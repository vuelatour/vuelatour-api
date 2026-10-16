// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86):
// historial de mantenimientos — se ocultan los COMPLETADOS anteriores al
// inicio (prod: 9); los abiertos de cualquier fecha se quedan.
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));

import { EngineeringService } from './engineering.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const MANTS = [
  {
    id: 'm-ago',
    estado: 'COMPLETADO',
    fecha_realizada: '2026-08-10',
    fecha_programada: '2026-08-01',
  },
  {
    id: 'm-ago-sin-real',
    estado: 'COMPLETADO',
    fecha_realizada: null,
    fecha_programada: '2026-07-15',
  },
  {
    id: 'm-sin-fechas',
    estado: 'COMPLETADO',
    fecha_realizada: null,
    fecha_programada: null,
  },
  {
    id: 'm-sep',
    estado: 'COMPLETADO',
    fecha_realizada: '2026-09-05',
    fecha_programada: '2026-08-30',
  },
  {
    id: 'm-abierto-viejo',
    estado: 'PROGRAMADO',
    fecha_realizada: null,
    fecha_programada: '2026-07-01',
  },
  {
    id: 'm-taller',
    estado: 'EN_TALLER',
    fecha_realizada: '2026-08-20',
    fecha_programada: null,
  },
];

const armar = (inicio: string | null) => {
  const g = supabaseGrabador((tabla) =>
    tabla === 'mantenimiento' ? { data: MANTS, error: null } : undefined,
  );
  const svc = new EngineeringService(
    g.supabase,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, ...g };
};

describe('EngineeringService.listMantenimientos — inicio oficial', () => {
  it('oculta COMPLETADOS anteriores; abiertos y sin fecha se quedan', async () => {
    const r = (await armar('2026-09-01').svc.listMantenimientos(
      'a1',
    )) as Array<{
      id: string;
    }>;
    expect(r.map((m) => m.id)).toEqual([
      'm-sin-fechas',
      'm-sep',
      'm-abierto-viejo',
      'm-taller',
    ]);
  });

  it('inicio null ⇒ todos (como 0.0.84)', async () => {
    const r = await armar(null).svc.listMantenimientos('a1');
    expect(r).toHaveLength(6);
  });
});
