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
 * espejo EXACTO del trigger `tg_mov_bancario_gasto_suma`
 * (migración 20260914000001): si una cambia, la otra también.
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
