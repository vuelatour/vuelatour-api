/**
 * Normaliza un código de barras / SKU tal como lo entrega el escáner: sin
 * espacios (ni internos: el UPC impreso "0 21400 06215 3" se captura como
 * "021400062153"), sin tocar mayúsculas (los SKU internos pueden traer
 * letras). Cadena vacía → null. FUENTE ÚNICA para toda entrada de códigos:
 * ítems, empaques, lookup, alta masiva y visión.
 *
 * Canonización UPC-A ↔ EAN-13: un EAN-13 que empieza con 0 ES el UPC-A con
 * un cero de relleno (GTIN-12 → GTIN-13); los escáneres lo entregan de
 * cualquiera de las dos formas, así que se guarda y busca SIEMPRE como los
 * 12 dígitos. Espejo en BD: la función `inventario_codigo_unico()` hace lo
 * mismo antes de comparar. No toca 14 dígitos (ITF-14 de la caja, cuyo 0
 * inicial es el indicador de empaque) ni códigos con letras.
 *
 * Un número (Excel leyó la celda como numérico) se vuelve texto entero: se
 * pierde un cero inicial si lo había — la alta masiva lo avisa por fila.
 */
export function normalizarCodigo(raw: unknown): string | null {
  if (raw == null) return null;
  let s: string;
  if (typeof raw === 'number') s = numeroATexto(raw);
  else if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'bigint' || typeof raw === 'boolean') s = String(raw);
  else return null; // objetos/arreglos: no es un código
  s = s.replace(/\s+/g, '');
  // "2.1400062153E10" / "2.14e+10": notación científica de una celda
  // numérica exportada como texto — se reconstruye el entero. SOLO con punto
  // decimal o signo "+": "1E5" es un SKU alfanumérico válido y se respeta.
  if (/^(\d+\.\d+e\+?\d+|\d+e\+\d+)$/i.test(s)) s = numeroATexto(Number(s));
  if (/^0\d{12}$/.test(s)) s = s.slice(1);
  return s.length > 0 ? s : null;
}

function numeroATexto(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n) || Math.abs(n) >= 1e15) {
    // Sin notación científica ni decimales fantasma (21400062153.0).
    return BigInt(Math.round(n)).toString();
  }
  return String(n);
}

/**
 * Pinta de código de barras comercial (EAN-8 / UPC-A / EAN-13 / ITF-14):
 * solo dígitos, 8 a 14. Útil para decidir si un texto tecleado/pegado es un
 * escaneo (búsqueda directa) o una búsqueda libre.
 */
export function pareceCodigoBarras(codigo: string): boolean {
  return /^\d{8,14}$/.test(codigo);
}
