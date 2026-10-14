/**
 * PIEZAS DEL EXCEL DE GASTOS (`GET /v1/expenses/export`), PURAS y con spec.
 *
 * 13-oct-2026 (API 0.0.75, invariante 71 — conciliación al revés):
 *  - el libro ya no se corta en 1,000 filas: se lee en páginas de
 *    `PAGINA_XLSX_GASTOS` hasta `TOPE_XLSX_GASTOS`, con aviso si se llega
 *    al tope (`notaTruncadoXlsx`);
 *  - ADMIN y FACTURACION (`puedeVerDetalleBanco`) reciben al final de la
 *    pestaña de siempre «Factura», «Cargo del banco» y «Estado de cuenta», y
 *    una pestaña nueva «Cargos del banco» con una fila por cada par gasto ×
 *    cargo. Todo sale del lector único `leerCargosDeGastos` (el mismo de la
 *    hoja del panel): aquí solo se ROTULA, ningún número se recalcula ni se
 *    suman monedas (la pestaña no lleva fila de totales).
 * Fechas `dd-mmm-aaaa` deterministas (`fechaNota`), en día Cancún.
 */
import { fechaNota, montoNota } from '../../common/vinculo-no-bancario.util';
import { diaCancun } from '../../common/fecha-cancun.util';
import { normalizarTc } from '../../common/tc.util';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import type {
  CargoDeGastoDetalle,
  CargosDeGastoLeidos,
} from '../conciliacion/cargos-de-gasto.util';
import type { TablaColumnaPayload } from '../pyservices/pyservices.service';
import type { EstadoBanco } from './estado-banco.util';

// ----------------------------- paginado ---------------------------------

/** Página de lectura (= el `max-rows` de PostgREST, que corta sin avisar). */
export const PAGINA_XLSX_GASTOS = 1000;
/** Máximo de gastos por Excel; si se llega, el subtítulo lo avisa. */
export const TOPE_XLSX_GASTOS = 20000;

function miles(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * « · OJO: se exportaron 20,000 de 25,310 gastos (tope del Excel); acota
 * los filtros» — '' si no hubo corte.
 */
export function notaTruncadoXlsx(mostrados: number, total: number): string {
  if (!(total > mostrados)) return '';
  return ` · OJO: se exportaron ${miles(mostrados)} de ${miles(total)} gastos (tope del Excel); acota los filtros`;
}

/**
 * «Concepto» del gasto: la primera línea de las notas recortada, o el
 * lugar (la MISMA expresión que la columna de siempre, 11-sep-2026).
 */
export function conceptoDeGasto(x: Record<string, unknown>): string {
  const notas = (typeof x.notas === 'string' ? x.notas : '')
    .split('\n')[0]
    .trim();
  const lugar = (typeof x.lugar === 'string' ? x.lugar : '').trim();
  return notas || lugar;
}

// -------------------------- pestaña principal ---------------------------

/** Las 3 columnas que se AGREGAN al final para ADMIN / FACTURACION. */
export const COLUMNAS_BANCO_PRINCIPAL: readonly TablaColumnaPayload[] = [
  { label: 'Factura' },
  { label: 'Cargo del banco' },
  { label: 'Estado de cuenta' },
];

export const TEXTO_DETALLE_BANCO_NO_DISPONIBLE =
  'No se pudo leer el detalle del banco (vuelve a exportar)';
export const NOTA_DETALLE_BANCO_NO_DISPONIBLE =
  ' · Detalle del banco NO disponible: vuelve a exportar';
export const NOTA_FOLIOS_NO_DISPONIBLES =
  ' · Números de factura NO disponibles: vuelve a exportar';
export const TEXTO_CONCILIADO_SIN_CARGO =
  'Marcado como conciliado, sin cargo ligado';

/** `dd-mmm-aaaa` del día Cancún de un instante; ilegible ⇒ «sin fecha». */
function diaNota(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || !iso) return 'sin fecha';
  try {
    return fechaNota(diaCancun(iso));
  } catch {
    return 'sin fecha';
  }
}

/**
 * «30-sep-2026 · EJE SCOTIA · $11,205.60» + « (paga 4 gastos; a este
 * $2,801.40)» en un lote, « (T.C. 17.2244)» (el GUARDADO) o « (T.C. sin
 * registrar)» en un cruzado y « (ligado con justificación)».
 */
export function etiquetaCargoReporte(
  c: CargoDeGastoDetalle,
  tcGasto: number | null | undefined,
): string {
  let s = `${fechaNota(c.fecha)} · ${c.cuenta?.alias || 'Cuenta'} · ${montoNota(c.monto, c.moneda)}`;
  if (c.lote) {
    s += ` (paga ${c.lote.gastos_n} gastos; a este ${montoNota(c.parte.monto_parte, c.parte.moneda)})`;
  }
  if (c.parte.cruzada) {
    const tc = normalizarTc(tcGasto);
    s += tc == null ? ' (T.C. sin registrar)' : ` (T.C. ${String(tc)})`;
  }
  if (c.justificacion) s += ' (ligado con justificación)';
  return s;
}

/**
 * Celda «Cargo del banco»: los cargos unidos con « | »; en PARCIAL + « ·
 * faltan $X de $Y» (el faltante de los aditivos de `list()`, que leen la
 * misma vista). Sin cargos: el aviso de «conciliado sin cargo» o ''.
 */
export function etiquetaCargosGastoReporte(args: {
  estado: EstadoBanco;
  cargos: ReadonlyArray<CargoDeGastoDetalle>;
  monto: number;
  moneda: string | null | undefined;
  faltante: number | null | undefined;
  tcGasto: number | null | undefined;
}): string {
  if (args.cargos.length === 0) {
    return args.estado === 'CONCILIADO' ? TEXTO_CONCILIADO_SIN_CARGO : '';
  }
  let s = args.cargos
    .map((c) => etiquetaCargoReporte(c, args.tcGasto))
    .join(' | ');
  if (args.estado === 'PARCIAL' && args.faltante != null) {
    s += ` · faltan ${montoNota(Number(args.faltante), args.moneda)} de ${montoNota(args.monto, args.moneda)}`;
  }
  return s;
}

/**
 * «scotia eje sep.pdf (importado 06-oct-2026)» (los nombres se repiten en
 * prod: por eso la fecha), «Sin archivo (importado el 16-jul-2026)» (día
 * Cancún del alta del cargo) o «Sin archivo (capturado a mano)».
 */
export function etiquetaEstadoCuentaCargo(c: CargoDeGastoDetalle): string {
  if (c.estado_cuenta) {
    return `${c.estado_cuenta.filename} (importado ${diaNota(c.estado_cuenta.importado_at)})`;
  }
  if (c.sin_archivo === 'IMPORTADO_SIN_ARCHIVO') {
    return `Sin archivo (importado el ${diaNota(c.creado_at)})`;
  }
  if (c.sin_archivo === 'CAPTURA_MANUAL')
    return 'Sin archivo (capturado a mano)';
  return '';
}

/** Celda «Estado de cuenta»: valores únicos unidos con « | ». */
export function etiquetaEstadosCuentaReporte(
  cargos: ReadonlyArray<CargoDeGastoDetalle>,
): string {
  const unicos: string[] = [];
  for (const c of cargos) {
    const e = etiquetaEstadoCuentaCargo(c);
    if (e && !unicos.includes(e)) unicos.push(e);
  }
  return unicos.join(' | ');
}

// --------------------- pestaña «Cargos del banco» -----------------------

export const TITULO_HOJA_CARGOS_BANCO = 'Cargos del banco';

export function subtituloHojaCargosBanco(
  rango: string,
  hayPares: boolean,
): string {
  return hayPares
    ? `Una fila por gasto y cargo del banco. Suma la columna «Aplicado a este gasto»: el monto del cargo y la diferencia de un cargo que paga varios gastos se repiten en cada uno.${rango}`
    : `Ningún gasto de este filtro tiene cargos del banco ligados.${rango}`;
}

/**
 * 22 columnas. «T.C. del gasto» va como TEXTO (el formato «numero» redondea
 * a 2 decimales y el T.C. lleva 6).
 */
export const COLUMNAS_HOJA_CARGOS_BANCO: readonly TablaColumnaPayload[] = [
  { label: 'Fecha gasto' },
  { label: 'Categoría' },
  { label: 'Vuelo' },
  { label: 'Concepto' },
  { label: 'Factura' },
  { label: 'Monto del gasto', tipo: 'money' },
  { label: 'Moneda del gasto' },
  { label: 'Banco' },
  { label: 'Fecha del cargo' },
  { label: 'Cuenta' },
  { label: 'Leyenda del banco' },
  { label: 'Referencia' },
  { label: 'Monto del cargo', tipo: 'money' },
  { label: 'Moneda del cargo' },
  { label: 'Aplicado a este gasto', tipo: 'money' },
  { label: 'Gastos que paga el cargo', tipo: 'entero' },
  { label: 'Diferencia del lote', tipo: 'money' },
  { label: 'T.C. del gasto' },
  { label: 'Estado de cuenta' },
  { label: 'Línea del archivo', tipo: 'entero' },
  { label: 'Registró la liga' },
  { label: 'Justificación' },
];

const COL_DIFERENCIA_LOTE = COLUMNAS_HOJA_CARGOS_BANCO.findIndex(
  (c) => c.label === 'Diferencia del lote',
);

/** Folio del vuelo de la fila de `list()` (`vuelo:vuelo!vuelo_id(folio)`). */
function folioVuelo(x: Record<string, unknown>): number | null {
  const raw = x.vuelo as
    | { folio?: unknown }
    | { folio?: unknown }[]
    | null
    | undefined;
  const v = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  const f = v?.folio == null ? null : Number(v.folio);
  return f != null && Number.isFinite(f) ? f : null;
}

function registroDeLiga(
  c: CargoDeGastoDetalle,
  fuente: CargosDeGastoLeidos['fuente'],
): string {
  const r = c.parte.registro;
  if (r) return `${r.por ?? 'sin usuario'} · ${diaNota(r.at)}`;
  return fuente === 'PUENTE' ? '(anterior al 02-oct-2026)' : '';
}

/**
 * Filas de la pestaña «Cargos del banco» de UN gasto: una por cada cargo
 * ligado (un gasto sin cargos no aparece). `resaltes` = la «Diferencia del
 * lote» con |d| ≥ 0.005, con `fila` RELATIVA a las filas devueltas (quien
 * arma la hoja suma su desfase).
 */
export function filasHojaCargosBanco(args: {
  fila: Record<string, unknown>;
  leidos: CargosDeGastoLeidos;
  etiquetaBanco: string;
  folio: string | null | undefined;
}): {
  filas: Array<Array<string | number | null>>;
  resaltes: Array<{ fila: number; col: number }>;
} {
  const x = args.fila;
  const filas: Array<Array<string | number | null>> = [];
  const resaltes: Array<{ fila: number; col: number }> = [];
  const tc = normalizarTc(x.tc_gasto);
  const vuelo = folioVuelo(x);
  for (const c of args.leidos.cargos) {
    const dif = c.lote?.gastos_diferencia ?? null;
    if (dif != null && Math.abs(dif) >= 0.005) {
      resaltes.push({ fila: filas.length, col: COL_DIFERENCIA_LOTE });
    }
    const j = c.justificacion;
    filas.push([
      typeof x.fecha_gasto === 'string' ? x.fecha_gasto.slice(0, 10) : '',
      etiquetaCategoriaGasto(
        typeof x.categoria === 'string' ? x.categoria : null,
      ),
      vuelo != null ? `#${vuelo}` : '',
      conceptoDeGasto(x),
      args.folio ?? '',
      Number(x.monto),
      typeof x.moneda === 'string' ? x.moneda : '',
      args.etiquetaBanco,
      c.fecha,
      c.cuenta
        ? `${c.cuenta.alias}${c.cuenta.tipo === 'PASARELA' ? ' (pasarela)' : ''}`
        : '',
      c.descripcion ?? '',
      c.referencia ?? '',
      c.monto,
      c.moneda ?? '',
      c.parte.monto_parte,
      c.lote?.gastos_n ?? 1,
      dif,
      c.parte.cruzada ? (tc == null ? 'sin registrar' : String(tc)) : '',
      etiquetaEstadoCuentaCargo(c),
      c.orden_archivo ?? null,
      registroDeLiga(c, args.leidos.fuente),
      j ? `${j.razon} — ${j.firmante}${j.fecha ? `, ${j.fecha}` : ''}` : '',
    ]);
  }
  return { filas, resaltes };
}
