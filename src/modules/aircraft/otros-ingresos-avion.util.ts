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
 * (partición única `partirIngresosPorAvion`) y el T.C. de sus hojas de
 * gastos; `payloadGeneral` fusiona las hojas de los libros para la hoja
 * consolidada «otros ingresos aviones». Los pesos salen de la fuente única
 * `filaLibroDeIngreso` (MXN directo; USD × su `tc_usd_mxn` PROPIO): nadie
 * reconvierte aquí. `buildHoja` NO se toca: su regla del USD de la hoja se
 * COPIA tal cual.
 */
import {
  filaLibroDeIngreso,
  type IngresoParaLibro,
} from '../../common/ingreso-resultado.util';
import { etiquetaCategoriaIngreso } from '../../common/categoria-ingreso.util';
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

/**
 * Fila de la hoja «Otros ingresos» de un ingreso (null si no es de
 * resultado: anticipos y aportaciones nunca llevan avión).
 */
export function filaHojaOtrosIngresos(
  i: IngresoParaLibro,
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
  };
}

/**
 * Hoja «Otros ingresos» de UN avión: filas en el orden recibido (fecha,
 * folio del lector), `total_mxn` = round2(Σ neto MXN) y `usd` con la MISMA
 * regla de `buildHoja` (copiada, no compartida): alguna fila sin MXN ⇒
 * null; total 0 ⇒ 0; si no, total ÷ `tcHojas` (sin T.C. ⇒ null). Un
 * ingreso USD sin T.C. (el CHECK `ingreso_tc_resultado_chk` ya lo impide)
 * se grita en `pendientes`: la utilidad después de gastos queda vacía.
 */
export function hojaOtrosIngresosAvion(
  ingresos: readonly IngresoParaLibro[],
  tcHojas: number | null,
  pendientes: string[],
): BalanceAvionHojaOtrosIngresosPayload {
  const filas: BalanceAvionOtroIngresoFilaPayload[] = [];
  for (const i of ingresos) {
    const fila = filaHojaOtrosIngresos(i);
    if (!fila) continue;
    if (fila.neto_mxn == null) {
      pendientes.push(
        `Hoja "Otros ingresos" (${fila.fecha}): ingreso ${fila.clave} en USD sin tipo de cambio — fila sin monto MXN; la utilidad después de gastos queda vacía`,
      );
    }
    filas.push(fila);
  }
  const totalMxn = round2(filas.reduce((s, f) => s + (f.neto_mxn ?? 0), 0));
  const hayFilaSinMxn = filas.some((f) => f.neto_mxn == null);
  const usd = hayFilaSinMxn
    ? null
    : totalMxn === 0
      ? 0
      : tcHojas != null
        ? round2(totalMxn / tcHojas)
        : null;
  return { filas, total_mxn: totalMxn, usd };
}

/**
 * Hoja consolidada «otros ingresos aviones» del Balance GENERAL: SOLO los
 * libros con filas (ninguno ⇒ null y el consolidado no lleva la llave). Cada
 * fila lleva «MATRÍCULA · » al frente del detalle, su `matricula` y su
 * `avion_color`; orden por fecha con sort ESTABLE (a igual fecha, el orden
 * de los libros). `total_mxn` = round2(Σ); `usd` = round2(Σ usd de los
 * libros) — cada libro convirtió con SU T.C. promedio: no hay un T.C. de
 * flota que lo reproduzca — y un `usd` null de cualquier libro con filas se
 * PROPAGA (jamás `?? 0`).
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
  return { filas, total_mxn: totalMxn, usd };
}
