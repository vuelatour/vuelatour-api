// cobro-recibo.service importa COBRO_COLS de flights.service, que arrastra
// el gateway de notificaciones y `jose` (ESM puro que jest no transforma):
// mismos stubs que los demás specs de este módulo.
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

import { CobroReciboService } from './cobro-recibo.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  PyservicesService,
  ReciboPdfPayload,
} from '../pyservices/pyservices.service';

/**
 * RECIBO DE PAGO (11-sep-2026): el «Método» del recibo sale SIEMPRE de
 * `cobro_vuelo.metodo_cobro` — lo que de verdad se recibió —, JAMÁS de
 * `vuelo.metodo_cobro` (lo previsto al cotizar, que además define el IVA del
 * desglose). Un vuelo cotizado por transferencia puede liquidarse en
 * efectivo, y cada parcialidad puede venir por un medio distinto.
 */
type Op = { m: string; args: unknown[] };
type Row = Record<string, unknown>;

const COBRO_ID = 'cccccccc-0000-4000-8000-000000000001';
const VUELO_ID = 'vvvvvvvv-0000-4000-8000-000000000001';

function fakeSupabase(
  resolver: (tabla: string, ops: Op[], lista: boolean) => unknown,
) {
  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
      const resolve = (lista: boolean) => ({
        data: resolver(tabla, ops, lista) ?? (lista ? [] : null),
        error: null,
      });
      for (const m of [
        'select',
        'eq',
        'in',
        'is',
        'not',
        'or',
        'gte',
        'lte',
        'order',
        'limit',
        'range',
      ]) {
        q[m] = (...args: unknown[]) => {
          ops.push({ m, args });
          return q;
        };
      }
      q.maybeSingle = () => Promise.resolve(resolve(false));
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve(true)).then(res);
      return q;
    },
  };
  return { supabase: { service } as unknown as SupabaseService };
}

function armar(over: { cobro?: Row; vuelo?: Row; cobros?: Row[] } = {}) {
  const cobro: Row = {
    id: COBRO_ID,
    vuelo_id: VUELO_ID,
    monto: 1000,
    moneda: 'USD',
    // Lo que REALMENTE pagó el cliente.
    metodo_cobro: 'EFECTIVO',
    tc_usd_mxn: null,
    comision_banco_pct: null,
    comision_banco_monto: null,
    cuenta_destino: null,
    referencia: 'REF-9',
    fecha_cobro: '2026-09-09T15:00:00.000Z',
    notas: null,
    created_at: '2026-09-09T15:00:00.000Z',
    ...over.cobro,
  };
  const vuelo: Row = {
    id: VUELO_ID,
    folio: 254,
    cliente_id: 'clienteee-0000-4000-8000-000000000001',
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: '2026-09-09T14:00:00.000Z',
    monto_total_usd: 1000,
    tc_usd_mxn: 17,
    // Lo PREVISTO al cotizar: jamás debe aparecer en el recibo.
    metodo_cobro: 'TRANSFERENCIA',
    ...over.vuelo,
  };
  const { supabase } = fakeSupabase((tabla, ops, lista) => {
    const eq = (col: string) =>
      ops.find((o) => o.m === 'eq' && o.args[0] === col)?.args[1];
    switch (tabla) {
      case 'cobro_vuelo':
        if (eq('id') !== undefined) return cobro;
        return over.cobros ?? [cobro];
      case 'vuelo':
        return vuelo;
      case 'escala':
        return lista
          ? [
              {
                orden: 1,
                origen_iata: 'CUN',
                destino_iata: 'HOL',
                solo_operativa: false,
                pdf_oculto: false,
              },
            ]
          : null;
      case 'cliente':
        return { nombre: 'Juan Pérez', razon_social_default: null };
      default:
        return lista ? [] : null;
    }
  });
  let payload: ReciboPdfPayload | null = null;
  const pyservices = {
    generateReciboPdf: jest.fn((p: ReciboPdfPayload) => {
      payload = p;
      return Promise.resolve(Buffer.from('pdf'));
    }),
  } as unknown as PyservicesService;
  const service = new CobroReciboService(supabase, pyservices);
  return { service, leerPayload: () => payload! };
}

describe('CobroReciboService — método REAL del cobro', () => {
  it('el recibo pinta el método del COBRO (efectivo), no el previsto del vuelo (transferencia)', async () => {
    const { service, leerPayload } = armar();
    const { folioRecibo } = await service.pdf(COBRO_ID);
    const p = leerPayload();
    expect(p.metodo).toBe('Efectivo');
    expect(p.metodo).not.toBe('Transferencia');
    expect(folioRecibo).toBe('REC-254-1');
  });

  it('cada parcialidad lleva SU método: un segundo cobro con link no hereda el del vuelo', async () => {
    const { service, leerPayload } = armar({
      cobro: { metodo_cobro: 'HSBC_LINK', monto: 400 },
      cobros: [
        {
          id: 'otro',
          monto: 600,
          moneda: 'USD',
          metodo_cobro: 'EFECTIVO',
          created_at: '2026-09-08T15:00:00.000Z',
        },
        {
          id: COBRO_ID,
          monto: 400,
          moneda: 'USD',
          metodo_cobro: 'HSBC_LINK',
          created_at: '2026-09-09T15:00:00.000Z',
        },
      ],
    });
    await service.pdf(COBRO_ID);
    const p = leerPayload();
    expect(p.metodo).toBe('HSBC link');
    // El dinero sigue saliendo de la fuente única (cobrosEnUsd): 600 + 400.
    expect(p.cobrado_a_la_fecha_usd).toBe(1000);
    expect(p.saldo_pendiente_usd).toBe(0);
    expect(p.liquidado).toBe(true);
    expect(p.cobros_previos).toHaveLength(1);
  });

  it('método desconocido (dato viejo): se pinta tal cual, nunca el del vuelo', async () => {
    const { service, leerPayload } = armar({
      cobro: { metodo_cobro: 'MERCADOPAGO' },
    });
    await service.pdf(COBRO_ID);
    expect(leerPayload().metodo).toBe('MERCADOPAGO');
  });
});
