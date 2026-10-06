/**
 * «Vincular gasto»: POR QUÉ un gasto NO aparece entre los candidatos de un
 * CARGO (6-oct-2026, API 0.0.63). Caso real: cargo de $212.00 del 07-sep
 * (ASUR CANCUN, cuenta GASTOS GNRAL); la oficina buscó «212» y vio «Ningún
 * gasto pendiente coincide con 212 en ±30 días». Había TRES gastos de
 * $212.00 (24, 27 y 28-sep, estacionamiento ASUR, vuelos #338 y #330)… en
 * EFECTIVO, y el universo de candidatos es SOLO de medios bancarios
 * (`MEDIOS_BANCARIOS`), sin conciliar, en la moneda de la cuenta y dentro de
 * la ventana. La oficina creyó que era un bug.
 *
 * Con la lista de candidatos VACÍA, `GET movimientos/:id/gastos-candidatos`
 * hace UNA consulta extra —gastos del MISMO monto (±0.01) a ±max(120, dias)
 * del cargo, sin filtrar medio, conciliado ni moneda— y aquí, PURO y con
 * spec, se decide el motivo de cada uno y se arman los grupos que viajan en
 * `excluidos`. Nadie más clasifica: el panel solo redacta.
 */
import { TOLERANCIA_CENTAVOS, ventanaDias } from './auto-cruce.util';
import {
  interpretarBusquedaGasto,
  MEDIOS_BANCARIOS,
} from './gastos-candidatos.util';
import { difDias } from './paywise-cruce.util';

/**
 * Motivos en orden de PRECEDENCIA (y orden de los grupos en la respuesta):
 * gana el motivo que ninguna otra acción del diálogo arregla.
 * - `EFECTIVO_U_OTRO_MEDIO`: medio fuera de `MEDIOS_BANCARIOS` (EFECTIVO,
 *   BODEGA, PERSONAL_*). Ampliar la ventana no lo trae: hay que corregir el
 *   medio de pago del gasto (si de verdad se pagó con tarjeta).
 * - `YA_CONCILIADO`: ya está cubierto por otro(s) cargo(s). Gana a la moneda:
 *   un gasto USD conciliado 1 ↔ 1 contra pesos ya está tomado, y su moneda no
 *   se edita (candado `GASTO_CONCILIADO`).
 * - `OTRA_MONEDA`: no está en la moneda de la cuenta del cargo (y no entró
 *   como cruzado con T.C. implícito 15–25).
 * - `FUERA_DE_VENTANA`: dentro de ±120 días pero fuera de los ±dias pedidos.
 */
export const MOTIVOS_EXCLUSION = [
  'EFECTIVO_U_OTRO_MEDIO',
  'YA_CONCILIADO',
  'OTRA_MONEDA',
  'FUERA_DE_VENTANA',
] as const;

export type MotivoExclusion = (typeof MOTIVOS_EXCLUSION)[number];

/** La consulta extra mira ±120 días del cargo (o ±dias, si se pidió más). */
export const EXCLUIDOS_DIAS = 120;

/** Gastos que viajan por motivo (`n` cuenta TODOS los del motivo). */
export const EXCLUIDOS_POR_MOTIVO = 5;

/**
 * Tope de la consulta extra. Va filtrada por monto (±0.01) y por fechas: ni
 * los 29 «Pago VIP SAESA» iguales se acercan, así que el tope de 1000 de
 * PostgREST no aplica (no se pagina).
 */
export const EXCLUIDOS_LECTURA_TOPE = 500;

/** Columnas de la consulta extra (lo que lee `gastoExcluibleDeFila`). */
export const GASTO_EXCLUIDO_COLS =
  'id, fecha_gasto, monto, moneda, medio_pago, categoria, conciliado, vuelo_id, vuelo:vuelo!vuelo_id(folio)';

/** Gasto leído por la consulta extra, ya normalizado. */
export interface GastoExcluible {
  id: string;
  fecha_gasto: string | null;
  monto: number;
  moneda: string | null;
  medio_pago: string | null;
  categoria: string | null;
  conciliado: boolean;
  vuelo_id: string | null;
  vuelo_folio: number | null;
}

/** Cargo del banco con el que YA está conciliado un gasto (de la puente). */
export interface CargoConciliadoExcluido {
  movimiento_id: string;
  /** Fecha del cargo (YYYY-MM-DD). */
  fecha: string | null;
  /** Lo que ESE cargo aporta al gasto (`monto_parte`). */
  monto: number;
  /** Moneda de la CUENTA del cargo (la de la parte). */
  moneda: string | null;
  /** Alias de la cuenta del cargo («GASTOS GNRAL»). */
  cuenta: string | null;
}

/** Ficha de un gasto excluido tal como viaja (≤ 5 por motivo). */
export interface GastoExcluido {
  id: string;
  fecha_gasto: string | null;
  monto: number;
  moneda: string | null;
  medio_pago: string | null;
  categoria: string | null;
  /** Para ligar al vuelo (`/admin/flights/:id`); null = gasto sin vuelo. */
  vuelo_id: string | null;
  vuelo_folio: number | null;
  /**
   * SOLO en `YA_CONCILIADO`: los cargos con los que ya está conciliado (el
   * más viejo primero). `[]` = conciliado sin cargo en la puente; `null` = no
   * se pudo leer la puente.
   */
  conciliado_con?: CargoConciliadoExcluido[] | null;
}

/** Un grupo de `excluidos`. */
export interface GrupoExcluidos {
  motivo: MotivoExclusion;
  /** Cuántos gastos caen en este motivo (TODOS, no solo los que viajan). */
  n: number;
  /** Los ≤ 5 más cercanos a la fecha del cargo, en orden cronológico. */
  gastos: GastoExcluido[];
}

/** Campos ADITIVOS de la respuesta de candidatos (solo con la lista vacía). */
export interface ExcluidosCandidatos {
  excluidos: GrupoExcluidos[];
  /** Monto con el que se buscaron (el de `q` si es numérico; si no, el del cargo). */
  excluidos_monto: number;
}

/** Lo que la clasificación necesita del cargo y de la búsqueda. */
export interface ContextoExclusion {
  /** Moneda de la CUENTA del cargo. */
  monedaCuenta: string;
  /** Ventana de los candidatos (±dias pedidos). */
  ventana: { desde: string; hasta: string };
  /** Fecha del cargo (YYYY-MM-DD): elige los más cercanos. */
  fechaCargo: string;
}

const c2 = (x: number) => Math.round(x * 100) / 100;

const cmpTexto = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Monto de la consulta extra: el de `q` cuando es numérico (entero «212» ⇒
 * 212; con decimales «2801.40» ⇒ lo tecleado) y, sin búsqueda o con texto,
 * el |monto| del cargo. Así un cargo de $8,404.20 buscado como «2801.40»
 * explica los gastos de $2,801.40, que son los que la oficina busca.
 */
export function montoReferenciaExcluidos(
  q: string | null | undefined,
  montoCargo: number,
): number {
  const b = interpretarBusquedaGasto(q);
  if (b.tipo === 'monto') {
    return b.maxExclusivo ? c2(b.min) : c2((b.min + b.max) / 2);
  }
  return c2(Math.abs(Number(montoCargo) || 0));
}

/** Banda [min, max] de la consulta extra: el MISMO monto ±0.01. */
export function bandaMontoExcluidos(monto: number): {
  min: number;
  max: number;
} {
  const m = c2(Math.abs(Number(monto) || 0));
  return {
    min: c2(m - TOLERANCIA_CENTAVOS),
    max: c2(m + TOLERANCIA_CENTAVOS),
  };
}

/** Ventana de la consulta extra: ±max(120, dias) — nunca más angosta que la de los candidatos. */
export function ventanaExcluidos(
  fechaCargo: string,
  dias: number,
): { desde: string; hasta: string } {
  const pedidos = Math.trunc(Math.abs(Number(dias) || 0));
  return ventanaDias(fechaCargo, Math.max(EXCLUIDOS_DIAS, pedidos));
}

/** Fila cruda de PostgREST (`GASTO_EXCLUIDO_COLS`) ⇒ gasto normalizado; null sin id. */
export function gastoExcluibleDeFila(
  f: Record<string, unknown>,
): GastoExcluible | null {
  if (typeof f.id !== 'string' || !f.id) return null;
  const vuelo = unwrap(
    f.vuelo as { folio?: unknown } | { folio?: unknown }[] | null | undefined,
  );
  const folio = vuelo?.folio == null ? null : Number(vuelo.folio);
  return {
    id: f.id,
    fecha_gasto:
      typeof f.fecha_gasto === 'string' ? f.fecha_gasto.slice(0, 10) : null,
    monto: c2(Number(f.monto) || 0),
    moneda: typeof f.moneda === 'string' ? f.moneda : null,
    medio_pago: typeof f.medio_pago === 'string' ? f.medio_pago : null,
    categoria: typeof f.categoria === 'string' ? f.categoria : null,
    conciliado: f.conciliado === true,
    vuelo_id: typeof f.vuelo_id === 'string' ? f.vuelo_id : null,
    vuelo_folio: folio != null && Number.isFinite(folio) ? folio : null,
  };
}

/**
 * Por qué ESTE gasto no es candidato del cargo (precedencia de
 * `MOTIVOS_EXCLUSION`). `null` = SÍ es del universo (medio bancario, sin
 * conciliar, moneda de la cuenta y dentro de la ventana): si no salió fue
 * por la búsqueda de TEXTO, y eso no se reporta.
 */
export function motivoExclusion(
  g: GastoExcluible,
  ctx: ContextoExclusion,
): MotivoExclusion | null {
  if (!MEDIOS_BANCARIOS.includes(g.medio_pago ?? '')) {
    return 'EFECTIVO_U_OTRO_MEDIO';
  }
  if (g.conciliado) return 'YA_CONCILIADO';
  if ((g.moneda ?? '') !== ctx.monedaCuenta) return 'OTRA_MONEDA';
  const f = (g.fecha_gasto ?? '').slice(0, 10);
  if (!f || f < ctx.ventana.desde || f > ctx.ventana.hasta) {
    return 'FUERA_DE_VENTANA';
  }
  return null;
}

/** Ficha que viaja (sin `conciliado`: el motivo ya lo dice). */
function aGastoExcluido(g: GastoExcluible): GastoExcluido {
  return {
    id: g.id,
    fecha_gasto: g.fecha_gasto,
    monto: g.monto,
    moneda: g.moneda,
    medio_pago: g.medio_pago,
    categoria: g.categoria,
    vuelo_id: g.vuelo_id,
    vuelo_folio: g.vuelo_folio,
  };
}

/**
 * Agrupa por motivo, en el orden de `MOTIVOS_EXCLUSION`: `n` = todos los del
 * motivo; `gastos` = los `EXCLUIDOS_POR_MOTIVO` más CERCANOS a la fecha del
 * cargo, pintados en orden CRONOLÓGICO (empates por id). Un id repetido
 * cuenta una vez; los del universo (`null`) no se reportan; un motivo sin
 * gastos no viaja. Sin nada que explicar ⇒ `[]`.
 */
export function agruparExcluidos(
  filas: readonly GastoExcluible[],
  ctx: ContextoExclusion,
): GrupoExcluidos[] {
  const vistos = new Set<string>();
  const porMotivo = new Map<MotivoExclusion, GastoExcluible[]>();
  for (const g of filas) {
    if (!g.id || vistos.has(g.id)) continue;
    vistos.add(g.id);
    const motivo = motivoExclusion(g, ctx);
    if (!motivo) continue;
    const lista = porMotivo.get(motivo) ?? [];
    lista.push(g);
    porMotivo.set(motivo, lista);
  }
  const distancia = (g: GastoExcluible) =>
    g.fecha_gasto
      ? difDias(ctx.fechaCargo, g.fecha_gasto)
      : Number.POSITIVE_INFINITY;
  const cronologico = (a: GastoExcluible, b: GastoExcluible) =>
    cmpTexto(a.fecha_gasto ?? '', b.fecha_gasto ?? '') || cmpTexto(a.id, b.id);
  const grupos: GrupoExcluidos[] = [];
  for (const motivo of MOTIVOS_EXCLUSION) {
    const lista = porMotivo.get(motivo);
    if (!lista || lista.length === 0) continue;
    const cercanos = [...lista]
      .sort((a, b) => distancia(a) - distancia(b) || cronologico(a, b))
      .slice(0, EXCLUIDOS_POR_MOTIVO)
      .sort(cronologico);
    grupos.push({
      motivo,
      n: lista.length,
      gastos: cercanos.map(aGastoExcluido),
    });
  }
  return grupos;
}

/**
 * Partes de la puente + sus movimientos (`id, fecha, cuenta(alias)`) ⇒
 * gasto_id → cargos con los que ya está conciliado, el más viejo primero.
 */
export function cargosConciliadosPorGasto(
  partes: ReadonlyArray<{
    movimiento_id: string;
    gasto_id: string;
    monto_parte: number;
    moneda: string | null;
  }>,
  movimientos: ReadonlyArray<Record<string, unknown>>,
): Map<string, CargoConciliadoExcluido[]> {
  const movDe = new Map<
    string,
    { fecha: string | null; cuenta: string | null }
  >();
  for (const m of movimientos) {
    if (typeof m.id !== 'string') continue;
    const cuenta = unwrap(
      m.cuenta as { alias?: unknown } | { alias?: unknown }[] | null,
    );
    movDe.set(m.id, {
      fecha: typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : null,
      cuenta: typeof cuenta?.alias === 'string' ? cuenta.alias : null,
    });
  }
  const out = new Map<string, CargoConciliadoExcluido[]>();
  for (const p of partes) {
    const mov = movDe.get(p.movimiento_id);
    const lista = out.get(p.gasto_id) ?? [];
    lista.push({
      movimiento_id: p.movimiento_id,
      fecha: mov?.fecha ?? null,
      monto: c2(Math.abs(Number(p.monto_parte) || 0)),
      moneda: p.moneda ?? null,
      cuenta: mov?.cuenta ?? null,
    });
    out.set(p.gasto_id, lista);
  }
  for (const lista of out.values()) {
    lista.sort(
      (a, b) =>
        cmpTexto(a.fecha ?? '', b.fecha ?? '') ||
        cmpTexto(a.movimiento_id, b.movimiento_id),
    );
  }
  return out;
}

/**
 * Pone `conciliado_con` en CADA gasto de `YA_CONCILIADO` (y solo ahí):
 * `cargos` null (la puente no se pudo leer) ⇒ `null`; si no, sus cargos
 * (`[]` si no tiene). Los demás grupos salen intactos.
 */
export function conCargosConciliados(
  grupos: readonly GrupoExcluidos[],
  cargos: ReadonlyMap<string, readonly CargoConciliadoExcluido[]> | null,
): GrupoExcluidos[] {
  return grupos.map((gr) =>
    gr.motivo !== 'YA_CONCILIADO'
      ? gr
      : {
          ...gr,
          gastos: gr.gastos.map((g) => ({
            ...g,
            conciliado_con:
              cargos === null ? null : [...(cargos.get(g.id) ?? [])],
          })),
        },
  );
}
