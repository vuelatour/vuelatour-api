// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { AircraftService } from './aircraft.service';
import {
  armarServicioFila,
  ultimoServicioDe,
  type EtapaServicioFila,
  type MantenimientoServicioRow,
  type ProximoServicioFn,
} from './servicio-flota.util';
import {
  FLOTA_REAL_17_NOV,
  N4142R,
  N58BT,
  N621TX,
  type AvionReal,
} from '../../common/servicio-hito.flota-real.fixture-spec';

/**
 * «ÚLTIMO / SIGUIENTE SERVICIO» del listado de la flota (22-sep-2026).
 *
 * El cliente mandó foto del pizarrón «Tacómetros» de la oficina y pidió que
 * `/admin/aircraft` se pareciera a esa tabla. Los casos de este spec son
 * DATOS REALES de producción (bjesduasnzbzywofukbf, leídos el 22-sep-2026):
 * si alguien cambia la regla, el spec dice exactamente qué avión empieza a
 * mentir en la pantalla que la oficina mira a diario.
 *
 * El hito NO se recalcula aquí: se inyecta el MISMO
 * `AircraftService.proximoServicioDetallado` que usa la ficha del avión, así
 * que un cambio en la fuente única se ve en este spec.
 */

const svc = new AircraftService(
  undefined as never,
  undefined as never,
  undefined as never,
);
const PROXIMO: ProximoServicioFn = (intervalos, base, horas, etapas, mants) =>
  svc.proximoServicioDetallado(intervalos, base, horas, etapas, mants);

const etapa = (
  intervalo_hr: number,
  nombre: string | null,
): EtapaServicioFila => ({ intervalo_hr, nombre, tareas: [] });

/** Fila de `mantenimiento` como la devuelve `MANT_SERVICIO_COLS`. */
const mant = (
  m: Partial<MantenimientoServicioRow> & { id: string },
): MantenimientoServicioRow => ({
  estado: null,
  horas_programadas: null,
  etapa_intervalo_hr: null,
  fecha_realizada: null,
  fecha_programada: null,
  horas_aeronave: null,
  notas: null,
  descripcion: null,
  motor_id: null,
  helice_id: null,
  ...m,
});

const fila = (args: {
  intervalos: unknown;
  base: unknown;
  ultimoTaco: number | null;
  etapas?: EtapaServicioFila[];
  mantenimientos?: MantenimientoServicioRow[];
  aviso?: { activo: boolean; umbral_hr: number } | null;
  proximo?: ProximoServicioFn;
}) =>
  armarServicioFila({
    intervalos: args.intervalos,
    base: args.base,
    ultimoTaco: args.ultimoTaco,
    etapas: args.etapas ?? [],
    mantenimientos: args.mantenimientos ?? [],
    avisoAutomatico:
      'aviso' in args ? (args.aviso ?? null) : { activo: true, umbral_hr: 10 },
    proximo: args.proximo ?? PROXIMO,
  });

// ───────────────────────── Aviones REALES de producción ─────────────────────

describe('servicio de la flota — casos REALES (prod, 22-sep-2026)', () => {
  it('N4142R: último 4455.1 «50 hrs» del 12-sep; siguiente 4500 «Servicio 100 hrs / Anual»', () => {
    const s = fila({
      intervalos: [50, 100, 500, 1000],
      base: 4200,
      ultimoTaco: 4458,
      etapas: [
        etapa(50, 'Servicio 50 hrs'),
        etapa(100, 'Servicio 100 hrs / Anual'),
        etapa(500, 'Servicio de 500 hrs'),
        etapa(1000, 'Servicio de 1000 hrs'),
      ],
      mantenimientos: [
        mant({
          id: 'm-4254',
          estado: 'COMPLETADO',
          horas_aeronave: 4254.5,
          horas_programadas: 4250,
          fecha_realizada: '2026-04-24',
          descripcion: '50 hrs',
        }),
        // Legado real: COMPLETADO pero SIN fecha_realizada.
        mant({
          id: 'm-4406',
          estado: 'COMPLETADO',
          horas_aeronave: 4406,
          horas_programadas: 4400,
          etapa_intervalo_hr: 100,
          descripcion: 'servicio 100 hrs / anual',
        }),
        mant({
          id: 'm-44066',
          estado: 'COMPLETADO',
          horas_aeronave: 4406.6,
          horas_programadas: 4300,
          fecha_realizada: '2026-08-17',
          descripcion: '100 HRS',
        }),
        mant({
          id: 'm-4455',
          estado: 'COMPLETADO',
          horas_aeronave: 4455.1,
          horas_programadas: 4450,
          fecha_realizada: '2026-09-12',
          descripcion: '50 hrs',
        }),
      ],
    });
    // «Últ. Tact. Serv.» del pizarrón: manda el TACÓMETRO más alto, no la
    // fecha de captura (hay servicios cargados semanas después).
    expect(s?.ultimo).toEqual({
      hobbs_hr: 4455.1,
      fecha: '2026-09-12',
      // La fila real no trae `etapa_intervalo_hr`: la etiqueta sale de la
      // descripción, TAL CUAL la capturó la oficina.
      etiqueta: '50 hrs',
      origen: 'MANTENIMIENTO',
    });
    // Base 4200 + ciclos de 50 y 100 coinciden en 4500: gana la etiqueta del
    // servicio MAYOR (el de 100 incluye al de 50).
    expect(s?.siguiente).toEqual({
      hobbs_hr: 4500,
      intervalo_hr: 100,
      etiqueta: 'Servicio 100 hrs / Anual',
      faltan_hr: 42,
      orden: null,
    });
    expect(s?.aviso_automatico).toEqual({ activo: true, umbral_hr: 10 });
  });

  it('XA-VGV: siguiente 2250 «Servicio 500 hrs», faltan 9.8, con la orden PROGRAMADA del hito', () => {
    const s = fila({
      intervalos: [50, 100, 200, 500],
      base: 1750,
      ultimoTaco: 2240.2,
      etapas: [
        etapa(50, 'Servicio 50 hrs'),
        etapa(100, 'Servicio 100 hrs / Anual'),
        etapa(200, 'Servicio 200 hrs'),
        etapa(500, 'Servicio 500 hrs'),
      ],
      mantenimientos: [
        mant({
          id: 'm-2162',
          estado: 'COMPLETADO',
          horas_aeronave: 2162.7,
          fecha_realizada: '2026-07-10',
          descripcion: '200 HRS',
        }),
        mant({
          id: 'm-2216',
          estado: 'COMPLETADO',
          horas_aeronave: 2216.9,
          horas_programadas: 2212,
          etapa_intervalo_hr: 50,
          fecha_realizada: '2026-08-28',
          descripcion: '50 hrs',
        }),
        mant({
          id: 'af81ccf5-65b3-477d-bcbc-9ecc871d35b7',
          estado: 'PROGRAMADO',
          horas_programadas: 2250,
          etapa_intervalo_hr: 500,
          descripcion: 'Servicio de 500 hrs — Servicio 500 hrs',
        }),
      ],
    });
    // Aquí la fila SÍ trae etapa (50) ⇒ manda el nombre de la etapa.
    expect(s?.ultimo).toEqual({
      hobbs_hr: 2216.9,
      fecha: '2026-08-28',
      etiqueta: 'Servicio 50 hrs',
      origen: 'MANTENIMIENTO',
    });
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 2250,
      intervalo_hr: 500,
      etiqueta: 'Servicio 500 hrs',
      faltan_hr: 9.8,
    });
    // La orden real de prod NO trae la nota del programa automático
    // (`notas: null`): la levantaron desde el panel, no el cron ⇒ el mismo
    // criterio que el dedupe dice `automatica: false`. El panel no puede
    // prometer «la creó el sistema» de algo que capturó una persona.
    expect(s?.siguiente?.orden).toEqual({
      id: 'af81ccf5-65b3-477d-bcbc-9ecc871d35b7',
      estado: 'PROGRAMADO',
      fecha_programada: null,
      automatica: false,
    });
  });

  it('XA-VGV el 27-oct-2026: taco 2,264.2 con la orden de 2,250 PROGRAMADA ⇒ el hito NO brinca a 2,300 (vencido por 14.2 h)', () => {
    // Pedido del cliente (invariante 108): «que tenga un contador negativo
    // hasta que se marque de concluido el servicio». Datos reales de prod.
    const ordenAbierta = mant({
      id: 'af81ccf5-65b3-477d-bcbc-9ecc871d35b7',
      estado: 'PROGRAMADO',
      horas_programadas: '2250',
      etapa_intervalo_hr: '500.00',
      fecha_programada: '2026-10-23',
      descripcion: 'Servicio de 500 hrs — Servicio 500 hrs',
    });
    const hechos = [
      mant({
        id: 'm-2162',
        estado: 'COMPLETADO',
        horas_aeronave: 2162.7,
        fecha_realizada: '2026-07-10',
        descripcion: '200 HRS',
      }),
      mant({
        id: 'm-2216',
        estado: 'COMPLETADO',
        horas_aeronave: 2216.9,
        horas_programadas: 2212,
        etapa_intervalo_hr: 50,
        fecha_realizada: '2026-08-28',
        descripcion: '50 hrs',
      }),
    ];
    const etapas = [
      etapa(50, 'Servicio 50 hrs'),
      etapa(100, 'Servicio 100 hrs / Anual'),
      etapa(200, 'Servicio 200 hrs'),
      etapa(500, 'Servicio 500 hrs'),
    ];
    const s = fila({
      intervalos: [50, 100, 200, 500],
      base: 1750,
      ultimoTaco: 2264.2,
      etapas,
      mantenimientos: [...hechos, ordenAbierta],
    });
    expect(s?.ultimo).toMatchObject({
      hobbs_hr: 2216.9,
      etiqueta: 'Servicio 50 hrs',
    });
    expect(s?.siguiente).toEqual({
      hobbs_hr: 2250,
      intervalo_hr: 500,
      etiqueta: 'Servicio 500 hrs',
      faltan_hr: -14.2,
      orden: {
        id: 'af81ccf5-65b3-477d-bcbc-9ecc871d35b7',
        estado: 'PROGRAMADO',
        fecha_programada: '2026-10-23',
        automatica: false,
      },
    });

    // Al marcar esa orden COMPLETADO (entró a 2,270 el 28-oct) la lista
    // avanza al siguiente hito del programa: 2,300 (50 hrs), faltan 35.8.
    const cerrada = mant({
      ...ordenAbierta,
      estado: 'COMPLETADO',
      horas_aeronave: 2270,
      fecha_realizada: '2026-10-28',
    });
    const despues = fila({
      intervalos: [50, 100, 200, 500],
      base: 1750,
      ultimoTaco: 2264.2,
      etapas,
      mantenimientos: [...hechos, cerrada],
    });
    expect(despues?.ultimo).toEqual({
      hobbs_hr: 2270,
      fecha: '2026-10-28',
      etiqueta: 'Servicio 500 hrs',
      origen: 'MANTENIMIENTO',
    });
    expect(despues?.siguiente).toEqual({
      hobbs_hr: 2300,
      intervalo_hr: 50,
      etiqueta: 'Servicio 50 hrs',
      faltan_hr: 35.8,
      orden: null,
    });
  });

  it('N58BT: sin servicios capturados ⇒ último = BASE del programa, y la orden EN_TALLER de 1600 ya alcanzada sostiene el hito (vencido por 27.2 h)', () => {
    const s = fila({
      intervalos: [100],
      base: 1500,
      ultimoTaco: 1627.2,
      // Etapa real SIN nombre.
      etapas: [etapa(100, null)],
      mantenimientos: [
        mant({
          id: 'm-taller',
          estado: 'EN_TALLER',
          horas_programadas: 1600,
          horas_aeronave: 1627.2,
          fecha_programada: '2026-08-13',
          descripcion: '100 HRS / ANUAL',
        }),
        mant({
          id: 'm-hsi',
          estado: 'PROGRAMADO',
          horas_programadas: 1800,
          descripcion: 'HSI',
        }),
      ],
    });
    // Ningún mantenimiento COMPLETADO: el arranque de la secuencia es la
    // base. `origen: 'BASE'` es lo que el panel usa para decir «base del
    // programa» en vez de inventar un servicio que nadie hizo.
    expect(s?.ultimo).toEqual({
      hobbs_hr: 1500,
      fecha: null,
      etiqueta: null,
      origen: 'BASE',
    });
    // Etapa sin nombre ⇒ etiqueta genérica (igual que la ficha del avión).
    // Hasta el 26-oct-2026 la fila decía «faltan 72.8 h» al hito de 1700 con
    // el avión PARADO en el taller por el de 1600 (correcto y tranquilizador
    // de más). Con el hito pendiente (invariante 108) la orden EN_TALLER ya
    // alcanzada ES el próximo servicio, en negativo, hasta que se complete.
    expect(s?.siguiente).toEqual({
      hobbs_hr: 1600,
      intervalo_hr: 100,
      etiqueta: 'Servicio de 100 hr',
      faltan_hr: -27.2,
      orden: {
        id: 'm-taller',
        estado: 'EN_TALLER',
        fecha_programada: '2026-08-13',
        automatica: false,
      },
    });
    // La orden de 1800 («HSI») sigue adelante: no se alcanza todavía.
  });

  it('N990GG: el último servicio real viene SIN fecha_realizada ⇒ fecha null (y no se inventa)', () => {
    const s = fila({
      intervalos: [50, 100, 500, 1000],
      base: 5500,
      ultimoTaco: 5577.4,
      etapas: [
        etapa(50, 'Servicio 50 hrs'),
        etapa(100, 'Servicio 100 hrs / Anual'),
        etapa(500, 'Servicio 500 hrs'),
        etapa(1000, 'Servicio de 1000 hrs'),
      ],
      mantenimientos: [
        mant({
          id: 'm-5504',
          estado: 'COMPLETADO',
          horas_aeronave: 5504.8,
          fecha_realizada: '2026-06-26',
          descripcion: '50 Y 100 HRS',
        }),
        mant({
          id: 'm-5544',
          estado: 'COMPLETADO',
          horas_aeronave: 5544.5,
          horas_programadas: 5550,
          fecha_programada: '2026-08-06',
          descripcion: '50 hrs',
        }),
        mant({
          id: 'm-5600',
          estado: 'PROGRAMADO',
          horas_programadas: 5600,
          descripcion: '100 HRS / ANUAL',
        }),
        mant({
          id: 'm-5650',
          estado: 'PROGRAMADO',
          horas_programadas: 5650,
          descripcion: '50 hrs',
        }),
      ],
    });
    expect(s?.ultimo).toEqual({
      hobbs_hr: 5544.5,
      // `fecha_programada` NO es «cuándo se hizo»: mejor vacío que falso.
      fecha: null,
      etiqueta: '50 hrs',
      origen: 'MANTENIMIENTO',
    });
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 5600,
      intervalo_hr: 100,
      faltan_hr: 22.6,
      orden: { id: 'm-5600', estado: 'PROGRAMADO', automatica: false },
    });
  });

  it('XB-IJP (inactivo, sin programa) ⇒ servicio null: el panel pinta «—», no un cero', () => {
    expect(fila({ intervalos: [], base: 0, ultimoTaco: null })).toBeNull();
    // `servicio_intervalos` nulo o basura se trata igual que «sin programa».
    expect(fila({ intervalos: null, base: 0, ultimoTaco: 100 })).toBeNull();
    expect(fila({ intervalos: [0, -50], base: 0, ultimoTaco: 100 })).toBeNull();
  });

  it('XB-PEV: avión con programa y taco recién arrancado (366.2 sobre base 329.6)', () => {
    const s = fila({
      intervalos: [50, 100, 200, 500],
      base: 329.6,
      ultimoTaco: 366.2,
      etapas: [
        etapa(50, '50 hrs'),
        etapa(100, '100 hrs'),
        etapa(200, '200 hrs'),
        etapa(500, '500 hrs'),
      ],
      mantenimientos: [
        mant({
          id: 'm-313',
          estado: 'COMPLETADO',
          horas_aeronave: 313.2,
          fecha_realizada: '2026-06-13',
          descripcion: 'Se puso la ventana',
        }),
        mant({
          id: 'm-329',
          estado: 'COMPLETADO',
          horas_aeronave: 329.6,
          horas_programadas: 300,
          fecha_programada: '2026-07-19',
          descripcion: 'Servicio 50,100',
        }),
      ],
    });
    expect(s?.ultimo).toMatchObject({
      hobbs_hr: 329.6,
      etiqueta: 'Servicio 50,100',
    });
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 379.6,
      intervalo_hr: 50,
      etiqueta: '50 hrs',
      faltan_hr: 13.4,
    });
  });
});

// ───────────────────────────── Reglas del helper ────────────────────────────

describe('ultimoServicioDe', () => {
  it('el overhaul de un COMPONENTE no es el servicio del avión', () => {
    const u = ultimoServicioDe(
      [
        mant({
          id: 'm-avion',
          estado: 'COMPLETADO',
          horas_aeronave: 1200,
          fecha_realizada: '2026-05-01',
          descripcion: '100 hrs',
        }),
        // Entró al taller el MOTOR, no la célula: su tacómetro es más alto
        // pero no dice nada del servicio del avión.
        mant({
          id: 'm-motor',
          estado: 'COMPLETADO',
          horas_aeronave: 1300,
          fecha_realizada: '2026-07-01',
          descripcion: 'Overhaul motor',
          motor_id: 'mot-1',
        }),
        mant({
          id: 'm-helice',
          estado: 'COMPLETADO',
          horas_aeronave: 1400,
          fecha_realizada: '2026-08-01',
          descripcion: 'Overhaul hélice',
          helice_id: 'hel-1',
        }),
      ],
      1000,
    );
    expect(u).toMatchObject({ hobbs_hr: 1200, etiqueta: '100 hrs' });
  });

  it('empate de tacómetro: gana la fecha más reciente y, a igualdad, el id menor', () => {
    const filas = [
      mant({
        id: 'b',
        estado: 'COMPLETADO',
        horas_aeronave: 900,
        fecha_realizada: '2026-03-01',
        descripcion: 'vieja',
      }),
      mant({
        id: 'a',
        estado: 'COMPLETADO',
        horas_aeronave: 900,
        fecha_realizada: '2026-06-01',
        descripcion: 'nueva',
      }),
    ];
    expect(ultimoServicioDe(filas, 800)?.etiqueta).toBe('nueva');
    // El resultado NO depende del orden en que lleguen las filas.
    expect(ultimoServicioDe([...filas].reverse(), 800)?.etiqueta).toBe('nueva');

    const mismaFecha = [
      mant({
        id: 'z',
        estado: 'COMPLETADO',
        horas_aeronave: 900,
        fecha_realizada: '2026-06-01',
        descripcion: 'z',
      }),
      mant({
        id: 'a',
        estado: 'COMPLETADO',
        horas_aeronave: 900,
        fecha_realizada: '2026-06-01',
        descripcion: 'a',
      }),
    ];
    expect(ultimoServicioDe(mismaFecha, 800)?.etiqueta).toBe('a');
    expect(ultimoServicioDe([...mismaFecha].reverse(), 800)?.etiqueta).toBe(
      'a',
    );
  });

  it('una orden ABIERTA (PROGRAMADO / EN_TALLER) todavía no es «último servicio»', () => {
    expect(
      ultimoServicioDe(
        [
          mant({
            id: 'abierta',
            estado: 'PROGRAMADO',
            horas_aeronave: 1500,
            descripcion: '100 hrs',
          }),
        ],
        900,
      ),
    ).toEqual({ hobbs_hr: 900, fecha: null, etiqueta: null, origen: 'BASE' });
  });

  it('sin servicios y con base 0 ⇒ null (no se inventa «último servicio a las 0 h»)', () => {
    expect(ultimoServicioDe([], 0)).toBeNull();
  });

  it('COMPLETADO sin horas_aeronave se ignora (no se puede decir CON QUÉ taco se hizo)', () => {
    expect(
      ultimoServicioDe(
        [
          mant({
            id: 'x',
            estado: 'COMPLETADO',
            fecha_realizada: '2026-09-01',
          }),
        ],
        700,
      ),
    ).toMatchObject({ hobbs_hr: 700, origen: 'BASE' });
  });

  it('la descripción larga se recorta para la celda del listado', () => {
    const largo =
      'Servicio mayor con cambio de aceite, bujías, filtros, mangueras y revisión de tren';
    const u = ultimoServicioDe(
      [
        mant({
          id: 'x',
          estado: 'COMPLETADO',
          horas_aeronave: 100,
          descripcion: largo,
        }),
      ],
      50,
    );
    expect(u?.etiqueta?.length).toBeLessThanOrEqual(60);
    expect(u?.etiqueta?.endsWith('…')).toBe(true);
  });
});

describe('armarServicioFila', () => {
  it('sin tacómetro: el hito se calcula con 0 h ⇒ el PRIMER hito del programa', () => {
    // Decisión (22-sep-2026): misma que la ficha del avión, que pasa
    // `maxHobbs ?? 0`. El panel muestra «Tact. Actual —» al lado, así que no
    // puede leerse como «le faltan N horas» de verdad.
    const s = fila({
      intervalos: [50, 100],
      base: 1253.9,
      ultimoTaco: null,
      etapas: [etapa(50, 'Servicio 50 hrs')],
    });
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 1303.9,
      intervalo_hr: 50,
      etiqueta: 'Servicio 50 hrs',
    });
  });

  it('un hito YA PASADO viaja con faltan_hr NEGATIVO: jamás se recorta a 0', () => {
    // El pizarrón de la oficina escribe «−30» en rojo. Si el helper
    // recortara a 0, un servicio VENCIDO se vería «justo a tiempo»: el error
    // más caro posible en esta tabla. (Hoy la fuente única siempre devuelve
    // el siguiente múltiplo ESTRICTAMENTE arriba del taco, así que el
    // negativo solo puede nacer de un cambio en esa regla — este spec es el
    // candado para ese día.)
    const s = fila({
      intervalos: [100],
      base: 1500,
      ultimoTaco: 1630,
      proximo: () => ({
        a_las: 1600,
        intervalo: 100,
        faltan: -30,
        nombre: '100 hrs',
      }),
    });
    expect(s?.siguiente).toMatchObject({ hobbs_hr: 1600, faltan_hr: -30 });
  });

  it('el aviso automático viaja tal cual (incluido el null de «no se pudo leer»)', () => {
    expect(
      fila({
        intervalos: [100],
        base: 1000,
        ultimoTaco: 1010,
        aviso: { activo: false, umbral_hr: 25 },
      })?.aviso_automatico,
    ).toEqual({ activo: false, umbral_hr: 25 });
    expect(
      fila({ intervalos: [100], base: 1000, ultimoTaco: 1010, aviso: null })
        ?.aviso_automatico,
    ).toBeNull();
  });

  it('el hito lo decide la FUENTE ÚNICA: el helper solo ensambla (y le pasa las órdenes)', () => {
    const espia = jest.fn(PROXIMO);
    const orden = mant({
      id: 'o-1',
      estado: 'PROGRAMADO',
      horas_programadas: 4500,
    });
    fila({
      intervalos: [50, 100],
      base: 4200,
      ultimoTaco: 4458,
      etapas: [etapa(100, 'Servicio 100 hrs / Anual')],
      mantenimientos: [orden],
      proximo: espia,
    });
    expect(espia).toHaveBeenCalledTimes(1);
    // Las órdenes viajan como 5.º argumento (hito pendiente, invariante 108).
    expect(espia).toHaveBeenCalledWith(
      [50, 100],
      4200,
      4458,
      [etapa(100, 'Servicio 100 hrs / Anual')],
      [orden],
    );
  });
});

// ───────── El programa no avanza solo (18-nov-2026, invariante 138) ─────────

/**
 * Reporte del cliente (17-nov-2026): «en el XA-VGV aparece vencido por 14
 * horas. Creo que solo se aplicó en ese avión: el N4142R ya se venció por
 * como cinco horas y aparece que faltan 45 horas, cuando debería decir
 * vencido por cinco horas. Como que se brincó al siguiente servicio de manera
 * automática».
 *
 * Los 7 aviones con programa, con sus datos REALES de ese día
 * (`servicio-hito.flota-real.fixture-spec`), pasando por la MISMA fuente
 * única que la lista, la ficha y el programa automático.
 */
describe('flota REAL del 17-nov-2026 — el próximo servicio no brinca (invariante 138)', () => {
  const filaReal = (
    a: AvionReal,
    mantenimientos: MantenimientoServicioRow[] = a.mantenimientos,
    ultimoTaco: number = a.hobbs,
  ) =>
    fila({
      intervalos: a.intervalos,
      base: a.base,
      ultimoTaco,
      mantenimientos,
    });

  it.each(FLOTA_REAL_17_NOV)(
    '$matricula a $hobbs h: siguiente servicio a las $esperado.a_las (faltan $esperado.faltan)',
    (a) => {
      const s = filaReal(a);
      expect(s?.siguiente).toMatchObject({
        hobbs_hr: a.esperado.a_las,
        intervalo_hr: a.esperado.intervalo,
        faltan_hr: a.esperado.faltan,
      });
      expect(s?.siguiente?.orden?.id ?? null).toBe(a.esperado.orden);
      // La fuente única, entera (la FORMA de la respuesta no cambia).
      expect(
        svc.proximoServicioDetallado(
          a.intervalos,
          a.base,
          a.hobbs,
          [],
          a.mantenimientos,
        ),
      ).toEqual({
        a_las: a.esperado.a_las,
        intervalo: a.esperado.intervalo,
        faltan: a.esperado.faltan,
        nombre: null,
        etapas_incluidas: a.esperado.etapas_incluidas,
        tareas: [],
      });
    },
  );

  it('N4142R: «vencido por 4.1 h» al hito de 4,500 (100 hrs / anual), SIN orden todavía — antes decía «faltan 45.9 h» al de 4,550', () => {
    const s = fila({
      intervalos: N4142R.intervalos,
      base: N4142R.base,
      ultimoTaco: N4142R.hobbs,
      etapas: [
        etapa(50, 'Servicio 50 hrs'),
        etapa(100, 'Servicio 100 hrs / Anual'),
        etapa(500, 'Servicio de 500 hrs'),
        etapa(1000, 'Servicio de 1000 hrs'),
      ],
      mantenimientos: N4142R.mantenimientos,
    });
    expect(s?.siguiente).toEqual({
      hobbs_hr: 4500,
      intervalo_hr: 100,
      etiqueta: 'Servicio 100 hrs / Anual',
      faltan_hr: -4.1,
      orden: null,
    });
    // El «último servicio» no cambia: el tacómetro más alto con el que se
    // hizo uno (el «50 hrs» de 4,455.1).
    expect(s?.ultimo).toMatchObject({ hobbs_hr: 4455.1, etiqueta: '50 hrs' });
    // Lo que decía prod el 17-nov es justo el programa cíclico a secas…
    expect(
      svc.proximoServicio(N4142R.intervalos, N4142R.base, N4142R.hobbs),
    ).toEqual({ a_las: 4550, intervalo: 50, faltan: 45.9 });
    // …que sigue siendo lo que responden las llamadas SIN las órdenes (la
    // línea informativa del balance por avión): comportamiento histórico.
    expect(
      svc.proximoServicioDetallado(
        N4142R.intervalos,
        N4142R.base,
        N4142R.hobbs,
        [],
      ),
    ).toMatchObject({ a_las: 4550, intervalo: 50, faltan: 45.9 });
  });

  it('N4142R con la orden de 4,500 ya creada por el programa: sigue vencido y la lista ya trae la orden', () => {
    const orden = mant({
      id: 'auto-4500',
      estado: 'PROGRAMADO',
      horas_programadas: 4500,
      etapa_intervalo_hr: 100,
      notas:
        'Creado automáticamente por el programa de servicio: el hito de 4500 h ya se alcanzó (vencido por 4.1 h, tacómetro 4504.1). Confirma la fecha de entrada al taller.',
    });
    const s = filaReal(N4142R, [...N4142R.mantenimientos, orden]);
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 4500,
      intervalo_hr: 100,
      faltan_hr: -4.1,
      orden: {
        id: 'auto-4500',
        estado: 'PROGRAMADO',
        fecha_programada: null,
        automatica: true,
      },
    });
  });

  it('al completar la orden vencida el programa avanza UN hito: N4142R ⇒ 4,550 (faltan 45.9); N621TX ⇒ 1,800 (faltan 97.6)', () => {
    const n4142r = filaReal(N4142R, [
      ...N4142R.mantenimientos,
      mant({
        id: 'auto-4500',
        estado: 'COMPLETADO',
        horas_programadas: 4500,
        etapa_intervalo_hr: 100,
        horas_aeronave: 4504.1,
        fecha_realizada: '2026-11-18',
      }),
    ]);
    expect(n4142r?.siguiente).toMatchObject({
      hobbs_hr: 4550,
      intervalo_hr: 50,
      faltan_hr: 45.9,
      orden: null,
    });
    expect(n4142r?.ultimo).toMatchObject({ hobbs_hr: 4504.1 });

    const n621tx = filaReal(N621TX, [
      ...N621TX.mantenimientos,
      mant({
        id: 'auto-1700',
        estado: 'COMPLETADO',
        horas_programadas: 1700,
        etapa_intervalo_hr: 100,
        horas_aeronave: 1702.4,
        fecha_realizada: '2026-11-18',
      }),
    ]);
    expect(n621tx?.siguiente).toMatchObject({
      hobbs_hr: 1800,
      intervalo_hr: 100,
      faltan_hr: 97.6,
      orden: null,
    });
  });

  it('el hito no brinca aunque pasen más horas: N621TX a 1,812 h sigue en 1,700 («vencido por 112 h»)', () => {
    expect(
      filaReal(N621TX, N621TX.mantenimientos, 1812)?.siguiente,
    ).toMatchObject({ hobbs_hr: 1700, faltan_hr: -112, orden: null });
  });

  it('manda el hito más BAJO — el anclado, aunque haya una orden abierta ya alcanzada MÁS ADELANTE', () => {
    // N58BT a 1,810 h: nadie hizo el de 1,700 y la «HSI» de 1,800 sigue
    // abierta y ya se alcanzó. Lo más atrasado es el de 1,700 (sin orden).
    const s = filaReal(N58BT, N58BT.mantenimientos, 1810);
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 1700,
      intervalo_hr: 100,
      faltan_hr: -110,
      orden: null,
    });
  });

  it('manda el hito más BAJO — la orden abierta ya alcanzada, aunque un servicio POSTERIOR ya se haya hecho', () => {
    // N4142R: la orden de 4,500 (100 hrs) sigue abierta y el «50 hrs» de
    // 4,550 ya se hizo. El de 50 no es el de 100: 4,500 sigue vencido.
    const s = filaReal(
      N4142R,
      [
        ...N4142R.mantenimientos,
        mant({
          id: 'auto-4500',
          estado: 'PROGRAMADO',
          horas_programadas: 4500,
          etapa_intervalo_hr: 100,
        }),
        mant({
          id: 'm-4550',
          estado: 'COMPLETADO',
          horas_programadas: 4550,
          etapa_intervalo_hr: 50,
          horas_aeronave: 4552,
          fecha_realizada: '2026-12-01',
        }),
      ],
      4560,
    );
    expect(s?.siguiente).toMatchObject({
      hobbs_hr: 4500,
      intervalo_hr: 100,
      faltan_hr: -60,
      orden: { id: 'auto-4500', estado: 'PROGRAMADO' },
    });
  });
});
