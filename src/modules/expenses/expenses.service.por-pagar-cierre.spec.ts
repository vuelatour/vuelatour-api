// Módulos pesados que expenses.service importa solo para inyección.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { ExpensesService } from './expenses.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { Rol } from '../../common/types/auth.types';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * GASTOS POR PAGAR × CIERRE DE MES (acuerdo del 19-oct-2026 entre repos,
 * revisión adversaria del lote 0.0.95): «marcar pagado» que NO cambia la
 * `fecha_gasto` (solo `por_pagar` true ⇒ false) no mueve ningún libro y ya no
 * pasa por el candado MES_CERRADO. Re-programar (`por_pagar: true`) sí; un
 * cambio de fecha entra por `fecha_gasto` como siempre; eliminar sigue con
 * candado.
 *
 * BD en memoria CON las migraciones del cierre (20261016000004) y de los
 * por pagar (20261019000001): septiembre 2026 CERRADO; el vuelo #318 es de
 * septiembre. Reloj: lunes 19-oct-2026 10:00 Cancún.
 */

const ALE = 'u-ale';
const V318 = 'v-318';

const gasto = (id: string, extra: Fila): Fila => ({
  id,
  categoria: 'OTRO',
  monto: 100,
  propina: 0,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-09-25',
  medio_pago: 'EFECTIVO',
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  conciliado: false,
  por_pagar: false,
  compra_id: null,
  notas: null,
  fecha_hora_carga: null,
  usuario_captura_id: ALE,
  created_at: '2026-09-20T17:00:00Z',
  updated_at: '2026-09-20T17:00:00Z',
  ...extra,
});

function armar() {
  const f = fakeCierre({
    usuario: [{ id: ALE, nombre: 'Ale Martínez', rol: 'ADMIN' }],
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
      {
        id: V318,
        folio: 318,
        fecha_vuelo: '2026-09-20T15:00:00Z',
        periodo_contable: null,
        aeronave_id: 'av-1',
        es_externo: false,
      },
    ],
    gasto: [
      // Eje GASTO: vencido del 25-sep (mes cerrado) que nunca se marcó.
      gasto('g-sep-pp', { por_pagar: true }),
      gasto('g-sep-pagado', { fecha_gasto: '2026-09-20' }),
      // Eje VUELO: el vuelo #318 es de septiembre (cerrado) aunque el gasto
      // se fechó en octubre (el caso P1 de la revisión).
      gasto('g-318-pp', {
        categoria: 'OPERACIONES',
        vuelo_id: V318,
        aeronave_id: 'av-1',
        medio_pago: 'TRANSFERENCIA',
        fecha_gasto: '2026-10-15',
        por_pagar: true,
      }),
      gasto('g-oct-pp', { por_pagar: true, fecha_gasto: '2026-10-25' }),
    ],
  });
  const nada = {} as never;
  const service = new ExpensesService(
    f.supabase as unknown as SupabaseService,
    { notifyRole: jest.fn(), notifyUser: jest.fn() } as never,
    nada,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    { fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null) } as never,
    nada,
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

const escrituras = (f: ReturnType<typeof fakeCierre>, id: string) =>
  f.escrituras.filter((e) => e.tabla === 'gasto' && e.valores.id === id);

beforeEach(() =>
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date('2026-10-19T15:00:00Z'),
  }),
);
afterEach(() => jest.useRealTimers());

describe('Por pagar × MES_CERRADO — marcar pagado SIN cambiar la fecha', () => {
  it('eje GASTO: el vencido del 25-sep (cerrado) se marca pagado con SU fecha ⇒ solo baja la bandera', async () => {
    const { service, f } = armar();
    const r = (await service.update(
      'g-sep-pp',
      { por_pagar: false },
      ALE,
      Rol.ADMIN,
    )) as Fila;
    const [w] = escrituras(f, 'g-sep-pp');
    expect(w.valores.por_pagar).toBe(false);
    expect('fecha_gasto' in w.valores).toBe(false);
    expect(r.estado_pago).toBe('PAGADO');
  });

  it('eje VUELO: el gasto del #318 (septiembre cerrado) fechado en octubre ⇒ también pasa con su fecha', async () => {
    const { service, f } = armar();
    await service.update(
      'g-318-pp',
      { por_pagar: false, fecha_gasto: '2026-10-15' },
      ALE,
      Rol.ADMIN,
    );
    const [w] = escrituras(f, 'g-318-pp');
    expect(w.valores.por_pagar).toBe(false);
    expect('fecha_gasto' in w.valores).toBe(false);
  });
});

describe('Por pagar × MES_CERRADO — lo que SIGUE con candado', () => {
  it('marcar pagado CAMBIANDO la fecha ⇒ 409 MES_CERRADO (el estado de antes cuenta en septiembre)', async () => {
    const { service, f } = armar();
    expect(
      await codigo(
        service.update(
          'g-sep-pp',
          { por_pagar: false, fecha_gasto: '2026-10-19' },
          ALE,
          Rol.ADMIN,
        ),
      ),
    ).toBe('MES_CERRADO');
    expect(
      await codigo(
        service.update(
          'g-318-pp',
          { por_pagar: false, fecha_gasto: '2026-10-19' },
          ALE,
          Rol.ADMIN,
        ),
      ),
    ).toBe('MES_CERRADO');
    expect(escrituras(f, 'g-sep-pp')).toHaveLength(0);
    expect(escrituras(f, 'g-318-pp')).toHaveLength(0);
  });

  it('re-programar (`por_pagar: true`) un pagado de septiembre ⇒ 409 MES_CERRADO', async () => {
    const { service, f } = armar();
    expect(
      await codigo(
        service.update('g-sep-pagado', { por_pagar: true }, ALE, Rol.ADMIN),
      ),
    ).toBe('MES_CERRADO');
    expect(escrituras(f, 'g-sep-pagado')).toHaveLength(0);
  });

  it('eliminar un por pagar de septiembre ⇒ 409 MES_CERRADO', async () => {
    const { service } = armar();
    expect(await codigo(service.remove('g-sep-pp', ALE, Rol.ADMIN))).toBe(
      'MES_CERRADO',
    );
  });

  it('CONTROL: un por pagar de octubre (abierto) se marca pagado con la fecha de hoy', async () => {
    const { service, f } = armar();
    await service.update('g-oct-pp', { por_pagar: false }, ALE, Rol.ADMIN);
    expect(escrituras(f, 'g-oct-pp')[0].valores).toMatchObject({
      por_pagar: false,
      fecha_gasto: '2026-10-19',
    });
  });
});
