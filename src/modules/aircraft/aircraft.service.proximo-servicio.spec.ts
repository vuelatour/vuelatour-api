// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { AircraftService } from './aircraft.service';
import { NOTA_SERVICIO_AUTOMATICO } from '../../common/servicio-hito.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ExpirationsService } from '../expirations/expirations.service';

/**
 * `proximo_servicio.orden` (20-sep-2026, pedido de Porfirio).
 *
 * La tarjeta decía «Próximo servicio · a las 2,250 h · faltan 9.8 h» y nada
 * más: parecía que el aviso era solo ENUNCIATIVO. Ahora viaja la ORDEN que
 * cubre ese hito (si existe) con el MISMO criterio que usa el dedupe del
 * programa automático — si difirieran, o se duplicaría la orden o la tarjeta
 * mentiría.
 *
 * Campo ADITIVO: sin orden viva es `null` y el resto del contrato no cambia.
 */

const AVION = 'aaaaaaaa-0000-4000-8000-00000000xavg';
const INTERVALOS = [50, 100, 200];
const BASE = 1700;
/** 2,240.2 h con base 1,700 y etapa de 50 ⇒ hito 2,250 y faltan 9.8. */
const HOBBS = 2240.2;

type Res = { data?: unknown; error?: unknown; count?: number | null };
type Chain = Array<{ m: string; a: unknown[] }>;

/** `alerta_config.servicio_horas`: null = la fila no existe; 'error' = la
 *  lectura falla (no se puede afirmar nada). */
type ConfigServicio =
  | { activa: boolean; horas_anticipacion: number | null }
  | null
  | 'error';

function armar(
  mantenimientos: Array<Record<string, unknown>>,
  config: ConfigServicio = { activa: true, horas_anticipacion: 10 },
) {
  const handler = (tabla: string, chain: Chain): Res => {
    switch (tabla) {
      case 'alerta_config':
        if (config === 'error') return { error: { message: 'BD caída' } };
        return { data: config };
      case 'aeronave':
        return {
          data: {
            id: AVION,
            matricula: 'XA-VGV',
            activa: true,
            servicio_intervalos: INTERVALOS,
            servicio_horas_base: BASE,
            planeador_horas_base: 0,
            planeador_taco_ref: 0,
          },
        };
      case 'aeronave_servicio_etapa':
        return {
          data: [
            {
              id: 'et-50',
              intervalo_hr: 50,
              nombre: 'Servicio 500 hrs',
              tareas: ['Cambio de aceite'],
            },
          ],
        };
      case 'escala':
        // Tramos heredados: ninguno. Propios: la lectura que cruza el umbral.
        if (chain.some((c) => c.m === 'is' && c.a[0] === 'aeronave_id')) {
          return { data: [] };
        }
        return {
          data: [
            {
              taco_salida: 2239.5,
              taco_llegada: HOBBS,
              vuelo: {
                id: 'v-295',
                aeronave_id: AVION,
                fecha_vuelo: '2026-09-19T14:00:00Z',
                estado: 'COMPLETADO',
              },
            },
          ],
        };
      case 'mantenimiento':
        return { data: mantenimientos };
      default:
        return { data: [] };
    }
  };

  const from = (tabla: string) => {
    const chain: Chain = [];
    const q: Record<string, unknown> = {};
    const reg =
      (m: string) =>
      (...a: unknown[]) => {
        chain.push({ m, a });
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'neq',
      'is',
      'not',
      'in',
      'gt',
      'gte',
      'lt',
      'lte',
      'or',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = reg(m);
    }
    const resolver = (): Res => {
      const r = handler(tabla, chain);
      return {
        data: r.data ?? null,
        error: r.error ?? null,
        count: r.count ?? null,
      };
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.single = () => Promise.resolve(resolver());
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };

  const supabase = { service: { from } } as unknown as SupabaseService;
  const expirations = {
    findBlockingExpirations: jest.fn().mockResolvedValue([]),
  } as unknown as ExpirationsService;
  return new AircraftService(supabase, expirations, {} as never);
}

const ORDEN_MANUAL = {
  id: 'porfirio-0850',
  estado: 'PROGRAMADO',
  horas_programadas: 2250,
  etapa_intervalo_hr: null,
  fecha_realizada: null,
  fecha_programada: null,
  horas_aeronave: null,
  notas: null,
};

describe('aircraftMetrics().proximo_servicio.orden', () => {
  it('sin orden del hito ⇒ null (y el resto del contrato intacto)', async () => {
    const m = await armar([]).aircraftMetrics(AVION);
    expect(m.horas_actuales).toBe(2240.2);
    expect(m.proximo_servicio).toMatchObject({
      titulo: 'Servicio 500 hrs',
      horas_objetivo: 2250,
      faltan_hr: 9.8,
      orden: null,
    });
  });

  it('orden PROGRAMADA sin fecha (como nace la automática)', async () => {
    const m = await armar([
      {
        ...ORDEN_MANUAL,
        id: 'auto-1',
        notas: `${NOTA_SERVICIO_AUTOMATICO} por el programa de servicio: faltan 9.8 h…`,
      },
    ]).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.orden).toEqual({
      id: 'auto-1',
      estado: 'PROGRAMADO',
      fecha_programada: null,
      automatica: true,
    });
  });

  it('la orden que levantó el mecánico a mano viaja como automatica:false', async () => {
    const m = await armar([ORDEN_MANUAL]).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.orden).toEqual({
      id: 'porfirio-0850',
      estado: 'PROGRAMADO',
      fecha_programada: null,
      automatica: false,
    });
  });

  it('con fecha confirmada y EN_TALLER, la tarjeta lo puede decir', async () => {
    const conFecha = await armar([
      { ...ORDEN_MANUAL, fecha_programada: '2026-09-25' },
    ]).aircraftMetrics(AVION);
    expect(conFecha.proximo_servicio?.orden).toMatchObject({
      estado: 'PROGRAMADO',
      fecha_programada: '2026-09-25',
    });

    const enTaller = await armar([
      { ...ORDEN_MANUAL, estado: 'EN_TALLER', fecha_programada: '2026-09-25' },
    ]).aircraftMetrics(AVION);
    expect(enTaller.proximo_servicio?.orden?.estado).toBe('EN_TALLER');
    // El semáforo "en taller" sigue saliendo de la MISMA lectura.
    expect(enTaller.airworthiness.en_taller).toBe(true);
  });

  it('una orden COMPLETADA del hito no es orden pendiente (null), pero sí tapa el semáforo', async () => {
    const m = await armar([
      {
        ...ORDEN_MANUAL,
        estado: 'COMPLETADO',
        fecha_realizada: '2026-09-18',
        horas_aeronave: 2210,
        etapa_intervalo_hr: 50,
      },
    ]).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.orden).toBeNull();
    expect(m.airworthiness.en_taller).toBe(false);
  });

  it('una orden de OTRO hito no se atribuye a este', async () => {
    const m = await armar([
      { ...ORDEN_MANUAL, id: 'otro', horas_programadas: 2400 },
    ]).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.orden).toBeNull();
  });
});

/**
 * REVISIÓN ADVERSARIA (20-sep-2026). La tarjeta promete «la orden se genera
 * sola en unos minutos» cuando no hay orden y el avión ya entró al margen.
 * Esa promesa solo es cierta si la regla `servicio_horas` está ENCENDIDA, y
 * el margen no siempre es 10 h (el panel lo tenía en una constante). Decirlo
 * mal sería exactamente la queja original: «entonces es enunciativa».
 */
describe('proximo_servicio.aviso_automatico (ADITIVO)', () => {
  it('regla encendida: viaja el margen REAL de alerta_config', async () => {
    const m = await armar([], {
      activa: true,
      horas_anticipacion: 25,
    }).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.aviso_automatico).toEqual({
      activo: true,
      umbral_hr: 25,
    });
  });

  it('regla APAGADA: el panel puede dejar de prometer la orden', async () => {
    const m = await armar([], {
      activa: false,
      horas_anticipacion: 10,
    }).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.aviso_automatico).toEqual({
      activo: false,
      umbral_hr: 10,
    });
  });

  it('sin fila en alerta_config ⇒ apagada (safe() salta la regla)', async () => {
    const m = await armar([], null).aircraftMetrics(AVION);
    expect(m.proximo_servicio?.aviso_automatico).toEqual({
      activo: false,
      umbral_hr: 10,
    });
  });

  it('lectura fallida ⇒ null: NO se afirma nada (ni prendida ni apagada)', async () => {
    const m = await armar([], 'error').aircraftMetrics(AVION);
    expect(m.proximo_servicio?.aviso_automatico).toBeNull();
    // Y el resto de la tarjeta sigue respondiendo: nunca 500 por esto.
    expect(m.proximo_servicio?.faltan_hr).toBe(9.8);
  });

  it('la ficha de tacómetros manda lo MISMO que el KPI', async () => {
    const servicio = armar([], { activa: true, horas_anticipacion: 10 });
    const [kpi, historial] = await Promise.all([
      servicio.aircraftMetrics(AVION),
      servicio.tacometroHistorial(AVION),
    ]);
    expect(historial.proximo_servicio?.aviso_automatico).toEqual(
      kpi.proximo_servicio?.aviso_automatico,
    );
  });
});

describe('tacometroHistorial().proximo_servicio.orden', () => {
  it('la ficha de tacómetros ve EXACTAMENTE la misma orden que el KPI', async () => {
    const servicio = armar([ORDEN_MANUAL]);
    const [kpi, historial] = await Promise.all([
      servicio.aircraftMetrics(AVION),
      servicio.tacometroHistorial(AVION),
    ]);
    expect(historial.proximo_servicio).toMatchObject({
      a_las: 2250,
      intervalo: 50,
      faltan: 9.8,
      nombre: 'Servicio 500 hrs',
    });
    expect(historial.proximo_servicio?.orden).toEqual(
      kpi.proximo_servicio?.orden,
    );
  });

  it('sin programa capturado, proximo_servicio sigue siendo null', async () => {
    const servicio = armar([]);
    jest.spyOn(servicio, 'proximoServicioDetallado').mockReturnValue(null);
    const h = await servicio.tacometroHistorial(AVION);
    expect(h.proximo_servicio).toBeNull();
  });
});
