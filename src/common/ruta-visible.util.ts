/**
 * Ruta VISIBLE de cara al cliente (PDF de cotización y recibo de cobro).
 *
 * Recorre los tramos visibles EN SU ORDEN ORIGINAL y une los puntos que
 * quedan: si un tramo intermedio está oculto (`pdf_oculto`), el origen del
 * siguiente tramo visible entra como punto propio en lugar de desaparecer.
 * Ejemplo — visibles CUN→AZP, BZE→CZM, CZM→CUN (los tramos AZP→…→BZE quedaron
 * ocultos) → ["CUN", "AZP", "BZE", "CZM", "CUN"].
 *
 * Es el ÚNICO algoritmo del walk (lo comparten cotización y recibo: jamás
 * duplicar esta lógica). Presentación PURA: no toca precios, desglose
 * canónico ni totales — el tramo oculto se sigue cobrando; solo no se pinta.
 */
export function puntosRutaVisible(
  legs: ReadonlyArray<{ origen_iata?: unknown; destino_iata?: unknown }>,
): string[] {
  const puntos: string[] = [];
  for (const l of legs) {
    const o = typeof l.origen_iata === 'string' ? l.origen_iata.trim() : '';
    const d = typeof l.destino_iata === 'string' ? l.destino_iata.trim() : '';
    // El origen solo entra cuando hay hueco (difiere del último punto); el
    // destino SIEMPRE (un sobrevuelo CUN→CUN se sigue pintando "CUN → CUN").
    if (o && o !== puntos[puntos.length - 1]) puntos.push(o);
    if (d) puntos.push(d);
  }
  return puntos;
}
