/**
 * COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65, sin migración) —
 * FUENTE ÚNICA del balance por avión (columna COMISIONES, la ganancia y su
 * cascada) y del reparto a socios (`compute()`, utilidades por mes y cuenta
 * corriente). Prohibido reimplementarla en un lector: si el balance y el
 * reparto no descuentan lo mismo del mismo vuelo, el cierre no cuadra.
 *
 * Pedido del cliente: «En el balance, cuando hay una comisión de un banco,
 * en la parte de total cobrado no refleja el monto real que entró a la
 * cuenta… La comisión del banco y vendedor se puede ir a la columna de
 * (comisiones del vendedor) pero cambiar el nombre a "comisiones"… para que
 * el monto real total cobrado ya sea después de cualquier comisión. Por si no
 * le estaríamos poniendo dinero al socio.» Respuestas (6-oct-2026): la
 * comisión del vendedor la ABSORBE el avión; lo que se le cobra al cliente
 * por ese concepto se queda como ingreso de VuelaTour; vigencia desde
 * septiembre de 2026 («es el cierre que estamos haciendo»).
 *
 * VIGENCIA por `fecha_vuelo` (día Cancún) ≥ la clave de configuración
 * `comisiones_al_avion_desde` (default `COMISIONES_AL_AVION_DESDE_DEFAULT`,
 * sin migración). Antes de la vigencia NADA cambia: `aplica: false` y todo
 * en 0 (los libros de esos vuelos salen byte-idénticos).
 *
 * Por vuelo y por AVIÓN (lo que esa matrícula absorbe):
 *  - BANCO: por cada cobro con comisión, comisión × el MISMO factor que
 *    prorratea el cobro al avión (`factor_avion` de la partición; 1 en un
 *    CANCELADO —lo retenido es 100 % del avión— o en un vuelo sin precio) y
 *    después la parte de ESTE avión con la MISMA función que reparte la venta
 *    y el cobro (`parteAvion`: `repartirUsd` en multi-avión, el monto tal
 *    cual con un solo avión). Es el primer término de `parteFilaDeCobro`:
 *    por cobro, Σ de los aviones == round2(comisión × factor) al centavo y lo
 *    que resta (comisión − partes de los aviones) es de VuelaTour.
 *  - VENDEDOR: la PROVISIÓN = lo cobrado al cliente por ese concepto
 *    (`pagoVendedorUsd`: comisión + su IVA si la cotización grava, fuente
 *    única) × la parte del avión (`parteAvion`); en MXN al T.C. de venta (K)
 *    del vuelo. Nunca en un CANCELADO (no se vendió) ni con la partición
 *    inconsistente (no hay comisión que separar: misma regla que «otros
 *    movimientos»). NO depende del gasto real `COMISION_VENDEDOR` (ese sigue
 *    apareado en «otros movimientos» con su «faltan/excede»).
 *
 * MXN (balance) y USD (reparto) salen del MISMO recorrido:
 *  - cobro MXN: comisión MXN tal cual; USD = comisión ÷ (T.C. del cobro ?? K)
 *    — la cadena de `cobrosEnUsd`.
 *  - cobro USD: comisión USD tal cual; MXN = comisión × (T.C. del cobro ?? K)
 *    — la cadena del balance.
 *  - sin ningún T.C. ese lado no se convierte ni se suma (`banco_sin_tc`
 *    cuenta las que no llegan a MXN y la nota lo dice): jamás un 0 falso.
 *
 * PURO (sin Nest, sin consultas). `detalle` = la nota de la celda COMISIONES:
 * una línea por concepto y, con más de uno, el encabezado «N conceptos».
 */
import {
  ivaComisionVendedorUsd,
  pagoVendedorUsd,
  type ParticionIngreso,
} from './ingreso-vuelo.util';
import { etiquetaMetodoCobro } from './metodo-cobro.util';

/**
 * Primer día (Cancún) de la regla cuando la configuración
 * `comisiones_al_avion_desde` no existe o no es una fecha válida.
 */
export const COMISIONES_AL_AVION_DESDE_DEFAULT = '2026-09-01';

/** Lo que el cálculo necesita de un cobro (forma de `cobro_vuelo`). */
export interface CobroComisionAvionInput {
  moneda?: unknown;
  tc_usd_mxn?: unknown;
  /** Comisión bancaria en la MONEDA del cobro. */
  comision_banco_monto?: unknown;
  /** % capturado (en puntos: 5 = 5 %); solo para la nota. */
  comision_banco_pct?: unknown;
  /** Código del método (`metodo_cobro`); solo para la nota. */
  metodo_cobro?: unknown;
}

export interface ComisionesDelVueloInput {
  /** Día Cancún del vuelo (YYYY-MM-DD) — eje de la vigencia. */
  diaVuelo: string | null | undefined;
  /** Primer día de la regla (`comisiones_al_avion_desde`). */
  vigenteDesde: string;
  /** Cobros del VUELO (todos; los que no traen comisión no cuentan). */
  cobros: ReadonlyArray<CobroComisionAvionInput>;
  /**
   * T.C. de venta del vuelo (K: el de la cotización o el oficial de su día):
   * respaldo de los cobros sin T.C. propio y conversión de la provisión.
   */
  tcVenta: number | null | undefined;
  /** Partición del ingreso (`particionIngresoVuelo`) del vuelo. */
  particion: ParticionIngreso | null;
  /** Vuelo CANCELADO: lo retenido es 100 % del avión y no hay provisión. */
  cancelado: boolean;
  /**
   * Parte de ESTE avión de un monto del VUELO: la MISMA función con la que
   * el lector reparte la venta y el cobro (`repartirUsd` en multi-avión, el
   * monto tal cual con un solo avión).
   */
  parteAvion: (montoVuelo: number) => number;
  /** Fracción de este avión en la venta del vuelo (1 con un solo avión). */
  participacion: number;
  /** Quién cobra la comisión del vendedor (solo para la nota). */
  vendedorNombre?: string | null;
}

export interface ComisionesDelVuelo {
  /** ¿El vuelo cae en la vigencia de la regla? */
  aplica: boolean;
  /** Parte del avión de la comisión bancaria (MXN, Σ por cobro). */
  banco_mxn: number;
  /** La misma parte en USD (reparto a socios). */
  banco_usd: number;
  /** Provisión del vendedor × parte del avión (MXN, al K del vuelo). */
  vendedor_mxn: number;
  /** La misma provisión en USD (reparto a socios). */
  vendedor_usd: number;
  total_mxn: number;
  total_usd: number;
  /** Nota de la celda COMISIONES (una línea por concepto). */
  detalle: string[];
  /** Comisiones bancarias que no llegaron a MXN (cobro USD sin T.C. ni K). */
  banco_sin_tc: number;
  /** Provisión del vendedor sin T.C. de venta: no entra en MXN. */
  vendedor_sin_tc: boolean;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** Número positivo o null (montos, T.C. y %; numeric de PostgREST = string). */
const pos = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};

/** «$20,400.00» (2 decimales es-MX, como las notas del libro); «-$5.00». */
export function fmtMxnNota(n: number): string {
  const r = round2(n);
  const cuerpo = Math.abs(r).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return r < 0 ? `-$${cuerpo}` : `$${cuerpo}`;
}

/** 5 → «5», 3.828 → «3.83», 5.0001 → «5» (hasta 2 decimales). */
export function fmtPctNota(puntos: number): string {
  return (Math.round(puntos * 100) / 100).toLocaleString('es-MX', {
    maximumFractionDigits: 2,
  });
}

/** ¿El vuelo de ese día (Cancún) cae en la vigencia? Sin día ⇒ no. */
export function aplicaComisionesAlAvion(
  diaVuelo: string | null | undefined,
  vigenteDesde: string,
): boolean {
  if (typeof diaVuelo !== 'string') return false;
  const dia = diaVuelo.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia >= vigenteDesde;
}

const MESES_CORTOS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/**
 * «regla sep-2026» (vigencia el día 1) o «regla desde 15-oct-2026»: el
 * nombre de la regla en los textos sale de la vigencia CONFIGURADA, nunca
 * fijo.
 */
export function etiquetaReglaComisiones(vigenteDesde: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(vigenteDesde);
  if (!m) return `regla desde ${vigenteDesde}`;
  const mes = MESES_CORTOS[Number(m[2]) - 1] ?? m[2];
  return m[3] === '01'
    ? `regla ${mes}-${m[1]}`
    : `regla desde ${m[3]}-${mes}-${m[1]}`;
}

/**
 * Concepto de la línea de INGRESO de VuelaTour en «otros movimientos» por la
 * provisión del vendedor que absorbe el avión: «comisión del vendedor a
 * cargo del avión XB-PEV (regla sep-2026)». Empieza con «comisión del
 * vendedor» a propósito (`colapsarFilasDeVuelo` la distingue de la comisión
 * bancaria).
 */
export function conceptoVendedorACargoDelAvion(
  matricula: string,
  vigenteDesde: string,
): string {
  return `comisión del vendedor a cargo del avión ${matricula} (${etiquetaReglaComisiones(
    vigenteDesde,
  )})`;
}

/**
 * Sufijo del egreso «comisión bancaria» de VuelaTour cuando los aviones ya
 * absorbieron su parte (la pestaña queda SOLO con la parte de VuelaTour).
 */
export const SUFIJO_COMISION_BANCO_PARTE_VUELATOUR =
  ' (parte VuelaTour: la del avión va en su columna COMISIONES)';

/** «(parte del avión 89.69 %: $313.90)» o «(parte del avión 100 %)». */
function textoParte(
  fraccion: number,
  totalMxn: number,
  parteMxn: number,
): string {
  const pct = fmtPctNota(fraccion * 100);
  return round2(parteMxn) === round2(totalMxn)
    ? ` (parte del avión ${pct} %)`
    : ` (parte del avión ${pct} %: ${fmtMxnNota(parteMxn)})`;
}

const VACIO: Omit<ComisionesDelVuelo, 'aplica' | 'detalle'> = {
  banco_mxn: 0,
  banco_usd: 0,
  vendedor_mxn: 0,
  vendedor_usd: 0,
  total_mxn: 0,
  total_usd: 0,
  banco_sin_tc: 0,
  vendedor_sin_tc: false,
};

/**
 * Comisiones que ESTE avión absorbe de UN vuelo. Ver la cabecera del
 * archivo para la regla completa.
 */
export function comisionesDelVuelo(
  i: ComisionesDelVueloInput,
): ComisionesDelVuelo {
  if (!aplicaComisionesAlAvion(i.diaVuelo, i.vigenteDesde)) {
    return { aplica: false, ...VACIO, detalle: [] };
  }
  const p = i.particion;
  // El MISMO factor que prorratea el cobro al avión (cobradoParteAvion):
  // venta del avión ÷ total del cliente; CANCELADO o sin precio ⇒ 1.
  const factorCobro =
    i.cancelado || p == null || !(p.total_usd > 0) ? 1 : p.factor_avion;
  const participacion = i.participacion > 0 ? i.participacion : 0;
  const k = pos(i.tcVenta);
  const lineas: string[] = [];

  // ----- Comisión BANCARIA de cada cobro -----
  let bancoMxn = 0;
  let bancoUsd = 0;
  let bancoSinTc = 0;
  for (const c of i.cobros) {
    const com = pos(c.comision_banco_monto);
    if (com == null) continue;
    const tc = pos(c.tc_usd_mxn) ?? k;
    const esMxn = c.moneda === 'MXN';
    const comMxn = esMxn ? round2(com) : tc != null ? round2(com * tc) : null;
    const comUsd = esMxn ? (tc != null ? round2(com / tc) : null) : round2(com);
    const parteMxn =
      comMxn != null ? i.parteAvion(round2(comMxn * factorCobro)) : null;
    const parteUsd =
      comUsd != null ? i.parteAvion(round2(comUsd * factorCobro)) : null;
    if (parteMxn != null) bancoMxn += parteMxn;
    else bancoSinTc += 1;
    if (parteUsd != null) bancoUsd += parteUsd;

    const metodo =
      typeof c.metodo_cobro === 'string' && c.metodo_cobro.trim()
        ? etiquetaMetodoCobro(c.metodo_cobro.trim())
        : null;
    const pct = pos(c.comision_banco_pct);
    const como = [metodo, pct != null ? `${fmtPctNota(pct)} %` : null]
      .filter(Boolean)
      .join(' ');
    const monto =
      comMxn == null
        ? `${fmtMxnNota(com)} USD sin T.C. — no suma`
        : esMxn
          ? fmtMxnNota(comMxn)
          : `${fmtMxnNota(com)} USD = ${fmtMxnNota(comMxn)}`;
    const parte =
      comMxn != null && parteMxn != null
        ? textoParte(factorCobro * participacion, comMxn, parteMxn)
        : '';
    lineas.push(
      ['Comisión bancaria', como || null, `${monto}${parte}`]
        .filter(Boolean)
        .join(' · '),
    );
  }

  // ----- PROVISIÓN del vendedor (lo cobrado al cliente por ese concepto) -----
  let vendedorMxn = 0;
  let vendedorUsd = 0;
  let vendedorSinTc = false;
  if (!i.cancelado && p != null && !p.inconsistente) {
    const pagoUsd = pagoVendedorUsd(p);
    if (pagoUsd > 0) {
      vendedorUsd = i.parteAvion(pagoUsd);
      const nombre =
        typeof i.vendedorNombre === 'string' && i.vendedorNombre.trim()
          ? ` (${i.vendedorNombre.trim()})`
          : '';
      if (k != null) {
        const totalMxn = round2(pagoUsd * k);
        vendedorMxn = i.parteAvion(totalMxn);
        const base =
          ivaComisionVendedorUsd(p) > 0
            ? 'provisión = cotizado + IVA'
            : 'provisión = cotizado (sin IVA)';
        const parte =
          round2(vendedorMxn) === totalMxn
            ? ''
            : textoParte(participacion, totalMxn, vendedorMxn);
        lineas.push(
          `Comisión vendedor${nombre} · ${fmtMxnNota(totalMxn)} · ${base}${parte}`,
        );
      } else {
        vendedorSinTc = true;
        lineas.push(
          `Comisión vendedor${nombre} · ${fmtMxnNota(pagoUsd)} USD sin T.C. de venta — no suma en pesos`,
        );
      }
    }
  }

  const banco_mxn = round2(bancoMxn);
  const banco_usd = round2(bancoUsd);
  const vendedor_mxn = round2(vendedorMxn);
  const vendedor_usd = round2(vendedorUsd);
  if (lineas.length > 1) lineas.unshift(`${lineas.length} conceptos`);
  return {
    aplica: true,
    banco_mxn,
    banco_usd,
    vendedor_mxn,
    vendedor_usd,
    total_mxn: round2(banco_mxn + vendedor_mxn),
    total_usd: round2(banco_usd + vendedor_usd),
    detalle: lineas,
    banco_sin_tc: bancoSinTc,
    vendedor_sin_tc: vendedorSinTc,
  };
}
