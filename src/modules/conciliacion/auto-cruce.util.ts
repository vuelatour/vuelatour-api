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

function descDedupe(d: string | null | undefined): string {
  return (d ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Multiconjunto de duplicados contra lo YA importado en la cuenta.
 *
 * La REFERENCIA manda cuando existe de los dos lados (el mismo PDF re-subido
 * puede traer la descripción redactada distinta por la IA y seguía
 * insertándose otra vez); si a alguno le falta, se compara la descripción
 * como siempre. Dos cargos legítimos del mismo día y monto con referencias
 * DISTINTAS ya NO se confunden: son dos movimientos reales.
 */
export function emparejarDuplicados<T extends LineaDedupe>(
  nuevos: readonly T[],
  previos: readonly LineaDedupe[],
): { aInsertar: T[]; duplicados: number } {
  const buckets = new Map<
    string,
    Array<{ ref: string | null; desc: string; usado: boolean }>
  >();
  for (const p of previos) {
    const k = claveBucket(p);
    const lista = buckets.get(k) ?? [];
    lista.push({
      ref: refDedupe(p.referencia),
      desc: descDedupe(p.descripcion),
      usado: false,
    });
    buckets.set(k, lista);
  }
  const aInsertar: T[] = [];
  let duplicados = 0;
  for (const n of nuevos) {
    const lista = buckets.get(claveBucket(n)) ?? [];
    const ref = refDedupe(n.referencia);
    const desc = descDedupe(n.descripcion);
    let hit = ref
      ? lista.find((p) => !p.usado && p.ref !== null && p.ref === ref)
      : undefined;
    if (!hit) {
      hit = lista.find(
        (p) => !p.usado && (p.ref === null || ref === null) && p.desc === desc,
      );
    }
    if (hit) {
      hit.usado = true;
      duplicados += 1;
    } else {
      aInsertar.push(n);
    }
  }
  return { aInsertar, duplicados };
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
