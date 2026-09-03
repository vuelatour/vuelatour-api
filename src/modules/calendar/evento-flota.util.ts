/**
 * Eventos NO-vuelo de la flota (`evento_flota`) — helpers PUROS compartidos
 * por el calendario (GET /v1/calendar y GET /v1/me/eventos), los avisos al
 * responsable (calendar.service) y los recordatorios (alerts.service).
 *
 * Incidente 3-sep-2026 ("Llenar Bitácora"): el aviso al responsable se
 * persistía sin hora ni avión, el piloto no tenía dispositivo push, su app
 * no leía eventos y nadie en la oficina se enteró. Todo lo que aquí se
 * formatea lleva SIEMPRE hora Cancún, matrícula y notas cuando existen.
 */
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';

/** Shape público de un evento para su responsable (contrato /me/eventos). */
export interface EventoMe {
  id: string;
  titulo: string;
  /** Instante ISO (timestamptz). */
  fecha: string;
  fecha_fin: string | null;
  aeronave_id: string | null;
  aeronave_matricula: string | null;
  aeronave_color: string | null;
  notas: string | null;
  responsable_id: string | null;
  creado_por_nombre: string | null;
  created_at: string;
  updated_at: string;
}

/** EventoMe + lo que el servicio necesita internamente (no viaja a la app). */
export interface EventoInterno extends EventoMe {
  responsable_nombre: string | null;
  google_calendar_id: string | null;
  created_by: string | null;
}

/** Fila cruda de `evento_flota` con sus embeds (select EVENTO_FLOTA_COLS). */
export interface EventoFlotaRow {
  id: string;
  titulo: string;
  fecha: string;
  fecha_fin: string | null;
  aeronave_id: string | null;
  responsable_id: string | null;
  notas: string | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  google_calendar_id?: string | null;
  aeronave?:
    | { matricula?: string | null; color_calendario?: string | null }
    | Array<{ matricula?: string | null; color_calendario?: string | null }>
    | null;
  responsable?:
    | { nombre?: string | null }
    | Array<{ nombre?: string | null }>
    | null;
  creador?:
    | { nombre?: string | null }
    | Array<{ nombre?: string | null }>
    | null;
}

/** Columnas + embeds únicos para leer eventos (calendario, /me, alertas). */
export const EVENTO_FLOTA_COLS =
  'id, titulo, fecha, fecha_fin, aeronave_id, responsable_id, notas, created_at, updated_at, created_by, google_calendar_id, aeronave:aeronave_id(matricula, color_calendario), responsable:usuario!responsable_id(nombre), creador:usuario!created_by(nombre)';

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function mapEventoRow(row: EventoFlotaRow): EventoInterno {
  const aero = unwrap(row.aeronave);
  const resp = unwrap(row.responsable);
  const creador = unwrap(row.creador);
  return {
    id: row.id,
    titulo: row.titulo,
    fecha: row.fecha,
    fecha_fin: row.fecha_fin ?? null,
    aeronave_id: row.aeronave_id ?? null,
    aeronave_matricula: aero?.matricula ?? null,
    aeronave_color: aero?.color_calendario ?? null,
    notas: row.notas ?? null,
    responsable_id: row.responsable_id ?? null,
    creado_por_nombre: creador?.nombre ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    responsable_nombre: resp?.nombre ?? null,
    google_calendar_id: row.google_calendar_id ?? null,
    created_by: row.created_by ?? null,
  };
}

/** Proyección al contrato público (sin nombres/ids internos). */
export function aEventoMe(ev: EventoInterno): EventoMe {
  return {
    id: ev.id,
    titulo: ev.titulo,
    fecha: ev.fecha,
    fecha_fin: ev.fecha_fin,
    aeronave_id: ev.aeronave_id,
    aeronave_matricula: ev.aeronave_matricula,
    aeronave_color: ev.aeronave_color,
    notas: ev.notas,
    responsable_id: ev.responsable_id,
    creado_por_nombre: ev.creado_por_nombre,
    created_at: ev.created_at,
    updated_at: ev.updated_at,
  };
}

// ===== Formato de fecha/hora Cancún =====

const FMT_CORTA = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Cancun',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const FMT_HORA = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Cancun',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function instante(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${iso}`);
  return d;
}

/** "jue 3 sep, 09:45" en hora Cancún. */
export function fechaHoraCancunCorta(iso: string): string {
  const partes = Object.fromEntries(
    FMT_CORTA.formatToParts(instante(iso))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${partes.weekday} ${partes.day} ${partes.month}, ${partes.hour}:${partes.minute}`;
}

/** "09:45" en hora Cancún. */
export function horaCancun(iso: string): string {
  return FMT_HORA.format(instante(iso));
}

// ===== Cuerpo y payload de los avisos =====

export interface EventoParaAviso {
  id: string;
  titulo: string;
  fecha: string;
  aeronave_id?: string | null;
  aeronave_matricula?: string | null;
  notas?: string | null;
  responsable_id?: string | null;
}

/** Segmentos informativos: título · matrícula · notas (los vacíos se omiten). */
export function segmentosEvento(ev: EventoParaAviso): string[] {
  return [ev.titulo, ev.aeronave_matricula, ev.notas]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Cuerpo canónico de todo aviso de evento:
 * "jue 3 sep, 09:45 · Llenar Bitácora · XA-VGV · Está en la oficina ⚠️".
 * `encabezado` sustituye la fecha ("En 90 min · 09:45", "Mañana 09:45").
 */
export function cuerpoEvento(ev: EventoParaAviso, encabezado?: string): string {
  return [
    encabezado ?? fechaHoraCancunCorta(ev.fecha),
    ...segmentosEvento(ev),
  ].join(' · ');
}

/** `data` + `link` comunes a los 4 tipos de aviso de evento. */
export function avisoEventoBase(ev: EventoParaAviso): {
  data: {
    evento_id: string;
    titulo: string;
    fecha: string;
    fecha_dia: string;
    aeronave_id: string | null;
    aeronave_matricula: string | null;
    responsable_id: string | null;
  };
  link: string;
} {
  const fechaDia = diaCancun(ev.fecha);
  return {
    data: {
      evento_id: ev.id,
      titulo: ev.titulo,
      fecha: instante(ev.fecha).toISOString(),
      fecha_dia: fechaDia,
      aeronave_id: ev.aeronave_id ?? null,
      aeronave_matricula: ev.aeronave_matricula ?? null,
      responsable_id: ev.responsable_id ?? null,
    },
    link: `/me/eventos?dia=${fechaDia}`,
  };
}

/**
 * ¿Cambió algo que el responsable deba saber? (fecha, fin, avión, título,
 * notas). Un PATCH que no toca nada de esto no genera 'evento_actualizado'.
 */
export function cambiosRelevantes(
  prev: {
    titulo: string;
    fecha: string;
    fecha_fin: string | null;
    aeronave_id: string | null;
    notas: string | null;
  },
  next: {
    titulo: string;
    fecha: string;
    fecha_fin: string | null;
    aeronave_id: string | null;
    notas: string | null;
  },
): boolean {
  const ms = (iso: string | null): number | null =>
    iso ? instante(iso).getTime() : null;
  const txt = (s: string | null): string => (s ?? '').trim();
  return (
    txt(prev.titulo) !== txt(next.titulo) ||
    ms(prev.fecha) !== ms(next.fecha) ||
    ms(prev.fecha_fin) !== ms(next.fecha_fin) ||
    (prev.aeronave_id ?? null) !== (next.aeronave_id ?? null) ||
    txt(prev.notas) !== txt(next.notas)
  );
}

// ===== Rangos en cortes Cancún =====

export interface RangoCancun {
  /** YYYY-MM-DD */
  desde: string;
  /** YYYY-MM-DD */
  hasta: string;
  /** `${desde}T00:00:00-05:00` */
  desdeTs: string;
  /** `${hasta}T23:59:59-05:00` */
  hastaTs: string;
}

/** Suma días a una fecha de pared YYYY-MM-DD (sin zona: mediodía UTC). */
export function sumarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${dia}`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function rangoDiaCancun(
  desde: string,
  hasta: string = desde,
): RangoCancun {
  return {
    desde,
    hasta,
    desdeTs: `${desde}T00:00:00-05:00`,
    hastaTs: `${hasta}T23:59:59-05:00`,
  };
}

export const MIS_EVENTOS_DIAS_ATRAS = 7;
export const MIS_EVENTOS_DIAS_ADELANTE = 90;

/**
 * Rango de GET /v1/me/eventos: días Cancún; default hoy-7 → hoy+90. El
 * llamador valida `hasta >= desde` (aquí no hay excepciones de Nest).
 */
export function rangoMisEventos(
  desde?: string,
  hasta?: string,
  hoy: string = hoyCancun(),
): RangoCancun {
  return rangoDiaCancun(
    desde ?? sumarDias(hoy, -MIS_EVENTOS_DIAS_ATRAS),
    hasta ?? sumarDias(hoy, MIS_EVENTOS_DIAS_ADELANTE),
  );
}

// ===== Recordatorios (alerts.service) =====

export const RECORDATORIO_EVENTO_MIN = 90;

/** Ventana [now+89min, now+91min] en ISO — el cron corre cada minuto. */
export function ventanaRecordatorio90(nowMs: number): {
  desde: string;
  hasta: string;
} {
  return {
    desde: new Date(
      nowMs + (RECORDATORIO_EVENTO_MIN - 1) * 60_000,
    ).toISOString(),
    hasta: new Date(
      nowMs + (RECORDATORIO_EVENTO_MIN + 1) * 60_000,
    ).toISOString(),
  };
}

/** ¿El instante cae dentro de la ventana de 90 min? (inclusiva). */
export function enVentanaRecordatorio90(
  fechaIso: string,
  nowMs: number,
): boolean {
  const t = instante(fechaIso).getTime();
  const { desde, hasta } = ventanaRecordatorio90(nowMs);
  return t >= Date.parse(desde) && t <= Date.parse(hasta);
}

/** ISO UTC truncado al minuto ("2026-09-03T14:45Z"): reagendar la hora
 *  cambia la clave y el evento vuelve a avisar. */
export function isoAlMinuto(iso: string): string {
  return `${instante(iso).toISOString().slice(0, 16)}Z`;
}

export function claveRecordatorio90(
  eventoId: string,
  fechaIso: string,
): string {
  return `evento_90m:${eventoId}:${isoAlMinuto(fechaIso)}`;
}

export function claveVispera(eventoId: string, dia: string): string {
  return `evento_vispera:${eventoId}:${dia}`;
}

/** Día Cancún de MAÑANA (YYYY-MM-DD) respecto al instante dado. */
export function diaSiguienteCancun(now: Date = new Date()): string {
  return sumarDias(hoyCancun(now), 1);
}
