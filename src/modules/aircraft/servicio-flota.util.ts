/**
 * «ÚLTIMO / SIGUIENTE SERVICIO» DE CADA AVIÓN, PARA EL LISTADO DE LA FLOTA
 * (22-sep-2026 — el cliente mandó foto del pizarrón «Tacómetros» de la
 * oficina y pidió que `/admin/aircraft` se pareciera a esa tabla).
 *
 * El pizarrón tiene cuatro columnas que el panel no tenía: «Últ. Tact.
 * Serv.» (el tacómetro con el que se HIZO el último servicio), «Sig.
 * Servicio» (tipo + tacómetro del próximo hito), «Tact. Actual» (el
 * `ultimo_taco` que el listado ya traía) y «Tiempo restante».
 *
 * TODO AQUÍ ES PURO (sin BD, sin fechas del sistema, sin `this`): el
 * listado arma los datos en LOTE (una lectura de etapas y una de
 * mantenimientos para TODA la flota) y este helper solo los ENSAMBLA. Los
 * números NO se recalculan aquí:
 *  - el próximo hito lo sigue decidiendo `AircraftService.proximoServicio*`
 *    (se INYECTA como `proximo`, para que no pueda nacer un cálculo paralelo
 *    que diga una cosa en la lista y otra en la ficha del avión), y
 *  - la orden que cubre el hito la sigue decidiendo `ordenAbiertaDelHito`
 *    (`src/common/servicio-hito.util.ts`), el mismo helper que usa el dedupe
 *    del programa automático.
 *
 * OJO (decisión que falta preguntarle al cliente): el pizarrón ancla el
 * siguiente servicio al ÚLTIMO HECHO (5409.7 + 100 = 5509.9), mientras que
 * el sistema lo ancla al PROGRAMA CÍCLICO (`servicio_horas_base` + k ×
 * intervalo) — que es también lo que dispara las órdenes automáticas y lo
 * que pinta la ficha del avión. Coinciden solo cuando el servicio se hizo
 * justo en el hito (XB-PEV), y difieren cuando se adelantó o se atrasó
 * (N621TX: el pizarrón diría 1732.7 y el sistema dice 1700). Aquí se usa la
 * fuente única EXISTENTE a propósito: cambiar el ancla movería también el
 * motor de alertas, y eso se decide con el cliente, no de lado.
 */

import {
  ordenAbiertaDelHito,
  type MantenimientoHitoRow,
  type OrdenServicio,
} from '../../common/servicio-hito.util';

/** Etapa del programa de servicio (`aeronave_servicio_etapa`). */
export interface EtapaServicioFila {
  intervalo_hr: number;
  nombre: string | null;
  tareas: string[];
}

/**
 * Fila de `mantenimiento` que mira el listado: lo que ya pedía el dedupe
 * (`MANT_HITO_COLS`) más lo que necesita el ÚLTIMO servicio.
 */
export interface MantenimientoServicioRow extends MantenimientoHitoRow {
  aeronave_id?: string | null;
  descripcion?: string | null;
  /** Overhaul de un componente: NO es servicio del avión (ver `esDelAvion`). */
  motor_id?: string | null;
  helice_id?: string | null;
}

/** El último servicio HECHO al avión (o la base del programa). */
export interface UltimoServicioFila {
  /** Tacómetro con el que se hizo (columna «Últ. Tact. Serv.» del pizarrón). */
  hobbs_hr: number;
  /** `fecha_realizada` del mantenimiento; `null` en filas legadas y en BASE. */
  fecha: string | null;
  /** Nombre de la etapa, o la descripción recortada. `null` en BASE. */
  etiqueta: string | null;
  /** `BASE` = el avión aún no tiene servicios capturados: es donde ARRANCA
   *  la secuencia (`aeronave.servicio_horas_base`), no un servicio real. */
  origen: 'MANTENIMIENTO' | 'BASE';
}

/** El próximo hito del programa cíclico (columnas «Sig. Servicio» + «Tiempo
 *  restante» + «tipo» del pizarrón). */
export interface SiguienteServicioFila {
  hobbs_hr: number;
  intervalo_hr: number;
  etiqueta: string;
  /** `a_las − tacómetro`. Se expone TAL CUAL (ver `armarServicioFila`). */
  faltan_hr: number;
  orden: OrdenServicio | null;
}

/** Campo `servicio` de cada fila de `GET /v1/aircraft` (ADITIVO). */
export interface ServicioFlota {
  ultimo: UltimoServicioFila | null;
  siguiente: SiguienteServicioFila | null;
  aviso_automatico: { activo: boolean; umbral_hr: number } | null;
}

/**
 * La MISMA firma de `AircraftService.proximoServicioDetallado`. Se inyecta
 * para que el listado no pueda calcular el hito por su cuenta.
 */
export type ProximoServicioFn = (
  intervalos: number[],
  base: number,
  horas: number,
  etapas: EtapaServicioFila[],
) => {
  a_las: number;
  intervalo: number;
  faltan: number;
  nombre: string | null;
} | null;

/** Tolerancia al cruzar `etapa_intervalo_hr` con la etapa (misma del hito). */
const TOLERANCIA_ETAPA_HR = 0.05;

/** Tope de la etiqueta derivada de `descripcion` (la celda del panel es
 *  angosta; el texto completo viaja igual en la ficha del avión). */
export const ETIQUETA_SERVICIO_MAX = 60;

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Intervalos válidos del programa, sin repetidos (misma limpieza que
 *  `proximoServicio`: así «hay programa» significa lo mismo en los dos). */
export function intervalosDePrograma(valor: unknown): number[] {
  const crudos = Array.isArray(valor) ? valor : [];
  return [
    ...new Set(
      crudos.map((n) => num(n)).filter((n): n is number => n != null && n > 0),
    ),
  ];
}

function etiquetaDeDescripcion(desc: unknown): string | null {
  const t = typeof desc === 'string' ? desc.trim() : '';
  if (!t) return null;
  return t.length > ETIQUETA_SERVICIO_MAX
    ? `${t.slice(0, ETIQUETA_SERVICIO_MAX - 1).trimEnd()}…`
    : t;
}

/**
 * ¿Este mantenimiento es un servicio DEL AVIÓN?
 *
 * Un overhaul de motor o de hélice se guarda en la misma tabla con
 * `motor_id` / `helice_id`: entra al taller el COMPONENTE, no la célula, y
 * su `horas_aeronave` no es «el último servicio del avión». Colarlo aquí
 * pondría en el pizarrón un «último servicio» que nadie hizo.
 */
function esDelAvion(m: MantenimientoServicioRow): boolean {
  return m.motor_id == null && m.helice_id == null;
}

/** ¿Ya se hizo? (`estado` llegó después que las filas legadas: cuenta
 *  también `fecha_realizada`, igual que `ordenEstaAbierta`). */
function estaHecho(m: MantenimientoServicioRow): boolean {
  return m.estado === 'COMPLETADO' || m.fecha_realizada != null;
}

/**
 * El ÚLTIMO servicio hecho al avión = el mantenimiento COMPLETADO del AVIÓN
 * con `horas_aeronave` más ALTA (es el horómetro: solo sube, y la fecha de
 * captura miente más que el taco — hay servicios cargados semanas después).
 *
 * Empates: gana la `fecha_realizada` más reciente y, a igualdad, el `id`
 * menor — el resultado NO puede depender del orden en que PostgREST devuelva
 * las filas.
 *
 * Sin ningún servicio capturado cae a la BASE del programa
 * (`aeronave.servicio_horas_base`), que es justo desde dónde cuenta la
 * secuencia cíclica; con base 0 devuelve `null` (un «último servicio a las
 * 0 h» sería una mentira, no un dato).
 */
export function ultimoServicioDe(
  mantenimientos: readonly MantenimientoServicioRow[],
  base: number,
  etapas: readonly EtapaServicioFila[] = [],
): UltimoServicioFila | null {
  const hechos = mantenimientos.filter(
    (m) => esDelAvion(m) && estaHecho(m) && num(m.horas_aeronave) != null,
  );
  let mejor: MantenimientoServicioRow | null = null;
  let mejorHoras = -Infinity;
  for (const m of hechos) {
    const horas = num(m.horas_aeronave) as number;
    if (horas > mejorHoras) {
      mejor = m;
      mejorHoras = horas;
      continue;
    }
    if (horas < mejorHoras || mejor == null) continue;
    // Empate en el tacómetro: fecha más reciente; a igualdad, `id` menor.
    const fa = m.fecha_realizada ?? '';
    const fb = mejor.fecha_realizada ?? '';
    if (fa > fb || (fa === fb && (m.id ?? '') < (mejor.id ?? ''))) mejor = m;
  }

  if (mejor == null) {
    const b = num(base) ?? 0;
    if (b <= 0) return null;
    return { hobbs_hr: b, fecha: null, etiqueta: null, origen: 'BASE' };
  }

  const intervalo = num(mejor.etapa_intervalo_hr);
  const etapa =
    intervalo == null
      ? undefined
      : etapas.find(
          (e) => Math.abs(e.intervalo_hr - intervalo) <= TOLERANCIA_ETAPA_HR,
        );
  return {
    hobbs_hr: mejorHoras,
    fecha: (mejor.fecha_realizada as string | null) ?? null,
    etiqueta: etapa?.nombre ?? etiquetaDeDescripcion(mejor.descripcion),
    origen: 'MANTENIMIENTO',
  };
}

/**
 * Arma el campo `servicio` de UNA fila del listado.
 *
 * `null` = el avión NO tiene programa de servicio capturado (XB-IJP en
 * prod). Es distinto de «tiene programa y aún no hay datos»: ahí el panel
 * sí pinta el hito. Mismo criterio que `metrics.programa_configurado`.
 *
 * Sin tacómetro (`ultimoTaco == null`) el hito se calcula con 0 h, que con
 * `horas < base` da el PRIMER hito del programa (`base + intervalo menor`):
 * es exactamente lo que ya hace la ficha del avión (`aircraftMetrics` pasa
 * `maxHobbs ?? 0`), y el panel muestra «Tact. Actual —» al lado, así que no
 * puede leerse como «le faltan N horas» de verdad.
 *
 * `faltan_hr` viaja TAL CUAL sale de la fuente única: si algún día el hito
 * queda por debajo del tacómetro, el número debe salir NEGATIVO (el pizarrón
 * escribe «−30» en rojo). Recortarlo a 0 convertiría un servicio VENCIDO en
 * «justo a tiempo», que es el error más caro posible en esta tabla.
 */
export function armarServicioFila(args: {
  intervalos: unknown;
  base: unknown;
  ultimoTaco: number | null;
  etapas: readonly EtapaServicioFila[];
  mantenimientos: readonly MantenimientoServicioRow[];
  avisoAutomatico: { activo: boolean; umbral_hr: number } | null;
  proximo: ProximoServicioFn;
}): ServicioFlota | null {
  const intervalos = intervalosDePrograma(args.intervalos);
  if (intervalos.length === 0) return null;

  const base = num(args.base) ?? 0;
  const etapas = [...args.etapas];
  const prox = args.proximo(intervalos, base, args.ultimoTaco ?? 0, etapas);

  return {
    ultimo: ultimoServicioDe(args.mantenimientos, base, etapas),
    siguiente: prox
      ? {
          hobbs_hr: prox.a_las,
          intervalo_hr: prox.intervalo,
          etiqueta: prox.nombre ?? `Servicio de ${prox.intervalo} hr`,
          faltan_hr: prox.faltan,
          orden: ordenAbiertaDelHito(args.mantenimientos, prox),
        }
      : null,
    aviso_automatico: args.avisoAutomatico ?? null,
  };
}

/** Agrupa filas por `aeronave_id` (las lecturas en LOTE del listado). */
export function agruparPorAeronave<T extends { aeronave_id?: unknown }>(
  filas: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const f of filas) {
    const id = f.aeronave_id;
    if (typeof id !== 'string' || !id) continue;
    const lista = out.get(id);
    if (lista) lista.push(f);
    else out.set(id, [f]);
  }
  return out;
}
