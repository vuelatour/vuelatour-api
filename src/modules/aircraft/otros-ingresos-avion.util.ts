/**
 * HOJA «Otros ingresos» DEL LIBRO DE UN AVIÓN (13-oct-2026, API 0.0.75,
 * invariante 67 — «INGRESO ASIGNADO A UN AVIÓN: CUENTA PARA ESE AVIÓN»).
 *
 * Un ingreso de RESULTADO registrado en Ingresos (ING-n) con `aeronave_id`
 * cuenta UNA vez, en el mes de su `fecha`, para ESE avión: su hoja «Otros
 * ingresos», la línea «(+) OTROS INGRESOS USD» que SUMA en la cascada y su
 * reparto a socios. Deja de contar en «otros movimientos», en el bloque
 * VUELATOUR (empresa) y en `utilidades_otros_ingresos_mxn` del Libro Dinero.
 *
 * PURO (sin BD ni reloj): `buildPayload` le pasa los ingresos de SU avión
 * (partición única `partirIngresosPorAvion`) y la CONVERSIÓN de cada uno;
 * `payloadGeneral` fusiona las hojas de los libros para la hoja consolidada
 * «otros ingresos aviones». Los pesos salen de la fuente única
 * `filaLibroDeIngreso` (MXN directo; USD × su `tc_usd_mxn` PROPIO): nadie
 * reconvierte aquí.
 *
 * CONVERSIÓN ÚNICA (decisión del cliente del 14-oct-2026, API 0.0.77): el
 * USD de cada fila es el de `usdDeIngresoAvion` (la MISMA del reparto y del
 * tablero: USD ⇒ su neto; MXN ⇒ neto ÷ T.C. propio ?? T.C. del gasto ligado
 * ?? oficial del día); TOTAL USD = round2(Σ NETO USD). La hoja YA NO divide
 * entre el T.C. de las hojas de gastos (ING-4: 2,746.70 en los tres libros;
 * antes el balance daba 2,710.47). Las hojas de GASTOS siguen con su T.C.
 * promedio (dos T.C. por diseño, como el Excel del cliente).
 */
import {
  filaLibroDeIngreso,
  usdDeIngresoAvion,
  type ConversionIngreso,
  type IngresoParaLibro,
} from '../../common/ingreso-resultado.util';
import { etiquetaCategoriaIngreso } from '../../common/categoria-ingreso.util';
import { fuenteTcLegible } from '../../common/fuente-tc-oficial.util';
import type {
  BalanceAvionHojaOtrosIngresosPayload,
  BalanceAvionOtroIngresoFilaPayload,
  BalanceAvionPayload,
} from '../pyservices/pyservices.service';

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Cuenta donde entró el dinero: «alias · banco» o «Efectivo / caja». */
function cuentaDeIngreso(i: IngresoParaLibro): string {
  const alias = i.cuenta_alias?.trim();
  if (!alias) return 'Efectivo / caja';
  const banco = i.cuenta_banco?.trim();
  return banco ? `${alias} · ${banco}` : alias;
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

/** «15-sep-2026» de un `AAAA-MM-DD` (otro texto, tal cual). */
function diaCorto(dia: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return dia;
  return `${Number(m[3])}-${MESES_CORTOS[Number(m[2]) - 1] ?? m[2]}-${m[1]}`;
}

/**
 * Nota de la celda T.C. A USD (14-oct-2026, API 0.0.77): de dónde salió el
 * T.C. de un ingreso en pesos que no traía el suyo. OFICIAL_DEL_DIA ⇒ «T.C.
 * oficial de referencia del día del ingreso (open.er-api, dato del
 * 2026-09-04): el ingreso en pesos no traía tipo de cambio.»; GASTO_LIGADO ⇒
 * «T.C. con el que este libro convierte el gasto que reembolsa (gasto
 * 70e8c3a4 del 15-sep-2026, T.C. promedio de las hojas): reembolso y gasto se
 * anulan en este libro.»; PROPIO o USD ⇒ null. Pura.
 */
export function notaTcUsdIngreso(conv: ConversionIngreso): string | null {
  if (conv.origen === 'OFICIAL_DEL_DIA' && conv.oficial) {
    return `T.C. oficial de referencia del día del ingreso (${fuenteTcLegible(conv.oficial.fuente)}, dato del ${conv.oficial.fecha_dato}): el ingreso en pesos no traía tipo de cambio.`;
  }
  if (conv.origen === 'GASTO_LIGADO' && conv.gasto) {
    const g = conv.gasto;
    const cual = [
      `gasto ${g.gasto_id.slice(0, 8)}`,
      g.fecha ? `del ${diaCorto(g.fecha)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return `T.C. con el que este libro convierte el gasto que reembolsa (${cual}, ${g.lugar}): reembolso y gasto se anulan en este libro.`;
  }
  return null;
}

/**
 * Fila de la hoja «Otros ingresos» de un ingreso (null si no es de
 * resultado: anticipos y aportaciones nunca llevan avión). `conv` = su
 * conversión (`usdDeIngresoAvion`): desde el 0.0.77 la fila termina con
 * `tc_usd` (MXN: el T.C. EXACTO que dividió; USD: null), `neto_usd`,
 * `tc_usd_origen` y `tc_usd_nota`.
 */
export function filaHojaOtrosIngresos(
  i: IngresoParaLibro,
  conv: ConversionIngreso,
): BalanceAvionOtroIngresoFilaPayload | null {
  const f = filaLibroDeIngreso(i);
  if (!f) return null;
  const monto = Number(i.monto) || 0;
  const tc = Number(i.tc_usd_mxn);
  return {
    ingreso_id: i.id,
    clave: f.clave,
    fecha: i.fecha,
    categoria: etiquetaCategoriaIngreso(i.categoria),
    detalle: [
      f.clave,
      i.descripcion?.trim() || null,
      i.cliente_nombre?.trim() || i.pagador?.trim() || null,
      i.vuelo_folio != null ? `vuelo #${i.vuelo_folio}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    moneda_original: i.moneda,
    monto_original: round2(monto),
    // EXACTAMENTE el número que multiplicó `filaLibroDeIngreso` (sin
    // re-redondear): pyservices lo cita en ROUND(MONTO × T.C., 2).
    tc_aplicado: i.moneda === 'USD' && tc > 0 ? tc : null,
    ingreso_mxn: f.ingreso_mxn,
    comision_mxn: f.egreso_mxn,
    neto_mxn: f.remanente_mxn,
    cuenta: cuentaDeIngreso(i),
    notas: i.notas ?? null,
    // ADITIVOS (14-oct-2026, API 0.0.77, invariante 67), al final (antes de
    // `matricula`/`avion_color` del consolidado). `tc_usd` EXACTO, sin
    // re-redondear: pyservices lo cita en ROUND(NETO MXN / T.C., 2).
    tc_usd: i.moneda === 'USD' ? null : conv.tc,
    neto_usd: conv.usd,
    tc_usd_origen: conv.origen,
    tc_usd_nota: notaTcUsdIngreso(conv),
  };
}

/**
 * Hoja «Otros ingresos» de UN avión: filas en el orden recibido (fecha,
 * folio del lector), `total_mxn` = round2(Σ neto MXN) y —desde el 0.0.77
 * (decisión del cliente del 14-oct-2026)— `usd` = round2(Σ NETO USD) de la
 * conversión ÚNICA por ingreso (`conversiones`, una por `ingreso.id`; la
 * MISMA del reparto y del tablero): alguna fila sin NETO USD ⇒ null; vacía
 * ⇒ 0. Una fila USD ya no anula la hoja por no tener pesos (su NETO USD sí
 * suma). ÚLTIMA llave `usd_por_ingreso: true` SIEMPRE (pyservices pinta
 * T.C. A USD / NETO USD y C5 = ROUND(SUM(K),2) con ella). Pendientes: MXN
 * sin T.C. propio ni oficial de su día (la utilidad queda vacía), USD sin
 * T.C. (el CHECK `ingreso_tc_resultado_chk` lo impide) y un reembolso en
 * pesos cuyo gasto NO cuenta en este libro (`gastosDelLibro` = ids de los
 * gastos en pesos que este libro convierte): no se anula exacto con él.
 */
export function hojaOtrosIngresosAvion(
  ingresos: readonly IngresoParaLibro[],
  conversiones: ReadonlyMap<string, ConversionIngreso>,
  pendientes: string[],
  gastosDelLibro: ReadonlySet<string> = new Set(),
): BalanceAvionHojaOtrosIngresosPayload {
  const filas: BalanceAvionOtroIngresoFilaPayload[] = [];
  for (const i of ingresos) {
    // Sin conversión del llamador: la regla sin contexto (nunca un T.C.
    // inventado: un MXN sin T.C. propio sale sin USD y con su pendiente).
    const conv = conversiones.get(i.id) ?? usdDeIngresoAvion(i, {});
    const fila = filaHojaOtrosIngresos(i, conv);
    if (!fila) continue;
    const donde = `Hoja "Otros ingresos" (${fila.fecha})`;
    if (fila.neto_mxn == null) {
      pendientes.push(
        `${donde}: ingreso ${fila.clave} en USD sin tipo de cambio — fila sin monto MXN (su NETO USD sí suma)`,
      );
    }
    if (i.moneda === 'MXN' && conv.usd == null) {
      pendientes.push(
        `${donde}: ingreso ${fila.clave} en pesos sin T.C. propio ni T.C. oficial de su día — fila sin USD; la utilidad después de gastos queda vacía`,
      );
    }
    if (
      i.categoria === 'REEMBOLSO_DEVOLUCION' &&
      i.moneda === 'MXN' &&
      i.gasto_id &&
      conv.usd != null &&
      conv.origen !== 'GASTO_LIGADO' &&
      !gastosDelLibro.has(i.gasto_id)
    ) {
      pendientes.push(
        `${donde}: ${fila.clave} reembolsa un gasto que este libro no cuenta (otro mes, otro avión u otra moneda): se convirtió con ${conv.origen === 'PROPIO' ? 'su T.C. propio' : 'el T.C. oficial de su día'} y no se anula exacto con su gasto`,
      );
    }
    filas.push(fila);
  }
  const totalMxn = round2(filas.reduce((s, f) => s + (f.neto_mxn ?? 0), 0));
  const usd = filas.some((f) => f.neto_usd == null)
    ? null
    : round2(filas.reduce((s, f) => s + (f.neto_usd ?? 0), 0));
  return { filas, total_mxn: totalMxn, usd, usd_por_ingreso: true };
}

/**
 * Hoja consolidada «otros ingresos aviones» del Balance GENERAL: SOLO los
 * libros con filas (ninguno ⇒ null y el consolidado no lleva la llave). Cada
 * fila lleva «MATRÍCULA · » al frente del detalle, su `matricula` y su
 * `avion_color`; orden por fecha con sort ESTABLE (a igual fecha, el orden
 * de los libros). `total_mxn` = round2(Σ); `usd` = round2(Σ usd de los
 * libros) — desde el 0.0.77 cada libro sumó la conversión ÚNICA por ingreso,
 * así que es la Σ de NETO USD de todas las filas — y un `usd` null de
 * cualquier libro con filas se PROPAGA (jamás `?? 0`). `usd_por_ingreso:
 * true` como ÚLTIMA llave.
 */
export function fusionarOtrosIngresosFlota(
  libros: ReadonlyArray<
    Pick<
      BalanceAvionPayload,
      'matricula' | 'avion_color' | 'otros_ingresos_avion'
    >
  >,
): BalanceAvionHojaOtrosIngresosPayload | null {
  const conFilas = libros.filter(
    (p) => (p.otros_ingresos_avion?.filas.length ?? 0) > 0,
  );
  if (conFilas.length === 0) return null;
  const filas = conFilas
    .flatMap((p) =>
      (p.otros_ingresos_avion?.filas ?? []).map((f) => ({
        ...f,
        detalle: `${p.matricula} · ${f.detalle}`,
        matricula: p.matricula,
        avion_color: p.avion_color ?? null,
      })),
    )
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  const totalMxn = round2(
    conFilas.reduce((s, p) => s + (p.otros_ingresos_avion?.total_mxn ?? 0), 0),
  );
  const usd = conFilas.some((p) => p.otros_ingresos_avion?.usd == null)
    ? null
    : round2(
        conFilas.reduce((s, p) => s + (p.otros_ingresos_avion?.usd ?? 0), 0),
      );
  return { filas, total_mxn: totalMxn, usd, usd_por_ingreso: true };
}
