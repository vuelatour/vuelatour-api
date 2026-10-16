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

import { ConflictException, HttpException } from '@nestjs/common';
import { FlightsService } from './flights.service';
import {
  faltaAsignacion,
  type ConfirmadorCotizacion,
} from './confirmar-vuelo.util';
import { avisoAeronaveEnTaller } from '../../common/aviso-taller.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { ExpirationsService } from '../expirations/expirations.service';
import type { AirportsService } from '../airports/airports.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { PilotsService } from '../pilots/pilots.service';

/**
 * CONFIRMAR desde el detalle del vuelo (16-oct-2026, invariante 84):
 * RESERVA/SOLICITUD → CONFIRMADO con CAS por estado, candados de asignación
 * (avión y piloto, squawk ALTA, taller solo avisa), COTIZADO delegado al
 * confirmador inyectado, idempotencia y 409 estructurados. Supabase se
 * simula con un builder encadenable: se prueba el CONTRATO, no la BD.
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
  'order',
  'limit',
  'insert',
  'update',
  'delete',
];

function fakeSupabase(resolver: (tabla: string, ops: Op[]) => Resultado) {
  const llamadas: { tabla: string; ops: Op[] }[] = [];
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => {
        const r = resolver(tabla, ops);
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
const eqDe = (ops: Op[], col: string): unknown =>
  ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];

const V1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PILOTO = 'aaaaaaaa-0000-4000-8000-00000000000b';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000f';
const LLAVE = 'aaaaaaaa-0000-4000-8000-00000000cccc';

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
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: '2026-10-20T14:00:00+00:00',
    fecha_confirmacion: null,
    grupo_id: null,
    combinado_con_id: null,
    notas_internas: null,
    ...extra,
  };
}

interface Mundo {
  /** Fila del vuelo (null = no existe). */
  vuelo?: Row | null;
  /** Squawks ALTA abiertos del avión. */
  squawks?: { id: string; descripcion: string }[];
  enTaller?: boolean;
  /** El UPDATE con CAS no toca filas; la relectura devuelve esta fila. */
  casPierde?: Row;
  /** Confirmador del COTIZADO (undefined = no inyectado). */
  confirmador?: ConfirmadorCotizacion;
}

function armar(m: Mundo) {
  const updates: Row[] = [];
  let lecturasVuelo = 0;
  const fila = (): Row | null => (m.vuelo === undefined ? vueloRow() : m.vuelo);
  const { supabase, llamadas } = fakeSupabase((tabla, ops) => {
    const upd = ops.find((o) => o.m === 'update');
    switch (tabla) {
      case 'vuelo':
        if (upd) {
          updates.push(upd.args[0] as Row);
          if (m.casPierde) return { data: null };
          return { data: { ...(fila() ?? {}), ...(upd.args[0] as Row) } };
        }
        lecturasVuelo += 1;
        if (lecturasVuelo > 1 && m.casPierde) return { data: m.casPierde };
        return { data: fila() };
      case 'aeronave_discrepancia':
        return { data: m.squawks ?? [] };
      case 'mantenimiento':
        return { data: m.enTaller ? { id: 'mt-1' } : null };
      case 'aeronave':
        return { data: { matricula: 'XA-VGV' } };
      case 'escala':
        return {
          data: [{ id: 'e-1', piloto_id: PILOTO, copiloto_id: null }],
        };
      case 'vuelo_apoyo':
        return { data: [] };
      case 'alerta_emitida':
        return tiene(ops, 'insert') ? { data: { id: 'ae-1' } } : { data: null };
      default:
        return {};
    }
  });
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifyRole = jest.fn().mockResolvedValue(true);
  const syncFlight = jest.fn().mockResolvedValue(undefined);
  const notifications = {
    notifyUser,
    notifyUserDetallado: jest.fn().mockResolvedValue({ notificado: true }),
    notifyRole,
  } as unknown as NotificationsService;
  const calendar = {
    syncFlight,
    removeFlight: jest.fn().mockResolvedValue(undefined),
  } as unknown as CalendarSyncService;
  const service = new FlightsService(
    supabase,
    calendar,
    {} as EmailService,
    {} as VisionService,
    notifications,
    {
      findBlockingExpirations: jest.fn().mockResolvedValue([]),
    } as unknown as ExpirationsService,
    { refreshPermisosDeVuelo: jest.fn() } as unknown as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
    undefined,
    undefined,
    undefined,
    undefined,
    m.confirmador,
  );
  return { service, llamadas, updates, notifyUser, notifyRole, syncFlight };
}

/** status + code + message de una HttpException estructurada. */
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

/** Avisos best-effort en segundo plano: dejar que terminen. */
const esperarAvisos = () => new Promise((r) => setImmediate(r));

describe('faltaAsignacion (puro)', () => {
  it('propio sin nada ⇒ [aeronave, piloto] en ese orden; solo piloto ⇒ [piloto]; completo ⇒ []', () => {
    expect(
      faltaAsignacion({
        es_externo: false,
        aeronave_id: null,
        piloto_id: null,
      }),
    ).toEqual(['aeronave', 'piloto']);
    expect(
      faltaAsignacion({
        es_externo: false,
        aeronave_id: AVION,
        piloto_id: null,
      }),
    ).toEqual(['piloto']);
    expect(
      faltaAsignacion({
        es_externo: false,
        aeronave_id: AVION,
        piloto_id: PILOTO,
      }),
    ).toEqual([]);
  });

  it('EXTERNO (operador de fuera) no lleva avión ni piloto propios ⇒ []', () => {
    expect(
      faltaAsignacion({ es_externo: true, aeronave_id: null, piloto_id: null }),
    ).toEqual([]);
  });
});

describe('confirmar — RESERVA / SOLICITUD → CONFIRMADO', () => {
  it.each(['RESERVA', 'SOLICITUD'])(
    '%s con avión y piloto: CONFIRMADO + fecha_confirmacion con CAS por estado, calendario y «queda en firme» a la tripulación',
    async (estado) => {
      const w = armar({ vuelo: vueloRow({ estado }) });
      const out = await w.service.confirmar(V1, {}, USER);
      expect(w.updates).toHaveLength(1);
      const upd = w.updates[0];
      expect(upd.estado).toBe('CONFIRMADO');
      expect(upd.updated_by).toBe(USER);
      expect(typeof upd.fecha_confirmacion).toBe('string');
      expect(
        Math.abs(Date.now() - Date.parse(upd.fecha_confirmacion as string)),
      ).toBeLessThan(10_000);
      // CAS: el UPDATE va acotado por id Y por el estado leído.
      const escritura = w.llamadas.find((l) =>
        l.ops.some((o) => o.m === 'update'),
      );
      expect(escritura?.tabla).toBe('vuelo');
      expect(eqDe(escritura!.ops, 'id')).toBe(V1);
      expect(eqDe(escritura!.ops, 'estado')).toBe(estado);
      expect(out).toMatchObject({
        id: V1,
        estado: 'CONFIRMADO',
        avisos: [],
      });
      expect(out.idempotente).toBeUndefined();
      expect(w.syncFlight).toHaveBeenCalledWith(V1);
      await esperarAvisos();
      expect(w.notifyUser).toHaveBeenCalledWith(
        PILOTO,
        expect.objectContaining({
          tipo: 'vuelo_asignado',
          titulo: 'Vuelo #118 confirmado',
          cuerpo: expect.stringMatching(
            /^CUN → HOL del .* queda en firme\.$/,
          ) as string,
          link: `/flights/${V1}`,
        }),
      );
    },
  );

  it('la llave del outbox no cambia el contrato (solo trazabilidad)', async () => {
    const w = armar({});
    const out = await w.service.confirmar(V1, { clientRequestId: LLAVE }, USER);
    expect(out.estado).toBe('CONFIRMADO');
    expect(w.updates[0].client_request_id).toBeUndefined();
    await esperarAvisos();
  });

  it('EXTERNO sin avión ni piloto: se confirma sin pedir asignación y sin leer squawks', async () => {
    const w = armar({
      vuelo: vueloRow({
        es_externo: true,
        aeronave_id: null,
        piloto_id: null,
        operador_externo: 'Aerolíneas X',
      }),
    });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(out.estado).toBe('CONFIRMADO');
    expect(out.avisos).toEqual([]);
    expect(w.llamadas.some((l) => l.tabla === 'aeronave_discrepancia')).toBe(
      false,
    );
    await esperarAvisos();
  });

  it.each(['RESERVA', 'SOLICITUD'])(
    'HIJO de grupo en %s ⇒ 409 VUELO_DE_GRUPO (se confirma desde el grupo) y NO escribe',
    async (estado) => {
      const w = armar({
        vuelo: vueloRow({
          estado,
          grupo_id: 'aaaaaaaa-0000-4000-8000-00000000009a',
          grupo_posicion: 2,
          grupo: { id: 'g', folio: 12, nombre: null, pasajeros_total: 44 },
        }),
      });
      const r = await rebote(w.service.confirmar(V1, {}, USER));
      expect(r.status).toBe(409);
      expect(r.code).toBe('VUELO_DE_GRUPO');
      expect(r.message).toBe(
        'No se puede confirmar el vuelo #118 por separado: es parte del grupo G-12 (avión 2). Confírmalo desde el grupo.',
      );
      expect(r.details).toMatchObject({ folio: 118, grupo_folio: 12, estado });
      expect(w.updates).toHaveLength(0);
      expect(w.syncFlight).not.toHaveBeenCalled();
      expect(w.notifyUser).not.toHaveBeenCalled();
    },
  );
});

describe('confirmar — candados de asignación', () => {
  it('propio sin avión ni piloto ⇒ 409 VUELO_SIN_ASIGNAR details.falta [aeronave, piloto] y NO escribe', async () => {
    const w = armar({
      vuelo: vueloRow({ aeronave_id: null, piloto_id: null }),
    });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('VUELO_SIN_ASIGNAR');
    expect(r.details).toEqual({
      falta: ['aeronave', 'piloto'],
      estado: 'RESERVA',
      folio: 118,
    });
    expect(r.message).toBe(
      'No se puede confirmar el vuelo #118: falta asignar el avión y el piloto.',
    );
    expect(w.updates).toHaveLength(0);
    expect(w.syncFlight).not.toHaveBeenCalled();
  });

  it('solo falta el piloto ⇒ details.falta [piloto]', async () => {
    const w = armar({ vuelo: vueloRow({ piloto_id: null }) });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.code).toBe('VUELO_SIN_ASIGNAR');
    expect(r.details?.falta).toEqual(['piloto']);
    expect(r.message).toContain('falta asignar el piloto.');
  });

  it('squawk ALTA sin resolver ⇒ 409 SQUAWK_ALTA_SIN_RESOLVER (mismo candado que assign) y NO escribe', async () => {
    const w = armar({
      squawks: [{ id: 'sq-1', descripcion: 'Fuga de aceite motor izq.' }],
    });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.status).toBe(409);
    expect(r.code).toBe('SQUAWK_ALTA_SIN_RESOLVER');
    expect(r.details).toEqual({
      aeronave_id: AVION,
      discrepancias: [{ id: 'sq-1', descripcion: 'Fuga de aceite motor izq.' }],
    });
    expect(w.updates).toHaveLength(0);
  });

  it('squawk ALTA con aceptar_discrepancia_alta ⇒ confirma y avisa al mecánico', async () => {
    const w = armar({
      squawks: [{ id: 'sq-1', descripcion: 'Fuga de aceite motor izq.' }],
    });
    const out = await w.service.confirmar(
      V1,
      { aceptarDiscrepanciaAlta: true },
      USER,
    );
    expect(out.estado).toBe('CONFIRMADO');
    // La primera escritura es la confirmación (el sello del squawk en
    // notas_internas llega después, en segundo plano).
    expect(w.updates[0]).toMatchObject({ estado: 'CONFIRMADO' });
    await esperarAvisos();
    await esperarAvisos();
    expect(w.notifyRole).toHaveBeenCalledWith(
      'MECANICO',
      expect.objectContaining({
        cuerpo: expect.stringContaining('Fuga de aceite') as string,
      }),
    );
  });

  it('avión EN TALLER ⇒ confirma igual y el aviso ámbar viaja en avisos[] (nunca 409)', async () => {
    const w = armar({ enTaller: true });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(out.estado).toBe('CONFIRMADO');
    expect(out.avisos).toEqual([avisoAeronaveEnTaller('XA-VGV')]);
    await esperarAvisos();
  });
});

describe('confirmar — idempotencia y estados no confirmables', () => {
  it('ya CONFIRMADO ⇒ 200 {…vuelo, avisos: [], idempotente: true} sin escribir ni avisar', async () => {
    const w = armar({
      vuelo: vueloRow({
        estado: 'CONFIRMADO',
        fecha_confirmacion: '2026-10-15T20:00:00+00:00',
      }),
    });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(out).toMatchObject({
      id: V1,
      estado: 'CONFIRMADO',
      fecha_confirmacion: '2026-10-15T20:00:00+00:00',
      avisos: [],
      idempotente: true,
    });
    expect(w.updates).toHaveLength(0);
    expect(w.syncFlight).not.toHaveBeenCalled();
    expect(w.notifyUser).not.toHaveBeenCalled();
  });

  it.each(['EN_VUELO', 'COMPLETADO', 'CANCELADO'])(
    '%s ⇒ 409 VUELO_NO_CONFIRMABLE con details {estado, folio}',
    async (estado) => {
      const w = armar({ vuelo: vueloRow({ estado }) });
      const r = await rebote(w.service.confirmar(V1, {}, USER));
      expect(r.status).toBe(409);
      expect(r.code).toBe('VUELO_NO_CONFIRMABLE');
      expect(r.details).toEqual({ estado, folio: 118 });
      expect(r.message).toBe(
        `No se puede confirmar un vuelo en estado ${estado}.`,
      );
      expect(w.updates).toHaveLength(0);
    },
  );

  it('vuelo inexistente ⇒ 404 VUELO_NO_EXISTE (findById de siempre)', async () => {
    const w = armar({ vuelo: null });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.status).toBe(404);
    expect(r.code).toBe('VUELO_NO_EXISTE');
  });

  it('CAS pierde y la relectura ya está CONFIRMADO ⇒ idempotente, sin repetir calendario ni avisos', async () => {
    const w = armar({
      casPierde: vueloRow({ estado: 'CONFIRMADO' }),
    });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(out).toMatchObject({ estado: 'CONFIRMADO', idempotente: true });
    expect(w.updates).toHaveLength(1);
    expect(w.syncFlight).not.toHaveBeenCalled();
    expect(w.notifyUser).not.toHaveBeenCalled();
  });

  it('CAS pierde y la relectura está CANCELADO ⇒ 409 VUELO_NO_CONFIRMABLE', async () => {
    const w = armar({ casPierde: vueloRow({ estado: 'CANCELADO' }) });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.code).toBe('VUELO_NO_CONFIRMABLE');
    expect(r.details?.estado).toBe('CANCELADO');
    expect(w.syncFlight).not.toHaveBeenCalled();
  });
});

describe('confirmar — COTIZADO delega en QuotesService.confirm', () => {
  it('llama al confirmador con (id, userId), NO escribe en vuelo desde flights y suma avisos[]', async () => {
    const confirm = jest.fn().mockResolvedValue(
      vueloRow({
        estado: 'CONFIRMADO',
        fecha_confirmacion: '2026-10-16T15:00:00+00:00',
      }),
    );
    const w = armar({
      vuelo: vueloRow({ estado: 'COTIZADO' }),
      enTaller: true,
      confirmador: { confirm },
    });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(confirm).toHaveBeenCalledWith(V1, USER);
    expect(w.updates).toHaveLength(0);
    // El calendario y la tripulación los dispara quotes.confirm; aquí no.
    expect(w.syncFlight).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      id: V1,
      estado: 'CONFIRMADO',
      fecha_confirmacion: '2026-10-16T15:00:00+00:00',
      avisos: [avisoAeronaveEnTaller('XA-VGV')],
    });
    expect(out.idempotente).toBeUndefined();
  });

  it('el confirmador devuelve idempotente (perdió su CAS) ⇒ se pasa tal cual con avisos: [] y sin leer taller', async () => {
    const confirm = jest.fn().mockResolvedValue({
      ...vueloRow({ estado: 'CONFIRMADO', aeronave_id: AVION }),
      idempotente: true,
    });
    const w = armar({
      vuelo: vueloRow({ estado: 'COTIZADO' }),
      enTaller: true,
      confirmador: { confirm },
    });
    const out = await w.service.confirmar(V1, {}, USER);
    expect(out).toMatchObject({ estado: 'CONFIRMADO', idempotente: true });
    expect(out.avisos).toEqual([]);
    expect(w.llamadas.some((l) => l.tabla === 'mantenimiento')).toBe(false);
  });

  it('el 409 del confirmador (cotización ya movida) sube tal cual', async () => {
    const confirm = jest
      .fn()
      .mockRejectedValue(
        new ConflictException(
          'Solo cotizaciones en estado COTIZADO pueden confirmarse. Estado actual: CANCELADO',
        ),
      );
    const w = armar({
      vuelo: vueloRow({ estado: 'COTIZADO' }),
      confirmador: { confirm },
    });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.status).toBe(409);
    expect(r.message).toContain('Estado actual: CANCELADO');
  });

  it('sin confirmador inyectado ⇒ 503 CONFIRMACION_NO_DISPONIBLE y nada se escribe', async () => {
    const w = armar({ vuelo: vueloRow({ estado: 'COTIZADO' }) });
    const r = await rebote(w.service.confirmar(V1, {}, USER));
    expect(r.status).toBe(503);
    expect(r.code).toBe('CONFIRMACION_NO_DISPONIBLE');
    expect(w.updates).toHaveLength(0);
  });
});
