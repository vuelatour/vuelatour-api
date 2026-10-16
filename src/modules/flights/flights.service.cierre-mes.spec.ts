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
import { Moneda } from '../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../quotes/dto/calculate-quote.dto';
import type { CreateCobroDto } from './dto/cobros.dto';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * CIERRE DE MES — candado de COBROS y del estado del vuelo (16-oct-2026,
 * invariante 89). Septiembre CERRADO: #318 se quedó (cobrado) y #337 se
 * DIFIRIÓ a octubre. El mes que decide un cobro es el CONTABLE del vuelo.
 */

const ALE = 'u-ale';
const V318 = 'v-318';
const V337 = 'v-337';

const vuelo = (id: string, folio: number, extra: Fila = {}): Fila => ({
  id,
  folio,
  estado: 'COMPLETADO',
  cliente_id: 'cli-1',
  aeronave_id: 'av-1',
  es_externo: false,
  fecha_vuelo: '2026-09-20T15:00:00Z',
  monto_total_usd: 1000,
  tc_usd_mxn: 20,
  metodo_cobro: 'TRANSFERENCIA',
  cobrado: true,
  periodo_contable: null,
  updated_at: '2026-10-01T00:00:00Z',
  ...extra,
});

function mundo(): Record<string, Fila[]> {
  return {
    usuario: [{ id: ALE, nombre: 'Ale Martínez' }],
    cierre_mes: [
      {
        periodo: '2026-09-01',
        estado: 'CERRADO',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: ALE,
        version: 1,
      },
    ],
    vuelo: [
      vuelo(V318, 318),
      vuelo(V337, 337, {
        fecha_vuelo: '2026-09-25T15:00:00Z',
        periodo_contable: '2026-10-01T00:00:00-05:00',
      }),
    ],
    cobro_vuelo: [
      {
        id: 'c-318',
        vuelo_id: V318,
        monto: 1000,
        moneda: 'USD',
        metodo_cobro: 'TRANSFERENCIA',
        tc_usd_mxn: null,
        fecha_cobro: '2026-09-21T16:00:00Z',
        cobro_grupo_id: null,
        client_request_id: 'llave-1',
        comision_banco_monto: null,
        comision_banco_pct: null,
      },
    ],
    escala: [],
  };
}

function armar() {
  const f = fakeCierre(mundo());
  const service = new FlightsService(
    f.supabase as unknown as SupabaseService,
    { syncFlight: jest.fn(), removeFlight: jest.fn() } as never,
    {} as never,
    {} as never,
    {
      notifyUser: jest.fn().mockResolvedValue(true),
      notifyRole: jest.fn().mockResolvedValue(true),
    } as never,
    { findBlockingExpirations: jest.fn().mockResolvedValue([]) } as never,
    { refreshPermisosDeVuelo: jest.fn() } as never,
    { numero: jest.fn().mockResolvedValue(8.857) } as never,
    {} as never,
  );
  return { service, f };
}

async function codigo(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    return (r as { error?: string } | undefined)?.error ?? String(e);
  }
}

const dto = (extra: Partial<CreateCobroDto> = {}): CreateCobroDto => ({
  monto: 100,
  moneda: Moneda.USD,
  metodo_cobro: MetodoPago.TRANSFERENCIA,
  ...extra,
});

describe('FlightsService — candado MES_CERRADO de cobros', () => {
  it('cobro NUEVO en #318 (se quedó en septiembre cerrado) ⇒ 409 MES_CERRADO, sin insert', async () => {
    const { service, f } = armar();
    expect(await codigo(service.createCobro(V318, dto(), ALE))).toBe(
      'MES_CERRADO',
    );
    expect(f.escrituras.filter((e) => e.tabla === 'cobro_vuelo')).toHaveLength(
      0,
    );
  });

  it('el REPLAY de un cobro que ya existe va ANTES del candado: devuelve el existente', async () => {
    const { service } = armar();
    const r = (await service.createCobro(
      V318,
      dto({ client_request_id: 'llave-1' }),
      ALE,
    )) as { id: string; idempotente?: boolean };
    expect(r).toMatchObject({ id: 'c-318', idempotente: true });
  });

  it('cobro en #337 (DIFERIDO a octubre, abierto) ⇒ el candado de mes NO lo frena', async () => {
    const { service } = armar();
    expect(await codigo(service.createCobro(V337, dto(), ALE))).not.toBe(
      'MES_CERRADO',
    );
  });

  it('corregir el DINERO o borrar un cobro de #318 ⇒ 409; cambiar solo la referencia no', async () => {
    const { service } = armar();
    expect(
      await codigo(service.updateCobro('c-318', { monto: 900 }, ALE)),
    ).toBe('MES_CERRADO');
    expect(await codigo(service.deleteCobro('c-318', ALE))).toBe('MES_CERRADO');
    expect(
      await codigo(service.updateCobro('c-318', { referencia: 'SPEI 1' }, ALE)),
    ).not.toBe('MES_CERRADO');
  });
});
