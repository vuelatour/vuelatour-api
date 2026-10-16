/**
 * Desglose de una factura de gasto a partir de los renglones que leyó la IA.
 * FUENTE ÚNICA de la regla: la usan la creación de gastos (notas), el
 * enriquecimiento IA del sync offline y la vista previa del panel — no
 * duplicar este cálculo en ningún otro lado.
 *
 * REGLA DEL CLIENTE (facturas de aeródromo): FBO, TUA y —desde el
 * 1-oct-2026— la EXTENSIÓN Y/O ANTELACIÓN DE HORARIO se separan CON su IVA
 * incluido y todo lo demás se agrupa como "Operación" = total − separados.
 * Dos formas de factura:
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
 * Sin renglones FBO/TUA/extensión reconocibles, se listan tal cual.
 *
 * TUA SISTÉMICA — UNA PRIORIDAD (13-oct-2026, invariante 66 del CLAUDE.md
 * del API; caso #383, gasto 8c60e428: la IA leyó corrida la tabla resumen de
 * ASUR y llamó «Autobuses» a la Tarifa TUA de $559.63 — nada se separó y la
 * fila del vuelo cargó la TUA como OPERACIONES). La TUA de un gasto (IVA
 * incluido, moneda del gasto, base = monto − propina) sale de, en orden:
 *  1) `gasto.tua_incluida` (la fija la OFICINA en «Verificar / editar»;
 *     migración 20261013000008): 0 = esta factura no cobra TUA; > 0 = esa
 *     TUA aunque los renglones de la IA no cuadren (FBO y extensión de la
 *     lectura se recortan al resto: la TUA manda);
 *  2) el renglón de la IA reconocido como TUA (`esTua` / `CLAVES_TUA`);
 *  3) `valor_ia_extraido.tua_monto` (la TUA que la IA leyó APARTE, ya con
 *     IVA) SOLO si ningún renglón es TUA y la tabla CUADRA (formas a/b). Sin
 *     renglones válidos o con una tabla que no suma ⇒ nada: pyservices vacía
 *     la tabla que no suma (`validar_suma_conceptos`) y separar ahí sería
 *     reparar una lectura rota (regla del 26-ago, caso #118).
 * Sin ninguna de esas señales el resultado es byte-idéntico al de siempre.
 */
import { categoriaEsDeEmpresa } from './categoria-gasto.util';

/**
 * Claves de concepto que algunos aeropuertos imprimen EN VEZ del nombre del
 * servicio (renglones "Servicio (clave NNNNNN)"). Verificadas contra
 * facturas reales capturadas en el sistema:
 * - 230700 = TUA en Aeropuerto de Cozumel (ticket jul-2026: neto $1,484.44
 *   × 1.16 = $1,721.95, cuadra exacto con la separación manual de oficina).
 * - 130700 = TUA NACIONAL en Aeropuerto de Cozumel (factura FEACZM 72139,
 *   21-sep-2026, vuelo #305 XB-PEV: 2 × $374.31 − descuento $6.40 = neto
 *   $742.22 × 1.16 = $860.98; la oficina: «ese es el TUA, no forma parte de
 *   la operación»). La IA imprime «Servicio (clave 130700)» porque la
 *   factura no trae el nombre del concepto legible.
 * NO son TUA (operación del avión, verificado en prod 6-oct-2026): 210100
 * aterrizaje, 210200 plataforma de embarque/desembarque, 210300 plataforma
 * de pernocta.
 * Al confirmar claves nuevas de otros aeropuertos, agregarlas aquí (única
 * fuente de la regla).
 */
const CLAVES_TUA = ['130700', '230700'];

// FBO / FOB (así lo imprime ASUR en la tabla resumen).
const esFbo = (c: string) => /\bf(?:bo|ob)\b/i.test(c);
// TUA / T.U.A. / TUAS / "Uso de Aeropuerto" con límites de palabra (no
// matchear "actual"), o renglón "Servicio (clave NNNNNN)" con clave TUA
// conocida del catálogo de arriba.
const esTua = (c: string) =>
  /\bt\.?\s?u\.?\s?a\.?s?\b/i.test(c) ||
  /uso\s+de\s+aeropuerto/i.test(c) ||
  CLAVES_TUA.some((clave) => new RegExp(`\\b${clave}\\b`).test(c));

/**
 * EXTENSIÓN Y/O ANTELACIÓN DE HORARIO de un aeropuerto (1-oct-2026, pedido de
 * Ale con el balance XA-VGV/N4142R: «en este vuelo me se está poniendo la
 * extensión de servicios como Operación y no va en ese apartado»). Es un
 * TRASLADO al cliente, como el TUA: la cotización la cobra como EXTRA
 * («Extensión de servicios», ingreso de VuelaTour) y lo pagado NO es costo de
 * operar el avión. Textos REALES que reconoce: «AE-Extension y/o antelacion
 * de horario» (GAFSACOMM, #192), «Extensión y/o antelación de horario»
 * (Chetumal, #190), «extensión de servicio inspector …» (#314), «Extensión
 * de servicios» (línea del cotizador). Una palabra suelta («Extensión») NO
 * basta: exige «de horario» / «de servicio(s)» o la clave «AE-Extension».
 * Un renglón que además es FBO o TUA NO es extensión (gana el FBO / el TUA).
 */
const RE_EXTENSION =
  /extensi[oó]n\s*(y\/o\s*)?(antelaci[oó]n\s*)?(de\s*)?(horario|servicios?)|antelaci[oó]n\s*(de\s*)?horario|\bAE-?\s*extensi/i;
export const esExtension = (c: string | null | undefined): boolean =>
  RE_EXTENSION.test(String(c ?? ''));

/**
 * Concepto del EGRESO de la extensión de horario pagada (1-oct-2026): el par
 * de «tuas pagadas» en «Otros movimientos» del Balance general y en «otros
 * ingresos» del Libro Dinero — el MISMO texto en los dos libros.
 */
export const CONCEPTO_EXTENSION_PAGADA = 'extensión de horario pagada';

export interface DesglosePartes {
  operacion: number;
  tua: number;
  fbo: number;
  /** Extensión y/o antelación de horario CON su IVA (traslado al cliente). */
  extension: number;
}

/** Señales extra del desglose (13-oct-2026, TUA sistémica). */
export interface OpcionesDesglose {
  /**
   * `valor_ia_extraido.tua_monto`: TUA CON IVA que la IA leyó APARTE de los
   * renglones (13-oct-2026). Solo se usa si ningún renglón es TUA y la tabla
   * cuadra; jamás se multiplica por 1.16.
   */
  tuaMonto?: number | null;
}

/**
 * Partes NUMÉRICAS de la separación (la MISMA regla que las líneas de
 * texto): TUA, FBO y extensión de horario con su IVA incluido, Operación =
 * total − separados. `null` cuando la factura no trae renglones TUA/FBO/
 * extensión reconocibles o los montos no cuadran — el caller trata el gasto
 * como un solo monto.
 *
 * La usan las notas del gasto (vía desgloseGastoLineas) y el Balance por
 * avión: el TUA es un TRASLADO al pasajero, no costo de operar el avión —
 * regla del libro manual del cliente (17-ago-2026) — y la extensión de
 * horario también (1-oct-2026).
 *
 * `opciones.tuaMonto` (13-oct-2026, TUA sistémica): la TUA CON IVA que la IA
 * leyó APARTE. Solo entra si NINGÚN renglón es TUA, 0 < tua_monto ≤ total
 * (+0.05) y la tabla CUADRA por las formas a/b de siempre; se usa tal cual
 * (ya trae IVA: jamás × 1.16). Sin `opciones` el resultado es byte-idéntico.
 */
export function desgloseGastoPartes(
  conceptos: Array<{ concepto: string; monto: number }>,
  total: number,
  opciones?: OpcionesDesglose,
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
  // Extensión de horario: nunca un renglón que ya es FBO o TUA.
  const extension = limpios
    .filter(
      (c) =>
        esExtension(c.concepto) && !esFbo(c.concepto) && !esTua(c.concepto),
    )
    .reduce((a, c) => a + c.monto, 0);
  // Señal `tua_monto` (13-oct-2026, caso #383: la IA llamó «Autobuses» a la
  // Tarifa TUA de la tabla resumen de ASUR). SOLO sin renglón TUA reconocido
  // (el renglón manda) y nunca mayor que el total: ya trae IVA.
  const senal = Number(opciones?.tuaMonto);
  const tuaSenal =
    tua === 0 &&
    Number.isFinite(senal) &&
    senal > 0 &&
    senal <= r2(total) + 0.05
      ? Math.min(r2(senal), r2(total))
      : 0;
  // Coherencia: si la separación deja Operación NEGATIVA (monto del gasto
  // editado tras la captura IA, pago parcial, moneda distinta), las partes NO
  // cuadran y se descartan — restar un TUA mayor que el gasto a la columna
  // del balance sería peor que no separar.
  const armar = (
    tuaConIva: number,
    fboConIva: number,
    extConIva: number,
  ): DesglosePartes | null => {
    const operacion = r2(total - tuaConIva - fboConIva - extConIva);
    if (operacion >= 0)
      return {
        operacion,
        tua: tuaConIva,
        fbo: fboConIva,
        extension: extConIva,
      };
    // Centavos del IVA por renglón (forma a: r2(neto × 1.16) por parte vs el
    // IVA impreso sobre la suma): una factura SIN operación —TUA + extensión,
    // p. ej.— puede quedar 1-5 ¢ «negativa». SOLO cuando hay extensión, esos
    // centavos los absorbe la extensión (las partes suman el total exacto);
    // sin extensión la regla es la de siempre (null), byte-idéntica.
    if (extConIva > 0 && operacion >= -0.05 && extConIva + operacion > 0)
      return {
        operacion: 0,
        tua: tuaConIva,
        fbo: fboConIva,
        extension: r2(extConIva + operacion),
      };
    return null;
  };
  if ((fbo > 0 || tua > 0 || extension > 0 || tuaSenal > 0) && total > 0) {
    // (a) Netos + IVA aparte → separar con IVA (neto × 1.16), PERO solo si
    // la lectura IA es COHERENTE: los netos × 1.16 deben sumar el total
    // (tolerancia $1). Caso real 26-ago (gasto 45007a9c): la IA leyó un TUA
    // $25 arriba y la separación mandaba ~$30 a la hoja equivocada — mejor
    // no separar que separar con números que no cuadran (mismo criterio
    // conservador que la forma b). La señal `tua_monto` YA trae IVA.
    if (hayIva) {
      const netos = r2(
        limpios
          .filter((c) => !/\biva\b/i.test(c.concepto))
          .reduce((a, c) => a + c.monto, 0),
      );
      if (Math.abs(r2(netos * 1.16) - r2(total)) > 1) return null;
      return armar(
        tuaSenal > 0 ? tuaSenal : r2(tua * 1.16),
        r2(fbo * 1.16),
        r2(extension * 1.16),
      );
    }
    // (b) Tabla resumen: montos YA con IVA que suman el total → tal cual.
    const suma = r2(limpios.reduce((a, c) => a + c.monto, 0));
    if (Math.abs(suma - r2(total)) <= 0.05)
      return armar(tuaSenal > 0 ? tuaSenal : r2(tua), r2(fbo), r2(extension));
  }
  return null;
}

export function desgloseGastoLineas(
  conceptos: Array<{ concepto: string; monto: number }>,
  total: number,
  moneda: string,
  opciones?: OpcionesDesglose,
): string[] {
  const partes = desgloseGastoPartes(conceptos, total, opciones);
  if (partes) {
    const lineas = [`Operación - $${partes.operacion.toFixed(2)} ${moneda}`];
    if (partes.tua > 0)
      lineas.push(`TUA (IVA incluido) - $${partes.tua.toFixed(2)} ${moneda}`);
    if (partes.fbo > 0)
      lineas.push(`FBO (IVA incluido) - $${partes.fbo.toFixed(2)} ${moneda}`);
    if (partes.extension > 0)
      lineas.push(
        `Extensión de horario (IVA incluido) - $${partes.extension.toFixed(2)} ${moneda}`,
      );
    return lineas;
  }
  return conceptos.map(
    (c) => `${c.concepto} - $${c.monto.toFixed(2)} ${moneda}`,
  );
}

/**
 * Categorías donde JAMÁS se separa un TUA embebido (regla 7, 28-ago-2026)
 * NI una extensión de horario embebida (1-oct-2026): GAS/PERMISO/INDIRECTO
 * tienen hoja propia, TUAS es el TUA entero (no embebido) y las categorías
 * del piloto no traen factura de aeródromo. FUENTE ÚNICA: la usan el Balance
 * por avión (fila del vuelo y pestaña Otros movimientos), el reparto a socios
 * y el Libro Dinero.
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
  // COMISION_VENDEDOR (28-sep-2026) y COMISION_VENDEDOR_AVION (13-oct-2026,
  // invariante 61): el pago al vendedor jamás trae una factura de aeródromo
  // con TUA ni extensión embebidas (cubre balance, reparto, Libro Dinero y
  // «otros movimientos»; sin esto `trasladosEmbebidosDeGasto` podría sacar
  // unas «tuas pagadas» del desglose IA de la comisión). Se usa en JS, nunca
  // en un query.
  'COMISION_VENDEDOR',
  'COMISION_VENDEDOR_AVION',
  // COMISARIATO (13-oct-2026, invariante 63): ticket de súper/OXXO/comedor,
  // jamás factura de aeródromo con TUA/FBO/extensión embebidos. Además
  // garantiza la columna: `separarPartes` del balance devuelve null para
  // esta categoría y la fila cae ENTERA en OTROS aunque la IA traiga
  // conceptos (gasto 83da7c99: «Mafer surtido salado 120g $53 · Cristal agua
  // 600ml $22…»). Cubre balance, reparto y Libro Dinero por la fuente única
  // `trasladosEmbebidosDeGasto`. Se usa en JS, nunca en un query.
  'COMISARIATO',
]);

export interface GastoParaTuaEmbebido {
  vuelo_id?: string | null;
  categoria?: string | null;
  monto?: string | number | null;
  propina?: string | number | null;
  valor_ia_extraido?: unknown;
  es_reparto_parcial?: boolean;
  /** Notas del gasto: SOLO para el respaldo por texto de la extensión
   *  (`extensionPorNotas`). Sin ellas el respaldo no aplica. */
  notas?: string | null;
  /**
   * `gasto.tua_incluida` (13-oct-2026, migración 20261013000008): la TUA
   * (IVA incluido, moneda del gasto) que fijó la OFICINA. null/ausente =
   * manda la lectura de la IA; 0 = sin TUA; > 0 = esa TUA. PostgREST manda
   * `numeric` como string.
   */
  tua_incluida?: string | number | null;
}

/**
 * Categorías donde la OFICINA puede fijar la TUA incluida de un gasto
 * (13-oct-2026): las facturas de aeropuerto. Subconjunto de las categorías
 * donde `trasladosEmbebidosDeGasto` separa (ninguna está en
 * `CATS_SIN_TUA_EMBEBIDO` ni es de EMPRESA; COMISARIATO, invariante 63,
 * queda fuera sin tocar nada). En prod (13-oct) solo OPERACIONES trae
 * renglones TUA (32 gastos). El panel la COPIA con test de paridad.
 */
export const CATEGORIAS_TUA_INCLUIDA: readonly string[] = Object.freeze([
  'OPERACIONES',
  'ATERRIZAJE',
  'FBO',
]);

/** ¿La categoría admite «TUA incluida en este gasto»? */
export function categoriaAdmiteTuaIncluida(
  cat: string | null | undefined,
): boolean {
  return !!cat && CATEGORIAS_TUA_INCLUIDA.includes(cat);
}

/** Sufijo de la nota del balance cuando la TUA la fijó la oficina. */
export const SUFIJO_TUA_FIJADA_OFICINA = ' (fijada por oficina)';

/** Nota del balance cuando la oficina fijó «sin TUA» y la IA sí la separaba. */
export const NOTA_TUA_CERO_OFICINA = 'TUA: 0 (fijada por oficina)';

/**
 * `valor_ia_extraido.tua_monto` del gasto (TUA CON IVA leída aparte por la
 * IA, 13-oct-2026): número finito > 0 ⇒ a centavos; cualquier otra cosa
 * (ausente, null, 0, negativo, texto) ⇒ null.
 */
export function tuaMontoDeIa(valorIa: unknown): number | null {
  if (!valorIa || typeof valorIa !== 'object') return null;
  const v = (valorIa as { tua_monto?: unknown }).tua_monto;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? r2(n) : null;
}

/**
 * `gasto.tua_incluida` normalizada (13-oct-2026): null / ausente / '' / no
 * numérico / negativo ⇒ null («manda la IA»); si no, a centavos (0 = «sin
 * TUA»). PostgREST manda `numeric` como string.
 */
export function tuaIncluidaDe(g: {
  tua_incluida?: string | number | null;
}): number | null {
  const v = g?.tua_incluida;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return r2(n);
}

/**
 * Categorías donde, SIN conceptos IA, las NOTAS deciden que el gasto entero
 * es una extensión de horario (respaldo por TEXTO, 1-oct-2026). Solo las de
 * la factura de aeródromo: es donde la oficina/piloto captura «extensión de
 * servicio …» a mano (caso #314: OPERACIONES $500 «extensión de servicio
 * inspector Baraona $500 efectivo», sin IA).
 */
export const CATS_EXTENSION_POR_NOTAS: ReadonlySet<string> = new Set([
  'OPERACIONES',
  'ATERRIZAJE',
]);

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Renglones IA del gasto, normalizados (los mismos filtros del desglose). */
function conceptosIaDe(
  valorIa: unknown,
): Array<{ concepto: string; monto: number }> {
  // Mismo tipo que el jsonb que escribe la IA (los montos pueden llegar
  // como texto: `Number` los normaliza abajo).
  const ia = valorIa as
    | { conceptos?: Array<{ concepto?: string; monto?: number }> | null }
    | null
    | undefined;
  const crudos = Array.isArray(ia?.conceptos) ? ia.conceptos : [];
  return crudos
    .map((c) => ({
      concepto: String(c?.concepto ?? ''),
      monto: Number(c?.monto),
    }))
    .filter((c) => c.concepto && Number.isFinite(c.monto) && c.monto > 0);
}

/**
 * RESPALDO POR TEXTO (1-oct-2026): un gasto SIN conceptos IA (nulos, `[]` o
 * sin renglones válidos) de categoría OPERACIONES/ATERRIZAJE cuya PRIMERA
 * línea de notas —la descripción que se capturó; lo que se anexa después
 * (desglose, sellos de corrección) va en líneas siguientes— cumple
 * `esExtension` se toma COMPLETO como extensión de horario. Es una regla de
 * TEXTO, no de factura: «extensión de servicio inspector Baraona $500
 * efectivo» (#314) o «2 horas extension servicio PEV 25 agosto» (#190). Con
 * conceptos IA manda SIEMPRE la factura (si no cuadra ⇒ no se separa nada).
 *
 * CONSERVADOR (revisión del 1-oct-2026): una nota que NIEGA la extensión
 * («sin extensión de horario», «no hubo extensión de servicio») o que la
 * MEZCLA con otro servicio del aeródromo («Aterrizaje y extensión de
 * horario», «TUA + extensión de servicio», plataforma, pernocta,
 * combustible…) NO se toma como extensión completa: sin la factura no hay
 * cómo separar las partes y mandar el aterrizaje a «traslado» sacaría costo
 * real del avión. Esos gastos se quedan como siempre (un solo monto en su
 * columna) hasta que traigan conceptos IA.
 */
const RE_NIEGA_EXTENSION = /\b(?:sin|no)\b[^.·,;:\n]{0,25}extensi/i;
const RE_OTRO_SERVICIO_AERODROMO =
  /aterriza|plataforma|pernocta|estacionamiento|embarque|combustible|turbosina|avgas|gasavi[oó]n/i;
export function extensionPorNotas(g: {
  categoria?: string | null;
  notas?: string | null;
  valor_ia_extraido?: unknown;
}): boolean {
  if (!g.categoria || !CATS_EXTENSION_POR_NOTAS.has(g.categoria)) return false;
  if (conceptosIaDe(g.valor_ia_extraido).length > 0) return false;
  const primera = String(g.notas ?? '').split('\n')[0];
  if (!esExtension(primera)) return false;
  if (RE_NIEGA_EXTENSION.test(primera)) return false;
  if (
    RE_OTRO_SERVICIO_AERODROMO.test(primera) ||
    esTua(primera) ||
    esFbo(primera)
  )
    return false;
  return true;
}

/**
 * Partes de UN gasto en SU moneda sobre la base del desglose = monto −
 * propina (la propina no sale de la factura y sigue siendo costo del avión):
 * con conceptos IA, `desgloseGastoPartes` (con la señal `tua_monto` de la
 * lectura); sin ellos, el respaldo por texto (`extensionPorNotas` ⇒ toda la
 * base es extensión). `null` = no se separa nada. NO aplica exclusiones de
 * categoría/vuelo: eso lo hace cada lector (`trasladosEmbebidosDeGasto` o la
 * fila del vuelo del Balance).
 *
 * PRIORIDAD ÚNICA DE LA TUA (13-oct-2026, invariante 66): `tua_incluida` de
 * la OFICINA manda sobre la lectura — 0 = sin TUA (esa parte vuelve a
 * Operación; FBO y extensión de la lectura se conservan) y > 0 = esa TUA,
 * topada a la base, aunque los renglones de la IA no cuadren (caso #118);
 * FBO y extensión de la lectura se recortan al resto (la TUA manda). Con 0
 * y sin lectura que separe ⇒ null (nada que separar). Orden deliberado:
 * conceptos → respaldo por notas → nada (un `tua_monto` sin renglones NO
 * separa: pyservices vacía la tabla que no suma).
 */
export function partesDeGasto(g: {
  categoria?: string | null;
  monto?: string | number | null;
  propina?: string | number | null;
  valor_ia_extraido?: unknown;
  notas?: string | null;
  tua_incluida?: string | number | null;
}): DesglosePartes | null {
  const monto = Number(g.monto);
  if (!(monto > 0)) return null;
  const base = r2(monto - (Number(g.propina) || 0));
  if (base <= 0) return null;
  const conceptos = conceptosIaDe(g.valor_ia_extraido);
  const partesIa: DesglosePartes | null =
    conceptos.length > 0
      ? desgloseGastoPartes(conceptos, base, {
          tuaMonto: tuaMontoDeIa(g.valor_ia_extraido),
        })
      : extensionPorNotas(g)
        ? { operacion: 0, tua: 0, fbo: 0, extension: base }
        : null;
  const fija = tuaIncluidaDe(g);
  if (fija === null) return partesIa;
  if (fija === 0 && !partesIa) return null;
  const tua = Math.min(fija, base);
  const resto = r2(base - tua);
  const fbo = Math.min(partesIa?.fbo ?? 0, resto);
  const extension = Math.min(partesIa?.extension ?? 0, r2(resto - fbo));
  return {
    operacion: r2(base - tua - fbo - extension),
    tua,
    fbo,
    extension,
  };
}

/**
 * TUA que separa la LECTURA de la IA (renglón TUA o `tua_monto`), ignorando
 * lo que fijó la oficina (13-oct-2026): lo que el panel enseña como «La IA
 * detectó una TUA de $X». null si la lectura no separa TUA.
 */
export function tuaDetectadaIa(
  g: Parameters<typeof partesDeGasto>[0],
): number | null {
  const tua = partesDeGasto({ ...g, tua_incluida: null })?.tua ?? 0;
  return tua > 0 ? tua : null;
}

/** ¿La oficina fijó «sin TUA» (0) y la lectura de la IA sí la separaba? */
export function tuaAnuladaPorOficina(
  g: Parameters<typeof partesDeGasto>[0],
): boolean {
  return tuaIncluidaDe(g) === 0 && (tuaDetectadaIa(g) ?? 0) > 0;
}

/**
 * TRASLADOS EMBEBIDOS en una factura de aeródromo/handling, en la MONEDA del
 * gasto: la parte TUA (regla 7, 28-ago-2026) y la parte EXTENSIÓN DE
 * HORARIO (1-oct-2026), cada una con su IVA; `{0, 0}` si no hay nada que
 * separar. Ninguna de las dos es costo del avión: su egreso vive en Otros
 * movimientos del Balance general («tuas pagadas» / «extensión de horario
 * pagada»), en «otros ingresos» del Libro Dinero y se descuenta del costo en
 * el reparto a socios. Solo gastos CON vuelo; los parciales del reparto
 * manual quedan fuera (sus renglones IA son de la factura completa y no
 * cuadran con el parcial), igual que `CATS_SIN_TUA_EMBEBIDO` y las
 * categorías de EMPRESA (viajan ENTERAS a «otros gastos»: separar aquí
 * restaría dos veces — los lectores ya las saltaban; aquí es el cinturón).
 * Topes: TUA ≤ monto y extensión ≤ monto − TUA.
 */
export function trasladosEmbebidosDeGasto(g: GastoParaTuaEmbebido): {
  tua: number;
  extension: number;
} {
  const cero = { tua: 0, extension: 0 };
  if (g.es_reparto_parcial || !g.vuelo_id) return cero;
  if (
    !g.categoria ||
    CATS_SIN_TUA_EMBEBIDO.has(g.categoria) ||
    categoriaEsDeEmpresa(g.categoria)
  )
    return cero;
  const monto = Number(g.monto);
  if (!(monto > 0)) return cero;
  const partes = partesDeGasto(g);
  if (!partes) return cero;
  const tua = partes.tua > 0 ? Math.min(partes.tua, monto) : 0;
  const resto = r2(monto - tua);
  const extension =
    partes.extension > 0 && resto > 0 ? Math.min(partes.extension, resto) : 0;
  return { tua, extension };
}

/**
 * Parte TUA EMBEBIDA (con su IVA) de una factura de aeródromo/handling, en la
 * MONEDA del gasto; 0 si no hay nada que separar. Regla 7 (28-ago-2026): el
 * TUA es un traslado al pasajero, no costo del avión — su egreso vive en
 * Otros movimientos del Balance general. Base del desglose = monto − propina
 * (la propina no sale de la factura pero SÍ sigue siendo costo del avión).
 * Solo gastos CON vuelo; los parciales del reparto manual quedan fuera (sus
 * renglones IA son de la factura completa y no cuadran con el parcial).
 * Firma conservada: es `trasladosEmbebidosDeGasto(g).tua`.
 */
export function tuaEmbebidoDeGasto(g: GastoParaTuaEmbebido): number {
  return trasladosEmbebidosDeGasto(g).tua;
}

/**
 * TRASLADOS PAGADOS por UN gasto del vuelo, en SU moneda (13-oct-2026,
 * FUENTE ÚNICA de las «tuas pagadas» de «Otros movimientos», del Libro
 * Dinero y del pre-cierre `tua_pagada_sin_cobrar` (hasta el 15-oct-2026,
 * `tua_cobrada_sin_pagada`)): categoría de EMPRESA ⇒
 * nada (viaja entera a «otros gastos»); `TUAS` ⇒ el gasto ENTERO es TUA; el
 * resto ⇒ la parte embebida (`trasladosEmbebidosDeGasto`, con la TUA de la
 * oficina). Sustituye el ternario `categoria === 'TUAS' ? … :
 * trasladosEmbebidosDeGasto(…)` que repetía cada lector: prohibido volver a
 * escribirlo.
 */
export function trasladosPagadosDeGasto(g: GastoParaTuaEmbebido): {
  tua: number;
  extension: number;
} {
  if (categoriaEsDeEmpresa(g.categoria)) return { tua: 0, extension: 0 };
  if (g.categoria === 'TUAS') {
    const monto = Number(g.monto);
    return {
      tua: Number.isFinite(monto) && monto > 0 ? monto : 0,
      extension: 0,
    };
  }
  return trasladosEmbebidosDeGasto(g);
}

/** TUA pagada por UN gasto (en su moneda): `trasladosPagadosDeGasto(g).tua`. */
export const tuaPagadaDeGasto = (g: GastoParaTuaEmbebido): number =>
  trasladosPagadosDeGasto(g).tua;
