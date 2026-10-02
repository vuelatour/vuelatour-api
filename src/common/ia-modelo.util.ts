/**
 * MODELO DE IA CONFIGURABLE (2-oct-2026, API 0.0.51). Pedido del cliente
 * desde Configuración → Créditos de IA: «dejar una opción en la
 * configuración para adaptar el modelo que quieran utilizar, aunque ahorita
 * dejaremos por default el que estamos usando actualmente».
 *
 * FUENTE ÚNICA (pura) del catálogo de modelos, la validación del id, la
 * tarifa de cada uno, el modelo efectivo y los textos de aviso. El panel
 * (`vuelatour-next/src/lib/admin/ia-modelo.ts`) y pyservices llevan una
 * COPIA LITERAL del catálogo con test de paridad: si aquí se mueve un id,
 * un nombre, una descripción o una tarifa, se mueve allá en el mismo cambio.
 *
 * Cómo viaja: la clave `configuracion_sistema.ia_modelo` guarda el id elegido
 * (o nada = «el del servidor», `ANTHROPIC_MODEL` de pyservices) y TODA
 * llamada del API a pyservices que lee con IA lleva el header `X-IA-Modelo`
 * SOLO cuando hay un modelo configurado. Un pyservices viejo ignora el
 * header y un API viejo no lo manda: en ambos casos todo como hoy.
 */
import { tarifaIa } from '../modules/ia-uso/ia-uso.service';

/** Header con el que el API le dice a pyservices qué modelo usar. */
export const HEADER_IA_MODELO = 'X-IA-Modelo';

/**
 * Forma válida de un id de modelo (MISMA regex en pyservices y en el panel):
 * empieza con `claude-` y lleva solo minúsculas, números, puntos o guiones.
 */
export const REGEX_ID_MODELO_IA = /^claude-[a-z0-9.-]{3,80}$/;

/** Un renglón del catálogo tal como viaja en `GET /v1/config/ia-modelo`. */
export interface ModeloIaCatalogo {
  /** Id exacto que recibe Anthropic (`model=`). */
  id: string;
  /** Nombre corto para el selector. */
  nombre: string;
  /** Una línea para el operador ('' = sin nota). */
  descripcion: string;
  /** Tarifa de ENTRADA, USD por millón de tokens (de `TARIFAS`). */
  in_usd_por_millon: number;
  /** Tarifa de SALIDA, USD por millón de tokens (de `TARIFAS`). */
  out_usd_por_millon: number;
}

/**
 * Catálogo (sin tarifas: esas salen de `TARIFAS` de `ia-uso.service`, la
 * misma tabla con la que se cobra cada lectura). Orden = orden del selector.
 *
 * SOLO modelos que, como el de hoy, NO piensan cuando pyservices omite el
 * parámetro `thinking` (Opus 4.8, Sonnet 4.6 y Haiku 4.5). Revisión del
 * 2-oct-2026: Sonnet 5 y Opus 5.5 corren thinking ADAPTATIVO si se omite
 * (Opus 5.5 ni siquiera deja apagarlo) y esos tokens cuentan contra los
 * `max_tokens` chicos de pyservices (800–2048): la lectura de un ticket o un
 * tacómetro podía salir truncada o vacía. Siguen elegibles por «Otro» (con
 * su aviso y su tarifa). Volverlos al catálogo exige antes que pyservices
 * decida `thinking`/`effort` por modelo junto a `modelo_actual()` y probarlos
 * con un ticket y un tacómetro reales.
 */
const CATALOGO_BASE: ReadonlyArray<
  Pick<ModeloIaCatalogo, 'id' | 'nombre' | 'descripcion'>
> = [
  {
    id: 'claude-opus-4-8',
    nombre: 'Claude Opus 4.8',
    descripcion: 'el que usa hoy el servidor; el más preciso',
  },
  {
    id: 'claude-sonnet-4-6',
    nombre: 'Claude Sonnet 4.6',
    descripcion: 'más barato (≈ 40 % menos por token)',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    nombre: 'Claude Haiku 4.5',
    descripcion: 'el más barato y rápido; menos preciso en tickets difíciles',
  },
];

/** Tarifa USD por millón de un id (por prefijo, regla de `TARIFAS`). */
export function tarifaDe(
  id: string | null | undefined,
): { in_usd_por_millon: number; out_usd_por_millon: number } | null {
  const t = tarifaIa(id);
  return t
    ? {
        in_usd_por_millon: t.inUsdPorMillon,
        out_usd_por_millon: t.outUsdPorMillon,
      }
    : null;
}

/**
 * Catálogo completo con su tarifa. Todo id del catálogo TIENE tarifa (el
 * spec lo exige); el `?? 0` solo es una guarda de tipos.
 */
export const CATALOGO_MODELOS_IA: ReadonlyArray<ModeloIaCatalogo> =
  CATALOGO_BASE.map((m) => {
    const t = tarifaDe(m.id);
    return {
      ...m,
      in_usd_por_millon: t?.in_usd_por_millon ?? 0,
      out_usd_por_millon: t?.out_usd_por_millon ?? 0,
    };
  });

/** ¿El id tiene la forma de un id de modelo? (no dice si existe en Anthropic). */
export function esIdModeloValido(id: unknown): id is string {
  return typeof id === 'string' && REGEX_ID_MODELO_IA.test(id);
}

/** El renglón del catálogo de un id, o `null` si es un id «Otro». */
export function modeloDelCatalogo(
  id: string | null | undefined,
): ModeloIaCatalogo | null {
  return CATALOGO_MODELOS_IA.find((m) => m.id === id) ?? null;
}

/**
 * Modelo que de verdad se usará: el configurado si es válido; si no, el
 * default del servidor (`null` si pyservices no lo reporta: viejo o caído).
 */
export function resolverModeloEfectivo(
  configurado: string | null | undefined,
  defaultServidor: string | null | undefined,
): string | null {
  if (esIdModeloValido(configurado)) return configurado;
  const d = typeof defaultServidor === 'string' ? defaultServidor.trim() : '';
  return d || null;
}

/**
 * `valor_json` de la fila `ia_modelo` ⇒ id configurado. La BD exige que
 * `valor_json` sea null o ARREGLO (`configuracion_sistema_valor_json_chk`),
 * así que el id se guarda como `["claude-…"]`; también se acepta un string
 * suelto por si algún día se relaja el CHECK. Cualquier otra cosa (editado a
 * mano, id inválido, `[]`) ⇒ `null` = el del servidor.
 */
export function modeloDeValorJson(raw: unknown): string | null {
  const v: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return esIdModeloValido(v) ? v : null;
}

/** Id configurado ⇒ `valor_json` a guardar (`null` = el del servidor). */
export function valorJsonDeModelo(modelo: string | null): string[] | null {
  return esIdModeloValido(modelo) ? [modelo] : null;
}

/**
 * Header de la llamada a pyservices: `{ 'X-IA-Modelo': id }` SOLO con un
 * modelo configurado válido; si no, `{}` (pyservices usa el suyo).
 */
export function headersModeloIa(
  modelo: string | null | undefined,
): Record<string, string> {
  return esIdModeloValido(modelo) ? { [HEADER_IA_MODELO]: modelo } : {};
}

// ============================== TEXTOS ==============================

/** Mensaje del 400 `MODELO_INVALIDO`. */
export const MENSAJE_MODELO_INVALIDO =
  'El id del modelo no es válido: debe empezar con «claude-» y llevar solo minúsculas, números, puntos o guiones (por ejemplo, claude-sonnet-4-6).';

/** Aviso de un id sin tarifa conocida (mismo texto en el panel). */
export const AVISO_SIN_TARIFA =
  'Sin tarifa conocida: el consumo se registra con costo 0 hasta agregar su tarifa.';

/** Aviso de un id fuera del catálogo (un id mal escrito tumba las lecturas). */
export const AVISO_FUERA_DE_CATALOGO =
  'Este modelo no está en el catálogo: verifica que el id exista en Anthropic; si no existe, las lecturas con IA fallarán hasta corregirlo.';

/**
 * Aviso del modelo configurado: `null` si no hay modelo o es del catálogo;
 * fuera del catálogo, el aviso de verificar el id y —si tampoco tiene
 * tarifa— el de costo 0.
 */
export function avisoModeloIa(
  modelo: string | null | undefined,
): string | null {
  if (!esIdModeloValido(modelo) || modeloDelCatalogo(modelo)) return null;
  return tarifaDe(modelo)
    ? AVISO_FUERA_DE_CATALOGO
    : `${AVISO_FUERA_DE_CATALOGO} ${AVISO_SIN_TARIFA}`;
}

/** Descripción fija de la fila `configuracion_sistema.ia_modelo`. */
export const DESCRIPCION_CONFIG_IA_MODELO =
  'Modelo de IA (Anthropic) de las lecturas de tickets, tacómetros, PDFs y sugerencias. Vacío = el del servidor (ANTHROPIC_MODEL de pyservices). Se edita en Configuración → Créditos de IA → Modelo de IA.';
