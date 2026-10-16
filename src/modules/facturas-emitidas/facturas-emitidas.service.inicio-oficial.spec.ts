// INICIO OFICIAL (16-oct-2026, invariante 86): lista/Excel por
// `fecha_emision`, «Por facturar» y su conteo por `fecha_vuelo`;
// `vuelos-candidatos` sin piso.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));

import { FacturasEmitidasService } from './facturas-emitidas.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const PISO = 'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00';

type Priv = {
  filtrosDe(q: object, inicio: string | null): { desde?: string };
  vuelosConSolicitud<T>(cols: string, inicio?: string | null): Promise<T[]>;
};

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const solicitud = {
    ligadasDeVuelos: jest.fn().mockResolvedValue(new Map()),
    exigenciasDeAutomaticas: jest.fn().mockResolvedValue(new Map()),
  };
  const svc = new FacturasEmitidasService(
    g.supabase,
    {} as never,
    solicitud as never,
    {} as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, priv: svc as unknown as Priv, ...g };
}

describe('FacturasEmitidasService — inicio oficial', () => {
  it('filtros de lista y Excel: el desde sube al inicio', () => {
    const { priv } = armar(INICIO);
    expect(priv.filtrosDe({}, INICIO).desde).toBe(INICIO);
    expect(priv.filtrosDe({ desde: '2026-08-01' }, INICIO).desde).toBe(INICIO);
    expect(priv.filtrosDe({ desde: '2026-09-20' }, INICIO).desde).toBe(
      '2026-09-20',
    );
    expect(priv.filtrosDe({}, null).desde).toBeUndefined();
  });

  it('con vuelo_id NO hay piso (facturas de UN vuelo abierto por id)', () => {
    const { priv } = armar(INICIO);
    expect(priv.filtrosDe({ vuelo_id: 'v-201' }, INICIO).desde).toBeUndefined();
    expect(
      priv.filtrosDe({ vuelo_id: 'v-201', desde: '2026-08-01' }, INICIO).desde,
    ).toBe('2026-08-01');
  });

  it('vuelos con solicitud: con inicio lleva el or; sin él (candidatos) no', async () => {
    const { priv, de, lleva } = armar(INICIO);
    await priv.vuelosConSolicitud('id', INICIO);
    await priv.vuelosConSolicitud('id');
    const [conPiso, sinPiso] = de('vuelo');
    expect(lleva(conPiso, 'or', PISO)).toBe(true);
    expect(sinPiso.ops.some((o) => o.m === 'or')).toBe(false);
  });

  it('conteo del badge y bandeja «Por facturar» pasan el inicio', async () => {
    const { svc, de, lleva } = armar(INICIO);
    await svc.conteoPorFacturar().catch(() => undefined);
    await svc.porFacturar().catch(() => undefined);
    const vuelos = de('vuelo').filter((c) =>
      c.ops.some((o) => o.m === 'not' && o.args[0] === 'factura_solicitada_at'),
    );
    expect(vuelos.length).toBeGreaterThanOrEqual(2);
    for (const c of vuelos) expect(lleva(c, 'or', PISO)).toBe(true);
  });
});
