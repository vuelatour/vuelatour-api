// El cliente de Google está MOCKEADO: este spec JAMÁS llama a la API de
// Google Calendar (ni a la red). `calendarioFake()` es una función declarada
// (hoisted) que lee el doble al momento de la llamada, no al cargar el módulo.
jest.mock('googleapis', () => ({
  google: { calendar: () => calendarioFake() },
}));
jest.mock('google-auth-library', () => ({
  JWT: class {
    constructor(public readonly opts: unknown) {}
  },
}));

import { Logger } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { SupabaseService } from '../supabase/supabase.service';

const eventosGoogle = {
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
function calendarioFake() {
  return { events: eventosGoogle };
}

const CALENDARIO = 'aerochartercancunflightplanner@gmail.com';

/** Forma (parcial) del evento que se le manda a Google. */
type CuerpoEvento = {
  summary?: string;
  description?: string;
  colorId?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};
type LlamadaGoogle = {
  calendarId: string;
  eventId?: string;
  requestBody: CuerpoEvento;
};

const argsDe = (fn: jest.Mock, i: number): LlamadaGoogle => {
  const llamadas = fn.mock.calls as unknown as LlamadaGoogle[][];
  return llamadas[i][0];
};
const insertado = (i = 0): LlamadaGoogle => argsDe(eventosGoogle.insert, i);
const actualizado = (i = 0): LlamadaGoogle => argsDe(eventosGoogle.update, i);

type Resultado = { data: unknown; error: null | { message: string } };
type Llamada = { tabla: string; metodo: string; args: unknown[] };

/**
 * Doble de Supabase con resolución PEREZOSA (al await): cada consulta a una
 * tabla consume el siguiente resultado de su cola (el último se repite).
 */
function armarSupabase(tablas: Record<string, Resultado[]>) {
  const llamadas: Llamada[] = [];
  const cursor: Record<string, number> = {};
  const siguiente = (tabla: string): Resultado => {
    const lista = tablas[tabla] ?? [{ data: null, error: null }];
    const i = cursor[tabla] ?? 0;
    cursor[tabla] = i + 1;
    return lista[Math.min(i, lista.length - 1)];
  };
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = registra(m);
    }
    q.maybeSingle = () => Promise.resolve(siguiente(tabla));
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(siguiente(tabla)).then(resolve, reject);
    return q;
  };
  return { llamadas, service: { from } };
}

function armar(
  tablas: Record<string, Resultado[]>,
  env: Partial<Record<string, unknown>> = {},
) {
  const sb = armarSupabase(tablas);
  const valores: Record<string, unknown> = {
    GOOGLE_CALENDAR_SYNC_ENABLED: true,
    GOOGLE_CALENDAR_ID: CALENDARIO,
    GOOGLE_SERVICE_ACCOUNT_JSON:
      '{"client_email":"sa@vuelatour.iam.gserviceaccount.com","private_key":"k"}',
    ...env,
  };
  const config = {
    get: (k: string) => valores[k],
  } as unknown as ConfigService<EnvVars, true>;
  const service = new CalendarSyncService(config, {
    service: sb.service,
  } as unknown as SupabaseService);
  service.onModuleInit();
  return { service, llamadas: sb.llamadas };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const MANT = {
  id: 'm-1',
  estado: 'PROGRAMADO',
  descripcion: 'Servicio de 100 h',
  fecha_programada: '2026-09-20',
  horas_programadas: '1200.0',
  etapa_intervalo_hr: '100',
  google_calendar_id: null as string | null,
  aeronave: { matricula: 'N4142R', color_calendario: '#F97316' },
};

beforeEach(() => {
  jest.clearAllMocks();
  eventosGoogle.insert.mockResolvedValue({ data: { id: 'ev-nuevo' } });
  eventosGoogle.update.mockResolvedValue({ data: { id: 'ev-existente' } });
  eventosGoogle.delete.mockResolvedValue({});
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ===== C1 · MANTENIMIENTOS =====

describe('CalendarSyncService.syncMantenimiento (C1)', () => {
  it('PROGRAMADO con fecha: evento de día completo ámbar y el id persistido', async () => {
    const { service, llamadas } = armar({
      mantenimiento: [{ data: MANT, error: null }],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(true);

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    const { calendarId, requestBody } = insertado();
    expect(calendarId).toBe(CALENDARIO);
    expect(requestBody.summary).toBe(
      '🔧 Servicio · N4142R · Servicio de 100 h',
    );
    expect(requestBody.colorId).toBe('5'); // Banana = ámbar del sistema
    // Día completo en el DÍA CANCÚN de fecha_programada; fin EXCLUSIVO.
    expect(requestBody.start).toEqual({ date: '2026-09-20' });
    expect(requestBody.end).toEqual({ date: '2026-09-21' });
    expect(requestBody.transparency).toBe('transparent');
    expect(requestBody.extendedProperties).toEqual({
      private: { vuelatour_mantenimiento_id: 'm-1' },
    });
    expect(String(requestBody.description).split('\n')).toEqual([
      'Estado: PROGRAMADO',
      'Horas programadas: 1200 hr',
      'Intervalo de servicio: 100 hr',
      '',
      'VuelaTour · mantenimiento m-1',
    ]);
    // id de Google guardado en mantenimiento.google_calendar_id.
    expect(de(llamadas, 'mantenimiento', 'update')[0].args[0]).toEqual({
      google_calendar_id: 'ev-nuevo',
    });
  });

  it('EN_TALLER: título "En taller", rojo Tomate y UPDATE del evento ya creado (sin re-persistir el id)', async () => {
    const { service, llamadas } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            estado: 'EN_TALLER',
            google_calendar_id: 'ev-existente',
          },
          error: null,
        },
      ],
    });

    await service.syncMantenimiento('m-1');

    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    const { eventId, requestBody } = actualizado();
    expect(eventId).toBe('ev-existente');
    expect(requestBody.summary).toBe(
      '🔧 En taller · N4142R · Servicio de 100 h',
    );
    expect(requestBody.colorId).toBe('11'); // Tomate = el rojo de Google
    expect(de(llamadas, 'mantenimiento', 'update')).toHaveLength(0);
  });

  it('COMPLETADO: BORRA el evento y limpia la columna (el calendario del sistema tampoco lo pinta)', async () => {
    const { service, llamadas } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            estado: 'COMPLETADO',
            google_calendar_id: 'ev-viejo',
          },
          error: null,
        },
      ],
    });

    await service.syncMantenimiento('m-1');

    expect(eventosGoogle.delete).toHaveBeenCalledWith({
      calendarId: CALENDARIO,
      eventId: 'ev-viejo',
    });
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(eventosGoogle.update).not.toHaveBeenCalled();
    expect(de(llamadas, 'mantenimiento', 'update')[0].args[0]).toEqual({
      google_calendar_id: null,
    });
  });

  it('sin fecha_programada: no agenda nada (y borra el evento si lo tenía)', async () => {
    const { service, llamadas } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            fecha_programada: null,
            google_calendar_id: 'ev-viejo',
          },
          error: null,
        },
      ],
    });

    await service.syncMantenimiento('m-1');

    expect(eventosGoogle.delete).toHaveBeenCalledTimes(1);
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(de(llamadas, 'mantenimiento', 'update')[0].args[0]).toEqual({
      google_calendar_id: null,
    });
  });

  it('auto-programado sin fecha y sin evento: NO toca Google', async () => {
    const { service } = armar({
      mantenimiento: [
        {
          data: { ...MANT, fecha_programada: null, google_calendar_id: null },
          error: null,
        },
      ],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(true);

    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(eventosGoogle.update).not.toHaveBeenCalled();
    expect(eventosGoogle.delete).not.toHaveBeenCalled();
  });

  it('sin descripción ni matrícula: título con respaldos, jamás "undefined"', async () => {
    const { service } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            descripcion: '  ',
            aeronave: null,
            horas_programadas: null,
            etapa_intervalo_hr: null,
          },
          error: null,
        },
      ],
    });

    await service.syncMantenimiento('m-1');

    const { requestBody } = insertado();
    expect(requestBody.summary).toBe('🔧 Servicio · avión · Servicio');
    expect(String(requestBody.description).split('\n')).toEqual([
      'Estado: PROGRAMADO',
      '',
      'VuelaTour · mantenimiento m-1',
    ]);
  });

  it('Google falla: devuelve false y NO lanza (best-effort, nunca llega al cliente)', async () => {
    eventosGoogle.insert.mockRejectedValue(new Error('403 Forbidden'));
    const { service } = armar({ mantenimiento: [{ data: MANT, error: null }] });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(false);
  });

  it('sync APAGADA (faltan variables): no-op sin tocar Google ni la BD', async () => {
    const { service, llamadas } = armar(
      { mantenimiento: [{ data: MANT, error: null }] },
      { GOOGLE_CALENDAR_SYNC_ENABLED: false },
    );

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(true);

    expect(llamadas).toHaveLength(0);
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
  });

  it('removeMantenimientoEvent borra por id (baja de la fila) y tolera null', async () => {
    const { service } = armar({});
    await service.removeMantenimientoEvent(null);
    expect(eventosGoogle.delete).not.toHaveBeenCalled();
    await service.removeMantenimientoEvent('ev-9');
    expect(eventosGoogle.delete).toHaveBeenCalledWith({
      calendarId: CALENDARIO,
      eventId: 'ev-9',
    });
  });
});

// ===== C3/C4 · TÍTULO CON PILOTO Y COLOR POR AVIÓN =====

const VUELO_MULTIESCALA = {
  id: 'v-1',
  folio: 247,
  estado: 'CONFIRMADO',
  es_externo: false,
  operador_externo: null,
  origen_iata: 'CUN',
  destino_iata: 'PTU',
  pasajeros: 3,
  monto_total_usd: '4200',
  fecha_vuelo: '2026-09-20T14:00:00.000Z',
  fecha_traslado_final: null,
  tipo: 'MULTIESCALA',
  notas: null,
  estado_permiso: null,
  google_calendar_id: null,
  google_calendar_regreso_id: null,
  aeronave: { matricula: 'N4142R', color_calendario: '#10B981' },
  piloto: { nombre: 'Luis Alberto Ramírez' },
  cliente: { nombre: 'ACME' },
  escalas: [
    {
      id: 'e-1',
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'PTU',
      fecha_salida_plan: '2026-09-20T14:00:00.000Z',
      es_ferry: false,
      pasajeros: 3,
      google_calendar_id: null,
      aeronave_id: 'a-1',
      piloto_id: 'p-1',
      estado_permiso: null,
      cancelada_at: null,
      aeronave: { matricula: 'N4142R', color_calendario: '#10B981' },
      piloto: { nombre: 'Luis Alberto Ramírez' },
    },
    {
      id: 'e-2',
      orden: 2,
      origen_iata: 'PTU',
      destino_iata: 'CUN',
      fecha_salida_plan: '2026-09-20T20:00:00.000Z',
      es_ferry: true,
      pasajeros: null,
      google_calendar_id: null,
      aeronave_id: 'a-1',
      piloto_id: 'p-1',
      estado_permiso: 'pendiente',
      cancelada_at: null,
      aeronave: { matricula: 'N4142R', color_calendario: '#10B981' },
      piloto: { nombre: 'Luis Alberto Ramírez' },
    },
  ],
};

describe('CalendarSyncService.syncFlight — piloto en el título (C3) y color por avión (C4)', () => {
  it('un evento por tramo: «T1 · N4142R · CUN-PTU · Luis · 3 pax» y el ferry con su prefijo', async () => {
    const { service } = armar({
      vuelo: [{ data: VUELO_MULTIESCALA, error: null }],
    });

    await expect(service.syncFlight('v-1')).resolves.toBe(true);

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(2);
    const cuerpos = [insertado(0).requestBody, insertado(1).requestBody];
    expect(cuerpos[0].summary).toBe('T1 · N4142R · CUN-PTU · Luis · 3 pax');
    // El color del avión del sistema (#10B981) → Salvia (2).
    expect(cuerpos[0].colorId).toBe('2');
    expect(cuerpos[1].summary).toBe(
      'T2 Ferry · N4142R · PTU-CUN · Luis · 0 pax ⚠ permiso pendiente',
    );
    // El permiso pendiente sigue DOMINANDO el color (Mandarina/6).
    expect(cuerpos[1].colorId).toBe('6');
  });

  it('sin piloto asignado: «sin piloto» en el título y color del avión', async () => {
    const vuelo = {
      ...VUELO_MULTIESCALA,
      piloto: null,
      escalas: [
        { ...VUELO_MULTIESCALA.escalas[0], piloto: null, piloto_id: null },
      ],
    };
    const { service } = armar({ vuelo: [{ data: vuelo, error: null }] });

    await service.syncFlight('v-1');

    const { requestBody } = insertado();
    expect(requestBody.summary).toBe(
      'T1 · N4142R · CUN-PTU · sin piloto · 3 pax',
    );
    expect(requestBody.colorId).toBe('2');
  });

  it('externo: «externo» como piloto, operador como avión y su color Flamenco', async () => {
    const vuelo = {
      ...VUELO_MULTIESCALA,
      es_externo: true,
      operador_externo: 'Jet Amigo',
      escalas: [
        {
          ...VUELO_MULTIESCALA.escalas[0],
          aeronave: null,
          aeronave_id: null,
        },
      ],
    };
    const { service } = armar({ vuelo: [{ data: vuelo, error: null }] });

    await service.syncFlight('v-1');

    const { requestBody } = insertado();
    expect(requestBody.summary).toBe(
      'T1 · Jet Amigo · CUN-PTU · externo · 3 pax',
    );
    expect(requestBody.colorId).toBe('4');
  });

  it('vuelo legacy ida/regreso (sin escalas): título con piloto y color del avión del vuelo', async () => {
    const vuelo = {
      ...VUELO_MULTIESCALA,
      tipo: 'SENCILLO',
      escalas: [],
      aeronave: { matricula: 'N990GG', color_calendario: '#3B82F6' },
      piloto: { nombre: 'Itzi Pérez' },
    };
    const { service } = armar({ vuelo: [{ data: vuelo, error: null }] });

    await service.syncFlight('v-1');

    const { requestBody } = insertado();
    expect(requestBody.summary).toBe('N990GG · CUN-PTU · Itzi · 3 pax');
    expect(requestBody.colorId).toBe('7'); // azul del sistema → Pavo real
  });

  it('avión sin color_calendario: cae al DEFAULT (Arándano/9)', async () => {
    const vuelo = {
      ...VUELO_MULTIESCALA,
      tipo: 'SENCILLO',
      escalas: [],
      aeronave: { matricula: 'XB-ANU', color_calendario: null },
    };
    const { service } = armar({ vuelo: [{ data: vuelo, error: null }] });

    await service.syncFlight('v-1');

    const { requestBody } = insertado();
    expect(requestBody.colorId).toBe('9');
  });

  it('CANCELADO: el evento se BORRA de Google (C6)', async () => {
    const { service } = armar({
      vuelo: [
        { data: { ...VUELO_MULTIESCALA, estado: 'CANCELADO' }, error: null },
        {
          data: {
            google_calendar_id: 'ev-1',
            google_calendar_regreso_id: null,
          },
          error: null,
        },
      ],
      escala: [{ data: [], error: null }],
    });

    await service.syncFlight('v-1');

    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    expect(eventosGoogle.delete).toHaveBeenCalledWith({
      calendarId: CALENDARIO,
      eventId: 'ev-1',
    });
  });
});

// ===== C2/C5 · BACKFILL COMPLETO Y ESTADO VISIBLE =====

describe('CalendarSyncService.resyncTodo (C2) y estadoSync (C5)', () => {
  const listas = (): Record<string, Resultado[]> => ({
    vuelo: [{ data: [{ id: 'v-1' }, { id: 'v-2' }], error: null }],
    piloto_descanso: [
      {
        data: [
          {
            id: 'd-1',
            fecha_inicio: '2026-09-01',
            fecha_fin: '2026-09-03',
            motivo: null,
            google_calendar_id: 'ev-d',
            piloto: { nombre: 'Luis' },
          },
        ],
        error: null,
      },
    ],
    evento_flota: [
      {
        data: [
          {
            id: 'ef-1',
            titulo: 'Lavado',
            fecha: '2026-09-05T15:00:00.000Z',
            fecha_fin: null,
            notas: null,
            google_calendar_id: 'ev-e',
            aeronave: null,
            responsable: null,
          },
        ],
        error: null,
      },
    ],
    mantenimiento: [
      { data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }], error: null },
    ],
  });

  it('cuenta por tipo, respeta la ventana y trae la nota de los eventos manuales', async () => {
    const { service, llamadas } = armar(listas());
    const syncFlight = jest
      .spyOn(service, 'syncFlight')
      .mockResolvedValue(true);
    const syncMant = jest
      .spyOn(service, 'syncMantenimiento')
      .mockResolvedValue(true);
    jest.spyOn(service, 'upsertDescansoEvent').mockResolvedValue('ev-d');
    jest.spyOn(service, 'upsertEventoFlotaEvent').mockResolvedValue('ev-e');

    const r = await service.resyncTodo({
      desde: '2026-08-01T00:00:00-05:00',
      hasta: '2027-09-12T23:59:59-05:00',
    });

    const { nota, ...conteos } = r;
    expect(conteos).toEqual({
      enabled: true,
      calendar_id: CALENDARIO,
      vuelos: 2,
      descansos: 1,
      eventos: 1,
      mantenimientos: 3,
      errores: 0,
      desde: '2026-08-01',
      hasta: '2027-09-12',
    });
    // C7: la respuesta le dice al panel que lo capturado a mano no se toca.
    expect(nota).toContain('NO se tocan');
    expect(syncFlight).toHaveBeenCalledTimes(2);
    expect(syncMant).toHaveBeenCalledTimes(3);
    // Mantenimientos: ventana por DÍA Cancún sobre fecha_programada (DATE).
    expect(de(llamadas, 'mantenimiento', 'gte')[0].args).toEqual([
      'fecha_programada',
      '2026-08-01',
    ]);
    expect(de(llamadas, 'mantenimiento', 'lte')[0].args).toEqual([
      'fecha_programada',
      '2027-09-12',
    ]);
    // El estado visible del panel queda sellado.
    const estado = service.estadoSync();
    expect(estado.enabled).toBe(true);
    expect(estado.calendar_id).toBe(CALENDARIO);
    expect(estado.ultimo_resync_at).not.toBeNull();
    expect(estado.ultimo_reconcile_at).toBeNull();
    expect(estado.ultimo_resumen).toMatchObject({
      origen: 'resync',
      vuelos: 2,
      mantenimientos: 3,
      desde: '2026-08-01',
      hasta: '2027-09-12',
    });
  });

  it('un evento que falla se CUENTA y no tumba el resto (nunca lanza)', async () => {
    const { service } = armar(listas());
    jest
      .spyOn(service, 'syncFlight')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest
      .spyOn(service, 'syncMantenimiento')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    // Descanso sin id devuelto = el upsert falló (ya se logueó dentro).
    jest.spyOn(service, 'upsertDescansoEvent').mockResolvedValue(null);
    jest.spyOn(service, 'upsertEventoFlotaEvent').mockResolvedValue('ev-e');

    const r = await service.resyncTodo();

    expect(r.vuelos).toBe(1);
    expect(r.descansos).toBe(0);
    expect(r.eventos).toBe(1);
    expect(r.mantenimientos).toBe(2);
    expect(r.errores).toBe(3);
    expect(r.enabled).toBe(true);
  });

  it('una consulta que falla cuenta error y sigue con los demás tipos', async () => {
    const tablas = listas();
    tablas.mantenimiento = [{ data: null, error: { message: 'boom' } }];
    const { service } = armar(tablas);
    jest.spyOn(service, 'syncFlight').mockResolvedValue(true);
    jest.spyOn(service, 'upsertDescansoEvent').mockResolvedValue('ev-d');
    jest.spyOn(service, 'upsertEventoFlotaEvent').mockResolvedValue('ev-e');

    const r = await service.resyncTodo();

    expect(r.mantenimientos).toBe(0);
    expect(r.errores).toBe(1);
    expect(r.vuelos).toBe(2);
    expect(r.descansos).toBe(1);
  });

  it('ventana por default: [hoy−30d, hoy+365d] en días Cancún', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T18:00:00Z'));
    try {
      const { service } = armar(listas());
      jest.spyOn(service, 'syncFlight').mockResolvedValue(true);
      jest.spyOn(service, 'syncMantenimiento').mockResolvedValue(true);
      jest.spyOn(service, 'upsertDescansoEvent').mockResolvedValue('ev-d');
      jest.spyOn(service, 'upsertEventoFlotaEvent').mockResolvedValue('ev-e');

      const r = await service.resyncTodo();

      expect(r.desde).toBe('2026-08-13');
      expect(r.hasta).toBe('2027-09-12');
    } finally {
      jest.useRealTimers();
    }
  });

  it('APAGADA: responde enabled:false con ceros, sin tocar la BD ni Google', async () => {
    const { service, llamadas } = armar(listas(), {
      GOOGLE_CALENDAR_SYNC_ENABLED: false,
    });

    const r = await service.resyncTodo();

    expect(r).toMatchObject({
      enabled: false,
      calendar_id: CALENDARIO,
      vuelos: 0,
      descansos: 0,
      eventos: 0,
      mantenimientos: 0,
      errores: 0,
    });
    expect(llamadas).toHaveLength(0);
    expect(service.estadoSync()).toMatchObject({
      enabled: false,
      ultimo_resync_at: null,
      ultimo_reconcile_at: null,
      ultimo_resumen: null,
    });
  });

  it('sin GOOGLE_CALENDAR_ID la sync queda inactiva aunque el flag esté en true', () => {
    const { service } = armar({}, { GOOGLE_CALENDAR_ID: '' });
    expect(service.estadoSync().enabled).toBe(false);
  });
});

describe('CalendarSyncService.reconcileVentana', () => {
  it('incluye mantenimientos y sella ultimo_reconcile_at', async () => {
    const { service, llamadas } = armar({
      vuelo: [{ data: [], error: null }],
      piloto_descanso: [{ data: [], error: null }],
      evento_flota: [{ data: [], error: null }],
      mantenimiento: [{ data: [{ id: 'm-1' }], error: null }],
    });
    const syncMant = jest
      .spyOn(service, 'syncMantenimiento')
      .mockResolvedValue(true);

    await service.reconcileVentana();

    expect(syncMant).toHaveBeenCalledWith('m-1');
    expect(de(llamadas, 'mantenimiento', 'select')).toHaveLength(1);
    const estado = service.estadoSync();
    expect(estado.ultimo_reconcile_at).not.toBeNull();
    expect(estado.ultimo_resync_at).toBeNull();
    expect(estado.ultimo_resumen).toMatchObject({
      origen: 'reconcile',
      mantenimientos: 1,
    });
  });

  it('APAGADA: no consulta nada', async () => {
    const { service, llamadas } = armar(
      { mantenimiento: [{ data: [{ id: 'm-1' }], error: null }] },
      { GOOGLE_CALENDAR_SYNC_ENABLED: false },
    );

    await service.reconcileVentana();

    expect(llamadas).toHaveLength(0);
  });
});

// ===== IDEMPOTENCIA REAL: fallos de Google que NO son "el evento ya no está" =====

describe('CalendarSyncService — idempotencia ante fallos de Google', () => {
  const gaxios = (status: number, msg: string) =>
    Object.assign(new Error(msg), { code: status, response: { status } });

  it('update con 403 de cuota: NO re-crea (no duplica), conserva el id y cuenta error', async () => {
    eventosGoogle.update.mockRejectedValue(gaxios(403, 'Rate Limit Exceeded'));
    const { service, llamadas } = armar({
      mantenimiento: [
        { data: { ...MANT, google_calendar_id: 'ev-existente' }, error: null },
      ],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(false);

    // Lo importante: NO nace un segundo evento para el mismo mantenimiento…
    expect(eventosGoogle.insert).not.toHaveBeenCalled();
    // …y el id guardado NO se pisa (el viejo seguiría vivo y huérfano).
    expect(de(llamadas, 'mantenimiento', 'update')).toHaveLength(0);
  });

  it('update con 404 (lo borraron a mano en Google): SÍ re-crea y persiste el id nuevo', async () => {
    eventosGoogle.update.mockRejectedValue(gaxios(404, 'Not Found'));
    const { service, llamadas } = armar({
      mantenimiento: [
        { data: { ...MANT, google_calendar_id: 'ev-borrado' }, error: null },
      ],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(true);

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    expect(de(llamadas, 'mantenimiento', 'update')[0].args[0]).toEqual({
      google_calendar_id: 'ev-nuevo',
    });
  });

  it('COMPLETADO con el DELETE fallando: NO limpia la columna (si no, el evento queda fantasma)', async () => {
    eventosGoogle.delete.mockRejectedValue(gaxios(500, 'Backend Error'));
    const { service, llamadas } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            estado: 'COMPLETADO',
            google_calendar_id: 'ev-viejo',
          },
          error: null,
        },
      ],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(false);

    expect(eventosGoogle.delete).toHaveBeenCalledTimes(1);
    expect(de(llamadas, 'mantenimiento', 'update')).toHaveLength(0);
  });

  it('COMPLETADO con el evento ya borrado en Google (404): se da por hecho y limpia la columna', async () => {
    eventosGoogle.delete.mockRejectedValue(gaxios(404, 'Not Found'));
    const { service, llamadas } = armar({
      mantenimiento: [
        {
          data: {
            ...MANT,
            estado: 'COMPLETADO',
            google_calendar_id: 'ev-viejo',
          },
          error: null,
        },
      ],
    });

    await expect(service.syncMantenimiento('m-1')).resolves.toBe(true);

    expect(de(llamadas, 'mantenimiento', 'update')[0].args[0]).toEqual({
      google_calendar_id: null,
    });
  });

  it('un tramo que falla NO cancela los siguientes (se publica el resto del itinerario)', async () => {
    // El tramo 1 ya tenía evento y su update falla con 403 de cuota; el 2 es
    // nuevo y DEBE publicarse igual.
    eventosGoogle.update.mockRejectedValue(gaxios(403, 'Rate Limit Exceeded'));
    const conIda = {
      ...VUELO_MULTIESCALA,
      escalas: [
        { ...VUELO_MULTIESCALA.escalas[0], google_calendar_id: 'ev-t1' },
        VUELO_MULTIESCALA.escalas[1],
      ],
    };
    const { service } = armar({ vuelo: [{ data: conIda, error: null }] });

    await expect(service.syncFlight('v-1')).resolves.toBe(false);

    // El tramo 2 sí se creó; el 1 NO se duplicó.
    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    expect(insertado().requestBody.summary).toContain('T2 Ferry');
  });

  it('dos corridas seguidas sobre el mismo mantenimiento: un solo evento (update, nunca insert)', async () => {
    const { service } = armar({
      mantenimiento: [
        { data: MANT, error: null },
        { data: { ...MANT, google_calendar_id: 'ev-nuevo' }, error: null },
      ],
    });

    await service.syncMantenimiento('m-1');
    await service.syncMantenimiento('m-1');

    expect(eventosGoogle.insert).toHaveBeenCalledTimes(1);
    expect(eventosGoogle.update).toHaveBeenCalledTimes(1);
    expect(actualizado().eventId).toBe('ev-nuevo');
  });
});

// ===== C2/C6 · el barrido también LIMPIA los cancelados =====

describe('CalendarSyncService.resyncTodo — cancelados y parámetros', () => {
  it('barre los CANCELADOS de la ventana (borra su evento) sin contarlos como publicados', async () => {
    const { service, llamadas } = armar({
      vuelo: [
        {
          data: [
            { id: 'v-1', estado: 'CONFIRMADO' },
            { id: 'v-cancelado', estado: 'CANCELADO' },
          ],
          error: null,
        },
      ],
      piloto_descanso: [{ data: [], error: null }],
      evento_flota: [{ data: [], error: null }],
      mantenimiento: [{ data: [], error: null }],
    });
    const syncFlight = jest
      .spyOn(service, 'syncFlight')
      .mockResolvedValue(true);

    const r = await service.resyncTodo();

    // El cancelado SÍ pasa por syncFlight (que hace removeFlight): si no, un
    // borrado que falló cuando Google estaba caído se quedaba de fantasma.
    expect(syncFlight).toHaveBeenCalledWith('v-cancelado');
    // La consulta ya NO excluye los cancelados.
    expect(
      de(llamadas, 'vuelo', 'neq').filter((l) => l.args[0] === 'estado'),
    ).toHaveLength(0);
    expect(r.vuelos).toBe(1);
    expect(r.errores).toBe(0);
  });

  it('un `desde` que pasa @IsISO8601 pero no es fecha real responde 400, nunca 500', async () => {
    const { service } = armar({});
    // `2026-W01-1` y la coma decimal pasan el validador y daban RangeError.
    await expect(service.resyncTodo({ desde: '2026-W01-1' })).rejects.toThrow(
      /no es una fecha válida/,
    );
    await expect(
      service.resyncTodo({ hasta: '2026-08-01T00:00:00,000Z' }),
    ).rejects.toThrow(/«hasta»/);
  });
});

describe('arranque tolerante de la credencial (incidente Railway 12-sep-2026)', () => {
  it('JSON pegado entre comillas → la sync arranca igual y sin motivo', () => {
    const { service } = armar(
      {},
      {
        GOOGLE_SERVICE_ACCOUNT_JSON:
          '"{\"client_email\":\"sa@vuelatour.iam.gserviceaccount.com\",\"private_key\":\"k\"}"',
      },
    );
    const estado = service.estadoSync();
    expect(estado.enabled).toBe(true);
    expect(estado.motivo).toBeNull();
  });

  it('JSON roto → apagada con motivo legible y SIN el valor de la variable', () => {
    const { service } = armar(
      {},
      { GOOGLE_SERVICE_ACCOUNT_JSON: '"{"type":"x"' },
    );
    const estado = service.estadoSync();
    expect(estado.enabled).toBe(false);
    expect(estado.motivo).toMatch(/No se pudo leer la credencial/);
    expect(estado.motivo).not.toContain('"type"');
  });

  it('variable de encendido en false → motivo dice cuál variable', () => {
    const { service } = armar({}, { GOOGLE_CALENDAR_SYNC_ENABLED: false });
    expect(service.estadoSync().motivo).toMatch(/GOOGLE_CALENDAR_SYNC_ENABLED/);
  });

  it('falta el calendario → motivo lo nombra', () => {
    const { service } = armar({}, { GOOGLE_CALENDAR_ID: '' });
    expect(service.estadoSync().motivo).toMatch(/GOOGLE_CALENDAR_ID/);
  });
});
