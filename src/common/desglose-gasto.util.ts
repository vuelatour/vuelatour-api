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
/**
 * Claves de concepto que algunos aeropuertos imprimen EN VEZ del nombre del
 * servicio (renglones "Servicio (clave NNNNNN)"). Verificadas contra
 * facturas reales capturadas en el sistema:
 * - 230700 = TUA en Aeropuerto de Cozumel (ticket jul-2026: neto $1,484.44
 *   × 1.16 = $1,721.95, cuadra exacto con la separación manual de oficina).
 * Al confirmar claves nuevas de otros aeropuertos, agregarlas aquí (única
 * fuente de la regla).
 */
const CLAVES_TUA = ['230700'];

// FBO / FOB (así lo imprime ASUR en la tabla resumen).
const esFbo = (c: string) => /\bf(?:bo|ob)\b/i.test(c);
// TUA / T.U.A. / TUAS / "Uso de Aeropuerto" con límites de palabra (no
// matchear "actual"), o renglón "Servicio (clave NNNNNN)" con clave TUA
// conocida del catálogo de arriba.
const esTua = (c: string) =>
  /\bt\.?\s?u\.?\s?a\.?s?\b/i.test(c) ||
  /uso\s+de\s+aeropuerto/i.test(c) ||
  CLAVES_TUA.some((clave) => new RegExp(`\\b${clave}\\b`).test(c));

export interface DesglosePartes {
  operacion: number;
  tua: number;
  fbo: number;
}

/**
 * Partes NUMÉRICAS de la separación (la MISMA regla que las líneas de
 * texto): TUA y FBO con su IVA incluido, Operación = total − separados.
 * `null` cuando la factura no trae renglones TUA/FBO reconocibles o los
 * montos no cuadran — el caller trata el gasto como un solo monto.
 *
 * La usan las notas del gasto (vía desgloseGastoLineas) y el Balance por
 * avión: el TUA es un TRASLADO al pasajero, no costo de operar el avión —
 * regla del libro manual del cliente (17-ago-2026).
 */
export function desgloseGastoPartes(
  conceptos: Array<{ concepto: string; monto: number }>,
  total: number,
): DesglosePartes | null {
  // Normalización ANTES de calcular (mismos filtros que la composición de
  // notas en expenses.service): los lectores del balance/Libro Dinero pasan
  // el jsonb CRUDO — montos string/0/negativos divergían del texto impreso.
  const limpios = conceptos
    .map((c) => ({
      concepto: String(c?.concepto ?? ''),
      monto: Number(c?.monto),
    }))
    .filter((c) => c.concepto && Number.isFinite(c.monto) && c.monto > 0);
  const hayIva = limpios.some((c) => /\biva\b/i.test(c.concepto));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const fbo = limpios
    .filter((c) => esFbo(c.concepto))
    .reduce((a, c) => a + c.monto, 0);
  const tua = limpios
    .filter((c) => esTua(c.concepto) && !esFbo(c.concepto))
    .reduce((a, c) => a + c.monto, 0);
  // Coherencia: si la separación deja Operación NEGATIVA (monto del gasto
  // editado tras la captura IA, pago parcial, moneda distinta), las partes NO
  // cuadran y se descartan — restar un TUA mayor que el gasto a la columna
  // del balance sería peor que no separar.
  const armar = (
    tuaConIva: number,
    fboConIva: number,
  ): DesglosePartes | null => {
    const operacion = r2(total - tuaConIva - fboConIva);
    return operacion >= 0
      ? { operacion, tua: tuaConIva, fbo: fboConIva }
      : null;
  };
  if ((fbo > 0 || tua > 0) && total > 0) {
    // (a) Netos + IVA aparte → separar con IVA (neto × 1.16), PERO solo si
    // la lectura IA es COHERENTE: los netos × 1.16 deben sumar el total
    // (tolerancia $1). Caso real 26-ago (gasto 45007a9c): la IA leyó un TUA
    // $25 arriba y la separación mandaba ~$30 a la hoja equivocada — mejor
    // no separar que separar con números que no cuadran (mismo criterio
    // conservador que la forma b).
    if (hayIva) {
      const netos = r2(
        limpios
          .filter((c) => !/\biva\b/i.test(c.concepto))
          .reduce((a, c) => a + c.monto, 0),
      );
      if (Math.abs(r2(netos * 1.16) - r2(total)) > 1) return null;
      return armar(r2(tua * 1.16), r2(fbo * 1.16));
    }
    // (b) Tabla resumen: montos YA con IVA que suman el total → tal cual.
    const suma = r2(limpios.reduce((a, c) => a + c.monto, 0));
    if (Math.abs(suma - r2(total)) <= 0.05) return armar(r2(tua), r2(fbo));
  }
  return null;
}

export function desgloseGastoLineas(
  conceptos: Array<{ concepto: string; monto: number }>,
  total: number,
  moneda: string,
): string[] {
  const partes = desgloseGastoPartes(conceptos, total);
  if (partes) {
    const lineas = [`Operación - $${partes.operacion.toFixed(2)} ${moneda}`];
    if (partes.tua > 0)
      lineas.push(`TUA (IVA incluido) - $${partes.tua.toFixed(2)} ${moneda}`);
    if (partes.fbo > 0)
      lineas.push(`FBO (IVA incluido) - $${partes.fbo.toFixed(2)} ${moneda}`);
    return lineas;
  }
  return conceptos.map(
    (c) => `${c.concepto} - $${c.monto.toFixed(2)} ${moneda}`,
  );
}

/**
 * Categorías donde JAMÁS se separa un TUA embebido (regla 7, 28-ago-2026):
 * GAS/PERMISO/INDIRECTO tienen hoja propia, TUAS es el TUA entero (no
 * embebido) y las categorías del piloto no traen factura de aeródromo.
 * FUENTE ÚNICA: la usan el Balance por avión (fila del vuelo y pestaña
 * Otros movimientos), el reparto a socios y el Libro Dinero.
 */
export const CATS_SIN_TUA_EMBEBIDO: ReadonlySet<string> = new Set([
  'GAS',
  'PERMISO',
  'INDIRECTO',
  // NOMINA y SERVICIOS (29-ago): nómina y servicios al avión no traen
  // factura de aeródromo con TUA embebido.
  'NOMINA',
  'SERVICIOS',
  'TUAS',
  'COMIDA',
  'HOTEL',
  'TAXI',
  'PILOTO_EXTERNO',
  'PERSONAL_DUENO',
  'GASOLINA',
  'VISITA',
]);

export interface GastoParaTuaEmbebido {
  vuelo_id?: string | null;
  categoria?: string | null;
  monto?: string | number | null;
  propina?: string | number | null;
  valor_ia_extraido?: unknown;
  es_reparto_parcial?: boolean;
}

/**
 * Parte TUA EMBEBIDA (con su IVA) de una factura de aeródromo/handling, en la
 * MONEDA del gasto; 0 si no hay nada que separar. Regla 7 (28-ago-2026): el
 * TUA es un traslado al pasajero, no costo del avión — su egreso vive en
 * Otros movimientos del Balance general. Base del desglose = monto − propina
 * (la propina no sale de la factura pero SÍ sigue siendo costo del avión).
 * Solo gastos CON vuelo; los parciales del reparto manual quedan fuera (sus
 * renglones IA son de la factura completa y no cuadran con el parcial).
 */
export function tuaEmbebidoDeGasto(g: GastoParaTuaEmbebido): number {
  if (g.es_reparto_parcial || !g.vuelo_id) return 0;
  if (!g.categoria || CATS_SIN_TUA_EMBEBIDO.has(g.categoria)) return 0;
  const monto = Number(g.monto);
  if (!(monto > 0)) return 0;
  const base = Math.round((monto - (Number(g.propina) || 0)) * 100) / 100;
  if (base <= 0) return 0;
  const ia = g.valor_ia_extraido as
    | { conceptos?: Array<{ concepto?: string; monto?: number }> | null }
    | null
    | undefined;
  const conceptos = Array.isArray(ia?.conceptos) ? ia.conceptos : [];
  if (conceptos.length === 0) return 0;
  const partes = desgloseGastoPartes(
    conceptos as Parameters<typeof desgloseGastoPartes>[0],
    base,
  );
  if (!partes || !(partes.tua > 0)) return 0;
  return Math.min(partes.tua, monto);
}
