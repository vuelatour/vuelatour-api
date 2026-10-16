// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/reparto-cuenta.service', () => ({
  RepartoCuentaService: class {},
}));

import type { SupabaseService } from '../supabase/supabase.service';
import { CajaChicaService } from '../caja-chica/caja-chica.service';
import { IngresosService } from '../ingresos/ingresos.service';
import { RepartoPagoService } from '../profit-sharing/reparto-pago.service';
import { Rol } from '../../common/types/auth.types';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * CIERRE DE MES — candado 409 MES_CERRADO en caja chica, ingresos y
 * entregas a socios (16-oct-2026, invariante 89). Septiembre 2026 CERRADO.
 * Cada registro se evalúa por SU fecha (movimiento, ingreso, entrega).
 */

const ALE = 'u-ale';
const FONDO = 'f-1';

function mundo(): Record<string, Fila[]> {
  return {
    usuario: [{ id: ALE, nombre: 'Ale Martínez', estado: 'ACTIVO' }],
    cierre_mes: [
      {
        periodo: '2026-09-01',
        estado: 'CERRADO',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: ALE,
        version: 1,
      },
    ],
    caja_chica_fondo: [{ id: FONDO, moneda: 'MXN', usuario_id: ALE }],
    caja_chica_movimiento: [
      {
        id: 'm-sep',
        fondo_id: FONDO,
        tipo: 'REPOSICION',
        monto: 1000,
        moneda: 'MXN',
        fecha: '2026-09-20',
        espejo_de_id: null,
      },
    ],
    ingreso: [],
    reparto_pago: [],
  };
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

describe('Caja chica', () => {
  const armar = () => {
    const f = fakeCierre(mundo());
    return {
      f,
      svc: new CajaChicaService(f.supabase as unknown as SupabaseService),
    };
  };

  it('movimiento con fecha en septiembre cerrado ⇒ 409 MES_CERRADO sin insertar; en octubre ⇒ pasa el candado', async () => {
    const { f, svc } = armar();
    expect(
      await codigo(
        svc.createMovimiento(
          FONDO,
          { tipo: 'REPOSICION', monto: 500, fecha: '2026-09-30' } as never,
          ALE,
        ),
      ),
    ).toBe('MES_CERRADO');
    expect(
      f.escrituras.filter((e) => e.tabla === 'caja_chica_movimiento'),
    ).toHaveLength(0);
    expect(
      await codigo(
        svc.createMovimiento(
          FONDO,
          { tipo: 'REPOSICION', monto: 500, fecha: '2026-10-02' } as never,
          ALE,
        ),
      ),
    ).not.toBe('MES_CERRADO');
  });

  it('corregir el monto o borrar un movimiento de septiembre ⇒ 409', async () => {
    const { svc } = armar();
    expect(
      await codigo(svc.updateMovimiento('m-sep', { monto: 900 }, ALE)),
    ).toBe('MES_CERRADO');
    expect(await codigo(svc.removeMovimiento('m-sep'))).toBe('MES_CERRADO');
  });
});

describe('Ingresos', () => {
  it('alta con fecha de septiembre ⇒ 409 MES_CERRADO (después del replay); octubre ⇒ no es el candado', async () => {
    const f = fakeCierre(mundo());
    const svc = new IngresosService(
      f.supabase as unknown as SupabaseService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const datos = (fecha: string) =>
      JSON.stringify({
        categoria: 'OTRO_INGRESO',
        fecha,
        descripcion: 'Renta de hangar',
        monto: 5000,
        moneda: 'MXN',
        metodo: 'TRANSFERENCIA',
      });
    const actor = { userId: ALE, rol: Rol.ADMIN };
    expect(
      await codigo(svc.crear(datos('2026-09-15'), undefined, actor as never)),
    ).toBe('MES_CERRADO');
    expect(f.escrituras.filter((e) => e.tabla === 'ingreso')).toHaveLength(0);
    expect(
      await codigo(svc.crear(datos('2026-10-15'), undefined, actor as never)),
    ).not.toBe('MES_CERRADO');
  });
});

describe('Entregas a socios', () => {
  it('entrega fechada en septiembre cerrado ⇒ 409 MES_CERRADO antes de calcular utilidades', async () => {
    const f = fakeCierre(mundo());
    const contextoSocio = jest.fn();
    const cuentas = {
      assertDisponible: () => Promise.resolve(),
      hoy: () => '2026-10-16',
      ahora: () => new Date('2026-10-16T17:00:00Z'),
      contextoSocio,
      lector: {},
    };
    const svc = new RepartoPagoService(
      f.supabase as unknown as SupabaseService,
      cuentas as never,
    );
    expect(
      await codigo(
        svc.crear(
          {
            socio_id: 's-1',
            monto: 1000,
            moneda: 'USD',
            fecha_pago: '2026-09-30',
            metodo: 'TRANSFERENCIA',
          } as never,
          { userId: ALE, rol: Rol.ADMIN },
        ),
      ),
    ).toBe('MES_CERRADO');
    expect(contextoSocio).not.toHaveBeenCalled();
    expect(f.escrituras).toHaveLength(0);
  });
});
