import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { EnvVars } from '../../config/env.schema';
import {
  ConciliacionParseDto,
  ImportarMovimientosDto,
  ListConciliacionQuery,
  TipoMovimientoBancario,
} from './dto/conciliacion.dto';

const MOV_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, conciliado, gasto_id, cobro_id, origen, notas, created_at';
const MATCH_DAYS = 3;
/**
 * Solo estos medios de pago tocan el banco y pueden cruzarse con un CARGO del
 * estado de cuenta. EFECTIVO sale de caja chica (del cajón), BODEGA es un
 * cargo contable de inventario y los PERSONAL_* llegan al banco después como
 * reintegro, no como el gasto original. Cruzarlos generaba matches falsos.
 */
const MEDIOS_BANCARIOS = ['TARJETA_CORP', 'TRANSFERENCIA'];

export interface ParsedStatement {
  movimientos: Array<{
    fecha: string | null;
    descripcion: string | null;
    monto: number;
    tipo: 'CARGO' | 'ABONO';
    referencia: string | null;
  }>;
  total: number;
  formato: string;
  notas: string;
  modelo: string | null;
}

export interface SugerenciaConciliacion {
  disponible: boolean;
  gasto_id_sugerido: string | null;
  confianza: number;
  razon: string;
  /** Gastos candidatos considerados (para que el front muestre opciones). */
  candidatos: Array<{
    id: string;
    fecha: string | null;
    monto: number;
    proveedor: string | null;
  }>;
}

/** Banda de tolerancia de monto (±5%) para juntar gastos candidatos. */
const MATCH_MONTO_PCT = 0.05;

@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
  ) {}

  /** Parsea el estado de cuenta en pyservices (sin persistir). */
  async parse(dto: ConciliacionParseDto): Promise<ParsedStatement> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'Conciliación no configurada (pyservices).',
      );
    }
    const controller = new AbortController();
    // Un PDF con cientos de movimientos tarda varios minutos en extraerse con
    // IA: 60s abortaba a media lectura. La importación es manual (el operador
    // espera) y CSV/Excel siguen siendo instantáneos.
    const timer = setTimeout(() => controller.abort(), 270_000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify({
          filename: dto.filename,
          file_base64: dto.file_base64,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al parsear: ${detail.slice(0, 200)}`,
        );
      }
      return (await res.json()) as ParsedStatement;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`parse estado de cuenta falló: ${msg}`);
      throw new ServiceUnavailableException(
        `No se pudo parsear el estado de cuenta: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persiste los movimientos y auto-concilia los CARGO con gastos del mismo monto/fecha. */
  async importar(dto: ImportarMovimientosDto, userId: string) {
    // Compat: importación síncrona (sin progreso). El panel usa importarAsync.
    return this.ejecutarImport(dto, userId, async () => {});
  }

  /**
   * Importación como JOB del servidor: responde de inmediato con job_id y el
   * proceso (dedupe, archivo, insert y auto-conciliación) sigue en el backend
   * aunque el navegador se cierre. El panel consulta el avance con
   * importStatus (barra de porcentaje).
   */
  async importarAsync(dto: ImportarMovimientosDto, userId: string) {
    const total = dto.movimientos.filter((m) => m.fecha).length;
    if (total === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    const { data: job, error } = await this.supabase.service
      .from('conciliacion_import_job')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        total_movimientos: total,
        paso: 'Preparando importación…',
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }
    void this.correrImportJob(job!.id as string, dto, userId);
    return { job_id: job!.id as string };
  }

  private async correrImportJob(
    jobId: string,
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<void> {
    const setJob = async (patch: Record<string, unknown>) => {
      const { error } = await this.supabase.service
        .from('conciliacion_import_job')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', jobId);
      if (error)
        this.logger.warn(`import job ${jobId}: ${error.message}`);
    };
    try {
      const res = await this.ejecutarImport(
        dto,
        userId,
        async (progreso, paso) => setJob({ progreso, paso }),
      );
      await setJob({
        estado: 'LISTO',
        progreso: 100,
        paso: 'Terminado',
        importados: res.importados,
        conciliados_auto: res.conciliados_auto,
        duplicados_omitidos: res.duplicados_omitidos,
      });
    } catch (err) {
      // El job jamás queda colgado en PROCESANDO: el error se muestra tal
      // cual en el panel para corregir (cuenta equivocada, archivo, etc.).
      await setJob({
        estado: 'ERROR',
        paso: 'Error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Estado de un job de importación (polling del panel). */
  async importStatus(jobId: string) {
    const { data, error } = await this.supabase.service
      .from('conciliacion_import_job')
      .select(
        'id, estado, progreso, paso, total_movimientos, importados, conciliados_auto, duplicados_omitidos, error, created_at',
      )
      .eq('id', jobId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Job ${jobId} not found`);
    return data;
  }

  private async ejecutarImport(
    dto: ImportarMovimientosDto,
    userId: string,
    onProgress: (progreso: number, paso: string) => Promise<void>,
  ) {
    const base = dto.movimientos
      .filter((m) => m.fecha)
      .map((m) => ({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        fecha: m.fecha,
        tipo: m.tipo,
        monto: m.monto,
        descripcion: m.descripcion ?? null,
        referencia: m.referencia ?? null,
        origen: 'IMPORTADO',
        created_by: userId,
        updated_by: userId,
      }));
    if (base.length === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    await onProgress(5, 'Buscando duplicados…');

    // CANDADO DE RE-IMPORTACIÓN: el mismo estado de cuenta subido dos veces
    // duplicaría los movimientos e inflaría los pendientes para siempre (los
    // gastos ya conciliados no se vuelven a cruzar). Dedup MULTICONJUNTO por
    // (fecha, tipo, monto, descripción) contra lo ya importado en la cuenta:
    // dos cargos legítimos idénticos del mismo día solo se omiten si ya
    // existen exactamente esas repeticiones en la base.
    const fechas = base.map((r) => r.fecha).sort();
    const { data: previos, error: prevErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('fecha, tipo, monto, descripcion')
      .eq('cuenta_bancaria_id', dto.cuenta_bancaria_id)
      .gte('fecha', fechas[0])
      .lte('fecha', fechas[fechas.length - 1]);
    if (prevErr) throw new Error(prevErr.message);
    const clave = (m: {
      fecha?: string | null;
      tipo?: string | null;
      monto: number | string;
      descripcion?: string | null;
    }) =>
      [
        m.fecha,
        m.tipo,
        Number(m.monto).toFixed(2),
        (m.descripcion ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
      ].join('|');
    const existentes = new Map<string, number>();
    for (const p of previos ?? []) {
      const k = clave(p);
      existentes.set(k, (existentes.get(k) ?? 0) + 1);
    }
    const nuevos: typeof base = [];
    let duplicadosOmitidos = 0;
    for (const r of base) {
      const k = clave(r);
      const disponibles = existentes.get(k) ?? 0;
      if (disponibles > 0) {
        existentes.set(k, disponibles - 1);
        duplicadosOmitidos += 1;
      } else {
        nuevos.push(r);
      }
    }

    await onProgress(18, 'Archivando el estado de cuenta…');
    // El archivo original se archiva DESPUÉS de validar y ANTES de insertar:
    // cada movimiento queda ligado a su estado de cuenta. Se archiva aunque
    // todo resulte duplicado (re-subir un estado de cuenta viejo solo para
    // conservar el archivo es un caso legítimo).
    const estadoCuentaId = await this.archivarEstadoCuenta(dto, userId);

    if (nuevos.length === 0) {
      if (estadoCuentaId) {
        await this.supabase.service
          .from('estado_cuenta_archivo')
          .update({ movimientos_importados: 0 })
          .eq('id', estadoCuentaId);
      }
      return {
        importados: 0,
        conciliados_auto: 0,
        duplicados_omitidos: duplicadosOmitidos,
      };
    }
    const rows = nuevos.map((r) => ({
      ...r,
      estado_cuenta_id: estadoCuentaId,
    }));

    await onProgress(30, `Guardando ${rows.length} movimientos…`);
    const { data: inserted, error } = await this.supabase.service
      .from('movimiento_bancario')
      .insert(rows)
      .select('id, fecha, monto, tipo');
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }

    // La moneda de la cuenta define contra qué se cruza: un cargo de 3,000 en
    // la cuenta USD jamás debe conciliar un gasto de $3,000 MXN.
    const monedaCuenta = await this.monedaCuenta(dto.cuenta_bancaria_id);

    // Auto-conciliación: la parte lenta (una consulta por movimiento). El
    // progreso avanza de 35 a 95, reportado por lotes para no duplicar el
    // costo con updates del job en cada vuelta.
    let conciliadosAuto = 0;
    const lista = inserted ?? [];
    const pasoLote = Math.max(1, Math.ceil(lista.length / 25));
    for (let i = 0; i < lista.length; i++) {
      const m = lista[i];
      const matched =
        m.tipo === TipoMovimientoBancario.CARGO
          ? await this.autoMatch(m.id, m.monto, m.fecha, monedaCuenta, userId)
          : await this.autoMatchAbono(
              m.id,
              m.monto,
              m.fecha,
              monedaCuenta,
              userId,
            );
      if (matched) conciliadosAuto += 1;
      if (i % pasoLote === 0 || i === lista.length - 1) {
        await onProgress(
          35 + Math.round(((i + 1) / lista.length) * 60),
          `Conciliando ${i + 1} de ${lista.length}…`,
        );
      }
    }

    if (estadoCuentaId) {
      await this.supabase.service
        .from('estado_cuenta_archivo')
        .update({ movimientos_importados: rows.length })
        .eq('id', estadoCuentaId);
    }

    return {
      importados: rows.length,
      conciliados_auto: conciliadosAuto,
      duplicados_omitidos: duplicadosOmitidos,
    };
  }

  /**
   * Guarda el archivo original del estado de cuenta en el bucket privado
   * `estados-cuenta` y registra la importación. Sin archivo (panel viejo) la
   * importación sigue funcionando; CON archivo, un fallo al archivar tumba
   * la importación a propósito (fail-loud): importar sin respaldo en
   * silencio dejaría la auditoría incompleta, y como aún no se insertó
   * ningún movimiento, reintentar es seguro.
   */
  private async archivarEstadoCuenta(
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<string | null> {
    if (!dto.file_base64 || !dto.filename) return null;
    const limpio = dto.filename.replace(/[^\w.-]+/g, '_').slice(-120);
    const path = `${dto.cuenta_bancaria_id}/${Date.now()}-${limpio}`;
    const { error: upErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .upload(path, Buffer.from(dto.file_base64, 'base64'), {
        contentType: 'application/octet-stream',
      });
    if (upErr) {
      throw new InternalServerErrorException(
        `No se pudo archivar el estado de cuenta (${upErr.message}). Reintenta la importación.`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        filename: dto.filename,
        storage_path: path,
        formato: limpio.split('.').pop()?.toLowerCase() ?? null,
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.id as string) ?? null;
  }

  /** Estados de cuenta importados (para consultarlos/descargarlos después). */
  async listEstadosCuenta(cuentaBancariaId?: string) {
    let q = this.supabase.service
      .from('estado_cuenta_archivo')
      .select(
        'id, cuenta_bancaria_id, filename, formato, movimientos_importados, created_at, cuenta:cuenta_bancaria(banco, alias, moneda)',
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (cuentaBancariaId) q = q.eq('cuenta_bancaria_id', cuentaBancariaId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [] };
  }

  /** URL firmada (1 h) para descargar un estado de cuenta archivado. */
  async estadoCuentaUrl(id: string) {
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .select('storage_path, filename')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Estado de cuenta ${id} not found`);
    const { data: signed, error: signErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .createSignedUrl(data.storage_path as string, 3600, {
        download: data.filename as string,
      });
    if (signErr || !signed?.signedUrl) {
      throw new Error(signErr?.message ?? 'No se pudo firmar la URL');
    }
    return { url: signed.signedUrl, filename: data.filename as string };
  }

  private async monedaCuenta(cuentaId: string): Promise<string | null> {
    const { data } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('moneda')
      .eq('id', cuentaId)
      .maybeSingle();
    return (data?.moneda as string | null) ?? null;
  }

  /** Si hay exactamente un gasto candidato (mismo monto+moneda, fecha ±N días, medio bancario, sin conciliar), lo vincula. */
  private async autoMatch(
    movId: string,
    monto: number,
    fecha: string,
    moneda: string | null,
    userId: string,
  ): Promise<boolean> {
    const base = new Date(`${fecha}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - MATCH_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + MATCH_DAYS);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    let q = this.supabase.service
      .from('gasto')
      .select('id')
      .eq('monto', monto)
      .eq('conciliado', false)
      // Solo medios que tocan el banco (excluye EFECTIVO, BODEGA, PERSONAL_*).
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .limit(2);
    if (moneda) q = q.eq('moneda', moneda);
    const { data, error } = await q;
    if (error || !data || data.length !== 1) return false;

    const gastoId = data[0].id;
    await this.link(movId, gastoId, userId);
    return true;
  }

  /**
   * ABONO = entrada de dinero. Se cruza contra los COBROS de vuelos (HSBC
   * link, transferencia) del mismo monto/moneda ±N días que aún no estén
   * enlazados a otro movimiento. Con esto la mitad "ingresos" del estado de
   * cuenta también se concilia sola.
   */
  private async autoMatchAbono(
    movId: string,
    monto: number,
    fecha: string,
    moneda: string | null,
    userId: string,
  ): Promise<boolean> {
    const base = new Date(`${fecha}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - MATCH_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + MATCH_DAYS);

    // El banco deposita monto − comisión bancaria: el abono real es el NETO.
    // Se matchea por bruto (cobros sin comisión) O por neto (con comisión) —
    // antes solo por bruto y los cobros con comisión jamás conciliaban.
    let q = this.supabase.service
      .from('cobro_vuelo')
      .select('id, monto, comision_banco_monto')
      .in('metodo_cobro', ['TRANSFERENCIA', 'HSBC_LINK', 'CHEQUE'])
      .gte('fecha_cobro', lo.toISOString())
      .lte('fecha_cobro', hi.toISOString())
      // Orden estable: si la ventana excede el tope, el corte es determinista.
      .order('fecha_cobro', { ascending: true })
      .limit(50);
    if (moneda) q = q.eq('moneda', moneda);
    const { data, error } = await q;
    if (error || !data || data.length === 0) return false;

    const r2 = (x: number) => Math.round(x * 100) / 100;
    const matchea = (c: { monto: unknown; comision_banco_monto: unknown }) => {
      const bruto = Number(c.monto);
      const comision = Number(c.comision_banco_monto) || 0;
      if (comision > 0) return r2(bruto - comision) === r2(monto);
      return r2(bruto) === r2(monto);
    };
    const candidatos = (
      data as Array<{
        id: string;
        monto: unknown;
        comision_banco_monto: unknown;
      }>
    ).filter(matchea);
    if (candidatos.length === 0) return false;

    // Descarta cobros ya enlazados a otro movimiento; exige candidato único.
    const ids = candidatos.map((c) => c.id);
    const { data: yaEnlazados } = await this.supabase.service
      .from('movimiento_bancario')
      .select('cobro_id')
      .in('cobro_id', ids);
    const ocupados = new Set(
      (yaEnlazados ?? []).map((m) => m.cobro_id as string),
    );
    const libres = ids.filter((id) => !ocupados.has(id));
    if (libres.length !== 1) return false;

    await this.linkCobro(movId, libres[0], userId);
    return true;
  }

  /** Vincula (o desvincula si cobroId es null) un ABONO con un cobro de vuelo. */
  async linkCobro(movId: string, cobroId: string | null, userId: string) {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    // Un cobro ya enlazado a OTRO movimiento no puede cuadrar una segunda
    // línea del banco (el auto-match ya lo respeta; el manual también).
    if (cobroId) {
      const { data: yaEnlazado, error: ocupadoErr } =
        await this.supabase.service
          .from('movimiento_bancario')
          .select('id')
          .eq('cobro_id', cobroId)
          .neq('id', movId)
          .limit(1)
          .maybeSingle();
      if (ocupadoErr) throw new Error(ocupadoErr.message);
      if (yaEnlazado) {
        throw new ConflictException(
          'Ese cobro ya está conciliado con otro movimiento bancario.',
        );
      }
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        cobro_id: cobroId,
        conciliado:
          cobroId !== null ||
          (mov as { gasto_id: string | null }).gasto_id !== null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      // Índice único uq_mov_bancario_cobro: dos vínculos simultáneos al mismo
      // cobro pasan el check previo (TOCTOU) pero solo uno gana en la BD.
      if (error.code === '23505' || error.message?.includes('23505'))
        throw new ConflictException(
          'Ese cobro ya está vinculado a otro movimiento bancario.',
        );
      if (error.code === '23503')
        throw new BadRequestException('Cobro no encontrado.');
      throw new Error(error.message);
    }
    return data!;
  }

  /**
   * Resumen por cuenta para el cierre: cuántos movimientos hay, cuántos están
   * conciliados y cuánto dinero sigue pendiente. "Faltan N por conciliar" deja
   * de descubrirse revisando la lista a mano.
   */
  async resumen(desde?: string, hasta?: string) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select('cuenta_bancaria_id, tipo, monto, conciliado');
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const { data: cuentas } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda');
    const cuentaInfo = new Map(
      (cuentas ?? []).map((c) => [
        c.id as string,
        c as Record<string, unknown>,
      ]),
    );

    const porCuenta = new Map<
      string,
      {
        total: number;
        conciliados: number;
        pendientes: number;
        monto_pendiente: number;
      }
    >();
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      const key = m.cuenta_bancaria_id as string;
      const cur = porCuenta.get(key) ?? {
        total: 0,
        conciliados: 0,
        pendientes: 0,
        monto_pendiente: 0,
      };
      cur.total += 1;
      if (m.conciliado === true) cur.conciliados += 1;
      else {
        cur.pendientes += 1;
        cur.monto_pendiente += Number(m.monto);
      }
      porCuenta.set(key, cur);
    }

    return [...porCuenta.entries()].map(([id, v]) => {
      const info = cuentaInfo.get(id);
      return {
        cuenta_bancaria_id: id,
        alias: (info?.alias as string) ?? null,
        banco: (info?.banco as string) ?? null,
        moneda: (info?.moneda as string) ?? null,
        total: v.total,
        conciliados: v.conciliados,
        pendientes: v.pendientes,
        monto_pendiente: Math.round(v.monto_pendiente * 100) / 100,
      };
    });
  }

  /**
   * Reporte de conciliación en Excel: réplica del estado de cuenta (una fila
   * por movimiento, cargos y abonos en columnas) con el ESTATUS de cada línea
   * (Conciliado/PENDIENTE) y con qué se cruzó (gasto o cobro, con su vuelo).
   * Para revisar/imprimir el cierre de la cuenta en el periodo.
   */
  async reporteXlsx(
    cuentaBancariaId: string,
    desde?: string,
    hasta?: string,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    const { data: cuenta, error: ctaErr } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda')
      .eq('id', cuentaBancariaId)
      .maybeSingle();
    if (ctaErr) throw new Error(ctaErr.message);
    if (!cuenta)
      throw new NotFoundException(`Cuenta ${cuentaBancariaId} not found`);

    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        `${MOV_COLS}, gasto:gasto!gasto_id(categoria, vuelo_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)), cobro:cobro_vuelo!cobro_id(metodo_cobro, vuelo:vuelo!vuelo_id(folio))`,
      )
      .eq('cuenta_bancaria_id', cuentaBancariaId)
      // Orden del estado de cuenta impreso: cronológico ascendente.
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000);
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const movs = (data ?? []) as Array<Record<string, unknown>>;

    const unwrapOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    const conQue = (m: Record<string, unknown>): string => {
      const gasto = unwrapOne(
        m.gasto as {
          categoria?: string;
          proveedor?: { nombre?: string } | { nombre?: string }[] | null;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (gasto) {
        const prov = unwrapOne(gasto.proveedor)?.nombre;
        const folio = unwrapOne(gasto.vuelo)?.folio;
        return [
          `Gasto ${gasto.categoria ?? ''}`.trim(),
          prov ?? null,
          folio != null ? `vuelo #${folio}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      const cobro = unwrapOne(
        m.cobro as {
          metodo_cobro?: string;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (cobro) {
        const folio = unwrapOne(cobro.vuelo)?.folio;
        return [
          'Cobro',
          folio != null ? `vuelo #${folio}` : null,
          cobro.metodo_cobro ?? null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      return '';
    };

    let totalCargos = 0;
    let totalAbonos = 0;
    let conciliados = 0;
    const filas = movs.map((m) => {
      const monto = Number(m.monto) || 0;
      const esCargo = m.tipo === 'CARGO';
      if (esCargo) totalCargos += monto;
      else totalAbonos += monto;
      const ok = m.conciliado === true;
      if (ok) conciliados += 1;
      return [
        (m.fecha as string) ?? '',
        (m.descripcion as string | null) ?? '',
        (m.referencia as string | null) ?? '',
        esCargo ? monto : null,
        esCargo ? null : monto,
        ok ? 'Conciliado' : 'PENDIENTE',
        ok ? conQue(m) : '',
      ];
    });

    const pendientes = movs.length - conciliados;
    const etiquetaCuenta = `${cuenta.alias as string} · ${cuenta.banco as string} (${cuenta.moneda as string})`;
    const rango =
      desde || hasta ? ` · ${desde ?? 'inicio'} a ${hasta ?? 'hoy'}` : '';
    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: `Conciliación · ${etiquetaCuenta}`,
      subtitulo: `${movs.length} movimientos · ${conciliados} conciliados · ${pendientes} pendientes${rango}`,
      columnas: [
        { label: 'Fecha', tipo: 'texto' },
        { label: 'Descripción', tipo: 'texto' },
        { label: 'Referencia', tipo: 'texto' },
        { label: `Cargo (${cuenta.moneda as string})`, tipo: 'money' },
        { label: `Abono (${cuenta.moneda as string})`, tipo: 'money' },
        { label: 'Estatus', tipo: 'texto' },
        { label: 'Conciliado con', tipo: 'texto' },
      ],
      filas,
      totales: [
        'Totales',
        null,
        null,
        Number(totalCargos.toFixed(2)),
        Number(totalAbonos.toFixed(2)),
        `${conciliados} conciliados`,
        `${pendientes} pendientes`,
      ],
    });
    return { buffer, etiqueta: (cuenta.alias as string) ?? 'cuenta' };
  }

  async list(filters: ListConciliacionQuery) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // El gasto/cobro conciliado trae su detalle y su vuelo (folio) para
        // que la fila sea verificable de un clic desde el panel.
        `${MOV_COLS}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto, vuelo_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)), cobro:cobro_vuelo!cobro_id(monto, moneda, metodo_cobro, fecha_cobro, vuelo_id, vuelo:vuelo!vuelo_id(folio))`,
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (typeof filters.conciliado === 'boolean')
      q = q.eq('conciliado', filters.conciliado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /** Vincula (o desvincula si gastoId es null) un movimiento con un gasto. */
  async link(movId: string, gastoId: string | null, userId: string) {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const prevGasto = (mov as { gasto_id: string | null }).gasto_id;

    // Un gasto ya conciliado NO puede cuadrar una segunda línea del banco
    // (doble conciliación). El auto-match ya lo respeta; el vínculo manual
    // también debe hacerlo.
    if (gastoId && gastoId !== prevGasto) {
      const { data: gasto, error: gastoErr } = await this.supabase.service
        .from('gasto')
        .select('id, conciliado')
        .eq('id', gastoId)
        .maybeSingle();
      if (gastoErr) throw new Error(gastoErr.message);
      if (!gasto) throw new BadRequestException('Gasto no encontrado.');
      if (gasto.conciliado === true) {
        throw new ConflictException(
          'Ese gasto ya está conciliado con otro movimiento bancario.',
        );
      }
    }

    if (prevGasto && prevGasto !== gastoId) {
      // Libera el gasto previamente vinculado. Si falla, se aborta: dejarlo
      // conciliado=true sin movimiento lo sacaría de la conciliación en
      // silencio (regla del repo: nada de fallos silenciosos en dinero).
      const { error: liberaErr } = await this.supabase.service
        .from('gasto')
        .update({ conciliado: false, updated_by: userId })
        .eq('id', prevGasto);
      if (liberaErr) {
        throw new Error(
          `No se pudo liberar el gasto previamente conciliado: ${liberaErr.message}`,
        );
      }
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        gasto_id: gastoId,
        conciliado: gastoId !== null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      // Índice único uq_mov_bancario_gasto: dos vínculos simultáneos al mismo
      // gasto pasan el check previo (TOCTOU) pero solo uno gana en la BD.
      if (error.code === '23505' || error.message?.includes('23505'))
        throw new ConflictException(
          'Ese gasto ya está vinculado a otro movimiento bancario.',
        );
      if (error.code === '23503')
        throw new BadRequestException('Gasto no encontrado.');
      throw new Error(error.message);
    }

    if (gastoId) {
      // Si falla, se avisa: un gasto que sigue conciliado=false puede volver a
      // matchearse con OTRO cargo (doble conciliación silenciosa).
      const { error: marcaErr } = await this.supabase.service
        .from('gasto')
        .update({ conciliado: true, updated_by: userId })
        .eq('id', gastoId);
      if (marcaErr) {
        throw new Error(
          `El movimiento quedó vinculado pero no se pudo marcar el gasto como conciliado: ${marcaErr.message}`,
        );
      }
    }
    return data!;
  }

  /**
   * Sugiere (vía Claude en pyservices) el gasto más probable para un movimiento
   * bancario sin conciliar y ambiguo. Junta gastos candidatos cercanos (±3 días
   * y ±5% de monto, sin conciliar) y deja que la IA proponga el match con razón.
   * Best-effort: si pyservices no está configurado o falla, devuelve
   * disponible=false con los candidatos para que el operador elija a mano.
   */
  async sugerir(movId: string): Promise<SugerenciaConciliacion> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, fecha, monto, descripcion, conciliado, cuenta_bancaria_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const m = mov;
    if (m.conciliado) {
      throw new BadRequestException('El movimiento ya está conciliado.');
    }

    const moneda = await this.monedaCuenta(m.cuenta_bancaria_id);
    const candidatos = await this.candidatosCercanos(m.monto, m.fecha, moneda);
    if (candidatos.length === 0) {
      return {
        disponible: true,
        gasto_id_sugerido: null,
        confianza: 0,
        razon:
          'No hay gastos candidatos cercanos (±3 días y ±5% de monto) sin conciliar.',
        candidatos,
      };
    }

    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      return {
        disponible: false,
        gasto_id_sugerido: null,
        confianza: 0,
        razon: 'Asistente de conciliación no configurado (pyservices).',
        candidatos,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/sugerir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify({
          movimiento: {
            fecha: m.fecha,
            monto: m.monto,
            descripcion: m.descripcion,
          },
          candidatos,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `pyservices /conciliacion/sugerir respondió ${res.status}`,
        );
        return {
          disponible: false,
          gasto_id_sugerido: null,
          confianza: 0,
          razon: `pyservices respondió ${res.status}.`,
          candidatos,
        };
      }
      const data = (await res.json()) as {
        gasto_id_sugerido: string | null;
        confianza: number;
        razon: string;
      };
      // Solo aceptamos un id que esté realmente entre los candidatos.
      const sugerido = candidatos.some((c) => c.id === data.gasto_id_sugerido)
        ? data.gasto_id_sugerido
        : null;
      return {
        disponible: true,
        gasto_id_sugerido: sugerido,
        confianza: sugerido ? data.confianza : 0,
        razon: data.razon ?? '',
        candidatos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sugerir conciliación falló: ${msg}`);
      return {
        disponible: false,
        gasto_id_sugerido: null,
        confianza: 0,
        razon: `No se pudo contactar al asistente de conciliación: ${msg}`,
        candidatos,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gastos sin conciliar dentro de ±MATCH_DAYS días y ±MATCH_MONTO_PCT de monto. */
  private async candidatosCercanos(
    monto: number,
    fecha: string,
    moneda: string | null,
  ): Promise<SugerenciaConciliacion['candidatos']> {
    const base = new Date(`${fecha}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - MATCH_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + MATCH_DAYS);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const delta = Math.abs(monto) * MATCH_MONTO_PCT;
    const montoLo = monto - delta;
    const montoHi = monto + delta;

    let query = this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, monto, proveedor:proveedor!proveedor_id(nombre)',
      )
      .eq('conciliado', false)
      // Solo medios que tocan el banco (misma regla que autoMatch).
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .gte('monto', montoLo)
      .lte('monto', montoHi)
      .limit(15);
    if (moneda) query = query.eq('moneda', moneda);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return (data ?? []).map((g) => {
      const row = g as {
        id: string;
        fecha_gasto: string | null;
        monto: number;
        proveedor: { nombre: string } | { nombre: string }[] | null;
      };
      const prov = Array.isArray(row.proveedor)
        ? row.proveedor[0]
        : row.proveedor;
      return {
        id: row.id,
        fecha: row.fecha_gasto,
        monto: Number(row.monto),
        proveedor: prov?.nombre ?? null,
      };
    });
  }
}
