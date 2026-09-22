// Mismos mocks de módulos pesados que el resto de los specs de flights:
// notifications arrastra el gateway y `jose` (ESM puro), calendar-sync
// arrastra googleapis, vision el SDK de IA y pilots el stack de push.
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
 * «Sería buenísimo si se pudiera ver ahí en la lista de cobros de un vuelo
 * quién registró el cobro» (cliente, 22-sep-2026).
 *
 * Contrato congelado aquí — `GET /v1/flights/:id/cobros` y `vuelo.cobros`
 * del snapshot (mismo `listCobros`, y es el que alimenta también la card de
 * cobros del cotizador):
 * 1. Campo ADITIVO `registrado_por_nombre`; TODO lo demás queda idéntico
 *    (`registrado_por` sigue siendo el uuid).
 * 2. Los nombres se resuelven EN LOTE: UNA consulta a `usuario` por
 *    respuesta, con los ids DISTINTOS — jamás una por cobro.
 * 3. Usuario borrado, sin nombre o lectura fallida ⇒ `null`, nunca un uuid
 *    ni un nombre inventado, y la lista de cobros NO se cae.
 */

type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const VUELO = 'vuelo-1';
const ITZI = 'usr-itzi';
const PABLO = 'usr-pablo';
const BORRADO = 'usr-borrado';

function fakeSupabase(db: Tablas, fallos: Record<string, unknown> = {}) {
  /** Consultas por tabla: así se PRUEBA que no hay N+1. */
  const consultas: Array<{ tabla: string; ids: unknown[] | null }> = [];
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let ids: unknown[] | null = null;
      let contada = false;
      const ejecutar = (unico: boolean) => {
        if (!contada) {
          contada = true;
          consultas.push({ tabla, ids });
        }
        const err = fallos[tabla];
        if (err) return { data: null, error: err };
        const rows = (db[tabla] ?? [])
          .filter((r) => filtros.every((f) => f(r)))
          .map((r) => ({ ...r }));
        return { data: unico ? (rows[0] ?? null) : rows, error: null };
      };
      const api: Record<string, unknown> = {
        select: () => api,
        eq(col: string, val: unknown) {
          filtros.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          ids = vals;
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        or: () => api,
        order: () => api,
        limit: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, consultas };
}

function armar(db: Tablas, fallos: Record<string, unknown> = {}) {
  const { supabase, consultas } = fakeSupabase(db, fallos);
  const svc = new FlightsService(
    supabase,
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
  return { svc, consultas };
}

/** Tres cobros del mismo vuelo: dos de Itzi, uno de un usuario BORRADO. */
function mundo(): Tablas {
  return {
    usuario: [
      { id: ITZI, nombre: 'Itzi' },
      { id: PABLO, nombre: 'Pablo Canales' },
    ],
    vuelo: [{ id: VUELO, folio: 314, tc_usd_mxn: 17 }],
    cobro_vuelo: [
      {
        id: 'c-1',
        vuelo_id: VUELO,
        monto: 600,
        moneda: 'USD',
        metodo_cobro: 'DOLARES',
        tc_usd_mxn: null,
        registrado_por: ITZI,
        cobro_grupo_id: null,
        fecha_cobro: '2026-09-21T15:00:00Z',
      },
      {
        id: 'c-2',
        vuelo_id: VUELO,
        monto: 10_000,
        moneda: 'MXN',
        metodo_cobro: 'TRANSFERENCIA',
        tc_usd_mxn: 17,
        registrado_por: PABLO,
        cobro_grupo_id: null,
        fecha_cobro: '2026-09-20T15:00:00Z',
      },
      {
        id: 'c-3',
        vuelo_id: VUELO,
        monto: 200,
        moneda: 'USD',
        metodo_cobro: 'EFECTIVO',
        tc_usd_mxn: null,
        registrado_por: BORRADO,
        cobro_grupo_id: null,
        fecha_cobro: '2026-09-19T15:00:00Z',
      },
      // Cobro de OTRO vuelo: no debe salir ni aportar ids al lote.
      {
        id: 'c-otro',
        vuelo_id: 'vuelo-9',
        monto: 50,
        moneda: 'USD',
        metodo_cobro: 'EFECTIVO',
        tc_usd_mxn: null,
        registrado_por: PABLO,
        cobro_grupo_id: null,
        fecha_cobro: '2026-09-18T15:00:00Z',
      },
    ],
    cobro_grupo: [],
    movimiento_bancario: [],
  };
}

describe('listCobros · registrado_por_nombre (quién registró el cobro)', () => {
  it('resuelve el nombre y CONSERVA el uuid (campo ADITIVO)', async () => {
    const { svc } = armar(mundo());
    const cobros = await svc.listCobros(VUELO);
    const porId = new Map(cobros.map((c) => [c.id as string, c]));
    expect(porId.get('c-1')?.registrado_por_nombre).toBe('Itzi');
    expect(porId.get('c-1')?.registrado_por).toBe(ITZI);
    expect(porId.get('c-2')?.registrado_por_nombre).toBe('Pablo Canales');
  });

  it('usuario BORRADO ⇒ null, jamás el uuid ni un nombre inventado', async () => {
    const { svc } = armar(mundo());
    const cobros = await svc.listCobros(VUELO);
    const c3 = cobros.find((c) => c.id === 'c-3');
    expect(c3?.registrado_por_nombre).toBeNull();
    expect(c3?.registrado_por).toBe(BORRADO);
  });

  it('UNA sola consulta a `usuario` para toda la lista (cero N+1)', async () => {
    const { svc, consultas } = armar(mundo());
    await svc.listCobros(VUELO);
    const aUsuario = consultas.filter((q) => q.tabla === 'usuario');
    expect(aUsuario).toHaveLength(1);
    // Ids DISTINTOS y SOLO los de este vuelo (c-otro no aporta nada nuevo).
    expect(aUsuario[0].ids).toEqual([ITZI, PABLO, BORRADO]);
  });

  it('los demás campos del cobro no cambian (nada más se toca)', async () => {
    const { svc } = armar(mundo());
    const c1 = (await svc.listCobros(VUELO)).find((c) => c.id === 'c-1');
    expect(c1).toMatchObject({
      id: 'c-1',
      vuelo_id: VUELO,
      monto: 600,
      moneda: 'USD',
      metodo_cobro: 'DOLARES',
      cobro_grupo: null,
      conciliado: false,
      movimiento_bancario_id: null,
    });
  });

  it('si `usuario` no se puede leer, los cobros SALEN igual con null', async () => {
    const { svc } = armar(mundo(), { usuario: { message: 'timeout' } });
    const cobros = await svc.listCobros(VUELO);
    expect(cobros).toHaveLength(3);
    expect(cobros.every((c) => c.registrado_por_nombre === null)).toBe(true);
  });

  it('vuelo SIN cobros: ni una consulta a `usuario`', async () => {
    const db = mundo();
    db.cobro_vuelo = [];
    const { svc, consultas } = armar(db);
    expect(await svc.listCobros(VUELO)).toEqual([]);
    expect(consultas.some((q) => q.tabla === 'usuario')).toBe(false);
  });
});
