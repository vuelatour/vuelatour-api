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
 * CASO REAL 14-sep-2026 (vuelo #260 N4142R): el piloto capturó DOS gastos en
 * el 260 y la oficina movió el de CZM al 268. `tg_gasto_bitacora` guarda el
 * UPDATE bajo `coalesce(new.vuelo_id, old.vuelo_id)` = el vuelo DESTINO, así
 * que el 260 mostraba una segunda captura MUDA (sin descripción, sin acción)
 * y el 268 no decía de dónde venía el gasto.
 *
 * Contrato congelado aquí: `accion` NO cambia y el campo ADITIVO
 * `movimiento` dice de qué lado quedó cada vuelo, con folio y descripción.
 */

type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

const V260 = 'vuelo-260';
const V268 = 'vuelo-268';
const PILOTO = 'usr-piloto';
const OFICINA = 'usr-oficina';

function fakeSupabase(db: Tablas, fallos: Record<string, unknown> = {}) {
  const valor = (r: Row, col: string): unknown => {
    if (!col.includes('->')) return r[col];
    const partes = col.split(/->>|->/).map((p) => p.trim());
    let v: unknown = r[partes[0]];
    for (const p of partes.slice(1)) v = (v as Row | null)?.[p];
    return v;
  };
  const service = {
    from(tabla: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      // La consulta de "gastos movidos" se reconoce por su filtro JSON
      // (`diff->vuelo_id->>antes`): así se puede tumbar SOLO a ella.
      let porJson = false;
      const ejecutar = (unico: boolean) => {
        const err = porJson ? (fallos.__json ?? fallos[tabla]) : fallos[tabla];
        if (err) return { data: null, error: err };
        const rows = (db[tabla] ?? [])
          .filter((r) => filtros.every((f) => f(r)))
          .map((r) => ({ ...r }));
        return { data: unico ? (rows[0] ?? null) : rows, error: null };
      };
      const api: Record<string, unknown> = {
        select: () => api,
        eq(col: string, val: unknown) {
          if (col.includes('->')) porJson = true;
          filtros.push((r) => valor(r, col) === val);
          return api;
        },
        neq(col: string, val: unknown) {
          filtros.push((r) => valor(r, col) !== val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          filtros.push((r) => vals.includes(valor(r, col)));
          return api;
        },
        order: () => api,
        limit: () => api,
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { service } as unknown as SupabaseService;
}

function armar(db: Tablas, fallos: Record<string, unknown> = {}) {
  return new FlightsService(
    fakeSupabase(db, fallos),
    { syncFlight: jest.fn() } as unknown as CalendarSyncService,
    {} as EmailService,
    {} as VisionService,
    {} as NotificationsService,
    {} as ExpirationsService,
    {} as AirportsService,
    {} as ConfiguracionService,
    {} as PilotsService,
  );
}

/** El mundo del caso real: dos gastos capturados en el 260, uno movido al 268. */
function mundo(): Tablas {
  return {
    usuario: [
      { id: PILOTO, nombre: 'Luis Cáceres', rol: 'PILOTO' },
      { id: OFICINA, nombre: 'Oficina', rol: 'ADMIN' },
    ],
    vuelo: [
      { id: V260, folio: 260 },
      { id: V268, folio: 268 },
    ],
    gasto: [
      // El de CUN se quedó en el 260…
      {
        id: 'g-cun',
        vuelo_id: V260,
        categoria: 'PISTA',
        monto: 277.79,
        moneda: 'MXN',
        created_by: PILOTO,
        created_at: '2026-09-14T14:03:00Z',
      },
      // …y el de CZM YA VIVE en el 268.
      {
        id: 'g-czm',
        vuelo_id: V268,
        categoria: 'PISTA',
        monto: 125.82,
        moneda: 'MXN',
        created_by: PILOTO,
        created_at: '2026-09-14T14:04:00Z',
      },
    ],
    gasto_bitacora: [
      {
        id: 'b-1',
        gasto_id: 'g-cun',
        vuelo_id: V260,
        accion: 'INSERT',
        actor_id: PILOTO,
        diff: { vuelo_id: { antes: null, despues: V260 } },
        snapshot: null,
        created_at: '2026-09-14T14:03:00Z',
      },
      {
        id: 'b-2',
        gasto_id: 'g-czm',
        vuelo_id: V260,
        accion: 'INSERT',
        actor_id: PILOTO,
        diff: { vuelo_id: { antes: null, despues: V260 } },
        snapshot: null,
        created_at: '2026-09-14T14:04:00Z',
      },
      // El movimiento: la fila vive bajo el vuelo DESTINO (268).
      {
        id: 'b-3',
        gasto_id: 'g-czm',
        vuelo_id: V268,
        accion: 'UPDATE',
        actor_id: OFICINA,
        diff: { vuelo_id: { antes: V260, despues: V268 } },
        snapshot: null,
        created_at: '2026-09-14T14:27:00Z',
      },
    ],
  };
}

describe('gastosHistorial — gasto movido a otro vuelo', () => {
  it('vuelo ORIGEN: la captura deja de ser muda y aparece «salió» con folio y descripción', async () => {
    const flights = armar(mundo());
    const eventos = await flights.gastosHistorial(V260);
    expect(eventos).toHaveLength(3);

    const captura = eventos.find(
      (e) => e.gasto_id === 'g-czm' && e.accion === 'INSERT',
    )!;
    // A3: la descripción se resuelve aunque el gasto ya no viva aquí.
    expect(captura.descripcion_gasto).toBe('Pista · 125.82 MXN');
    expect(captura.movimiento).toBeNull();
    expect(captura.actor_nombre).toBe('Luis Cáceres');

    const salida = eventos.find((e) => e.accion === 'UPDATE')!;
    expect(salida.gasto_id).toBe('g-czm');
    expect(salida.movimiento).toEqual({
      tipo: 'salio',
      vuelo_id: V268,
      folio: 268,
    });
    expect(salida.descripcion_gasto).toBe('Pista · 125.82 MXN');
    expect(salida.actor_nombre).toBe('Oficina');
  });

  it('vuelo DESTINO: el mismo evento se lee como «llegó» con el folio del origen', async () => {
    const flights = armar(mundo());
    const eventos = await flights.gastosHistorial(V268);
    // La captura (fila INSERT) vive bajo el 260: aquí se SINTETIZA desde el
    // gasto vivo, como cualquier historial que arranca en la captura.
    expect(eventos).toHaveLength(2);
    expect(eventos[0]).toMatchObject({
      gasto_id: 'g-czm',
      accion: 'INSERT',
      sintetizado: true,
      movimiento: null,
    });
    expect(eventos[1]).toMatchObject({
      gasto_id: 'g-czm',
      accion: 'UPDATE',
      descripcion_gasto: 'Pista · 125.82 MXN',
      movimiento: { tipo: 'llego', vuelo_id: V260, folio: 260 },
    });
  });

  it('el gasto que NO se movió sigue igual: accion INSERT y movimiento null', async () => {
    const flights = armar(mundo());
    const eventos = await flights.gastosHistorial(V260);
    const cun = eventos.find((e) => e.gasto_id === 'g-cun')!;
    expect(cun).toMatchObject({
      accion: 'INSERT',
      movimiento: null,
      descripcion_gasto: 'Pista · 277.79 MXN',
    });
  });

  it('un UPDATE que solo DESLIGA el vuelo sale una vez, como «salió» sin contraparte', async () => {
    const db = mundo();
    db.gasto_bitacora = [
      {
        id: 'b-9',
        gasto_id: 'g-cun',
        // coalesce(new.vuelo_id, old.vuelo_id) = el viejo: la fila cae en las
        // DOS consultas y no puede duplicarse.
        vuelo_id: V260,
        accion: 'UPDATE',
        actor_id: OFICINA,
        diff: { vuelo_id: { antes: V260, despues: null } },
        snapshot: null,
        created_at: '2026-09-14T15:00:00Z',
      },
    ];
    const flights = armar(db);
    const eventos = await flights.gastosHistorial(V260);
    const updates = eventos.filter((e) => e.accion === 'UPDATE');
    expect(updates).toHaveLength(1);
    expect(updates[0].movimiento).toEqual({
      tipo: 'salio',
      vuelo_id: null,
      folio: null,
    });
  });

  it('si la consulta de movidos falla, el historial SIGUE saliendo (solo sin «salió»)', async () => {
    // Best-effort por diseño: se pierde el aviso del movimiento, jamás la
    // pantalla del vuelo.
    const flights = armar(mundo(), {
      __json: { message: 'operator does not exist: jsonb -> unknown' },
    });
    const eventos = await flights.gastosHistorial(V260);
    expect(eventos).toHaveLength(2);
    expect(eventos.every((e) => e.movimiento === null)).toBe(true);
    expect(eventos.map((e) => e.gasto_id).sort()).toEqual(['g-cun', 'g-czm']);
  });
});

/**
 * REVISIÓN 14-sep-2026 — un gasto puede REBOTAR entre vuelos (260 → 268 →
 * 300). Cada fila de bitácora vive bajo el vuelo DESTINO de SU movimiento,
 * así que el vuelo intermedio la ve por las DOS consultas (la suya por
 * `vuelo_id` y la de movidos por `diff->vuelo_id->>antes`): sin la
 * deduplicación por `gasto_bitacora.id` la línea saldría repetida.
 */
describe('gastosHistorial — gasto movido DOS veces (260 → 268 → 300)', () => {
  function mundoRebote(): Tablas {
    const db = mundo();
    db.vuelo.push({ id: 'v-300', folio: 300 });
    // El gasto terminó en el 300.
    db.gasto.find((g) => g.id === 'g-czm')!.vuelo_id = 'v-300';
    db.gasto_bitacora.push({
      id: 'b-4',
      gasto_id: 'g-czm',
      vuelo_id: 'v-300',
      accion: 'UPDATE',
      actor_id: OFICINA,
      diff: { vuelo_id: { antes: V268, despues: 'v-300' } },
      snapshot: null,
      created_at: '2026-09-14T15:10:00Z',
    });
    return db;
  }

  it('el vuelo INTERMEDIO ve «llegó» y «salió» UNA vez cada uno (sin duplicar)', async () => {
    const flights = armar(mundoRebote());
    const eventos = await flights.gastosHistorial(V268);
    const updates = eventos.filter((e) => e.accion === 'UPDATE');
    expect(updates).toHaveLength(2);
    expect(new Set(eventos.map((e) => e.created_at)).size).toBe(eventos.length);
    expect(updates[0].movimiento).toEqual({
      tipo: 'llego',
      vuelo_id: V260,
      folio: 260,
    });
    expect(updates[1].movimiento).toEqual({
      tipo: 'salio',
      vuelo_id: 'v-300',
      folio: 300,
    });
    // Y la descripción se resuelve aunque el gasto ya no viva en el 268.
    expect(updates[1].descripcion_gasto).toBe('Pista · 125.82 MXN');
  });

  it('el vuelo ORIGEN sigue viendo SOLO su salida al 268 (no la del 300)', async () => {
    const flights = armar(mundoRebote());
    const eventos = await flights.gastosHistorial(V260);
    const updates = eventos.filter((e) => e.accion === 'UPDATE');
    expect(updates).toHaveLength(1);
    expect(updates[0].movimiento).toMatchObject({ tipo: 'salio', folio: 268 });
  });

  it('el vuelo FINAL ve «llegó» del 268 y la captura sintetizada', async () => {
    const flights = armar(mundoRebote());
    const eventos = await flights.gastosHistorial('v-300');
    expect(eventos.filter((e) => e.accion === 'INSERT')).toHaveLength(1);
    const llego = eventos.find((e) => e.accion === 'UPDATE')!;
    expect(llego.movimiento).toEqual({
      tipo: 'llego',
      vuelo_id: V268,
      folio: 268,
    });
  });
});
