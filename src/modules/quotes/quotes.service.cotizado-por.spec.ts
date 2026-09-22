// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que los demás specs del cotizador).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { QuotesService } from './quotes.service';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * `cotizado_por` EN `GET /v1/quotes/:id` (22-sep-2026) — la hoja interna
 * imprime quién cotizó y hasta hoy ese dato solo existía dentro del armador
 * del PDF interno (una consulta suelta a `vuelo.created_by`).
 *
 * Contrato (ADITIVO, tres reglas):
 * 1. `created_by` NO entra a `VUELO_COLS`: esa constante la comparten
 *    `list()`, `findById` y tres selects más. El detalle la AMPLÍA en su
 *    propio select, con el nombre embebido en la MISMA consulta.
 * 2. Nunca un uuid ni un nombre inventado: usuario borrado, nombre en blanco
 *    o relación sin resolver ⇒ `null`.
 * 3. La relación cruda (`creador`) NO sale en la respuesta: el contrato es
 *    el nombre.
 */
const V329 = 'vvvvvvvv-0000-4000-8000-000000000329';
const AVION = 'aaaaaaaa-0000-4000-8000-00000000c206';

type Row = Record<string, unknown>;

function vueloRow(extra: Row = {}): Row {
  return {
    id: V329,
    folio: 329,
    aeronave_id: AVION,
    estado: 'COTIZADO',
    es_externo: false,
    pasajeros: 4,
    monto_total_usd: 2887.5,
    subtotal_vuelo_usd: 2887.5,
    tuas_usd: 0,
    extras_total_usd: 0,
    viaticos_pernocta_usd: 0,
    ajuste_final_usd: 0,
    comision_vendedor_usd: 0,
    iva_usd: 0,
    calculo_snapshot: null,
    created_by: 'uuuuuuuu-0000-4000-8000-0000000000it',
    creador: { nombre: 'Itzi' },
    ...extra,
  };
}

/** Métodos encadenables de PostgREST que toca `findById`. */
const ENCADENABLES = [
  'eq',
  'in',
  'is',
  'neq',
  'not',
  'or',
  'gte',
  'lte',
  'order',
  'limit',
  'range',
  'filter',
] as const;

/** Supabase mínimo: registra los `select` y responde por tabla. */
function armar(vuelo: Row) {
  const selects: Array<{ tabla: string; select: string }> = [];
  const supabase = {
    service: {
      from(tabla: string) {
        // `vuelo` se lee con maybeSingle; `escala`/`aeronave` se consumen
        // como promesa (await de la query) y aquí van vacías: este spec mide
        // SOLO cómo se resuelve `cotizado_por`.
        const resultado = {
          data: tabla === 'vuelo' ? vuelo : [],
          error: null,
        };
        const q: Record<string, unknown> = {
          select: (s: string) => {
            selects.push({ tabla, select: s });
            return q;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: tabla === 'vuelo' ? vuelo : null,
              error: null,
            }),
          single: () =>
            Promise.resolve({
              data: tabla === 'vuelo' ? vuelo : null,
              error: null,
            }),
          then: (
            res: (v: typeof resultado) => unknown,
            rej: (e: unknown) => unknown,
          ) => Promise.resolve(resultado).then(res, rej),
        };
        for (const m of ENCADENABLES) q[m] = () => q;
        return q;
      },
    },
  } as unknown as SupabaseService;
  const svc = new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
  );
  return { svc, selects };
}

describe('QuotesService.findById — cotizado_por (ADITIVO)', () => {
  it('resuelve el nombre de quien creó la cotización en la MISMA consulta y no devuelve la relación cruda', async () => {
    const { svc, selects } = armar(vueloRow());
    const r = (await svc.findById(V329)) as Row;
    expect(r.cotizado_por).toBe('Itzi');
    expect(r).not.toHaveProperty('creador');
    // `created_by` sí viaja (el panel lo usa para ligar al usuario).
    expect(r.created_by).toBe('uuuuuuuu-0000-4000-8000-0000000000it');

    const selVuelo = selects.find((s) => s.tabla === 'vuelo')!.select;
    // UNA sola consulta de `vuelo`: el nombre viene embebido, no en un
    // round-trip aparte.
    expect(selects.filter((s) => s.tabla === 'vuelo')).toHaveLength(1);
    expect(selVuelo).toContain('creador:usuario!created_by(nombre)');
    expect(selVuelo).toContain('created_by');
    // Y sigue trayendo TODO lo de siempre (VUELO_COLS intacto).
    expect(selVuelo).toContain('calculo_snapshot');
    expect(selVuelo).toContain('monto_total_usd');
  });

  it('sin usuario, con nombre en blanco o con la relación vacía ⇒ null (jamás un uuid)', async () => {
    for (const creador of [
      null,
      undefined,
      [],
      {},
      { nombre: '   ' },
      'Itzi',
    ]) {
      const { svc } = armar(vueloRow({ creador }));
      const r = (await svc.findById(V329)) as Row;
      expect(r.cotizado_por).toBeNull();
    }
  });

  it('PostgREST puede devolver la relación como arreglo de uno: también resuelve', async () => {
    const { svc } = armar(vueloRow({ creador: [{ nombre: 'Pablo Canales' }] }));
    const r = (await svc.findById(V329)) as Row;
    expect(r.cotizado_por).toBe('Pablo Canales');
  });
});
