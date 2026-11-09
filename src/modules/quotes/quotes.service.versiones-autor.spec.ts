// Módulos pesados que quotes.service importa solo para inyección (mismo
// patrón que los demás specs del cotizador).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { QuotesService } from './quotes.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * QUIÉN HIZO CADA VERSIÓN (9-nov-2026, API 0.0.132, invariante 127). Pedido
 * de la oficina sobre el «Historial de versiones»: «pueden poner quién hace
 * cada versión». `GET /v1/quotes/:id/versions` añade `creado_por_nombre`
 * (ADITIVO) resuelto de `created_by` en UNA consulta; nunca un uuid ni un
 * nombre inventado.
 */
const VUELO = 'vvvvvvvv-0000-4000-8000-000000000329';
const ITZI = 'uuuuuuuu-0000-4000-8000-0000000000it';
const MARY = 'uuuuuuuu-0000-4000-8000-0000000000ma';
const BORRADO = 'uuuuuuuu-0000-4000-8000-0000000000xx';

type Row = Record<string, unknown>;

function armar(opts: {
  versiones: Row[];
  usuarios?: Row[];
  errorUsuarios?: boolean;
}) {
  const consultas: Array<{ tabla: string; ins: unknown[] }> = [];
  const supabase = {
    service: {
      from(tabla: string) {
        const reg = { tabla, ins: [] as unknown[] };
        consultas.push(reg);
        const resultado =
          tabla === 'cotizacion_version_history'
            ? { data: opts.versiones, error: null }
            : tabla === 'usuario'
              ? opts.errorUsuarios
                ? { data: null, error: { message: 'boom' } }
                : { data: opts.usuarios ?? [], error: null }
              : { data: [], error: null };
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order']) q[m] = () => q;
        q.in = (_col: string, ids: unknown[]) => {
          reg.ins = ids;
          return q;
        };
        q.then = (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(resultado).then(resolve, reject);
        return q;
      },
    },
  } as unknown as SupabaseService;
  // `supabase` es el 4.º parámetro del constructor.
  const service = new QuotesService(
    {} as never,
    {} as never,
    {} as never,
    supabase,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // La existencia de la cotización no es el tema de este spec.
  Object.assign(service as unknown as Record<string, unknown>, {
    findById: () => Promise.resolve({ id: VUELO }),
  });
  return { service, consultas };
}

const v = (
  version: number,
  created_by: string | null,
  extra: Row = {},
): Row => ({
  id: `h-${version}`,
  vuelo_id: VUELO,
  version,
  monto_total_usd: 2424.4,
  motivo: version === 1 ? 'Versión inicial' : 'Corrección',
  created_at: '2026-11-07T18:42:00+00:00',
  created_by,
  ...extra,
});

describe('Historial de versiones — quién hizo cada versión (invariante 127)', () => {
  it('cada versión trae `creado_por_nombre` y el resto de la fila queda idéntico; UNA sola consulta a `usuario` con los ids distintos', async () => {
    const versiones = [v(3, MARY), v(2, ITZI), v(1, ITZI)];
    const { service, consultas } = armar({
      versiones,
      usuarios: [
        { id: ITZI, nombre: 'Itzi  Canales ' },
        { id: MARY, nombre: 'Mary' },
      ],
    });
    const r = await service.findVersions(VUELO);
    expect(r.map((x) => [x.version, x.creado_por_nombre])).toEqual([
      [3, 'Mary'],
      [2, 'Itzi Canales'],
      [1, 'Itzi Canales'],
    ]);
    r.forEach((x, i) => {
      const resto: Record<string, unknown> = { ...x };
      delete resto.creado_por_nombre;
      expect(resto).toEqual(versiones[i]);
    });
    const aUsuario = consultas.filter((c) => c.tabla === 'usuario');
    expect(aUsuario).toHaveLength(1);
    expect([...aUsuario[0].ins].sort()).toEqual([ITZI, MARY].sort());
  });

  it('sin autor, usuario que ya no existe o nombre en blanco ⇒ null (nunca el uuid)', async () => {
    const { service } = armar({
      versiones: [v(3, null), v(2, BORRADO), v(1, ITZI)],
      usuarios: [{ id: ITZI, nombre: '   ' }],
    });
    const r = await service.findVersions(VUELO);
    expect(r.map((x) => x.creado_por_nombre)).toEqual([null, null, null]);
  });

  it('si `usuario` no se puede leer, el historial sale completo con los nombres en null', async () => {
    const { service } = armar({
      versiones: [v(2, ITZI), v(1, ITZI)],
      errorUsuarios: true,
    });
    const r = await service.findVersions(VUELO);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.creado_por_nombre === null)).toBe(true);
  });

  it('sin versiones: lista vacía y ni una consulta a `usuario`', async () => {
    const { service, consultas } = armar({ versiones: [] });
    expect(await service.findVersions(VUELO)).toEqual([]);
    expect(consultas.some((c) => c.tabla === 'usuario')).toBe(false);
  });
});
