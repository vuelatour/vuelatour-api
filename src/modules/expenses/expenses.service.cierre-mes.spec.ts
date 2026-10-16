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
 * CIERRE DE MES — candado de GASTOS (16-oct-2026, invariante 89). Septiembre
 * 2026 CERRADO por Ale; #318 se quedó en septiembre y #337 se DIFIRIÓ a
 * octubre. El mes que decide es el CONTABLE del gasto (eje de la invariante
 * 72): eje vuelo ⇒ el del vuelo; eje gasto ⇒ `fecha_gasto`.
 */

const ALE = 'u-ale';
const V318 = 'v-318';
const V337 = 'v-337';

const gasto = (id: string, extra: Fila): Fila => ({
  id,
  categoria: 'OTRO',
  monto: 100,
  propina: 0,
  moneda: 'MXN',
  tc_gasto: null,
  fecha_gasto: '2026-09-20',
  medio_pago: 'TRANSFERENCIA',
  vuelo_id: null,
  escala_id: null,
  aeronave_id: null,
  conciliado: false,
  compra_id: null,
  notas: null,
  updated_at: '2026-09-20T17:00:00Z',
  usuario_captura_id: ALE,
  ...extra,
});

function mundo(): Record<string, Fila[]> {
  return {
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
      {
        id: V337,
        folio: 337,
        fecha_vuelo: '2026-09-25T15:00:00Z',
        periodo_contable: '2026-10-01T00:00:00-05:00',
        aeronave_id: 'av-1',
        es_externo: false,
      },
    ],
    gasto: [
      gasto('g-sep', {}),
      gasto('g-318', {
        categoria: 'OPERACIONES',
        vuelo_id: V318,
        aeronave_id: 'av-1',
      }),
      gasto('g-337', {
        categoria: 'OPERACIONES',
        vuelo_id: V337,
        aeronave_id: 'av-1',
        fecha_gasto: '2026-09-28',
      }),
    ],
  };
}

function armar() {
  const f = fakeCierre(mundo());
  const nada = {} as never;
  const service = new ExpensesService(
    f.supabase as unknown as SupabaseService,
    { notifyRole: jest.fn(), notifyUser: jest.fn() } as never,
    nada,
    nada,
    { numero: jest.fn().mockResolvedValue(1) } as never,
    { fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null) } as never,
    nada,
    {
      intentarCruzarGasto: jest.fn().mockResolvedValue({ ligado: false }),
    } as never,
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

describe('ExpensesService — candado MES_CERRADO', () => {
  it('PATCH del MONTO de un gasto sin vuelo del 20-sep ⇒ 409 MES_CERRADO y no escribe', async () => {
    const { service, f } = armar();
    expect(
      await codigo(service.update('g-sep', { monto: 200 }, ALE, Rol.ADMIN)),
    ).toBe('MES_CERRADO');
    expect(escrituras(f, 'g-sep')).toHaveLength(0);
  });

  it('PATCH de solo NOTAS (clasificación) ⇒ pasa', async () => {
    const { service, f } = armar();
    await service.update('g-sep', { notas: 'papelería' }, ALE, Rol.ADMIN);
    expect(escrituras(f, 'g-sep')).toHaveLength(1);
  });

  it('mover un gasto de octubre HACIA septiembre ⇒ 409 (el estado de DESPUÉS también cuenta)', async () => {
    const { service, f } = armar();
    f.tablas.gasto.push(gasto('g-oct', { fecha_gasto: '2026-10-05' }));
    expect(
      await codigo(
        service.update('g-oct', { fecha_gasto: '2026-09-29' }, ALE, Rol.ADMIN),
      ),
    ).toBe('MES_CERRADO');
  });

  it('gasto de #318 (se quedó en septiembre) ⇒ 409; de #337 (diferido a octubre) ⇒ pasa', async () => {
    const { service, f } = armar();
    expect(
      await codigo(service.update('g-318', { monto: 300 }, ALE, Rol.ADMIN)),
    ).toBe('MES_CERRADO');
    await service.update('g-337', { monto: 300 }, ALE, Rol.ADMIN);
    expect(escrituras(f, 'g-337')).toHaveLength(1);
  });

  it('BAJA de un gasto del mes cerrado ⇒ 409 MES_CERRADO', async () => {
    const { service } = armar();
    expect(await codigo(service.remove('g-sep', ALE, Rol.ADMIN))).toBe(
      'MES_CERRADO',
    );
  });
});

describe('REVISIÓN 16-oct-2026 — gastos de PISTA (INSERT directo)', () => {
  function conEscalas() {
    const t = mundo();
    t.escala = [
      {
        id: 'e-318',
        vuelo_id: V318,
        destino_iata: 'MID',
        hora_llegada: '2026-09-20T17:00:00Z',
        fecha_salida_plan: null,
        aeronave_id: 'av-1',
        vuelo: { aeronave_id: 'av-1' },
      },
      {
        id: 'e-337',
        vuelo_id: V337,
        destino_iata: 'MID',
        hora_llegada: '2026-09-25T17:00:00Z',
        fecha_salida_plan: null,
        aeronave_id: 'av-1',
        vuelo: { aeronave_id: 'av-1' },
      },
    ];
    t.proveedor = [];
    const f = fakeCierre(t);
    const nada = {} as never;
    const service = new ExpensesService(
      f.supabase as unknown as SupabaseService,
      { notifyRole: jest.fn(), notifyUser: jest.fn() } as never,
      nada,
      nada,
      { numero: jest.fn().mockResolvedValue(1) } as never,
      { fechaUltimaReposicionDe: jest.fn().mockResolvedValue(null) } as never,
      nada,
      {
        intentarCruzarGasto: jest.fn().mockResolvedValue({ ligado: false }),
      } as never,
    );
    return { service, f };
  }

  it('la pista de #318 (septiembre cerrado) NO se crea y el renglón dice por qué; la de #337 (diferido a octubre) pasa el candado', async () => {
    const { service, f } = conEscalas();
    const r = await service.generarPistas(
      {
        items: [
          { escala_id: 'e-318', monto: 500, categoria: 'ATERRIZAJE' },
          { escala_id: 'e-337', monto: 500, categoria: 'ATERRIZAJE' },
        ],
      } as never,
      ALE,
    );
    const r318 = r.resultados.find((x) => x.escala_id === 'e-318');
    expect(r318).toMatchObject({ ok: false });
    expect(r318?.error).toContain('Septiembre 2026 ya está cerrado');
    const insertados = f.escrituras.filter(
      (e) => e.tabla === 'gasto' && e.op === 'insert',
    );
    expect(insertados.map((e) => e.valores.escala_id)).toEqual(['e-337']);
  });
});
