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
 *     Desde el 2-oct-2026 un candidato EXACTO (desfase 0.00) descarta a los
 *     de ±0.01, y si SOLO hay de ±0.01 queda AMBIGUO (`separarPorDesfase`).
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
 *  4. GASTO EN DÓLARES ↔ CARGO EN PESOS (13-oct-2026, lote 2, API 0.0.75,
 *     invariante 70; al final del archivo): solo con el T.C. OFICIAL del día
 *     del cargo a ±`TOLERANCIA_TC_OFICIAL_PCT`, una leyenda del banco que
 *     COINCIDE con el gasto (≥ 2 palabras propias) y ningún otro cargo que
 *     cuadre igual. Es el HOGAR ÚNICO de esa regla: la usan el auto-cruce, el
 *     motivo de la lista, «Vincular gasto», «Sugerir con IA» y el pre-cierre.
 */
import { redondearA } from '../../common/redondeo.util';
import { round6 } from '../../common/tc.util';
import { fechaCortaEs, montoBonito } from './conciliacion-parcial.util';

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
  | 'REGLA'
  /** Cargo devuelto por el banco ↔ su abono de devolución (30-sep-2026). */
  | 'REVERSO';

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
  /**
   * Lo que se compara contra el cargo cuando NO es `monto` (2-oct-2026): el
   * FALTANTE de un gasto con pago parcial, o lo que el gasto todavía espera
   * del banco en el camino inverso. Default: `monto`.
   */
  monto_cruce?: number | null;
}

/**
 * DESFASE 0.00 GANA AL ±0.01 (2-oct-2026, corrección de fiabilidad). Caso
 * REAL: el SPEI de SAESA de $2,231.38 se ligó SOLO al gasto #318 de
 * $2,231.37 (cabía en la banda de centavos) y el gasto EXACTO #321 de
 * $2,231.38 se capturó 15 min después. Regla: si hay algún candidato con
 * desfase 0.00, los de ±0.01 se descartan; si SOLO hay de ±0.01, el
 * auto-cruce NO decide (AMBIGUO, lo confirma un humano). Los candidatos
 * cuyo monto comparable cae FUERA de la banda (el llamador no dio
 * `monto_cruce`) no se clasifican: se conservan como antes.
 */
export function separarPorDesfase<T>(
  objetivo: number,
  items: readonly T[],
  montoDe: (t: T) => number,
): { exactos: T[]; centavo: T[]; otros: T[] } {
  const cent = (x: number) => Math.round(Math.abs(Number(x) || 0) * 100);
  const obj = cent(objetivo);
  const exactos: T[] = [];
  const centavo: T[] = [];
  const otros: T[] = [];
  for (const it of items) {
    const d = Math.abs(cent(montoDe(it)) - obj);
    if (d === 0) exactos.push(it);
    else if (d <= Math.round(TOLERANCIA_CENTAVOS * 100)) centavo.push(it);
    else otros.push(it);
  }
  return { exactos, centavo, otros };
}

/** Texto del AMBIGUO cuando solo hay candidatos a un centavo. */
export function textoSoloCentavo(n: number, sujeto: 'gasto' | 'cargo'): string {
  if (n === 1) {
    return sujeto === 'gasto'
      ? 'Solo un gasto difiere por un centavo y ninguno cuadra exacto: vincúlalo a mano para confirmarlo.'
      : 'Solo un cargo del banco difiere por un centavo y ninguno cuadra exacto: vincúlalo a mano para confirmarlo.';
  }
  return sujeto === 'gasto'
    ? `${n} gastos difieren por un centavo y ninguno cuadra exacto: vincúlalo a mano.`
    : `${n} cargos del banco difieren por un centavo y ninguno cuadra exacto: vincúlalo a mano.`;
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
  const terminacion = terminacionDeMovimiento(
    mov.referencia,
    mov.descripcion,
    terminacionesValidas,
  );
  // Desfase 0.00 gana; solo ±0.01 ⇒ AMBIGUO (ver `separarPorDesfase`).
  const desfase = separarPorDesfase(
    mov.monto,
    candidatos,
    (c) => c.monto_cruce ?? c.monto,
  );
  if (desfase.exactos.length > 0) {
    candidatos = desfase.exactos;
  } else if (desfase.centavo.length > 0 && desfase.otros.length === 0) {
    return {
      gasto_id: null,
      criterio: null,
      motivo: 'AMBIGUO',
      candidatos_n: desfase.centavo.length,
      terminacion,
      detalle: textoSoloCentavo(desfase.centavo.length, 'gasto'),
    };
  }
  const n = candidatos.length;
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
): {
  movimiento_id: string | null;
  criterio: CriterioCruce | null;
  /** ADITIVO (2-oct-2026): por qué no se eligió (solo ±0.01). */
  detalle?: string;
} {
  if (movimientos.length === 0) return { movimiento_id: null, criterio: null };
  // Desfase 0.00 gana; solo ±0.01 ⇒ nadie (ver `separarPorDesfase`).
  const desfase = separarPorDesfase(
    gasto.monto_cruce ?? gasto.monto,
    movimientos,
    (m) => m.monto,
  );
  if (desfase.exactos.length > 0) {
    movimientos = desfase.exactos;
  } else if (desfase.centavo.length > 0 && desfase.otros.length === 0) {
    return {
      movimiento_id: null,
      criterio: null,
      detalle: textoSoloCentavo(desfase.centavo.length, 'cargo'),
    };
  }
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
 * Una pareja del dedupe (0.0.75): la línea `nuevo` del archivo ES la fila
 * `previo` ya importada. Los índices son los de los arreglos RECIBIDOS por
 * `emparejarDuplicados`; `nivel` = el de `nivelEmpateDedupe` de esa arista.
 */
export interface ParejaDedupe {
  nuevo: number;
  previo: number;
  nivel: number;
}

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
 *
 * Exportada desde el 0.0.75 (concepto del SPEI, 13-oct-2026): la regla
 * ORDEN_ARCHIVO de `planEnriquecimiento` re-empareja gemelos por posición y
 * exige que cada nueva pareja siga siendo la MISMA línea para el dedupe. La
 * lógica no cambió.
 */
export function nivelEmpateDedupe(
  n: LineaDedupe,
  p: LineaDedupe,
): number | null {
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
 *
 * Desde el 0.0.75 (concepto del SPEI, 13-oct-2026) devuelve además
 * `parejas` (qué línea nueva es qué fila previa): `parejas` alimenta
 * `planEnriquecimiento` (`enriquecer-descripcion.util`). El predicado, los
 * niveles, `aInsertar` y `duplicados` NO cambiaron (el espejo SQL
 * 20260929000001 tampoco): `parejas.length === duplicados` siempre.
 */
export function emparejarDuplicados<T extends LineaDedupe>(
  nuevos: readonly T[],
  previos: readonly LineaDedupe[],
): { aInsertar: T[]; duplicados: number; parejas: ParejaDedupe[] } {
  // Solo interesan los buckets que trae el archivo. Los buckets guardan
  // ÍNDICES (de los arreglos recibidos) para poder devolver `parejas`.
  const buckets = new Map<string, { nuevos: number[]; previos: number[] }>();
  nuevos.forEach((n, i) => {
    const k = claveBucket(n);
    const b = buckets.get(k) ?? { nuevos: [], previos: [] };
    b.nuevos.push(i);
    buckets.set(k, b);
  });
  previos.forEach((p, i) => buckets.get(claveBucket(p))?.previos.push(i));

  const duplicado = new Array<boolean>(nuevos.length).fill(false);
  const parejas: ParejaDedupe[] = [];
  for (const b of buckets.values()) {
    if (b.previos.length === 0) continue;
    // Filas previas con las que empata cada línea nueva, la más fuerte primero.
    const aristas = b.nuevos.map((i) =>
      b.previos
        .map((pi, k) => ({
          k,
          nivel: nivelEmpateDedupe(nuevos[i], previos[pi]),
        }))
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
    // Parejas del emparejamiento final (fila previa k ↔ línea usadaPor[k]),
    // con el nivel de ESA arista.
    usadaPor.forEach((u, k) => {
      if (u === -1) return;
      const arista = aristas[u].find((a) => a.k === k);
      parejas.push({
        nuevo: b.nuevos[u],
        previo: b.previos[k],
        nivel: arista ? arista.nivel : NIVEL_EMPATE_MAX,
      });
    });
  }
  const aInsertar = nuevos.filter((_, i) => !duplicado[i]);
  parejas.sort((x, y) => x.nuevo - y.nuevo);
  return {
    aInsertar,
    duplicados: nuevos.length - aInsertar.length,
    parejas,
  };
}

/**
 * Previas en un orden DETERMINISTA para el dedupe (0.0.75): fecha, tipo,
 * monto a centavos, `orden_archivo` asc (null al final), `created_at` asc e
 * id asc. El conteo de duplicados no depende del orden (emparejamiento
 * máximo), pero QUÉ fila previa se empareja con qué línea sí puede cambiar
 * entre previas equivalentes; con este orden `parejas` —que alimenta
 * `planEnriquecimiento`— sale igual en cada corrida. Devuelve una COPIA.
 */
export function ordenarPreviosParaDedupe<
  P extends LineaDedupe & {
    id?: string;
    orden_archivo?: number | null;
    created_at?: string | null;
  },
>(previos: readonly P[]): P[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const cent = (x: number | string) => Math.round((Number(x) || 0) * 100);
  return [...previos].sort((a, b) => {
    const f = cmp(a.fecha ?? '', b.fecha ?? '');
    if (f !== 0) return f;
    const t = cmp(a.tipo ?? '', b.tipo ?? '');
    if (t !== 0) return t;
    const m = cent(a.monto) - cent(b.monto);
    if (m !== 0) return m;
    const oa = a.orden_archivo ?? null;
    const ob = b.orden_archivo ?? null;
    if (oa !== ob) {
      if (oa === null) return 1;
      if (ob === null) return -1;
      return oa - ob;
    }
    const c = cmp(a.created_at ?? '', b.created_at ?? '');
    if (c !== 0) return c;
    return cmp(a.id ?? '', b.id ?? '');
  });
}

// =======================================================================
// CONTEO DE RESULTADOS (import y re-cruce hablan el MISMO idioma)
// =======================================================================

export type ResultadoCruce =
  | 'CONCILIADO'
  | 'TRASPASO'
  /**
   * El movimiento quedó conciliado como CARGO DEVUELTO o como su DEVOLUCIÓN
   * (30-sep-2026, `reverso-cruce.util`). Se cuenta por MOVIMIENTO, como
   * todos: un par emparejado dentro de la corrida suma 2.
   */
  | 'REVERSO'
  | 'AMBIGUO'
  | 'SIN_CANDIDATO'
  | 'RECHAZADO'
  | 'ERROR';

export interface ConteoCruce {
  conciliados: number;
  traspasos: number;
  /** ADITIVO (30-sep-2026): movimientos conciliados como reverso. */
  reversos: number;
  ambiguos: number;
  sin_candidato: number;
  rechazados: number;
  errores: number;
}

export function conteoVacio(): ConteoCruce {
  return {
    conciliados: 0,
    traspasos: 0,
    reversos: 0,
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
    case 'REVERSO':
      c.reversos += 1;
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

// =======================================================================
// GASTO EN DÓLARES ↔ CARGO EN PESOS (13-oct-2026, lote 2, API 0.0.75,
// invariante 70). Caso real (Aircraft Spruce): el auto-cruce ligaba un gasto
// USD a un cargo MXN solo porque el cociente caía en la banda 15–25 y el
// candidato era único. Así el tubo Michelin (422.86 USD, 01-sep) quedó
// ligado a «ASA CANCUN» $8,939.38 de COMBUSTIBLE: T.C. 21.14 contra un
// oficial de 17.01 (+24.3 %), y la BD le derivó `tc_gasto` 21.140300; las
// bujías (794.61 USD, 24-sep) a «ASA CANCUN I\CARR CANC» $14,197.17 (+2.3 %)
// mientras sus cargos reales «AIRCRAFT SPRUCE AND SP» seguían pendientes.
// La corrección de datos se aplicó el 13-oct a las 21:40 Cancún; aquí vive
// la regla que impide que vuelva a pasar. `tc_gasto` lo sigue derivando SOLO
// la BD (`recalcular_gasto_conciliado`): aquí nadie calcula pesos.
// =======================================================================

/**
 * Banda plausible del T.C. implícito (pesos del cargo ÷ dólares del gasto).
 * ESPEJO de `recalcular_gasto_conciliado` en la BD (15/25: fuera de la banda
 * la BD no deriva `tc_gasto` de la liga). Antes vivían en el servicio.
 */
export const TC_IMPLICITO_MIN = 15;
export const TC_IMPLICITO_MAX = 25;

/**
 * Tolerancia ÚNICA contra el T.C. OFICIAL del día del cargo (±%). Datos de
 * prod (13-oct-2026): las 6 ligas cruzadas correctas caen entre −0.4 % y
 * +1.5 %; las 2 equivocadas a +24.3 % (tubo ↔ ASA $8,939.38) y +2.3 %
 * (bujías ↔ ASA I $14,197.17); el señuelo 7,380.80 ↔ tubo a +3.0 %. Si se
 * cambia, volver a correr el describe con las ligas reales del spec.
 */
export const TOLERANCIA_TC_OFICIAL_PCT = 2;

/** Gastos USD en banda que el auto-cruce lee por cargo (llegar al tope ⇒ AMBIGUO). */
export const TOPE_CRUCE_USD = 25;

/** Palabras propias que la leyenda y el gasto deben compartir para COINCIDIR. */
export const MIN_PALABRAS_COMUNES_USD = 2;

/**
 * Relleno en inglés de las leyendas de comercios extranjeros: no identifica
 * a nadie («AIRCRAFT SPRUCE AND SP»). OF y CO ya los tira `tokensTexto` (< 3
 * letras). `VACIAS` NO se toca (es del desempate de siempre).
 */
export const PALABRAS_SIN_IDENTIDAD_USD: ReadonlySet<string> = new Set([
  'AND',
  'THE',
  'INC',
  'LLC',
  'LTD',
  'CORP',
  'FOR',
  'WWW',
  'COM',
  'PAYPAL',
]);

/** Palabras del GIRO (llaves y valores de `SINONIMOS`): ASA, TURBOSINA, CUN… */
const PALABRAS_GIRO: ReadonlySet<string> = new Set([
  ...Object.keys(SINONIMOS),
  ...Object.values(SINONIMOS).flat(),
]);

export type NivelTcCruce = 'CERCA' | 'LEJOS' | 'SIN_OFICIAL';

/** T.C. oficial vigente para un día (respaldo de hasta 7 días). */
export interface OficialDelDia {
  tc: number;
  /** Día REAL del dato (YYYY-MM-DD). */
  fecha_dato: string;
  /** Fuente ya legible ('open.er-api', 'BCE (frankfurter)'…). */
  fuente: string;
}

export interface EvaluacionTcCruce {
  /** round6(|mxn| ÷ |usd|). */
  tc_implicito: number;
  /** Cociente SIN redondear ∈ [15, 25] (el mismo criterio de la BD). */
  en_banda: boolean;
  tc_oficial: number | null;
  tc_oficial_fecha: string | null;
  tc_oficial_fuente: string | null;
  /** (tc_implicito ÷ oficial − 1) × 100 a 1 decimal (−0 ⇒ 0); null sin oficial. */
  desvio_pct: number | null;
  nivel: NivelTcCruce;
}

/** Lo que viaja al panel (`tc_cruce`): la evaluación + sus textos. */
export type TcCruceUsd = EvaluacionTcCruce & {
  tolerancia_pct: number;
  /** No en banda, o LEJOS del oficial. */
  fuera_de_lugar: boolean;
  texto: string;
  titulo: string;
};

export type ContrasteDescripcionUsd =
  | 'COINCIDE'
  | 'DEBIL'
  | 'SIN_TEXTO'
  | 'CONTRADICE';

/** Un gasto en USD candidato a pagarse con el cargo en pesos. */
export interface OpcionCruceUsd {
  id: string;
  usd: number;
  gasto: TextoDelGasto;
}

export interface DecisionCruceUsd {
  resultado: 'LIGAR' | 'AMBIGUO' | 'SIN_CANDIDATOS';
  elegido_id: string | null;
  elegido_usd: number | null;
  candidatos_n: number;
  /** En banda pero LEJOS del oficial (no se ligan). */
  descartados_n: number;
  detalle: string | null;
  evaluacion: EvaluacionTcCruce | null;
}

/** Otro cargo pendiente que podría ser el MISMO gasto (recíproco). */
export interface CargoCompetidor {
  id: string;
  fecha: string;
  monto: number;
  descripcion: string | null;
  oficial: OficialDelDia | null;
}

const dec = (x: number, d: number) => redondearA(x, d).toFixed(d);

/**
 * Evalúa el T.C. implícito de una liga USD ↔ MXN contra el oficial del día
 * del CARGO. null si |mxn| o |usd| ≤ 0. CERCA ⟺ |desvío| ≤ tolerancia,
 * comparando el valor de 1 decimal que se MUESTRA («+2.0 %» es CERCA).
 */
export function evaluarTcCruce(
  mxn: number,
  usd: number,
  oficial: OficialDelDia | null | undefined,
): EvaluacionTcCruce | null {
  const m = Math.abs(Number(mxn) || 0);
  const u = Math.abs(Number(usd) || 0);
  if (!(m > 0) || !(u > 0)) return null;
  const cociente = m / u;
  const tc = round6(cociente);
  const enBanda = cociente >= TC_IMPLICITO_MIN && cociente <= TC_IMPLICITO_MAX;
  const of =
    oficial && Number.isFinite(oficial.tc) && oficial.tc > 0 ? oficial : null;
  if (!of) {
    return {
      tc_implicito: tc,
      en_banda: enBanda,
      tc_oficial: null,
      tc_oficial_fecha: null,
      tc_oficial_fuente: null,
      desvio_pct: null,
      nivel: 'SIN_OFICIAL',
    };
  }
  let desvio = redondearA((tc / of.tc - 1) * 100, 1);
  if (desvio === 0) desvio = 0; // −0 ⇒ 0
  return {
    tc_implicito: tc,
    en_banda: enBanda,
    tc_oficial: of.tc,
    tc_oficial_fecha: of.fecha_dato,
    tc_oficial_fuente: of.fuente,
    desvio_pct: desvio,
    nivel: Math.abs(desvio) <= TOLERANCIA_TC_OFICIAL_PCT ? 'CERCA' : 'LEJOS',
  };
}

/** ¿La liga está fuera de lugar? (fuera de la banda 15–25 o LEJOS del oficial). */
export function ligaUsdFueraDeLugar(ev: EvaluacionTcCruce): boolean {
  return !ev.en_banda || ev.nivel === 'LEJOS';
}

/** «+0.3 %» · «−0.4 %» (U+2212) · «0.0 %». */
function desvioTexto(desvio: number): string {
  if (desvio > 0) return `+${dec(desvio, 1)} %`;
  if (desvio < 0) return `−${dec(Math.abs(desvio), 1)} %`;
  return '0.0 %';
}

/** «T.C. 17.06 · oficial 17.01 (+0.3 %)» · «T.C. 17.55 · sin T.C. oficial del día». */
export function piezaTcCruce(ev: EvaluacionTcCruce): string {
  const tc = `T.C. ${dec(ev.tc_implicito, 2)}`;
  if (ev.tc_oficial == null || ev.desvio_pct == null) {
    return `${tc} · sin T.C. oficial del día`;
  }
  return `${tc} · oficial ${dec(ev.tc_oficial, 2)} (${desvioTexto(ev.desvio_pct)})`;
}

/** La pieza + «: fuera de la banda 15–25» o «: lejos del oficial». */
export function textoTcCruce(ev: EvaluacionTcCruce): string {
  const pieza = piezaTcCruce(ev);
  if (!ev.en_banda) {
    return `${pieza}: fuera de la banda ${TC_IMPLICITO_MIN}–${TC_IMPLICITO_MAX}`;
  }
  if (ev.nivel === 'LEJOS') return `${pieza}: lejos del oficial`;
  return pieza;
}

/** «01 sep 2026». */
function fechaConAnio(fecha: string | null): string {
  const corta = fechaCortaEs(fecha);
  return corta ? `${corta} ${String(fecha).slice(0, 4)}` : String(fecha ?? '');
}

/** Tooltip exacto de la liga (6 decimales, oficial con 4, fecha y fuente). */
export function tituloTcCruce(ev: EvaluacionTcCruce): string {
  const exacto = `T.C. exacto ${ev.tc_implicito.toFixed(6)} (pesos del cargo ÷ dólares del gasto)`;
  const base =
    ev.tc_oficial == null
      ? `${exacto} · sin T.C. oficial del día del cargo: no se puede comparar`
      : `${exacto} · oficial ${dec(ev.tc_oficial, 4)} del ${fechaConAnio(ev.tc_oficial_fecha)} · fuente ${ev.tc_oficial_fuente ?? 'T.C. oficial'} · tolerancia ±${TOLERANCIA_TC_OFICIAL_PCT} %`;
  return ev.en_banda
    ? base
    : `${base} · fuera de la banda ${TC_IMPLICITO_MIN}–${TC_IMPLICITO_MAX}: la base de datos no deriva el T.C. de esta liga`;
}

/** `tc_cruce` del contrato (evaluación + tolerancia + marca + textos). */
export function tcCruceUsdPublico(ev: EvaluacionTcCruce): TcCruceUsd {
  return {
    ...ev,
    tolerancia_pct: TOLERANCIA_TC_OFICIAL_PCT,
    fuera_de_lugar: ligaUsdFueraDeLugar(ev),
    texto: textoTcCruce(ev),
    titulo: tituloTcCruce(ev),
  };
}

/** Tokens CRUDOS que identifican al comercio (sin ciudades, giro ni relleno). */
function palabrasPropiasUsd(s: string | null | undefined): string[] {
  return tokensTexto(s).filter(
    (t) =>
      !CIUDADES.has(t) &&
      !PALABRAS_GIRO.has(t) &&
      !PALABRAS_SIN_IDENTIDAD_USD.has(t),
  );
}

/**
 * ¿La leyenda del banco CONFIRMA que el cargo es ESE gasto en dólares?
 * Tokens CRUDOS (`tokensTexto`, SIN `expandirTokens`) de la leyenda y de la
 * 1.ª línea de las notas + lugar + proveedor, sin ciudades (incluye IATA),
 * sin TODA palabra del giro (llaves y valores de `SINONIMOS`) y sin relleno
 * en inglés. Un lado vacío ⇒ SIN_TEXTO; ≥ 2 comunes ⇒ COINCIDE; 1 ⇒ DEBIL;
 * 0 ⇒ CONTRADICE. NO se reutiliza `puntuarDescripcion`: expande sinónimos
 * (CANCUN+CUN, TURBOSINA+COMBUSTIBLE contarían como 2 palabras: «ASUR
 * CANCUN» empataría con «Aeropuerto de Cancún»), ni
 * `descripcionesSeContradicen` / `leyendasNombranDistinto`, que son del
 * dedupe.
 */
export function contrasteDescripcionUsd(
  descBanco: string | null | undefined,
  gasto: TextoDelGasto,
): ContrasteDescripcionUsd {
  const banco = new Set(palabrasPropiasUsd(descBanco));
  const delGasto = new Set([
    ...palabrasPropiasUsd(gasto.lugar),
    ...palabrasPropiasUsd(primeraLinea(gasto.notas)),
    ...palabrasPropiasUsd(gasto.proveedor),
  ]);
  if (banco.size === 0 || delGasto.size === 0) return 'SIN_TEXTO';
  let comunes = 0;
  for (const t of banco) if (delGasto.has(t)) comunes += 1;
  if (comunes >= MIN_PALABRAS_COMUNES_USD) return 'COINCIDE';
  return comunes === 1 ? 'DEBIL' : 'CONTRADICE';
}

const gastoUsdTexto = (usd: number) =>
  `El gasto en USD de ${montoBonito(usd)} USD`;

/**
 * LA decisión del cruce USD ↔ MXN de UN cargo (solo mira el lado CARGO;
 * jamás la terminación de tarjeta). Opción fuera de banda ⇒ descartada.
 * Sin oficial ⇒ AMBIGUO. ≥ 2 CERCA ⇒ AMBIGUO. 1 CERCA: la leyenda COINCIDE
 * ⇒ LIGAR; si no, AMBIGUO (texto para CONTRADICE y para DEBIL/SIN_TEXTO).
 * 0 CERCA ⇒ SIN_CANDIDATOS (con detalle si hubo LEJOS). El recíproco (otro
 * cargo que cuadre igual con ese gasto) lo corre el servicio ANTES de ligar.
 */
export function decidirCruceUsd(
  cargo: { fecha: string; monto: number; descripcion: string | null },
  opciones: readonly OpcionCruceUsd[],
  oficial: OficialDelDia | null,
): DecisionCruceUsd {
  const mxn = Math.abs(Number(cargo.monto) || 0);
  const enBanda: Array<{ o: OpcionCruceUsd; ev: EvaluacionTcCruce }> = [];
  for (const o of opciones) {
    const ev = evaluarTcCruce(mxn, o.usd, oficial);
    if (ev && ev.en_banda) enBanda.push({ o, ev });
  }
  const nada = {
    elegido_id: null,
    elegido_usd: null,
    descartados_n: 0,
    evaluacion: null,
  };
  if (enBanda.length === 0) {
    return {
      ...nada,
      resultado: 'SIN_CANDIDATOS',
      candidatos_n: 0,
      detalle: null,
    };
  }
  const dia = fechaCortaEs(cargo.fecha) ?? cargo.fecha;
  if (!oficial || !(oficial.tc > 0)) {
    return {
      ...nada,
      resultado: 'AMBIGUO',
      candidatos_n: enBanda.length,
      detalle:
        enBanda.length === 1
          ? `No hay T.C. oficial del ${dia} para comprobar el gasto en USD que podría ser este cargo: vincúlalo a mano.`
          : `No hay T.C. oficial del ${dia} para comprobar los ${enBanda.length} gastos en USD que podrían ser este cargo: vincúlalo a mano.`,
    };
  }
  const oficial2 = dec(oficial.tc, 2);
  const cerca = enBanda.filter((x) => x.ev.nivel === 'CERCA');
  const lejos = enBanda.filter((x) => x.ev.nivel === 'LEJOS');
  if (cerca.length >= 2) {
    return {
      ...nada,
      resultado: 'AMBIGUO',
      candidatos_n: cerca.length,
      descartados_n: lejos.length,
      detalle: `${cerca.length} gastos en USD cuadran con este cargo a ±${TOLERANCIA_TC_OFICIAL_PCT} % del T.C. oficial del ${dia} (${oficial2}): vincúlalo a mano.`,
    };
  }
  if (cerca.length === 1) {
    const { o, ev } = cerca[0];
    const contraste = contrasteDescripcionUsd(cargo.descripcion, o.gasto);
    if (contraste === 'COINCIDE') {
      return {
        resultado: 'LIGAR',
        elegido_id: o.id,
        elegido_usd: o.usd,
        candidatos_n: 1,
        descartados_n: lejos.length,
        detalle: null,
        evaluacion: ev,
      };
    }
    return {
      ...nada,
      resultado: 'AMBIGUO',
      candidatos_n: 1,
      descartados_n: lejos.length,
      evaluacion: ev,
      detalle:
        contraste === 'CONTRADICE'
          ? `${gastoUsdTexto(o.usd)} cuadra con el T.C. oficial (${piezaTcCruce(ev)}), pero la descripción del banco («${cargo.descripcion ?? ''}») no coincide con el gasto: vincúlalo a mano si de verdad es ese.`
          : `${gastoUsdTexto(o.usd)} cuadra con el T.C. oficial (${piezaTcCruce(ev)}), pero la descripción del banco no basta para confirmarlo: vincúlalo a mano.`,
    };
  }
  if (lejos.length === 1) {
    const { o, ev } = lejos[0];
    return {
      ...nada,
      resultado: 'SIN_CANDIDATOS',
      candidatos_n: 0,
      descartados_n: 1,
      evaluacion: ev,
      detalle: `${gastoUsdTexto(o.usd)} daría ${piezaTcCruce(ev)}: fuera de ±${TOLERANCIA_TC_OFICIAL_PCT} %, no se liga.`,
    };
  }
  return {
    ...nada,
    resultado: 'SIN_CANDIDATOS',
    candidatos_n: 0,
    descartados_n: lejos.length,
    detalle: `${lejos.length} gastos en USD quedan a más de ±${TOLERANCIA_TC_OFICIAL_PCT} % del T.C. oficial del ${dia} (${oficial2}): no se liga ninguno.`,
  };
}

/** Un competidor del recíproco con su evaluación. */
export interface CompetidorCruceUsd {
  cargo: CargoCompetidor;
  evaluacion: EvaluacionTcCruce;
}

/**
 * RECÍPROCO (conservador, límite conocido): los OTROS cargos en banda con
 * ese gasto en dólares que quedan CERCA de su oficial o SIN oficial para
 * descartarlos. Un LEJOS no compite; el propio cargo se excluye.
 */
export function competidoresCruceUsd(
  cargoId: string,
  usd: number,
  cargos: readonly CargoCompetidor[],
): CompetidorCruceUsd[] {
  const out: CompetidorCruceUsd[] = [];
  for (const c of cargos) {
    if (c.id === cargoId) continue;
    const ev = evaluarTcCruce(c.monto, usd, c.oficial);
    if (ev && ev.en_banda && ev.nivel !== 'LEJOS') {
      out.push({ cargo: c, evaluacion: ev });
    }
  }
  return out;
}

/** Por qué el recíproco frena la liga (null sin competidores). */
export function textoReciprocoCruceUsd(
  usd: number,
  competidores: readonly CompetidorCruceUsd[],
): string | null {
  if (competidores.length === 0) return null;
  if (competidores.length > 1) {
    return `${gastoUsdTexto(usd)} también podría corresponder a otros ${competidores.length} cargos del banco: vincúlalo a mano.`;
  }
  const { cargo, evaluacion } = competidores[0];
  const cual = `el cargo del ${fechaCortaEs(cargo.fecha) ?? cargo.fecha} de ${montoBonito(cargo.monto)}${cargo.descripcion ? ` («${cargo.descripcion}»)` : ''}`;
  return evaluacion.nivel === 'CERCA'
    ? `${gastoUsdTexto(usd)} también cuadra con ${cual}: vincúlalo a mano.`
    : `${gastoUsdTexto(usd)} también podría ser ${cual}, y no hay T.C. oficial de ese día para descartarlo: vincúlalo a mano.`;
}

/** Motivo de la lista cuando el cruce USD ya decidiría LIGAR. */
export function textoSePuedeCruzarUsd(
  usd: number,
  ev: EvaluacionTcCruce,
): string {
  return `${gastoUsdTexto(usd)} cuadra con el T.C. oficial (${piezaTcCruce(ev)}) y la descripción del banco lo confirma: el cruce automático todavía no corre sobre este cargo. Pulsa «Cruzar pendientes» (o vincúlalo tú desde el menú).`;
}

export const TEXTO_CRUCE_USD_TRUNCADO =
  'Hay demasiados gastos en USD en esas fechas para decidir solo: vincúlalo a mano.';
export const TEXTO_CRUCE_USD_RECIPROCO_TRUNCADO =
  'Hay demasiados cargos del banco en esas fechas para decidir solo: vincúlalo a mano.';
export const TEXTO_CRUCE_USD_RECIPROCO_ERROR =
  'No se pudo comprobar si el gasto en USD cuadra con otro cargo: el cruce no se intenta.';
export const TEXTO_CRUCE_USD_SIN_LECTURA_TC =
  'No se pudo leer el T.C. oficial del día del cargo: el cruce con gastos en USD no se intentó; vuelve a correr «Cruzar pendientes».';
