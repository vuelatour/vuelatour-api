// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
// `notifications` arrastra el gateway y `jose` (ESM puro), `calendar-sync`
// arrastra googleapis y `pyservices` el cliente HTTP de reportes.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { Logger } from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { AlertsService } from './alerts.service';
import { NOTA_SERVICIO_AUTOMATICO } from '../../common/servicio-hito.util';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * PROGRAMA DE SERVICIO POR HORAS — REVISIÓN INMEDIATA (20-sep-2026).
 *
 * Caso real (XA-VGV, 19-sep-2026, Porfirio):
 *  - 08:00 corrió el cron diario con Hobbs 2,238.8 → faltaban 11.2 h ⇒ nada.
 *  - 08:40-08:42 la oficina capturó los tacos del vuelo #295 y el avión quedó
 *    en 2,240.2 → «faltan 9.8 h» en la tarjeta (que calcula EN VIVO).
 *  - 08:49 captura de pantalla: leyenda visible y NINGUNA orden.
 *  - 08:50 Porfirio la creó a mano.
 * El defecto no era la generación (funciona): era la LATENCIA de hasta 24 h.
 * Ahora cada escritura de tacómetro dispara `revisarServicioDeAvion` y, como
 * red, un cron cada 10 min. Lo único imperdonable sería DUPLICAR la orden.
 */

const AVION = 'aaaaaaaa-0000-4000-8000-00000000xavg';
const MATRICULA = 'XA-VGV';
// Programa real del avión: base 1,700 h con etapas 50/100/200.
// Con 2,240.2 h el hito más cercano es 2,250 (etapa de 50 h) ⇒ faltan 9.8.
const INTERVALOS = [50, 100, 200];
const BASE = 1700;

type Res = { data?: unknown; error?: unknown; count?: number | null };
type Eslabon = { m: string; a: unknown[] };
type Chain = Eslabon[];

interface Escenario {
  /** Lecturas de tacómetro del avión (el máximo manda). MUTABLE a propósito:
   *  el test de la carrera cambia el Hobbs a media corrida. */
  tacos?: number[];
  /** Páginas de escalas (para simular el tope de 1000 de PostgREST). */
  paginasEscala?: number[][];
  /** Filas de `mantenimiento` que ya existen para el avión. */
  mantenimientos?: Array<Record<string, unknown>>;
  configActiva?: boolean;
  avionActivo?: boolean;
  /** Etapas del programa (nombre y tareas del hito). */
  etapas?: Array<Record<string, unknown>>;
  /** Motores/hélices SIN `aeronave_horas_ref` (para `anclarRefsComponentes`). */
  componentesSinAncla?: Array<Record<string, unknown>>;
  /** Puerta para detener una lectura de `escala` (n = # de lectura, desde 0)
   *  y colar otra llamada mientras la primera sigue en vuelo. */
  puertaEscala?: (n: number) => Promise<void> | void;
}

function armar(e: Escenario = {}) {
  const inserts: Array<{ tabla: string; valores: Record<string, unknown> }> =
    [];
  const updates: Array<{ tabla: string; valores: Record<string, unknown> }> =
    [];
  const lecturas: Array<{ tabla: string; chain: Chain }> = [];

  // Se recalcula en CADA lectura: `e.tacos` puede cambiar a media corrida.
  const paginasAhora = () => e.paginasEscala ?? [e.tacos ?? [2240.2]];
  // `mantenimiento` vive entre lecturas (la BD real también).
  const mantenimientosVivos: Array<Record<string, unknown>> = [
    ...(e.mantenimientos ?? []),
  ];

  const handler = (tabla: string, chain: Chain): Res => {
    const tiene = (m: string, arg0?: unknown) =>
      chain.some((c) => c.m === m && (arg0 === undefined || c.a[0] === arg0));
    const argDe = (m: string, i = 1) => chain.find((c) => c.m === m)?.a[i];

    if (tabla === 'alerta_config') {
      return {
        data: {
          clave: 'servicio_horas',
          descripcion: 'Servicio por horas cerca',
          activa: e.configActiva ?? true,
          canal: 'socket',
          roles: ['ADMIN', 'COORDINADOR', 'MECANICO'],
          dias_anticipacion: [],
          horas_anticipacion: 10,
        },
      };
    }
    if (tabla === 'aeronave') {
      const fila = {
        id: AVION,
        matricula: MATRICULA,
        activa: e.avionActivo ?? true,
        servicio_intervalos: INTERVALOS,
        servicio_horas_base: BASE,
      };
      // Barrido de flota: `.eq('activa', true)` ⇒ lista. Hook: `.eq('id',…)`.
      return tiene('eq', 'activa') ? { data: [fila] } : { data: fila };
    }
    if (tabla === 'aeronave_servicio_etapa') {
      const etapas = e.etapas ?? [
        {
          id: 'et-50',
          aeronave_id: AVION,
          intervalo_hr: 50,
          nombre: 'Servicio 500 hrs',
          tareas: ['Cambio de aceite', 'Filtros'],
        },
      ];
      return { data: etapas };
    }
    if (tabla === 'escala') {
      // Tramos heredados (sin avión propio): ninguno en este escenario.
      if (chain.some((c) => c.m === 'is' && c.a[0] === 'aeronave_id')) {
        return { data: [] };
      }
      const from = Number(argDe('range', 0) ?? 0);
      const pagina = paginasAhora()[Math.floor(from / 1000)] ?? [];
      return {
        data: pagina.map((t, i) => ({
          taco_salida: null,
          taco_llegada: t,
          vuelo: { id: `v-${i}`, aeronave_id: AVION, estado: 'COMPLETADO' },
        })),
      };
    }
    if (tabla === 'mantenimiento') {
      if (tiene('insert')) {
        // La BD falsa PERSISTE: una segunda pasada tiene que VER la orden
        // recién creada y no duplicarla (es lo que hace el dedupe real).
        const valores = chain.find((c) => c.m === 'insert')?.a[0] as Record<
          string,
          unknown
        >;
        const id = `mant-nuevo-${mantenimientosVivos.length + 1}`;
        mantenimientosVivos.push({ id, fecha_realizada: null, ...valores });
        return { data: { id } };
      }
      return { data: mantenimientosVivos };
    }
    if (tabla === 'motor' || tabla === 'helice') {
      if (tiene('update')) return { data: null };
      // Solo `anclarRefsComponentes` consulta estas tablas en este spec.
      return {
        data: (e.componentesSinAncla ?? []).filter(
          (c) => (c.tabla ?? tabla) === tabla,
        ),
      };
    }
    if (tabla === 'alerta_emitida') {
      // Nada emitido todavía (el dedupe mensual del aviso no estorba).
      return { data: [], count: 0 };
    }
    return { data: [] };
  };

  let lecturasEscala = 0;
  const from = (tabla: string) => {
    const chain: Chain = [];
    const q: Record<string, unknown> = {};
    const reg =
      (m: string) =>
      (...a: unknown[]) => {
        chain.push({ m, a });
        if (m === 'insert') {
          inserts.push({ tabla, valores: a[0] as Record<string, unknown> });
        }
        if (m === 'update') {
          updates.push({ tabla, valores: a[0] as Record<string, unknown> });
        }
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
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = reg(m);
    }
    const resolver = async (): Promise<Res> => {
      lecturas.push({ tabla, chain });
      // Los datos se materializan ANTES de la puerta: así la corrida detenida
      // se queda con el Hobbs VIEJO, que es justo lo que pasa cuando otra
      // captura se guarda mientras la revisión está en vuelo.
      const r = handler(tabla, chain);
      if (tabla === 'escala' && e.puertaEscala) {
        await e.puertaEscala(lecturasEscala++);
      }
      return {
        data: r.data ?? null,
        error: r.error ?? null,
        count: r.count ?? null,
      };
    };
    q.maybeSingle = () => resolver();
    q.single = () => resolver();
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      resolver().then(resolve, reject);
    return q;
  };

  const supabase = { service: { from } } as unknown as SupabaseService;
  const nada = {} as never;
  // AircraftService REAL: `currentHobbs` (fuente única del Hobbs, paginada) y
  // `proximoServicioDetallado` (la aritmética del hito) son las de producción.
  const aircraft = new AircraftService(supabase, nada, nada);
  const notifyRole = jest
    .fn<Promise<number>, [string, { cuerpo: string }]>()
    .mockResolvedValue(1);
  const syncMantenimiento = jest.fn().mockResolvedValue(undefined);
  const alerts = new AlertsService(
    supabase,
    aircraft,
    nada,
    { notifyRole } as never,
    { sendAlert: jest.fn() } as never,
    nada,
    { syncMantenimiento } as never,
  );
  return { alerts, inserts, updates, lecturas, notifyRole, syncMantenimiento };
}

const mantsCreados = (
  inserts: Array<{ tabla: string; valores: Record<string, unknown> }>,
) => inserts.filter((i) => i.tabla === 'mantenimiento');

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('revisarServicioDeAvion — hook inmediato al capturar tacómetro', () => {
  it('19-sep 08:00 (2,238.8 h, faltan 11.2): fuera del umbral ⇒ ninguna orden', async () => {
    const { alerts, inserts, notifyRole } = armar({ tacos: [2238.8] });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
    expect(notifyRole).not.toHaveBeenCalled();
  });

  it('19-sep 08:42 (2,240.2 h, faltan 9.8): la orden queda creada EN EL MOMENTO', async () => {
    const { alerts, inserts, notifyRole, syncMantenimiento } = armar({
      tacos: [2238.8, 2239.5, 2240.2],
    });
    await alerts.revisarServicioDeAvion(AVION);

    const creados = mantsCreados(inserts);
    expect(creados).toHaveLength(1);
    expect(creados[0].valores).toMatchObject({
      aeronave_id: AVION,
      estado: 'PROGRAMADO',
      tipo: 'PROGRAMADO',
      descripcion: 'Servicio 500 hrs',
      horas_programadas: 2250,
      etapa_intervalo_hr: 50,
    });
    // Nace SIN fecha: el mecánico confirma cuándo entra al taller.
    expect(creados[0].valores.fecha_programada).toBeUndefined();
    // El prefijo es el que lee `orden.automatica` en la ficha del avión.
    expect(String(creados[0].valores.notas)).toContain(
      NOTA_SERVICIO_AUTOMATICO,
    );
    expect(String(creados[0].valores.notas)).toContain('faltan 9.8 h');
    expect(String(creados[0].valores.notas)).toContain('tacómetro 2240.2');
    // Mismo aviso y mismo espejo a Google que el barrido diario.
    expect(notifyRole).toHaveBeenCalled();
    expect(syncMantenimiento).toHaveBeenCalledWith('mant-nuevo-1');
    const cuerpo = notifyRole.mock.calls[0][1].cuerpo;
    expect(cuerpo).toContain('Faltan 9.8 hrs');
    expect(cuerpo).toContain('Tacómetro actual: 2240.2');
  });

  it('NO duplica la orden que el mecánico levantó A MANO para el mismo hito', async () => {
    const { alerts, inserts, notifyRole } = armar({
      tacos: [2240.2],
      mantenimientos: [
        {
          id: 'porfirio-0850',
          estado: 'PROGRAMADO',
          horas_programadas: 2250,
          etapa_intervalo_hr: null,
          fecha_realizada: null,
          fecha_programada: null,
          horas_aeronave: null,
          notas: null,
        },
      ],
    });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
    // El aviso sí sale (es lo que pasó el 20-sep a las 08:00).
    expect(notifyRole).toHaveBeenCalled();
  });

  it('NO duplica la orden AUTOMÁTICA que ya creó una corrida anterior', async () => {
    const { alerts, inserts } = armar({
      tacos: [2240.2],
      mantenimientos: [
        {
          id: 'auto-previa',
          estado: 'PROGRAMADO',
          horas_programadas: 2250,
          notas: `${NOTA_SERVICIO_AUTOMATICO} por el programa de servicio…`,
        },
      ],
    });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
  });

  it('dos llamadas CONCURRENTES al mismo avión ⇒ UN solo insert', async () => {
    const { alerts, inserts } = armar({ tacos: [2240.2] });
    await Promise.all([
      alerts.revisarServicioDeAvion(AVION),
      alerts.revisarServicioDeAvion(AVION),
      alerts.revisarServicioDeAvion(AVION),
    ]);
    expect(mantsCreados(inserts)).toHaveLength(1);
  });

  it('la revisión queda liberada: una segunda pasada posterior vuelve a evaluar', async () => {
    const { alerts, lecturas } = armar({ tacos: [2240.2] });
    await alerts.revisarServicioDeAvion(AVION);
    const antes = lecturas.filter((l) => l.tabla === 'mantenimiento').length;
    await alerts.revisarServicioDeAvion(AVION);
    expect(
      lecturas.filter((l) => l.tabla === 'mantenimiento').length,
    ).toBeGreaterThan(antes);
  });

  it('alerta_config.servicio_horas inactiva ⇒ no toca nada', async () => {
    const { alerts, inserts, lecturas } = armar({
      tacos: [2240.2],
      configActiva: false,
    });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
    expect(lecturas.some((l) => l.tabla === 'aeronave')).toBe(false);
  });

  it('avión dado de baja (activa=false) ⇒ fuera del programa', async () => {
    const { alerts, inserts } = armar({
      tacos: [2240.2],
      avionActivo: false,
    });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
  });

  it('NUNCA lanza: un id vacío o una BD caída solo dejan un warn', async () => {
    const { alerts } = armar({ tacos: [2240.2] });
    await expect(alerts.revisarServicioDeAvion('')).resolves.toBeUndefined();
    const roto = new AlertsService(
      {
        service: {
          from: () => {
            throw new Error('BD caída');
          },
        },
      } as unknown as SupabaseService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(roto.revisarServicioDeAvion(AVION)).resolves.toBeUndefined();
  });
});

describe('Carrera real: una captura llega con la revisión YA en vuelo', () => {
  /**
   * REVISIÓN ADVERSARIA (20-sep-2026). Así fue el caso XA-VGV: la oficina
   * capturó los tres tramos del vuelo #295 entre las 08:40 y las 08:42, y el
   * outbox de la app sube sus capturas en ráfaga. Si la revisión de la
   * PRIMERA lectura ya está en vuelo cuando entra la segunda, la segunda se
   * descartaba en silencio — y la primera había leído el Hobbs VIEJO (2,238.8,
   * faltan 11.2 ⇒ nada). Nadie veía las 2,240.2 y la orden se quedaba
   * esperando al cron de 10 min: justo la latencia que este trabajo elimina.
   */
  it('la lectura que cruza el umbral NO se pierde: la orden se crea igual', async () => {
    let abrir: () => void = () => undefined;
    const enVuelo = new Promise<void>((r) => {
      abrir = r;
    });
    let primeraLeyendo: () => void = () => undefined;
    const yaLeyendo = new Promise<void>((r) => {
      primeraLeyendo = r;
    });

    const escenario: Escenario = {
      tacos: [2238.8],
      // La PRIMERA lectura de escalas se queda detenida (candado tomado).
      puertaEscala: async (n) => {
        if (n === 0) {
          primeraLeyendo();
          await enVuelo;
        }
      },
    };
    const { alerts, inserts } = armar(escenario);

    const primera = alerts.revisarServicioDeAvion(AVION);
    await yaLeyendo;
    // Mientras tanto la oficina guarda los dos tacos que faltan del #295.
    escenario.tacos = [2238.8, 2239.5, 2240.2];
    await alerts.revisarServicioDeAvion(AVION);
    abrir();
    await primera;

    const creados = mantsCreados(inserts);
    expect(creados).toHaveLength(1);
    expect(creados[0].valores.horas_programadas).toBe(2250);
    expect(String(creados[0].valores.notas)).toContain('tacómetro 2240.2');
  });

  it('sin lecturas nuevas NO se repite la pasada: una orden y UN aviso', async () => {
    const { alerts, inserts, notifyRole } = armar({ tacos: [2240.2] });
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(1);
    // Un dispatch = una llamada por ROL configurado (ADMIN, COORDINADOR,
    // MECANICO). Dos pasadas habrían mandado seis.
    expect(notifyRole).toHaveBeenCalledTimes(3);
  });
});

describe('Hobbs del check = Hobbs de la tarjeta (anti-cap-1000)', () => {
  it('con >1000 escalas el máximo REAL manda (PostgREST corta en 1000)', async () => {
    // Página 1: 1000 lecturas viejas. Página 2: la lectura que cruza el
    // umbral. Sin paginar, el check vería 2,100 h y el servicio no
    // dispararía NUNCA.
    const pagina1 = Array.from({ length: 1000 }, (_, i) => 1800 + i * 0.3);
    const { alerts, inserts } = armar({
      paginasEscala: [pagina1, [2240.2]],
    });
    await alerts.revisarServicioDeAvion(AVION);
    const creados = mantsCreados(inserts);
    expect(creados).toHaveLength(1);
    expect(creados[0].valores.horas_programadas).toBe(2250);
    expect(String(creados[0].valores.notas)).toContain('tacómetro 2240.2');
  });

  /**
   * El ancla de componentes ESCRIBE el Hobbs en `aeronave_horas_ref`
   * (invariante 1: horas vivas = horas_totales + max(0, hobbs − ref)). Ese
   * cálculo también armaba el máximo con un `select … from escala` de toda la
   * flota SIN paginar: con >1000 escalas el ancla quedaba BAJA y las horas
   * del motor infladas para siempre. Hoy usa la misma fuente única paginada.
   */
  it('el ancla de motores/hélices usa el MISMO Hobbs paginado', async () => {
    const pagina1 = Array.from({ length: 1000 }, (_, i) => 1800 + i * 0.3);
    const { alerts, updates } = armar({
      paginasEscala: [pagina1, [2240.2]],
      componentesSinAncla: [
        { tabla: 'motor', id: 'mot-1', aeronave_id: AVION, numero_serie: 'M1' },
      ],
    });
    await (
      alerts as unknown as { anclarRefsComponentes: () => Promise<void> }
    ).anclarRefsComponentes();
    const anclas = updates.filter((u) => u.tabla === 'motor');
    expect(anclas).toHaveLength(1);
    expect(anclas[0].valores.aeronave_horas_ref).toBe(2240.2);
  });

  it('sin componentes por anclar no se lee NINGUNA escala', async () => {
    const { alerts, lecturas } = armar({ tacos: [2240.2] });
    await (
      alerts as unknown as { anclarRefsComponentes: () => Promise<void> }
    ).anclarRefsComponentes();
    expect(lecturas.some((l) => l.tabla === 'escala')).toBe(false);
  });
});

describe('runServicioHoras — red de seguridad cada 10 min', () => {
  it('corre el MISMO cuerpo sobre la flota activa', async () => {
    const { alerts, inserts, notifyRole } = armar({ tacos: [2240.2] });
    await alerts.runServicioHoras();
    const creados = mantsCreados(inserts);
    expect(creados).toHaveLength(1);
    expect(creados[0].valores).toMatchObject({
      aeronave_id: AVION,
      horas_programadas: 2250,
      etapa_intervalo_hr: 50,
    });
    expect(notifyRole).toHaveBeenCalled();
  });

  it('se salta si el barrido diario ya está corriendo (no pelea el insert)', async () => {
    const { alerts, inserts, lecturas } = armar({ tacos: [2240.2] });
    (alerts as unknown as { barridoEnCurso: boolean }).barridoEnCurso = true;
    await alerts.runServicioHoras();
    expect(mantsCreados(inserts)).toHaveLength(0);
    expect(lecturas).toHaveLength(0);
  });

  it('con el barrido en curso, el hook tampoco duplica', async () => {
    const { alerts, inserts } = armar({ tacos: [2240.2] });
    (alerts as unknown as { barridoEnCurso: boolean }).barridoEnCurso = true;
    await alerts.revisarServicioDeAvion(AVION);
    expect(mantsCreados(inserts)).toHaveLength(0);
  });
});
