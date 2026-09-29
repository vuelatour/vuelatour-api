// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';

/**
 * PRE-CIERRE · SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026): aviso NO
 * bloqueante «N vuelo(s) con ajustes pendientes de reflejar en la
 * cotización: #a, #b…» — vuelos del periodo (cortes Cancún) con notas
 * PENDIENTE que afectan la cotización. Nada de esto debe olvidarse en el
 * cierre mensual, pero tampoco lo detiene.
 */
type Fila = Record<string, unknown>;

interface Llamada {
  tabla: string;
  ops: Array<[string, unknown[]]>;
}

function armar(
  seguimiento: Fila[] | { error: { code: string; message: string } },
) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const ll: Llamada = { tabla, ops: [] };
    llamadas.push(ll);
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = (...args: unknown[]) => {
        ll.ops.push([m, args]);
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve({ data: null, error: null });
    q.then = (res: (v: unknown) => unknown) => {
      if (tabla === 'vuelo_seguimiento') {
        // PostgREST real: `range(a, b)` devuelve ese tramo y NUNCA más de
        // max-rows (1000) filas por respuesta.
        const r = ll.ops.find((o) => o[0] === 'range')?.[1] as
          | [number, number]
          | undefined;
        const [a, b] = r ?? [0, Number.MAX_SAFE_INTEGER];
        return Promise.resolve(
          Array.isArray(seguimiento)
            ? {
                data: seguimiento.slice(a, Math.min(b + 1, a + 1000)),
                error: null,
              }
            : { data: null, error: seguimiento.error },
        ).then(res);
      }
      return Promise.resolve({ data: [], error: null, count: 0 }).then(res);
    };
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const conciliacion = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  const svc = new ProfitSharingService(supabase, nada, nada, conciliacion);
  return { svc, llamadas };
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };

function itemDe(r: { items: Array<Record<string, unknown>> }) {
  return r.items.find((i) => i.clave === 'seguimiento_cotizacion_pendiente');
}

describe('ProfitSharingService.preCierre — seguimiento de la cotización', () => {
  it('lista los vuelos con ajustes pendientes y NO bloquea el cierre', async () => {
    const { svc, llamadas } = armar([
      {
        vuelo_id: 'v358',
        vuelo: {
          id: 'v358',
          folio: 358,
          estado: 'COMPLETADO',
          fecha_vuelo: '2026-09-29T14:00:00+00:00',
        },
      },
      {
        vuelo_id: 'v358',
        vuelo: {
          id: 'v358',
          folio: 358,
          estado: 'COMPLETADO',
          fecha_vuelo: '2026-09-29T14:00:00+00:00',
        },
      },
      {
        vuelo_id: 'v301',
        vuelo: {
          id: 'v301',
          folio: 301,
          estado: 'CONFIRMADO',
          fecha_vuelo: '2026-09-02T14:00:00+00:00',
        },
      },
    ]);
    const r = (await svc.preCierre(PERIODO)) as unknown as {
      listo: boolean;
      items: Array<Record<string, unknown>>;
    };
    const item = itemDe(r)!;
    expect(item).toMatchObject({
      titulo: 'Vuelos con ajustes pendientes de reflejar en la cotización',
      count: 2,
      notas: 3,
      lectura_fallida: false,
      detalle:
        '2 vuelo(s) con ajustes pendientes de reflejar en la cotización: #301, #358. Agrégalos a la cotización y márcalos como resueltos en el detalle del vuelo → «Seguimiento de la cotización».',
    });
    expect((item.vuelos as Fila[]).map((v) => [v.folio, v.notas])).toEqual([
      [301, 1],
      [358, 2],
    ]);
    // NO bloqueante: sin nada más pendiente, el periodo sigue «listo».
    expect(r.listo).toBe(true);
    expect(item).not.toHaveProperty('informativo');

    // La consulta: solo PENDIENTE + afecta la cotización + no borradas, con
    // cortes del periodo en hora Cancún sobre la fecha del VUELO.
    const q = llamadas.find((l) => l.tabla === 'vuelo_seguimiento')!;
    expect(q.ops).toEqual(
      expect.arrayContaining([
        ['eq', ['estado', 'PENDIENTE']],
        ['eq', ['afecta_cotizacion', true]],
        ['is', ['deleted_at', null]],
        ['gte', ['vuelo.fecha_vuelo', '2026-09-01T00:00:00-05:00']],
        ['lte', ['vuelo.fecha_vuelo', '2026-09-30T23:59:59-05:00']],
      ]),
    );
    expect(String(q.ops.find((o) => o[0] === 'select')?.[1][0])).toContain(
      'vuelo:vuelo_id!inner(',
    );
  });

  it('PAGINA: con más de 1000 notas (max-rows de PostgREST) ningún vuelo se pierde', async () => {
    // 2,350 notas en 1,175 vuelos (2 por vuelo). Sin paginar, PostgREST
    // entregaría solo las primeras 1000 filas (500 vuelos) sin avisar.
    const filas: Fila[] = [];
    for (let i = 0; i < 1175; i += 1) {
      const vuelo = {
        id: `v${i}`,
        folio: 1000 + i,
        estado: 'COMPLETADO',
        fecha_vuelo: '2026-09-15T14:00:00+00:00',
      };
      filas.push({ id: `n${i}a`, vuelo_id: `v${i}`, vuelo });
      filas.push({ id: `n${i}b`, vuelo_id: `v${i}`, vuelo });
    }
    const { svc, llamadas } = armar(filas);
    const item = itemDe(await svc.preCierre(PERIODO))!;
    expect(item).toMatchObject({
      count: 1175,
      notas: 2350,
      lectura_fallida: false,
    });
    const paginas = llamadas
      .filter((l) => l.tabla === 'vuelo_seguimiento')
      .map((l) => l.ops.find((o) => o[0] === 'range')?.[1]);
    expect(paginas).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    // Orden TOTAL por id: las páginas no se traslapan.
    const q = llamadas.find((l) => l.tabla === 'vuelo_seguimiento')!;
    expect(q.ops).toContainEqual(['order', ['id', { ascending: true }]]);
  });

  it('sin la migración (tabla ausente) ⇒ 0 vuelos, sin tumbar el pre-cierre', async () => {
    const { svc } = armar({
      error: {
        code: 'PGRST205',
        message:
          "Could not find the table 'public.vuelo_seguimiento' in the schema cache",
      },
    });
    const item = itemDe(await svc.preCierre(PERIODO))!;
    expect(item).toMatchObject({
      count: 0,
      notas: 0,
      vuelos: [],
      lectura_fallida: false,
    });
  });

  it('lectura fallida ⇒ count 0 pero MARCADA (lectura_fallida) y con texto que lo dice', async () => {
    const { svc } = armar({ error: { code: '57014', message: 'timeout' } });
    const r = (await svc.preCierre(PERIODO)) as unknown as {
      listo: boolean;
      items: Array<Record<string, unknown>>;
    };
    const item = itemDe(r)!;
    expect(item).toMatchObject({ count: 0, lectura_fallida: true });
    expect(String(item.detalle)).toContain('No se pudo leer el seguimiento');
    expect(r.listo).toBe(true);
  });
});
