/**
 * «PASAR ESTOS TRAMOS AL VUELO» (17-nov-2026, API 0.0.141, invariante 136;
 * caso REAL #478).
 *
 * Reporte de la oficina con las capturas de la cotización y del vuelo #478:
 * «no salen los demás tramos y no se actualiza a lo que acabo de poner en la
 * cotización». El vuelo nació el 23-oct como RESERVA con su propio tramo
 * (CUN → MHL), así que quedó con `itinerario_operativo = true`: en ese modo
 * la cotización solo calcula el precio y `replaceEscalas` NO escribe los
 * tramos del vuelo (invariante 6). La oficina cotizó después la ruta
 * completa (CUN → CTM → MHL → CTM → CUN) y el vuelo siguió con un solo tramo
 * de 0 pasajeros. No existía NINGÚN camino para decir «la ruta de la
 * cotización ES la del vuelo»: la banda azul solo ofrecía el sentido
 * contrario («Cotizar con estos tramos»).
 *
 * Este módulo es la REGLA PURA de esa acción: cuándo se puede, qué tramos se
 * escriben y qué se dice. La escritura la hace `QuotesService` con el MISMO
 * `replaceEscalas` de siempre (no hay un segundo escritor de tramos).
 *
 * NUNCA es automático: la regla del cliente es que la cotización no toca la
 * operación (invariantes 6, 14 y 24) y hay vuelos donde las dos rutas son
 * distintas A PROPÓSITO (el avión sale de otra base, ferries, combinados).
 * Solo corre cuando la oficina pulsa el botón y confirma.
 */
import { estadoVueloVolado } from './aeronave-revision.util';

/** Códigos estables de por qué NO se pueden pasar los tramos (409). */
export const CODIGOS_TRAMOS_AL_VUELO = [
  'VUELO_YA_SIGUE_COTIZACION',
  'VUELO_CANCELADO',
  'VUELO_YA_VOLO',
  'VUELO_COMBINADO',
  'VUELO_DE_GRUPO',
  'SIN_TRAMOS_COTIZADOS',
] as const;
export type CodigoTramosAlVuelo = (typeof CODIGOS_TRAMOS_AL_VUELO)[number];

/** Tramo cotizado listo para `replaceEscalas` (misma forma que `ResolvedLeg`). */
export interface TramoParaVuelo {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  pasajeros: number;
  pasajeros_nombres: string[];
  es_ferry: boolean;
  requiere_pernocta: boolean;
  pernocta_costo_usd: number;
  tipo_parada: 'NORMAL' | 'SERVICIO';
  servicio_notas: string | null;
  notas: string | null;
  fecha_salida_plan: string | null;
  /** Siempre null: la visibilidad del PDF es de la escala viva, no viaja. */
  pdf_oculto: null;
}

/** Tramo VIVO del vuelo, lo mínimo para decidir. */
export interface TramoVivoDeVuelo {
  orden?: unknown;
  origen_iata?: unknown;
  destino_iata?: unknown;
  taco_salida?: unknown;
  taco_llegada?: unknown;
  cancelada_at?: unknown;
  solo_operativa?: unknown;
}

export interface EntradaTramosAlVuelo {
  estado: unknown;
  itinerario_operativo: unknown;
  calculo_snapshot: unknown;
  combinado_con_id?: unknown;
  grupo_id?: unknown;
  /** Todas las escalas del vuelo (vivas y canceladas). */
  escalas: readonly TramoVivoDeVuelo[];
}

export type EvaluacionTramosAlVuelo =
  | {
      ok: true;
      /** Los tramos de la cotización, en orden, listos para escribirse. */
      tramos: TramoParaVuelo[];
      /** «CUN → CTM → MHL → CTM → CUN»: lo que el vuelo va a tener. */
      rutaCotizada: string;
      /** «CUN → MHL»: lo que el vuelo tiene hoy («—» sin tramos vivos). */
      rutaVuelo: string;
    }
  | { ok: false; code: CodigoTramosAlVuelo; message: string };

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const textoONull = (v: unknown): string | null => texto(v) || null;
const numero = (v: unknown): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};
const fechaIsoONull = (v: unknown): string | null => {
  const s = texto(v);
  if (!s) return null;
  return Number.isNaN(new Date(s).getTime()) ? null : s;
};

/**
 * Los tramos COTIZADOS del snapshot vigente, normalizados para escribirse en
 * el vuelo. Sale de `calculo_snapshot.ruta.escalas` — el input EXACTO con el
 * que se pactó el precio (lo mismo que `revise` le pasa a `replaceEscalas`).
 * `null` = no hay tramos confiables (sin snapshot, lista vacía o algún tramo
 * sin origen/destino): ahí NO se escribe nada.
 */
export function tramosDelSnapshotParaVuelo(
  snapshot: unknown,
): TramoParaVuelo[] | null {
  const ruta = (snapshot as { ruta?: { escalas?: unknown } } | null)?.ruta;
  const lista = ruta?.escalas;
  if (!Array.isArray(lista) || lista.length === 0) return null;
  const tramos: TramoParaVuelo[] = [];
  for (const crudo of lista as Array<Record<string, unknown> | null>) {
    const origen = texto(crudo?.origen_iata).toUpperCase();
    const destino = texto(crudo?.destino_iata).toUpperCase();
    if (!origen || !destino) return null;
    const ferry = crudo?.es_ferry === true;
    const pernocta = crudo?.requiere_pernocta === true;
    tramos.push({
      origen_iata: origen,
      destino_iata: destino,
      millas_nauticas: numero(crudo?.millas_nauticas),
      pasajeros: ferry ? 0 : Math.trunc(numero(crudo?.pasajeros)),
      pasajeros_nombres:
        ferry || !Array.isArray(crudo?.pasajeros_nombres)
          ? []
          : (crudo.pasajeros_nombres as unknown[])
              .map((n) => texto(n))
              .filter((n) => n.length > 0),
      es_ferry: ferry,
      requiere_pernocta: pernocta,
      pernocta_costo_usd: pernocta ? numero(crudo?.pernocta_costo_usd) : 0,
      tipo_parada: crudo?.tipo_parada === 'SERVICIO' ? 'SERVICIO' : 'NORMAL',
      servicio_notas: textoONull(crudo?.servicio_notas),
      notas: textoONull(crudo?.notas),
      fecha_salida_plan: fechaIsoONull(crudo?.fecha_salida_plan),
      pdf_oculto: null,
    });
  }
  return tramos;
}

/**
 * Una ruta en palabras: encadenada («CUN → CTM → MHL») cuando cada tramo
 * sale de donde llegó el anterior; si no, tramo por tramo («CUN → MHL · CZM
 * → CUN»). Sin tramos, «—».
 */
export function rutaEnTexto(
  tramos: ReadonlyArray<{ origen_iata?: unknown; destino_iata?: unknown }>,
): string {
  const legs = tramos.map((t) => ({
    o: texto(t.origen_iata).toUpperCase() || '?',
    d: texto(t.destino_iata).toUpperCase() || '?',
  }));
  if (legs.length === 0) return '—';
  const encadenada = legs.every((l, i) => i === 0 || legs[i - 1].d === l.o);
  return encadenada
    ? [legs[0].o, ...legs.map((l) => l.d)].join(' → ')
    : legs.map((l) => `${l.o} → ${l.d}`).join(' · ');
}

/** Tramos del CLIENTE que el vuelo tiene hoy (vivos, por orden). */
export function tramosVivosDelVuelo(
  escalas: readonly TramoVivoDeVuelo[],
): TramoVivoDeVuelo[] {
  return escalas
    .filter((e) => e.cancelada_at == null && e.solo_operativa !== true)
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        (Number.isFinite(Number(a.e.orden)) ? Number(a.e.orden) : a.i) -
        (Number.isFinite(Number(b.e.orden)) ? Number(b.e.orden) : b.i),
    )
    .map((x) => x.e);
}

export const MENSAJE_TRAMOS_AL_VUELO: Record<CodigoTramosAlVuelo, string> = {
  VUELO_YA_SIGUE_COTIZACION:
    'Este vuelo ya sigue los tramos de la cotización: se actualizan solos al guardarla.',
  VUELO_CANCELADO:
    'El vuelo está cancelado: sus tramos no se cambian desde la cotización.',
  VUELO_YA_VOLO:
    'El vuelo ya salió o tiene tacómetros capturados: sus tramos son historia de la operación y no se reemplazan desde la cotización. Corrígelos en el vuelo.',
  VUELO_COMBINADO:
    'Este vuelo está combinado con otro: sus tramos se administran desde el vuelo, no desde la cotización.',
  VUELO_DE_GRUPO:
    'Este vuelo es parte de un grupo: sus tramos se administran desde el grupo.',
  SIN_TRAMOS_COTIZADOS:
    'Esta cotización todavía no tiene tramos guardados. Guárdala primero y vuelve a intentarlo.',
};

/**
 * ¿Se pueden pasar los tramos de la cotización al vuelo? PURA. El orden de
 * los candados es el orden en que el operador puede resolverlos: primero lo
 * que hace la acción innecesaria, luego lo que la prohíbe, al final lo que
 * falta capturar.
 *
 * «Ya voló» usa la fuente única `estadoVueloVolado` (EN_VUELO, COMPLETADO o
 * algún tramo VIVO con tacómetro): reemplazar la ruta de un tramo volado
 * falsifica bitácora, calendario y horas de motor (invariante 1).
 */
export function evaluarTramosAlVuelo(
  v: EntradaTramosAlVuelo,
): EvaluacionTramosAlVuelo {
  const no = (code: CodigoTramosAlVuelo): EvaluacionTramosAlVuelo => ({
    ok: false,
    code,
    message: MENSAJE_TRAMOS_AL_VUELO[code],
  });
  if (v.itinerario_operativo !== true) return no('VUELO_YA_SIGUE_COTIZACION');
  const estado = texto(v.estado).toUpperCase();
  if (estado === 'CANCELADO') return no('VUELO_CANCELADO');
  if (
    estadoVueloVolado(
      v.estado,
      v.escalas.map((e) => ({
        orden: e.orden as number | null | undefined,
        taco_salida: e.taco_salida,
        taco_llegada: e.taco_llegada,
        cancelada_at: (e.cancelada_at ?? null) as string | null,
      })),
    ).ya_volo
  ) {
    return no('VUELO_YA_VOLO');
  }
  if (v.combinado_con_id != null) return no('VUELO_COMBINADO');
  if (v.grupo_id != null) return no('VUELO_DE_GRUPO');
  const tramos = tramosDelSnapshotParaVuelo(v.calculo_snapshot);
  if (!tramos) return no('SIN_TRAMOS_COTIZADOS');
  return {
    ok: true,
    tramos,
    rutaCotizada: rutaEnTexto(tramos),
    rutaVuelo: rutaEnTexto(tramosVivosDelVuelo(v.escalas)),
  };
}

/** «18/11/2026 10:00» en hora Cancún (UTC−5 fijo, sin horario de verano). */
export function fechaHoraCancun(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 5 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Aviso ámbar cuando el tramo 1 cotizado trae su propia hora y NO es la del
 * vuelo (caso #478: el vuelo decía 08:00 y la cotización 10:00). La acción
 * escribe la hora del tramo; la cabecera del vuelo no se toca: la oficina
 * decide cuál es la buena. `null` = coinciden o falta alguna.
 */
export function avisoHoraDeSalidaDistinta(
  fechaVuelo: unknown,
  fechaTramo1: unknown,
): string | null {
  const a = fechaIsoONull(fechaVuelo);
  const b = fechaIsoONull(fechaTramo1);
  if (!a || !b) return null;
  if (Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000) {
    return null;
  }
  return `El tramo 1 quedó con salida el ${fechaHoraCancun(b)} (la de la cotización) y el vuelo dice ${fechaHoraCancun(a)}: revisa cuál es la buena y corrígela (hora Cancún).`;
}

/** Sello de `notas_internas`: quién, cuándo y qué cambió (auditoría). */
export function selloTramosAlVuelo(d: {
  cuandoIso: string;
  quien: string | null;
  version: number | null;
  antes: string;
  ahora: string;
}): string {
  const quien = d.quien ? ` · ${d.quien}` : '';
  const version = d.version != null ? ` v${d.version}` : '';
  return `[Tramos de la cotización al vuelo] ${fechaHoraCancun(d.cuandoIso)}${quien}: el vuelo tomó los tramos de la cotización${version} (${d.ahora}); antes tenía ${d.antes}.`;
}

/** Push a la tripulación: UN solo aviso con la ruta completa nueva. */
export function avisoTripulacionTramosAlVuelo(d: {
  folio: number | string;
  antes: string;
  ahora: string;
}): { titulo: string; cuerpo: string } {
  return {
    titulo: `Vuelo #${d.folio}: cambió el itinerario`,
    cuerpo: `Ahora es ${d.ahora} (antes ${d.antes}). Revisa tus tramos y horarios.`,
  };
}
