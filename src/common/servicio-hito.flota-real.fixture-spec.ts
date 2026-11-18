/**
 * LA FLOTA REAL del 17-nov-2026 (prod `bjesduasnzbzywofukbf`): programa de
 * servicio, tacómetro y TODOS los mantenimientos del avión (ninguno es de
 * componente: `motor_id` / `helice_id` nulos) de los 7 aviones con programa.
 *
 * Es el caso que motivó la invariante 138. Reporte del cliente ese día: «en
 * el XA-VGV aparece vencido por 14 horas. Creo que solo se aplicó en ese
 * avión: el N4142R ya se venció por como cinco horas y aparece que faltan 45
 * horas, cuando debería decir vencido por cinco horas. Como que se brincó al
 * siguiente servicio de manera automática». El N621TX estaba igual («faltan
 * 97.6 h» al de 1,800 con el de 1,700 sin hacer).
 *
 * `esperado` es lo que el sistema TIENE que decir con la regla nueva; `antes`
 * es lo que decía en prod el 17-nov (solo donde cambia).
 *
 * Fuera del build (`*spec.ts`) y de jest (no termina en `.spec.ts`): patrón
 * `*.fixture-spec.ts` del repo. Lo comparten `servicio-hito.util.spec`,
 * `servicio-flota.util.spec` y `alerts.service.servicio-horas.spec`. Los `id`
 * son descriptivos (los uuid reales no aportan nada a la regla).
 */
import { NOTA_SERVICIO_AUTOMATICO } from './servicio-hito.util';

/** Fila de `mantenimiento` como la lee `MANT_SERVICIO_COLS`. Es un `type`
 *  (no `interface`) para que también sirva donde el arnés pide
 *  `Record<string, unknown>`. */
export type MantenimientoReal = {
  id: string;
  estado: 'PROGRAMADO' | 'EN_TALLER' | 'COMPLETADO';
  descripcion: string;
  horas_programadas: number | null;
  horas_aeronave: number | null;
  etapa_intervalo_hr: number | null;
  fecha_realizada: string | null;
  fecha_programada: string | null;
  notas: string | null;
  motor_id: null;
  helice_id: null;
};

export type AvionReal = {
  matricula: string;
  intervalos: number[];
  base: number;
  /** Tacómetro actual (el máximo de las escalas). */
  hobbs: number;
  mantenimientos: MantenimientoReal[];
  esperado: {
    a_las: number;
    intervalo: number;
    etapas_incluidas: number[];
    /** `a_las − hobbs`: NEGATIVO = «vencido por». */
    faltan: number;
    /** `id` de la orden ABIERTA del hito, o `null` si todavía no existe. */
    orden: string | null;
    /** ¿El dedupe del programa automático ya ve una orden para ese hito? */
    ya_tiene_orden: boolean;
  };
  /** Lo que decía prod el 17-nov-2026 (solo en los aviones que cambian). */
  antes?: { a_las: number; faltan: number };
};

const fila = (
  m: Pick<MantenimientoReal, 'id' | 'estado' | 'descripcion'> &
    Partial<MantenimientoReal>,
): MantenimientoReal => ({
  horas_programadas: null,
  horas_aeronave: null,
  etapa_intervalo_hr: null,
  fecha_realizada: null,
  fecha_programada: null,
  notas: null,
  motor_id: null,
  helice_id: null,
  ...m,
});

const NOTA_AUTO = `${NOTA_SERVICIO_AUTOMATICO} por el programa de servicio`;

/**
 * N4142R — EL CASO DEL REPORTE. La orden de 4,400 (etapa 100) se completó
 * TARDE, a 4,406 h. La regla 2 vieja del dedupe la daba por «hecha dentro del
 * ciclo» del hito de 4,500 ⇒ el programa nunca creó la orden de 4,500 ⇒ sin
 * orden abierta nada sostenía el hito y, al pasar las 4,500, brincó a 4,550.
 */
export const N4142R: AvionReal = {
  matricula: 'N4142R',
  intervalos: [50, 100, 500, 1000],
  base: 4200,
  hobbs: 4504.1,
  mantenimientos: [
    fila({
      id: 'n4142r-4250',
      estado: 'COMPLETADO',
      descripcion: '50 hrs',
      horas_programadas: 4250,
      horas_aeronave: 4254.5,
      fecha_realizada: '2026-04-24',
    }),
    fila({
      id: 'n4142r-4300',
      estado: 'COMPLETADO',
      descripcion: '100 HRS',
      horas_programadas: 4300,
      horas_aeronave: 4406.6,
      fecha_realizada: '2026-08-17',
    }),
    fila({
      id: 'n4142r-4400',
      estado: 'COMPLETADO',
      descripcion: 'servicio 100 hrs / anual',
      horas_programadas: 4400,
      horas_aeronave: 4406,
      etapa_intervalo_hr: 100,
      fecha_realizada: '2026-08-14',
      notas: `${NOTA_AUTO}…`,
    }),
    fila({
      id: 'n4142r-4450',
      estado: 'COMPLETADO',
      descripcion: '50 hrs',
      horas_programadas: 4450,
      horas_aeronave: 4455.1,
      fecha_realizada: '2026-09-12',
    }),
  ],
  esperado: {
    a_las: 4500,
    intervalo: 100,
    etapas_incluidas: [50, 100],
    faltan: -4.1,
    orden: null,
    ya_tiene_orden: false,
  },
  antes: { a_las: 4550, faltan: 45.9 },
};

/** N621TX — mismo defecto: la orden de 1,600 (etapa 100) se completó a
 *  1,632.7 y «cubría» el hito de 1,700. El «100» de 1,500 se hizo EN la base:
 *  no es un hito del programa (k ≥ 1) ni trae etapa ⇒ no cuenta. */
export const N621TX: AvionReal = {
  matricula: 'N621TX',
  intervalos: [100],
  base: 1500,
  hobbs: 1702.4,
  mantenimientos: [
    fila({
      id: 'n621tx-1500',
      estado: 'COMPLETADO',
      descripcion: '100',
      horas_programadas: 1500,
      horas_aeronave: 1500,
      fecha_realizada: '2026-05-08',
    }),
    fila({
      id: 'n621tx-1600',
      estado: 'COMPLETADO',
      descripcion: '100 HRS',
      horas_programadas: 1600,
      horas_aeronave: 1632.7,
      etapa_intervalo_hr: 100,
      fecha_realizada: '2026-09-14',
    }),
  ],
  esperado: {
    a_las: 1700,
    intervalo: 100,
    etapas_incluidas: [100],
    faltan: -2.4,
    orden: null,
    ya_tiene_orden: false,
  },
  antes: { a_las: 1800, faltan: 97.6 },
};

/** N58BT — el de 1,600 se cerró a 1,627.2 (declara su hito: 1,600) y la
 *  «HSI» de 1,800 sigue abierta, lejos. Igual que antes. */
export const N58BT: AvionReal = {
  matricula: 'N58BT',
  intervalos: [100],
  base: 1500,
  hobbs: 1627.8,
  mantenimientos: [
    fila({
      id: 'n58bt-hsi-1800',
      estado: 'PROGRAMADO',
      descripcion: 'HSI',
      horas_programadas: 1800,
    }),
    fila({
      id: 'n58bt-1600',
      estado: 'COMPLETADO',
      descripcion: '100 HRS / ANUAL',
      horas_programadas: 1600,
      horas_aeronave: 1627.2,
      fecha_realizada: '2026-09-24',
    }),
  ],
  esperado: {
    a_las: 1700,
    intervalo: 100,
    etapas_incluidas: [100],
    faltan: 72.2,
    orden: null,
    ya_tiene_orden: false,
  },
};

/** N990GG — el de 5,600 se hizo un poco ANTES (5,599.4) y la orden de 5,650
 *  ya existe, programada sin fecha. Igual que antes. */
export const N990GG: AvionReal = {
  matricula: 'N990GG',
  intervalos: [50, 100, 500, 1000],
  base: 5500,
  hobbs: 5601.3,
  mantenimientos: [
    fila({
      id: 'n990gg-5504',
      estado: 'COMPLETADO',
      descripcion: '50 Y 100 HRS',
      horas_aeronave: 5504.8,
      fecha_realizada: '2026-06-26',
    }),
    // Legado real: COMPLETADO pero SIN fecha_realizada.
    fila({
      id: 'n990gg-5550',
      estado: 'COMPLETADO',
      descripcion: '50 hrs',
      horas_programadas: 5550,
      horas_aeronave: 5544.5,
    }),
    fila({
      id: 'n990gg-5600',
      estado: 'COMPLETADO',
      descripcion: '100 HRS / ANUAL',
      horas_programadas: 5600,
      horas_aeronave: 5599.4,
      etapa_intervalo_hr: 100,
      fecha_realizada: '2026-11-13',
    }),
    fila({
      id: 'n990gg-5650',
      estado: 'PROGRAMADO',
      descripcion: '50 hrs',
      horas_programadas: 5650,
    }),
  ],
  esperado: {
    a_las: 5650,
    intervalo: 50,
    etapas_incluidas: [50],
    faltan: 48.7,
    orden: 'n990gg-5650',
    ya_tiene_orden: true,
  },
};

/** XA-VGV — el que SÍ decía «vencido por 14 h»: tiene su orden de 2,250
 *  abierta (EN_TALLER), que es lo único que sostenía un hito hasta hoy. */
export const XA_VGV: AvionReal = {
  matricula: 'XA-VGV',
  intervalos: [50, 100, 200, 500],
  base: 1750,
  hobbs: 2264.2,
  mantenimientos: [
    fila({
      id: 'xavgv-2162',
      estado: 'COMPLETADO',
      descripcion: '200 HRS',
      horas_aeronave: 2162.7,
      fecha_realizada: '2026-07-10',
    }),
    fila({
      id: 'xavgv-2212',
      estado: 'COMPLETADO',
      descripcion: '50 hrs',
      horas_programadas: 2212,
      horas_aeronave: 2216.9,
      etapa_intervalo_hr: 50,
      fecha_realizada: '2026-08-28',
    }),
    fila({
      id: 'xavgv-2250',
      estado: 'EN_TALLER',
      descripcion: 'Servicio de 500 hrs',
      horas_programadas: 2250,
      horas_aeronave: 2264.2,
      etapa_intervalo_hr: 500,
    }),
  ],
  esperado: {
    a_las: 2250,
    intervalo: 500,
    etapas_incluidas: [50, 100, 500],
    faltan: -14.2,
    orden: 'xavgv-2250',
    ya_tiene_orden: true,
  },
};

/** XB-PEV — base con decimales (329.6): el «50 hrs» automático de 379.6 se
 *  hizo a 379 y el siguiente es 429.6 (50 y 100 coinciden). Igual que antes. */
export const XB_PEV: AvionReal = {
  matricula: 'XB-PEV',
  intervalos: [50, 100, 200, 500],
  base: 329.6,
  hobbs: 398.6,
  mantenimientos: [
    fila({
      id: 'xbpev-ventana',
      estado: 'COMPLETADO',
      descripcion: 'Se puso la ventana',
      horas_aeronave: 313.2,
    }),
    fila({
      id: 'xbpev-300',
      estado: 'COMPLETADO',
      descripcion: 'Servicio 50,100',
      horas_programadas: 300,
      horas_aeronave: 329.6,
    }),
    fila({
      id: 'xbpev-379',
      estado: 'COMPLETADO',
      descripcion: '50 hrs',
      horas_programadas: 379.6,
      horas_aeronave: 379,
      etapa_intervalo_hr: 50,
      fecha_realizada: '2026-10-31',
      notas: `${NOTA_AUTO}…`,
    }),
  ],
  esperado: {
    a_las: 429.6,
    intervalo: 100,
    etapas_incluidas: [50, 100],
    faltan: 31,
    orden: null,
    ya_tiene_orden: false,
  },
};

/** XB-ANU — CERO mantenimientos capturados: sin ningún servicio hecho NO se
 *  inventa un vencido; sigue el programa cíclico desde el tacómetro. */
export const XB_ANU: AvionReal = {
  matricula: 'XB-ANU',
  intervalos: [50, 100, 200, 500],
  base: 1253.9,
  hobbs: 1381.6,
  mantenimientos: [],
  esperado: {
    a_las: 1403.9,
    intervalo: 50,
    etapas_incluidas: [50],
    faltan: 22.3,
    orden: null,
    ya_tiene_orden: false,
  },
};

export const FLOTA_REAL_17_NOV: AvionReal[] = [
  N4142R,
  N621TX,
  N58BT,
  N990GG,
  XA_VGV,
  XB_PEV,
  XB_ANU,
];
