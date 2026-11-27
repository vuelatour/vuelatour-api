/**
 * HORARIOS DE LAS TAREAS RECURRENTES, ESCALONADOS (27-nov-2026, API 0.0.153,
 * invariante 148). FUENTE ÚNICA de las expresiones cron de todo lo que corre
 * cada hora o más seguido.
 *
 * Por qué existe: la base (cómputo Nano, 0.5 GB) se cayó el 25-nov a las
 * 17:01 y el 27-nov a las 17:00–17:02 (hora Cancún), las dos veces justo a
 * la HORA EN PUNTO. En el segundo 0 del minuto 0 arrancaban a la vez OCHO
 * tareas: la de cada hora, tres de cada 10 minutos, la de cada 5, dos de cada
 * minuto y la cola de Google. En los registros del 27-nov ese segundo trae
 * ~120 lecturas de `vuelo` y `escala` encima del tráfico de la oficina; dos
 * minutos después empiezan los timeouts.
 *
 * Regla: **ninguna tarea recurrente arranca en el mismo segundo que otra**
 * (lo congela `horarios-cron.spec.ts` expandiendo una hora completa). Cada
 * una conserva su FRECUENCIA; solo cambia el minuto o el segundo en que cae:
 *
 *   minuto que termina en 0 … alertas de cada hora (solo el :10)
 *   minuto que termina en 2 o 7 … relectura de folios de gastos (cada 5)
 *   minuto que termina en 3 … programa de servicio por horas (cada 10)
 *   minuto que termina en 5 … vigilante de tacómetros en vivo (cada 10)
 *   minuto que termina en 8 … relectura de folios de facturas (cada 10)
 *   segundo 0 de cada minuto … recordatorio de tacómetro de salida
 *   segundo 30 de cada minuto … recordatorio de eventos (90 min antes)
 *   segundos 15, 35 y 55 … cola de Google Calendar (cada 20 s)
 *
 * Las de minuto caen en el segundo 20 (no en el 0, que es del recordatorio de
 * cada minuto). Ninguna regla de negocio depende del segundo ni del minuto
 * exacto: los recordatorios trabajan con ventanas de minutos y deduplican.
 *
 * Una tarea recurrente NUEVA se da de alta AQUÍ (y en `TAREAS_RECURRENTES`),
 * no con una expresión suelta en su decorador: el spec la obliga a no chocar.
 * Las tareas DIARIAS (08:00, 09:00, 18:00, 04:45…) no viven aquí: corren una
 * vez y a horas distintas.
 */

/** Alertas de cada hora (`AlertsService.runHourly`): minuto 10, segundo 20. */
export const CRON_ALERTAS_CADA_HORA = '20 10 * * * *';

/** Recordatorio del tacómetro de salida: cada minuto, segundo 0. */
export const CRON_RECORDATORIO_TACO = '0 * * * * *';

/** Recordatorio de eventos (90 min antes): cada minuto, segundo 30. */
export const CRON_RECORDATORIO_EVENTOS = '30 * * * * *';

/** Programa de servicio por horas (malla de seguridad): minutos 3, 13, 23… */
export const CRON_SERVICIO_HORAS = '20 3-59/10 * * * *';

/** Vigilante de tacómetros en vivo: minutos 5, 15, 25… */
export const CRON_TACO_LIVE = '20 5-59/10 * * * *';

/** Relectura de folios de facturas recibidas: minutos 8, 18, 28… */
export const CRON_RECIBIDAS_RELEER_FOLIO = '20 8-59/10 * * * *';

/** Relectura de folios de gastos: minutos 2, 7, 12, 17… */
export const CRON_GASTOS_RELEER_FOLIO = '20 2-59/5 * * * *';

/** Cola de Google Calendar: cada 20 s, en los segundos 15, 35 y 55. */
export const CRON_CALENDAR_COLA = '15,35,55 * * * * *';

/** Todas, con nombre, para el spec que prohíbe que dos coincidan. */
export const TAREAS_RECURRENTES: ReadonlyArray<{
  nombre: string;
  cron: string;
}> = [
  { nombre: 'alertas-cada-hora', cron: CRON_ALERTAS_CADA_HORA },
  { nombre: 'recordatorio-taco', cron: CRON_RECORDATORIO_TACO },
  { nombre: 'recordatorio-eventos', cron: CRON_RECORDATORIO_EVENTOS },
  { nombre: 'servicio-horas', cron: CRON_SERVICIO_HORAS },
  { nombre: 'taco-live-deduce', cron: CRON_TACO_LIVE },
  { nombre: 'recibidas-releer-folio', cron: CRON_RECIBIDAS_RELEER_FOLIO },
  { nombre: 'gastos-releer-folio', cron: CRON_GASTOS_RELEER_FOLIO },
  { nombre: 'calendar-sync-cola', cron: CRON_CALENDAR_COLA },
];
