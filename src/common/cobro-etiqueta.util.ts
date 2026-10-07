/**
 * FUENTE ÚNICA de «¿cómo se cobró esta parcialidad?» en UNA línea de texto
 * (6-oct-2026, API 0.0.60). Pedido del cliente con el Excel «reporte horas
 * FLOTA»: «Al lado de la columna STATUS, si ya se pagó, que venga la misma
 * información de cómo se cobró, quién lo cobró y, si es posible, a qué
 * cuenta». El panel ya lo pinta por cobro como «Transferencia → Scotiabank
 * Pesos · Registró: Itzi»; el balance por avión lo manda ARMADO en
 * `cobrado_con` y pyservices solo lo pinta (nota de la celda «COBRO n»), así
 * panel y Excel pueden compartir el MISMO texto después.
 *
 * Forma: `<método> → <cuenta> · Registró: <nombre>[ · <parte>]`.
 * - Sin cuenta (efectivo, dólares directo): `Efectivo · Registró: Itzi`.
 * - Sin registro (usuario borrado o sin dato): `Transferencia → Scotiabank
 *   Pesos`.
 * - Multi-avión: la PARTE de la fila (el mismo texto del sufijo de `metodo`,
 *   sin el « · » inicial) va AL FINAL, para que la flecha quede pegada al
 *   método: `Transferencia → Scotiabank Pesos · Registró: Itzi · parte de
 *   esta fila (50 % de la venta del avión)`.
 * - Sin método, sin cuenta y sin registro ⇒ `null` (no hay nada que decir;
 *   la parte sola no dice cómo se cobró).
 *
 * «Registró» y no el nombre a secas: el sistema sabe quién CAPTURÓ el cobro
 * (`cobro_vuelo.registrado_por`), no quién recibió el dinero — es la misma
 * palabra que pinta el panel (`textoRegistroCobro`).
 *
 * COMISIÓN BANCARIA (6-oct-2026, API 0.0.65, vuelos en la vigencia de
 * `comisiones-avion.util`): con `comision` la línea EMPIEZA con lo que entró
 * de verdad — `Bruto $20,400.00 · comisión banco 5 % $1,020.00 · neto
 * $19,380.00 · Transferencia → Scotiabank Pesos · Registró: Itzi` — porque la
 * celda «COBRO n» muestra el NETO. Los montos son los de ESTA fila (en
 * multi-avión, su parte). Sin método, cuenta ni registro queda solo la
 * comisión (sí hay algo que decir). Sin `comision` (o en 0) la línea es la
 * de siempre, byte a byte.
 *
 * PURA: no consulta nada. El nombre lo resuelve quien llama (en el balance,
 * el embed `registro:usuario!registrado_por(nombre)` +
 * `nombreDeRelacionUsuario`) y la etiqueta del método sale de
 * `etiquetaMetodoCobro` (`metodo-cobro.util`).
 */

import { fmtMxnNota, fmtPctNota } from './comisiones-avion.util';

/** Entre el método y la cuenta destino. */
export const FLECHA_CUENTA_COBRO = ' → ';
/** Entre las piezas de la línea. */
export const SEPARADOR_COBRADO_CON = ' · ';
/** Antes del nombre de quien capturó el cobro (igual que el panel). */
export const PREFIJO_REGISTRO_COBRO = 'Registró: ';

/** Lo que hace falta para armar la línea. */
export interface DatosCobradoCon {
  /**
   * Etiqueta HUMANA del método (`etiquetaMetodoCobro`: «Transferencia»,
   * «Efectivo»…) SIN el sufijo de parte del multi-avión. `null`, vacío o
   * «—» = sin método.
   */
  metodo_etiqueta: string | null | undefined;
  /** Cuenta destino (`cobro_vuelo.cuenta_destino`); vacío = sin cuenta. */
  cuenta: string | null | undefined;
  /** Nombre de quien registró el cobro; vacío o un uuid = sin registro. */
  registro: string | null | undefined;
  /**
   * Multi-avión: qué lleva ESTA fila del cobro («parte de esta fila (50 % de
   * la venta del avión)»), sin el separador inicial. Se omite en un vuelo de
   * un solo avión.
   */
  parte?: string | null;
  /**
   * Comisión bancaria de la parcialidad (6-oct-2026, API 0.0.65): solo en
   * vuelos de la vigencia y con comisión > 0. null/ausente = línea de
   * siempre.
   */
  comision?: ComisionCobradoCon | null;
}

/** Bruto / comisión / neto de ESTA fila (los de la celda y su nota). */
export interface ComisionCobradoCon {
  /** Lo depositado en bruto (`monto_mxn` de la fila). */
  bruto_mxn: number;
  /** Comisión bancaria (`comision_mxn` de la fila). */
  comision_mxn: number;
  /** % capturado en el cobro (puntos: 5 = 5 %); null = no se capturó. */
  pct?: number | null;
  /** bruto − comisión (`neto_mxn` de la fila): lo que entró. */
  neto_mxn: number;
}

/** Antes del % y del monto de la comisión en la línea. */
export const PREFIJO_COMISION_BANCO_COBRO = 'comisión banco ';

/** «Bruto $20,400.00 · comisión banco 5 % $1,020.00 · neto $19,380.00». */
export function textoComisionCobro(c: ComisionCobradoCon): string {
  const pct =
    c.pct != null && Number.isFinite(c.pct) && c.pct > 0
      ? `${fmtPctNota(c.pct)} % `
      : '';
  return [
    `Bruto ${fmtMxnNota(c.bruto_mxn)}`,
    `${PREFIJO_COMISION_BANCO_COBRO}${pct}${fmtMxnNota(c.comision_mxn)}`,
    `neto ${fmtMxnNota(c.neto_mxn)}`,
  ].join(SEPARADOR_COBRADO_CON);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Texto presentable o null (recorta y colapsa espacios). */
function limpio(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length > 0 ? t : null;
}

/**
 * La línea «cómo se cobró» de una parcialidad, o `null` si no hay comisión,
 * método, cuenta ni registro. Ver la cabecera para la forma exacta.
 */
export function etiquetaCobradoCon(d: DatosCobradoCon): string | null {
  const metodoTxt = limpio(d.metodo_etiqueta);
  const metodo = metodoTxt === '—' ? null : metodoTxt;
  const cuenta = limpio(d.cuenta);
  const registroTxt = limpio(d.registro);
  // Jamás un uuid como nombre (misma regla que `registrado-por.util`).
  const registro =
    registroTxt != null && !UUID_RE.test(registroTxt) ? registroTxt : null;
  const parte = limpio(d.parte);

  const piezas: string[] = [];
  const comision =
    d.comision != null && d.comision.comision_mxn > 0 ? d.comision : null;
  if (comision != null) piezas.push(textoComisionCobro(comision));
  if (metodo != null && cuenta != null) {
    piezas.push(`${metodo}${FLECHA_CUENTA_COBRO}${cuenta}`);
  } else if (metodo != null) {
    piezas.push(metodo);
  } else if (cuenta != null) {
    // Sin método capturado: la cuenta sola, con la flecha del panel.
    piezas.push(`${FLECHA_CUENTA_COBRO.trimStart()}${cuenta}`);
  }
  if (registro != null) piezas.push(`${PREFIJO_REGISTRO_COBRO}${registro}`);
  if (piezas.length === 0) return null;
  if (parte != null) piezas.push(parte);
  return piezas.join(SEPARADOR_COBRADO_CON);
}
