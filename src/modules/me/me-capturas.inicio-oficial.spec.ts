// GASTOS «POR PAGAR» (19-oct-2026, invariante 93): este spec congela la
// conducta SIN la migración 20261019000001 (0.0.94: ninguna consulta nombra
// `gasto.por_pagar`); la conducta con ella vive en los `*.por-pagar.spec.ts`.
jest.mock('../../common/por-pagar-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/por-pagar-disponible.util',
  ),
  porPagarDisponible: jest.fn(() => Promise.resolve(false)),
}));
// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): el
// historial de capturas de la app (`GET /me/capturas`) no muestra nada
// anterior al inicio: captura ≥ corte Y ticket/cobro ≥ inicio.
import { MeCapturasService } from './me-capturas.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const CORTE = '2026-09-01T00:00:00-05:00';

function armar(inicio: string | null, responder?: Responder) {
  const g = supabaseGrabador(responder);
  const svc = new MeCapturasService(
    g.supabase,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

/** Un ticket de agosto capturado en septiembre + uno de septiembre. */
const gastos: Responder = (tabla) =>
  tabla === 'gasto'
    ? {
        data: [
          {
            id: 'g-sep',
            categoria: 'OPERACIONES',
            monto: 10,
            moneda: 'MXN',
            created_at: '2026-09-10T15:00:00Z',
            fecha_gasto: '2026-09-10',
          },
          {
            id: 'g-ago',
            categoria: 'OPERACIONES',
            monto: 20,
            moneda: 'MXN',
            created_at: '2026-09-05T15:00:00Z',
            fecha_gasto: '2026-08-28',
          },
        ],
        error: null,
      }
    : undefined;

describe('MeCapturasService — inicio oficial', () => {
  it('sin desde ⇒ corte del inicio en las 5 fuentes + ticket y cobro ≥ inicio', async () => {
    const a = armar(INICIO);
    await a.svc.capturas('u1', { limit: 60, offset: 0 });
    expect(a.lleva(a.de('gasto')[0], 'gte', 'created_at', CORTE)).toBe(true);
    expect(a.lleva(a.de('gasto')[0], 'gte', 'fecha_gasto', INICIO)).toBe(true);
    expect(a.lleva(a.de('cobro_vuelo')[0], 'gte', 'fecha_cobro', CORTE)).toBe(
      true,
    );
    expect(a.lleva(a.de('escala')[0], 'gte', 'updated_at', CORTE)).toBe(true);
    expect(a.lleva(a.de('mantenimiento')[0], 'gte', 'created_at', CORTE)).toBe(
      true,
    );
    expect(a.lleva(a.de('vuelo')[0], 'gte', 'created_at', CORTE)).toBe(true);
  });

  it('desde explícito anterior sube; posterior se respeta', async () => {
    const a = armar(INICIO);
    await a.svc.capturas('u1', {
      limit: 60,
      offset: 0,
      desde: '2026-08-15',
    });
    expect(a.lleva(a.de('gasto')[0], 'gte', 'created_at', CORTE)).toBe(true);
    const b = armar(INICIO);
    await b.svc.capturas('u1', {
      limit: 60,
      offset: 0,
      desde: '2026-10-01',
    });
    expect(
      b.lleva(
        b.de('gasto')[0],
        'gte',
        'created_at',
        '2026-10-01T00:00:00-05:00',
      ),
    ).toBe(true);
  });

  it('un ítem cuyo día (ticket) es anterior al inicio no sale aunque se capturó después', async () => {
    const a = armar(INICIO, gastos);
    const r = await a.svc.capturas('u1', { limit: 60, offset: 0 });
    expect(r.data.map((i) => i.id)).toEqual(['g-sep']);
  });

  it('inicio null ⇒ sin piso y ambos ítems (como 0.0.84)', async () => {
    const a = armar(null, gastos);
    const r = await a.svc.capturas('u1', { limit: 60, offset: 0 });
    expect(r.data.map((i) => i.id)).toEqual(['g-sep', 'g-ago']);
    expect(a.de('gasto')[0].ops.some((o) => o.m === 'gte')).toBe(false);
  });
});
