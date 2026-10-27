// FECHA DEL VUELO EN LA LISTA DE GASTOS (19-oct-2026, API 0.0.96,
// invariante 94): el embed del vuelo de `GET /v1/expenses` trae
// `fecha_vuelo` además del folio, y la fila llega TAL CUAL (el panel la pinta
// bajo «Vuelo #375» en día Cancún).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));

import { ExpensesService } from './expenses.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { VisionService } from '../vision/vision.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import type { CajaChicaService } from '../caja-chica/caja-chica.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { ListGastosQuery } from './dto/expenses.dto';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

// Desde el 0.0.110 (invariante 110) el embed también trae `es_externo` y
// `operador_externo` (casilla «pago al operador externo» del panel).
const EMBED_VUELO =
  'vuelo:vuelo!vuelo_id(folio, fecha_vuelo, es_externo, operador_externo)';

function armar(responder?: Responder) {
  const g = supabaseGrabador(responder);
  const svc = new ExpensesService(
    g.supabase,
    {} as NotificationsService,
    {} as PyservicesService,
    {} as VisionService,
    cfgInicio(null) as unknown as ConfiguracionService,
    {} as CajaChicaService,
    {} as IaUsoService,
  );
  /** La consulta PRINCIPAL de la lista (la que pagina y cuenta). */
  const lista = () =>
    g.de('gasto').find((c) => c.ops.some((o) => o.m === 'range'))!;
  return { svc, lista, ...g };
}

const q = (over: Partial<ListGastosQuery> = {}): ListGastosQuery => ({
  limit: 50,
  offset: 0,
  ...over,
});

describe('GET /v1/expenses — fecha del vuelo en el embed (invariante 94)', () => {
  it('la consulta que pagina pide el folio Y la fecha del vuelo', async () => {
    const { svc, lista } = armar();
    await svc.list(q());
    const select = lista().ops.find((o) => o.m === 'select')!;
    expect(String(select.args[0])).toContain(EMBED_VUELO);
    // El embed viejo (solo el folio) ya no se pide.
    expect(String(select.args[0])).not.toContain('vuelo:vuelo!vuelo_id(folio)');
  });

  it('la fila llega con `vuelo.fecha_vuelo` tal cual (sin recalcular el día)', async () => {
    const fila = {
      id: '5e2a8a4e-6c1f-4a0e-9a3b-2f6d1c4e7b90',
      categoria: 'OPERACIONES',
      monto: '200.89',
      moneda: 'MXN',
      fecha_gasto: '2026-10-15',
      vuelo_id: '9b7c2d1e-3f4a-4b5c-8d6e-7f8091a2b3c4',
      conciliado: false,
      vuelo: { folio: 375, fecha_vuelo: '2026-10-14T15:00:00+00:00' },
    };
    const { svc } = armar((tabla, ops) =>
      tabla === 'gasto' && ops.some((o) => o.m === 'range')
        ? { data: [fila], error: null, count: 1 }
        : undefined,
    );
    const r = (await svc.list(q())) as {
      data: { vuelo?: { folio?: unknown; fecha_vuelo?: unknown } | null }[];
    };
    expect(r.data).toHaveLength(1);
    expect(r.data[0].vuelo).toEqual({
      folio: 375,
      fecha_vuelo: '2026-10-14T15:00:00+00:00',
    });
  });
});
