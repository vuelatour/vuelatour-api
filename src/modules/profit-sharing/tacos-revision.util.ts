import { soloPendientes } from '../../common/taco-motivo.util';

/**
 * PRE-CIERRE → «Tacómetros en revisión (amarillos)»: QUÉ tramos son.
 *
 * Pedido del cliente (14-sep-2026): «en Tacómetros pendientes por revisar
 * (pre-cierre) ¿podría indicar cuáles son?». Hasta ahora el item solo traía
 * un número y el operador tenía que ir a Tacómetros en vivo a adivinar cuál
 * de todos los amarillos caía en el periodo del cierre.
 *
 * ADITIVO: el item conserva `clave`, `titulo`, `detalle` y `count` (= tramos
 * amarillos) y gana `vuelos` (los chips con liga que el panel ya sabe
 * pintar) y `tramos` (una línea por tramo: «T1 CUN → CZM · motivo»).
 *
 * Helpers PUROS: la consulta vive en `profit-sharing.service`; aquí solo se
 * arma la respuesta (así se puede probar sin Supabase).
 */

/** Fila de `escala` con su vuelo embebido, tal como la lee el pre-cierre. */
export interface EscalaEnRevisionRow {
  id?: unknown;
  vuelo_id?: unknown;
  orden?: unknown;
  origen_iata?: unknown;
  destino_iata?: unknown;
  fecha_salida_plan?: unknown;
  revision_motivo?: unknown;
  /** Piloto del TRAMO (rotación); si falta, hereda el del vuelo. */
  piloto_id?: unknown;
  vuelo?: {
    id?: unknown;
    folio?: unknown;
    estado?: unknown;
    fecha_vuelo?: unknown;
    piloto_id?: unknown;
  } | null;
}

/** Chip de vuelo del checklist — mismo shape que los demás items. */
export interface PreCierreVueloRef {
  id: string;
  folio: number;
  estado: string | null;
  fecha_vuelo: string | null;
}

/** Una línea por TRAMO amarillo. */
export interface PreCierreTacoTramo {
  vuelo_id: string;
  folio: number;
  orden: number;
  origen_iata: string | null;
  destino_iata: string | null;
  /** timestamptz del plan (el panel lo formatea en hora Cancún). */
  fecha_salida_plan: string | null;
  /** Primera línea accionable de `revision_motivo` (sin la bitácora). */
  motivo: string | null;
  piloto_nombre: string | null;
}

/**
 * Tope del arreglo `tramos` para que un periodo desastroso no infle la
 * respuesta del checklist. `count` SIEMPRE es el total real: si algún día se
 * llega a este tope, el número sigue diciendo la verdad.
 */
export const MAX_TRAMOS_EN_REVISION = 200;

/** El motivo se recorta: en la BD llega a 1800 caracteres con bitácora. */
const MAX_MOTIVO = 180;

const texto = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

/**
 * Primera línea ACCIONABLE de `revision_motivo`: `soloPendientes` quita el
 * bloque `Registro: …` (procedencia, no es una alerta) y de lo que queda se
 * toma el primer chunk («; » separa los pendientes).
 */
export function motivoCorto(motivo: unknown): string | null {
  const pendientes = soloPendientes(typeof motivo === 'string' ? motivo : null);
  if (!pendientes) return null;
  const primera = pendientes.split(/[;\n]/)[0].trim();
  if (!primera) return null;
  return primera.length > MAX_MOTIVO
    ? `${primera.slice(0, MAX_MOTIVO - 1).trimEnd()}…`
    : primera;
}

/**
 * Ids de piloto que hay que resolver a nombre: el del TRAMO y, si el tramo
 * no tiene, el del VUELO (herencia — `flights.assign` escribe el piloto en
 * todos los tramos, pero los vuelos viejos y los tramos sin rotación lo
 * dejan solo a nivel vuelo).
 */
export function pilotosDeTacosEnRevision(
  rows: readonly EscalaEnRevisionRow[],
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const id = texto(r.piloto_id) ?? texto(r.vuelo?.piloto_id);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Arma `vuelos` (deduplicado, ordenado por folio) y `tramos` (ordenado por
 * folio y orden) del item `tacos_en_revision`.
 *
 * `nombres` = mapa usuario_id → nombre (el service lo trae con
 * `fetchNombres`); lo que no resuelva sale como `null`, jamás como un
 * nombre inventado.
 */
export function resumenTacosEnRevision(
  rows: readonly EscalaEnRevisionRow[],
  nombres: ReadonlyMap<string, string> = new Map(),
): { vuelos: PreCierreVueloRef[]; tramos: PreCierreTacoTramo[] } {
  const vuelos = new Map<string, PreCierreVueloRef>();
  const tramos: PreCierreTacoTramo[] = [];
  for (const r of rows) {
    const v = r.vuelo ?? null;
    const vueloId = texto(r.vuelo_id) ?? texto(v?.id) ?? '';
    const folio = Number(v?.folio ?? 0) || 0;
    const pilotoId = texto(r.piloto_id) ?? texto(v?.piloto_id);
    tramos.push({
      vuelo_id: vueloId,
      folio,
      orden: Number(r.orden ?? 0) || 0,
      origen_iata: texto(r.origen_iata),
      destino_iata: texto(r.destino_iata),
      fecha_salida_plan: texto(r.fecha_salida_plan),
      motivo: motivoCorto(r.revision_motivo),
      piloto_nombre: pilotoId ? (nombres.get(pilotoId) ?? null) : null,
    });
    if (vueloId && !vuelos.has(vueloId)) {
      vuelos.set(vueloId, {
        id: vueloId,
        folio,
        estado: texto(v?.estado),
        fecha_vuelo: texto(v?.fecha_vuelo),
      });
    }
  }
  tramos.sort((a, b) => a.folio - b.folio || a.orden - b.orden);
  return {
    vuelos: [...vuelos.values()].sort((a, b) => a.folio - b.folio),
    tramos: tramos.slice(0, MAX_TRAMOS_EN_REVISION),
  };
}

/**
 * Texto del item: dice CUÁNTOS TRAMOS y en cuántos vuelos (el `count` del
 * checklist son tramos, no vuelos — sin esto el operador leía "3" y veía 2
 * chips sin entender por qué).
 */
export function detalleTacosEnRevision(
  totalTramos: number,
  totalVuelos: number,
): string {
  if (totalTramos === 0)
    return 'Confírmalos o ajústalos en Tacómetros en vivo.';
  const t = `${totalTramos} ${totalTramos === 1 ? 'tramo' : 'tramos'}`;
  const v = `${totalVuelos} ${totalVuelos === 1 ? 'vuelo' : 'vuelos'}`;
  return `${t} con lectura en revisión en ${v}. Confírmalos o ajústalos en Tacómetros en vivo.`;
}
