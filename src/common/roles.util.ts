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
 *  - NÓMINA Y GASTOS PERSONALES POR PERSONA (12-nov-2026, invariantes 132 y
 *    133): Dirección puede abrirle el módulo de Nómina y/o el de Gastos
 *    personales a alguien de Administración desde Configuración («Acceso a
 *    Nómina», «Acceso a Gastos personales»). Dos listas independientes.
 *    Reglas más abajo.
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

// ===== Acceso POR PERSONA a Nómina y a Gastos personales =====
// (12-nov-2026: invariante 132, Nómina; invariante 133, Gastos personales)
//
// Pedidos de Dirección, el mismo día y sobre Configuración: «poder habilitar
// o deshabilitar a algunos usuarios el módulo de nómina … le acaban de
// autorizar el acceso a Mary, pero no sé si es para siempre o temporal, mejor
// poder controlarlo desde configuración» y, con esa tarjeta ya en uso, «y
// venga otro para gastos personales». Dirección elige en Configuración a
// quién de ADMINISTRACIÓN le abre cada módulo. Son DOS listas independientes
// (`acceso_nomina` y `acceso_gastos_personales`, `ConfiguracionService`):
// tener un acceso NO da el otro. Lo demás de la invariante 122 no se mueve:
// Estadísticas, Ingresos, Reparto y Pagos a socios siguen siendo solo de
// Dirección.

export const CATEGORIA_NOMINA = 'NOMINA';
export const CATEGORIA_GASTOS_PERSONALES = 'PERSONAL_DUENO';

/**
 * Las categorías que Dirección puede abrirle POR PERSONA a alguien de
 * Administración, cada una con SU lista. Una categoría «solo de Dirección»
 * que no esté aquí no se abre con ningún acceso.
 */
export const CATEGORIAS_CON_ACCESO_POR_PERSONA = [
  CATEGORIA_NOMINA,
  CATEGORIA_GASTOS_PERSONALES,
] as const;

export type CategoriaConAccesoPorPersona =
  (typeof CATEGORIAS_CON_ACCESO_POR_PERSONA)[number];

export function categoriaAdmiteAccesoPorPersona(
  categoria: string | null | undefined,
): categoria is CategoriaConAccesoPorPersona {
  return (CATEGORIAS_CON_ACCESO_POR_PERSONA as readonly string[]).includes(
    categoria ?? '',
  );
}

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

/**
 * Roles que entran al módulo de Gastos personales POR SU ROL (espejo de
 * `ROLES_GASTOS_PERSONALES` del panel): Dirección y la coordinación que los
 * captura. Facturación nunca tuvo ese módulo. Administración NO está: de
 * ella entra solo quien Dirección ponga en la lista.
 */
export const ROLES_GASTOS_PERSONALES_POR_ROL: readonly Rol[] = [
  Rol.DIRECCION,
  Rol.COORDINADOR,
];

const ROLES_POR_ROL_DE_MODULO: Record<
  CategoriaConAccesoPorPersona,
  readonly Rol[]
> = {
  NOMINA: ROLES_NOMINA_POR_ROL,
  PERSONAL_DUENO: ROLES_GASTOS_PERSONALES_POR_ROL,
};

/** ¿El rol entra al módulo de esa categoría POR SU ROL (sin lista)? */
export function rolEntraAModulo(
  categoria: CategoriaConAccesoPorPersona,
  rol: RolLike,
): boolean {
  return (ROLES_POR_ROL_DE_MODULO[categoria] as readonly string[]).includes(
    rol ?? '',
  );
}

export function rolEntraANomina(rol: RolLike): boolean {
  return rolEntraAModulo(CATEGORIA_NOMINA, rol);
}

export function rolEntraAGastosPersonales(rol: RolLike): boolean {
  return rolEntraAModulo(CATEGORIA_GASTOS_PERSONALES, rol);
}

/** A quién se le puede DAR un acceso por persona: solo a Administración. */
export function rolAdmiteAccesoPorPersona(rol: RolLike): boolean {
  return esAdministracion(rol);
}

/**
 * ¿Entra al módulo de esa categoría? Por su rol, o Administración con el
 * acceso que le dio Dirección (`enLista` = está en la lista de ESE módulo).
 * Un id en la lista con otro rol (piloto, socio…) NO entra: la lista solo
 * abre la puerta que la invariante 122 le cerró a Administración.
 */
export function entraAModulo(
  categoria: CategoriaConAccesoPorPersona,
  rol: RolLike,
  enLista: boolean,
): boolean {
  return (
    rolEntraAModulo(categoria, rol) ||
    (rolAdmiteAccesoPorPersona(rol) && enLista)
  );
}

/** Lo que publica `/me.permisos.nomina`. */
export function entraANomina(rol: RolLike, enLista: boolean): boolean {
  return entraAModulo(CATEGORIA_NOMINA, rol, enLista);
}

/** Lo que publica `/me.permisos.gastos_personales`. */
export function entraAGastosPersonales(
  rol: RolLike,
  enLista: boolean,
): boolean {
  return entraAModulo(CATEGORIA_GASTOS_PERSONALES, rol, enLista);
}

/**
 * ¿La categoría le queda VEDADA a este usuario? Igual que `rolVedaCategoria`
 * salvo que alguien de Administración tenga el acceso por persona de ESA
 * categoría: cada una tiene su lista, así que el acceso a Nómina no abre los
 * gastos personales ni al revés. `tieneAcceso(categoria)` se consulta SOLO
 * cuando hace falta (Administración + una categoría con acceso por persona):
 * ninguna otra petición paga esa lectura. Quien lo implemente DEBE contestar
 * con la lista de la categoría que recibe.
 */
export async function categoriaVedadaAUsuario(
  rol: RolLike,
  categoria: string | null | undefined,
  tieneAcceso: (categoria: CategoriaConAccesoPorPersona) => Promise<boolean>,
): Promise<boolean> {
  if (!rolVedaCategoria(rol, categoria)) return false;
  if (!categoriaAdmiteAccesoPorPersona(categoria)) return true;
  return !(await tieneAcceso(categoria));
}

/** A Administración SIN el acceso: se le dice a quién pedírselo y dónde. */
export const MENSAJE_NOMINA_SIN_ACCESO =
  'La nómina la lleva Dirección. Si te toca llevarla, pídele a Dirección que te dé acceso en Configuración («Acceso a Nómina»).';
export const MENSAJE_GASTOS_PERSONALES_SIN_ACCESO =
  'Los gastos personales los lleva Dirección. Si te toca llevarlos, pídele a Dirección que te dé acceso en Configuración («Acceso a Gastos personales»).';

/** Texto del 403 `CATEGORIA_SOLO_DIRECCION` según la categoría vedada. */
export function mensajeCategoriaVedada(
  categoria: string | null | undefined,
): string {
  if (categoria === CATEGORIA_NOMINA) return MENSAJE_NOMINA_SIN_ACCESO;
  if (categoria === CATEGORIA_GASTOS_PERSONALES) {
    return MENSAJE_GASTOS_PERSONALES_SIN_ACCESO;
  }
  return MENSAJE_CATEGORIA_SOLO_DIRECCION;
}

export const CODIGO_SOLO_DIRECCION_ACCESO_NOMINA =
  'SOLO_DIRECCION_ACCESO_NOMINA';
export const MENSAJE_SOLO_DIRECCION_ACCESO_NOMINA =
  'Solo Dirección puede cambiar quién entra a Nómina.';
export const CODIGO_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES =
  'SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES';
export const MENSAJE_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES =
  'Solo Dirección puede cambiar quién entra a Gastos personales.';

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
