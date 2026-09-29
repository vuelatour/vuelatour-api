/**
 * FUENTE ÚNICA del AUTO-CRUCE banco ↔ gasto (15-sep-2026).
 *
 * Todo lo de este archivo es PURO (sin BD, sin fechas del sistema, sin red):
 * la decisión «¿este cargo del banco es ESE gasto?» se toma aquí y se prueba
 * con specs. El servicio solo trae los datos y aplica la decisión.
 *
 * PRINCIPIO RECTOR (fiabilidad = requisito #1 del proyecto): el auto-cruce
 * liga SOLO cuando NO hay ambigüedad. Dos gastos que caben en el mismo cargo
 * y ningún desempate DURO ⇒ el movimiento queda pendiente con motivo
 * `AMBIGUO` y lo resuelve un humano (o la IA, que propone pero nunca liga).
 * Jamás se liga «por parecerse».
 *
 * Desempates, en orden (el primero que deja UN solo candidato gana):
 *  1. MONTO — banda de centavos (±0.01): un solo candidato ⇒ se liga.
 *  2. TARJETA — los últimos 4 dígitos de `referencia` (el estado de cuenta
 *     de Scotiabank los trae al final: '0025830577' ⇒ 0577) contra
 *     `gasto.tarjeta_terminacion`. Evidencia DURA: solo cuenta si la
 *     referencia es LARGA (≥8 dígitos, como los 10 de Scotiabank) y esos 4
 *     dígitos son una terminación REAL del catálogo `tarjeta_corporativa`
 *     (un número de autorización de 6 dígitos como '174465' jamás inventa
 *     tarjeta, ni aunque termine como una: en prod, 186/186 referencias de
 *     10 dígitos terminan en tarjeta y 0/126 de 6 dígitos).
 *  3. DESCRIPCIÓN — la leyenda del banco («AEROPUERTO DE COZUMEL») contra
 *     `gasto.lugar` / primera línea de `gasto.notas` / proveedor, con tabla
 *     de sinónimos del giro. Exige ≥2 tokens compartidos, puntaje mínimo y
 *     MARGEN sobre el segundo lugar: un solo token en común nunca gana.
 */

/** Tolerancia de centavos entre el cargo del banco y el monto del gasto. */
export const TOLERANCIA_CENTAVOS = 0.01;

/** Puntaje mínimo (0..1) para que la descripción pueda desempatar. */
export const PUNTAJE_MINIMO_DESCRIPCION = 0.6;

/** Ventaja mínima del ganador sobre el segundo lugar (0..1). */
export const MARGEN_MINIMO_DESCRIPCION = 0.2;

/**
 * Traspasos internos: ABONOS/CARGOS que NUNCA tendrán gasto ni cobro detrás
 * (el dinero solo cambió de cuenta). Sin esta regla quedan pendientes para
 * siempre e inflan el «faltan N por conciliar» del cierre.
 */
export const PATRONES_TRASPASO = [
  'TRASPASO ENTRE CUENTAS',
  'SEL TRASPASO',
  'TRASPASO A CUENTA PROPIA',
  'TRASPASO CTA PROPIA',
  'TRASPASO ENTRE CTAS',
] as const;

/** Nombre canónico de la clasificación que reciben los traspasos. */
export const CLASIFICACION_TRASPASO = 'Traspaso entre cuentas';

/** Prefijos de agregador/terminal que no dicen NADA del comercio. */
const PREFIJOS_AGREGADOR = [
  'MERPAGO',
  'MERCADOPAGO',
  'PINPE',
  'CLIP',
  'SR PAGO',
  'SRPAGO',
  'TPV',
  'SEL',
  'EC',
  'ES',
  'PAY',
  'SPEI',
];

/** Palabras que aparecen en cualquier línea y no identifican nada. */
const VACIAS = new Set([
  'DE',
  'DEL',
  'LA',
  'EL',
  'LOS',
  'LAS',
  'Y',
  'EN',
  'A',
  'AL',
  'POR',
  'CON',
  'SA',
  'CV',
  'SAPI',
  'SRL',
  'RL',
  'SC',
  'PAGO',
  'COMPRA',
  'CARGO',
  'ABONO',
  'TARJETA',
  'REF',
  'REFERENCIA',
  'MXN',
  'USD',
  'IVA',
  'TOTAL',
  'FACTURA',
  'TICKET',
  'MEXICO',
  'MEX',
]);

/**
 * Sinónimos del giro: la leyenda del banco y la captura del piloto nunca se
 * escriben igual. Cada token se EXPANDE con estos equivalentes en AMBOS
 * lados (banco y gasto), así «ASUR CANCUN» y «Aeropuerto de Cancún» se
 * encuentran. Ampliar aquí, nunca en el service.
 */
const SINONIMOS: Record<string, string[]> = {
  // ASUR opera Cancún, Cozumel y Mérida: la ciudad va SIEMPRE en la línea
  // del banco («ASUR MERIDA»), así que el grupo no implica ninguna.
  ASUR: ['AEROPUERTO'],
  AICM: ['AEROPUERTO'],
  AI: ['AEROPUERTO'],
  AEROPUERTO: ['AEROPUERTO'],
  AERO: ['AEROPUERTO'],
  ASA: ['COMBUSTIBLE', 'GASAVION', 'TURBOSINA', 'AVGAS'],
  GAFSACOMM: ['COMBUSTIBLE', 'TURBOSINA'],
  GASOL: ['COMBUSTIBLE', 'GASAVION', 'AVGAS'],
  GASOLINA: ['COMBUSTIBLE'],
  GAS: ['COMBUSTIBLE'],
  TURBOSINA: ['COMBUSTIBLE'],
  GASAVION: ['COMBUSTIBLE', 'AVGAS'],
  AVGAS: ['COMBUSTIBLE', 'GASAVION'],
  JETA1: ['COMBUSTIBLE', 'TURBOSINA'],
  FBO: ['AEROPUERTO'],
  TUA: ['AEROPUERTO', 'TUAS'],
  TUAS: ['AEROPUERTO', 'TUA'],
  ATERRIZAJE: ['AEROPUERTO'],
  PLATAFORMA: ['AEROPUERTO'],
  HANGAR: ['AEROPUERTO'],
  AFAC: ['AERONAUTICA', 'DERECHOS'],
  GOB: ['GOBIERNO', 'DERECHOS'],
  GOBIERNO: ['DERECHOS'],
  QROO: ['QUINTANA', 'ROO'],
  REST: ['RESTAURANTE', 'COMIDA', 'ALIMENTOS'],
  RESTAURANTE: ['COMIDA', 'ALIMENTOS'],
  TACO: ['COMIDA', 'ALIMENTOS', 'RESTAURANTE'],
  TACOS: ['COMIDA', 'ALIMENTOS', 'RESTAURANTE'],
  COMIDA: ['ALIMENTOS'],
  ALIMENTOS: ['COMIDA'],
  HOTEL: ['HOSPEDAJE', 'PERNOCTA'],
  HOSPEDAJE: ['HOTEL', 'PERNOCTA'],
  CUN: ['CANCUN', 'AEROPUERTO'],
  CANCUN: ['CUN'],
  CZM: ['COZUMEL', 'AEROPUERTO'],
  COZUMEL: ['CZM'],
  MID: ['MERIDA', 'AEROPUERTO'],
  MERIDA: ['MID'],
  CTM: ['CHETUMAL', 'AEROPUERTO'],
  CHETUMAL: ['CTM'],
  CME: ['CARMEN', 'AEROPUERTO'],
  CARMEN: ['CME'],
  MTT: ['MINATITLAN', 'AEROPUERTO'],
  MINATITLAN: ['MTT'],
  SAESA: ['VIP', 'PISTA'],
  VIP: ['SAESA', 'PISTA'],
};

/** Quita acentos y deja MAYÚSCULAS con espacios simples (sin quitar dígitos). */
export function normalizarPlano(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Texto del banco listo para comparar: normalizado y SIN los prefijos de
 * agregador/terminal («MERPAGO*AGREGADOR» ⇒ «AGREGADOR»).
 */
export function normalizarTextoBanco(s: string | null | undefined): string {
  let t = normalizarPlano(s);
  if (!t) return '';
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const p of PREFIJOS_AGREGADOR) {
      if (t === p) return '';
      if (t.startsWith(`${p} `)) {
        t = t.slice(p.length + 1);
        cambio = true;
      }
    }
  }
  return t;
}

/** Tokens con significado (≥3 letras, sin muletillas ni números sueltos). */
export function tokensTexto(s: string | null | undefined): string[] {
  const t = normalizarTextoBanco(s);
  if (!t) return [];
  const out: string[] = [];
  for (const raw of t.split(' ')) {
    if (raw.length < 3) continue;
    if (/^\d+$/.test(raw)) continue;
    if (VACIAS.has(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * Ciudades/aeropuertos que opera la flota. Si la leyenda del banco nombra
 * UNA y el gasto nombra OTRA, no son el mismo pago por mucho que compartan
 * el giro: «ASA MERIDA» jamás es la carga de «ASA Cancún».
 */
const CIUDADES = new Set([
  'CANCUN',
  'CUN',
  'COZUMEL',
  'CZM',
  'MERIDA',
  'MID',
  'CHETUMAL',
  'CTM',
  'CARMEN',
  'CME',
  'MINATITLAN',
  'MTT',
]);

/** Ciudades nombradas en un conjunto de tokens ya expandido. */
function ciudadesDe(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (CIUDADES.has(t)) out.add(t);
  return out;
}

/** Tokens + sus sinónimos del giro (se expanden los DOS lados por igual). */
export function expandirTokens(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    for (const s of SINONIMOS[t] ?? []) out.add(s);
  }
  return out;
}

/** Primera línea de un texto libre (la que describe el gasto). */
export function primeraLinea(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

/** Datos del gasto que se comparan contra la leyenda del banco. */
export interface TextoDelGasto {
  lugar?: string | null;
  /** `gasto.notas` completas: solo se usa la PRIMERA línea. */
  notas?: string | null;
  proveedor?: string | null;
}

/**
 * Parecido (0..1) entre la leyenda del banco y el gasto. Mide cuántos
 * tokens con significado comparten sobre el lado MÁS CORTO (una leyenda
 * larga del banco no castiga a un `lugar` de dos palabras), pero UN solo
 * token compartido jamás llega al umbral: «COMBUSTIBLE» lo comparten todas
 * las cargas del mes y no identifica ninguna.
 */
export function puntuarDescripcion(
  descBanco: string | null | undefined,
  gasto: TextoDelGasto,
): number {
  const banco = expandirTokens(tokensTexto(descBanco));
  const delGasto = expandirTokens([
    ...tokensTexto(gasto.lugar),
    ...tokensTexto(primeraLinea(gasto.notas)),
    ...tokensTexto(gasto.proveedor),
  ]);
  if (banco.size === 0 || delGasto.size === 0) return 0;
  // VETO por ciudad: dos plazas distintas no son el mismo pago.
  const ciudadBanco = ciudadesDe(banco);
  const ciudadGasto = ciudadesDe(delGasto);
  if (ciudadBanco.size > 0 && ciudadGasto.size > 0) {
    let coincide = false;
    for (const c of ciudadBanco) if (ciudadGasto.has(c)) coincide = true;
    if (!coincide) return 0;
  }
  let comunes = 0;
  for (const t of banco) if (delGasto.has(t)) comunes += 1;
  if (comunes === 0) return 0;
  const puntaje = comunes / Math.min(banco.size, delGasto.size);
  // Un único token en común nunca alcanza PUNTAJE_MINIMO_DESCRIPCION.
  if (comunes === 1) return Math.min(puntaje, PUNTAJE_MINIMO_DESCRIPCION - 0.1);
  return Math.min(1, puntaje);
}

/** Terminación de tarjeta normalizada (4 dígitos) o null. */
export function terminacionNormalizada(
  v: string | null | undefined,
): string | null {
  if (typeof v !== 'string') return null;
  const d = v.replace(/\D/g, '');
  return d.length === 4 ? d : null;
}

/**
 * Terminación de tarjeta que trae un movimiento del banco, o null.
 *
 * Solo se acepta si la referencia tiene ≥8 dígitos Y los 4 finales coinciden
 * con una terminación REAL del catálogo (`tarjeta_corporativa.terminacion`):
 * el número de autorización de 6 dígitos del archivo del 15-sep ('174465')
 * no debe inventar una tarjeta ni por azar (perfil real de prod, 15-sep:
 * 186/186 referencias de 10 dígitos terminan en tarjeta; 0 de 6). Si el
 * movimiento apunta a DOS terminaciones distintas (referencia y
 * descripción), se devuelve null: ambiguo no desempata nada.
 */
export function terminacionDeMovimiento(
  referencia: string | null | undefined,
  descripcion: string | null | undefined,
  terminacionesValidas: Iterable<string>,
): string | null {
  const validas = new Set<string>();
  for (const t of terminacionesValidas) {
    const n = terminacionNormalizada(t);
    if (n) validas.add(n);
  }
  if (validas.size === 0) return null;

  const candidatas = new Set<string>();
  // Referencia ÍNTEGRAMENTE numérica y LARGA (Scotiabank: '0025830577' ⇒
  // 0577). Con menos de 8 dígitos es un número de autorización, no tarjeta.
  const ref = typeof referencia === 'string' ? referencia.trim() : '';
  const refDigitos = ref.replace(/[\s-]/g, '');
  if (/^\d{8,}$/.test(refDigitos)) {
    const ult = refDigitos.slice(-4);
    if (validas.has(ult)) candidatas.add(ult);
  }
  // Descripción: SOLO con marca explícita de tarjeta (*1234, XXXX1234,
  // «TERMINACION 1234»). Un número suelto en la leyenda no es una tarjeta.
  const desc = normalizarPlano(descripcion);
  const marcados = [
    ...(typeof descripcion === 'string'
      ? descripcion.matchAll(/[*x]{1,}\s?(\d{4})\b/gi)
      : []),
    ...desc.matchAll(/\bTERM(?:INACION)?\s?(\d{4})\b/g),
    ...desc.matchAll(/\bTDC\s?(\d{4})\b/g),
  ];
  for (const m of marcados) {
    const n = m[1];
    if (validas.has(n)) candidatas.add(n);
  }
  return candidatas.size === 1 ? [...candidatas][0] : null;
}

/** ¿La descripción es un traspaso interno? Devuelve el patrón que empató. */
export function patronTraspaso(
  descripcion: string | null | undefined,
): string | null {
  const t = normalizarPlano(descripcion);
  if (!t) return null;
  for (const p of PATRONES_TRASPASO) {
    if (t.includes(p)) return p;
  }
  return null;
}

/** ¿Dos montos son el mismo pago? (banda de centavos, en valor absoluto). */
export function montoCasa(
  a: number,
  b: number,
  tolerancia: number = TOLERANCIA_CENTAVOS,
): boolean {
  const x = Math.abs(Number(a) || 0);
  const y = Math.abs(Number(b) || 0);
  return Math.abs(x - y) <= tolerancia + 1e-9;
}

/** Criterio por el que se ligó (o se propuso) un cruce. */
export type CriterioCruce =
  | 'MONTO_EXACTO'
  | 'TARJETA'
  | 'DESCRIPCION'
  | 'FALTANTE'
  | 'TC_IMPLICITO'
  | 'REGLA';

/** Movimiento del banco visto por el auto-cruce (solo lo que decide). */
export interface MovimientoCruce {
  monto: number;
  descripcion?: string | null;
  referencia?: string | null;
}

/** Gasto candidato con todo lo que sirve para desempatar. */
export interface GastoCandidatoCruce extends TextoDelGasto {
  id: string;
  monto: number;
  tarjeta_terminacion?: string | null;
}

export type MotivoPendiente = 'SIN_CANDIDATOS' | 'AMBIGUO';

export interface EleccionCruce {
  /** Gasto elegido, o null si no hay uno INEQUÍVOCO. */
  gasto_id: string | null;
  criterio: CriterioCruce | null;
  motivo: MotivoPendiente | null;
  candidatos_n: number;
  /** Terminación detectada en el movimiento (auditoría del porqué). */
  terminacion: string | null;
  /** Explicación corta y literal para el detalle del job. */
  detalle: string;
}

/**
 * LA decisión del auto-cruce. Recibe los candidatos que YA cuadran en monto
 * y ventana de fechas y devuelve UNO solo o el motivo por el que no.
 */
export function elegirCandidato(
  mov: MovimientoCruce,
  candidatos: readonly GastoCandidatoCruce[],
  terminacionesValidas: Iterable<string> = [],
  opts: { criterioBase?: CriterioCruce } = {},
): EleccionCruce {
  const criterioBase = opts.criterioBase ?? 'MONTO_EXACTO';
  const n = candidatos.length;
  const terminacion = terminacionDeMovimiento(
    mov.referencia,
    mov.descripcion,
    terminacionesValidas,
  );
  if (n === 0) {
    return {
      gasto_id: null,
      criterio: null,
      motivo: 'SIN_CANDIDATOS',
      candidatos_n: 0,
      terminacion,
      detalle: 'Ningún gasto bancario sin conciliar cuadra en monto y fecha.',
    };
  }
  if (n === 1) {
    return {
      gasto_id: candidatos[0].id,
      criterio: criterioBase,
      motivo: null,
      candidatos_n: 1,
      terminacion,
      detalle: 'Candidato único por monto y fecha.',
    };
  }

  // 2) Terminación de tarjeta: evidencia DURA.
  let pool = candidatos;
  if (terminacion) {
    const porTarjeta = candidatos.filter(
      (c) => terminacionNormalizada(c.tarjeta_terminacion) === terminacion,
    );
    if (porTarjeta.length === 1) {
      return {
        gasto_id: porTarjeta[0].id,
        criterio: 'TARJETA',
        motivo: null,
        candidatos_n: n,
        terminacion,
        detalle: `${n} candidatos por monto; la tarjeta ${terminacion} deja uno solo.`,
      };
    }
    if (porTarjeta.length > 1) pool = porTarjeta;
  }

  // 3) Descripción del banco ↔ lugar/notas/proveedor del gasto.
  const puntajes = pool
    .map((c) => ({ c, p: puntuarDescripcion(mov.descripcion, c) }))
    .sort((a, b) => b.p - a.p);
  const mejor = puntajes[0];
  const segundo = puntajes[1];
  if (
    mejor &&
    mejor.p >= PUNTAJE_MINIMO_DESCRIPCION &&
    (!segundo || mejor.p - segundo.p >= MARGEN_MINIMO_DESCRIPCION)
  ) {
    return {
      gasto_id: mejor.c.id,
      criterio: 'DESCRIPCION',
      motivo: null,
      candidatos_n: n,
      terminacion,
      detalle: `${n} candidatos por monto; la descripción del banco solo empata con uno (${mejor.p.toFixed(2)}).`,
    };
  }

  return {
    gasto_id: null,
    criterio: null,
    motivo: 'AMBIGUO',
    candidatos_n: n,
    terminacion,
    detalle:
      pool.length === n
        ? `${n} gastos cuadran en monto y fecha y nada los desempata: vincúlalo a mano.`
        : `${pool.length} gastos comparten la tarjeta ${terminacion ?? ''} y nada los desempata: vincúlalo a mano.`,
  };
}

/**
 * Elige el MOVIMIENTO que corresponde a un gasto (camino inverso: el gasto
 * se capturó DESPUÉS de importar el estado de cuenta). Misma disciplina:
 * uno solo o nada.
 */
export function elegirMovimiento(
  gasto: GastoCandidatoCruce,
  movimientos: ReadonlyArray<MovimientoCruce & { id: string }>,
  terminacionesValidas: Iterable<string> = [],
): { movimiento_id: string | null; criterio: CriterioCruce | null } {
  if (movimientos.length === 0) return { movimiento_id: null, criterio: null };
  if (movimientos.length === 1) {
    return { movimiento_id: movimientos[0].id, criterio: 'MONTO_EXACTO' };
  }
  const term = terminacionNormalizada(gasto.tarjeta_terminacion);
  let pool = movimientos;
  if (term) {
    const porTarjeta = movimientos.filter(
      (m) =>
        terminacionDeMovimiento(
          m.referencia,
          m.descripcion,
          terminacionesValidas,
        ) === term,
    );
    if (porTarjeta.length === 1) {
      return { movimiento_id: porTarjeta[0].id, criterio: 'TARJETA' };
    }
    if (porTarjeta.length > 1) pool = porTarjeta;
  }
  const puntajes = pool
    .map((m) => ({ m, p: puntuarDescripcion(m.descripcion, gasto) }))
    .sort((a, b) => b.p - a.p);
  const mejor = puntajes[0];
  const segundo = puntajes[1];
  if (
    mejor &&
    mejor.p >= PUNTAJE_MINIMO_DESCRIPCION &&
    (!segundo || mejor.p - segundo.p >= MARGEN_MINIMO_DESCRIPCION)
  ) {
    return { movimiento_id: mejor.m.id, criterio: 'DESCRIPCION' };
  }
  return { movimiento_id: null, criterio: null };
}

// =======================================================================
// DEDUPE DE IMPORTACIÓN (candado de re-subida del mismo estado de cuenta)
// =======================================================================

export interface LineaDedupe {
  fecha?: string | null;
  tipo?: string | null;
  monto: number | string;
  descripcion?: string | null;
  referencia?: string | null;
}

/** Bucket del multiconjunto: mismo día, mismo tipo, mismo monto. */
export function claveBucket(m: LineaDedupe): string {
  return [m.fecha ?? '', m.tipo ?? '', (Number(m.monto) || 0).toFixed(2)].join(
    '|',
  );
}

/** Referencia normalizada para comparar (sin signos; ≥4 caracteres). */
export function refDedupe(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const n = ref.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.length >= 4 ? n : null;
}

/**
 * Largo mínimo de la leyenda CORTA para que un prefijo cuente como la misma
 * línea truncada («REST HOTEL ZOMAY HOLBO» ⊂ «REST HOTEL ZOMAY HOLBOX»).
 * Con 8, una marca sola («ASUR», «UBER», «OXXO») NUNCA es prefijo de nada:
 * es una cadena con muchas sucursales y no identifica la línea; «OXXO
 * CISNE» (10) ya trae la sucursal.
 */
export const DEDUPE_PREFIJO_MIN = 8;

/** Caracteres iniciales que, compartidos, hacen la misma leyenda. */
export const DEDUPE_INICIO_COMUN = 12;

/**
 * Leyenda del banco lista para el dedupe: sin acentos, MAYÚSCULAS, sin
 * signos, espacios simples y sin prefijos de agregador/terminal
 * («MERPAGO*UBER» y «UBER» son la misma línea; «SPEI ENVIADO BBVA…» y
 * «SPEI ENVIADO BANORTE…» ya no comparten 12 caracteres por el prefijo).
 */
export function descDedupe(d: string | null | undefined): string {
  return normalizarTextoBanco(d);
}

/** Números sueltos (≥ 3 dígitos) de la leyenda: folio, sucursal, operación. */
function numerosDedupe(d: string | null | undefined): string[] {
  return descDedupe(d)
    .split(' ')
    .filter((t) => /^\d{3,}$/.test(t));
}

/**
 * ¿Las leyendas nombran cosas DISTINTAS aunque se parezcan? Dos plazas
 * distintas («AEROPUERTO DE CANCUN» / «AEROPUERTO DE COZUMEL» comparten 12
 * caracteres; «ASUR CANCUN» / «ASUR MERIDA» con la misma tarjeta) o dos
 * números distintos («CARGO INDEBIDO 21 SEP 35554» / «… 35552»,
 * «AUTOZONE 7226» / «… 7227»). Un número truncado («355» / «35554») NO
 * cuenta como distinto, ni una leyenda que no nombra plaza ni número.
 */
export function leyendasNombranDistinto(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ca = ciudadesDe(expandirTokens(tokensTexto(a)));
  const cb = ciudadesDe(expandirTokens(tokensTexto(b)));
  if (ca.size > 0 && cb.size > 0 && ![...ca].some((c) => cb.has(c))) {
    return true;
  }
  const na = numerosDedupe(a);
  const nb = numerosDedupe(b);
  if (na.length === 0 || nb.length === 0) return false;
  return !na.some((x) => nb.some((y) => x.startsWith(y) || y.startsWith(x)));
}

/**
 * ¿Qué tan parecidas son dos leyendas para el dedupe? `0` iguales
 * (normalizadas), `1` una es prefijo de la otra (lado corto ≥
 * `DEDUPE_PREFIJO_MIN`), `2` comparten los primeros `DEDUPE_INICIO_COMUN`
 * caracteres (lado corto ≥ `DEDUPE_INICIO_COMUN`); `null` si no se parecen
 * o nombran plazas/números distintos (`leyendasNombranDistinto`). Menor =
 * señal más fuerte. Las dos vacías cuentan como iguales (comportamiento de
 * siempre para líneas sin descripción).
 */
export function nivelDescripcionDedupe(
  a: string | null | undefined,
  b: string | null | undefined,
): 0 | 1 | 2 | null {
  const x = descDedupe(a);
  const y = descDedupe(b);
  if (x === y) return 0;
  const [corta, larga] = x.length <= y.length ? [x, y] : [y, x];
  let nivel: 1 | 2 | null = null;
  if (corta.length >= DEDUPE_PREFIJO_MIN && larga.startsWith(corta)) {
    nivel = 1;
  } else if (
    corta.length >= DEDUPE_INICIO_COMUN &&
    x.slice(0, DEDUPE_INICIO_COMUN) === y.slice(0, DEDUPE_INICIO_COMUN)
  ) {
    nivel = 2;
  }
  if (nivel === null || leyendasNombranDistinto(a, b)) return null;
  return nivel;
}

/**
 * ¿Dos leyendas son la MISMA línea del banco leída dos veces? Tolera el
 * truncado y la redacción de la IA (`nivelDescripcionDedupe` ≠ null).
 */
export function mismaDescripcionDedupe(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return nivelDescripcionDedupe(a, b) !== null;
}

/**
 * ¿Las leyendas se CONTRADICEN? Nombran plazas o números distintos, o las
 * dos traen texto y no comparten NINGÚN token con significado («UBER» vs
 * «OXXO»). Es lo único que impide que una referencia igual empate: la
 * referencia de Scotiabank leída por la IA suele ser el número de TARJETA
 * («0025830577»), que se repite en todos los cargos de esa tarjeta, así
 * que por sí sola no identifica la línea.
 */
export function descripcionesSeContradicen(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (mismaDescripcionDedupe(a, b)) return false;
  if (leyendasNombranDistinto(a, b)) return true;
  const ta = tokensTexto(a);
  const tb = tokensTexto(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return !ta.some((t) => tb.includes(t));
}

/** Nivel más débil de `nivelEmpateDedupe`. */
const NIVEL_EMPATE_MAX = 4;

/**
 * Nivel del empate de una línea nueva con una fila previa del MISMO bucket
 * (menor = más fuerte; `null` = no son la misma línea):
 *  0. REFERENCIA igual **y** leyenda tolerante igual (re-subir el mismo PDF).
 *  1. Leyenda normalizada IDÉNTICA.
 *  2. Leyenda truncada (una es prefijo de la otra).
 *  3. Leyenda con el mismo inicio (12 caracteres).
 *  4. REFERENCIA igual con leyendas que NO se contradicen (la IA redactó
 *     distinto la MISMA línea: «AEROPUERTO DE COZUMEL» / «Aeropuerto
 *     Cozumel (TUA)»).
 */
function nivelEmpateDedupe(n: LineaDedupe, p: LineaDedupe): number | null {
  const ref = refDedupe(n.referencia);
  const mismaRef = ref !== null && ref === refDedupe(p.referencia);
  const desc = nivelDescripcionDedupe(n.descripcion, p.descripcion);
  if (desc !== null) return mismaRef ? 0 : desc + 1;
  if (mismaRef && !descripcionesSeContradicen(n.descripcion, p.descripcion)) {
    return NIVEL_EMPATE_MAX;
  }
  return null;
}

/**
 * Multiconjunto de duplicados contra lo YA importado en la cuenta.
 *
 * INCIDENTE 29-sep-2026 («se me están duplicando los gastos»): la regla
 * anterior decía «la REFERENCIA manda cuando existe de los dos lados» y
 * dos cargos iguales con referencias distintas eran dos movimientos. Pero
 * la referencia que la IA transcribe del PDF NO es estable entre lecturas:
 * el MISMO cargo del 7-sep (AEROPUERTO DE COZUMEL $125.82) llegó como
 * «0025830577» (8-sep, número de tarjeta), «00000000000000000001»
 * (22-sep, consecutivo) y «00000000000000000001 AUT. 456529» (29-sep); cada
 * re-importación lo volvió a insertar (5 filas para 2 cargos reales;
 * septiembre de GASTOS GNRAL con ~2× filas).
 *
 * Regla, dentro del bucket (fecha|tipo|monto): cada línea nueva empata con
 * las filas previas según `nivelEmpateDedupe` (referencia + leyenda,
 * leyenda idéntica, truncada, mismo inicio, referencia sola). En los
 * niveles de leyenda la referencia NO cuenta: nunca veta un duplicado. Y
 * sola es la señal MÁS débil (va al final y exige leyendas compatibles): en
 * prod «0025830585» es la TARJETA y se repite en cargos de comercios
 * distintos, y los 7 abonos «CARGO INDEBIDO 21 SEP 355xx» del 23-sep traen
 * la MISMA referencia «00000000001303268115».
 *
 * EMPAREJAMIENTO MÁXIMO por niveles (no «el primero que encuentre»): se
 * abre un nivel a la vez y, con caminos de aumento, una línea ya emparejada
 * puede ceder su fila previa y moverse a otra con la que también empata.
 * Así el orden del archivo no decide: «ASA CANCUN I\CARR CANC» (que también
 * empata por prefijo con «ASA CANCUN») ya no le roba la fila a
 * «ASA CANCUN\CARR CANCUN» y deja una carga duplicada; y una pareja fuerte
 * (prefijo) gana siempre a una floja (mismo inicio).
 *
 * MULTICONJUNTO: cada fila previa se usa UNA sola vez. Dos cargos
 * legítimos iguales del mismo día siguen entrando si el archivo trae dos y
 * la base uno; y las líneas del MISMO archivo nunca se deduplican entre sí.
 */
export function emparejarDuplicados<T extends LineaDedupe>(
  nuevos: readonly T[],
  previos: readonly LineaDedupe[],
): { aInsertar: T[]; duplicados: number } {
  // Solo interesan los buckets que trae el archivo.
  const buckets = new Map<
    string,
    { nuevos: number[]; previos: LineaDedupe[] }
  >();
  nuevos.forEach((n, i) => {
    const k = claveBucket(n);
    const b = buckets.get(k) ?? { nuevos: [], previos: [] };
    b.nuevos.push(i);
    buckets.set(k, b);
  });
  for (const p of previos) buckets.get(claveBucket(p))?.previos.push(p);

  const duplicado = new Array<boolean>(nuevos.length).fill(false);
  for (const b of buckets.values()) {
    if (b.previos.length === 0) continue;
    // Filas previas con las que empata cada línea nueva, la más fuerte primero.
    const aristas = b.nuevos.map((i) =>
      b.previos
        .map((p, k) => ({ k, nivel: nivelEmpateDedupe(nuevos[i], p) }))
        .filter((a): a is { k: number; nivel: number } => a.nivel !== null)
        .sort((x, y) => x.nivel - y.nivel || x.k - y.k),
    );
    const usadaPor = new Array<number>(b.previos.length).fill(-1);
    const emparejada = new Array<boolean>(b.nuevos.length).fill(false);
    // Camino de aumento (Kuhn): si la fila previa ya la usa otra línea, se
    // intenta mover ESA línea a otra fila con la que empate (nivel ≤ tope).
    const aumentar = (
      u: number,
      tope: number,
      vistas: Set<number>,
    ): boolean => {
      for (const { k, nivel } of aristas[u]) {
        if (nivel > tope) break;
        if (vistas.has(k)) continue;
        vistas.add(k);
        if (usadaPor[k] === -1 || aumentar(usadaPor[k], tope, vistas)) {
          usadaPor[k] = u;
          return true;
        }
      }
      return false;
    };
    for (let tope = 0; tope <= NIVEL_EMPATE_MAX; tope++) {
      for (let u = 0; u < b.nuevos.length; u++) {
        if (!emparejada[u] && aumentar(u, tope, new Set())) {
          emparejada[u] = true;
        }
      }
    }
    b.nuevos.forEach((i, u) => {
      duplicado[i] = emparejada[u];
    });
  }
  const aInsertar = nuevos.filter((_, i) => !duplicado[i]);
  return { aInsertar, duplicados: nuevos.length - aInsertar.length };
}

// =======================================================================
// CONTEO DE RESULTADOS (import y re-cruce hablan el MISMO idioma)
// =======================================================================

export type ResultadoCruce =
  | 'CONCILIADO'
  | 'TRASPASO'
  | 'AMBIGUO'
  | 'SIN_CANDIDATO'
  | 'RECHAZADO'
  | 'ERROR';

export interface ConteoCruce {
  conciliados: number;
  traspasos: number;
  ambiguos: number;
  sin_candidato: number;
  rechazados: number;
  errores: number;
}

export function conteoVacio(): ConteoCruce {
  return {
    conciliados: 0,
    traspasos: 0,
    ambiguos: 0,
    sin_candidato: 0,
    rechazados: 0,
    errores: 0,
  };
}

export function sumarResultado(c: ConteoCruce, r: ResultadoCruce): ConteoCruce {
  switch (r) {
    case 'CONCILIADO':
      c.conciliados += 1;
      break;
    case 'TRASPASO':
      c.traspasos += 1;
      break;
    case 'AMBIGUO':
      c.ambiguos += 1;
      break;
    case 'SIN_CANDIDATO':
      c.sin_candidato += 1;
      break;
    case 'RECHAZADO':
      c.rechazados += 1;
      break;
    case 'ERROR':
      c.errores += 1;
      break;
  }
  return c;
}

/** Ventana [fecha − días, fecha + días] sobre un DATE `YYYY-MM-DD`. */
export function ventanaDias(
  fecha: string,
  dias: number,
): { desde: string; hasta: string } {
  const base = Date.parse(`${fecha}T00:00:00Z`);
  const d = (delta: number) =>
    new Date(base + delta * 86_400_000).toISOString().slice(0, 10);
  return { desde: d(-Math.abs(dias)), hasta: d(Math.abs(dias)) };
}
