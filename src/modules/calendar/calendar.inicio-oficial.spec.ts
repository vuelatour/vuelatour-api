// INICIO OFICIAL (auditoría 16-oct-2026, API 0.0.85, invariante 86): la
// agenda (app y panel) no arranca antes del inicio: `from = max(from,
// corte)`; un rango entero anterior no devuelve eventos.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('./calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));

import { CalendarService } from './calendar.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
  type Responder,
} from '../../common/inicio-oficial.fixture-spec';

const CORTE_ISO = new Date('2026-09-01T00:00:00-05:00').toISOString();

function armar(inicio: string | null, responder?: Responder) {
  const g = supabaseGrabador(responder);
  const svc = new CalendarService(
    g.supabase,
    {} as never,
    {} as never,
    {
      contarDispositivosPorUsuario: jest.fn().mockResolvedValue(new Map()),
    } as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  // Sondas de columnas opcionales: fuera del alcance de este spec.
  Object.assign(svc as unknown as Record<string, unknown>, {
    conClientRequestDescanso: jest.fn().mockResolvedValue(false),
    eventoCols: jest.fn().mockResolvedValue('id'),
  });
  return { svc, ...g };
}

/** Un descanso del 30-ago al 2-sep (cruza el corte). */
const descansoCruzado: Responder = (tabla) =>
  tabla === 'piloto_descanso'
    ? {
        data: [
          {
            id: 'd1',
            piloto_id: 'p1',
            fecha_inicio: '2026-08-30',
            fecha_fin: '2026-09-02',
            motivo: null,
            piloto: { nombre: 'Ana' },
          },
        ],
        error: null,
      }
    : undefined;

describe('CalendarService.listEvents — inicio oficial', () => {
  it('from anterior ⇒ sube al corte (consultas y respuesta)', async () => {
    const a = armar('2026-09-01');
    const r = await a.svc.listEvents({
      from: new Date('2026-08-01T05:00:00Z'),
      to: new Date('2026-09-30T05:00:00Z'),
    });
    expect(r.from).toBe(CORTE_ISO);
    expect(a.lleva(a.de('vuelo')[0], 'gte', 'fecha_fin', CORTE_ISO)).toBe(true);
    expect(
      a.lleva(a.de('piloto_descanso')[0], 'gte', 'fecha_fin', '2026-09-01'),
    ).toBe(true);
  });

  it('descanso que cruza el corte: solo pinta los días desde el inicio', async () => {
    const a = armar('2026-09-01', descansoCruzado);
    const r = await a.svc.listEvents({
      from: new Date('2026-08-25T05:00:00Z'),
      to: new Date('2026-09-10T05:00:00Z'),
    });
    const dias = r.events.map((e) => (e as { id: string }).id);
    expect(dias).toEqual(['descanso:d1:2026-09-01', 'descanso:d1:2026-09-02']);
  });

  it('rango entero anterior ⇒ 0 eventos (sin 400)', async () => {
    const a = armar('2026-09-01', descansoCruzado);
    const r = await a.svc.listEvents({
      from: new Date('2026-08-01T05:00:00Z'),
      to: new Date('2026-08-31T05:00:00Z'),
    });
    expect(r.count).toBe(0);
  });

  it('inicio null ⇒ el from pedido (como 0.0.84)', async () => {
    const a = armar(null, descansoCruzado);
    const from = new Date('2026-08-25T05:00:00Z');
    const r = await a.svc.listEvents({
      from,
      to: new Date('2026-09-10T05:00:00Z'),
    });
    expect(r.from).toBe(from.toISOString());
    expect(r.count).toBe(4);
  });
});
