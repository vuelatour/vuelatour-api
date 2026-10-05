/**
 * NÚMERO DE FACTURA DE UN GASTO — fuente única (5-oct-2026, API 0.0.57,
 * invariante 44 del CLAUDE.md). PURO: sin Nest ni Supabase.
 *
 * Pedido del cliente con la captura del Excel de conciliación: «al momento
 * de la conciliación me apoyan a poner el número de la factura con la que se
 * enlaza el movimiento. Aquí en notas estaría perfecto» (la columna «Notas»
 * salía vacía).
 *
 * El «número de factura» de un gasto vive en TRES lugares, con esta
 * prioridad:
 *   1. la factura recibida ligada (`gasto.factura_recibida_id →
 *      factura_recibida`) con `folio` (atributos `Serie`/`Folio` del CFDI,
 *      migración 20261005000002) ⇒ «A-0411», «FEACZM-72128»;
 *   2. `gasto.folio_ticket` (lo lee la IA o lo teclea la oficina);
 *   3. `gasto.valor_ia_extraido->>folio` (lectura IA que no se persistió como
 *      folio_ticket en algunas capturas del panel);
 *   4. la factura ligada SIN folio pero con UUID ⇒ «CFDI <uuid>» (el CFDI no
 *      exige Serie/Folio: el UUID es lo único que la identifica);
 *   5. nada ⇒ null (Notas queda como hoy).
 *
 * La usan: el reporte Excel de conciliación (columna «Notas» y la columna
 * «Factura» de «gastos sin banco»), la lista de movimientos
 * (`gasto.folio_comprobante` y cada `gastos[].folio_comprobante` de un lote)
 * y los candidatos de «Vincular gasto» / «Sugerir». Nadie más arma el texto.
 */

/** Lo que el embed `factura:factura_recibida!factura_recibida_id(…)` trae. */
export interface FacturaFolioLike {
  serie?: string | null;
  folio?: string | null;
  uuid_fiscal?: string | null;
}

export interface FolioComprobanteInput {
  folio_ticket?: string | null;
  ia_folio?: string | null;
  factura?: FacturaFolioLike | null;
}

/** Texto recortado; vacío o no-texto ⇒ null. Los números se aceptan. */
function limpio(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Número de factura del gasto (prioridad del encabezado) o null. */
export function folioComprobanteDeGasto(
  input: FolioComprobanteInput,
): string | null {
  const factura = input.factura ?? null;
  const folioFactura = limpio(factura?.folio);
  if (folioFactura) {
    return [limpio(factura?.serie), folioFactura].filter(Boolean).join('-');
  }
  const ticket = limpio(input.folio_ticket);
  if (ticket) return ticket;
  const ia = limpio(input.ia_folio);
  if (ia) return ia;
  const uuid = limpio(factura?.uuid_fiscal);
  if (uuid) return `CFDI ${uuid}`;
  return null;
}

/**
 * Lo mismo, desde la fila CRUDA de PostgREST (el embed `factura` puede venir
 * como objeto o como arreglo de uno; `ia_folio` sale de
 * `valor_ia_extraido->>folio`).
 */
export function folioComprobanteDeFila(
  g: Record<string, unknown> | null | undefined,
): string | null {
  if (!g) return null;
  const crudo = g.factura;
  const factura = (Array.isArray(crudo) ? (crudo[0] ?? null) : crudo) as
    | FacturaFolioLike
    | null
    | undefined;
  return folioComprobanteDeGasto({
    folio_ticket: limpio(g.folio_ticket),
    ia_folio: limpio(g.ia_folio),
    factura:
      factura && typeof factura === 'object'
        ? {
            serie: limpio(factura.serie),
            folio: limpio(factura.folio),
            uuid_fiscal: limpio(factura.uuid_fiscal),
          }
        : null,
  });
}

/** Campos CRUDOS que agrega `embedFolioGasto` (se retiran de las respuestas). */
export const CAMPOS_FOLIO_CRUDOS = ['folio_ticket', 'ia_folio', 'factura'];

/**
 * Columnas que hay que pedir del GASTO para calcular su folio. `serie` y
 * `folio` de la factura SOLO con la migración 20261005000002 aplicada (si
 * no, 42703 y la consulta entera revienta): sin ella, la factura aporta solo
 * su UUID.
 */
export function embedFolioGasto(conSerieFolio: boolean): string {
  const factura = conSerieFolio ? 'serie, folio, uuid_fiscal' : 'uuid_fiscal';
  return `folio_ticket, ia_folio:valor_ia_extraido->>folio, factura:factura_recibida!factura_recibida_id(${factura})`;
}

/**
 * Copia del gasto con `folio_comprobante` y SIN los campos crudos del
 * cálculo (la respuesta crece en UN solo campo aditivo).
 */
export function conFolioComprobante(
  g: Record<string, unknown>,
): Record<string, unknown> {
  const folio = folioComprobanteDeFila(g);
  const out: Record<string, unknown> = { ...g };
  for (const k of CAMPOS_FOLIO_CRUDOS) delete out[k];
  out.folio_comprobante = folio;
  return out;
}

/**
 * Etiqueta de las facturas de una línea del banco: 1 ⇒ «Factura
 * FEACZM-72128»; N ⇒ «Facturas FEACZM-72128 · A-0411» (sin vacíos ni
 * duplicados, en el orden recibido); 0 ⇒ null.
 */
export function etiquetaFacturasReporte(
  folios: ReadonlyArray<string | null | undefined>,
): string | null {
  const unicos: string[] = [];
  for (const f of folios) {
    const t = limpio(f);
    if (t && !unicos.includes(t)) unicos.push(t);
  }
  if (unicos.length === 0) return null;
  return `${unicos.length === 1 ? 'Factura' : 'Facturas'} ${unicos.join(' · ')}`;
}

/**
 * Columna «Notas» del Excel: la etiqueta de la factura PRIMERO y luego la
 * nota del banco, unidas con « · » (vacíos fuera). Sin factura queda la nota
 * del banco TAL CUAL, byte a byte (como hasta el 0.0.56).
 */
export function notasReporteConFactura(
  etiquetaFactura: string | null | undefined,
  notasBanco: string | null | undefined,
): string {
  const etiqueta = limpio(etiquetaFactura);
  if (!etiqueta) return typeof notasBanco === 'string' ? notasBanco : '';
  return [etiqueta, limpio(notasBanco)].filter(Boolean).join(' · ');
}
