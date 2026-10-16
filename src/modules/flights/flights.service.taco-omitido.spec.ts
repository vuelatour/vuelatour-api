// Mismos mocks de módulos pesados que el resto de los specs de flights.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pilots/pilots.service', () => ({ PilotsService: class {} }));

import { FlightsService } from './flights.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import {
  fakeSupabase,
  type Op,
  type Row,
  type Tablas,
} from './taco-omitido.fixture-spec';

/**
 * «Omitir el tacómetro» de un tramo (15-oct-2026, invariante 79): escrituras
 * (omitir / deshacer / llegada real que retira / cancelar), lectores
 * (listEscalas, tacoStatus, tacoLive, fillTacoGaps), completitud (complete,
 * cron zombi) y la salida DEDUCIDA que cruza un omitido (sección 9).
 *
 * El PostgREST falso emula lo que importa de la BD real:
 * - SIN la migración, cualquier select/update que NOMBRE `taco_omitido_*`
 *   responde 42703/PGRST204 (así se prueba la REGLA DURA de la sonda);
 * - CON ella, el CHECK `escala_taco_omitido_chk` (23514 si un update deja
 *   llegada + omisión, o at ⇎ motivo).
 */

const ITZI = 'u-itzi';
const LUIS = 'u-luis';
const PILOTO_VUELO = 'u-piloto-vuelo';
const AVION = 'av-n4142r';
/** 15:40 UTC = 10:40 en Cancún. */
const AHORA = new Date('2026-10-15T15:40:00Z');
const BITACORA_300 =
  'Registro: salida leída con IA (calidad de foto BAJA (dígitos dudosos), confianza 55%) — El tambor de la décima está a mitad de giro entre 1 y 2 · salida borrada(s) por Itzi (oficina) para recapturar';

function armar(
  db: Tablas,
  opts: { migracion?: boolean; antes?: (op: Op) => void } = {},
) {
  const { supabase, ops } = fakeSupabase(db, {
    migracion: opts.migracion ?? true,
    antes: opts.antes,
  });
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(true),
    notifyRole: jest.fn().mockResolvedValue(undefined),
  };
  const calendar = { syncFlight: jest.fn().mockResolvedValue(undefined) };
  const vision = { readTacometro: jest.fn() };
  const configuracion = { isActiva: jest.fn().mockResolvedValue(true) };
  const airports = {
    refreshPermisosDeVuelo: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new FlightsService(
    supabase,
    calendar as unknown as CalendarSyncService,
    {} as EmailService,
    vision as unknown as VisionService,
    notifications as unknown as NotificationsService,
    {} as ExpirationsService,
    airports as unknown as AirportsService,
    configuracion as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  const updates = (tabla: string) =>
    ops.filter((o) => o.tabla === tabla && o.tipo === 'update');
  return { svc, ops, updates, notifications, calendar, vision, db };
}

/** Caso real #300: N4142R, CET → CUN, EN_VUELO, un tramo sin tacos. */
function mundo300(over: { estado?: string; tramos?: Row[] } = {}): Tablas {
  return {
    usuario: [
      { id: ITZI, nombre: 'Itzi' },
      { id: LUIS, nombre: 'Luis Pérez' },
      { id: PILOTO_VUELO, nombre: 'Piloto del vuelo' },
    ],
    vuelo: [
      {
        id: 'v300',
        folio: 300,
        estado: over.estado ?? 'EN_VUELO',
        es_externo: false,
        aeronave_id: AVION,
        piloto_id: PILOTO_VUELO,
        fecha_vuelo: '2026-09-12T20:00:00Z',
        fecha_fin: '2026-09-12T23:00:00Z',
      },
    ],
    escala: over.tramos ?? [
      {
        id: 'e300',
        vuelo_id: 'v300',
        orden: 1,
        origen_iata: 'CET',
        destino_iata: 'CUN',
        aeronave_id: null,
        piloto_id: LUIS,
        fecha_salida_plan: '2026-09-12T20:00:00Z',
        taco_salida: null,
        taco_llegada: null,
        taco_salida_origen: null,
        taco_llegada_origen: null,
        revision_requerida: false,
        revision_motivo: BITACORA_300,
        cancelada_at: null,
        taco_omitido_at: null,
        taco_omitido_por: null,
        taco_omitido_motivo: null,
      },
    ],
  };
}

const omitido = (over: Row = {}): Row => ({
  id: 'e300',
  vuelo_id: 'v300',
  orden: 1,
  origen_iata: 'CET',
  destino_iata: 'CUN',
  aeronave_id: null,
  piloto_id: LUIS,
  fecha_salida_plan: '2026-09-12T20:00:00Z',
  taco_salida: null,
  taco_llegada: null,
  taco_salida_origen: null,
  taco_llegada_origen: null,
  revision_requerida: false,
  revision_motivo: `${BITACORA_300} · tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro`,
  cancelada_at: null,
  taco_omitido_at: '2026-10-15T15:40:00.000Z',
  taco_omitido_por: ITZI,
  taco_omitido_motivo: 'Falló el tacómetro',
  ...over,
});

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    return {
      status: err.getStatus?.(),
      body: err.getResponse?.() as {
        message: string;
        error: string;
        details: unknown;
      },
    };
  }
  throw new Error('esperaba un rechazo');
}

beforeEach(() => {
  jest.useFakeTimers({
    now: AHORA,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'setTimeout',
      'setInterval',
      'queueMicrotask',
    ],
  });
});
afterEach(() => jest.useRealTimers());

describe('omitirTaco (POST legs/:legId/taco/omitir)', () => {
  it('caso #300: patch exacto con CAS, bitácora AGREGADA y completable; NO completa ni avisa', async () => {
    const { svc, updates, notifications, calendar } = armar(mundo300());
    const r = await svc.omitirTaco(
      'e300',
      { motivo: '  Falló   el tacómetro ' },
      ITZI,
    );

    const [u] = updates('escala');
    expect(u.patch).toEqual({
      taco_omitido_at: '2026-10-15T15:40:00.000Z',
      taco_omitido_por: ITZI,
      taco_omitido_motivo: 'Falló el tacómetro',
      revision_requerida: false,
      revision_motivo: `${BITACORA_300} · tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro`,
      updated_by: ITZI,
    });
    expect(u.filtros).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'e300'],
        ['is', 'taco_omitido_at', null],
        ['is', 'taco_llegada', null],
      ]),
    );
    expect(r.vuelo).toEqual({
      id: 'v300',
      folio: 300,
      estado: 'EN_VUELO',
      completable: true,
      requiere_iniciar: false,
      omitidos: 1,
    });
    expect(r.escala.taco_omitido_por_nombre).toBe('Itzi');
    expect(r.escala.revision_motivo).toBeNull();
    expect(r.escala.procedencia).toBe(
      `${BITACORA_300.slice('Registro: '.length)} · tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro`,
    );
    // El vuelo NO se completa solo, ni hay push, ni calendario.
    expect(updates('vuelo')).toHaveLength(0);
    expect(notifications.notifyUser).not.toHaveBeenCalled();
    expect(calendar.syncFlight).not.toHaveBeenCalled();
  });

  it('CONFIRMADO nunca iniciado (#301) ⇒ requiere_iniciar y no completable', async () => {
    const { svc } = armar(mundo300({ estado: 'CONFIRMADO' }));
    const r = await svc.omitirTaco(
      'e300',
      { motivo: 'Falló el tacómetro' },
      ITZI,
    );
    expect(r.vuelo).toMatchObject({
      estado: 'CONFIRMADO',
      completable: false,
      requiere_iniciar: true,
      omitidos: 1,
    });
  });

  it('otro tramo sin llegada ⇒ ni completable ni requiere_iniciar', async () => {
    const base = mundo300();
    base.escala.push({
      ...base.escala[0],
      id: 'e300b',
      orden: 2,
      origen_iata: 'CUN',
      destino_iata: 'CET',
    });
    const { svc } = armar(base);
    const r = await svc.omitirTaco(
      'e300',
      { motivo: 'Falló el tacómetro' },
      ITZI,
    );
    expect(r.vuelo).toMatchObject({
      completable: false,
      requiere_iniciar: false,
      omitidos: 1,
    });
  });

  it('sin la migración ⇒ 503 MIGRACION_PENDIENTE y ninguna escritura', async () => {
    const { svc, updates } = armar(mundo300(), { migracion: false });
    const e = await rechazo(
      svc.omitirTaco('e300', { motivo: 'Falló el tacómetro' }, ITZI),
    );
    expect(e.status).toBe(503);
    expect(e.body.error).toBe('MIGRACION_PENDIENTE');
    expect(e.body.details).toEqual({ migracion: '20261015000001' });
    expect(updates('escala')).toHaveLength(0);
  });

  it('404 ESCALA_NO_EXISTE en es-MX', async () => {
    const { svc } = armar(mundo300());
    const e = await rechazo(
      svc.omitirTaco('nada', { motivo: 'Falló el tacómetro' }, ITZI),
    );
    expect(e.status).toBe(404);
    expect(e.body).toEqual({
      message:
        'Ese tramo ya no existe (quizá se borró o se reorganizó el vuelo). Recarga la página.',
      error: 'ESCALA_NO_EXISTE',
      details: { escala_id: 'nada' },
    });
  });

  it.each([
    [
      'ESCALA_CANCELADA',
      (t: Tablas) => {
        t.escala[0].cancelada_at = '2026-09-13T00:00:00Z';
        t.escala[0].cancelada_motivo = 'No voló';
      },
      { escala_id: 'e300', cancelada_motivo: 'No voló' },
    ],
    [
      'VUELO_EXTERNO',
      (t: Tablas) => {
        t.vuelo[0].es_externo = true;
      },
      { vuelo_id: 'v300', folio: 300 },
    ],
    [
      'VUELO_CANCELADO',
      (t: Tablas) => {
        t.vuelo[0].estado = 'CANCELADO';
      },
      { vuelo_id: 'v300', folio: 300, estado: 'CANCELADO' },
    ],
    [
      'VUELO_COMPLETADO',
      (t: Tablas) => {
        t.vuelo[0].estado = 'COMPLETADO';
      },
      { vuelo_id: 'v300', folio: 300, estado: 'COMPLETADO' },
    ],
    [
      'TACO_PRESENTE',
      (t: Tablas) => {
        t.escala[0].taco_llegada = 4455.3;
        t.escala[0].taco_llegada_origen = 'PILOTO';
      },
      {
        escala_id: 'e300',
        taco_llegada: 4455.3,
        taco_llegada_origen: 'PILOTO',
      },
    ],
  ])('409 %s con details', async (code, preparar, details) => {
    const t = mundo300();
    preparar(t);
    const { svc, updates } = armar(t);
    const e = await rechazo(
      svc.omitirTaco('e300', { motivo: 'Falló el tacómetro' }, ITZI),
    );
    expect(e.status).toBe(409);
    expect(e.body.error).toBe(code);
    expect(e.body.details).toEqual(details);
    expect(updates('escala')).toHaveLength(0);
  });

  it('409 TACO_YA_OMITIDO con quién, cuándo (hora Cancún) y motivo', async () => {
    const { svc } = armar(mundo300({ tramos: [omitido()] }));
    const e = await rechazo(
      svc.omitirTaco('e300', { motivo: 'Otra vez falló' }, LUIS),
    );
    expect(e.status).toBe(409);
    expect(e.body).toEqual({
      message:
        'Este tramo ya tiene el tacómetro omitido por Itzi (2026-10-15 10:40): «Falló el tacómetro».',
      error: 'TACO_YA_OMITIDO',
      details: {
        por: ITZI,
        nombre: 'Itzi',
        at: '2026-10-15T15:40:00.000Z',
        motivo: 'Falló el tacómetro',
      },
    });
  });

  it.each([
    ['9 caracteres', 'x'.repeat(9), 9],
    ['12 espacios', ' '.repeat(12), 0],
  ])('400 MOTIVO_INVALIDO con %s', async (_n, motivo, largo) => {
    const { svc, updates } = armar(mundo300());
    const e = await rechazo(svc.omitirTaco('e300', { motivo }, ITZI));
    expect(e.status).toBe(400);
    expect(e.body).toEqual({
      message:
        'Escribe el motivo por el que no se pudo capturar el tacómetro (de 10 a 500 caracteres).',
      error: 'MOTIVO_INVALIDO',
      details: { largo },
    });
    expect(updates('escala')).toHaveLength(0);
  });

  it('carrera: otra omisión gana el CAS (0 filas) ⇒ relectura y 409 TACO_YA_OMITIDO', async () => {
    const t = mundo300();
    const { svc } = armar(t, {
      antes: (op) => {
        if (op.tabla === 'escala' && op.tipo === 'update') {
          Object.assign(t.escala[0], {
            taco_omitido_at: '2026-10-15T15:39:00.000Z',
            taco_omitido_por: LUIS,
            taco_omitido_motivo: 'Doble clic de Luis',
          });
        }
      },
    });
    const e = await rechazo(
      svc.omitirTaco('e300', { motivo: 'Falló el tacómetro' }, ITZI),
    );
    expect(e.status).toBe(409);
    expect(e.body.error).toBe('TACO_YA_OMITIDO');
    expect((e.body.details as Row).nombre).toBe('Luis Pérez');
  });

  it('carrera: la llegada del piloto gana el CAS ⇒ 409 TACO_PRESENTE (nunca 500)', async () => {
    const t = mundo300();
    const { svc } = armar(t, {
      antes: (op) => {
        if (op.tabla === 'escala' && op.tipo === 'update') {
          t.escala[0].taco_llegada = 4455.3;
          t.escala[0].taco_llegada_origen = 'PILOTO';
        }
      },
    });
    const e = await rechazo(
      svc.omitirTaco('e300', { motivo: 'Falló el tacómetro' }, ITZI),
    );
    expect(e.status).toBe(409);
    expect(e.body.error).toBe('TACO_PRESENTE');
  });
});

describe('deshacerOmisionTaco (DELETE legs/:legId/taco/omitir)', () => {
  it('tres null + línea «deshecha»; COMPLETADO ⇒ EN_VUELO con CAS; push al piloto del TRAMO', async () => {
    const { svc, updates, notifications, calendar } = armar(
      mundo300({ estado: 'COMPLETADO', tramos: [omitido()] }),
    );
    const r = await svc.deshacerOmisionTaco('e300', ITZI);
    const [u] = updates('escala');
    expect(u.patch).toEqual({
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
      revision_motivo: `${BITACORA_300} · tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro · omisión del tacómetro deshecha por Itzi (oficina) el 2026-10-15 10:40: vuelve a pedir la llegada`,
      updated_by: ITZI,
    });
    expect(u.filtros).toEqual(
      expect.arrayContaining([['not', 'taco_omitido_at', null]]),
    );
    const [uv] = updates('vuelo');
    expect(uv.patch).toEqual({ estado: 'EN_VUELO', updated_by: ITZI });
    expect(uv.filtros).toEqual(
      expect.arrayContaining([['eq', 'estado', 'COMPLETADO']]),
    );
    expect(calendar.syncFlight).toHaveBeenCalledWith('v300');
    expect(notifications.notifyUser).toHaveBeenCalledWith(LUIS, {
      tipo: 'recordatorio_taco',
      titulo: 'Vuelve a capturar el tacómetro',
      cuerpo:
        'CET → CUN: la oficina deshizo la omisión del tacómetro; sube la lectura de llegada.',
      data: { escala_id: 'e300', vuelo_id: 'v300' },
      link: '/flights/v300',
    });
    expect(r.vuelo).toMatchObject({
      estado: 'EN_VUELO',
      completable: false,
      omitidos: 0,
    });
    expect(r.escala.taco_omitido_por_nombre).toBeNull();
  });

  it('sin piloto en el tramo ⇒ push al piloto del VUELO', async () => {
    const { svc, notifications } = armar(
      mundo300({ tramos: [omitido({ piloto_id: null })] }),
    );
    await svc.deshacerOmisionTaco('e300', ITZI);
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      PILOTO_VUELO,
      expect.objectContaining({ tipo: 'recordatorio_taco' }),
    );
  });

  it('409 TACO_NO_OMITIDO', async () => {
    const { svc } = armar(mundo300());
    const e = await rechazo(svc.deshacerOmisionTaco('e300', ITZI));
    expect(e.status).toBe(409);
    expect(e.body).toEqual({
      message:
        'Este tramo no tiene el tacómetro omitido: no hay nada que deshacer.',
      error: 'TACO_NO_OMITIDO',
      details: { escala_id: 'e300' },
    });
  });
});

describe('una LLEGADA REAL retira la omisión en el MISMO update', () => {
  it('captureTaco con llegada: los tres null van en el patch de la llegada y la bitácora lo dice', async () => {
    const { svc, updates } = armar(mundo300({ tramos: [omitido()] }));
    const fila = await svc.captureTaco('e300', { taco_llegada: 4455.3 }, LUIS);
    const conLlegada = updates('escala').find(
      (u) => u.patch?.taco_llegada === 4455.3,
    );
    expect(conLlegada?.patch).toMatchObject({
      taco_llegada: 4455.3,
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
    });
    expect(String(fila.revision_motivo)).toContain(
      'omisión del tacómetro retirada el 2026-10-15 10:40: llegada capturada por Luis Pérez',
    );
  });

  it('captureTaco con SALIDA sola NO retira la omisión', async () => {
    const t = mundo300({ tramos: [omitido()] });
    const { svc, updates } = armar(t);
    await svc.captureTaco('e300', { taco_salida: 4455.1 }, LUIS);
    for (const u of updates('escala')) {
      expect(Object.keys(u.patch ?? {})).not.toContain('taco_omitido_at');
    }
    expect(t.escala[0].taco_omitido_at).toBe('2026-10-15T15:40:00.000Z');
  });

  it('confirmTaco con llegada (oficina): retira y asienta «ajustada»', async () => {
    const t = mundo300({ tramos: [omitido({ taco_salida: 4455.1 })] });
    const { svc, updates } = armar(t);
    await svc.confirmTaco('e300', { taco_llegada: 4455.3 }, ITZI);
    const [u] = updates('escala');
    expect(u.patch).toMatchObject({
      taco_llegada: 4455.3,
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
    });
    expect(String(u.patch?.revision_motivo)).toContain(
      'omisión del tacómetro retirada el 2026-10-15 10:40: llegada ajustada por Itzi',
    );
    expect(t.escala[0].taco_omitido_at).toBeNull();
  });

  it('resolverLecturaPendiente (IA del sync offline): retira y queda AMARILLA', async () => {
    const t = mundo300({
      tramos: [
        omitido({ taco_salida: 4455.1, taco_salida_origen: 'DEDUCIDO' }),
      ],
    });
    const { svc, vision } = armar(t);
    vision.readTacometro.mockResolvedValue({
      legible: true,
      lectura: 4455.3,
      confianza: 0.95,
      calidad_foto: 'ALTA',
      notas: null,
    });
    await svc.captureTaco(
      'e300',
      {
        foto_taco_llegada_url: 'taco-fotos/e300.jpg',
        capturado_offline: true,
        pendiente_lectura: true,
      },
      LUIS,
    );
    expect(t.escala[0]).toMatchObject({
      taco_llegada: 4455.3,
      taco_llegada_origen: 'IA',
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
      revision_requerida: true,
    });
    expect(String(t.escala[0].revision_motivo)).toContain(
      'omisión del tacómetro retirada el 2026-10-15 10:40: llegada leída con IA por Luis Pérez',
    );
  });
});

describe('completitud: omitido = resuelto para la oficina, NO para el cron', () => {
  it('complete() pasa con [omitido]', async () => {
    const { svc, updates } = armar(mundo300({ tramos: [omitido()] }));
    await svc.complete('v300', ITZI);
    expect(updates('vuelo')[0].patch).toEqual({
      estado: 'COMPLETADO',
      updated_by: ITZI,
    });
  });

  it('cron zombi: con [omitido] NO completa (warn); con llegadas sí', async () => {
    const t = mundo300({ tramos: [omitido()] });
    t.vuelo[0].fecha_vuelo = '2026-09-12T20:00:00Z';
    const a = armar(t);
    const warn = jest
      .spyOn(
        (a.svc as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await a.svc.cerrarVuelosZombis();
    expect(a.updates('vuelo')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'Vuelo zombi #300 sigue EN_VUELO con tramos con tacómetro omitido — lo completa la oficina',
    );

    const t2 = mundo300({
      tramos: [
        {
          ...mundo300().escala[0],
          taco_salida: 4455.1,
          taco_llegada: 4455.3,
          taco_llegada_origen: 'PILOTO',
        },
      ],
    });
    const b = armar(t2);
    await b.svc.cerrarVuelosZombis();
    expect(b.updates('vuelo')[0].patch).toMatchObject({ estado: 'COMPLETADO' });
  });

  it('tacoStatus ⇒ {falta:false, omitido:true}; sin la migración ⇒ omitido:false', async () => {
    const { svc } = armar(mundo300({ tramos: [omitido()] }));
    await expect(svc.tacoStatus(['v300'])).resolves.toEqual({
      v300: { falta: false, omitido: true },
    });
    const sin = armar(mundo300(), { migracion: false });
    await expect(sin.svc.tacoStatus(['v300'])).resolves.toEqual({
      v300: { falta: true, omitido: false },
    });
  });
});

describe('lectores', () => {
  it('listEscalas: llaves SIEMPRE presentes; nombre en UNA consulta a usuario (sin N+1)', async () => {
    const t = mundo300({
      tramos: [
        omitido(),
        omitido({
          id: 'e300b',
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CET',
          taco_omitido_por: ITZI,
        }),
      ],
    });
    const { svc, ops } = armar(t);
    const filas = await svc.listEscalas('v300');
    expect(filas.map((f) => f.taco_omitido_por_nombre)).toEqual([
      'Itzi',
      'Itzi',
    ]);
    expect(filas[0]).toMatchObject({
      taco_omitido_at: '2026-10-15T15:40:00.000Z',
      taco_omitido_por: ITZI,
      taco_omitido_motivo: 'Falló el tacómetro',
    });
    expect(ops.filter((o) => o.tabla === 'usuario')).toHaveLength(1);
  });

  it('listEscalas sin la migración: llaves en null (contrato estable) y ninguna columna nombrada', async () => {
    const { svc } = armar(mundo300(), { migracion: false });
    const [f] = await svc.listEscalas('v300');
    expect(f).toMatchObject({
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
      taco_omitido_por_nombre: null,
    });
  });

  it('tacoLive: omitido ⇒ estado OK + omitido:true, sin llegada estimada ni revisión', async () => {
    const t = mundo300({
      tramos: [omitido({ taco_salida: 4455.1, revision_requerida: true })],
    });
    t.vuelo[0].fecha_vuelo = '2026-10-15T15:00:00Z';
    t.vuelo[0].fecha_fin = '2026-10-15T18:00:00Z';
    t.tramo_tiempo_promedio = [
      {
        origen_iata: 'CET',
        destino_iata: 'CUN',
        minutos_promedio: 12,
        muestras: 9,
      },
    ];
    const { svc } = armar(t);
    const r = await svc.tacoLive('2026-10-15');
    const fila = (r.vuelos[0].escalas as Row[])[0];
    expect(fila).toMatchObject({
      estado: 'OK',
      llegada_estimada: null,
      revision_requerida: false,
      omitido: true,
      taco_omitido_at: '2026-10-15T15:40:00.000Z',
      taco_omitido_motivo: 'Falló el tacómetro',
      taco_omitido_por_nombre: 'Itzi',
    });
    // Aditivos AL FINAL de la fila.
    expect(Object.keys(fila).slice(-4)).toEqual([
      'omitido',
      'taco_omitido_at',
      'taco_omitido_motivo',
      'taco_omitido_por_nombre',
    ]);
  });

  it('fillTacoGaps: el omitido NO se sugiere (sin push); el normal sí', async () => {
    const t = mundo300({
      tramos: [
        omitido({ taco_salida: 4455.1, taco_salida_origen: 'DEDUCIDO' }),
        {
          ...mundo300().escala[0],
          id: 'e300b',
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CET',
          taco_salida: 4456.0,
          taco_salida_origen: 'PILOTO',
          fecha_salida_plan: '2026-09-12T22:00:00Z',
        },
      ],
    });
    t.tramo_tiempo_promedio = [
      {
        origen_iata: 'CET',
        destino_iata: 'CUN',
        minutos_promedio: 12,
        muestras: 9,
      },
      {
        origen_iata: 'CUN',
        destino_iata: 'CET',
        minutos_promedio: 12,
        muestras: 9,
      },
    ];
    const { svc } = armar(t);
    const r = await svc.fillTacoGaps('v300', null);
    expect(r.sugerencias.map((s) => s.escala_id)).toEqual(['e300b']);
  });
});

describe('cancelEscala sobre un tramo omitido', () => {
  const dosTramos = () =>
    mundo300({
      tramos: [
        omitido(),
        {
          ...mundo300().escala[0],
          id: 'e300b',
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CET',
        },
      ],
    });

  it('con la migración ⇒ los tres null en el patch', async () => {
    const { svc, updates } = armar(dosTramos());
    await svc.cancelEscala('e300', 'No voló: se canceló en tierra', ITZI);
    expect(updates('escala')[0].patch).toMatchObject({
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
      revision_motivo: null,
    });
  });

  it('sin la migración ⇒ el patch NO nombra las columnas', async () => {
    const t = dosTramos();
    for (const e of t.escala) {
      delete e.taco_omitido_at;
      delete e.taco_omitido_por;
      delete e.taco_omitido_motivo;
    }
    const { svc, updates } = armar(t, { migracion: false });
    await svc.cancelEscala('e300', 'No voló: se canceló en tierra', ITZI);
    expect(Object.keys(updates('escala')[0].patch ?? {})).not.toContain(
      'taco_omitido_at',
    );
  });
});

describe('sección 9: salida DEDUCIDA que cruza un tramo omitido ⇒ ámbar', () => {
  /** #281 (llegada real 4455.1, 10-sep) → #300 omitido (12-sep) → #322 (19-sep). */
  const cadena = (conOmitido: boolean): Tablas => ({
    usuario: [
      { id: ITZI, nombre: 'Itzi' },
      { id: LUIS, nombre: 'Luis Pérez' },
    ],
    vuelo: [
      {
        id: 'v281',
        folio: 281,
        estado: 'COMPLETADO',
        es_externo: false,
        aeronave_id: AVION,
        fecha_vuelo: '2026-09-10T15:00:00Z',
      },
      {
        id: 'v300',
        folio: 300,
        estado: 'EN_VUELO',
        es_externo: false,
        aeronave_id: AVION,
        fecha_vuelo: '2026-09-12T20:00:00Z',
      },
      {
        id: 'v322',
        folio: 322,
        estado: 'EN_VUELO',
        es_externo: false,
        aeronave_id: AVION,
        piloto_id: LUIS,
        fecha_vuelo: '2026-09-19T15:00:00Z',
      },
    ],
    escala: [
      {
        id: 'e281',
        vuelo_id: 'v281',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'CET',
        aeronave_id: null,
        fecha_salida_plan: '2026-09-10T15:00:00Z',
        hora_llegada: '2026-09-10T16:00:00Z',
        taco_salida: 4454.0,
        taco_llegada: 4455.1,
        taco_salida_origen: 'PILOTO',
        taco_llegada_origen: 'PILOTO',
        cancelada_at: null,
        taco_omitido_at: null,
      },
      conOmitido
        ? omitido({ fecha_salida_plan: '2026-09-12T20:00:00Z' })
        : {
            ...omitido(),
            cancelada_at: '2026-09-12T00:00:00Z',
            taco_omitido_at: null,
            taco_omitido_por: null,
            taco_omitido_motivo: null,
          },
      {
        id: 'e322',
        vuelo_id: 'v322',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'CZM',
        aeronave_id: null,
        piloto_id: LUIS,
        fecha_salida_plan: '2026-09-19T15:00:00Z',
        taco_salida: null,
        taco_llegada: null,
        taco_salida_origen: null,
        taco_llegada_origen: null,
        revision_requerida: false,
        revision_motivo: null,
        cancelada_at: null,
        taco_omitido_at: null,
      },
    ],
  });
  const TEXTO =
    'La salida se copió del último tacómetro real del avión (4455.1), pero hay un tramo con tacómetro OMITIDO en medio (vuelo #300, CET → CUN): la lectura real puede ser mayor — confirmar contra la foto en oficina';

  it('captureTaco: copia DEDUCIDA + ámbar con el texto exacto en el MISMO update, y sobrevive al recálculo', async () => {
    const t = cadena(true);
    const { svc, updates } = armar(t);
    await svc.captureTaco('e322', { taco_llegada: 4455.6 }, LUIS);
    const u = updates('escala').find((x) => x.patch?.taco_llegada === 4455.6);
    expect(u?.patch).toMatchObject({
      taco_salida: 4455.1,
      taco_salida_origen: 'DEDUCIDO',
      revision_requerida: true,
    });
    expect(String(u?.patch?.revision_motivo).startsWith(TEXTO)).toBe(true);
    const e322 = t.escala.find((e) => e.id === 'e322')!;
    expect(e322.revision_requerida).toBe(true);
    expect(String(e322.revision_motivo)).toContain(TEXTO);
  });

  it('sin omitido en medio ⇒ copia sin ámbar', async () => {
    const t = cadena(false);
    const { svc, updates } = armar(t);
    await svc.captureTaco('e322', { taco_llegada: 4455.6 }, LUIS);
    const u = updates('escala').find((x) => x.patch?.taco_llegada === 4455.6);
    expect(u?.patch).toMatchObject({
      taco_salida: 4455.1,
      taco_salida_origen: 'DEDUCIDO',
    });
    expect(u?.patch?.revision_requerida).toBeUndefined();
    expect(t.escala.find((e) => e.id === 'e322')!.revision_requerida).toBe(
      false,
    );
  });

  it('start() (autoFillSalidaInicial): la copia cruza el omitido ⇒ ámbar en el mismo update', async () => {
    const t = cadena(true);
    t.vuelo[2].estado = 'CONFIRMADO';
    const { svc, updates } = armar(t);
    await svc.start('v322', ITZI);
    const u = updates('escala').find((x) =>
      x.filtros.some((f) => f[2] === 'e322'),
    );
    expect(u?.patch).toEqual({
      taco_salida: 4455.1,
      taco_salida_origen: 'DEDUCIDO',
      updated_by: ITZI,
      revision_requerida: true,
      revision_motivo: TEXTO,
    });
  });
});

/**
 * Revisión 0.0.81 (hallazgo alto): «entre» se decidía comparando la hora REAL
 * del lado fuente contra la PLANEADA del omitido. Vuelo redondo A (CUN→CZM→CUN)
 * con el regreso OMITIDO: si T1 llegó tarde respecto al plan de T2, o T2 no
 * tiene `fecha_salida_plan` (el cotizador la deja null en los intermedios), la
 * copia de B/T1 absorbía el ferry de A/T2 en VERDE.
 */
describe('sección 9: el cruce se decide por orden físico, no hora real contra plan', () => {
  const B = 'u-b';
  const mundo = (opts: {
    planT2?: string | null;
    omitidoEs?: 'T1' | 'T2';
    planB2?: string | null;
  }): Tablas => {
    const omitidoEs = opts.omitidoEs ?? 'T2';
    const omision = {
      taco_omitido_at: '2026-10-12T15:00:00Z',
      taco_omitido_por: B,
      taco_omitido_motivo: 'Falló el tacómetro',
    };
    const sinOmision = {
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
    };
    return {
      usuario: [{ id: B, nombre: 'Luis' }],
      vuelo: [
        {
          id: 'vA',
          folio: 500,
          estado: 'EN_VUELO',
          es_externo: false,
          aeronave_id: AVION,
          fecha_vuelo: '2026-10-10T15:00:00Z',
        },
        {
          id: 'vB',
          folio: 501,
          estado: 'EN_VUELO',
          es_externo: false,
          aeronave_id: AVION,
          piloto_id: B,
          fecha_vuelo: '2026-10-11T15:00:00Z',
        },
      ],
      escala: [
        omitidoEs === 'T1'
          ? {
              // A/T1 OMITIDO (antes de la fuente): NO cruza.
              id: 'eA1',
              vuelo_id: 'vA',
              orden: 1,
              origen_iata: 'CUN',
              destino_iata: 'CZM',
              aeronave_id: null,
              fecha_salida_plan: '2026-10-10T15:00:00Z',
              taco_salida: 999.0,
              taco_llegada: null,
              taco_salida_origen: 'PILOTO',
              taco_llegada_origen: null,
              revision_requerida: false,
              revision_motivo: null,
              cancelada_at: null,
              ...omision,
            }
          : {
              // A/T1: llegada REAL 1000.5 a las 16:10Z (retraso).
              id: 'eA1',
              vuelo_id: 'vA',
              orden: 1,
              origen_iata: 'CUN',
              destino_iata: 'CZM',
              aeronave_id: null,
              fecha_salida_plan: '2026-10-10T15:00:00Z',
              hora_llegada: '2026-10-10T16:10:00Z',
              taco_salida: 1000.0,
              taco_llegada: 1000.5,
              taco_salida_origen: 'PILOTO',
              taco_llegada_origen: 'PILOTO',
              revision_requerida: false,
              revision_motivo: null,
              cancelada_at: null,
              ...sinOmision,
            },
        omitidoEs === 'T1'
          ? {
              // A/T2: llegada REAL 1000.5 (la fuente).
              id: 'eA2',
              vuelo_id: 'vA',
              orden: 2,
              origen_iata: 'CZM',
              destino_iata: 'CUN',
              aeronave_id: null,
              fecha_salida_plan: opts.planT2 ?? null,
              hora_salida: '2026-10-10T17:00:00Z',
              hora_llegada: '2026-10-10T17:40:00Z',
              taco_salida: 1000.0,
              taco_llegada: 1000.5,
              taco_salida_origen: 'PILOTO',
              taco_llegada_origen: 'PILOTO',
              revision_requerida: false,
              revision_motivo: null,
              cancelada_at: null,
              ...sinOmision,
            }
          : {
              // A/T2 OMITIDO; su salida es la copia DEDUCIDA de T1.
              id: 'eA2',
              vuelo_id: 'vA',
              orden: 2,
              origen_iata: 'CZM',
              destino_iata: 'CUN',
              aeronave_id: null,
              fecha_salida_plan: opts.planT2 ?? null,
              taco_salida: 1000.5,
              taco_llegada: null,
              taco_salida_origen: 'DEDUCIDO',
              taco_llegada_origen: null,
              revision_requerida: false,
              revision_motivo: null,
              cancelada_at: null,
              ...omision,
            },
        {
          // B/T1: el piloto captura SOLO la llegada ⇒ la salida se copia.
          id: 'eB1',
          vuelo_id: 'vB',
          orden: 1,
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          aeronave_id: null,
          piloto_id: B,
          fecha_salida_plan: '2026-10-11T15:00:00Z',
          taco_salida: null,
          taco_llegada: null,
          taco_salida_origen: null,
          taco_llegada_origen: null,
          revision_requerida: false,
          revision_motivo: null,
          cancelada_at: null,
          ...sinOmision,
        },
      ],
    };
  };
  const TEXTO_A2 =
    'La salida se copió del último tacómetro real del avión (1000.5), pero hay un tramo con tacómetro OMITIDO en medio (vuelo #500, CZM → CUN)';

  it.each([
    [
      'plan de T2 (16:00Z) ANTES de la llegada real de T1 (16:10Z)',
      '2026-10-10T16:00:00Z',
    ],
    ['T2 SIN fecha_salida_plan (tramo intermedio del cotizador)', null],
    [
      'control: plan de T2 (16:30Z) después de la llegada real de T1',
      '2026-10-10T16:30:00Z',
    ],
  ])('regreso omitido del vuelo redondo — %s ⇒ ámbar', async (_n, planT2) => {
    const t = mundo({ planT2 });
    const { svc } = armar(t);
    await svc.captureTaco('eB1', { taco_llegada: 1002.0 }, B);
    const b1 = t.escala.find((e) => e.id === 'eB1')!;
    expect(b1).toMatchObject({
      taco_salida: 1000.5,
      taco_salida_origen: 'DEDUCIDO',
      revision_requerida: true,
    });
    expect(String(b1.revision_motivo)).toContain(TEXTO_A2);
  });

  it('omitido ANTES de la fuente en el mismo vuelo (A/T1 omitido, A/T2 real) ⇒ sin ámbar', async () => {
    const t = mundo({ omitidoEs: 'T1', planT2: null });
    const { svc } = armar(t);
    await svc.captureTaco('eB1', { taco_llegada: 1002.0 }, B);
    const b1 = t.escala.find((e) => e.id === 'eB1')!;
    expect(b1.taco_salida).toBe(1000.5);
    expect(b1.revision_requerida).toBe(false);
  });

  it('omitido en el MISMO vuelo que el tramo, antes de él, ambos sin plan ⇒ ámbar', async () => {
    // Fuente: A/T1 llegada 1000.5 (A/T2 cancelado para que no estorbe).
    // Vuelo B: T1 omitido (sin plan) → T2 captura solo la llegada.
    const t = mundo({ planT2: null });
    t.escala = t.escala.filter((e) => e.id !== 'eA2');
    const b1 = t.escala.find((e) => e.id === 'eB1')!;
    Object.assign(b1, {
      fecha_salida_plan: null,
      taco_salida: 1000.5,
      taco_salida_origen: 'DEDUCIDO',
      taco_omitido_at: '2026-10-12T15:00:00Z',
      taco_omitido_por: B,
      taco_omitido_motivo: 'Falló el tacómetro',
    });
    t.escala.push({
      id: 'eB2',
      vuelo_id: 'vB',
      orden: 2,
      origen_iata: 'CZM',
      destino_iata: 'CUN',
      aeronave_id: null,
      piloto_id: B,
      fecha_salida_plan: null,
      taco_salida: null,
      taco_llegada: null,
      taco_salida_origen: null,
      taco_llegada_origen: null,
      revision_requerida: false,
      revision_motivo: null,
      cancelada_at: null,
      taco_omitido_at: null,
      taco_omitido_por: null,
      taco_omitido_motivo: null,
    });
    const { svc } = armar(t);
    await svc.captureTaco('eB2', { taco_llegada: 1002.0 }, B);
    const b2 = t.escala.find((e) => e.id === 'eB2')!;
    expect(b2).toMatchObject({
      taco_salida: 1000.5,
      taco_salida_origen: 'DEDUCIDO',
      revision_requerida: true,
    });
    expect(String(b2.revision_motivo)).toContain(
      'hay un tramo con tacómetro OMITIDO en medio (vuelo #501, CUN → CZM)',
    );
  });
});
