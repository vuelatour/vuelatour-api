// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ExpirationsService } from '../expirations/expirations.service';

/**
 * `GET /v1/aircraft` → campo `servicio` (ADITIVO, 22-sep-2026).
 *
 * El cliente pidió que `/admin/aircraft` se pareciera al pizarrón
 * «Tacómetros» de la oficina: último servicio, siguiente, tiempo restante y
 * tipo. Este spec congela las DOS cosas que pueden romperse en silencio:
 *
 *  1. que el listado siga sirviendo esos números (cableado), y
 *  2. que los arme EN LOTE — un `etapasDeServicio(id)` por avión sería un
 *     N+1 que nadie ve hasta que la flota crece y la pantalla tarda.
 */

const AVIONES = [
  {
    id: 'a-n4142r',
    matricula: 'N4142R',
    servicio_intervalos: [50, 100, 500, 1000],
    servicio_horas_base: 4200,
  },
  {
    id: 'a-xavgv',
    matricula: 'XA-VGV',
    servicio_intervalos: [50, 100, 200, 500],
    servicio_horas_base: 1750,
  },
  {
    id: 'a-xbijp',
    matricula: 'XB-IJP',
    servicio_intervalos: [],
    servicio_horas_base: 0,
  },
];

/** Etapas reales de prod (con `aeronave_id`: el listado las lee de un jalón). */
const ETAPAS = [
  {
    id: 'e1',
    aeronave_id: 'a-n4142r',
    intervalo_hr: 50,
    nombre: 'Servicio 50 hrs',
    tareas: [],
  },
  {
    id: 'e2',
    aeronave_id: 'a-n4142r',
    intervalo_hr: 100,
    nombre: 'Servicio 100 hrs / Anual',
    tareas: [],
  },
  {
    id: 'e3',
    aeronave_id: 'a-xavgv',
    intervalo_hr: 50,
    nombre: 'Servicio 50 hrs',
    tareas: [],
  },
  {
    id: 'e4',
    aeronave_id: 'a-xavgv',
    intervalo_hr: 500,
    nombre: 'Servicio 500 hrs',
    tareas: [],
  },
];

const MANTENIMIENTOS = [
  {
    id: 'm-4455',
    aeronave_id: 'a-n4142r',
    estado: 'COMPLETADO',
    horas_aeronave: 4455.1,
    horas_programadas: 4450,
    etapa_intervalo_hr: null,
    fecha_realizada: '2026-09-12',
    fecha_programada: '2026-09-10',
    descripcion: '50 hrs',
    notas: null,
    motor_id: null,
    helice_id: null,
  },
  {
    id: 'm-2216',
    aeronave_id: 'a-xavgv',
    estado: 'COMPLETADO',
    horas_aeronave: 2216.9,
    horas_programadas: 2212,
    etapa_intervalo_hr: 50,
    fecha_realizada: '2026-08-28',
    fecha_programada: '2026-08-26',
    descripcion: '50 hrs',
    notas: null,
    motor_id: null,
    helice_id: null,
  },
  {
    id: 'm-2250',
    aeronave_id: 'a-xavgv',
    estado: 'PROGRAMADO',
    horas_aeronave: null,
    horas_programadas: 2250,
    etapa_intervalo_hr: 500,
    fecha_realizada: null,
    fecha_programada: null,
    descripcion: 'Servicio de 500 hrs — Servicio 500 hrs',
    notas: null,
    motor_id: null,
    helice_id: null,
  },
];

/** Tramos con taco (el listado deriva «Tact. Actual» de aquí). */
const ESCALAS = [
  {
    aeronave_id: 'a-n4142r',
    taco_salida: 4455.2,
    taco_llegada: 4458,
    vuelo: null,
  },
  {
    aeronave_id: null,
    taco_salida: 2239.5,
    taco_llegada: 2240.2,
    vuelo: { aeronave_id: 'a-xavgv' },
  },
];

type Res = { data: unknown; error: unknown; count: number | null };

function armar(aviones = AVIONES) {
  /** Cuántas consultas salieron por tabla (el candado anti-N+1). */
  const consultas: Record<string, number> = {};
  /** Cómo se armó cada consulta (el candado de PARIDAD con el detalle). */
  const filtros: Record<string, string[]> = {};
  const from = (tabla: string) => {
    consultas[tabla] = (consultas[tabla] ?? 0) + 1;
    const q: Record<string, unknown> = {};
    // Cualquier método de la cadena devuelve el mismo builder: lo que este
    // spec mide es CUÁNTAS consultas salen y, en `escala`, con qué filtros.
    const reg =
      (metodo: string) =>
      (...args: unknown[]) => {
        (filtros[tabla] ??= []).push(
          `${metodo}(${args.map((a) => JSON.stringify(a)).join(',')})`,
        );
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
      const datos: Record<string, unknown> = {
        aeronave: aviones,
        aeronave_imagen: [],
        escala: ESCALAS,
        aeronave_servicio_etapa: ETAPAS,
        mantenimiento: MANTENIMIENTOS,
        aeronave_discrepancia: [],
        motor: [],
        helice: [],
        aeronave_seguro: [],
        alerta_config: { activa: true, horas_anticipacion: 10 },
      };
      const data = datos[tabla] ?? [];
      return {
        data,
        error: null,
        count: Array.isArray(data) ? data.length : null,
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
    findBlockingExpirationsBulk: jest.fn().mockResolvedValue(new Map()),
  } as unknown as ExpirationsService;
  return {
    service: new AircraftService(supabase, expirations, {} as never),
    consultas,
    filtros,
  };
}

const LISTA = { limit: 50, offset: 0 } as never;

describe('AircraftService.list() → servicio (pizarrón de la oficina)', () => {
  it('cada fila trae último / siguiente / restante / tipo, y el avión sin programa trae null', async () => {
    const { service } = armar();
    const { data } = await service.list(LISTA);
    const por = new Map(data.map((a) => [a.matricula, a]));

    // «Tact. Actual» (el campo que ya existía) NO cambia.
    expect(por.get('N4142R')?.ultimo_taco).toBe(4458);
    expect(por.get('N4142R')?.servicio).toEqual({
      ultimo: {
        hobbs_hr: 4455.1,
        fecha: '2026-09-12',
        etiqueta: '50 hrs',
        origen: 'MANTENIMIENTO',
      },
      siguiente: {
        hobbs_hr: 4500,
        intervalo_hr: 100,
        etiqueta: 'Servicio 100 hrs / Anual',
        faltan_hr: 42,
        orden: null,
      },
      aviso_automatico: { activo: true, umbral_hr: 10 },
    });

    // Tramo heredado (escala sin avión propio): el taco es del vuelo.
    expect(por.get('XA-VGV')?.ultimo_taco).toBe(2240.2);
    expect(por.get('XA-VGV')?.servicio).toMatchObject({
      ultimo: { hobbs_hr: 2216.9, etiqueta: 'Servicio 50 hrs' },
      siguiente: {
        hobbs_hr: 2250,
        intervalo_hr: 500,
        etiqueta: 'Servicio 500 hrs',
        faltan_hr: 9.8,
        orden: { id: 'm-2250', estado: 'PROGRAMADO', automatica: false },
      },
    });

    // Sin programa capturado ⇒ `null` (el panel pinta «—», no un 0).
    expect(por.get('XB-IJP')?.servicio).toBeNull();
    expect(por.get('XB-IJP')?.ultimo_taco).toBeNull();
  });

  it('las etapas y los mantenimientos se leen UNA vez para toda la página (sin N+1)', async () => {
    const uno = armar([AVIONES[0]]);
    await uno.service.list(LISTA);
    const varios = armar();
    await varios.service.list(LISTA);

    // Una consulta a etapas y una al programa automático, con 1 avión o con N.
    expect(uno.consultas.aeronave_servicio_etapa).toBe(1);
    expect(varios.consultas.aeronave_servicio_etapa).toBe(1);
    expect(varios.consultas.alerta_config).toBe(1);
    // `mantenimiento` se lee dos veces: el semáforo EN_TALLER (aptitudBulk)
    // y el bloque `servicio`. Lo que importa es que NO crezca con la flota.
    expect(varios.consultas.mantenimiento).toBe(uno.consultas.mantenimiento);
    // Candado general: TODAS las tablas cuestan lo mismo con 1 avión que con
    // los 3 — si alguien mete una lectura por fila, este spec truena.
    expect(varios.consultas).toEqual(uno.consultas);
  });

  it('el Hobbs del listado sale del MISMO universo que el de la ficha (sin cancelados)', async () => {
    // El `siguiente` de la lista y el `proximo_servicio` de
    // `/aircraft/:id/metrics` tienen que dar EL MISMO hito, y los dos se
    // calculan con el Hobbs del avión. La ficha lo saca de `escalasDelAvion`
    // (tramo cancelado y vuelo CANCELADO FUERA); si la lista lee todas las
    // escalas, un vuelo cancelado con tacos capturados —los hay en prod— le
    // sube el Hobbs y la lista pinta otro hito, otras horas restantes y otro
    // TBO que el expediente del mismo avión.
    const { service, filtros } = armar();
    await service.list(LISTA);
    const escala = (filtros.escala ?? []).join(' ');
    expect(escala).toContain('is("cancelada_at",null)');
    expect(escala).toContain('neq("vuelo.estado","CANCELADO")');
    // `!inner`: sin el join interno PostgREST NO filtra la fila padre por una
    // columna del embebido — el `.neq` quedaría de adorno.
    expect(escala).toContain('vuelo:vuelo_id!inner');
    // Y sigue paginado (anti-cap-1000 de PostgREST).
    expect(escala).toContain('range(');
  });

  it('el campo es ADITIVO: el resto del contrato del listado sigue igual', async () => {
    const { service } = armar();
    const { data, count, limit, offset } = await service.list(LISTA);
    const fila = data[0];
    expect(count).toBe(3);
    expect(limit).toBe(50);
    expect(offset).toBe(0);
    for (const campo of [
      'matricula',
      'ultimo_taco',
      'apto',
      'no_apto_razones',
      'squawks_alta_abiertos',
      'en_taller',
      'imagen_principal_url',
    ]) {
      expect(fila).toHaveProperty(campo);
    }
  });
});
