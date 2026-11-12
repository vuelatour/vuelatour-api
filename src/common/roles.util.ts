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
 *  - NÓMINA POR PERSONA (12-nov-2026, invariante 132): Dirección puede
 *    abrirle el módulo de Nómina a alguien de Administración desde
 *    Configuración («Acceso a Nómina»). Reglas más abajo.
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

// ===== Acceso a Nómina POR PERSONA (12-nov-2026, invariante 132) =====
//
// Pedido de Dirección: «poder habilitar o deshabilitar a algunos usuarios el
// módulo de nómina … le acaban de autorizar el acceso a Mary, pero no sé si
// es para siempre o temporal, mejor poder controlarlo desde configuración».
// Dirección elige en Configuración → «Acceso a Nómina» a quién de
// ADMINISTRACIÓN le abre el módulo (lista `acceso_nomina`,
// `ConfiguracionService`). Lo demás de la invariante 122 no se mueve: los
// gastos personales, Estadísticas, Ingresos, Reparto y Pagos a socios siguen
// siendo solo de Dirección.

/** La ÚNICA categoría que Dirección puede abrirle a alguien de Administración. */
export const CATEGORIA_NOMINA = 'NOMINA';

/**
 * Roles que entran al módulo de Nómina POR SU ROL (los de siempre; espejo de
 * `ROLES_NOMINA` del panel). Administración NO está: de ella entra solo quien
 * Dirección ponga en la lista.
 */
export const ROLES_NOMINA_POR_ROL: readonly Rol[] = [
  Rol.DIRECCION,
  Rol.COORDINADOR,
  Rol.FACTURACION,
];

export function rolEntraANomina(rol: RolLike): boolean {
  return (ROLES_NOMINA_POR_ROL as readonly string[]).includes(rol ?? '');
}

/** A quién se le puede DAR el acceso por persona: solo a Administración. */
export function rolAdmiteAccesoNomina(rol: RolLike): boolean {
  return esAdministracion(rol);
}

/**
 * ¿Entra al módulo de Nómina? Por su rol, o Administración con el acceso que
 * le dio Dirección (`enLista`). Es lo que publica `/me.permisos.nomina`. Un
 * id en la lista con otro rol (piloto, socio…) NO entra: la lista solo abre
 * la puerta que la invariante 122 le cerró a Administración.
 */
export function entraANomina(rol: RolLike, enLista: boolean): boolean {
  return rolEntraANomina(rol) || (rolAdmiteAccesoNomina(rol) && enLista);
}

/**
 * ¿La categoría le queda VEDADA a este usuario? Igual que `rolVedaCategoria`
 * salvo NOMINA para alguien de Administración con el acceso por persona (los
 * gastos personales NUNCA se abren). `tieneAccesoNomina` se consulta SOLO
 * cuando hace falta (Administración + NOMINA): ninguna otra petición paga
 * esa lectura.
 */
export async function categoriaVedadaAUsuario(
  rol: RolLike,
  categoria: string | null | undefined,
  tieneAccesoNomina: () => Promise<boolean>,
): Promise<boolean> {
  if (!rolVedaCategoria(rol, categoria)) return false;
  if (categoria !== CATEGORIA_NOMINA) return true;
  return !(await tieneAccesoNomina());
}

/** A Administración SIN el acceso: se le dice a quién pedírselo y dónde. */
export const MENSAJE_NOMINA_SIN_ACCESO =
  'La nómina la lleva Dirección. Si te toca llevarla, pídele a Dirección que te dé acceso en Configuración («Acceso a Nómina»).';

/** Texto del 403 `CATEGORIA_SOLO_DIRECCION` según la categoría vedada. */
export function mensajeCategoriaVedada(
  categoria: string | null | undefined,
): string {
  return categoria === CATEGORIA_NOMINA
    ? MENSAJE_NOMINA_SIN_ACCESO
    : MENSAJE_CATEGORIA_SOLO_DIRECCION;
}

export const CODIGO_SOLO_DIRECCION_ACCESO_NOMINA =
  'SOLO_DIRECCION_ACCESO_NOMINA';
export const MENSAJE_SOLO_DIRECCION_ACCESO_NOMINA =
  'Solo Dirección puede cambiar quién entra a Nómina.';

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
