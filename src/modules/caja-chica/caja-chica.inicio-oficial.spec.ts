// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): «Mi
// caja» de la app — SOLO las listas se recortan; el saldo y el corrido salen
// del libro COMPLETO.
import { CajaChicaService } from './caja-chica.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';

const FONDO = {
  id: 'f1',
  usuario_id: 'u1',
  moneda: 'MXN',
  activo: true,
  monto_fondo: 1000,
  es_acumulada: false,
};

const conFondo: Responder = (tabla, ops) =>
  tabla === 'caja_chica_fondo' && ops.some((o) => o.m === 'maybeSingle')
    ? { data: [FONDO], error: null }
    : undefined;

function armar(inicio: string | null) {
  const g = supabaseGrabador(conFondo);
  const svc = new CajaChicaService(
    g.supabase,
    undefined,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
}

describe('CajaChicaService.getMyFondo — inicio oficial', () => {
  it('listas con piso; las lecturas del SALDO sin piso', async () => {
    const a = armar(INICIO);
    await a.svc.getMyFondo('u1');
    const movs = a.de('caja_chica_movimiento');
    const recientes = movs.find((c) => a.lleva(c, 'limit', 20))!;
    const todos = movs.find((c) => !c.ops.some((o) => o.m === 'limit'))!;
    expect(a.lleva(recientes, 'gte', 'fecha', INICIO)).toBe(true);
    expect(todos.ops.some((o) => o.m === 'gte')).toBe(false);
    const gastos = a.de('gasto');
    const lista = gastos.find((c) => a.lleva(c, 'limit', 200))!;
    const saldo = gastos.find((c) => !c.ops.some((o) => o.m === 'limit'))!;
    expect(a.lleva(lista, 'gte', 'fecha_gasto', INICIO)).toBe(true);
    expect(saldo.ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('inicio null ⇒ ninguna lista con piso', async () => {
    const a = armar(null);
    await a.svc.getMyFondo('u1');
    for (const c of [...a.de('caja_chica_movimiento'), ...a.de('gasto')]) {
      expect(c.ops.some((o) => o.m === 'gte')).toBe(false);
    }
  });
});

describe('CajaChicaService.getMyHistorial — inicio oficial', () => {
  const historial = [
    {
      id: 'm-ago',
      origen: 'caja',
      tipo: 'REPOSICION',
      fecha: '2026-08-20',
      monto: 500,
      saldo: 500,
      por_reponer: 500,
    },
    {
      id: 'g-sep',
      origen: 'gasto',
      tipo: 'GASTO',
      fecha: '2026-09-05',
      monto: 100,
      saldo: 400,
      por_reponer: 600,
    },
  ];
  function conLibro(inicio: string | null) {
    const a = armar(inicio);
    Object.assign(a.svc as unknown as Record<string, unknown>, {
      cargarLibro: jest
        .fn()
        .mockResolvedValue({ movs: [], efectivo: [], historial }),
    });
    return a;
  }

  it('ventana sube al inicio; el corrido por fila es el del libro completo', async () => {
    const r = await conLibro(INICIO).svc.getMyHistorial('u1', {
      desde: '2026-07-01',
    } as never);
    expect(r.desde).toBe(INICIO);
    expect(r.movimientos.map((m) => m.id)).toEqual(['g-sep']);
    expect(r.movimientos[0].saldo_despues).toBe(400);
    expect(r.fondo?.saldo_libro).toBe(400);
  });

  it('rango entero anterior ⇒ vacío, sin 400', async () => {
    const r = await conLibro(INICIO).svc.getMyHistorial('u1', {
      desde: '2026-08-01',
      hasta: '2026-08-31',
    } as never);
    expect(r.movimientos).toEqual([]);
  });

  it('inicio null ⇒ el desde pedido (como 0.0.84)', async () => {
    const r = await conLibro(null).svc.getMyHistorial('u1', {
      desde: '2026-07-01',
    } as never);
    expect(r.desde).toBe('2026-07-01');
    expect(r.movimientos).toHaveLength(2);
  });
});
