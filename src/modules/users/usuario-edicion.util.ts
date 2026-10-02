/**
 * Quién edita los datos de un usuario (2-oct-2026, contrato «Pilotos: editar
 * datos + tarjetas», sin migración).
 *
 * Pedido de la oficina: la coordinación (COORDINADOR) cambia la tarjeta corp.
 * y los datos de contacto de los PILOTOS sin esperar a un ADMIN. Hasta hoy
 * `PATCH /v1/users/:id` era solo ADMIN y la pantalla de Pilotos no tenía
 * dónde editarlos.
 *
 * Regla (el candado real es el API; el panel solo OFRECE el botón):
 *  - ADMIN: sin cambio (edita todo, reasigna tarjetas).
 *  - COORDINADOR: SOLO si el destino es piloto de base (`rol = 'PILOTO'`) o
 *    piloto externo (`es_piloto_externo = true`). Un usuario de oficina que
 *    también vuela (ADMIN/SOCIO/… con `es_piloto = true`, p. ej. Pablo
 *    Canales) NO cuenta: sigue siendo de oficina y solo un ADMIN lo edita.
 *  - COORDINADOR: SOLO los campos de `CAMPOS_EDITABLES_COORDINADOR`; rol,
 *    estado, fondo, banderas de piloto o avatar ⇒ 403.
 *  - COORDINADOR + tarjeta: la tarjeta debe estar LIBRE o ya ser del piloto.
 *    Quitársela a otra persona es una reasignación y la hace un ADMIN desde
 *    Tarjetas corp.
 *
 * PURO (sin Nest ni Supabase): los textos y la decisión viven aquí y su spec
 * los congela; `users.service` solo lanza.
 */

/** Código del 403 cuando el COORDINADOR toca algo que solo edita un ADMIN. */
export const CODIGO_SOLO_ADMIN_EDITA_USUARIOS = 'SOLO_ADMIN_EDITA_USUARIOS';

/** Código del 403 cuando la tarjeta elegida ya es de otra persona. */
export const CODIGO_TARJETA_DE_OTRO_USUARIO = 'TARJETA_DE_OTRO_USUARIO';

/** Lo único que la coordinación cambia de un piloto. */
export const CAMPOS_EDITABLES_COORDINADOR = [
  'nombre',
  'telefono',
  'apodo',
  'tarjeta_terminacion',
] as const;

export type CampoEditableCoordinador =
  (typeof CAMPOS_EDITABLES_COORDINADOR)[number];

/** Quien edita no es ADMIN ni COORDINADOR (la ruta ya lo frena antes). */
export const MENSAJE_SOLO_ADMIN_EDITA_USUARIOS =
  'Solo un ADMIN edita usuarios.';

/** El destino es de oficina (no es piloto de base ni externo). */
export const MENSAJE_USUARIO_DE_OFICINA =
  'Ese usuario es de oficina: solo un ADMIN lo edita';

/** Etiquetas es-MX de los campos que solo cambia un ADMIN. */
const ETIQUETAS_CAMPO: Record<string, string> = {
  rol: 'rol',
  estado: 'estado',
  tiene_fondo_caja: 'fondo de caja chica',
  es_piloto: '«también es piloto»',
  es_piloto_externo: '«piloto externo»',
  avatar_url: 'foto',
};

/**
 * Texto del 403 cuando la coordinación manda campos que no le tocan. Nombra
 * lo que sí puede editar para que el operador sepa qué hacer.
 */
export function mensajeCamposSoloAdmin(campos: readonly string[]): string {
  const nombres = campos.map((c) => ETIQUETAS_CAMPO[c] ?? c);
  const lista =
    nombres.length <= 1
      ? (nombres[0] ?? '')
      : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
  return `Solo un ADMIN cambia ${lista}. Desde Pilotos puedes editar nombre, teléfono, nombre corto y tarjeta corp.`;
}

/** Texto del 403 cuando la tarjeta ya está vinculada a otra persona. */
export function mensajeTarjetaDeOtroUsuario(
  nombre: string | null | undefined,
): string {
  const quien = (nombre ?? '').trim() || 'otro usuario';
  return `Esa tarjeta es de ${quien}: un ADMIN la reasigna desde Tarjetas corp.`;
}

/**
 * Campos PRESENTES del patch que el COORDINADOR no puede tocar. «Presente» =
 * valor distinto de `undefined`: con target ES2022+ el DTO de Nest define
 * TODAS sus propiedades (las ausentes valen `undefined`), así que contar
 * llaves daría falsos positivos.
 */
export function camposFueraDeAlcanceCoordinador(
  patch: Record<string, unknown>,
): string[] {
  const permitidos = new Set<string>(CAMPOS_EDITABLES_COORDINADOR);
  return Object.keys(patch).filter(
    (k) => patch[k] !== undefined && !permitidos.has(k),
  );
}

/**
 * ¿La coordinación puede editar a este usuario? Solo pilotos de base o
 * externos; el doble rol (`es_piloto` de alguien de oficina) NO cuenta.
 */
export function esDestinoEditablePorCoordinador(usuario: {
  rol?: string | null;
  es_piloto_externo?: boolean | null;
}): boolean {
  return usuario.rol === 'PILOTO' || usuario.es_piloto_externo === true;
}

/**
 * ¿La tarjeta pertenece a OTRA persona? Libre (`usuario_id` null) o ya del
 * destino ⇒ `false` (se puede asignar).
 */
export function tarjetaEsDeOtro(
  tarjeta: { usuario_id?: string | null } | null | undefined,
  destinoId: string,
): boolean {
  const dueno = tarjeta?.usuario_id ?? null;
  return dueno !== null && dueno !== destinoId;
}
