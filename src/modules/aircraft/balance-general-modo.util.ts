import type { VarianteBalanceGeneral } from '../pyservices/pyservices.service';

/**
 * «BALANCE MENSUAL» Y «BALANCE GENERAL» (6-oct-2026, API 0.0.64, sin
 * migración). Pedido del cliente (Reportes → card «Balance general
 * VuelaTour»): «me pueden poner otro botón para bajar el balance general; el
 * que ya tenemos que se renombre a "Balance mensual"».
 *
 * Los DOS libros salen del MISMO endpoint (`GET
 * /v1/aircraft/balance-general.xlsx`) y del MISMO payload —mismo motor,
 * mismos números—; `?modo=` solo elige cómo lo pinta pyservices
 * (`BalanceGeneralPayload.variante`, el mismo valor):
 *  - `mensual` (DEFAULT: un panel viejo sin `modo` sigue bajando lo de
 *    siempre) = el libro completo de hoy, byte-idéntico.
 *  - `general` = la hoja «reporte horas FLOTA» resumida a COSTO TOTAL y
 *    COSTO POR HORA (fórmula del cliente: «el total de todos los gastos,
 *    entre el tiempo volado, entre el tipo de cambio del día, entre 1.16»),
 *    sin el desglose de operación/piloto/AFAC.
 *
 * Fuente única de los valores válidos: el DTO (`BalanceGeneralQuery`), el
 * servicio (`xlsxGeneral`) y el nombre del archivo leen de aquí.
 */
export const MODOS_BALANCE_GENERAL = [
  'mensual',
  'general',
] as const satisfies readonly VarianteBalanceGeneral[];

export type ModoBalanceGeneral = (typeof MODOS_BALANCE_GENERAL)[number];

/** Sin `modo` = el libro de siempre (compatibilidad con el panel previo). */
export const MODO_BALANCE_GENERAL_DEFAULT: ModoBalanceGeneral = 'mensual';

/** Texto del 400 cuando `modo` trae otro valor. */
export const MENSAJE_MODO_BALANCE_INVALIDO =
  'El modo del balance debe ser «mensual» o «general».';

/**
 * ¿Es un modo válido? Exacto: sin recortar ni cambiar mayúsculas
 * («GENERAL» o « general» NO pasan; el panel manda los valores tal cual).
 */
export function esModoBalanceGeneral(
  valor: unknown,
): valor is ModoBalanceGeneral {
  return (
    typeof valor === 'string' &&
    (MODOS_BALANCE_GENERAL as readonly string[]).includes(valor)
  );
}

/**
 * Nombre del archivo descargado: `balance-mensual-vuelatour-<desde>-a-<hasta>.xlsx`
 * o `balance-general-vuelatour-<desde>-a-<hasta>.xlsx`. Antes del 0.0.64 el
 * único libro se llamaba `balance-general-vuelatour-…`: ese libro hoy es el
 * MENSUAL, y el nombre «general» queda para el resumen de costo por hora.
 */
export function nombreArchivoBalanceGeneral(
  modo: ModoBalanceGeneral,
  desde: string,
  hasta: string,
): string {
  return `balance-${modo}-vuelatour-${desde}-a-${hasta}.xlsx`;
}
