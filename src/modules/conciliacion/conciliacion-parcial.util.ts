/**
 * FUENTE ÚNICA de la regla «un gasto ↔ N cargos del banco» (14-sep-2026,
 * caso real del cliente: UNA factura de ASUR pagada en DOS cargos de
 * tarjeta — operación y FBO por separado — no cabía en el modelo 1 ↔ 1).
 *
 * REGLA (decisión del cliente, 14-sep-2026):
 * - Un gasto puede tener VARIOS `movimiento_bancario` ligados SOLO si todos
 *   son de la MISMA moneda que el gasto (`cuenta_bancaria.moneda ===
 *   gasto.moneda`). Un gasto USD conciliado contra una cuenta MXN sigue
 *   siendo 1 ↔ 1: de ESE cargo se deriva el `tc_gasto` (invariante 7), y
 *   dos cargos en pesos darían dos tipos de cambio distintos para el mismo
 *   gasto.
 * - La suma de |monto| de los cargos ligados NUNCA supera
 *   `gasto.monto + TOLERANCIA_CONCILIACION`; pasarse significa que el gasto
 *   está mal capturado (si de verdad son dos pagos de la misma factura, el
 *   gasto debe valer la suma de los dos).
 * - `gasto.conciliado = true` SOLO cuando la suma CUBRE el monto
 *   (`cubreGasto`). Mientras sea parcial el gasto sigue saliendo en
 *   gastos-sin-banco (con `monto_vinculado` y `faltante`): la oficina ve lo
 *   que falta, jamás desaparece en silencio.
 *
 * Estas funciones son PURAS (sin BD, sin fechas del sistema) y son el
 * espejo EXACTO de la BD: hasta el 0.0.51 del trigger
 * `tg_mov_bancario_gasto_suma` (migración 20260914000001); desde el
 * 0.0.52 (migración 20261002000002) del trigger `tg_mov_gasto_parte_valida`
 * de la puente `movimiento_bancario_gasto` y de la función
 * `recalcular_gasto_conciliado`. Si una cambia, la otra también.
 *
 * Con la puente, la «suma ligada» de un gasto es Σ `monto_parte` de sus
 * partes NO cruzadas (parte cruzada = moneda de su cuenta ≠ moneda del
 * gasto), nunca el |monto| del movimiento: un cargo de $8,404.20 que paga
 * tres gastos aporta $2,801.40 a cada uno.
 */

/**
 * Centavos de holgura entre la suma de los cargos y el monto del gasto, en
 * la MONEDA DEL GASTO. Cubre la diferencia por redondeo/propina del banco:
 * con $1.00 un ticket de $277.79 se da por cubierto con $276.80, pero un
 * segundo cargo real (de decenas o cientos) sigue rebotando.
 */
export const TOLERANCIA_CONCILIACION = 1.0;

function c2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/** Motivo por el que un cargo NO puede ligarse al gasto. */
export type MotivoNoLigar = 'GASTO_YA_CUBIERTO' | 'MONEDA_DISTINTA';

export interface PuedeLigarInput {
  /** `gasto.monto` (moneda del gasto). */
  montoGasto: number;
  /** Suma de |monto| de los cargos YA ligados al gasto (sin el nuevo). */
  sumaLigada: number;
  /** |monto| del cargo que se quiere ligar. */
  montoNuevo: number;
  /** `cuenta_bancaria.moneda` del cargo nuevo === `gasto.moneda`. */
  mismaMoneda: boolean;
  /** ¿El gasto ya tiene ALGÚN cargo ligado (aunque sume 0)? */
  yaHayLigados: boolean;
}

export interface PuedeLigarResultado {
  ok: boolean;
  motivo: MotivoNoLigar | null;
  /** Suma de los cargos ligados SI se aceptara el nuevo. */
  suma_resultante: number;
  /** Lo que seguiría faltando (0 = cubierto). */
  faltante: number;
  /** ¿La suma resultante CUBRE el gasto (⇒ `gasto.conciliado = true`)? */
  cubre: boolean;
}

/**
 * Lo que falta por conciliar de un gasto: `monto − suma ligada`, nunca
 * negativo y redondeado a centavos. Un gasto cubierto devuelve 0.
 */
export function faltanteDe(montoGasto: number, sumaLigada: number): number {
  const falta = c2(Math.abs(c2(montoGasto)) - Math.abs(c2(sumaLigada)));
  return falta > 0 ? falta : 0;
}

/**
 * ¿Los cargos ligados CUBREN el gasto? (suma ≥ monto − tolerancia). Es la
 * ÚNICA definición de `gasto.conciliado` desde el 14-sep-2026.
 */
export function cubreGasto(montoGasto: number, sumaLigada: number): boolean {
  const monto = Math.abs(c2(montoGasto));
  const suma = Math.abs(c2(sumaLigada));
  // Un gasto de $0 (no debería existir) se da por cubierto con cualquier
  // liga: nunca se queda "pendiente para siempre" en la bandeja.
  if (monto <= 0) return true;
  return suma + 1e-9 >= monto - TOLERANCIA_CONCILIACION;
}

/**
 * ¿Cabe un cargo más en este gasto? Espejo exacto del trigger de BD.
 * - Moneda DISTINTA (gasto USD contra cuenta MXN): solo si no hay ningún
 *   otro cargo ligado (1 ↔ 1, el TC se deriva de ese cargo).
 * - Misma moneda: cabe mientras la suma no rebase `monto + tolerancia`.
 */
export function puedeLigar(input: PuedeLigarInput): PuedeLigarResultado {
  const montoGasto = Math.abs(c2(input.montoGasto));
  const sumaLigada = Math.abs(c2(input.sumaLigada));
  const montoNuevo = Math.abs(c2(input.montoNuevo));
  const suma = c2(sumaLigada + montoNuevo);

  if (!input.mismaMoneda) {
    const ok = !input.yaHayLigados;
    return {
      ok,
      motivo: ok ? null : 'MONEDA_DISTINTA',
      // En moneda distinta la suma NO es comparable con el monto del gasto
      // (son monedas diferentes): se reporta el cargo tal cual.
      suma_resultante: ok ? montoNuevo : sumaLigada,
      faltante: ok ? 0 : faltanteDe(montoGasto, sumaLigada),
      cubre: ok,
    };
  }

  const cabe = suma <= c2(montoGasto + TOLERANCIA_CONCILIACION) + 1e-9;
  return {
    ok: cabe,
    motivo: cabe ? null : 'GASTO_YA_CUBIERTO',
    suma_resultante: cabe ? suma : sumaLigada,
    faltante: faltanteDe(montoGasto, cabe ? suma : sumaLigada),
    cubre: cubreGasto(montoGasto, cabe ? suma : sumaLigada),
  };
}

/** `2026-09-07` → `07 sep` (sin Date: ningún corrimiento de zona). */
export function fechaCortaEs(fecha: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha ?? ''));
  if (!m) return null;
  const meses = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];
  const mes = meses[Number(m[2]) - 1];
  return mes ? `${m[3]} ${mes}` : null;
}

/** `$1,234.50` (es-MX, determinista: sin Intl). */
export function montoBonito(monto: number): string {
  const n = Math.abs(c2(monto));
  const [ent, dec] = n.toFixed(2).split('.');
  return `$${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

export interface CargoLigado {
  id?: string;
  fecha?: string | null;
  monto?: number;
}

function listaFechas(cargos: ReadonlyArray<CargoLigado>): string {
  const fechas = cargos
    .map((c) => fechaCortaEs(c.fecha))
    .filter((f): f is string => !!f);
  if (fechas.length === 0) return '';
  return fechas.length === 1
    ? ` (cargo del ${fechas[0]})`
    : ` (cargos del ${fechas.join(', ')})`;
}

/**
 * Texto del 409 `GASTO_YA_CUBIERTO`: dice CUÁNTO ya está cubierto, con qué
 * cargos y qué hacer si de verdad son dos pagos de la misma factura.
 *
 * CASO SIN CARGOS PREVIOS (14-sep-2026, revisión): la regla también rechaza
 * el PRIMER cargo cuando él SOLO ya rebasa el ticket (p. ej. un cargo de
 * $1,800 contra un gasto de $277.79: el cargo paga varias facturas o el
 * gasto está mal capturado). Decir ahí «ya está cubierto: $0.00 de $277.79»
 * era incomprensible: ese caso tiene su propio texto.
 */
export function mensajeGastoYaCubierto(args: {
  montoGasto: number;
  sumaLigada: number;
  cargos: ReadonlyArray<CargoLigado>;
  /** |monto| del cargo que se intentó ligar (para el caso sin cargos previos). */
  montoNuevo?: number;
}): string {
  if (args.cargos.length === 0) {
    const cargo =
      args.montoNuevo != null ? ` (${montoBonito(args.montoNuevo)})` : '';
    return (
      `Ese cargo${cargo} es MAYOR que el gasto (${montoBonito(args.montoGasto)}): ` +
      'no se puede ligar. Si el cargo paga varias facturas, captura el gasto ' +
      'por el total; si el gasto quedó mal capturado, corrige su monto antes ' +
      'de conciliarlo.'
    );
  }
  return (
    `Ese gasto ya está cubierto: ${montoBonito(args.sumaLigada)} de ` +
    `${montoBonito(args.montoGasto)}${listaFechas(args.cargos)}. ` +
    'Si este cargo es otro pago de la misma factura, el gasto debe valer la ' +
    'suma de los dos.'
  );
}

/** Texto del 409 cuando el gasto ya se concilió contra otra moneda (1 ↔ 1). */
export function mensajeMonedaDistinta(args: {
  monedaGasto: string | null;
  monedaCuenta: string | null;
  cargos: ReadonlyArray<CargoLigado>;
}): string {
  const g = args.monedaGasto ?? 'otra moneda';
  const c = args.monedaCuenta ?? 'otra moneda';
  return (
    `Este gasto está en ${g} y el cargo es de una cuenta en ${c}: ` +
    'un gasto conciliado contra otra moneda solo admite UN cargo (de ahí ' +
    `sale su tipo de cambio)${listaFechas(args.cargos)}. ` +
    'Desvincula ese cargo antes de ligar otro.'
  );
}

// =======================================================================
// 1 CARGO ↔ N GASTOS («lote», 2-oct-2026, API 0.0.52, migración
// 20261002000002). Caso real: SAESA cobró en UN SPEI de $8,404.20 tres
// «Pago VIP» de $2,801.40, y en otro de $4,462.75 dos de $2,231.37/38. La
// liga vive en la puente `movimiento_bancario_gasto` (FUENTE ÚNICA); el
// candado de verdad es la BD (`conciliacion_ligar_cargo_gastos` + triggers):
// lo de aquí es su ESPEJO para responder textos claros ANTES de escribir.
// =======================================================================

/**
 * Tolerancia del LOTE (N ≥ 2 partes en un cargo):
 * `least(1.00, greatest(0.02, 0.01 × N))` — N=2 ⇒ 0.02, N=3 ⇒ 0.03,
 * N=29 ⇒ 0.29. Un centavo por gasto cubre el medio centavo que factura
 * SAESA (2,231.375 ⇒ 2,231.37 ó 2,231.38). MISMA fórmula en BD
 * (`tolerancia_lote`), aquí y en el panel.
 */
export function toleranciaLote(n: number): number {
  const k = Math.max(0, Math.trunc(Number(n) || 0));
  return c2(Math.min(TOLERANCIA_CONCILIACION, Math.max(0.02, 0.01 * k)));
}

/** Parte de OTRO cargo ya ligada a un gasto (la moneda es la de SU cuenta). */
export interface ParteDeGasto {
  monto_parte: number;
  moneda: string | null;
}

/** Gasto propuesto para el lote, con las partes que ya tiene en OTROS cargos. */
export interface GastoDeLote {
  id: string;
  /** `gasto.monto` (moneda del gasto). */
  monto: number;
  moneda: string | null;
  /** Partes del gasto en OTROS cargos (las de ESTE cargo no cuentan). */
  otras: ReadonlyArray<ParteDeGasto>;
}

/** Motivo por el que el lote NO se puede ligar. */
export type MotivoNoRepartir =
  | 'LOTE_INVALIDO'
  | 'LOTE_MONEDA_DISTINTA'
  | 'GASTO_YA_CUBIERTO'
  | 'CARGO_NO_CUADRA';

export interface PuedeRepartirInput {
  /** |movimiento.monto| (moneda de la cuenta). */
  montoCargo: number;
  /** `cuenta_bancaria.moneda` del cargo. */
  monedaCuenta: string | null;
  gastos: ReadonlyArray<GastoDeLote>;
}

export interface PuedeRepartirResultado {
  ok: boolean;
  motivo: MotivoNoRepartir | null;
  n: number;
  monto_cargo: number;
  /** Σ de lo que cada gasto aporta (su `faltante_lote`). */
  suma: number;
  /** |cargo| − suma (2 decimales; positivo = faltan, negativo = se pasan). */
  diferencia: number;
  tolerancia: number;
  moneda: string | null;
  /** Lo que se escribiría en la puente (solo con `ok`). */
  partes: Array<{ gasto_id: string; monto_parte: number }>;
  /** Cada gasto con su monto y lo que le falta (details de CARGO_NO_CUADRA). */
  gastos: Array<{ id: string; monto: number; faltante: number }>;
  /** El gasto que rompe la regla (moneda distinta / ya cubierto). */
  gasto_id: string | null;
  /** Con GASTO_YA_CUBIERTO: el motivo de hoy (cubierto o 1 ↔ 1 cruzado). */
  motivo_gasto: MotivoNoLigar | null;
  moneda_gasto: string | null;
}

/** ¿La parte es CRUZADA (moneda de su cuenta ≠ moneda del gasto)? */
export function parteCruzada(
  monedaParte: string | null | undefined,
  monedaGasto: string | null | undefined,
): boolean {
  return (
    monedaParte != null && monedaGasto != null && monedaParte !== monedaGasto
  );
}

/**
 * Lo que un gasto aporta a un lote (`faltante_lote`): 0 si sus OTRAS partes
 * ya lo cubren (regla de `conciliado`), si no `monto − Σ partes NO cruzadas
 * de otros cargos`. Las partes de ESTE cargo no cuentan: así reemplazar
 * [A] por [A, B] no rebota. Un gasto con una parte cruzada (1 ↔ 1 USD↔MXN)
 * no admite más ⇒ 0.
 */
export function faltanteLote(g: GastoDeLote): {
  faltante: number;
  cruzado: boolean;
} {
  const cruzadas = g.otras.filter((p) => parteCruzada(p.moneda, g.moneda));
  if (cruzadas.length > 0) return { faltante: 0, cruzado: true };
  const suma = c2(
    g.otras.reduce((acc, p) => acc + Math.abs(c2(p.monto_parte)), 0),
  );
  if (g.otras.length > 0 && cubreGasto(g.monto, suma)) {
    return { faltante: 0, cruzado: false };
  }
  return { faltante: faltanteDe(g.monto, suma), cruzado: false };
}

/**
 * ¿Este cargo puede pagar EXACTAMENTE estos gastos (N ≥ 2)? Espejo de
 * `conciliacion_ligar_cargo_gastos` (en el MISMO orden de reglas):
 * 1. 2..50 gastos distintos (si no, LOTE_INVALIDO);
 * 2. todos en la moneda de la cuenta (LOTE_MONEDA_DISTINTA — un gasto en
 *    otra moneda solo se liga 1 a 1);
 * 3. cada gasto entra por su `faltante_lote` > 0 (GASTO_YA_CUBIERTO);
 * 4. `|Σ − |cargo|| ≤ toleranciaLote(N)` (CARGO_NO_CUADRA). No existe el
 *    «cargo parcial»: el centavo que sobre o falte vive en
 *    `gastos_diferencia`, jamás se ajusta un gasto.
 */
export function puedeRepartirCargo(
  input: PuedeRepartirInput,
): PuedeRepartirResultado {
  const montoCargo = Math.abs(c2(input.montoCargo));
  const n = input.gastos.length;
  const tolerancia = toleranciaLote(n);
  const moneda = input.monedaCuenta ?? null;
  const base: PuedeRepartirResultado = {
    ok: false,
    motivo: null,
    n,
    monto_cargo: montoCargo,
    suma: 0,
    diferencia: montoCargo,
    tolerancia,
    moneda,
    partes: [],
    gastos: [],
    gasto_id: null,
    motivo_gasto: null,
    moneda_gasto: null,
  };
  const ids = input.gastos.map((g) => g.id);
  if (n < 2 || n > 50 || new Set(ids).size !== n) {
    return { ...base, motivo: 'LOTE_INVALIDO' };
  }
  const otraMoneda = input.gastos.find(
    (g) => moneda == null || g.moneda == null || g.moneda !== moneda,
  );
  if (otraMoneda) {
    return {
      ...base,
      motivo: 'LOTE_MONEDA_DISTINTA',
      gasto_id: otraMoneda.id,
      moneda_gasto: otraMoneda.moneda ?? null,
    };
  }
  const gastos = input.gastos.map((g) => {
    const f = faltanteLote(g);
    return { g, ...f };
  });
  const filas = gastos.map(({ g, faltante }) => ({
    id: g.id,
    monto: Math.abs(c2(g.monto)),
    faltante,
  }));
  const cubierto = gastos.find((x) => !(x.faltante > 0));
  if (cubierto) {
    return {
      ...base,
      gastos: filas,
      motivo: 'GASTO_YA_CUBIERTO',
      gasto_id: cubierto.g.id,
      motivo_gasto: cubierto.cruzado ? 'MONEDA_DISTINTA' : 'GASTO_YA_CUBIERTO',
      moneda_gasto: cubierto.g.moneda ?? null,
    };
  }
  const suma = c2(filas.reduce((acc, f) => acc + f.faltante, 0));
  const diferencia = c2(montoCargo - suma);
  const cuadra = Math.abs(diferencia) <= tolerancia + 1e-9;
  return {
    ...base,
    ok: cuadra,
    motivo: cuadra ? null : 'CARGO_NO_CUADRA',
    suma,
    diferencia,
    gastos: filas,
    partes: cuadra
      ? filas.map((f) => ({ gasto_id: f.id, monto_parte: f.faltante }))
      : [],
  };
}

/**
 * Diferencia del lote que se REPORTA (`gastos_diferencia`): |cargo| − Σ
 * partes, a centavos. `null` sin partes o con una parte cruzada (sus pesos
 * no se comparan con el gasto en dólares).
 */
export function diferenciaLote(
  montoCargo: number,
  partes: ReadonlyArray<{ monto_parte: number; cruzada?: boolean }>,
): number | null {
  if (partes.length === 0) return null;
  if (partes.some((p) => p.cruzada === true)) return null;
  const suma = partes.reduce((acc, p) => acc + Math.abs(c2(p.monto_parte)), 0);
  return c2(Math.abs(c2(montoCargo)) - c2(suma));
}

// ----------------------------- TEXTOS -----------------------------------

/** 400 `LOTE_INVALIDO` del DTO: `gasto_ids` y `gasto_id` juntos. */
export const MENSAJE_LOTE_AMBOS =
  'Manda la lista de gastos (gasto_ids) o un solo gasto (gasto_id), no los dos.';

/** 400 `LOTE_INVALIDO`: algún gasto repetido, de más o que ya no existe. */
export function mensajeLoteInvalido(
  caso: 'TAMANO' | 'REPETIDOS' | 'NO_EXISTE',
): string {
  if (caso === 'NO_EXISTE') {
    return 'Uno de los gastos elegidos ya no existe: recarga la lista y vuelve a elegirlos.';
  }
  if (caso === 'REPETIDOS') {
    return 'Hay gastos repetidos en la lista: elige cada gasto una sola vez.';
  }
  return 'Elige de 2 a 50 gastos para un mismo cargo.';
}

/** 400 `SOLO_CARGOS`: un ABONO no se concilia contra gastos. */
export const MENSAJE_SOLO_CARGOS =
  'Solo un cargo (salida de dinero) se concilia contra gastos.';

/** 409 `MOVIMIENTO_CON_LOTE`: cambiar a UN gasto un cargo que paga varios. */
export function mensajeMovimientoConLote(n: number): string {
  const k = Math.max(2, Math.trunc(Number(n) || 0));
  return (
    `Este cargo ya paga ${k} gastos: desvincúlalos primero ` +
    `(«Desvincular los ${k} gastos») y vuelve a vincularlo.`
  );
}

/** 409 `LOTE_MONEDA_DISTINTA`. */
export function mensajeLoteMonedaDistinta(args: {
  monedaGasto: string | null;
  monedaCuenta: string | null;
}): string {
  const g = args.monedaGasto ?? 'otra moneda';
  const c = args.monedaCuenta ?? 'otra moneda';
  return (
    `Uno de los gastos está en ${g} y la cuenta del cargo en ${c}: en un ` +
    'cargo con varios gastos todos deben estar en la moneda de la cuenta. ' +
    'Un gasto en otra moneda se vincula solo (1 a 1).'
  );
}

/** 409 `CARGO_NO_CUADRA`: la suma de los gastos no es el cargo. */
export function mensajeCargoNoCuadra(args: {
  n: number;
  suma: number;
  montoCargo: number;
  tolerancia: number;
}): string {
  const dif = c2(Math.abs(c2(args.montoCargo)) - c2(args.suma));
  const cuanto =
    dif > 0
      ? `faltan ${montoBonito(dif)}`
      : `se pasan por ${montoBonito(Math.abs(dif))}`;
  return (
    `Los ${args.n} gastos suman ${montoBonito(args.suma)} y el cargo es de ` +
    `${montoBonito(args.montoCargo)}: ${cuanto} (se acepta hasta ` +
    `${montoBonito(args.tolerancia)} de diferencia). Revisa qué gastos paga ` +
    'este cargo.'
  );
}

/**
 * `CODIGO: texto de la BD` ⇒ `Texto de la BD` (sin el prefijo técnico y con
 * mayúscula inicial). Para los códigos cuyo texto escribe la BD
 * (CARGO_EXCEDIDO, LOTE_SOLO_API_NUEVO, REVERSO_INVALIDO…).
 */
export function textoSinPrefijo(mensaje: string | null | undefined): string {
  const t = String(mensaje ?? '')
    .replace(/^\s*[A-Z][A-Z_]+\s*:\s*/, '')
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** Códigos que la BD lanza con prefijo/hint al escribir partes. */
export const CODIGOS_ERROR_PARTES = [
  'GASTO_YA_CUBIERTO',
  'CARGO_EXCEDIDO',
  'CARGO_NO_CUADRA',
  'LOTE_MONEDA_DISTINTA',
  'MOVIMIENTO_CON_LOTE',
  'MOVIMIENTO_YA_LIGADO',
  'REVERSO_INVALIDO',
  'LOTE_SOLO_API_NUEVO',
  'LOTE_INVALIDO',
  'PARTES_INCOHERENTES',
  'CARGO_LIGADO',
] as const;
export type CodigoErrorPartes = (typeof CODIGOS_ERROR_PARTES)[number];

export interface ErrorPartesLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

/**
 * Lee el error de la RPC/trigger de partes: `code = hint ?? prefijo
 * «CODIGO:» del mensaje` (y, por si cambia el formato, el primer código
 * conocido que aparezca en el texto); `details` = el JSON que la BD manda en
 * `detail` (null si no es un objeto JSON). `codigo` null = no es de esta
 * regla.
 */
export function leerErrorPartes(err: ErrorPartesLike | null | undefined): {
  codigo: CodigoErrorPartes | null;
  texto: string;
  details: Record<string, unknown> | null;
} {
  const msg = String(err?.message ?? '');
  const esCodigo = (c: unknown): c is CodigoErrorPartes =>
    typeof c === 'string' &&
    (CODIGOS_ERROR_PARTES as readonly string[]).includes(c);
  const hint = typeof err?.hint === 'string' ? err.hint.trim() : '';
  const prefijo = /^\s*([A-Z][A-Z_]+)\s*:/.exec(msg)?.[1];
  const codigo = esCodigo(hint)
    ? hint
    : esCodigo(prefijo)
      ? prefijo
      : (CODIGOS_ERROR_PARTES.find((c) => msg.includes(c)) ?? null);
  let details: Record<string, unknown> | null = null;
  if (typeof err?.details === 'string' && err.details.trim().startsWith('{')) {
    try {
      const v: unknown = JSON.parse(err.details);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        details = v as Record<string, unknown>;
      }
    } catch {
      details = null;
    }
  }
  return { codigo, texto: textoSinPrefijo(msg), details };
}

/**
 * «Conciliado con» del Excel para un cargo con VARIOS gastos:
 * «3 gastos: Operaciones · vuelo #315 ($2,801.40) · Operaciones · vuelo
 * #319 ($2,801.40) · …» + «· diferencia $0.01» cuando no cuadra exacto.
 */
export function etiquetaConciliadoLote(
  partes: ReadonlyArray<{
    categoria: string;
    proveedor?: string | null;
    vuelo_folio?: number | null;
    monto_parte: number;
  }>,
  diferencia: number | null,
): string {
  const items = partes.map((p) =>
    [
      p.categoria,
      p.proveedor ?? null,
      p.vuelo_folio != null ? `vuelo #${p.vuelo_folio}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
      .concat(` (${montoBonito(p.monto_parte)})`),
  );
  const dif =
    diferencia != null && Math.abs(c2(diferencia)) > 0
      ? ` · diferencia ${diferencia < 0 ? '-' : ''}${montoBonito(diferencia)}`
      : '';
  return `${partes.length} gastos: ${items.join(' · ')}${dif}`;
}
