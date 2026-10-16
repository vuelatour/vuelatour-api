// VARIAS FACTURAS POR GASTO (16-oct-2026, invariante 87): el detalle
// `GET /v1/expenses/:id` gana `facturas`, `facturas_avisos` y
// `facturas_multiples` SOLO para la oficina; la app (piloto/mecánico/
// visitante) recibe el gasto como siempre. Servicios stubbeados.
jest.mock('./expenses.service', () => ({ ExpensesService: class {} }));
jest.mock('./combustible-masivo.service', () => ({
  CombustibleMasivoService: class {},
}));

import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { ExpensesController } from './expenses.controller';
import type { ExpensesService } from './expenses.service';
import type { CombustibleMasivoService } from './combustible-masivo.service';

const G = '24b941d4-bc81-44d3-a388-a6bc17c05cdf';

function armar(extra: unknown) {
  const svc = {
    findById: jest.fn().mockResolvedValue({
      id: G,
      usuario_captura_id: 'u-piloto',
      factura_recibida_id: 'fr-A',
      verificado_por: 'x',
    }),
    facturasDelGasto: jest.fn().mockResolvedValue(extra),
  };
  const ctrl = new ExpensesController(
    svc as unknown as ExpensesService,
    {} as CombustibleMasivoService,
  );
  return { ctrl, svc };
}

const EXTRA = {
  facturas: [{ id: 'fr-A', principal: true }],
  facturas_avisos: [],
  facturas_multiples: true,
};

describe('GET /v1/expenses/:id — facturas del gasto', () => {
  it('ADMIN, COORDINADOR y FACTURACION reciben las llaves nuevas', async () => {
    for (const rol of [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION]) {
      const { ctrl } = armar(EXTRA);
      const r = await ctrl.getOne(G, { userId: 'u', rol } as AuthenticatedUser);
      expect(r).toMatchObject({ id: G, ...EXTRA });
    }
  });

  it('la app (piloto dueño de la captura) NO las recibe ni se consultan', async () => {
    const { ctrl, svc } = armar(EXTRA);
    const r = await ctrl.getOne(G, {
      userId: 'u-piloto',
      rol: Rol.PILOTO,
    } as AuthenticatedUser);
    expect(r).not.toHaveProperty('facturas');
    expect(r).not.toHaveProperty('verificado_por');
    expect(svc.facturasDelGasto).not.toHaveBeenCalled();
  });

  it('si la lectura de facturas falla (null) el detalle sale como antes', async () => {
    const { ctrl } = armar(null);
    const r = await ctrl.getOne(G, {
      userId: 'u',
      rol: Rol.ADMIN,
    } as AuthenticatedUser);
    expect(r).not.toHaveProperty('facturas');
    expect(r).toMatchObject({ id: G, factura_recibida_id: 'fr-A' });
  });
});
