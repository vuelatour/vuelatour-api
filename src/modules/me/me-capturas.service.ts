import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { CapturasQuery } from './dto/capturas.dto';
import { soloPendientes } from '../../common/taco-motivo.util';

/**
 * Historial de capturas del usuario de campo (piloto/mecánico/apoyo).
 *
 * El outbox local de la app se vacía al sincronizar y al usuario le queda la
 * duda de "¿se subió?, ¿se subió bien?". Este servicio responde con lo que el
 * SERVIDOR tiene registrado a nombre del usuario (fuente de verdad), unificado
 * en una sola línea de tiempo: gastos, combustible, cobros, tacómetros y
 * mantenimientos. SIEMPRE filtra por el usuario autenticado — es su historial;
 * jamás expone capturas (ni datos financieros) de otros.
 */

export type TipoCaptura =
  | 'GASTO'
  | 'COMBUSTIBLE'
  | 'COBRO'
  | 'TACO'
  | 'MANTENIMIENTO';

export type EstadoCaptura = 'OK' | 'EN_REVISION' | 'POSIBLE_DUPLICADO';

export interface CapturaItem {
  tipo: TipoCaptura;
  id: string;
  /** ISO: cuándo quedó el registro en el servidor. */
  fecha: string;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  ruta: string | null;
  titulo: string;
  detalle: string | null;
  estado: EstadoCaptura;
}

type Row = Record<string, unknown>;

/** es-MX: 6003.91 → "6,003.91" (montos siempre con 2 decimales). */
const fmtMonto = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** Lecturas de tacómetro con 1 decimal: 1589.4 → "1,589.4". */
const fmtTaco = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** Litros sin decimales forzados: 250 → "250", 250.5 → "250.5". */
const fmtLitros = new Intl.NumberFormat('es-MX', {
  maximumFractionDigits: 1,
});

/** Joins embebidos de supabase-js llegan como objeto o arreglo según metadata. */
function flatten(value: unknown): Row | null {
  const v: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  return v && typeof v === 'object' ? (v as Row) : null;
}

function trunc(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** proveedor/lugar/notas breves → una sola línea de máx ~80 chars. */
function detalleDe(...partes: Array<unknown>): string | null {
  const linea = partes
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' · ');
  return trunc(linea);
}

@Injectable()
export class MeCapturasService {
  constructor(private readonly supabase: SupabaseService) {}

  async capturas(
    userId: string,
    query: CapturasQuery,
  ): Promise<{ data: CapturaItem[]; count: number }> {
    const limit = query.limit ?? 60;
    // Corte de día SIEMPRE en hora Cancún (invariante del repo).
    const desdeIso = query.desde ? `${query.desde}T00:00:00-05:00` : null;
    const desdeMs = desdeIso ? new Date(desdeIso).getTime() : null;

    // ===== 4 fuentes en paralelo, cada una ya filtrada por el usuario =====
    let gastosQ = this.supabase.service
      .from('gasto')
      .select(
        'id, vuelo_id, categoria, monto, moneda, litros, lugar, notas, duplicado_sospechado, created_at, proveedor:proveedor!proveedor_id(nombre)',
      )
      .eq('usuario_captura_id', userId);
    if (desdeIso) gastosQ = gastosQ.gte('created_at', desdeIso);

    let cobrosQ = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, metodo_cobro, referencia, notas, created_at',
      )
      .eq('registrado_por', userId);
    if (desdeIso) cobrosQ = cobrosQ.gte('created_at', desdeIso);

    // Tacómetros: una escala = una captura. La fecha visible es
    // sincronizado_at ?? updated_at; updated_at >= sincronizado_at siempre
    // (la sincronización escribe la fila), así que filtrar por updated_at en
    // BD es un superconjunto seguro y el corte fino se aplica abajo.
    let tacosQ = this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, taco_salida, taco_llegada, taco_salida_origen, taco_llegada_origen, revision_requerida, revision_motivo, sincronizado_at, updated_at',
      )
      .eq('capturado_por', userId)
      .or('taco_salida.not.is.null,taco_llegada.not.is.null');
    if (desdeIso) tacosQ = tacosQ.gte('updated_at', desdeIso);

    let mantQ = this.supabase.service
      .from('mantenimiento')
      .select(
        'id, estado, tipo, descripcion, created_at, aeronave:aeronave!aeronave_id(matricula)',
      )
      .eq('created_by', userId);
    if (desdeIso) mantQ = mantQ.gte('created_at', desdeIso);

    // Traer `limit` por fuente basta: el top-limit del merge nunca necesita
    // más de `limit` filas de una sola fuente.
    const [gastos, cobros, tacos, mants] = await Promise.all([
      gastosQ.order('created_at', { ascending: false }).limit(limit),
      cobrosQ.order('created_at', { ascending: false }).limit(limit),
      tacosQ.order('updated_at', { ascending: false }).limit(limit),
      mantQ.order('created_at', { ascending: false }).limit(limit),
    ]);
    for (const r of [gastos, cobros, tacos, mants]) {
      if (r.error) throw new Error(r.error.message);
    }
    const gastoRows = (gastos.data ?? []) as Row[];
    const cobroRows = (cobros.data ?? []) as Row[];
    const tacoRows = (tacos.data ?? []) as Row[];
    const mantRows = (mants.data ?? []) as Row[];

    // ===== Lookups batch de folio y ruta (cero N+1) =====
    const vueloIds = [
      ...new Set(
        [...gastoRows, ...cobroRows, ...tacoRows]
          .map((r) => r.vuelo_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const { folios, rutas } = await this.vuelosLookup(vueloIds);

    // ===== Unificar =====
    const items: CapturaItem[] = [
      ...gastoRows.map((g) => this.itemGasto(g, folios, rutas)),
      ...cobroRows.map((c) => this.itemCobro(c, folios, rutas)),
      ...tacoRows.map((e) => this.itemTaco(e, folios)),
      ...mantRows.map((m) => this.itemMantenimiento(m)),
    ];

    const conCorte =
      desdeMs == null
        ? items
        : items.filter((i) => new Date(i.fecha).getTime() >= desdeMs);
    conCorte.sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );
    const data = conCorte.slice(0, limit);
    return { data, count: data.length };
  }

  /**
   * Folio y ruta operativa completa (origen → escalas → destino) de un lote
   * de vuelos en 2 queries. Vuelos sin escalas caen a origen/destino propios.
   */
  private async vuelosLookup(vueloIds: string[]): Promise<{
    folios: Map<string, number>;
    rutas: Map<string, string>;
  }> {
    const folios = new Map<string, number>();
    const rutas = new Map<string, string>();
    if (vueloIds.length === 0) return { folios, rutas };

    const [vuelos, escalas] = await Promise.all([
      this.supabase.service
        .from('vuelo')
        .select('id, folio, origen_iata, destino_iata')
        .in('id', vueloIds),
      this.supabase.service
        .from('escala')
        .select('vuelo_id, orden, origen_iata, destino_iata')
        .in('vuelo_id', vueloIds)
        .order('orden', { ascending: true }),
    ]);
    if (vuelos.error) throw new Error(vuelos.error.message);
    if (escalas.error) throw new Error(escalas.error.message);

    const puntosPorVuelo = new Map<string, string[]>();
    for (const e of (escalas.data ?? []) as Row[]) {
      const vid = e.vuelo_id as string;
      const puntos = puntosPorVuelo.get(vid);
      if (!puntos) {
        puntosPorVuelo.set(vid, [
          e.origen_iata as string,
          e.destino_iata as string,
        ]);
      } else {
        puntos.push(e.destino_iata as string);
      }
    }
    for (const v of (vuelos.data ?? []) as Row[]) {
      const id = v.id as string;
      if (v.folio != null) folios.set(id, Number(v.folio));
      const puntos =
        puntosPorVuelo.get(id) ??
        [v.origen_iata as string, v.destino_iata as string].filter(Boolean);
      if (puntos.length >= 2) rutas.set(id, puntos.join(' → '));
    }
    return { folios, rutas };
  }

  private itemGasto(
    g: Row,
    folios: Map<string, number>,
    rutas: Map<string, string>,
  ): CapturaItem {
    const categoria = (g.categoria as string) ?? 'GASTO';
    const monto = `$${fmtMonto.format(Number(g.monto))} ${g.moneda as string}`;
    const esCombustible = categoria === 'GAS';
    const litros = g.litros == null ? null : Number(g.litros);
    const titulo = esCombustible
      ? litros != null && Number.isFinite(litros) && litros > 0
        ? `Combustible ${fmtLitros.format(litros)} L · ${monto}`
        : `Combustible · ${monto}`
      : // PERSONAL_DUENO se lee mal crudo en Mis registros (26-ago).
        `Gasto ${categoria === 'PERSONAL_DUENO' ? 'Personal del dueño' : categoria} · ${monto}`;
    const vueloId = (g.vuelo_id as string | null) ?? null;
    return {
      tipo: esCombustible ? 'COMBUSTIBLE' : 'GASTO',
      id: g.id as string,
      fecha: g.created_at as string,
      vuelo_id: vueloId,
      vuelo_folio: vueloId ? (folios.get(vueloId) ?? null) : null,
      ruta: vueloId ? (rutas.get(vueloId) ?? null) : null,
      titulo,
      detalle: detalleDe(flatten(g.proveedor)?.nombre, g.lugar, g.notas),
      estado: g.duplicado_sospechado === true ? 'POSIBLE_DUPLICADO' : 'OK',
    };
  }

  private itemCobro(
    c: Row,
    folios: Map<string, number>,
    rutas: Map<string, string>,
  ): CapturaItem {
    const monto = `$${fmtMonto.format(Number(c.monto))} ${c.moneda as string}`;
    const vueloId = (c.vuelo_id as string | null) ?? null;
    return {
      tipo: 'COBRO',
      id: c.id as string,
      fecha: c.created_at as string,
      vuelo_id: vueloId,
      vuelo_folio: vueloId ? (folios.get(vueloId) ?? null) : null,
      ruta: vueloId ? (rutas.get(vueloId) ?? null) : null,
      titulo: `Cobro ${monto} · ${(c.metodo_cobro as string) ?? 's/método'}`,
      detalle: detalleDe(c.referencia, c.notas),
      estado: 'OK',
    };
  }

  private itemTaco(e: Row, folios: Map<string, number>): CapturaItem {
    // Solo las lecturas que capturó una persona (PILOTO/IA/OFICINA); las
    // DEDUCIDO son del sistema y no son evidencia de captura del usuario.
    const partes: string[] = [];
    if (e.taco_salida != null && e.taco_salida_origen !== 'DEDUCIDO') {
      partes.push(`salida ${fmtTaco.format(Number(e.taco_salida))}`);
    }
    if (e.taco_llegada != null && e.taco_llegada_origen !== 'DEDUCIDO') {
      partes.push(`llegada ${fmtTaco.format(Number(e.taco_llegada))}`);
    }
    if (partes.length === 0) {
      // Corrección posterior dejó ambas como DEDUCIDO: muestra lo que hay.
      if (e.taco_llegada != null) {
        partes.push(`llegada ${fmtTaco.format(Number(e.taco_llegada))}`);
      } else if (e.taco_salida != null) {
        partes.push(`salida ${fmtTaco.format(Number(e.taco_salida))}`);
      }
    }
    const origen = e.origen_iata as string | null;
    const destino = e.destino_iata as string | null;
    const tramo = origen && destino ? ` · tramo ${origen}→${destino}` : '';
    const vueloId = (e.vuelo_id as string | null) ?? null;
    const enRevision = e.revision_requerida === true;
    return {
      tipo: 'TACO',
      id: e.id as string,
      fecha: ((e.sincronizado_at as string | null) ?? e.updated_at) as string,
      vuelo_id: vueloId,
      vuelo_folio: vueloId ? (folios.get(vueloId) ?? null) : null,
      ruta: origen && destino ? `${origen} → ${destino}` : null,
      titulo: `Tacómetro ${partes.join(' / ')}${tramo}`,
      detalle: enRevision
        ? (trunc(soloPendientes(e.revision_motivo as string | null)) ??
          'En revisión de oficina')
        : null,
      estado: enRevision ? 'EN_REVISION' : 'OK',
    };
  }

  private itemMantenimiento(m: Row): CapturaItem {
    const estadoTxt =
      m.estado === 'EN_TALLER'
        ? 'en taller'
        : m.estado === 'COMPLETADO' || m.tipo === 'REALIZADO'
          ? 'completado'
          : 'programado';
    const matricula = flatten(m.aeronave)?.matricula as string | undefined;
    return {
      tipo: 'MANTENIMIENTO',
      id: m.id as string,
      fecha: m.created_at as string,
      vuelo_id: null,
      vuelo_folio: null,
      ruta: null,
      titulo: `Mantenimiento ${estadoTxt}${matricula ? ` · ${matricula}` : ''}`,
      detalle: trunc(m.descripcion),
      estado: 'OK',
    };
  }
}
