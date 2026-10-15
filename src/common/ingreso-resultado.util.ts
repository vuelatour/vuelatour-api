/**
 * FILA DE LIBRO de un ingreso sin vuelo (24-sep-2026) — FUENTE ÚNICA que
 * comparten el Libro Dinero (hoja «Otros ingresos», lo que el DF §10.2 llama
 * «ingresos no de vuelo») y el Balance general (pestaña «Otros movimientos»,
 * sección MOVIMIENTOS SIN AVIÓN / SIN VUELO). Si cada libro convirtiera por
 * su cuenta, los dos dirían cifras distintas del MISMO ingreso.
 *
 * Reglas:
 * - Solo categorías que SUMAN A RESULTADOS (`categoriaIngresoSumaAResultados`):
 *   anticipos y aportaciones/préstamos ⇒ null (no son resultado; el anticipo
 *   cuenta como cobro del vuelo al aplicarse).
 * - MXN directo; USD × `tc_usd_mxn` PROPIO del ingreso (sin promedio: así
 *   los dos libros dicen el mismo número). Sin TC ⇒ `ingreso_mxn` null y el
 *   concepto termina en «(USD sin TC — no suma)» — jamás un USD sumado como
 *   pesos (defensa: el CHECK `ingreso_tc_resultado_chk` ya lo impide).
 * - Comisión bancaria del ingreso ⇒ egreso «comisión bancaria» con la MISMA
 *   conversión y `remanente_mxn = ingreso − comisión`.
 *
 * INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67): un
 * ingreso de resultado cuenta UNA vez: su avión XOR VuelaTour;
 * `ingreso.fecha` decide el mes. La partición ÚNICA es
 * `partirIngresosPorAvion` (la usan el libro individual, el Balance general
 * —una sola lectura—, el Libro Dinero y el reparto): con `aeronave_id` ⇒ la
 * hoja «Otros ingresos» de ese avión, su cascada y su reparto; sin avión ⇒
 * «otros movimientos» del general y «Otros ingresos» del Libro Dinero, como
 * siempre. `filaLibroDeIngreso` y `leerIngresosDeResultado` NO cambian.
 *
 * CONVERSIÓN ÚNICA DEL INGRESO DE UN AVIÓN (decisión del cliente del
 * 14-oct-2026: «hazlo, si es lo mejor hazlo»; API 0.0.77, invariante 67):
 * balance, reparto y tablero convierten CADA ingreso asignado a un avión con
 * la MISMA función pura `usdDeIngresoAvion` (USD ⇒ su neto; MXN ⇒ neto ÷ T.C.
 * propio ?? T.C. del gasto LIGADO ?? oficial del día de su `fecha`). El día
 * del oficial lo decide `diaTcOficialIngreso` y el oficial sale de la única
 * puerta `TipoCambioService.oficialDetallePara` (cada libro con su lote).
 * El lector lee además `gasto_id` (el gasto que reembolsa un
 * REEMBOLSO_DEVOLUCION; la columna existe desde 20260924000004).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CATEGORIAS_INGRESO_RESULTADO,
  categoriaIngresoSumaAResultados,
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
} from './categoria-ingreso.util';
import { fmtDineroTexto } from './dinero-texto.util';
import { ingresosDisponibles } from './ingreso-disponible.util';

export interface IngresoParaLibro {
  id: string;
  folio: number;
  categoria: string;
  /** Día de pared Cancún (YYYY-MM-DD). */
  fecha: string;
  descripcion: string;
  /** BRUTO. */
  monto: number;
  comision_monto: number | null;
  moneda: 'MXN' | 'USD';
  tc_usd_mxn: number | null;
  cliente_nombre: string | null;
  pagador: string | null;
  vuelo_folio: number | null;
  matricula: string | null;
  aeronave_color: string | null;
  /**
   * ADITIVOS (13-oct-2026, API 0.0.75, invariante 67), OPCIONALES para que
   * los literales de los specs sigan compilando: el avión al que CUENTA el
   * ingreso (null = VuelaTour), sus notas (recortadas; vacío ⇒ null) y la
   * cuenta donde entró (alias y banco; null = efectivo / caja). Solo los
   * leen `partirIngresosPorAvion` y la hoja «Otros ingresos» del avión.
   */
  aeronave_id?: string | null;
  notas?: string | null;
  cuenta_alias?: string | null;
  cuenta_banco?: string | null;
  /**
   * ADITIVO (14-oct-2026, API 0.0.77, invariante 67), OPCIONAL por los
   * literales de los specs: el gasto que reembolsa un REEMBOLSO_DEVOLUCION
   * (`ingreso.gasto_id`; CHECK `ingreso_gasto_chk`). Lo usa
   * `usdDeIngresoAvion` para convertirlo como ESE libro convierte su gasto.
   */
  gasto_id?: string | null;
}

export interface FilaLibroIngreso {
  /** 'ING-12'. */
  clave: string;
  fecha: string;
  concepto_ingreso: string;
  ingreso_mxn: number | null;
  concepto_egreso: string | null;
  egreso_mxn: number | null;
  remanente_mxn: number | null;
  aeronave_color: string | null;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

const NOTA_SIN_TC = '(USD sin TC — no suma)';

/** null si la categoría NO suma a resultados (anticipo, aportación). */
export function filaLibroDeIngreso(
  i: IngresoParaLibro,
): FilaLibroIngreso | null {
  if (!categoriaIngresoSumaAResultados(i.categoria)) return null;
  const monto = Number(i.monto) || 0;
  const tc = Number(i.tc_usd_mxn) > 0 ? Number(i.tc_usd_mxn) : null;
  const esMxn = i.moneda === 'MXN';
  const sinTc = !esMxn && tc == null;
  const aMxn = (x: number): number | null =>
    esMxn ? r2(x) : tc != null ? r2(x * tc) : null;
  const ingresoMxn = aMxn(monto);
  const comision = Number(i.comision_monto) > 0 ? Number(i.comision_monto) : 0;
  const egresoMxn = comision > 0 ? aMxn(comision) : null;
  const concepto = [
    etiquetaCategoriaIngreso(i.categoria),
    i.descripcion?.trim() || null,
    i.cliente_nombre?.trim() || i.pagador?.trim() || null,
    i.vuelo_folio != null ? `vuelo #${i.vuelo_folio}` : null,
    i.matricula?.trim() || null,
    sinTc ? NOTA_SIN_TC : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    clave: etiquetaIngreso(i.folio),
    fecha: i.fecha,
    concepto_ingreso: concepto,
    ingreso_mxn: ingresoMxn,
    concepto_egreso:
      comision > 0
        ? `comisión bancaria${sinTc ? ` ${NOTA_SIN_TC}` : ''}`
        : null,
    egreso_mxn: egresoMxn,
    remanente_mxn:
      ingresoMxn != null ? r2(ingresoMxn - (egresoMxn ?? 0)) : null,
    aeronave_color: i.aeronave_color ?? null,
  };
}

/**
 * Columnas del lector (embeds por la columna FK: sin ambigüedad). Desde el
 * 13-oct-2026 (invariante 67) también `aeronave_id`, `notas` y la cuenta
 * (alias y banco) para la hoja «Otros ingresos» del avión; desde el 0.0.77
 * (14-oct-2026) `gasto_id` (reembolso ligado a su gasto).
 */
export const COLS_INGRESO_LIBRO =
  'id, folio, categoria, fecha, descripcion, monto, comision_monto, moneda, tc_usd_mxn, pagador, cliente:cliente_id(nombre), vuelo:vuelo_id(folio), aeronave:aeronave_id(matricula, color_calendario), aeronave_id, notas, cuenta:cuenta_bancaria_id(alias, banco), gasto_id';

const PAGINA = 1000;

function unwrapOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Fila cruda de `ingreso` (COLS_INGRESO_LIBRO) ⇒ IngresoParaLibro. */
export function ingresoParaLibroDeFila(
  f: Record<string, unknown>,
): IngresoParaLibro {
  const cliente = unwrapOne(f.cliente as { nombre?: unknown } | null);
  const vuelo = unwrapOne(f.vuelo as { folio?: unknown } | null);
  const avion = unwrapOne(
    f.aeronave as { matricula?: unknown; color_calendario?: unknown } | null,
  );
  const cuenta = unwrapOne(
    f.cuenta as { alias?: unknown; banco?: unknown } | null,
  );
  const notas = typeof f.notas === 'string' ? f.notas.trim() : '';
  return {
    id: f.id as string,
    folio: Number(f.folio),
    categoria: f.categoria as string,
    fecha: f.fecha as string,
    descripcion: (f.descripcion as string) ?? '',
    monto: Number(f.monto) || 0,
    comision_monto: f.comision_monto == null ? null : Number(f.comision_monto),
    moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
    tc_usd_mxn: f.tc_usd_mxn == null ? null : Number(f.tc_usd_mxn),
    cliente_nombre: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
    pagador: (f.pagador as string | null) ?? null,
    vuelo_folio: vuelo?.folio == null ? null : Number(vuelo.folio),
    matricula: typeof avion?.matricula === 'string' ? avion.matricula : null,
    aeronave_color:
      typeof avion?.color_calendario === 'string'
        ? avion.color_calendario
        : null,
    // ADITIVOS (13-oct-2026, invariante 67).
    aeronave_id:
      typeof f.aeronave_id === 'string' && f.aeronave_id ? f.aeronave_id : null,
    notas: notas || null,
    cuenta_alias: typeof cuenta?.alias === 'string' ? cuenta.alias : null,
    cuenta_banco: typeof cuenta?.banco === 'string' ? cuenta.banco : null,
    // ADITIVO (14-oct-2026, API 0.0.77).
    gasto_id: typeof f.gasto_id === 'string' && f.gasto_id ? f.gasto_id : null,
  };
}

/**
 * ¿El ingreso cuenta para un AVIÓN? (invariante 67): de resultado Y con
 * `aeronave_id`. Un anticipo o una aportación con avión (imposible tras el
 * CHECK `ingreso_aeronave_chk`) NO: no son resultado de nadie.
 */
export function ingresoEsDelAvion(
  i: Pick<IngresoParaLibro, 'categoria' | 'aeronave_id'>,
): boolean {
  return categoriaIngresoSumaAResultados(i.categoria) && !!i.aeronave_id;
}

/** Ingresos de resultado partidos: VuelaTour (`empresa`) XOR su avión. */
export interface IngresosDeResultadoPartidos {
  /** Sin avión: «otros movimientos» del general y el Libro Dinero. */
  empresa: IngresoParaLibro[];
  /** `aeronave_id` ⇒ sus ingresos (hoja «Otros ingresos», cascada y reparto). */
  porAvion: ReadonlyMap<string, IngresoParaLibro[]>;
}

/**
 * PARTICIÓN ÚNICA de los ingresos de resultado (13-oct-2026, invariante 67)
 * — la usan el libro individual, el Balance general (una sola lectura), el
 * Libro Dinero y el reparto. PURA. Conserva el orden del lector (fecha,
 * folio). Cada ingreso de RESULTADO cae en EXACTAMENTE un lado; lo que no es
 * de resultado (anticipo, aportación) no cae en ninguno (defensa: el lector
 * ya los filtra).
 */
export function partirIngresosPorAvion(
  ingresos: readonly IngresoParaLibro[],
): IngresosDeResultadoPartidos {
  const empresa: IngresoParaLibro[] = [];
  const porAvion = new Map<string, IngresoParaLibro[]>();
  for (const i of ingresos) {
    if (!categoriaIngresoSumaAResultados(i.categoria)) continue;
    if (i.aeronave_id) {
      const lista = porAvion.get(i.aeronave_id) ?? [];
      lista.push(i);
      porAvion.set(i.aeronave_id, lista);
    } else {
      empresa.push(i);
    }
  }
  return { empresa, porAvion };
}

/**
 * NETO del ingreso (monto − comisión bancaria) en USD — el número que SUMA
 * al saldo del reparto de su avión (invariante 67). USD ⇒ el neto tal cual;
 * MXN ⇒ neto ÷ `tcMxn` (el T.C. propio del ingreso o el oficial de su día:
 * lo decide el llamador); sin T.C. positivo ⇒ null (jamás se inventa uno).
 * Centavos: el neto y el resultado van redondeados a 2.
 */
export function netoIngresoUsd(
  i: Pick<IngresoParaLibro, 'monto' | 'comision_monto' | 'moneda'>,
  tcMxn: number | null,
): number | null {
  const monto = Number(i.monto) || 0;
  const comision = Number(i.comision_monto) > 0 ? Number(i.comision_monto) : 0;
  const neto = r2(monto - comision);
  if (i.moneda === 'USD') return neto;
  return tcMxn != null && tcMxn > 0 ? r2(neto / tcMxn) : null;
}

// ============ CONVERSIÓN ÚNICA DEL INGRESO DE UN AVIÓN (0.0.77) ============

/**
 * T.C. oficial de un día con su procedencia — la forma de
 * `TipoCambioService.oficialDetallePara` (`common/` no importa módulos).
 */
export interface TcOficialDia {
  tc: number;
  /** Día del dato (≤ el pedido: fin de semana ⇒ el último publicado). */
  fecha_dato: string;
  fuente: string;
}

/**
 * T.C. con el que ESTE libro convierte el gasto que el ingreso reembolsa: lo
 * arma CADA libro con SU conversión de ese gasto (balance: la fila de su
 * vuelo o sus hojas; reparto: `tc_gasto` ?? oficial del día del gasto) por
 * la fuente única `gastosLigadosDelLibro`. `lugar`: «T.C. promedio de las
 * hojas» | «T.C. de costos del vuelo #430» | «T.C. del gasto» | «T.C.
 * oficial del día del gasto» | `LUGAR_TC_PONDERADO`.
 */
export interface TcGastoLigado {
  gasto_id: string;
  tc: number;
  /** Día del gasto (YYYY-MM-DD) o null. */
  fecha: string | null;
  lugar: string;
  /**
   * Pesos de ESE gasto que ESTE libro le CARGA al avión (revisión del
   * 14-oct-2026): la Σ de sus partes que RESTAN en la utilidad —balance: los
   * vínculos 'suma' de las filas de vuelo con ganancia y sus filas de hojas;
   * reparto: monto − TUA/extensión de cada parte que resta—, a centavos y
   * SIEMPRE > 0 (un gasto que el avión no carga no es «ligado»). Contra él
   * se mide si un reembolso se anula con su gasto o lo excede.
   */
  cargado_mxn: number;
}

/** `lugar` de un gasto cuyas partes ESTE libro convierte con T.C. distintos. */
export const LUGAR_TC_PONDERADO = 'T.C. ponderado de sus partes en este libro';

/**
 * Una parte de un gasto en PESOS que un libro le CARGA al avión: lo que esa
 * parte resta en su utilidad (`mxn`) y el divisor EXACTO con que el libro la
 * convierte (`tc`).
 */
export interface ParteGastoCargada {
  gasto_id: string;
  tc: number;
  mxn: number;
  /** Día del gasto (YYYY-MM-DD) o null. */
  fecha: string | null;
  lugar: string;
}

/**
 * GASTOS LIGABLES DE UN LIBRO — fuente ÚNICA de los dos libros (revisión del
 * 14-oct-2026, invariante 67): agrupa por gasto las partes que ESE libro le
 * carga al avión y devuelve, por gasto, el divisor y `cargado_mxn` (Σ de sus
 * partes, a centavos). Un gasto cuya Σ no es > 0 (el avión no lo carga: TUA
 * o extensión trasladadas, una fila sin parte en la venta…) NO entra: su
 * reembolso no se convierte como «ligado». Si todas sus partes comparten
 * divisor, ese; si no (por construcción no ocurre: un gasto vive en UNA fila
 * de vuelo o en hojas con el mismo T.C.), el ponderado Σ mxn ÷ Σ (mxn ÷ tc),
 * para que un reembolso igual a lo cargado se anule igual. PURA; conserva el
 * orden de aparición.
 */
export function gastosLigadosDelLibro(
  partes: Iterable<ParteGastoCargada>,
): Map<string, TcGastoLigado> {
  const acum = new Map<
    string,
    { primera: ParteGastoCargada; mxn: number; usd: number; mismoTc: boolean }
  >();
  for (const p of partes) {
    const mxn = Number(p.mxn);
    if (!p.gasto_id || !(p.tc > 0) || !Number.isFinite(mxn) || mxn === 0) {
      continue;
    }
    const a = acum.get(p.gasto_id);
    if (!a) {
      acum.set(p.gasto_id, {
        primera: p,
        mxn,
        usd: mxn / p.tc,
        mismoTc: true,
      });
      continue;
    }
    a.mxn += mxn;
    a.usd += mxn / p.tc;
    if (p.tc !== a.primera.tc) a.mismoTc = false;
  }
  const out = new Map<string, TcGastoLigado>();
  for (const [id, a] of acum) {
    const cargado = r2(a.mxn);
    if (!(cargado > 0) || !(a.usd > 0)) continue;
    out.set(id, {
      gasto_id: id,
      tc: a.mismoTc ? a.primera.tc : a.mxn / a.usd,
      fecha: a.primera.fecha,
      lugar: a.mismoTc ? a.primera.lugar : LUGAR_TC_PONDERADO,
      cargado_mxn: cargado,
    });
  }
  return out;
}

/** De dónde salió el T.C. de un ingreso en pesos. */
export type OrigenTcIngreso = 'PROPIO' | 'GASTO_LIGADO' | 'OFICIAL_DEL_DIA';

/** El USD de un ingreso y con qué T.C. se llegó a él. */
export interface ConversionIngreso {
  /** NETO en USD a centavos (`netoIngresoUsd`); null = MXN sin T.C. */
  usd: number | null;
  /** El T.C. EXACTO que dividió (sin re-redondear); null en USD o sin T.C. */
  tc: number | null;
  /** null en USD o sin T.C. */
  origen: OrigenTcIngreso | null;
  /** El oficial del día que se usó (o que se tenía, si no alcanzó). */
  oficial: TcOficialDia | null;
  /** El gasto ligado cuyo T.C. se usó (solo GASTO_LIGADO). */
  gasto: TcGastoLigado | null;
}

/** ¿`AAAA-MM-DD` de un día de calendario real? */
function esDiaValido(x: unknown): x is string {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const [a, m, d] = x.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  return (
    t.getUTCFullYear() === a &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
}

/**
 * Día cuyo T.C. oficial PUEDE necesitar el ingreso (14-oct-2026): MXN sin
 * T.C. propio > 0 ⇒ su `fecha` (DATE, día de pared Cancún, `AAAA-MM-DD`
 * válido); si no ⇒ null. La usan el lote de días del reparto
 * (`resolverTcOficial`) y el del balance (`tcOficialDeDias`): un día, una
 * consulta.
 */
export function diaTcOficialIngreso(
  i: Pick<IngresoParaLibro, 'moneda' | 'tc_usd_mxn' | 'fecha'>,
): string | null {
  if (i.moneda !== 'MXN') return null;
  if (Number(i.tc_usd_mxn) > 0) return null;
  return esDiaValido(i.fecha) ? i.fecha : null;
}

/**
 * USD de un ingreso ASIGNADO a un avión — FUENTE ÚNICA (decisión del cliente
 * del 14-oct-2026; invariante 67): la MISMA en el balance (hoja «Otros
 * ingresos» y su cascada), el reparto y, vía el reparto, el tablero.
 *  - USD ⇒ su neto (monto − comisión) tal cual.
 *  - MXN ⇒ neto ÷ (T.C. PROPIO del ingreso ?? T.C. del GASTO LIGADO ?? T.C.
 *    oficial del día de su `fecha`), a centavos (`netoIngresoUsd`).
 *  - GASTO LIGADO (revisión F3): un REEMBOLSO_DEVOLUCION en pesos con
 *    `gasto_id` de un gasto en pesos que ESE libro le CARGA al avión
 *    (`ctx.gastoLigado` con el mismo id y `cargado_mxn` > 0: revisión del
 *    14-oct-2026) se convierte con el T.C. con que ESE libro convierte su
 *    gasto: hasta lo cargado, reembolso y gasto se ANULAN exactos en cada
 *    libro; lo que exceda lo avisa `avisosReembolsoGasto`.
 *  - Sin T.C. ⇒ `usd` null (jamás se inventa uno); cada libro decide qué
 *    hace (balance: fila sin NETO USD y pendiente; reparto: no suma).
 */
export function usdDeIngresoAvion(
  i: Pick<
    IngresoParaLibro,
    'monto' | 'comision_monto' | 'moneda' | 'tc_usd_mxn' | 'categoria'
  > & { gasto_id?: string | null },
  ctx: {
    oficialDelDia?: TcOficialDia | null;
    gastoLigado?: TcGastoLigado | null;
  },
): ConversionIngreso {
  if (i.moneda === 'USD') {
    return {
      usd: netoIngresoUsd(i, null),
      tc: null,
      origen: null,
      oficial: null,
      gasto: null,
    };
  }
  const propio = Number(i.tc_usd_mxn) > 0 ? Number(i.tc_usd_mxn) : null;
  if (propio != null) {
    return {
      usd: netoIngresoUsd(i, propio),
      tc: propio,
      origen: 'PROPIO',
      oficial: null,
      gasto: null,
    };
  }
  const g = ctx.gastoLigado;
  if (
    i.categoria === 'REEMBOLSO_DEVOLUCION' &&
    i.gasto_id &&
    g &&
    g.gasto_id === i.gasto_id &&
    g.tc > 0 &&
    g.cargado_mxn > 0
  ) {
    return {
      usd: netoIngresoUsd(i, g.tc),
      tc: g.tc,
      origen: 'GASTO_LIGADO',
      oficial: null,
      gasto: g,
    };
  }
  const of =
    ctx.oficialDelDia && ctx.oficialDelDia.tc > 0 ? ctx.oficialDelDia : null;
  const usd = netoIngresoUsd(i, of?.tc ?? null);
  return {
    usd,
    tc: of?.tc ?? null,
    origen: of && usd != null ? 'OFICIAL_DEL_DIA' : null,
    oficial: of,
    gasto: null,
  };
}

/** Neto en pesos (monto − comisión) de un ingreso, a centavos. */
function netoMxnDe(
  i: Pick<IngresoParaLibro, 'monto' | 'comision_monto'>,
): number {
  const monto = Number(i.monto) || 0;
  const comision = Number(i.comision_monto) > 0 ? Number(i.comision_monto) : 0;
  return r2(monto - comision);
}

/**
 * Lo que un reembolso de `netoMxn` pesos EXCEDE a lo que el libro le carga al
 * avión de su gasto (≥ 0, a centavos; medio centavo o menos ⇒ 0). Pura.
 */
export function excedenteSobreCargado(
  netoMxn: number,
  g: Pick<TcGastoLigado, 'cargado_mxn'>,
): number {
  const d = r2(netoMxn - g.cargado_mxn);
  return d > 0.005 ? d : 0;
}

/**
 * AVISOS de un REEMBOLSO_DEVOLUCION en pesos con `gasto_id` (revisión del
 * 14-oct-2026, invariante 67): cuándo NO se anula exacto con su gasto en
 * ESTE libro. Textos ÚNICOS de los dos libros (balance: un pendiente por
 * aviso con el prefijo de la hoja; reparto: `tc_aviso` de la línea). `clave`
 * = «ING-7»; `delLibro` = lo que ESTE libro le carga al avión de ese gasto
 * (`gastosLigadosDelLibro`; null = nada).
 *  - El libro no le carga el gasto ⇒ se convirtió por la regla por ingreso
 *    y no se anula con él.
 *  - T.C. PROPIO (manda: captura explícita) distinto del divisor del gasto
 *    en este libro ⇒ no se anulan al centavo.
 *  - El reembolso EXCEDE lo cargado ⇒ ese resto no se anula con nada y suma
 *    al avión (la oficina decide con el `aeronave_id`; aquí solo se avisa).
 * Otra categoría, USD, sin `gasto_id` o sin USD (su pendiente ya lo dice)
 * ⇒ []. Pura.
 */
export function avisosReembolsoGasto(
  i: Pick<
    IngresoParaLibro,
    'categoria' | 'moneda' | 'monto' | 'comision_monto'
  > & { gasto_id?: string | null },
  clave: string,
  conv: ConversionIngreso,
  delLibro: TcGastoLigado | null | undefined,
): string[] {
  if (i.categoria !== 'REEMBOLSO_DEVOLUCION' || i.moneda !== 'MXN') return [];
  if (!i.gasto_id || conv.usd == null) return [];
  if (!delLibro || !(delLibro.cargado_mxn > 0)) {
    const conQue =
      conv.origen === 'PROPIO' ? 'su T.C. propio' : 'el T.C. oficial de su día';
    return [
      `${clave} reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con ${conQue} y no se anula con su gasto`,
    ];
  }
  const out: string[] = [];
  const neto = netoMxnDe(i);
  if (
    conv.origen === 'PROPIO' &&
    conv.tc != null &&
    delLibro.tc > 0 &&
    Math.abs(r2(conv.usd - r2(neto / delLibro.tc))) >= 0.01
  ) {
    out.push(
      `${clave} trae T.C. propio (${conv.tc.toFixed(4)}) y este libro convierte el gasto que reembolsa con ${delLibro.tc.toFixed(4)} (${delLibro.lugar}): reembolso y gasto no se anulan exactos`,
    );
  }
  const exceso = excedenteSobreCargado(neto, delLibro);
  if (exceso > 0) {
    out.push(
      `${clave} reembolsa ${fmtDineroTexto(neto, 'MXN')} de un gasto del que este libro solo le carga ${fmtDineroTexto(delLibro.cargado_mxn, 'MXN')} al avión: ${fmtDineroTexto(exceso, 'MXN')} no se anulan con nada y suman al avión — si esa parte no es suya, corrige el monto o el avión del ingreso`,
    );
  }
  return out;
}

/**
 * Lector COMPARTIDO por los dos libros: ingresos VIVOS de RESULTADO con
 * `fecha ∈ [desde, hasta]` (DATE, día Cancún), orden fecha y folio, PAGINADO
 * de 1000 en 1000 (PostgREST corta en max-rows sin avisar). SIN la migración
 * devuelve [] sin tocar la tabla: los libros salen byte-idénticos a hoy.
 */
export async function leerIngresosDeResultado(
  sb: SupabaseClient,
  desde: string,
  hasta: string,
): Promise<IngresoParaLibro[]> {
  if (!(await ingresosDisponibles(sb))) return [];
  const out: IngresoParaLibro[] = [];
  for (let i = 0; ; i += PAGINA) {
    const { data, error } = await sb
      .from('ingreso')
      .select(COLS_INGRESO_LIBRO)
      .is('deleted_at', null)
      .in('categoria', [...CATEGORIAS_INGRESO_RESULTADO])
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true })
      .order('folio', { ascending: true })
      .range(i, i + PAGINA - 1);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<Record<string, unknown>>;
    for (const f of filas) out.push(ingresoParaLibroDeFila(f));
    if (filas.length < PAGINA) break;
  }
  return out;
}
