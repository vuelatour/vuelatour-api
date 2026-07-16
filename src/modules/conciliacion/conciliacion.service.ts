import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
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
  ) {}

  /** Parsea el estado de cuenta en pyservices (sin persistir). */
  async parse(dto: ConciliacionParseDto): Promise<ParsedStatement> {
    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException('Conciliación no configurada (pyservices).');
    }
    const controller = new AbortController();
    // Un PDF con cientos de movimientos tarda varios minutos en extraerse con
    // IA: 60s abortaba a media lectura. La importación es manual (el operador
    // espera) y CSV/Excel siguen siendo instantáneos.
    const timer = setTimeout(() => controller.abort(), 270_000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify({ filename: dto.filename, file_base64: dto.file_base64 }),
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
      throw new ServiceUnavailableException(`No se pudo parsear el estado de cuenta: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persiste los movimientos y auto-concilia los CARGO con gastos del mismo monto/fecha. */
  async importar(dto: ImportarMovimientosDto, userId: string) {
    const rows = dto.movimientos
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
    if (rows.length === 0) {
      throw new BadRequestException('No hay movimientos con fecha para importar.');
    }

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

    let conciliadosAuto = 0;
    for (const mov of inserted ?? []) {
      const m = mov as { id: string; fecha: string; monto: number; tipo: string };
      const matched =
        m.tipo === TipoMovimientoBancario.CARGO
          ? await this.autoMatch(m.id, m.monto, m.fecha, monedaCuenta, userId)
          : await this.autoMatchAbono(m.id, m.monto, m.fecha, monedaCuenta, userId);
      if (matched) conciliadosAuto += 1;
    }

    return { importados: rows.length, conciliados_auto: conciliadosAuto };
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

    const gastoId = (data[0] as { id: string }).id;
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
    const candidatos = (data as Array<{ id: string; monto: unknown; comision_banco_monto: unknown }>).filter(
      matchea,
    );
    if (candidatos.length === 0) return false;

    // Descarta cobros ya enlazados a otro movimiento; exige candidato único.
    const ids = candidatos.map((c) => c.id);
    const { data: yaEnlazados } = await this.supabase.service
      .from('movimiento_bancario')
      .select('cobro_id')
      .in('cobro_id', ids);
    const ocupados = new Set((yaEnlazados ?? []).map((m) => m.cobro_id as string));
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

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        cobro_id: cobroId,
        conciliado: cobroId !== null || (mov as { gasto_id: string | null }).gasto_id !== null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503') throw new BadRequestException('Cobro no encontrado.');
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
      (cuentas ?? []).map((c) => [c.id as string, c as Record<string, unknown>]),
    );

    const porCuenta = new Map<
      string,
      { total: number; conciliados: number; pendientes: number; monto_pendiente: number }
    >();
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      const key = m.cuenta_bancaria_id as string;
      const cur =
        porCuenta.get(key) ?? { total: 0, conciliados: 0, pendientes: 0, monto_pendiente: 0 };
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

  async list(filters: ListConciliacionQuery) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // El gasto/cobro conciliado trae su vuelo (folio) para que la fila
        // sea verificable de un clic desde el panel.
        `${MOV_COLS}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto, vuelo_id, vuelo:vuelo!vuelo_id(folio)), cobro:cobro_vuelo!cobro_id(vuelo_id, vuelo:vuelo!vuelo_id(folio))`,
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.cuenta_bancaria_id) q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (typeof filters.conciliado === 'boolean') q = q.eq('conciliado', filters.conciliado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: filters.limit, offset: filters.offset };
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
    if (prevGasto && prevGasto !== gastoId) {
      // Libera el gasto previamente vinculado.
      await this.supabase.service
        .from('gasto')
        .update({ conciliado: false, updated_by: userId })
        .eq('id', prevGasto);
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
      if (error.code === '23503') throw new BadRequestException('Gasto no encontrado.');
      throw new Error(error.message);
    }

    if (gastoId) {
      await this.supabase.service
        .from('gasto')
        .update({ conciliado: true, updated_by: userId })
        .eq('id', gastoId);
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

    const m = mov as {
      id: string;
      fecha: string;
      monto: number;
      descripcion: string | null;
      conciliado: boolean;
      cuenta_bancaria_id: string;
    };
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
        razon: 'No hay gastos candidatos cercanos (±3 días y ±5% de monto) sin conciliar.',
        candidatos,
      };
    }

    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
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
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify({
          movimiento: { fecha: m.fecha, monto: m.monto, descripcion: m.descripcion },
          candidatos,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`pyservices /conciliacion/sugerir respondió ${res.status}`);
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
      .select('id, fecha_gasto, monto, proveedor:proveedor!proveedor_id(nombre)')
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
      const prov = Array.isArray(row.proveedor) ? row.proveedor[0] : row.proveedor;
      return {
        id: row.id,
        fecha: row.fecha_gasto,
        monto: Number(row.monto),
        proveedor: prov?.nombre ?? null,
      };
    });
  }
}
