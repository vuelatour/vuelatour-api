// LA CAJA CHICA SE VE COMPLETA (19-nov-2026, API 0.0.146, invariante 141).
// Del 16-oct al 19-nov (0.0.85, invariante 86) «Mi caja» recortaba sus
// LISTAS al inicio oficial (1-sep-2026) mientras el saldo salía del libro
// completo. Reporte de la oficina: «había registrado unos gastos de taxi y
// ahorita ya no están; ahora me marca que tengo más dinero». Los taxis eran
// de agosto y su reposición de septiembre: la lista enseñaba la reposición
// sin los gastos que reponía. Aquí se congela que el inicio oficial YA NO
// recorta nada de la caja, aunque esté configurado.
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

describe('CajaChicaService.getMyFondo — sin piso del inicio oficial', () => {
  it.each([INICIO, null])(
    'inicio %s ⇒ ni las listas ni el saldo llevan condición de fecha',
    async (inicio) => {
      const a = armar(inicio);
      await a.svc.getMyFondo('u1');
      // Movimientos recientes, todos los movimientos (saldo), gastos del
      // saldo y la lista visible de gastos (más la sonda de «por pagar»).
      const consultas = [...a.de('caja_chica_movimiento'), ...a.de('gasto')];
      expect(consultas.length).toBeGreaterThanOrEqual(4);
      for (const c of consultas) {
        expect(c.ops.some((o) => o.m === 'gte')).toBe(false);
      }
      // Las listas siguen topadas (20 movimientos, 200 gastos), no recortadas.
      expect(
        a.de('caja_chica_movimiento').some((c) => a.lleva(c, 'limit', 20)),
      ).toBe(true);
      expect(a.de('gasto').some((c) => a.lleva(c, 'limit', 200))).toBe(true);
    },
  );
});

describe('CajaChicaService.getMyHistorial — sin piso del inicio oficial', () => {
  // La caja real del reporte: fondo de $1,000 (4-ago), gastos de agosto por
  // $1,070, reposición de $1,070 (21-sep) y dos gastos después.
  const historial = [
    {
      id: 'm-fondo',
      origen: 'caja',
      tipo: 'REPOSICION',
      fecha: '2026-08-04',
      monto: 1000,
      saldo: 1000,
      por_reponer: 0,
    },
    {
      id: 'g-taxi-ago',
      origen: 'gasto',
      tipo: 'GASTO',
      fecha: '2026-08-06',
      monto: -700,
      saldo: 300,
      por_reponer: 700,
    },
    {
      id: 'g-uber-ago',
      origen: 'gasto',
      tipo: 'GASTO',
      fecha: '2026-08-24',
      monto: -370,
      saldo: -70,
      por_reponer: 1070,
    },
    {
      id: 'm-reposicion-sep',
      origen: 'caja',
      tipo: 'REPOSICION',
      fecha: '2026-09-21',
      monto: 1070,
      saldo: 1000,
      por_reponer: 0,
    },
    {
      id: 'g-internet-sep',
      origen: 'gasto',
      tipo: 'GASTO',
      fecha: '2026-09-29',
      monto: -75,
      saldo: 925,
      por_reponer: 75,
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

  it('con inicio oficial configurado: la ventana es la PEDIDA y salen los gastos de agosto', async () => {
    const r = await conLibro(INICIO).svc.getMyHistorial('u1', {
      desde: '2026-07-01',
    } as never);
    expect(r.desde).toBe('2026-07-01');
    // Recientes primero; la reposición de septiembre viene CON los gastos de
    // agosto que repone y con el fondo inicial.
    expect(r.movimientos.map((m) => m.id)).toEqual([
      'g-internet-sep',
      'm-reposicion-sep',
      'g-uber-ago',
      'g-taxi-ago',
      'm-fondo',
    ]);
    expect(r.count).toBe(5);
  });

  it('el corrido por fila es el del libro (no cambia por quitar el piso)', async () => {
    const r = await conLibro(INICIO).svc.getMyHistorial('u1', {
      desde: '2026-07-01',
    } as never);
    const saldo = Object.fromEntries(
      r.movimientos.map((m) => [m.id, m.saldo_despues]),
    );
    expect(saldo).toEqual({
      'm-fondo': 1000,
      'g-taxi-ago': 300,
      'g-uber-ago': -70,
      'm-reposicion-sep': 1000,
      'g-internet-sep': 925,
    });
    expect(r.fondo?.saldo_libro).toBe(925);
  });

  it('un rango entero ANTERIOR al inicio devuelve sus filas (antes salía vacío)', async () => {
    const r = await conLibro(INICIO).svc.getMyHistorial('u1', {
      desde: '2026-08-01',
      hasta: '2026-08-31',
    } as never);
    expect(r.movimientos.map((m) => m.id)).toEqual([
      'g-uber-ago',
      'g-taxi-ago',
      'm-fondo',
    ]);
  });

  it('con y sin inicio oficial la respuesta es la MISMA', async () => {
    const q = { desde: '2026-07-01' } as never;
    const con = await conLibro(INICIO).svc.getMyHistorial('u1', q);
    const sin = await conLibro(null).svc.getMyHistorial('u1', q);
    expect(con).toEqual(sin);
  });
});
