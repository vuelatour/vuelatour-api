// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86):
// bitácora de eventos de motor y hélice desde el inicio. Las horas de vida
// (ficha + tacómetro) no salen de esta lista.
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));

import { EnginesService } from './engines.service';
import { PropellersService } from '../propellers/propellers.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

describe('Bitácora de componentes — inicio oficial', () => {
  it.each([
    ['motor', EnginesService],
    ['hélice', PropellersService],
  ] as const)('%s: fecha ≥ inicio; null ⇒ sin piso', async (_n, Clase) => {
    const g = supabaseGrabador();
    const svc = new Clase(
      g.supabase,
      {} as never,
      cfgInicio('2026-09-01') as unknown as ConfiguracionService,
    );
    await svc.listEventos('x1');
    expect(
      g.lleva(g.de('componente_evento')[0], 'gte', 'fecha', '2026-09-01'),
    ).toBe(true);
    const h = supabaseGrabador();
    const sin = new Clase(h.supabase, {} as never);
    await sin.listEventos('x1');
    expect(h.de('componente_evento')[0].ops.some((o) => o.m === 'gte')).toBe(
      false,
    );
  });
});
