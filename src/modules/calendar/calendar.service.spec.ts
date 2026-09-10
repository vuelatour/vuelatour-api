// Dependencias pesadas (gateway/jose/googleapis/firebase) fuera del spec.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../realtime/push.service', () => ({ PushService: class {} }));
jest.mock('./calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import type { CalendarRangeQuery } from './dto/calendar.dto';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { CalendarSyncService } from './calendar-sync.service';
import type { PushService } from '../realtime/push.service';

/**
 * Lote 2 Ola B (10-sep-2026) en calendario:
 *  - B1: PATCH /calendar/eventos/:id con `if_updated_at` → CAS solo cuando
 *    evento_flota ya tiene trigger de updated_at (sonda rpc); si no, se
 *    salta con warn una vez. 0 filas → 409 CONFLICTO_VERSION con EventoMe.
 *  - B5: GET /calendar?updated_since= devuelve solo lo tocado (vuelo o
 *    alguno de sus tramos, descanso, evento, mantenimiento) + `eliminados`.
 */
type Resultado = {
  data: unknown;
  error: null | { code?: string; message: string };
  count?: number | null;
};
type Llamada = { tabla: string; metodo: string; args: unknown[] };

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
    llamadas.push({ tabla, metodo: 'from', args: [tabla] });
    const cadena: Llamada[] = [];
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        const l = { tabla, metodo, args };
        llamadas.push(l);
        cadena.push(l);
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
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = registra(m);
    }
    // Resolución PEREZOSA (al await) para que el orden de resultados por
    // tabla sea el orden real de las consultas. La sonda de ColumnaOpcional
    // (`select('client_request_id').limit(1)`) responde "existe" sin
    // consumir resultados.
    const resolver = (): Resultado => {
      const sel = cadena.find((l) => l.metodo === 'select');
      const esSonda =
        cadena.length === 2 &&
        cadena.some((l) => l.metodo === 'limit') &&
        sel?.args[0] === 'client_request_id';
      if (esSonda) return { data: [], error: null };
      return siguiente(tabla);
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (
      resolve: (v: Resultado) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resolver()).then(resolve, reject);
    return q;
  };
  const rpc = jest.fn();
  return { llamadas, service: { from, rpc }, rpc };
}

function armar(tablas: Record<string, Resultado[]>) {
  const sb = armarSupabase(tablas);
  const supabase = { service: sb.service } as unknown as SupabaseService;
  const notifications = {
    notifyUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
  const calendarSync = {
    upsertEventoFlotaEvent: jest.fn().mockResolvedValue(undefined),
    removeEventoFlotaEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as CalendarSyncService;
  const push = {
    contarDispositivosPorUsuario: jest.fn().mockResolvedValue(new Map()),
  } as unknown as PushService;
  const service = new CalendarService(
    supabase,
    notifications,
    calendarSync,
    push,
  );
  return { service, llamadas: sb.llamadas, rpc: sb.rpc };
}

const de = (llamadas: Llamada[], tabla: string, metodo: string) =>
  llamadas.filter((l) => l.tabla === tabla && l.metodo === metodo);

const EVENTO = {
  id: 'ev-1',
  titulo: 'Lavado XA-VGV',
  fecha: '2026-09-16T14:00:00+00:00',
  fecha_fin: null,
  aeronave_id: null,
  responsable_id: null,
  notas: null,
  created_at: '2026-09-10T10:00:00+00:00',
  updated_at: '2026-09-10T15:00:00.123456+00:00',
  created_by: 'u-admin',
  google_calendar_id: null,
  client_request_id: null,
  aeronave: null,
  responsable: null,
  creador: { nombre: 'Ana' },
};

describe('CalendarService.updateEvento — B1 if_updated_at', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('con trigger activo (rpc → true) el UPDATE lleva la ventana ±1 ms', async () => {
    const { service, llamadas, rpc } = armar({
      evento_flota: [
        { data: EVENTO, error: null }, // cargarEvento (prev)
        { data: { ...EVENTO, titulo: 'Lavado' }, error: null }, // UPDATE
      ],
    });
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await service.updateEvento(
      'ev-1',
      { titulo: 'Lavado', if_updated_at: '2026-09-10T15:00:00.123Z' },
      'u-admin',
    );
    expect(res).toMatchObject({ id: 'ev-1', titulo: 'Lavado', aviso: null });
    expect(rpc).toHaveBeenCalledWith('updated_at_trigger_activo', {
      p_tabla: 'evento_flota',
    });
    expect(de(llamadas, 'evento_flota', 'gte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.122Z',
    ]);
    expect(de(llamadas, 'evento_flota', 'lte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.124Z',
    ]);
    const payload = de(llamadas, 'evento_flota', 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('if_updated_at');
    expect(payload).toMatchObject({ titulo: 'Lavado', updated_by: 'u-admin' });
    expect(typeof payload.updated_at).toBe('string');
  });

  it('sin trigger (migración pendiente) el CAS se salta con un warn: comportamiento de siempre', async () => {
    const { service, llamadas, rpc } = armar({
      evento_flota: [
        { data: EVENTO, error: null },
        { data: { ...EVENTO, titulo: 'Lavado' }, error: null },
      ],
    });
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    await service.updateEvento(
      'ev-1',
      { titulo: 'Lavado', if_updated_at: '2026-09-10T15:00:00.123Z' },
      'u-admin',
    );
    expect(de(llamadas, 'evento_flota', 'gte')).toHaveLength(0);
    expect(de(llamadas, 'evento_flota', 'lte')).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const aviso = (warn.mock.calls as unknown[][])[0][0];
    expect(String(aviso)).toMatch(/evento_flota/);
  });

  it('0 filas con CAS → 409 CONFLICTO_VERSION con el EventoMe vivo; sin el campo, 404', async () => {
    const vivo = { ...EVENTO, updated_at: '2026-09-10T16:00:00+00:00' };
    const { service, rpc } = armar({
      evento_flota: [
        { data: EVENTO, error: null }, // prev
        { data: null, error: null }, // UPDATE CAS: 0 filas
        { data: vivo, error: null }, // relectura
      ],
    });
    rpc.mockResolvedValue({ data: true, error: null });
    let err: unknown;
    try {
      await service.updateEvento(
        'ev-1',
        { titulo: 'Lavado', if_updated_at: '2026-09-10T15:00:00.123Z' },
        'u-admin',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      error: string;
      message: string;
      details: { actual: Record<string, unknown>; updated_at_actual: string };
    };
    expect(body.error).toBe('CONFLICTO_VERSION');
    expect(body.message).toMatch(/modificó este evento/);
    expect(body.details.updated_at_actual).toBe('2026-09-10T16:00:00+00:00');
    // details.actual = proyección pública (EventoMe), sin internos.
    expect(body.details.actual).toMatchObject({
      id: 'ev-1',
      titulo: 'Lavado XA-VGV',
      updated_at: '2026-09-10T16:00:00+00:00',
      client_request_id: null,
    });
    expect(body.details.actual).not.toHaveProperty('google_calendar_id');

    const sinLlave = armar({
      evento_flota: [
        { data: EVENTO, error: null },
        { data: null, error: null },
      ],
    });
    await expect(
      sinLlave.service.updateEvento('ev-1', { titulo: 'Lavado' }, 'u-admin'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CalendarService.listEvents — B5 updated_since', () => {
  const rango: CalendarRangeQuery = {
    from: new Date('2026-09-14T00:00:00Z'),
    to: new Date('2026-09-20T23:59:59Z'),
    incluir_mantenimientos: true,
  };
  const vuelo = (
    id: string,
    updatedAt: string,
    escalaUpdatedAt: string | null = null,
  ) => ({
    id,
    folio: 1,
    fecha_vuelo: '2026-09-16T14:00:00+00:00',
    fecha_traslado_final: null,
    fecha_fin: '2026-09-16T14:00:00+00:00',
    tipo: 'SENCILLO',
    estado: 'CONFIRMADO',
    es_externo: false,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    pasajeros: 2,
    pasajeros_nombres: null,
    notas: null,
    notas_internas: null,
    motivo_cancelacion: null,
    monto_total_usd: '100',
    aeronave_id: 'a-1',
    piloto_id: 'p-1',
    copiloto_id: null,
    cliente_id: 'c-1',
    operador_externo: null,
    estado_permiso: 'emitido',
    google_calendar_id: null,
    client_request_id: null,
    grupo_id: null,
    grupo_posicion: null,
    grupo_pax: null,
    updated_at: updatedAt,
    grupo: null,
    aeronave: { matricula: 'XA-VGV', color_calendario: '#000' },
    piloto: { nombre: 'Luis' },
    copiloto: null,
    cliente: { nombre: 'ACME' },
    apoyos: [],
    escalas: escalaUpdatedAt
      ? [
          {
            id: `${id}-e1`,
            orden: 1,
            origen_iata: 'CUN',
            destino_iata: 'HOL',
            fecha_salida_plan: '2026-09-16T14:00:00+00:00',
            es_ferry: false,
            pasajeros: 2,
            pasajeros_nombres: null,
            notas: null,
            aeronave_id: null,
            piloto_id: null,
            copiloto_id: null,
            estado_permiso: 'emitido',
            cancelada_at: null,
            updated_at: escalaUpdatedAt,
            aeronave: null,
            piloto: null,
            copiloto: null,
          },
        ]
      : [],
  });
  const tablas = () => ({
    vuelo: [
      {
        data: [
          vuelo('v-viejo', '2026-09-01T00:00:00+00:00'),
          vuelo('v-nuevo', '2026-09-15T12:00:00+00:00'),
          // Solo el TRAMO cambió (asignación por tramo): también cuenta.
          vuelo(
            'v-tramo',
            '2026-09-01T00:00:00+00:00',
            '2026-09-15T13:00:00+00:00',
          ),
        ],
        error: null,
      },
    ],
    piloto_descanso: [
      {
        data: [
          {
            id: 'd-viejo',
            piloto_id: 'p-1',
            fecha_inicio: '2026-09-16',
            fecha_fin: '2026-09-16',
            motivo: null,
            updated_at: '2026-09-01T00:00:00+00:00',
            piloto: { nombre: 'Luis' },
          },
          {
            id: 'd-nuevo',
            piloto_id: 'p-2',
            fecha_inicio: '2026-09-17',
            fecha_fin: '2026-09-17',
            motivo: null,
            updated_at: '2026-09-15T12:00:00+00:00',
            piloto: { nombre: 'Ana' },
          },
        ],
        error: null,
      },
    ],
    evento_flota: [
      {
        data: [
          {
            ...EVENTO,
            id: 'ev-viejo',
            updated_at: '2026-09-01T00:00:00+00:00',
          },
          {
            ...EVENTO,
            id: 'ev-nuevo',
            updated_at: '2026-09-15T12:00:00+00:00',
          },
        ],
        error: null,
      },
    ],
    mantenimiento: [
      {
        data: [
          {
            id: 'm-viejo',
            descripcion: 'Servicio 50',
            estado: 'PROGRAMADO',
            fecha_programada: '2026-09-18',
            aeronave_id: 'a-1',
            updated_at: '2026-09-01T00:00:00+00:00',
            aeronave: { matricula: 'XA-VGV' },
          },
          {
            id: 'm-nuevo',
            descripcion: 'Servicio 100',
            estado: 'EN_TALLER',
            fecha_programada: '2026-09-19',
            aeronave_id: 'a-1',
            updated_at: '2026-09-15T12:00:00+00:00',
            aeronave: { matricula: 'XA-VGV' },
          },
        ],
        error: null,
      },
    ],
    vuelo_eliminado: [
      {
        data: [{ vuelo_id: 'v-borrado' }, { vuelo_id: 'v-borrado' }],
        error: null,
      },
    ],
  });

  it('sin updated_since: respuesta de siempre (todo, sin `eliminados`, sin consultar vuelo_eliminado)', async () => {
    const { service, llamadas } = armar(tablas());
    const res = await service.listEvents(rango);
    const ids = res.events.map((e) => String(e.id));
    expect(ids).toEqual(
      expect.arrayContaining([
        'v-viejo',
        'v-nuevo',
        'v-tramo',
        'descanso:d-viejo:2026-09-16',
        'descanso:d-nuevo:2026-09-17',
        'evento:ev-viejo:2026-09-16',
        'evento:ev-nuevo:2026-09-16',
        'mant:m-viejo',
        'mant:m-nuevo',
      ]),
    );
    expect(res.count).toBe(9);
    expect(res).not.toHaveProperty('eliminados');
    expect(de(llamadas, 'vuelo_eliminado', 'from')).toHaveLength(0);
  });

  it('con updated_since: solo lo tocado desde entonces (vuelo O tramo) + eliminados únicos', async () => {
    const { service, llamadas } = armar(tablas());
    const res = await service.listEvents({
      ...rango,
      updated_since: new Date('2026-09-15T00:00:00Z'),
    });
    const ids = res.events.map((e) => String(e.id)).sort();
    expect(ids).toEqual(
      [
        'v-nuevo',
        'v-tramo',
        'descanso:d-nuevo:2026-09-17',
        'evento:ev-nuevo:2026-09-16',
        'mant:m-nuevo',
      ].sort(),
    );
    expect(res.count).toBe(5);
    expect(res).toMatchObject({
      updated_since: '2026-09-15T00:00:00.000Z',
      eliminados: ['v-borrado'],
    });
    expect(de(llamadas, 'vuelo_eliminado', 'gte')[0].args).toEqual([
      'eliminado_at',
      '2026-09-15T00:00:00.000Z',
    ]);
    // El filtro pide updated_at del vuelo y de sus tramos.
    const sel = String(de(llamadas, 'vuelo', 'select')[0].args[0]);
    expect(sel).toMatch(/grupo_pax, updated_at,/);
    expect(sel).toMatch(/cancelada_at, updated_at, aeronave:/);
  });
});
