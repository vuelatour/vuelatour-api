/**
 * Caché CORTO del usuario de la app por `supabase_auth_id` (25-nov-2026,
 * invariante 144).
 *
 * Por qué existe: CADA petición del API resolvía al usuario con un
 * `select … from usuario where supabase_auth_id = …`. Medido en los registros
 * de Supabase, esa sola consulta era ~20 % de TODO el tráfico a la base (706
 * por minuto en el pico del 25-nov-2026, 411 en el del 4-nov) y una pantalla
 * del panel la repetía una vez por cada llamada al API (12 o más por carga).
 * La instancia Micro se saturó las dos veces; quitar esta lectura no cuesta
 * dinero.
 *
 * Reglas (si cambias una, cambia su spec):
 * - Solo se guarda una resolución EXITOSA (usuario ACTIVO y con acceso). Un
 *   rechazo —no existe, inactivo, externo, base caída— NUNCA se guarda: quien
 *   acaba de ser activado entra en su siguiente intento.
 * - Lecturas simultáneas del mismo usuario comparten UNA consulta.
 * - `olvidarUsuariosAuth()` vacía todo: lo llama todo escritor de `usuario`
 *   que pueda cambiar rol, estado, nombre, correo o el vínculo de la cuenta,
 *   para que desactivar a alguien o cambiarle el rol aplique AL INSTANTE.
 * - El TTL solo cubre lo que se cambie FUERA del API (SQL directo): como
 *   mucho `USUARIO_AUTH_TTL_MS` de retraso.
 * - El JWT se sigue verificando en CADA petición (firma y vencimiento); aquí
 *   solo se ahorra la lectura de la fila.
 *
 * Estado de módulo a propósito: el API corre en UNA réplica y así los
 * escritores no necesitan inyectar nada. Con más réplicas, la invalidación
 * dejaría de ser inmediata en las demás (quedaría el TTL).
 */

/** Vigencia de una resolución guardada. */
export const USUARIO_AUTH_TTL_MS = 30_000;

/** Tope de entradas (hay decenas de usuarios; es solo un freno). */
export const USUARIO_AUTH_MAX = 500;

interface Entrada<T> {
  promesa: Promise<T>;
  expira: number;
}

const cache = new Map<string, Entrada<unknown>>();

/**
 * Devuelve la resolución guardada de `authId` o la lee con `leer` (una sola
 * vez aunque lleguen varias peticiones a la vez). Si `leer` rechaza, el
 * rechazo se propaga y NO se guarda.
 */
export function usuarioAuthCacheado<T>(
  authId: string,
  leer: () => Promise<T>,
  ahora: number = Date.now(),
): Promise<T> {
  const previa = cache.get(authId) as Entrada<T> | undefined;
  if (previa && previa.expira > ahora) return previa.promesa;

  if (cache.size >= USUARIO_AUTH_MAX) {
    for (const [clave, e] of cache) {
      if (e.expira <= ahora) cache.delete(clave);
    }
    if (cache.size >= USUARIO_AUTH_MAX) cache.clear();
  }

  // La vigencia cuenta desde que EMPIEZA la lectura (lado conservador).
  const entrada: Entrada<T> = {
    promesa: Promise.resolve().then(leer),
    expira: ahora + USUARIO_AUTH_TTL_MS,
  };
  cache.set(authId, entrada);
  entrada.promesa.catch(() => {
    // Un rechazo jamás se queda guardado (y no se borra una entrada más
    // nueva que ya ocupó el lugar).
    if (cache.get(authId) === entrada) cache.delete(authId);
  });
  return entrada.promesa;
}

/**
 * Olvida TODAS las resoluciones guardadas. Llamar tras cualquier escritura de
 * `usuario` que pueda cambiar quién entra o con qué rol.
 */
export function olvidarUsuariosAuth(): void {
  cache.clear();
}

/** Solo para pruebas y diagnóstico. */
export function usuariosAuthEnCache(): number {
  return cache.size;
}
