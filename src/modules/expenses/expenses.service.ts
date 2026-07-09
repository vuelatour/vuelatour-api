import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  PyservicesService,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import { VisionService } from '../vision/vision.service';
import { Rol } from '../../common/types/auth.types';
import type {
  CreateGastoDto,
  CreateTarifaAerodromoDto,
  GenerarPistasDto,
  ListGastosQuery,
  UpdateGastoDto,
  UpdateTarifaAerodromoDto,
} from './dto/expenses.dto';

const COLS =
  'id, vuelo_id, aeronave_id, escala_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, fecha_gasto, proveedor_id, medio_pago, tarjeta_terminacion, litros, tipo_combustible, lugar, fecha_hora_carga, estatus_comprobante, foto_url, valor_ia_extraido, conciliado, duplicado_sospechado, origen, factura_recibida_id, notas, created_at, updated_at';

// Para el panel admin: nombres legibles de proveedor, avión y persona que capturó.
const LIST_COLS = `${COLS}, proveedor:proveedor!proveedor_id(nombre), aeronave:aeronave!aeronave_id(matricula), captura:usuario!usuario_captura_id(nombre)`;

/** Ventana en días para considerar dos gastos como posible duplicado. */
const DUP_DAYS = 3;

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly pyservices: PyservicesService,
    private readonly vision: VisionService,
  ) {}

  /** Gastos por avión/categoría en Excel (respeta los filtros del listado). */
  async listXlsx(filters: ListGastosQuery): Promise<Buffer> {
    const { data } = await this.list({ ...filters, limit: 5000, offset: 0 });
    const columnas: TablaColumnaPayload[] = [
      { label: 'Fecha' },
      { label: 'Categoría' },
      { label: 'Avión' },
      { label: 'Proveedor' },
      { label: 'Medio pago' },
      { label: 'Comprobante' },
      { label: 'Moneda' },
      { label: 'Monto', tipo: 'money' },
    ];
    const filas = data.map((g) => {
      const x = g as Record<string, unknown>;
      const aeronave = x.aeronave as { matricula?: string } | null;
      const proveedor = x.proveedor as { nombre?: string } | null;
      return [
        (x.fecha_gasto as string) ?? '',
        (x.categoria as string) ?? '',
        aeronave?.matricula ?? '(pendiente)',
        proveedor?.nombre ?? '',
        (x.medio_pago as string) ?? '',
        (x.estatus_comprobante as string) ?? '',
        (x.moneda as string) ?? '',
        Number(x.monto),
      ];
    });
    return this.pyservices.generateTablaXlsx({
      titulo: 'Gastos por avión / categoría',
      subtitulo: `Generado ${new Date().toISOString().slice(0, 10)}`,
      columnas,
      filas,
    });
  }

  async list(filters: ListGastosQuery) {
    let q = this.supabase.service
      .from('gasto')
      .select(LIST_COLS, { count: 'exact' })
      .order('fecha_gasto', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.vuelo_id) q = q.eq('vuelo_id', filters.vuelo_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.usuario_captura_id) q = q.eq('usuario_captura_id', filters.usuario_captura_id);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.estatus_comprobante) q = q.eq('estatus_comprobante', filters.estatus_comprobante);
    if (filters.medio_pago) q = q.eq('medio_pago', filters.medio_pago);
    if (filters.desde) q = q.gte('fecha_gasto', filters.desde);
    if (filters.hasta) q = q.lte('fecha_gasto', filters.hasta);
    // Pendiente = sin avión asignado (la bandeja debe quedar siempre vacía).
    if (filters.pendientes === true) q = q.is('aeronave_id', null);
    if (filters.duplicados === true) q = q.eq('duplicado_sospechado', true);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  /**
   * Sugerencia de asignación para un gasto de la bandeja: ¿a qué vuelo/avión
   * pertenece? Candidatos DETERMINISTAS = vuelos donde el capturista voló
   * (piloto/copiloto/por tramo) con fecha a ±3 días del gasto. Si hay
   * exactamente UNO el mismo día → match por regla. Si hay varios → Claude
   * elige usando notas/lugar vs la ruta. Sin candidatos o sin IA → sin match
   * (la asignación queda manual: la IA propone, el humano confirma).
   */
  async sugerirAsignacion(gastoId: string) {
    const gasto = await this.findById(gastoId);
    const fecha = gasto.fecha_gasto as string | null;
    const capturo = gasto.usuario_captura_id as string | null;
    const sinMatch = (razon: string) => ({
      sugerido: null,
      confianza: 0,
      razon,
      fuente: 'regla' as const,
      candidatos: [] as Array<Record<string, unknown>>,
    });
    if (!fecha || !capturo) {
      return sinMatch('El gasto no tiene fecha o capturista para buscar vuelos.');
    }

    // Vuelos propios no cancelados en ±3 días de la fecha del gasto.
    const base = new Date(`${fecha}T12:00:00-05:00`);
    const lo = new Date(base.getTime() - 3 * 86400_000).toISOString();
    const hi = new Date(base.getTime() + 3 * 86400_000).toISOString();
    const { data: vuelos, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, fecha_vuelo, piloto_id, copiloto_id, estado, aeronave_id, aeronave:aeronave_id(matricula), escalas:escala(orden, origen_iata, destino_iata, piloto_id)',
      )
      .neq('estado', 'CANCELADO')
      .eq('es_externo', false)
      .gte('fecha_vuelo', lo)
      .lte('fecha_vuelo', hi);
    if (error) throw new Error(error.message);

    const participo = (v: Record<string, unknown>): boolean => {
      if (v.piloto_id === capturo || v.copiloto_id === capturo) return true;
      const escalas = (v.escalas as Array<Record<string, unknown>> | null) ?? [];
      return escalas.some((e) => e.piloto_id === capturo);
    };
    const rutaDe = (v: Record<string, unknown>): string | null => {
      const escalas = [
        ...((v.escalas as Array<Record<string, unknown>> | null) ?? []),
      ].sort((a, b) => Number(a.orden) - Number(b.orden));
      if (escalas.length === 0) return null;
      return [
        escalas[0].origen_iata as string,
        ...escalas.map((e) => e.destino_iata as string),
      ].join(' → ');
    };
    const matriculaDe = (v: Record<string, unknown>): string | null => {
      const a = v.aeronave as { matricula?: string } | { matricula?: string }[] | null;
      if (Array.isArray(a)) return a[0]?.matricula ?? null;
      return a?.matricula ?? null;
    };

    const candidatos = ((vuelos ?? []) as Array<Record<string, unknown>>)
      .filter(participo)
      .map((v) => ({
        vuelo_id: v.id as string,
        folio: (v.folio as number | null) ?? null,
        fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
        aeronave_id: (v.aeronave_id as string | null) ?? null,
        matricula: matriculaDe(v),
        ruta: rutaDe(v),
      }));

    if (candidatos.length === 0) {
      return sinMatch(
        'El piloto no tiene vuelos en ±3 días de la fecha del gasto: asignar a mano.',
      );
    }

    // Regla fuerte: exactamente UN vuelo del capturista el MISMO día (Cancún).
    const diaCancun = (iso: string | null) =>
      iso
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
            new Date(iso),
          )
        : null;
    const mismoDia = candidatos.filter((c) => diaCancun(c.fecha_vuelo) === fecha);
    if (mismoDia.length === 1) {
      return {
        sugerido: mismoDia[0],
        confianza: 0.95,
        razon: 'Único vuelo del piloto ese día.',
        fuente: 'regla' as const,
        candidatos,
      };
    }

    // Ambiguo: Claude elige entre los candidatos (best-effort).
    const { data: piloto } = await this.supabase.service
      .from('usuario')
      .select('nombre')
      .eq('id', capturo)
      .maybeSingle();
    const ia = await this.pyservices.sugerirGastoVuelo({
      gasto: {
        fecha,
        monto: gasto.monto == null ? null : Number(gasto.monto),
        moneda: (gasto.moneda as string | null) ?? null,
        categoria: (gasto.categoria as string | null) ?? null,
        notas: (gasto.notas as string | null) ?? null,
        lugar: (gasto.lugar as string | null) ?? null,
        piloto_nombre: (piloto?.nombre as string | null) ?? null,
      },
      candidatos: candidatos.map((c) => ({
        vuelo_id: c.vuelo_id,
        folio: c.folio,
        fecha_vuelo: c.fecha_vuelo,
        matricula: c.matricula,
        ruta: c.ruta,
      })),
    });
    if (!ia) {
      return {
        sugerido: null,
        confianza: 0,
        razon:
          'Hay varios vuelos posibles y el asistente IA no está disponible: elige entre los candidatos.',
        fuente: 'regla' as const,
        candidatos,
      };
    }
    const pick = candidatos.find((c) => c.vuelo_id === ia.vuelo_id_sugerido) ?? null;
    return {
      sugerido: pick,
      confianza: pick ? ia.confianza : 0,
      razon: ia.razon || (pick ? 'Match propuesto por IA.' : 'Sin coincidencias claras.'),
      fuente: 'ia' as const,
      candidatos,
    };
  }

  /**
   * Barrido de la BANDEJA completa: corre sugerirAsignacion para cada gasto
   * sin avión (máx 15, en tandas de 5 para no saturar la IA) y devuelve la
   * lista gasto→sugerencia. La oficina revisa y aplica en lote — nunca se
   * asigna solo (la IA propone, el humano confirma).
   */
  async sugerirAsignaciones() {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, monto, moneda, categoria, notas, captura:usuario!usuario_captura_id(nombre)',
      )
      .is('aeronave_id', null)
      .neq('categoria', 'FIJO')
      .order('fecha_gasto', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    const pendientes = (data ?? []) as Array<Record<string, unknown>>;

    const resumen = (g: Record<string, unknown>) => {
      const cap = g.captura as { nombre?: string } | { nombre?: string }[] | null;
      const nombre = Array.isArray(cap) ? cap[0]?.nombre : cap?.nombre;
      return {
        id: g.id as string,
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
        monto: g.monto == null ? null : Number(g.monto),
        moneda: (g.moneda as string | null) ?? null,
        categoria: (g.categoria as string | null) ?? null,
        capturo_nombre: nombre ?? null,
      };
    };

    const resultados: Array<Record<string, unknown>> = [];
    const CONCURRENCIA = 5;
    for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
      const lote = pendientes.slice(i, i + CONCURRENCIA);
      const parciales = await Promise.all(
        lote.map(async (g) => {
          try {
            const sug = await this.sugerirAsignacion(g.id as string);
            return { gasto: resumen(g), ...sug };
          } catch {
            return {
              gasto: resumen(g),
              sugerido: null,
              confianza: 0,
              razon: 'No se pudo evaluar este gasto.',
              fuente: 'regla' as const,
              candidatos: [],
            };
          }
        }),
      );
      resultados.push(...parciales);
    }
    return { total_pendientes: pendientes.length, resultados };
  }

  /** URLs firmadas (1 h) para fotos de recibos en el bucket privado gasto-fotos. */
  async signPhotos(paths: string[]): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage
      .from('gasto-fotos')
      .createSignedUrls(clean, 3600);
    const map: Record<string, string> = {};
    for (const it of data ?? []) {
      if (it.signedUrl && it.path) map[it.path] = it.signedUrl;
    }
    return map;
  }

  // ===== Gastos de pista (cuotas de aeródromo, p.ej. VIP SAESA) =====
  //
  // El sistema ya sabe qué avión aterrizó dónde y cuándo (escalas). En vez de
  // capturar desde cero, se PROPONE un gasto por aterrizaje fuera de CUN con
  // el monto del tarifario; la oficina solo confirma (mínimo trabajo, doc 5.2).
  // La factura del proveedor llega días después y se amarra a estos gastos.

  /** Fecha Cancún (UTC-5 fija, sin DST) de un timestamp ISO. */
  private cancunDate(iso: string): string {
    return new Date(new Date(iso).getTime() - 5 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Aterrizajes del periodo (escalas con destino ≠ CUN) que aún NO tienen
   * gasto de pista, con el monto sugerido del tarifario aeródromo×modelo.
   */
  async pistasPendientes(desde: string, hasta: string) {
    const d1 = `${desde}T00:00:00-05:00`;
    const d2 = `${hasta}T23:59:59-05:00`;
    const { data: escalas, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, hora_llegada, fecha_salida_plan, aeronave_id, aeronave:aeronave!aeronave_id(id, matricula, modelo), vuelo:vuelo!vuelo_id(id, folio, estado, aeronave_id, aeronave:aeronave!aeronave_id(id, matricula, modelo))',
      )
      .neq('destino_iata', 'CUN')
      .or(
        `and(hora_llegada.gte.${d1},hora_llegada.lte.${d2}),and(hora_llegada.is.null,fecha_salida_plan.gte.${d1},fecha_salida_plan.lte.${d2})`,
      )
      .order('fecha_salida_plan', { ascending: true });
    if (error) throw new Error(error.message);

    type EscalaRow = {
      id: string;
      vuelo_id: string;
      orden: number;
      origen_iata: string;
      destino_iata: string;
      hora_llegada: string | null;
      fecha_salida_plan: string | null;
      aeronave: { id: string; matricula: string; modelo: string } | null;
      vuelo: {
        id: string;
        folio: string | null;
        estado: string;
        aeronave: { id: string; matricula: string; modelo: string } | null;
      } | null;
    };
    const filas = ((escalas ?? []) as unknown as EscalaRow[]).filter(
      (e) => e.vuelo && e.vuelo.estado !== 'CANCELADO',
    );
    if (filas.length === 0) return { data: [] };

    // Escalas que ya tienen gasto de pista (no proponer doble).
    const { data: existentes, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('escala_id, categoria')
      .in('escala_id', filas.map((e) => e.id));
    if (gErr) throw new Error(gErr.message);
    const conGasto = new Set(
      (existentes ?? [])
        .filter((g) => g.categoria === 'OPERACIONES' || g.categoria === 'ATERRIZAJE')
        .map((g) => g.escala_id as string),
    );

    const tarifas = await this.listTarifasAerodromo();

    const data = filas
      .filter((e) => !conGasto.has(e.id))
      .map((e) => {
        const aeronave = e.aeronave ?? e.vuelo?.aeronave ?? null;
        const tarifa = this.matchTarifa(tarifas, e.destino_iata, aeronave?.modelo);
        const fechaIso = e.hora_llegada ?? e.fecha_salida_plan;
        return {
          escala_id: e.id,
          vuelo_id: e.vuelo_id,
          folio: e.vuelo?.folio ?? null,
          orden: e.orden,
          tramo: `${e.origen_iata}→${e.destino_iata}`,
          destino_iata: e.destino_iata,
          fecha: fechaIso,
          fecha_gasto: fechaIso ? this.cancunDate(fechaIso) : null,
          aeronave_id: aeronave?.id ?? null,
          matricula: aeronave?.matricula ?? null,
          modelo: aeronave?.modelo ?? null,
          monto_sugerido: tarifa ? Number(tarifa.monto) : null,
          moneda: tarifa?.moneda ?? 'MXN',
          tarifa_variable: tarifa?.variable ?? false,
        };
      });
    return { data };
  }

  /** Mejor tarifa: iata+modelo > iata > modelo > nada. Modelo por contains. */
  private matchTarifa(
    tarifas: Array<Record<string, unknown>>,
    iata: string,
    modelo?: string | null,
  ) {
    const m = (modelo ?? '').toLowerCase();
    const matchModelo = (t: Record<string, unknown>) =>
      t.modelo != null && m.includes(String(t.modelo).toLowerCase());
    const matchIata = (t: Record<string, unknown>) =>
      t.codigo_iata != null &&
      String(t.codigo_iata).toUpperCase() === iata.toUpperCase();
    const activas = tarifas.filter((t) => t.activo !== false);
    return (
      activas.find((t) => matchIata(t) && matchModelo(t)) ??
      activas.find((t) => matchIata(t) && t.modelo == null) ??
      activas.find((t) => t.codigo_iata == null && matchModelo(t)) ??
      null
    );
  }

  /**
   * Crea los gastos de pista confirmados por la oficina: origen SISTEMA,
   * ligados a su escala/vuelo, SIN_COMPROBANTE hasta que llegue la factura.
   */
  async generarPistas(dto: GenerarPistasDto, userId: string) {
    // Proveedor VIP SAESA por default si existe en el catálogo.
    const { data: prov } = await this.supabase.service
      .from('proveedor')
      .select('id')
      .ilike('nombre', '%saesa%')
      .limit(1)
      .maybeSingle();

    const resultados: Array<{
      escala_id: string;
      ok: boolean;
      gasto_id?: string;
      error?: string;
    }> = [];
    for (const item of dto.items) {
      const { data: esc } = await this.supabase.service
        .from('escala')
        .select(
          'id, vuelo_id, destino_iata, hora_llegada, fecha_salida_plan, aeronave_id, vuelo:vuelo!vuelo_id(aeronave_id)',
        )
        .eq('id', item.escala_id)
        .maybeSingle();
      if (!esc) {
        resultados.push({ escala_id: item.escala_id, ok: false, error: 'Escala no encontrada' });
        continue;
      }
      const categoria = item.categoria ?? 'OPERACIONES';
      const { data: dup } = await this.supabase.service
        .from('gasto')
        .select('id')
        .eq('escala_id', item.escala_id)
        .eq('categoria', categoria)
        .limit(1);
      if (dup && dup.length > 0) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: `Ya existe un gasto ${categoria} para ese aterrizaje`,
        });
        continue;
      }
      const vuelo = esc.vuelo as unknown as { aeronave_id: string | null } | null;
      const fechaIso = (esc.hora_llegada ?? esc.fecha_salida_plan) as string | null;
      const { data: gasto, error } = await this.supabase.service
        .from('gasto')
        .insert({
          usuario_captura_id: userId,
          origen: 'SISTEMA',
          categoria,
          monto: item.monto,
          moneda: item.moneda ?? 'MXN',
          fecha_gasto: fechaIso
            ? this.cancunDate(fechaIso)
            : this.cancunDate(new Date().toISOString()),
          medio_pago: item.medio_pago ?? 'TRANSFERENCIA',
          vuelo_id: esc.vuelo_id,
          escala_id: esc.id,
          aeronave_id: (esc.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null,
          proveedor_id: item.proveedor_id ?? prov?.id ?? null,
          lugar: esc.destino_iata,
          estatus_comprobante: 'SIN_COMPROBANTE',
          notas: item.notas ?? `Cuota de aterrizaje ${esc.destino_iata as string}`,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .maybeSingle();
      if (error || !gasto) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: error?.message ?? 'No se pudo crear el gasto',
        });
        continue;
      }
      resultados.push({ escala_id: item.escala_id, ok: true, gasto_id: gasto.id as string });
    }
    return { creados: resultados.filter((r) => r.ok).length, resultados };
  }

  // ===== Tarifario de aeródromos =====

  async listTarifasAerodromo() {
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .order('codigo_iata', { ascending: true, nullsFirst: false })
      .order('modelo', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async createTarifaAerodromo(dto: CreateTarifaAerodromoDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .insert({
        codigo_iata: dto.codigo_iata?.toUpperCase() || null,
        modelo: dto.modelo || null,
        monto: dto.monto,
        moneda: dto.moneda ?? 'MXN',
        variable: dto.variable ?? false,
        activo: dto.activo ?? true,
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('Ya existe una tarifa para ese aeródromo/modelo.');
      throw new Error(error.message);
    }
    return data!;
  }

  async updateTarifaAerodromo(id: string, dto: UpdateTarifaAerodromoDto, userId: string) {
    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.codigo_iata !== undefined) patch.codigo_iata = dto.codigo_iata?.toUpperCase() || null;
    if (dto.modelo !== undefined) patch.modelo = dto.modelo || null;
    if (dto.monto !== undefined) patch.monto = dto.monto;
    if (dto.moneda !== undefined) patch.moneda = dto.moneda;
    if (dto.variable !== undefined) patch.variable = dto.variable;
    if (dto.activo !== undefined) patch.activo = dto.activo;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .update(patch)
      .eq('id', id)
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Tarifa ${id} not found`);
    return data;
  }

  async removeTarifaAerodromo(id: string) {
    const { error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  async create(dto: CreateGastoDto, userId: string, rol?: Rol) {
    // El mecánico solo puede cargar combustible (GAS).
    if (rol === Rol.MECANICO && dto.categoria !== 'GAS') {
      throw new BadRequestException('El mecánico solo puede cargar combustible (GAS).');
    }
    // Distintivo pedido por el cliente: quién sube el gasto (piloto vs oficina).
    const origen =
      rol === Rol.PILOTO ? 'PILOTO' : rol === Rol.MECANICO ? 'MECANICO' : 'OFICINA';
    const payload: Record<string, unknown> = {
      usuario_captura_id: userId,
      origen,
      categoria: dto.categoria,
      monto: dto.monto,
      moneda: dto.moneda,
      tc_gasto: dto.tc_gasto,
      fecha_gasto: dto.fecha_gasto,
      medio_pago: dto.medio_pago,
      tarjeta_terminacion: dto.tarjeta_terminacion,
      vuelo_id: dto.vuelo_id,
      escala_id: dto.escala_id,
      aeronave_id: dto.aeronave_id,
      proveedor_id: dto.proveedor_id,
      litros: dto.litros,
      tipo_combustible: dto.tipo_combustible,
      lugar: dto.lugar,
      fecha_hora_carga: dto.fecha_hora_carga,
      estatus_comprobante: dto.estatus_comprobante ?? 'SIN_COMPROBANTE',
      foto_url: dto.foto_url,
      valor_ia_extraido: dto.valor_ia_extraido,
      duplicado_sospechado: await this.looksLikeDuplicate(dto),
      notas: dto.notas,
      created_by: userId,
      updated_by: userId,
    };

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert(payload)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }

    // Captura OFFLINE con foto: el piloto no tuvo IA en campo — el servidor
    // lee el comprobante ahora y completa lo que falte (como el tacómetro:
    // la operación no se detiene y el dato llega completo igual).
    if (dto.leer_con_ia === true && dto.foto_url) {
      void this.enriquecerGastoConIA(
        (data as { id: string }).id,
        dto.foto_url,
        userId,
      ).catch((err) =>
        this.logger.warn(
          `Enriquecimiento IA del gasto falló: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    // Aviso a admin: el piloto subió un gasto desde campo.
    void this.notifications.notifyRole(
      Rol.ADMIN,
      {
        tipo: 'gasto_registrado',
        titulo: 'Gasto registrado',
        cuerpo: `${dto.categoria} · ${dto.moneda} ${Number(dto.monto).toLocaleString('en-US')}`,
        data: { gasto_id: (data as { id: string }).id, vuelo_id: dto.vuelo_id ?? null },
        link: dto.vuelo_id ? `/admin/flights/${dto.vuelo_id}` : '/admin/expenses',
      },
      userId,
    );

    return data!;
  }

  /**
   * Lee el comprobante de un gasto capturado OFFLINE y completa los campos
   * que el piloto no pudo llenar. REGLAS: lo manual NUNCA se pisa (el monto
   * jamás se toca; si la IA lee otro total, se anota para revisión). Se
   * completa: desglose→notas, fecha del ticket, categoría (solo si quedó
   * OTRO), tarjeta, litros/lugar en GAS, matrícula→aeronave si estaba vacía.
   */
  private async enriquecerGastoConIA(
    gastoId: string,
    fotoPath: string,
    userId: string,
  ): Promise<void> {
    const urls = await this.signPhotos([fotoPath]);
    const imageUrl = urls[fotoPath];
    if (!imageUrl) return;
    const ai = await this.vision.readGastoTicket({ imageUrl });
    if (!ai || ai.monto === undefined || !ai.legible) return;

    const gasto = await this.findById(gastoId);
    const patch: Record<string, unknown> = {
      valor_ia_extraido: ai,
      updated_by: userId,
    };

    // REGLA: lo que el piloto CAPTURÓ nunca se sobreescribe. Solo se llenan
    // huecos; toda diferencia IA-vs-captura se anota con ⚠ y se avisa a
    // oficina — los pilotos también se equivocan y debe quedar visible.
    const discrepancias: string[] = [];

    // Categoría: solo se llena si el piloto dejó la genérica; si eligió una
    // específica y la IA ve otra, discrepancia.
    if (gasto.categoria === 'OTRO' && ai.categoria_sugerida) {
      patch.categoria = ai.categoria_sugerida;
    } else if (
      ai.categoria_sugerida &&
      gasto.categoria !== 'OTRO' &&
      ai.categoria_sugerida !== gasto.categoria
    ) {
      discrepancias.push(
        `categoría capturada ${gasto.categoria as string}, la IA sugiere ${ai.categoria_sugerida}`,
      );
    }
    // Fecha: NO se pisa; si el ticket trae otra, discrepancia.
    if (
      ai.fecha &&
      /^\d{4}-\d{2}-\d{2}$/.test(ai.fecha) &&
      ai.fecha !== (gasto.fecha_gasto as string | null)
    ) {
      discrepancias.push(
        `fecha capturada ${gasto.fecha_gasto as string}, el ticket dice ${ai.fecha}`,
      );
    }
    // Moneda distinta = monto probablemente en la divisa equivocada.
    if (ai.moneda && ai.moneda !== gasto.moneda) {
      discrepancias.push(
        `moneda capturada ${gasto.moneda as string}, el ticket está en ${ai.moneda}`,
      );
    }
    // Total: nunca se toca; diferencia → discrepancia.
    if (ai.monto != null && Math.abs(Number(gasto.monto) - ai.monto) > 0.01) {
      discrepancias.push(
        `total capturado $${Number(gasto.monto).toFixed(2)} ${gasto.moneda}, la IA leyó $${ai.monto.toFixed(2)} ${ai.moneda ?? ''}`,
      );
    }
    // Tarjeta: llenar si falta; discrepancia si difiere.
    if (!gasto.tarjeta_terminacion && ai.tarjeta_terminacion) {
      patch.tarjeta_terminacion = ai.tarjeta_terminacion;
    } else if (
      ai.tarjeta_terminacion &&
      gasto.tarjeta_terminacion &&
      ai.tarjeta_terminacion !== gasto.tarjeta_terminacion
    ) {
      discrepancias.push(
        `tarjeta capturada •${gasto.tarjeta_terminacion as string}, el voucher dice •${ai.tarjeta_terminacion}`,
      );
    }
    if (gasto.categoria === 'GAS' || ai.categoria_sugerida === 'GAS') {
      if (gasto.litros == null && (ai as { litros?: number }).litros != null) {
        patch.litros = (ai as { litros?: number }).litros;
      }
    }
    // Matrícula del documento → avión (saca el gasto de la bandeja solo).
    if (ai.matricula) {
      const { data: aviones } = await this.supabase.service
        .from('aeronave')
        .select('id, matricula')
        .eq('activa', true);
      const norm = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const match = (aviones ?? []).find(
        (a) => norm(a.matricula as string) === norm(ai.matricula!),
      );
      if (match && !gasto.aeronave_id) {
        patch.aeronave_id = match.id;
      } else if (match && gasto.aeronave_id && match.id !== gasto.aeronave_id) {
        discrepancias.push(
          `el documento trae la matrícula ${match.matricula as string} pero el gasto está asignado a otro avión`,
        );
      }
    }

    // Notas: bloque IA (desglose renglón por renglón + proveedor + matrícula),
    // añadido DESPUÉS de lo que el piloto escribió, y las ⚠ discrepancias.
    const lineas: string[] = [];
    for (const c of ai.conceptos ?? []) {
      lineas.push(`${c.concepto} - $${c.monto.toFixed(2)} ${ai.moneda ?? gasto.moneda}`);
    }
    const extras = [ai.matricula, ai.proveedor, ai.concepto]
      .filter((v): v is string => !!v && v.trim().length > 0)
      .join(' · ');
    if (extras) lineas.push(extras);
    for (const d of discrepancias) lineas.push(`⚠ ${d} — revisar`);
    if (lineas.length > 0) {
      const bloque = `[IA al sincronizar]\n${lineas.join('\n')}`;
      patch.notas = gasto.notas ? `${gasto.notas}\n\n${bloque}` : bloque;
    }

    const { error } = await this.supabase.service
      .from('gasto')
      .update(patch)
      .eq('id', gastoId);
    if (error) throw new Error(error.message);

    // Con discrepancias, oficina se entera de inmediato (no solo en notas).
    if (discrepancias.length > 0) {
      const aviso = {
        tipo: 'alerta_sistema',
        titulo: 'Gasto con discrepancias IA vs captura',
        cuerpo: `${gasto.categoria as string} · $${Number(gasto.monto).toFixed(2)} ${gasto.moneda as string}: ${discrepancias[0]}${discrepancias.length > 1 ? ` (+${discrepancias.length - 1} más)` : ''}`,
        data: { gasto_id: gastoId },
        link: '/admin/expenses',
      };
      void this.notifications.notifyRole(Rol.ADMIN, aviso);
      void this.notifications.notifyRole(Rol.ANALISTA, aviso);
    }
    this.logger.log(
      `Gasto ${gastoId} enriquecido con IA al sincronizar (${discrepancias.length} discrepancias)`,
    );
  }

  /**
   * Posible duplicado (doble captura). Dos reglas, deterministas — más fiable
   * que IA para esto:
   * - CON proveedor: mismo proveedor + monto + moneda, fecha ±DUP_DAYS
   *   (regla del diseño funcional).
   * - SIN proveedor (capturas del piloto/mecánico desde la app): misma
   *   categoría + monto + moneda, fecha ±1 día — ventana corta para no marcar
   *   falsos positivos (dos taxis iguales en días distintos).
   * El flag NUNCA bloquea: la app avisa al capturista y el admin lo lista.
   */
  private async looksLikeDuplicate(dto: CreateGastoDto): Promise<boolean> {
    const base = new Date(`${dto.fecha_gasto}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return false;
    const dias = dto.proveedor_id ? DUP_DAYS : 1;
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - dias);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + dias);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    let q = this.supabase.service
      .from('gasto')
      .select('id')
      .eq('moneda', dto.moneda)
      .eq('monto', dto.monto)
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .limit(1);
    q = dto.proveedor_id
      ? q.eq('proveedor_id', dto.proveedor_id)
      : q.eq('categoria', dto.categoria);
    const { data, error } = await q;
    if (error) return false; // la detección no debe bloquear la captura
    return (data ?? []).length > 0;
  }

  /**
   * Sugiere a qué vuelo corresponde una carga de combustible según la
   * aeronave (matrícula) y el momento de la carga:
   *  - si la carga cae dentro de la ventana del vuelo (en ruta) → ese vuelo;
   *  - si no → la SIGUIENTE salida de esa aeronave (la carga de las 6 pm
   *    "previene" el siguiente vuelo, aunque sea días después).
   * Devuelve el sugerido + candidatos cercanos para confirmar/cambiar.
   */
  async sugerirVuelo(aeronaveId: string, fechaHoraIso: string) {
    const t = new Date(fechaHoraIso).getTime();
    if (!Number.isFinite(t)) {
      throw new BadRequestException('fecha_hora inválida (usa ISO 8601)');
    }
    const desde = new Date(t - 7 * 86_400_000).toISOString();
    const hasta = new Date(t + 14 * 86_400_000).toISOString();

    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, origen_iata, destino_iata, estado, fecha_vuelo, fecha_traslado_final, aeronave_id, escalas:escala(aeronave_id, fecha_salida_plan, hora_salida, hora_llegada)',
      )
      .neq('estado', 'CANCELADO')
      .not('fecha_vuelo', 'is', null)
      .gte('fecha_vuelo', desde)
      .lte('fecha_vuelo', hasta)
      .order('fecha_vuelo', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    interface LegRow {
      aeronave_id: string | null;
      fecha_salida_plan: string | null;
      hora_salida: string | null;
      hora_llegada: string | null;
    }
    const ms = (v: string | null) => (v ? new Date(v).getTime() : null);

    const deAvion = (data ?? [])
      .map((v) => {
        const escalas = ((v.escalas as LegRow[] | null) ?? []).filter(
          (e) =>
            e.aeronave_id === aeronaveId ||
            (e.aeronave_id == null && v.aeronave_id === aeronaveId),
        );
        const esDeAvion = v.aeronave_id === aeronaveId || escalas.length > 0;
        if (!esDeAvion) return null;
        const salidas = escalas
          .map((e) => ms(e.fecha_salida_plan))
          .filter((x): x is number => x != null);
        const llegadas = escalas
          .map((e) => ms(e.hora_llegada))
          .filter((x): x is number => x != null);
        const inicio = salidas.length
          ? Math.min(...salidas)
          : (ms(v.fecha_vuelo as string) ?? t);
        const fin = Math.max(
          ms(v.fecha_traslado_final as string | null) ?? inicio,
          salidas.length ? Math.max(...salidas) : inicio,
          llegadas.length ? Math.max(...llegadas) : inicio,
        );
        return { v, inicio, fin };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const VENTANA_ANTES_MS = 3 * 3_600_000; // carga previa al primer despegue
    const VENTANA_DESPUES_MS = 2 * 3_600_000; // carga justo al cerrar el vuelo

    const toItem = (c: (typeof deAvion)[number]) => ({
      vuelo_id: c.v.id as string,
      folio: c.v.folio as number,
      origen_iata: c.v.origen_iata as string,
      destino_iata: c.v.destino_iata as string,
      estado: c.v.estado as string,
      fecha_vuelo: c.v.fecha_vuelo as string,
    });

    // 1) Carga en ruta: cae dentro de la ventana del vuelo (o va en el aire).
    const enRuta = deAvion.find(
      (c) =>
        (t >= c.inicio - VENTANA_ANTES_MS && t <= c.fin + VENTANA_DESPUES_MS) ||
        (c.v.estado === 'EN_VUELO' && t >= c.inicio - VENTANA_ANTES_MS),
    );
    // 2) Previno: la siguiente salida de la aeronave después de la carga.
    const siguiente = deAvion
      .filter((c) => c.inicio >= t)
      .sort((a, b) => a.inicio - b.inicio)[0];
    // 3) Fallback: el vuelo más cercano hacia atrás.
    const anterior = deAvion
      .filter((c) => c.inicio < t)
      .sort((a, b) => b.inicio - a.inicio)[0];

    const elegido = enRuta ?? siguiente ?? anterior ?? null;
    const razon = enRuta
      ? 'EN_RUTA'
      : siguiente
        ? 'SIGUIENTE_SALIDA'
        : anterior
          ? 'VUELO_ANTERIOR'
          : null;

    const candidatos = deAvion
      .slice()
      .sort((a, b) => Math.abs(a.inicio - t) - Math.abs(b.inicio - t))
      .slice(0, 5)
      .map(toItem);

    return {
      sugerido: elegido ? { ...toItem(elegido), razon } : null,
      candidatos,
    };
  }

  /**
   * Regla del doc 5.2/5.3: el CAPTURISTA (piloto/mecánico) corrige o borra su
   * gasto SOLO el mismo día de la captura (hora Cancún) y solo si aún no está
   * conciliado. Después, únicamente oficina. Lanza si no cumple.
   */
  async assertOwnSameDay(id: string, userId: string): Promise<void> {
    const gasto = await this.findById(id);
    if (gasto.usuario_captura_id !== userId) {
      throw new ForbiddenException('Solo puedes corregir gastos capturados por ti.');
    }
    if (gasto.conciliado === true) {
      throw new ConflictException(
        'Este gasto ya está conciliado con el banco; pide el ajuste a oficina.',
      );
    }
    const dia = (iso: string | Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
        typeof iso === 'string' ? new Date(iso) : iso,
      );
    if (dia(gasto.created_at as string) !== dia(new Date())) {
      throw new ForbiddenException(
        'Los gastos solo se corrigen el mismo día. Pide el ajuste a oficina.',
      );
    }
  }

  async update(id: string, dto: UpdateGastoDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.service.from('gasto').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }
}
