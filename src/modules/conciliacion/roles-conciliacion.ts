import { Rol } from '../../common/types/auth.types';

/**
 * QUIÉN VE EL BANCO (13-oct-2026, API 0.0.75, invariante 71 — conciliación
 * al revés). FUENTE ÚNICA de los roles que leen movimientos, cuentas y
 * estados de cuenta:
 *  - equivale al `@Roles` de la clase `ConciliacionController` (de la que
 *    hereda `GET /v1/conciliacion/gastos/:id`), a la fila `estados-cuenta`
 *    de `ROLES_POR_BUCKET` (invariante 37) y a `GET /bank-accounts`;
 *  - la usan el decorador de la clase y el Excel de gastos (detalle del
 *    banco solo para quien concilia).
 * Va en archivo aparte (patrón `ROLES_INGRESOS`) para que
 * `expenses.controller.ts` no importe un controller. Abrir el detalle a
 * COORDINADOR/ANALISTA es decisión del cliente (hoy no leen movimientos,
 * cuentas ni el bucket): cambiar esta lista cambia quién ve qué y el spec
 * de paridad lo grita.
 */
export const ROLES_CONCILIACION: readonly Rol[] = [Rol.ADMIN, Rol.FACTURACION];

/**
 * ¿Este rol ve el detalle del banco (cargo, cuenta y estado de cuenta)?
 * null, '' o undefined ⇒ false: el API siempre conoce el rol del usuario.
 */
export function puedeVerDetalleBanco(rol: string | null | undefined): boolean {
  if (typeof rol !== 'string' || !rol) return false;
  return (ROLES_CONCILIACION as readonly string[]).includes(rol);
}
