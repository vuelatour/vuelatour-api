// EL HISTORIAL DE MANTENIMIENTO VA COMPLETO (18-nov-2026, API 0.0.144,
// invariante 139). Del 16-oct al 18-nov (0.0.85, invariante 86) la lista
// ocultaba los servicios COMPLETADOS anteriores al inicio oficial
// (1-sep-2026). Reporte de Porfirio: «llené datos de un servicio anterior en
// N4142R pero ya no se visualiza (¿ya no se puede ver el historial de
// servicios?)». El inicio oficial NO aplica a esta lista: es la bitácora
// técnica del avión y el programa de servicio la lee entera.
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));

import { EngineeringService } from './engineering.service';
import { supabaseGrabador } from '../../common/inicio-oficial.fixture-spec';

// N4142R, tal como estaba en prod el 18-nov-2026 (lo que la tarjeta dejó de
// mostrar: solo salía el de septiembre).
const MANTS = [
  {
    id: 'm-50-abr',
    estado: 'COMPLETADO',
    descripcion: '50 hrs',
    fecha_realizada: '2026-04-24',
    fecha_programada: null,
  },
  {
    id: 'm-100-ago',
    estado: 'COMPLETADO',
    descripcion: 'servicio 100 hrs / anual',
    fecha_realizada: '2026-08-14',
    fecha_programada: '2026-08-10',
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
    id: 'm-50-sep',
    estado: 'COMPLETADO',
    descripcion: '50 hrs',
    fecha_realizada: '2026-09-12',
    fecha_programada: '2026-09-10',
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

const armar = () => {
  const g = supabaseGrabador((tabla) =>
    tabla === 'mantenimiento' ? { data: MANTS, error: null } : undefined,
  );
  const svc = new EngineeringService(g.supabase, {} as never);
  return { svc, ...g };
};

describe('EngineeringService.listMantenimientos — historial completo', () => {
  it('devuelve TODOS los servicios, también los completados antes del 1-sep-2026', async () => {
    const r = (await armar().svc.listMantenimientos('a1')) as Array<{
      id: string;
    }>;
    expect(r.map((m) => m.id)).toEqual(MANTS.map((m) => m.id));
  });

  it('el servicio de agosto que capturó la oficina SIGUE en la lista', async () => {
    const r = (await armar().svc.listMantenimientos('a1')) as Array<{
      id: string;
    }>;
    expect(r.map((m) => m.id)).toContain('m-100-ago');
    expect(r.map((m) => m.id)).toContain('m-50-abr');
  });

  it('no recorta la consulta por fecha (ni una condición de inicio oficial)', async () => {
    const { svc, consultas } = armar();
    await svc.listMantenimientos('a1');
    const texto = JSON.stringify(consultas);
    expect(consultas.map((c) => c.tabla)).toEqual(['mantenimiento']);
    expect(texto).not.toContain('2026-09-01');
    expect(texto).not.toContain('gte');
  });
});
