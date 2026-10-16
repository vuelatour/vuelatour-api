/**
 * VARIAS FACTURAS RECIBIDAS POR GASTO (16-oct-2026, API 0.0.87, invariante
 * 87) — piezas PURAS (sin BD) que comparten `InvoicesService` y el lector de
 * gastos: forma de `FacturaDeGasto`, orden, nombre legible, huella del PDF,
 * agrupación de los archivos de UN envío (mismo archivo dos veces ⇒ una sola
 * factura) y el aviso «Las facturas suman $X; el gasto es $Y».
 */
import { createHash } from 'node:crypto';
import { fmtDineroTexto } from '../../common/dinero-texto.util';

/** Una factura recibida tal como la ve la fila / el detalle de un gasto. */
export interface FacturaDeGasto {
  id: string;
  /** `true` = es `gasto.factura_recibida_id` (la primera; la que da el folio). */
  principal: boolean;
  serie: string | null;
  folio: string | null;
  uuid_fiscal: string | null;
  emisor_nombre: string | null;
  total: number | null;
  moneda: string | null;
  fecha_emision: string | null;
  /** Path en el bucket `facturas` (firmar con POST /invoices/recibidas/file-urls). */
  pdf_url: string | null;
  xml_url: string | null;
  /** Nombre del archivo original (de las notas de un PDF sin XML) o null. */
  nombre: string | null;
}

/** Prefijo de la nota de una factura que entró solo en PDF (desde 22-sep). */
export const PREFIJO_NOTA_PDF_SIN_XML = 'Factura en PDF (sin XML)';

/** «Factura en PDF (sin XML): ACC…_FCUN_1299718.pdf» (formato de siempre). */
export function notaPdfSinXml(nombre?: string | null): string {
  const n = (nombre ?? '').trim();
  return n ? `${PREFIJO_NOTA_PDF_SIN_XML}: ${n}` : PREFIJO_NOTA_PDF_SIN_XML;
}

/** El nombre del archivo que guardó `notaPdfSinXml`, o null. */
export function nombreDeNotas(notas: unknown): string | null {
  if (typeof notas !== 'string') return null;
  const pref = `${PREFIJO_NOTA_PDF_SIN_XML}:`;
  if (!notas.startsWith(pref)) return null;
  const n = notas.slice(pref.length).trim();
  return n || null;
}

/** SHA-256 en hex minúsculas (64) — el CHECK de la columna exige ese formato. */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;

const numero = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Fila de `factura_recibida` (columnas que existan) ⇒ `FacturaDeGasto`. */
export function aFacturaDeGasto(
  fila: Record<string, unknown>,
  principalId: string | null | undefined,
): FacturaDeGasto {
  const id = String(fila.id);
  return {
    id,
    principal: principalId != null && id === principalId,
    serie: texto(fila.serie),
    folio: texto(fila.folio),
    uuid_fiscal: texto(fila.uuid_fiscal),
    emisor_nombre: texto(fila.emisor_nombre),
    total: numero(fila.total),
    moneda: texto(fila.moneda),
    fecha_emision: texto(fila.fecha_emision),
    pdf_url: texto(fila.pdf_url),
    xml_url: texto(fila.xml_url),
    nombre: nombreDeNotas(fila.notas),
  };
}

/**
 * Orden ÚNICO de las facturas de un gasto: la principal primero; después por
 * fecha de la liga (la más antigua primero — es también el orden de
 * PROMOCIÓN al quitar la principal) y, a igualdad, por id.
 */
export function ordenarFacturasDeGasto<
  T extends { factura: FacturaDeGasto; ligada_at: string | null },
>(lista: T[]): T[] {
  return [...lista].sort((a, b) => {
    if (a.factura.principal !== b.factura.principal)
      return a.factura.principal ? -1 : 1;
    const fa = a.ligada_at ?? '';
    const fb = b.ligada_at ?? '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.factura.id < b.factura.id
      ? -1
      : a.factura.id > b.factura.id
        ? 1
        : 0;
  });
}

/**
 * ¿A cuál promover al quitar la principal? La liga más antigua que no sea la
 * que sale (mismo orden que `ordenarFacturasDeGasto`); null si no queda otra.
 */
export function siguientePrincipal(
  ligas: Array<{ factura_recibida_id: string; created_at: string | null }>,
  sale: string,
): string | null {
  const resto = ligas
    .filter((l) => l.factura_recibida_id !== sale)
    .sort((a, b) => {
      const fa = a.created_at ?? '';
      const fb = b.created_at ?? '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.factura_recibida_id < b.factura_recibida_id ? -1 : 1;
    });
  return resto[0]?.factura_recibida_id ?? null;
}

// ===== Agrupación de los archivos de UN envío =====

/** Un archivo del envío ya leído (UUID del XML parseado y huella del PDF). */
export interface ArchivoLeido {
  /** Posición en `archivos[]` (0-based). */
  indice: number;
  xml_b64: string | null;
  pdf_b64: string | null;
  nombre: string | null;
  /** UUID fiscal del XML (null sin XML o si el XML no trae UUID). */
  uuid: string | null;
  /** SHA-256 del PDF (null sin PDF). */
  pdf_sha256: string | null;
  /** SHA-256 del XML (para agrupar XML sin UUID; null sin XML). */
  xml_sha256: string | null;
  /** Lo que devolvió el parser del XML (null sin XML). */
  parse: Record<string, unknown> | null;
}

/** Una factura a resolver: uno o más archivos del envío que son LA MISMA. */
export interface GrupoFactura {
  indices: number[];
  xml_b64: string | null;
  pdf_b64: string | null;
  nombre: string | null;
  uuid: string | null;
  pdf_sha256: string | null;
  parse: Record<string, unknown> | null;
}

/**
 * Mismo archivo dos veces en un envío ⇒ UNA factura:
 *  - XML con el mismo UUID fiscal ⇒ mismo grupo (el PDF que traiga
 *    cualquiera de ellos se queda);
 *  - un PDF SIN XML cuya huella es la del PDF de un grupo con XML ⇒ es el
 *    papel de ESE CFDI: se une a ese grupo;
 *  - PDF sin XML con la misma huella ⇒ mismo grupo;
 *  - XML sin UUID (raro) ⇒ se agrupa por la huella del propio XML.
 * El orden de los grupos es el de la primera aparición.
 */
export function agruparArchivos(archivos: ArchivoLeido[]): GrupoFactura[] {
  const grupos: GrupoFactura[] = [];
  const porLlave = new Map<string, GrupoFactura>();
  const porPdf = new Map<string, GrupoFactura>();

  const unir = (g: GrupoFactura, a: ArchivoLeido) => {
    g.indices.push(a.indice);
    if (!g.xml_b64 && a.xml_b64) {
      g.xml_b64 = a.xml_b64;
      g.parse = a.parse;
      g.uuid = a.uuid;
    }
    if (!g.pdf_b64 && a.pdf_b64) {
      g.pdf_b64 = a.pdf_b64;
      g.pdf_sha256 = a.pdf_sha256;
      if (a.pdf_sha256) porPdf.set(a.pdf_sha256, g);
    }
    if (!g.nombre && a.nombre) g.nombre = a.nombre;
  };
  const nuevo = (llave: string, a: ArchivoLeido) => {
    const g: GrupoFactura = {
      indices: [a.indice],
      xml_b64: a.xml_b64,
      pdf_b64: a.pdf_b64,
      nombre: a.nombre,
      uuid: a.uuid,
      pdf_sha256: a.pdf_b64 ? a.pdf_sha256 : null,
      parse: a.parse,
    };
    grupos.push(g);
    porLlave.set(llave, g);
    if (g.pdf_sha256) porPdf.set(g.pdf_sha256, g);
  };

  // 1ª pasada: los que traen XML (su identidad es el UUID).
  for (const a of archivos) {
    if (!a.xml_b64) continue;
    const llave = a.uuid ? `u:${a.uuid}` : `x:${a.xml_sha256 ?? a.indice}`;
    // Dos UUID distintos NUNCA se unen (aunque compartieran el PDF).
    const g = porLlave.get(llave);
    if (g) unir(g, a);
    else nuevo(llave, a);
  }
  // 2ª pasada: PDF sin XML (su identidad es la huella).
  for (const a of archivos) {
    if (a.xml_b64 || !a.pdf_b64) continue;
    const g = a.pdf_sha256 ? porPdf.get(a.pdf_sha256) : undefined;
    if (g) unir(g, a);
    else nuevo(`s:${a.pdf_sha256 ?? `i${a.indice}`}`, a);
  }
  // Orden de primera aparición en el envío.
  return grupos.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));
}

// ===== Aviso NO bloqueante: Σ facturas vs monto del gasto =====

/** Tolerancia del aviso (misma que el resto de cuadres del sistema). */
export const TOLERANCIA_SUMA_FACTURAS = 1.0;

/**
 * «Las facturas suman $X; el gasto es $Y.» cuando las facturas del gasto CON
 * total (es decir, con XML) en la MISMA moneda del gasto no cuadran con su
 * monto (± 1.00). Null si cuadra, si no hay ninguna con total en esa moneda,
 * o si alguna de las facturas ampara además OTROS gastos (`compartida`: el
 * caso VIP SAESA, una factura para varios aterrizajes — su total no es de
 * este gasto y la comparación no diría nada útil). Nunca bloquea.
 */
export function avisoSumaFacturas(
  gasto: { monto: unknown; moneda: unknown },
  facturas: Array<Pick<FacturaDeGasto, 'total' | 'moneda'>>,
  compartida: boolean,
): string | null {
  if (compartida) return null;
  const monto = numero(gasto.monto);
  const moneda =
    typeof gasto.moneda === 'string' ? gasto.moneda.trim().toUpperCase() : '';
  if (monto == null || !moneda) return null;
  const mismas = facturas.filter(
    (f) => f.total != null && (f.moneda ?? '').trim().toUpperCase() === moneda,
  );
  if (mismas.length === 0) return null;
  const suma =
    Math.round(mismas.reduce((s, f) => s + (f.total ?? 0), 0) * 100) / 100;
  if (Math.abs(suma - monto) <= TOLERANCIA_SUMA_FACTURAS + 1e-9) return null;
  return `Las facturas suman ${fmtDineroTexto(suma, moneda)}; el gasto es ${fmtDineroTexto(monto, moneda)}.`;
}
