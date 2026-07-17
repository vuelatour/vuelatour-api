/**
 * Desglose de una factura de gasto a partir de los renglones que leyó la IA.
 * FUENTE ÚNICA de la regla: la usan la creación de gastos (notas), el
 * enriquecimiento IA del sync offline y la vista previa del panel — no
 * duplicar este cálculo en ningún otro lado.
 *
 * REGLA DEL CLIENTE (facturas de aeródromo): FBO y TUA se separan CON su
 * IVA incluido y todo lo demás se agrupa como "Operación" = total −
 * separados. Dos formas de factura:
 *
 * a) Renglones NETOS + renglón de IVA aparte (ej. FEDCUN): FBO/TUA netos ×
 *    1.16 (el neto ya trae el descuento que la IA lee del renglón).
 *    Ej.: total $911.28 con TUA $605.18 y descuento $5.18 (neto $600) →
 *    TUA $696.00 + Operación $215.28.
 * b) TABLA RESUMEN por secciones con IVA YA INCLUIDO (ej. CZA/ASUR:
 *    Operaciones/Tarifa TUA/FOB con columna Total): los montos se usan tal
 *    cual — se detecta porque NO hay renglón de IVA y la suma de conceptos
 *    da el total pagado. Ej.: total $1,673.67 con Operaciones $554.41 y
 *    Tarifa TUA $1,119.26 → TUA $1,119.26 + Operación $554.41.
 *
 * Sin renglones FBO/TUA reconocibles, se listan tal cual.
 */
export function desgloseGastoLineas(
  conceptos: Array<{ concepto: string; monto: number }>,
  total: number,
  moneda: string,
): string[] {
  // FBO / FOB (así lo imprime ASUR en la tabla resumen).
  const esFbo = (c: string) => /\bf(?:bo|ob)\b/i.test(c);
  // TUA / T.U.A. / TUAS con límites de palabra (no matchear "actual").
  const esTua = (c: string) => /\bt\.?\s?u\.?\s?a\.?s?\b/i.test(c);
  const hayIva = conceptos.some((c) => /\biva\b/i.test(c.concepto));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const fbo = conceptos
    .filter((c) => esFbo(c.concepto))
    .reduce((a, c) => a + c.monto, 0);
  const tua = conceptos
    .filter((c) => esTua(c.concepto) && !esFbo(c.concepto))
    .reduce((a, c) => a + c.monto, 0);
  const armar = (tuaConIva: number, fboConIva: number): string[] => {
    const operacion = r2(total - tuaConIva - fboConIva);
    const lineas = [`Operación - $${operacion.toFixed(2)} ${moneda}`];
    if (tuaConIva > 0)
      lineas.push(`TUA (IVA incluido) - $${tuaConIva.toFixed(2)} ${moneda}`);
    if (fboConIva > 0)
      lineas.push(`FBO (IVA incluido) - $${fboConIva.toFixed(2)} ${moneda}`);
    return lineas;
  };
  if ((fbo > 0 || tua > 0) && total > 0) {
    // (a) Netos + IVA aparte → separar con IVA (neto × 1.16).
    if (hayIva) return armar(r2(tua * 1.16), r2(fbo * 1.16));
    // (b) Tabla resumen: montos YA con IVA que suman el total → tal cual.
    const suma = r2(conceptos.reduce((a, c) => a + c.monto, 0));
    if (Math.abs(suma - r2(total)) <= 0.05) return armar(r2(tua), r2(fbo));
  }
  return conceptos.map(
    (c) => `${c.concepto} - $${c.monto.toFixed(2)} ${moneda}`,
  );
}
