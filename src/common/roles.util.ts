import { Rol } from './types/auth.types';

/**
 * ROLES «DIRECCIÓN» Y «ADMINISTRACIÓN» (6-nov-2026, API 0.0.126, invariante
 * 122). Pedido del dueño: «un nuevo rol que sea Super usuario o Dirección …
 * se le dará a Ale Canales y Pablo Canales; los demás que están de ADMIN
 * sean de Administración».
 *
 *  - DIRECCION pasa CUALQUIER `@Roles` (RolesGuard): es el superconjunto de
 *    todo lo que podía ADMIN. Las listas de las rutas no necesitan nombrarlo;
 *    las comprobaciones INLINE (`c.rol === Rol.ADMIN`) usan
 *    `esAdminODireccion` o incluyen `Rol.DIRECCION` en la lista que se
 *    consulta con `.includes`.
 *  - ADMIN = «Administración» (la oficina). Conserva todo salvo lo SOLO DE
 *    DIRECCIÓN: Estadísticas (finanzas, gastos y tarjetas), la pantalla de
 *    Ingresos, Nómina y Gastos personales (categorías NOMINA y
 *    PERSONAL_DUENO), Reparto de utilidades y Pagos a socios; en el
 *    expediente del avión ve solo los GASTOS (ni cobrado ni utilidad); ni ve
 *    ni toca la caja chica de Dirección; ni da el rol de Dirección ni edita a
 *    un usuario de Dirección.
 *  - Reportes y Conciliación siguen como estaban para Administración
 *    (decisión del dueño: «de momento pueden ver todo de aquí»).
 *
 * PURO (sin Nest): `roles.util.spec.ts` congela la matriz.
 */

type RolLike = Rol | string | null | undefined;

export function esDireccion(rol: RolLike): boolean {
  return rol === Rol.DIRECCION;
}

/** Administración = el rol ADMIN (el código no cambia; cambia su alcance). */
export function esAdministracion(rol: RolLike): boolean {
  return rol === Rol.ADMIN;
}

/** Lo que antes se escribía `rol === Rol.ADMIN`: Administración o Dirección. */
export function esAdminODireccion(rol: RolLike): boolean {
  return rol === Rol.ADMIN || rol === Rol.DIRECCION;
}

/**
 * Destinatarios de un aviso POR ROL: lo que recibe Administración lo recibe
 * también Dirección (Ale y Pablo eran ADMIN y no deben dejar de enterarse).
 */
export function rolesDestinatarios(rol: Rol): Rol[] {
  return rol === Rol.ADMIN ? [Rol.ADMIN, Rol.DIRECCION] : [rol];
}

// ===== Nómina y gastos personales: solo Dirección =====

/** Categorías cuyos módulos (Nómina, Gastos personales) son solo de Dirección. */
export const CATEGORIAS_SOLO_DIRECCION: readonly string[] = [
  'NOMINA',
  'PERSONAL_DUENO',
];

export function categoriaSoloDireccion(
  categoria: string | null | undefined,
): boolean {
  return categoria != null && CATEGORIAS_SOLO_DIRECCION.includes(categoria);
}

/**
 * ¿El rol tiene VEDADA la categoría? Solo Administración (ADMIN); los demás
 * roles conservan sus listas de siempre (COORDINADOR y FACTURACION siguen
 * llevando la nómina si así lo deciden).
 */
export function rolVedaCategoria(
  rol: RolLike,
  categoria: string | null | undefined,
): boolean {
  return esAdministracion(rol) && categoriaSoloDireccion(categoria);
}

export const CODIGO_CATEGORIA_SOLO_DIRECCION = 'CATEGORIA_SOLO_DIRECCION';
export const MENSAJE_CATEGORIA_SOLO_DIRECCION =
  'La nómina y los gastos personales los lleva Dirección.';

// ===== Caja chica de Dirección =====

/** Lo mínimo de un fondo para saber de quién es (`FONDO_COLS` trae al dueño). */
export interface FondoConDueno {
  usuario?: { rol?: string | null } | null;
}

export function fondoEsDeDireccion(
  fondo: FondoConDueno | null | undefined,
): boolean {
  return esDireccion(fondo?.usuario?.rol);
}

/** ¿El rol ve (y toca) este fondo? Administración no ve el de Dirección. */
export function rolVeFondo(
  rol: RolLike,
  fondo: FondoConDueno | null | undefined,
): boolean {
  return !(esAdministracion(rol) && fondoEsDeDireccion(fondo));
}

export const CODIGO_CAJA_SOLO_DIRECCION = 'CAJA_SOLO_DIRECCION';
export const MENSAJE_CAJA_SOLO_DIRECCION =
  'La caja chica de Dirección solo la ve Dirección.';

// ===== Usuarios =====

/** Solo Dirección da (o quita) el rol de Dirección. */
export function actorPuedeAsignarRol(
  actorRol: RolLike,
  rolDestino: RolLike,
): boolean {
  return !esDireccion(rolDestino) || esDireccion(actorRol);
}

/** Solo Dirección edita, desactiva o cambia la contraseña de alguien de Dirección. */
export function actorPuedeTocarUsuario(
  actorRol: RolLike,
  usuario: { rol?: string | null } | null | undefined,
): boolean {
  return !esDireccion(usuario?.rol) || esDireccion(actorRol);
}

export const CODIGO_SOLO_DIRECCION_USUARIOS = 'SOLO_DIRECCION_EDITA_DIRECCION';
export const MENSAJE_SOLO_DIRECCION_ASIGNA =
  'Solo Dirección puede dar el rol de Dirección.';
export const MENSAJE_SOLO_DIRECCION_EDITA =
  'Ese usuario es de Dirección: solo Dirección lo edita.';

// ===== Dinero del avión (expediente) =====

export interface FinanzasMoneda {
  moneda: string;
  ingresos: number;
  gastos: number;
  utilidad: number;
}

/** Misma fila con lo cobrado y la utilidad en `null` cuando el rol no los ve. */
export interface FinanzasMonedaPorRol {
  moneda: string;
  gastos: number;
  ingresos: number | null;
  utilidad: number | null;
}

/**
 * Administración ve solo los GASTOS del avión (pedido del dueño: «no deben
 * ver la utilidad del avión ni lo cobrado, solo los gastos»); los demás roles
 * que llegan a `/aircraft/:id/metrics` reciben todo.
 */
export function finanzasParaRol(
  finanzas: readonly FinanzasMoneda[],
  rol: RolLike,
): FinanzasMonedaPorRol[] {
  if (!esAdministracion(rol)) return finanzas.map((f) => ({ ...f }));
  return finanzas.map((f) => ({
    moneda: f.moneda,
    gastos: f.gastos,
    ingresos: null,
    utilidad: null,
  }));
}
