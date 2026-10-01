// Vigencia de las firmas que alimentan MINIATURAS del panel (1-oct-2026,
// API 0.0.48): de 1 h a 8 h. Stubs de los módulos pesados como en
// expenses.service.spec / flights.service.espejo-google.spec.
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
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import {
  SEGUNDOS_URL_MINIATURA,
  SEGUNDOS_URL_PUNTUAL,
} from '../../common/url-firmada.util';
import { ExpensesService } from '../expenses/expenses.service';
import { InvoicesController } from '../facturacion/invoices.controller';
import { InvoicesService } from '../facturacion/invoices.service';
import { FlightsService } from '../flights/flights.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Reporte de la oficina («las fotos de las facturas no están cargando»): el
 * panel firmaba al renderizar con 1 h y la pestaña se quedaba abierta más de
 * una hora ⇒ Supabase 400 `InvalidJWT` ⇒ imagen rota. Las firmas de
 * miniaturas pasan a 8 h; las que se entregan a la IA siguen en 1 h.
 */
function storageSimulado(fila: Record<string, unknown> | null = null) {
  const llamadas: Array<{ bucket: string; paths: string[]; segundos: number }> =
    [];
  // Lectura mínima de la BD (`from(t).select().eq().maybeSingle()`) para
  // `flightPlanUrl`.
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: () => Promise.resolve({ data: fila, error: null }),
  };
  const service = {
    from: () => consulta,
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: (paths: string[], segundos: number) => {
          llamadas.push({ bucket, paths, segundos });
          return Promise.resolve({
            data: paths.map((p) => ({
              path: p,
              signedUrl: `https://x/object/sign/${bucket}/${p}?token=${segundos}`,
              error: null,
            })),
            error: null,
          });
        },
        createSignedUrl: (path: string, segundos: number) => {
          llamadas.push({ bucket, paths: [path], segundos });
          return Promise.resolve({
            data: {
              signedUrl: `https://x/object/sign/${bucket}/${path}?token=${segundos}`,
            },
            error: null,
          });
        },
      }),
    },
  };
  return {
    llamadas,
    supabase: { service } as unknown as SupabaseService,
  };
}

describe('Vigencia de URLs firmadas (1-oct-2026)', () => {
  it('constantes: 8 h para miniaturas, 1 h para lo puntual', () => {
    expect(SEGUNDOS_URL_MINIATURA).toBe(8 * 3600);
    expect(SEGUNDOS_URL_PUNTUAL).toBe(3600);
    // El panel renueva antes de abrir el visor si la URL tiene > 50 min:
    // con 8 h el caso normal nunca llega a la imagen rota.
    expect(SEGUNDOS_URL_MINIATURA).toBeGreaterThan(50 * 60);
  });

  it('ExpensesService.signPhotos (photo-urls de Gastos, caja chica, compras…) firma 8 h por default', async () => {
    const { llamadas, supabase } = storageSimulado();
    const nada = {} as never;
    const svc = new ExpensesService(
      supabase,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
    );
    const urls = await svc.signPhotos([
      'u/2026-09/a.jpg',
      '',
      'u/2026-09/a.jpg',
    ]);
    expect(llamadas).toEqual([
      { bucket: 'gasto-fotos', paths: ['u/2026-09/a.jpg'], segundos: 28800 },
    ]);
    expect(urls).toEqual({
      'u/2026-09/a.jpg':
        'https://x/object/sign/gasto-fotos/u/2026-09/a.jpg?token=28800',
    });
    // La IA pide explícitamente la vigencia corta.
    await svc.signPhotos(['u/2026-09/b.jpg'], SEGUNDOS_URL_PUNTUAL);
    expect(llamadas[1]).toEqual({
      bucket: 'gasto-fotos',
      paths: ['u/2026-09/b.jpg'],
      segundos: 3600,
    });
  });

  it('FlightsService.signCobroVouchers (miniatura del comprobante del cobro) firma 8 h', async () => {
    const { llamadas, supabase } = storageSimulado();
    const nada = {} as never;
    const svc = new FlightsService(
      supabase,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
    );
    await svc.signCobroVouchers(['oficina/v/c/x.jpg']);
    expect(llamadas).toEqual([
      {
        bucket: 'cobro-vouchers',
        paths: ['oficina/v/c/x.jpg'],
        segundos: 28800,
      },
    ]);
  });

  function flightsCon(supabase: SupabaseService): FlightsService {
    const nada = {} as never;
    return new FlightsService(
      supabase,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
      nada,
    );
  }

  it('FlightsService.tacoPhotos (miniaturas de tacómetro del detalle del vuelo) firma 8 h', async () => {
    const { llamadas, supabase } = storageSimulado();
    const svc = flightsCon(supabase);
    jest.spyOn(svc, 'listEscalas').mockResolvedValue([
      {
        id: 'e1',
        orden: 1,
        foto_taco_salida_url: 'p/2026-09/s.jpg',
        foto_taco_llegada_url: 'p/2026-09/l.jpg',
      },
      { id: 'e2', orden: 2 },
    ] as never);
    const fotos = await svc.tacoPhotos('v-1');
    expect(llamadas).toEqual([
      {
        bucket: 'taco-fotos',
        paths: ['p/2026-09/s.jpg', 'p/2026-09/l.jpg'],
        segundos: 28800,
      },
    ]);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].foto_salida_url).toContain('token=28800');
  });

  it('FlightsService.flightPlanUrl (href del plan de vuelo, firmado al renderizar el detalle) firma 8 h', async () => {
    const { llamadas, supabase } = storageSimulado({
      foto_plan_vuelo_url: 'vuelo-1/plan-1.jpg',
    });
    const r = await flightsCon(supabase).flightPlanUrl('v-1');
    expect(llamadas).toEqual([
      {
        bucket: 'planes-vuelo',
        paths: ['vuelo-1/plan-1.jpg'],
        segundos: 28800,
      },
    ]);
    expect(r.url).toContain('token=28800');
  });

  it('Facturas CFDI: POST invoices/file-urls (/admin/facturas firma al renderizar) pide 8 h; el buzón de recibidas (al clic) 1 h', async () => {
    const { llamadas, supabase } = storageSimulado();
    const nada = {} as never;
    const svc = new InvoicesService(supabase, nada, nada, nada);
    const ctrl = new InvoicesController(svc);
    await ctrl.fileUrls({ paths: ['cfdi/a.xml'] });
    await ctrl.recibidaFileUrls({ paths: ['recibidas/b.xml'] });
    expect(llamadas).toEqual([
      { bucket: 'facturas', paths: ['cfdi/a.xml'], segundos: 28800 },
      { bucket: 'facturas', paths: ['recibidas/b.xml'], segundos: 3600 },
    ]);
  });
});
