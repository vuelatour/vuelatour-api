// Mismos stubs que flights.service.baja.spec.ts: notifications arrastra el
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
import type { ListFlightsQuery } from './dto/flights.dto';
import type { CreateCobroDto } from './dto/cobros.dto';
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';

/**
 * Lote 2 · Ola B (10-sep-2026) — ediciones sin red con «gana el servidor +
 * aviso» e idempotencia de altas:
 *  B1 control de versión `if_updated_at` → 409 CONFLICTO_VERSION (CAS ±1 ms)
 *  B2 tramos idempotentes por `client_request_id` (con y sin columna)
 *  B3 COBRO_EXCEDE_SALDO solo con llave (fuente única cobrosEnUsd)
 *  B4 codes en bajas/transiciones (message intacto)
 *  B5 GET /flights?updated_since + eliminados; updated_at expuesto
 * Supabase se simula con un builder encadenable: se prueba el CONTRATO
 * (codes, details, qué se escribe y qué NO), no la BD.
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
const esHead = (ops: Op[]): boolean =>
  ops.some(
    (o) =>
      o.m === 'select' && (o.args[1] as { head?: boolean } | undefined)?.head,
  );
const selectDe = (ops: Op[]): string => {
  const sel = ops.find((o) => o.m === 'select')?.args[0];
  return typeof sel === 'string' ? sel : '';
};
const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];
const argDe = (ops: Op[], m: string): unknown[] | undefined =>
  ops.find((o) => o.m === m)?.args;

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const E1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
/** Lo que guarda Postgres (microsegundos) y lo que reserializa la app (ms). */
const TS_DB = '2026-09-10T12:34:56.123456+00:00';
const TS_APP = '2026-09-10T12:34:56.123Z';
const TS_VIEJO = '2026-09-10T12:34:56.121Z';
const MSG_VUELO =
  'Alguien modificó este vuelo después de tu captura; se conserva la versión del servidor.';
const MSG_TRAMO =
  'Alguien modificó este tramo después de tu captura; se conserva la versión del servidor.';

function vueloRow(extra: Row = {}): Row {
  return {
    id: V1,
    folio: 118,
    cliente_id: 'aaaaaaaa-0000-4000-8000-00000000000d',
    aeronave_id: AVION,
    piloto_id: PILOTO,
    copiloto_id: null,
    apoyo_id: null,
    estado: 'RESERVA',
    es_externo: false,
    cobrado: false,
    facturado: false,
    metodo_cobro: null,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    pasajeros: 3,
    monto_total_usd: 1000,
    tc_usd_mxn: 17,
    fecha_vuelo: '2026-09-14T14:00:00+00:00',
    fecha_fin: '2026-09-14T18:00:00+00:00',
    grupo_id: null,
    combinado_con_id: null,
    notas_internas: null,
    updated_at: TS_DB,
    ...extra,
  };
}

function escalaRow(extra: Row = {}): Row {
  return {
    id: E1,
    vuelo_id: V1,
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    taco_salida_origen: null,
    taco_llegada_origen: null,
    foto_taco_salida_url: null,
    foto_taco_llegada_url: null,
    fecha_salida_plan: '2026-09-14T14:00:00+00:00',
    capturado_por: null,
    corregido_por: null,
    revision_motivo: null,
    notas: null,
    updated_at: TS_DB,
    ...extra,
  };
}

interface Mundo {
  /** Fila del vuelo (null = no existe). */
  vuelo?: Row | null;
  /** null = el UPDATE de vuelo devuelve 0 filas (CAS perdido / desapareció). */
  vueloUpdateData?: null;
  /** Fila del tramo para lecturas por id (null = no existe). */
  escala?: Row | null;
  /** null = el UPDATE de escala devuelve 0 filas. */
  escalaUpdateData?: null;
  /** Resultado del pre-check por llave (o secuencia de resultados). */
  escalaPorLlave?: Row | null;
  escalaPorLlaveSecuencia?: (Row | null)[];
  /** ¿Existe escala.client_request_id? (default true). */
  columnaLlave?: boolean;
  insertEscalaError?: { code: string; message: string };
  /** Cobros ya registrados del vuelo. */
  cobros?: Row[];
  cobroPorLlave?: Row | null;
  insertCobroError?: { code: string; message: string };
  /** vuelo_id con escala.updated_at >= since. */
  tramosDesde?: string[];
  eliminados?: string[];
  /** count de tramos activos distintos al cancelado (cancelEscala). */
  nActivos?: number;
}

function armar(m: Mundo = {}) {
  const inserts: Record<string, Row[]> = {};
  const updates: Record<string, Row[]> = {};
  const deletes: string[] = [];
  const { supabase, llamadas } = fakeSupabase((tabla, ops, lista) => {
    const ins = ops.find((o) => o.m === 'insert');
    const upd = ops.find((o) => o.m === 'update');
    if (ins) (inserts[tabla] ??= []).push(ins.args[0] as Row);
    if (upd) (updates[tabla] ??= []).push(upd.args[0] as Row);
    if (tiene(ops, 'delete')) deletes.push(tabla);
    switch (tabla) {
      case 'vuelo': {
        const fila = m.vuelo === undefined ? vueloRow() : m.vuelo;
        if (upd) {
          if (m.vueloUpdateData === null) return { data: null };
          return { data: fila ? { ...fila, ...(upd.args[0] as Row) } : null };
        }
        if (lista) return { data: fila ? [fila] : [], count: fila ? 1 : 0 };
        return { data: fila };
      }
      case 'escala': {
        // Sonda de ColumnaOpcional: select('client_request_id').limit(1).
        if (selectDe(ops) === 'client_request_id' && !tiene(ops, 'eq')) {
          return m.columnaLlave === false
            ? {
                error: {
                  code: '42703',
                  message: 'column escala.client_request_id does not exist',
                },
              }
            : { data: [] };
        }
        if (ins) {
          if (m.insertEscalaError) return { error: m.insertEscalaError };
          return {
            data: { ...escalaRow(), id: 'e-new', ...(ins.args[0] as Row) },
          };
        }
        if (upd) {
          if (m.escalaUpdateData === null) return { data: null };
          return {
            data: { ...(m.escala ?? escalaRow()), ...(upd.args[0] as Row) },
          };
        }
        if (tiene(ops, 'delete')) return {};
        if (esHead(ops)) return { count: m.nActivos ?? 1 };
        if (eqDe(ops, 'client_request_id') !== undefined) {
          if (m.escalaPorLlaveSecuencia)
            return { data: m.escalaPorLlaveSecuencia.shift() ?? null };
          return { data: m.escalaPorLlave ?? null };
        }
        if (
          selectDe(ops) === 'vuelo_id' &&
          ops.some((o) => o.m === 'gte' && o.args[0] === 'updated_at')
        ) {
          return {
            data: (m.tramosDesde ?? []).map((id) => ({ vuelo_id: id })),
          };
        }
        if (selectDe(ops) === 'orden')
          return { data: [{ orden: 1 }, { orden: 2 }] };
        if (selectDe(ops) === 'id')
          return { data: lista ? [{ id: E1 }] : { id: E1 } };
        const fila = m.escala === undefined ? escalaRow() : m.escala;
        return lista ? { data: fila ? [fila] : [] } : { data: fila };
      }
      case 'cobro_vuelo': {
        if (ins) {
          if (m.insertCobroError) return { error: m.insertCobroError };
          return { data: { id: 'c-new', ...(ins.args[0] as Row) } };
        }
        if (eqDe(ops, 'client_request_id') !== undefined)
          return { data: m.cobroPorLlave ?? null };
        // Ventana anti-gemelos de 90 s (filtra por monto): sin gemelos aquí.
        if (eqDe(ops, 'monto') !== undefined) return { data: [] };
        return { data: m.cobros ?? [] };
      }
      case 'vuelo_eliminado':
        return { data: (m.eliminados ?? []).map((id) => ({ vuelo_id: id })) };
      case 'aeronave':
        return { data: { matricula: 'XA-VGV' } };
      default:
        return {};
    }
  });
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifyRole = jest.fn().mockResolvedValue(true);
  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const refreshPermisosDeVuelo = jest.fn().mockResolvedValue(undefined);
  const service = new FlightsService(
    supabase,
    { syncFlight, removeFlight: jest.fn() } as unknown as CalendarSyncService,
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
  // Aviso de tramo nuevo (privado): se espía para probar que el replay NUNCA
  // re-notifica a la tripulación.
  type Privados = {
    notificarTramoNuevo: (vueloId: string, escala: Row) => Promise<void>;
  };
  const avisoTramo = jest
    .spyOn(service as unknown as Privados, 'notificarTramoNuevo')
    .mockResolvedValue(undefined);
  return {
    service,
    llamadas,
    inserts,
    updates,
    deletes,
    notifyUser,
    notifyRole,
    syncFlight,
    refreshPermisosDeVuelo,
    avisoTramo,
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
      code: r.error as string,
      message: err.message,
      details: r.details as Record<string, unknown> | undefined,
    };
  }
  throw new Error('no rebotó');
}

/** ops del PRIMER update sobre la tabla. */
const opsUpdate = (
  llamadas: { tabla: string; ops: Op[] }[],
  tabla: string,
): Op[] | undefined =>
  llamadas.find((l) => l.tabla === tabla && tiene(l.ops, 'update'))?.ops;

// =====================================================================
// B1 · if_updated_at → CONFLICTO_VERSION
// =====================================================================

describe('B1 · PATCH /flights/:id — CAS con if_updated_at', () => {
  it('misma versión (µs de BD vs ms de la app): UPDATE con ventana ±1 ms y if_updated_at NO entra al patch', async () => {
    const w = armar();
    const out = await w.service.update(
      V1,
      { notas: 'ok', if_updated_at: TS_APP },
      USER,
    );
    const patch = w.updates.vuelo[0];
    expect(patch.notas).toBe('ok');
    expect(patch.updated_by).toBe(USER);
    expect('if_updated_at' in patch).toBe(false);
    const ops = opsUpdate(w.llamadas, 'vuelo')!;
    expect(argDe(ops, 'gte')).toEqual([
      'updated_at',
      '2026-09-10T12:34:56.122Z',
    ]);
    expect(argDe(ops, 'lte')).toEqual([
      'updated_at',
      '2026-09-10T12:34:56.124Z',
    ]);
    expect((out as Row).notas).toBe('ok');
  });

  it('versión vieja (2 ms antes) → 409 CONFLICTO_VERSION con la fila viva y SIN escribir', async () => {
    const w = armar();
    const r = await rebote(
      w.service.update(V1, { notas: 'x', if_updated_at: TS_VIEJO }, USER),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect(r.message).toBe(MSG_VUELO);
    expect((r.details!.actual as Row).id).toBe(V1);
    expect(r.details!.updated_at_enviado).toBe(TS_VIEJO);
    expect(r.details!.updated_at_actual).toBe(TS_DB);
    expect(w.updates.vuelo).toBeUndefined();
  });

  it('tolerancia: +1 ms y −1 ms pasan; +2 ms ya es conflicto', async () => {
    for (const ts of ['2026-09-10T12:34:56.124Z', '2026-09-10T12:34:56.122Z']) {
      const w = armar();
      await expect(
        w.service.update(V1, { notas: 'x', if_updated_at: ts }, USER),
      ).resolves.toBeDefined();
      expect(w.updates.vuelo).toHaveLength(1);
    }
    const w = armar();
    const r = await rebote(
      w.service.update(
        V1,
        { notas: 'x', if_updated_at: '2026-09-10T12:34:56.125Z' },
        USER,
      ),
    );
    expect(r.code).toBe('CONFLICTO_VERSION');
  });

  it('carrera: el pre-check pasa pero el UPDATE con CAS devuelve 0 filas → relectura y 409', async () => {
    const w = armar({ vueloUpdateData: null });
    const r = await rebote(
      w.service.update(V1, { notas: 'x', if_updated_at: TS_APP }, USER),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect((r.details!.actual as Row).id).toBe(V1);
    // Se intentó el write (una vez) y nada más.
    expect(w.updates.vuelo).toHaveLength(1);
    expect(w.syncFlight).not.toHaveBeenCalled();
  });

  it('sin if_updated_at: sin ventana en el UPDATE (comportamiento actual)', async () => {
    const w = armar();
    await w.service.update(V1, { notas: 'x' }, USER);
    const ops = opsUpdate(w.llamadas, 'vuelo')!;
    expect(tiene(ops, 'gte')).toBe(false);
    expect(tiene(ops, 'lte')).toBe(false);
  });

  it('solo if_updated_at (sin campos) = nada que guardar: devuelve el vuelo sin escribir', async () => {
    const w = armar();
    const out = await w.service.update(V1, { if_updated_at: TS_APP }, USER);
    expect((out as Row).id).toBe(V1);
    expect(w.updates.vuelo).toBeUndefined();
  });
});

describe('B1 · PATCH /flights/legs/:legId — CAS con if_updated_at', () => {
  it('misma versión: UPDATE del tramo con ventana ±1 ms', async () => {
    const w = armar();
    const out = await w.service.updateEscala(
      E1,
      { notas: 'ok', if_updated_at: TS_APP },
      USER,
    );
    const ops = opsUpdate(w.llamadas, 'escala')!;
    expect(argDe(ops, 'gte')).toEqual([
      'updated_at',
      '2026-09-10T12:34:56.122Z',
    ]);
    expect(argDe(ops, 'lte')).toEqual([
      'updated_at',
      '2026-09-10T12:34:56.124Z',
    ]);
    expect(w.updates.escala[0].notas).toBe('ok');
    expect('if_updated_at' in w.updates.escala[0]).toBe(false);
    expect((out as Row).notas).toBe('ok');
  });

  it('versión vieja → 409 CONFLICTO_VERSION (tramo) con la fila pública completa, sin escribir', async () => {
    const w = armar();
    const r = await rebote(
      w.service.updateEscala(E1, { notas: 'x', if_updated_at: TS_VIEJO }, USER),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect(r.message).toBe(MSG_TRAMO);
    expect((r.details!.actual as Row).id).toBe(E1);
    expect((r.details!.actual as Row).origen_iata).toBe('CUN');
    expect(r.details!.updated_at_actual).toBe(TS_DB);
    expect(w.updates.escala).toBeUndefined();
  });

  it('carrera: UPDATE con CAS devuelve 0 filas → 409 con relectura', async () => {
    const w = armar({ escalaUpdateData: null });
    const r = await rebote(
      w.service.updateEscala(E1, { notas: 'x', if_updated_at: TS_APP }, USER),
    );
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect((r.details!.actual as Row).id).toBe(E1);
  });

  it('sin if_updated_at: sin ventana (comportamiento actual)', async () => {
    const w = armar();
    await w.service.updateEscala(E1, { notas: 'x' }, USER);
    expect(tiene(opsUpdate(w.llamadas, 'escala')!, 'gte')).toBe(false);
  });
});

describe('B1 · flujos multi-paso: assign / assignEscala validan UNA vez antes del primer write', () => {
  it('assign con versión vieja → 409 antes de tocar apoyos, vuelo o tramos', async () => {
    const w = armar();
    const r = await rebote(
      w.service.assign(
        V1,
        { copiloto_id: null, apoyo_ids: [], if_updated_at: TS_VIEJO },
        USER,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect(r.message).toBe(MSG_VUELO);
    expect((r.details!.actual as Row).id).toBe(V1);
    expect(w.updates.vuelo).toBeUndefined();
    expect(w.updates.escala).toBeUndefined();
    expect(
      w.llamadas.some(
        (l) =>
          l.tabla === 'vuelo_apoyo' &&
          (tiene(l.ops, 'insert') || tiene(l.ops, 'delete')),
      ),
    ).toBe(false);
  });

  it('assign con la misma versión: procede; el write del vuelo NO lleva ventana (se validó una vez)', async () => {
    const w = armar();
    const out = await w.service.assign(
      V1,
      { copiloto_id: null, if_updated_at: TS_APP },
      USER,
    );
    expect(w.updates.vuelo).toHaveLength(1);
    expect(tiene(opsUpdate(w.llamadas, 'vuelo')!, 'gte')).toBe(false);
    expect('if_updated_at' in w.updates.vuelo[0]).toBe(false);
    expect((out as { avisos: string[] }).avisos).toEqual([]);
  });

  it('assignEscala con versión vieja → 409 CONFLICTO_VERSION (tramo, fila pública) sin escribir', async () => {
    const w = armar();
    const r = await rebote(
      w.service.assignEscala(
        E1,
        { copiloto_id: null, if_updated_at: TS_VIEJO },
        USER,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONFLICTO_VERSION');
    expect(r.message).toBe(MSG_TRAMO);
    expect((r.details!.actual as Row).id).toBe(E1);
    expect(w.updates.escala).toBeUndefined();
    expect(w.updates.vuelo).toBeUndefined();
  });

  it('assignEscala con la misma versión: escribe el tramo (y el espejo al vuelo por ser la ida)', async () => {
    const w = armar();
    await w.service.assignEscala(
      E1,
      { copiloto_id: null, if_updated_at: TS_APP },
      USER,
    );
    expect(w.updates.escala).toHaveLength(1);
    expect('if_updated_at' in w.updates.escala[0]).toBe(false);
    expect(w.updates.vuelo).toHaveLength(1);
  });
});

// =====================================================================
// B2 · tramos idempotentes
// =====================================================================

describe('B2 · POST /flights/:id/legs — idempotencia por client_request_id', () => {
  const dto = {
    orden: 3,
    origen_iata: 'cun',
    destino_iata: 'hol',
    client_request_id: LLAVE,
  };

  it('replay (llave ya usada en este vuelo): devuelve el tramo existente, idempotente:true, sin insert, sin permisos ni aviso', async () => {
    const w = armar({ escalaPorLlave: escalaRow({ id: 'e-ya', orden: 3 }) });
    const out = await w.service.createEscala(V1, dto, USER);
    expect(out.idempotente).toBe(true);
    expect((out as Row).id).toBe('e-ya');
    expect((out as Row).orden).toBe(3);
    expect(w.inserts.escala).toBeUndefined();
    expect(w.avisoTramo).not.toHaveBeenCalled();
    expect(w.refreshPermisosDeVuelo).not.toHaveBeenCalled();
    expect(w.syncFlight).not.toHaveBeenCalled();
    // La relectura por llave va ACOTADA al vuelo.
    const porLlave = w.llamadas.find(
      (l) => l.tabla === 'escala' && eqDe(l.ops, 'client_request_id') === LLAVE,
    )!;
    expect(eqDe(porLlave.ops, 'vuelo_id')).toBe(V1);
  });

  it('alta fresca con llave: el insert lleva client_request_id, responde idempotente:false y avisa UNA vez', async () => {
    const w = armar();
    const out = await w.service.createEscala(V1, dto, USER);
    expect(out.idempotente).toBe(false);
    expect(w.inserts.escala).toHaveLength(1);
    expect(w.inserts.escala[0].client_request_id).toBe(LLAVE);
    expect(w.inserts.escala[0].origen_iata).toBe('CUN');
    expect(w.avisoTramo).toHaveBeenCalledTimes(1);
    expect(w.refreshPermisosDeVuelo).toHaveBeenCalledWith(V1);
  });

  it('sin llave (panel): insert idéntico al de siempre, sin la columna ni pre-check', async () => {
    const w = armar();
    const { client_request_id: _sin, ...sinLlave } = dto;
    void _sin;
    const out = await w.service.createEscala(V1, sinLlave, USER);
    expect(out.idempotente).toBe(false);
    expect('client_request_id' in w.inserts.escala[0]).toBe(false);
    expect(
      w.llamadas.some(
        (l) =>
          l.tabla === 'escala' &&
          eqDe(l.ops, 'client_request_id') !== undefined,
      ),
    ).toBe(false);
  });

  it('columna AUSENTE (42703 en la sonda): la llave se ignora — sin pre-check y sin la columna en el insert', async () => {
    const w = armar({ columnaLlave: false });
    const out = await w.service.createEscala(V1, dto, USER);
    expect(out.idempotente).toBe(false);
    expect('client_request_id' in w.inserts.escala[0]).toBe(false);
    expect(
      w.llamadas.some(
        (l) =>
          l.tabla === 'escala' &&
          eqDe(l.ops, 'client_request_id') !== undefined,
      ),
    ).toBe(false);
    expect(w.avisoTramo).toHaveBeenCalledTimes(1);
  });

  it('carrera: 23505 sobre uq_escala_client_request → relectura por llave, idempotente:true, sin re-avisar', async () => {
    const w = armar({
      insertEscalaError: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_escala_client_request"',
      },
      escalaPorLlaveSecuencia: [null, escalaRow({ id: 'e-ya', orden: 3 })],
    });
    const out = await w.service.createEscala(V1, dto, USER);
    expect(out.idempotente).toBe(true);
    expect((out as Row).id).toBe('e-ya');
    expect(w.avisoTramo).not.toHaveBeenCalled();
  });

  it('llave reutilizada en OTRO vuelo: 23505 y la relectura acotada no encuentra → 409 CLIENT_REQUEST_ID_EN_USO (nunca 500)', async () => {
    const w = armar({
      insertEscalaError: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_escala_client_request"',
      },
      escalaPorLlaveSecuencia: [null, null],
    });
    const r = await rebote(w.service.createEscala(V1, dto, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('CLIENT_REQUEST_ID_EN_USO');
    expect(r.details).toEqual({ client_request_id: LLAVE });
  });

  it('23505 de orden (contrato intacto): 409 «Ya existe una escala con orden N»', async () => {
    const w = armar({
      insertEscalaError: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "escala_vuelo_id_orden_key"',
      },
    });
    const r = await rebote(w.service.createEscala(V1, dto, USER));
    expect(r.status).toBe(409);
    expect(r.message).toBe('Ya existe una escala con orden 3');
  });
});

describe('B2 · POST /flights/:id/operational-legs — idempotencia', () => {
  const dto = {
    origen_iata: 'cun',
    destino_iata: 'pce',
    es_ferry: true,
    client_request_id: LLAVE,
  };

  it('replay: devuelve el tramo existente con su orden calculado, sin insert ni aviso', async () => {
    const w = armar({
      escalaPorLlave: escalaRow({
        id: 'e-op',
        orden: 100,
        solo_operativa: true,
      }),
    });
    const out = await w.service.createOperationalLeg(V1, dto, USER);
    expect(out.idempotente).toBe(true);
    expect((out as Row).orden).toBe(100);
    expect(w.inserts.escala).toBeUndefined();
    expect(w.avisoTramo).not.toHaveBeenCalled();
  });

  it('alta fresca: orden en el rango operativo (100), insert con llave, avisa una vez', async () => {
    const w = armar();
    const out = await w.service.createOperationalLeg(V1, dto, USER);
    expect(out.idempotente).toBe(false);
    expect(w.inserts.escala[0].orden).toBe(100);
    expect(w.inserts.escala[0].solo_operativa).toBe(true);
    expect(w.inserts.escala[0].client_request_id).toBe(LLAVE);
    expect(w.avisoTramo).toHaveBeenCalledTimes(1);
  });

  it('columna ausente: insert sin la columna (alta normal)', async () => {
    const w = armar({ columnaLlave: false });
    await w.service.createOperationalLeg(V1, dto, USER);
    expect('client_request_id' in w.inserts.escala[0]).toBe(false);
  });
});

// =====================================================================
// B3 · COBRO_EXCEDE_SALDO
// =====================================================================

describe('B3 · createCobro — candado de sobre-cobro SOLO con client_request_id', () => {
  const base = (extra: Partial<CreateCobroDto>): CreateCobroDto => ({
    monto: 200,
    moneda: Moneda.USD,
    metodo_cobro: MetodoPago.EFECTIVO,
    ...extra,
  });
  const cobrados900 = [
    { id: 'c-1', monto: 900, moneda: 'USD', tc_usd_mxn: null },
  ];

  it('con llave: 900 cobrados + 200 > 1000 + 1 → 409 COBRO_EXCEDE_SALDO con details en USD y sin insert', async () => {
    const w = armar({ cobros: cobrados900 });
    const r = await rebote(
      w.service.createCobro(
        V1,
        base({ client_request_id: LLAVE }),
        USER,
        Rol.PILOTO,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('COBRO_EXCEDE_SALDO');
    expect(r.details).toEqual({
      saldo_usd: 100,
      cobrado_usd: 900,
      monto_usd: 200,
      monto_total_usd: 1000,
    });
    expect(r.message).toMatch(/rebasa lo que falta por cobrar/);
    expect(w.inserts.cobro_vuelo).toBeUndefined();
    expect(w.notifyRole).not.toHaveBeenCalled();
  });

  it('con llave dentro de la tolerancia (+1 USD): 900 + 101 pasa e inserta', async () => {
    const w = armar({ cobros: cobrados900 });
    await w.service.createCobro(
      V1,
      base({ monto: 101, client_request_id: LLAVE }),
      USER,
      Rol.PILOTO,
    );
    expect(w.inserts.cobro_vuelo).toHaveLength(1);
    expect(w.inserts.cobro_vuelo[0].client_request_id).toBe(LLAVE);
  });

  it('tolerancia = max(1 USD, 5 %): 900 + 140 = 1,040 ≤ 1,050 pasa (redondeo de TC en campo)', async () => {
    const w = armar({ cobros: cobrados900 });
    await w.service.createCobro(
      V1,
      base({ monto: 140, client_request_id: LLAVE }),
      USER,
      Rol.PILOTO,
    );
    expect(w.inserts.cobro_vuelo).toHaveLength(1);
  });

  it('SIN llave (panel): el mismo sobre-cobro se acepta a propósito', async () => {
    const w = armar({ cobros: cobrados900 });
    await w.service.createCobro(V1, base({}), USER);
    expect(w.inserts.cobro_vuelo).toHaveLength(1);
  });

  it('vuelo sin precio ($0 / interno): exento aunque viaje la llave', async () => {
    const w = armar({
      vuelo: vueloRow({ monto_total_usd: 0 }),
      cobros: cobrados900,
    });
    await w.service.createCobro(V1, base({ client_request_id: LLAVE }), USER);
    expect(w.inserts.cobro_vuelo).toHaveLength(1);
  });

  it('replay (llave ya registrada): devuelve el cobro existente, idempotente:true, sin candado, sin insert ni aviso', async () => {
    const w = armar({
      cobros: cobrados900,
      cobroPorLlave: { id: 'c-ya', monto: 200, moneda: 'USD' },
    });
    const out = await w.service.createCobro(
      V1,
      base({ client_request_id: LLAVE }),
      USER,
      Rol.PILOTO,
    );
    expect((out as Row).id).toBe('c-ya');
    expect((out as { idempotente?: boolean }).idempotente).toBe(true);
    expect(w.inserts.cobro_vuelo).toBeUndefined();
    expect(w.notifyRole).not.toHaveBeenCalled();
  });

  it('replay ANTES de los candados: PILOTO en vuelo CANCELADO con llave ya registrada → cobro existente (sin 409); relectura acotada al vuelo', async () => {
    const w = armar({
      vuelo: vueloRow({ estado: 'CANCELADO' }),
      cobros: cobrados900,
      cobroPorLlave: { id: 'c-ya', monto: 200, moneda: 'USD' },
    });
    const out = await w.service.createCobro(
      V1,
      base({ client_request_id: LLAVE }),
      USER,
      Rol.PILOTO,
    );
    expect((out as Row).id).toBe('c-ya');
    expect((out as { idempotente?: boolean }).idempotente).toBe(true);
    expect(w.inserts.cobro_vuelo).toBeUndefined();
    const lectura = w.llamadas.find(
      (l) =>
        l.tabla === 'cobro_vuelo' &&
        eqDe(l.ops, 'client_request_id') !== undefined,
    )!.ops;
    expect(eqDe(lectura, 'vuelo_id')).toBe(V1);
  });

  it('23505 de llave y ningún cobro con esa llave EN ESTE vuelo → 409 CLIENT_REQUEST_ID_EN_USO (nunca 500 ni un cobro ajeno)', async () => {
    const w = armar({
      insertCobroError: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_cobro_vuelo_client_request"',
      },
      cobroPorLlave: null,
    });
    const r = await rebote(
      w.service.createCobro(V1, base({ client_request_id: LLAVE }), USER),
    );
    expect(r.status).toBe(409);
    expect(r.code).toBe('CLIENT_REQUEST_ID_EN_USO');
    expect(r.details).toEqual({ client_request_id: LLAVE });
    expect(w.notifyRole).not.toHaveBeenCalled();
  });

  it('MXN con TC del vuelo (fuente única): 3,400 MXN / 17 = 200 USD → 409 con monto_usd 200', async () => {
    const w = armar({ cobros: cobrados900 });
    const r = await rebote(
      w.service.createCobro(
        V1,
        base({ monto: 3400, moneda: Moneda.MXN, client_request_id: LLAVE }),
        USER,
      ),
    );
    expect(r.code).toBe('COBRO_EXCEDE_SALDO');
    expect(r.details!.monto_usd).toBe(200);
    expect(r.details!.saldo_usd).toBe(100);
  });
});

// =====================================================================
// B4 · codes en bajas y transiciones (message intacto)
// =====================================================================

describe('B4 · codes estructurados', () => {
  it('deleteEscala con taco → 409 ESCALA_CON_TACO, message de siempre, sin delete', async () => {
    const w = armar({ escala: escalaRow({ taco_salida: 1234.5 }) });
    const r = await rebote(w.service.deleteEscala(E1));
    expect(r.status).toBe(409);
    expect(r.code).toBe('ESCALA_CON_TACO');
    expect(r.message).toBe(
      'No se puede borrar una escala con tacómetro capturado (auditoría)',
    );
    expect(r.details).toEqual({
      escala_id: E1,
      taco_salida: 1234.5,
      taco_llegada: null,
    });
    expect(w.deletes).toEqual([]);
  });

  it('deleteEscala de tramo inexistente → 404 ESCALA_NO_EXISTE', async () => {
    const w = armar({ escala: null });
    const r = await rebote(w.service.deleteEscala(E1));
    expect(r.status).toBe(404);
    expect(r.code).toBe('ESCALA_NO_EXISTE');
    expect(r.message).toBe(`Escala ${E1} not found`);
  });

  it('cancelEscala ya cancelado → 409 ESCALA_YA_CANCELADA (idempotente para la app)', async () => {
    const w = armar({
      escala: escalaRow({ cancelada_at: '2026-09-09T10:00:00Z' }),
    });
    const r = await rebote(w.service.cancelEscala(E1, 'no voló', USER));
    expect(r.code).toBe('ESCALA_YA_CANCELADA');
    expect(r.message).toBe('Este tramo ya está cancelado.');
    expect(w.updates.escala).toBeUndefined();
  });

  it('cancelEscala con llegada real → 409 ESCALA_CON_TACO («sí voló»)', async () => {
    const w = armar({
      escala: escalaRow({
        taco_llegada: 1240.1,
        taco_llegada_origen: 'PILOTO',
      }),
    });
    const r = await rebote(w.service.cancelEscala(E1, 'no voló', USER));
    expect(r.code).toBe('ESCALA_CON_TACO');
    expect(r.message).toMatch(/sí voló/);
    expect(w.updates.escala).toBeUndefined();
  });

  it('cancelEscala del único tramo activo → 409 ESCALA_UNICA', async () => {
    const w = armar({ nActivos: 0 });
    const r = await rebote(w.service.cancelEscala(E1, 'no voló', USER));
    expect(r.code).toBe('ESCALA_UNICA');
    expect(r.message).toBe(
      'Es el único tramo activo del vuelo: cancela el vuelo completo, no el tramo.',
    );
    expect(r.details).toEqual({ escala_id: E1, vuelo_id: V1 });
    expect(w.updates.escala).toBeUndefined();
  });

  it('start() ya EN_VUELO → 409 VUELO_YA_INICIADO (idempotente); COMPLETADO → VUELO_NO_INICIABLE', async () => {
    const enVuelo = armar({ vuelo: vueloRow({ estado: 'EN_VUELO' }) });
    const r1 = await rebote(enVuelo.service.start(V1, USER));
    expect(r1.status).toBe(409);
    expect(r1.code).toBe('VUELO_YA_INICIADO');
    expect(r1.message).toBe('No se puede iniciar un vuelo en estado EN_VUELO.');
    expect(r1.details).toEqual({ estado: 'EN_VUELO', folio: 118 });
    expect(enVuelo.updates.vuelo).toBeUndefined();

    const completado = armar({ vuelo: vueloRow({ estado: 'COMPLETADO' }) });
    const r2 = await rebote(completado.service.start(V1, USER));
    expect(r2.code).toBe('VUELO_NO_INICIABLE');
    expect(r2.message).toBe(
      'No se puede iniciar un vuelo en estado COMPLETADO.',
    );
  });

  it('updatePermiso: el vuelo desaparece entre la lectura y el write → 404 VUELO_NO_EXISTE', async () => {
    const w = armar({ vueloUpdateData: null });
    const r = await rebote(
      w.service.updatePermiso(V1, 'emitido', { userId: USER, rol: Rol.ADMIN }),
    );
    expect(r.status).toBe(404);
    expect(r.code).toBe('VUELO_NO_EXISTE');
    expect(r.message).toBe(`Vuelo ${V1} not found`);
  });

  it('updatePermiso de vuelo inexistente → 404 VUELO_NO_EXISTE desde la lectura', async () => {
    const w = armar({ vuelo: null });
    const r = await rebote(
      w.service.updatePermiso(V1, 'emitido', { userId: USER, rol: Rol.ADMIN }),
    );
    expect(r.code).toBe('VUELO_NO_EXISTE');
  });
});

// =====================================================================
// B5 · updated_since + updated_at expuesto
// =====================================================================

describe('B5 · GET /flights?updated_since — deltas', () => {
  const q = (extra: Partial<ListFlightsQuery>): ListFlightsQuery => ({
    limit: 50,
    offset: 0,
    ...extra,
  });

  it('con updated_since: filtra vuelos modificados O con tramo modificado, y devuelve eliminados', async () => {
    const w = armar({
      tramosDesde: ['v-2', 'v-2', 'v-3'],
      eliminados: ['v-9'],
    });
    const out = await w.service.list(
      q({ updated_since: '2026-09-10T00:00:00-05:00' }),
    );
    const opsVuelo = w.llamadas.find(
      (l) => l.tabla === 'vuelo' && tiene(l.ops, 'range'),
    )!.ops;
    expect(argDe(opsVuelo, 'or')).toEqual([
      'updated_at.gte.2026-09-10T05:00:00.000Z,id.in.(v-2,v-3)',
    ]);
    expect(out.updated_since).toBe('2026-09-10T05:00:00.000Z');
    expect(out.eliminados).toEqual(['v-9']);
    expect(out.count).toBe(1);
    expect((out.data[0] as Row).updated_at).toBe(TS_DB);
    // Lecturas de apoyo con >= sobre updated_at / eliminado_at.
    const opsTramos = w.llamadas.find(
      (l) => l.tabla === 'escala' && selectDe(l.ops) === 'vuelo_id',
    )!.ops;
    expect(argDe(opsTramos, 'gte')).toEqual([
      'updated_at',
      '2026-09-10T05:00:00.000Z',
    ]);
    const opsBorrados = w.llamadas.find(
      (l) => l.tabla === 'vuelo_eliminado',
    )!.ops;
    expect(argDe(opsBorrados, 'gte')).toEqual([
      'eliminado_at',
      '2026-09-10T05:00:00.000Z',
    ]);
  });

  it('sin tramos modificados: filtro simple updated_at >= since', async () => {
    const w = armar();
    const out = await w.service.list(
      q({ updated_since: '2026-09-10T05:00:00.000Z' }),
    );
    const opsVuelo = w.llamadas.find(
      (l) => l.tabla === 'vuelo' && tiene(l.ops, 'range'),
    )!.ops;
    expect(argDe(opsVuelo, 'gte')).toEqual([
      'updated_at',
      '2026-09-10T05:00:00.000Z',
    ]);
    expect(tiene(opsVuelo, 'or')).toBe(false);
    expect(out.eliminados).toEqual([]);
  });

  it('desborde: más de 150 vuelos con tramo tocado → lista COMPLETA (sin or/gte) pero con updated_since y eliminados', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const w = armar({
        tramosDesde: Array.from({ length: 151 }, (_, i) => `v-${i}`),
        eliminados: ['v-9'],
      });
      const out = await w.service.list(
        q({ updated_since: '2026-09-10T05:00:00.000Z' }),
      );
      const opsVuelo = w.llamadas.find(
        (l) => l.tabla === 'vuelo' && tiene(l.ops, 'range'),
      )!.ops;
      expect(tiene(opsVuelo, 'or')).toBe(false);
      expect(tiene(opsVuelo, 'gte')).toBe(false);
      expect(out.updated_since).toBe('2026-09-10T05:00:00.000Z');
      expect(out.eliminados).toEqual(['v-9']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('lectura de tramos truncada en max-rows (1000 filas) → lista completa aunque sean pocos vuelos', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const w = armar({ tramosDesde: Array<string>(1000).fill('v-2') });
      const out = await w.service.list(
        q({ updated_since: '2026-09-10T05:00:00.000Z' }),
      );
      const opsVuelo = w.llamadas.find(
        (l) => l.tabla === 'vuelo' && tiene(l.ops, 'range'),
      )!.ops;
      expect(tiene(opsVuelo, 'or')).toBe(false);
      expect(tiene(opsVuelo, 'gte')).toBe(false);
      expect(out.updated_since).toBe('2026-09-10T05:00:00.000Z');
    } finally {
      warn.mockRestore();
    }
  });

  it('sin updated_since: respuesta de siempre (sin eliminados, sin filtro por updated_at)', async () => {
    const w = armar();
    const out = await w.service.list(q({}));
    expect('eliminados' in out).toBe(false);
    expect('updated_since' in out).toBe(false);
    const opsVuelo = w.llamadas.find(
      (l) => l.tabla === 'vuelo' && tiene(l.ops, 'range'),
    )!.ops;
    expect(tiene(opsVuelo, 'gte')).toBe(false);
    expect(tiene(opsVuelo, 'or')).toBe(false);
    expect(w.llamadas.some((l) => l.tabla === 'vuelo_eliminado')).toBe(false);
  });
});

describe('B5 · updated_at expuesto en vuelo y tramos (snapshot/legs)', () => {
  it('findById selecciona updated_at (VUELO_COLS) y la fila lo trae', async () => {
    const w = armar();
    const v = await w.service.findById(V1);
    expect(v.updated_at).toBe(TS_DB);
    expect(selectDe(w.llamadas[0].ops)).toMatch(/\bupdated_at\b/);
  });

  it('listEscalas: select con updated_at; con la columna de llave la agrega y la expone', async () => {
    const w = armar({ escala: escalaRow({ client_request_id: LLAVE }) });
    const filas = await w.service.listEscalas(V1);
    const sel = w.llamadas.find(
      (l) => l.tabla === 'escala' && eqDe(l.ops, 'vuelo_id') === V1,
    )!;
    expect(selectDe(sel.ops)).toMatch(/\bupdated_at\b/);
    expect(selectDe(sel.ops)).toMatch(/, client_request_id$/);
    expect(filas[0].updated_at).toBe(TS_DB);
    expect(filas[0].client_request_id).toBe(LLAVE);
  });

  it('listEscalas sin la columna: select de siempre y client_request_id null (contrato estable)', async () => {
    const w = armar({ columnaLlave: false });
    const filas = await w.service.listEscalas(V1);
    const sel = w.llamadas.find(
      (l) => l.tabla === 'escala' && eqDe(l.ops, 'vuelo_id') === V1,
    )!;
    expect(selectDe(sel.ops)).not.toMatch(/client_request_id/);
    expect(filas[0].client_request_id).toBeNull();
  });
});
