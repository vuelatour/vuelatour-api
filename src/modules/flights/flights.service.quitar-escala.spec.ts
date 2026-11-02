// Mismos stubs que flights.service.ola-b.spec.ts: notifications arrastra el
// gateway y `jose` (ESM), calendar-sync googleapis, vision el SDK de IA y
// pilots calendar/users (push, firebase).
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

import { HttpException, Logger } from '@nestjs/common';
import { FlightsService } from './flights.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';

/**
 * QUITAR UNA ESCALA INTERMEDIA QUE NO SE HIZO (2-nov-2026, API 0.0.114,
 * invariante 113) — orquestación de `quitarEscala`: qué se lee, qué se
 * escribe (PATCH de A, borrado de B, renumeración, ligas, notas internas),
 * qué se avisa y qué NO (el estado del vuelo). La regla pura vive en
 * `escala-quitada.util.spec.ts`. Supabase se simula con un builder
 * encadenable (contrato, no BD).
 */
type Row = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Resultado = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
};

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'gte',
  'lte',
  'gt',
  'lt',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(
  resolver: (tabla: string, ops: Op[], lista: boolean) => Resultado,
) {
  const llamadas: { tabla: string; ops: Op[] }[] = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops, lista);
        return {
          data: r.data === undefined ? (lista ? [] : null) : r.data,
          error: r.error ?? null,
          count: r.count ?? null,
        };
      };
      for (const m of METODOS) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.single = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res, rej);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, llamadas };
}

const tiene = (ops: Op[], m: string): boolean => ops.some((o) => o.m === m);
const selectDe = (ops: Op[]): string => {
  const sel = ops.find((o) => o.m === 'select')?.args[0];
  return typeof sel === 'string' ? sel : '';
};
const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const B = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const C = 'aaaaaaaa-0000-4000-8000-0000000000c3';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';
const OTRO_PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000c';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 496,
    cliente_id: 'aaaaaaaa-0000-4000-8000-00000000000d',
    aeronave_id: AVION,
    piloto_id: PILOTO,
    copiloto_id: null,
    apoyo_id: null,
    estado: 'COMPLETADO',
    es_externo: false,
    cobrado: false,
    facturado: false,
    metodo_cobro: null,
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    pasajeros: 4,
    monto_total_usd: 3866.61,
    tc_usd_mxn: 18.6673,
    fecha_vuelo: '2026-10-29T16:30:00+00:00',
    fecha_fin: '2026-10-29T16:30:00+00:00',
    fecha_traslado_final: null,
    grupo_id: null,
    combinado_con_id: null,
    notas_internas: 'Confirmar con Pablo el vuelo',
    updated_at: '2026-11-02T17:49:26.573178+00:00',
    ...extra,
  };
}

function tramo(extra: Row = {}): Row {
  return {
    id: A,
    vuelo_id: V1,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    aeronave_id: AVION,
    piloto_id: null,
    copiloto_id: null,
    estado_permiso: 'emitido',
    fecha_salida_plan: '2026-10-29T16:30:00+00:00',
    google_calendar_id: null,
    pasajeros: 4,
    pasajeros_nombres: [],
    es_ferry: false,
    es_sobrevuelo: false,
    requiere_pernocta: false,
    pernocta_costo_usd: null,
    tipo_parada: 'NORMAL',
    servicio_notas: null,
    solo_operativa: false,
    taco_salida: '1680.6',
    taco_llegada: '1682.3',
    taco_salida_origen: 'PILOTO',
    taco_llegada_origen: 'PILOTO',
    foto_taco_salida_url: null,
    foto_taco_llegada_url: null,
    valor_ia_propuesto: null,
    revision_requerida: true,
    revision_motivo:
      'Duración 102 min fuera de rango histórico (~32 min); Registro: salida capturada por Pablo Canales · llegada capturada por Pablo Canales',
    hora_salida: '2026-10-29T18:02:38.789+00:00',
    hora_llegada: '2026-10-29T18:28:00.687+00:00',
    capturado_offline: false,
    sincronizado_at: '2026-10-29T18:28:01.03+00:00',
    capturado_por: PILOTO,
    corregido_por: null,
    nota_correccion: null,
    corregido_at: null,
    taco_salida_obs: null,
    taco_llegada_obs: null,
    taco_obs_updated_by: null,
    taco_obs_updated_at: null,
    notas: null,
    cancelada_at: null,
    cancelada_motivo: null,
    cancelada_por: null,
    taco_omitido_at: null,
    taco_omitido_por: null,
    taco_omitido_motivo: null,
    created_at: '2026-10-27T22:29:12.728751+00:00',
    updated_at: '2026-10-29T18:28:01.488609+00:00',
    ...extra,
  };
}

const tramoA = (extra: Row = {}) => tramo(extra);
const tramoB = (extra: Row = {}) =>
  tramo({
    id: B,
    orden: 2,
    origen_iata: 'HOL',
    destino_iata: 'TQO',
    google_calendar_id: 'evento-b',
    taco_salida: null,
    taco_salida_origen: null,
    hora_salida: null,
    hora_llegada: '2026-10-30T00:49:50.143+00:00',
    sincronizado_at: '2026-10-30T00:49:50.637+00:00',
    capturado_offline: true,
    revision_motivo:
      'Salida estimada retirada: la llegada real (1682.3) la contradecía — confirmar salida en oficina',
    ...extra,
  });

interface Mundo {
  vuelo?: Row | null;
  /** Tramo A (por id); null = no existe. */
  a?: Row | null;
  /** Tramo ACTIVO siguiente a A (null = A es el último). */
  siguiente?: Row | null;
  /** Tramos comerciales posteriores a B (`id, orden`) para renumerar. */
  posteriores?: Row[];
  /** `escalasTaco` del vuelo (para el autocierre EN_VUELO → COMPLETADO). */
  escalasTaco?: Row[];
  /** Apoyos por escala_id. */
  apoyos?: Record<string, Row[]>;
  deleteError?: { code?: string; message: string };
}

function armar(m: Mundo = {}) {
  const updates: { tabla: string; patch: Row; eqId: unknown }[] = [];
  const deletes: { tabla: string; eqId: unknown }[] = [];
  const a = m.a === undefined ? tramoA() : m.a;
  const b = m.siguiente === undefined ? tramoB() : m.siguiente;
  const { supabase, llamadas } = fakeSupabase((tabla, ops, lista) => {
    const upd = ops.find((o) => o.m === 'update');
    if (upd) {
      updates.push({ tabla, patch: upd.args[0] as Row, eqId: eqDe(ops, 'id') });
    }
    if (tiene(ops, 'delete')) {
      deletes.push({ tabla, eqId: eqDe(ops, 'id') });
      return m.deleteError ? { error: m.deleteError } : {};
    }
    switch (tabla) {
      case 'vuelo': {
        // Sonda del cierre de mes (`periodo_contable`): sin la migración.
        if (selectDe(ops) === 'periodo_contable') {
          return {
            error: {
              code: '42703',
              message: 'column vuelo.periodo_contable does not exist',
            },
          };
        }
        const fila = m.vuelo === undefined ? vueloRow() : m.vuelo;
        if (upd)
          return { data: fila ? { ...fila, ...(upd.args[0] as Row) } : null };
        if (lista) return { data: fila ? [fila] : [] };
        return { data: fila };
      }
      case 'escala': {
        // Sonda del tacómetro omitido: las columnas existen.
        if (selectDe(ops) === 'taco_omitido_at' && !tiene(ops, 'eq')) {
          return { data: [] };
        }
        if (upd) {
          const id = eqDe(ops, 'id');
          const base = id === A ? a : id === B ? b : { id };
          return { data: { ...(base ?? {}), ...(upd.args[0] as Row) } };
        }
        // Siguiente tramo ACTIVO (gt orden + is cancelada_at null + limit 1).
        if (tiene(ops, 'gt') && tiene(ops, 'is') && tiene(ops, 'limit')) {
          return { data: b ? [b] : [] };
        }
        // Renumeración: `id, orden` posteriores a B.
        if (selectDe(ops) === 'id, orden') return { data: m.posteriores ?? [] };
        // escalasTaco (autocierre).
        if (selectDe(ops).startsWith('orden, taco_salida')) {
          return { data: m.escalasTaco ?? [] };
        }
        if (eqDe(ops, 'id') !== undefined) {
          const id = eqDe(ops, 'id');
          const fila = id === A ? a : id === B ? b : null;
          return lista ? { data: fila ? [fila] : [] } : { data: fila };
        }
        // Listas por vuelo (tripulación, participación…).
        return { data: [a, b].filter((f): f is Row => !!f) };
      }
      case 'usuario':
        return {
          data: [{ id: USER, nombre: 'Ale', rol: 'ADMIN' }],
        };
      case 'vuelo_apoyo': {
        const esc = eqDe(ops, 'escala_id') as string | undefined;
        if (esc) return { data: m.apoyos?.[esc] ?? [] };
        return { data: [] };
      }
      default:
        return {};
    }
  });
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifyRole = jest.fn().mockResolvedValue(true);
  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const removeEscalaEvent = jest.fn().mockResolvedValue(undefined);
  const refreshPermisosDeVuelo = jest.fn().mockResolvedValue(undefined);
  const service = new FlightsService(
    supabase,
    {
      syncFlight,
      removeFlight: jest.fn(),
      removeEscalaEvent,
    } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {
      notifyUser,
      notifyRole,
      notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    } as unknown as NotificationsService,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo } as unknown as AirportsService,
    {
      numero: jest.fn().mockResolvedValue(8.857),
    } as unknown as ConfiguracionService,
    {} as PilotsService,
  );
  const complete = jest
    .spyOn(service, 'complete')
    .mockResolvedValue(vueloRow({ estado: 'COMPLETADO' }) as never);
  return {
    service,
    llamadas,
    updates,
    deletes,
    notifyUser,
    syncFlight,
    removeEscalaEvent,
    refreshPermisosDeVuelo,
    complete,
  };
}

/** status + code + message + details de una HttpException estructurada. */
async function rebote(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const r = err.getResponse() as Record<string, unknown>;
    return {
      status: err.getStatus(),
      code: (typeof r === 'object' ? r.error : undefined) as string | undefined,
      message: err.message,
      details: (typeof r === 'object' ? r.details : undefined) as
        | Record<string, unknown>
        | undefined,
    };
  }
  throw new Error('no rebotó');
}

const MOTIVO = 'No bajamos en Holbox: fuimos directo a Tulum';
const escalaUpdates = (w: ReturnType<typeof armar>) =>
  w.updates.filter((u) => u.tabla === 'escala');

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('quitarEscala · caso #496 (COMPLETADO): CUN→HOL + HOL→TQO ⇒ CUN→TQO', () => {
  it('PATCH de A con la llegada de B, borra B, renumera C, sella notas, espeja y avisa; el estado NO cambia', async () => {
    const w = armar({ posteriores: [{ id: C, orden: 3 }] });
    const r = (await w.service.quitarEscala(A, MOTIVO, USER)) as Row & {
      fusion: Row;
    };
    // 1) A fusionado.
    const patchA = escalaUpdates(w).find((u) => u.eqId === A)?.patch;
    expect(patchA).toMatchObject({
      destino_iata: 'TQO',
      taco_llegada: '1682.3',
      taco_llegada_origen: 'PILOTO',
      hora_llegada: '2026-10-30T00:49:50.143+00:00',
      estado_permiso: 'emitido',
      capturado_offline: true,
      revision_requerida: true,
      updated_by: USER,
      taco_omitido_at: null,
    });
    expect(patchA).not.toHaveProperty('taco_salida');
    expect(patchA?.revision_motivo).toMatch(
      /^Escala en HOL quitada \(no se aterrizó\)/,
    );
    expect(patchA?.revision_motivo).toContain('por Ale');
    // 2) B borrado (su evento de Google, antes) y C renumerado a 2.
    expect(w.removeEscalaEvent).toHaveBeenCalledWith('evento-b');
    expect(w.deletes).toEqual([{ tabla: 'escala', eqId: B }]);
    expect(escalaUpdates(w).find((u) => u.eqId === C)?.patch).toEqual({
      orden: 2,
      updated_by: USER,
    });
    // Orden de escritura: A se actualiza ANTES de borrar B (si el borrado
    // falla, no se pierde la llegada a TQO).
    const iUpd = w.llamadas.findIndex(
      (l) =>
        l.tabla === 'escala' &&
        tiene(l.ops, 'update') &&
        eqDe(l.ops, 'id') === A,
    );
    const iDel = w.llamadas.findIndex(
      (l) => l.tabla === 'escala' && tiene(l.ops, 'delete'),
    );
    expect(iUpd).toBeGreaterThan(-1);
    expect(iDel).toBeGreaterThan(iUpd);
    // 3) Gastos ligados a B pasan a A.
    expect(w.updates.find((u) => u.tabla === 'gasto')?.patch).toEqual({
      escala_id: A,
    });
    // 4) Notas internas del vuelo con el sello y el motivo; NUNCA el estado.
    const vuelo = w.updates.find((u) => u.tabla === 'vuelo')?.patch;
    expect(vuelo?.notas_internas).toContain(
      'Confirmar con Pablo el vuelo\n[Escala HOL quitada ',
    );
    expect(vuelo?.notas_internas).toContain(MOTIVO);
    expect(vuelo?.notas_internas).toContain('CUN→HOL + HOL→TQO ⇒ CUN→TQO');
    for (const u of w.updates.filter((u) => u.tabla === 'vuelo')) {
      expect(u.patch).not.toHaveProperty('estado');
    }
    expect(w.complete).not.toHaveBeenCalled();
    // 5) Permisos, calendario, tripulación.
    expect(w.refreshPermisosDeVuelo).toHaveBeenCalledWith(V1);
    expect(w.syncFlight).toHaveBeenCalledWith(V1);
    await new Promise((res) => setTimeout(res, 0));
    const avisos = w.notifyUser.mock.calls as [
      string,
      { titulo: string; cuerpo: string },
    ][];
    const aviso = avisos.find((c) => c[0] === PILOTO);
    expect(aviso).toBeDefined();
    const n = aviso![1];
    expect(n.titulo).toBe('Escala quitada · vuelo #496');
    expect(n.cuerpo).toContain(
      'Se quitó la escala en HOL: el tramo ahora es CUN → TQO',
    );
    // 6) Respuesta: el tramo fusionado + `fusion`.
    expect(r.destino_iata).toBe('TQO');
    expect(r.fusion).toMatchObject({
      escala_quitada_id: B,
      escala_iata: 'HOL',
      tramo_a: 'CUN→HOL',
      tramo_b: 'HOL→TQO',
      salida_retirada: false,
      descartada: { taco_llegada: 1682.3, taco_llegada_origen: 'PILOTO' },
    });
    expect(r.fusion.aviso).toContain('La llegada a HOL capturada');
  });

  it('salida de A que no cabe bajo la llegada de B: se retira en el PATCH y la respuesta lo avisa', async () => {
    const w = armar({ a: tramoA({ taco_salida: '1682.5' }) });
    const r = (await w.service.quitarEscala(A, MOTIVO, USER)) as Row & {
      fusion: Row;
    };
    const patchA = escalaUpdates(w).find((u) => u.eqId === A)?.patch;
    expect(patchA).toMatchObject({
      taco_salida: null,
      taco_salida_origen: null,
    });
    expect(r.fusion.salida_retirada).toBe(true);
    expect(r.fusion.aviso).toContain('se retiró');
  });

  it('apoyos SOLO del tramo B pasan a A, salvo los que A ya tiene (esos caen con el CASCADE)', async () => {
    const w = armar({
      apoyos: {
        [B]: [
          { id: 'ap-1', usuario_id: 'u-1' },
          { id: 'ap-2', usuario_id: 'u-2' },
        ],
        [A]: [{ id: 'ap-9', usuario_id: 'u-2' }],
      },
    });
    await w.service.quitarEscala(A, MOTIVO, USER);
    const apoyos = w.updates.filter((u) => u.tabla === 'vuelo_apoyo');
    expect(apoyos).toEqual([
      { tabla: 'vuelo_apoyo', patch: { escala_id: A }, eqId: 'ap-1' },
    ]);
  });

  it('si borrar B falla DESPUÉS de fusionar A ⇒ 409 ESCALA_FUSION_INCOMPLETA (la llegada a TQO ya está en A)', async () => {
    const w = armar({ deleteError: { message: 'boom' } });
    const r = await rebote(w.service.quitarEscala(A, MOTIVO, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('ESCALA_FUSION_INCOMPLETA');
    expect(r.message).toContain('ya quedó como CUN → TQO');
    expect(escalaUpdates(w).find((u) => u.eqId === A)).toBeDefined();
  });
});

describe('quitarEscala · estado del vuelo: solo AVANZA EN_VUELO → COMPLETADO', () => {
  it('EN_VUELO con todas las llegadas ⇒ complete(); con una llegada faltante, no', async () => {
    const w = armar({
      vuelo: vueloRow({ estado: 'EN_VUELO' }),
      escalasTaco: [
        { orden: 1, taco_salida: 1680.6, taco_llegada: 1682.3 },
        { orden: 2, taco_salida: 1682.3, taco_llegada: 1682.8 },
      ],
    });
    await w.service.quitarEscala(A, MOTIVO, USER);
    expect(w.complete).toHaveBeenCalledWith(V1, USER);

    const w2 = armar({
      vuelo: vueloRow({ estado: 'EN_VUELO' }),
      escalasTaco: [
        { orden: 1, taco_salida: 1680.6, taco_llegada: 1682.3 },
        { orden: 2, taco_salida: 1682.3, taco_llegada: null },
      ],
    });
    await w2.service.quitarEscala(A, MOTIVO, USER);
    expect(w2.complete).not.toHaveBeenCalled();
  });
});

describe('quitarEscala · rechazos (nada se escribe)', () => {
  const sinEscrituras = (w: ReturnType<typeof armar>) => {
    expect(w.updates).toEqual([]);
    expect(w.deletes).toEqual([]);
    expect(w.removeEscalaEvent).not.toHaveBeenCalled();
  };

  it('tramo inexistente ⇒ 404 ESCALA_NO_EXISTE', async () => {
    const w = armar({ a: null });
    const r = await rebote(w.service.quitarEscala(A, MOTIVO, USER));
    expect(r.status).toBe(404);
    expect(r.code).toBe('ESCALA_NO_EXISTE');
    sinEscrituras(w);
  });

  it('último tramo activo ⇒ 409 ESCALA_FINAL', async () => {
    const w = armar({ siguiente: null });
    const r = await rebote(w.service.quitarEscala(A, MOTIVO, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('ESCALA_FINAL');
    expect(r.details).toEqual({ escala_id: A, destino_iata: 'HOL' });
    sinEscrituras(w);
  });

  it('el siguiente no sale de donde llega A ⇒ 409 ESCALA_NO_ENLAZA', async () => {
    const w = armar({ siguiente: tramoB({ origen_iata: 'MID' }) });
    const r = await rebote(w.service.quitarEscala(A, MOTIVO, USER));
    expect(r.code).toBe('ESCALA_NO_ENLAZA');
    sinEscrituras(w);
  });

  it('tramo operativo ⇒ 409 ESCALA_OPERATIVA; tramo cancelado ⇒ 409 ESCALA_CANCELADA; vuelo CANCELADO ⇒ 409 VUELO_CANCELADO', async () => {
    const op = armar({
      siguiente: tramoB({ solo_operativa: true, orden: 100 }),
    });
    expect((await rebote(op.service.quitarEscala(A, MOTIVO, USER))).code).toBe(
      'ESCALA_OPERATIVA',
    );
    sinEscrituras(op);
    const canc = armar({ a: tramoA({ cancelada_at: '2026-10-30T00:00:00Z' }) });
    expect(
      (await rebote(canc.service.quitarEscala(A, MOTIVO, USER))).code,
    ).toBe('ESCALA_CANCELADA');
    sinEscrituras(canc);
    const vc = armar({ vuelo: vueloRow({ estado: 'CANCELADO' }) });
    expect((await rebote(vc.service.quitarEscala(A, MOTIVO, USER))).code).toBe(
      'VUELO_CANCELADO',
    );
    sinEscrituras(vc);
  });

  it('aviones distintos ⇒ 409 ESCALAS_DISTINTO_AVION', async () => {
    const w = armar({ siguiente: tramoB({ aeronave_id: 'otro' }) });
    expect((await rebote(w.service.quitarEscala(A, MOTIVO, USER))).code).toBe(
      'ESCALAS_DISTINTO_AVION',
    );
    sinEscrituras(w);
  });
});

describe('quitarEscala · PILOTO: solo tripulación y con el vuelo COMPLETADO', () => {
  const piloto = (userId: string): AuthenticatedUser =>
    ({ userId, rol: Rol.PILOTO }) as unknown as AuthenticatedUser;

  it('vuelo EN_VUELO ⇒ 403 (la ruta la corrige oficina)', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'EN_VUELO' }) });
    const r = await rebote(
      w.service.quitarEscala(A, MOTIVO, PILOTO, piloto(PILOTO)),
    );
    expect(r.status).toBe(403);
    expect(r.message).toContain('ya se completó');
    expect(w.updates).toEqual([]);
  });

  it('no tripulante ⇒ 403; tripulante y COMPLETADO ⇒ fusiona', async () => {
    const ajeno = armar();
    const r = await rebote(
      ajeno.service.quitarEscala(A, MOTIVO, OTRO_PILOTO, piloto(OTRO_PILOTO)),
    );
    expect(r.status).toBe(403);
    expect(r.message).toContain('Solo la tripulación');
    expect(ajeno.updates).toEqual([]);

    const propio = armar();
    const res = (await propio.service.quitarEscala(
      A,
      MOTIVO,
      PILOTO,
      piloto(PILOTO),
    )) as Row;
    expect(res.destino_iata).toBe('TQO');
    expect(propio.deletes).toEqual([{ tabla: 'escala', eqId: B }]);
  });
});
