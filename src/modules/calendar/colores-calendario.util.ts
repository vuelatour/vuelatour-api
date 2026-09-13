/**
 * PALETA ÚNICA del calendario (12-sep-2026).
 *
 * Todos los hex que el calendario del SISTEMA (panel y app) usa para pintar
 * sus eventos viven aquí, y `colorVueloSistema` es la ÚNICA implementación de
 * la precedencia de color de un vuelo. `calendar.service` los consume para la
 * respuesta de `GET /calendar` y `google-evento.util` los traduce al colorId
 * más cercano de Google (pedido del cliente: «los mismos colores» en el
 * Google Calendar de la oficina).
 *
 * Regla: NADIE vuelve a escribir un hex de calendario suelto en un servicio.
 * Si el cliente quiere otro color, se cambia ACÁ y el sistema y Google se
 * mueven juntos — antes la sync de Google traía sus propias constantes y el
 * mismo evento salía de un color en el panel y de otro en Google.
 */

// ===== VUELOS (precedencia de arriba hacia abajo) =====

/**
 * Vuelo CANCELADO: se queda en el calendario del sistema como historial de
 * operaciones (pedido del cliente, ago 2026) — en rojo y con la etiqueta
 * CANCELADO. En GOOGLE no aplica: el evento de un cancelado se BORRA.
 */
export const CANCELADO_COLOR = '#EF4444';
/** Reserva tentativa: espacio apartado sin cotización ("espérame y te confirmo"). */
export const TENTATIVO_COLOR = '#64748B';
/** Vuelo propio confirmado pero todavía SIN avión o SIN piloto (acción pendiente). */
export const SIN_ASIGNAR_COLOR = '#8B5CF6';
/** Vuelo con permiso de pista PENDIENTE (alerta hasta que se emita). */
export const PERMISO_PENDIENTE_COLOR = '#F59E0B';
/** Paleta del equipo (21-ago-2026): externos en rosa pálido. */
export const EXTERNO_COLOR = '#F0DCDB';
/** Vuelo propio ya asignado cuyo avión no tiene `color_calendario`. */
export const SIN_AVION_COLOR = '#9CA3AF';

// ===== OTROS EVENTOS DEL CALENDARIO =====

/** Descanso de piloto (un evento por día de descanso). */
export const DESCANSO_COLOR = '#14B8A6';
/** Evento NO-vuelo de la flota SIN avión (con avión manda el color del avión). */
export const EVENTO_COLOR = '#0EA5E9';
/** Mantenimiento PROGRAMADO (mismo ámbar que el permiso pendiente). */
export const MANTENIMIENTO_PROGRAMADO_COLOR = '#F59E0B';
/** Mantenimiento EN_TALLER (mismo rojo que el cancelado). */
export const MANTENIMIENTO_TALLER_COLOR = '#EF4444';

/** Entradas de `colorVueloSistema` (todas opcionales: lo ausente es "no"). */
export interface ParamsColorVuelo {
  /** Estado del VUELO (`RESERVA`, `CONFIRMADO`, `CANCELADO`…). */
  estado?: string | null;
  /**
   * Cancelado EFECTIVO: el vuelo está CANCELADO **o** el tramo que se pinta
   * tiene `cancelada_at`. Sin pasarlo se deriva de `estado`.
   */
  cancelado?: boolean | null;
  esExterno?: boolean | null;
  /** Avión del TRAMO con herencia del vuelo (null = falta asignar). */
  aeronaveId?: string | null;
  /** Piloto del TRAMO con herencia del vuelo (null = falta asignar). */
  pilotoId?: string | null;
  /** `estado_permiso === 'pendiente'` del tramo (o del vuelo si no hay tramo). */
  permisoPendiente?: boolean | null;
  /** `aeronave.color_calendario` del avión efectivo. */
  colorAvion?: string | null;
}

/**
 * ¿Vuelo propio CONFIRMADO al que le falta avión o piloto? Es la condición
 * del morado "⚠ Falta asignar" y también viaja en la respuesta del calendario
 * como `sin_asignar`.
 */
export function vueloSinAsignar(p: ParamsColorVuelo): boolean {
  return (
    p.estado === 'CONFIRMADO' && !p.esExterno && (!p.aeronaveId || !p.pilotoId)
  );
}

/**
 * Color del sistema para UN evento de vuelo (vuelo completo o tramo), con la
 * precedencia que el calendario ya usaba:
 *
 *   cancelado > tentativo (RESERVA) > sin asignar > permiso pendiente >
 *   externo > color del avión > sin avión (#9CA3AF)
 *
 * El cancelado domina (es historial) y el tentativo va antes que todo lo
 * demás porque un espacio apartado no es un vuelo firme: sus pendientes no se
 * anuncian todavía.
 */
export function colorVueloSistema(p: ParamsColorVuelo): string {
  const cancelado = p.cancelado ?? p.estado === 'CANCELADO';
  if (cancelado) return CANCELADO_COLOR;
  if (p.estado === 'RESERVA') return TENTATIVO_COLOR;
  if (vueloSinAsignar(p)) return SIN_ASIGNAR_COLOR;
  if (p.permisoPendiente) return PERMISO_PENDIENTE_COLOR;
  if (p.esExterno) return EXTERNO_COLOR;
  return p.colorAvion ?? SIN_AVION_COLOR;
}

/** Color del sistema para un mantenimiento con fecha. */
export function colorMantenimientoSistema(enTaller: boolean): string {
  return enTaller ? MANTENIMIENTO_TALLER_COLOR : MANTENIMIENTO_PROGRAMADO_COLOR;
}

/** Color del sistema para un evento NO-vuelo (con avión manda el avión). */
export function colorEventoFlotaSistema(colorAvion?: string | null): string {
  return colorAvion ?? EVENTO_COLOR;
}
