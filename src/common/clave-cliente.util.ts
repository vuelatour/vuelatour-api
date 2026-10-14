/**
 * ID DE VUELO POR CLIENTE JUNTO AL FOLIO (decisión 6 del lote del
 * 13-oct-2026, API 0.0.75, invariante 68): FUENTE ÚNICA del texto del ID
 * «diego01-131026» = alias del cliente + número de vuelo de ESE cliente (2
 * dígitos mínimo) + '-' + DDMMAA del DÍA CANCÚN de `fecha_vuelo` (sin fecha,
 * sin sufijo: «francisco10»).
 *
 * Se calcula al LEER y NUNCA se persiste: cambiar el alias del cliente o
 * reprogramar el vuelo re-etiqueta sus vuelos. Panel, pyservices y app lo
 * reciben YA armado (`clave_cliente`) y jamás lo recalculan. El FOLIO sigue
 * siendo la llave del dinero (cobros, gastos, facturas, conciliación y
 * bitácoras); el ID es una etiqueta.
 *
 * PURO (sin BD, con spec). Los insumos (`cliente.alias` y
 * `vuelo.consecutivo_cliente`, migración 20261013000006) los lee SOLO
 * `clave-cliente-lectura.util.ts`, detrás de la sonda
 * `id-cliente-disponible.util.ts`.
 *
 * El alias SUGERIDO (primera palabra del nombre sin acentos) NO vive aquí:
 * lo fija la BD (`public.cliente_alias_default`, espejo del `aliasSugerido`
 * del panel). Por eso no se reusa `normalizarNombreCliente` (NFD).
 */
import { diaCancun } from './fecha-cancun.util';

/**
 * Alias válido: 1 a 24 letras minúsculas a-z. MISMO literal que el CHECK
 * `cliente_alias_chk` de la migración y que `src/lib/admin/clave-cliente.ts`
 * del panel (su vitest compara este archivo).
 */
export const ALIAS_REGEX = /^[a-z]{1,24}$/;

/** Texto del 400 de un alias inválido (DTO y CHECK 23514). */
export const MENSAJE_ALIAS_INVALIDO =
  'Alias inválido: usa de 1 a 24 letras minúsculas, sin acentos, espacios, números ni signos (ej. diego).';

/**
 * `@Transform` del alias en los DTO: un string se recorta y pasa a
 * minúsculas, y '' (o solo espacios) ⇒ null (= volver al sugerido). Cualquier
 * otro tipo pasa TAL CUAL para que `@IsString` lo rechace.
 */
export function normalizarAliasEntrada(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const limpio = v.trim().toLowerCase();
  return limpio === '' ? null : limpio;
}

/**
 * DDMMAA del DÍA CANCÚN de `fecha_vuelo` ('2026-10-14T03:30:00Z' ⇒ '131026':
 * en Cancún todavía es el 13). Una fecha 'YYYY-MM-DD' se respeta como fecha
 * de pared (`diaCancun`). null o '' ⇒ null; una fecha inválida ⇒ null:
 * NUNCA lanza (una etiqueta jamás tumba una lista ni un libro).
 */
export function ddmmaaCancun(
  fechaVuelo: string | null | undefined,
): string | null {
  if (fechaVuelo == null || fechaVuelo === '') return null;
  let dia: string;
  try {
    dia = diaCancun(fechaVuelo);
  } catch {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return null;
  // Una fecha de pared imposible ('2026-02-31') tampoco inventa un día.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return `${m[3]}${m[2]}${m[1].slice(2)}`;
}

/**
 * Número de vuelo del cliente: entero ≥ 1, como number o como string de
 * solo dígitos (PostgREST puede mandarlo de las dos formas). Otro ⇒ null.
 */
function consecutivoValido(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v >= 1 ? v : null;
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  return null;
}

/**
 * EL ID del vuelo por cliente, o null si falta un insumo válido (sin alias
 * a-z, sin número entero ≥ 1): nunca inventa. `alias` + número con 2 dígitos
 * mínimo (100 ⇒ «diego100») + '-DDMMAA' solo cuando `fecha_vuelo` es un
 * string que da fecha.
 */
export function claveCliente(p: {
  alias: unknown;
  consecutivo: unknown;
  fecha_vuelo: unknown;
}): string | null {
  if (typeof p.alias !== 'string' || !ALIAS_REGEX.test(p.alias)) return null;
  const n = consecutivoValido(p.consecutivo);
  if (n == null) return null;
  const base = `${p.alias}${String(n).padStart(2, '0')}`;
  const ddmmaa =
    typeof p.fecha_vuelo === 'string' ? ddmmaaCancun(p.fecha_vuelo) : null;
  return ddmmaa ? `${base}-${ddmmaa}` : base;
}

/** Forma de un ID escrito en un buscador: «diego02» o «diego02-211026». */
const BUSQUEDA_CLAVE = /^([a-z]{1,24})([0-9]{1,4})(?:-[0-9]{6})?$/i;

/**
 * ¿El texto buscado tiene forma de ID? ⇒ `{ alias (minúsculas), consecutivo
 * ≥ 1 }`; si no, null ('diego00', '376', 'maqar', 'CUN', 'n4142r',
 * 'xa-vgv'…). La FECHA escrita se IGNORA a propósito: un vuelo reprogramado
 * se sigue encontrando con su ID viejo (alias + número no cambian).
 */
export function parseBusquedaClave(
  q: string | null | undefined,
): { alias: string; consecutivo: number } | null {
  if (typeof q !== 'string') return null;
  const m = BUSQUEDA_CLAVE.exec(q.trim());
  if (!m) return null;
  const consecutivo = Number(m[2]);
  if (!Number.isInteger(consecutivo) || consecutivo < 1) return null;
  return { alias: m[1].toLowerCase(), consecutivo };
}

/**
 * CLAVE de la hoja maestra y de cobranza del balance por avión:
 * «#364 · beh05-011026 · Beh Kay ». Con `claveCliente` null da EXACTAMENTE
 * la plantilla de siempre (`#${folio}${cliente ? ` · ${cliente}` : ''}`). No
 * recorta: el nombre viaja tal cual lo capturó la oficina.
 */
export function claveLibro(p: {
  folio: string | number;
  claveCliente: string | null;
  cliente: string | null;
}): string {
  return [`#${p.folio}`, p.claveCliente, p.cliente].filter(Boolean).join(' · ');
}

/**
 * CLAVE de «otros movimientos» del Balance general: «#364 · beh05-011026»
 * con ID; sin él, el `legado` de siempre ('vt' + primera palabra del
 * cliente + folio: «vtbeh364»).
 */
export function claveOtrosMovimientos(p: {
  folio: string | number;
  claveCliente: string | null;
  legado: string;
}): string {
  return p.claveCliente ? `#${p.folio} · ${p.claveCliente}` : p.legado;
}

/**
 * CLAVE del Libro Dinero (hoja de vuelos y «Otros ingresos» del vuelo): un
 * vuelo de SERVICIO es SIEMPRE 'vtservicio' (como el libro manual), aunque
 * tenga ID; si no, el ID («beh05-011026») o, sin él, el `legado` de siempre
 * ('vt' + primera palabra del cliente: «vtbeh»).
 */
export function claveDinero(p: {
  servicio: boolean;
  claveCliente: string | null;
  legado: string;
}): string {
  if (p.servicio) return 'vtservicio';
  return p.claveCliente ? p.claveCliente : p.legado;
}
