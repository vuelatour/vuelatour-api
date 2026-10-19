import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AVISO_SIN_MARCADOS_PAGADOS,
  LOTE_BITACORA_PAGADOS,
  marcadosPagadosEnBitacora,
} from './gasto-marcado-pagado.lector';

/**
 * Lector BEST-EFFORT de `gasto_bitacora` para el Excel de la reposición de
 * caja chica (gastos por pagar, invariante 93, revisión P7): la última vez
 * que cada gasto pasó de `por_pagar` true a false.
 */

type Fila = Record<string, unknown>;

interface Consulta {
  tabla: string;
  select: string;
  eq: Array<[string, unknown]>;
  in: unknown[] | null;
}

function cliente(
  opts: {
    bitacora?: Fila[];
    sinPorPagar?: boolean;
    /** Número de consulta a la bitácora (1, 2…) que falla. */
    fallaLote?: number;
    revienta?: boolean;
  } = {},
) {
  const consultas: Consulta[] = [];
  let lotes = 0;
  const from = (tabla: string) => {
    if (opts.revienta && tabla === 'gasto_bitacora') {
      throw new Error('fetch failed');
    }
    const c: Consulta = { tabla, select: '', eq: [], in: null };
    consultas.push(c);
    const q: Record<string, unknown> = {};
    q.select = (s: string) => {
      c.select = s;
      return q;
    };
    q.eq = (col: string, v: unknown) => {
      c.eq.push([col, v]);
      return q;
    };
    q.in = (_col: string, arr: unknown[]) => {
      c.in = arr;
      return q;
    };
    q.limit = () => q;
    q.then = (res: (v: unknown) => unknown) => {
      if (tabla === 'gasto') {
        return Promise.resolve(
          opts.sinPorPagar
            ? {
                data: null,
                error: {
                  code: '42703',
                  message: 'column gasto.por_pagar does not exist',
                },
              }
            : { data: [], error: null },
        ).then(res);
      }
      lotes += 1;
      if (opts.fallaLote === lotes) {
        return Promise.resolve({
          data: null,
          error: { code: '57014', message: 'statement timeout' },
        }).then(res);
      }
      const ids = c.in ?? [];
      return Promise.resolve({
        data: (opts.bitacora ?? []).filter((b) => ids.includes(b.gasto_id)),
        error: null,
      }).then(res);
    };
    return q;
  };
  const logger = { warn: jest.fn() };
  return {
    sb: { from } as unknown as SupabaseClient,
    consultas,
    logger,
  };
}

const bitacora = (gastoId: string, cuando: unknown): Fila => ({
  gasto_id: gastoId,
  created_at: cuando,
});

describe('marcadosPagadosEnBitacora', () => {
  it('la ÚLTIMA vez que se marcó pagado, por gasto; filas ilegibles se ignoran', async () => {
    const { sb, consultas } = cliente({
      bitacora: [
        bitacora('g1', '2026-10-19T15:00:00+00:00'),
        bitacora('g1', '2026-10-21T15:00:00+00:00'),
        bitacora('g1', '2026-10-20T15:00:00+00:00'),
        bitacora('g2', 'no es fecha'),
        bitacora('g3', null),
      ],
    });
    const r = await marcadosPagadosEnBitacora(sb, ['g1', 'g2', 'g3', 'g1']);
    expect([...r.entries()]).toEqual([['g1', '2026-10-21T15:00:00+00:00']]);
    const b = consultas.filter((c) => c.tabla === 'gasto_bitacora');
    expect(b).toEqual([
      {
        tabla: 'gasto_bitacora',
        select: 'gasto_id, created_at',
        eq: [
          ['accion', 'UPDATE'],
          ['diff->por_pagar->>despues', 'false'],
        ],
        in: ['g1', 'g2', 'g3'],
      },
    ]);
  });

  it(`en lotes de ${LOTE_BITACORA_PAGADOS} ids (163 ⇒ 150 + 13, sin repetidos)`, async () => {
    const ids = Array.from({ length: 163 }, (_, i) => `g${i}`);
    const { sb, consultas } = cliente({
      bitacora: [bitacora('g162', '2026-10-19T15:00:00Z')],
    });
    const r = await marcadosPagadosEnBitacora(sb, [...ids, ...ids]);
    const lotes = consultas
      .filter((c) => c.tabla === 'gasto_bitacora')
      .map((c) => (c.in ?? []).length);
    expect(lotes).toEqual([150, 13]);
    expect(r.get('g162')).toBe('2026-10-19T15:00:00Z');
  });

  it('sin ids ⇒ ni la sonda ni la bitácora', async () => {
    const { sb, consultas } = cliente();
    expect((await marcadosPagadosEnBitacora(sb, [])).size).toBe(0);
    expect(consultas).toHaveLength(0);
  });

  it('SIN la migración 20261019000001 ⇒ mapa vacío sin leer la bitácora', async () => {
    const { sb, consultas, logger } = cliente({
      sinPorPagar: true,
      bitacora: [bitacora('g1', '2026-10-19T15:00:00Z')],
    });
    expect((await marcadosPagadosEnBitacora(sb, ['g1'], logger)).size).toBe(0);
    expect(consultas.some((c) => c.tabla === 'gasto_bitacora')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('un lote caído ⇒ mapa VACÍO (nunca a medias) y un warn', async () => {
    const ids = Array.from({ length: 163 }, (_, i) => `g${i}`);
    const { sb, logger } = cliente({
      fallaLote: 2,
      bitacora: [bitacora('g1', '2026-10-19T15:00:00Z')],
    });
    const r = await marcadosPagadosEnBitacora(sb, ids, logger);
    expect(r.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      `${AVISO_SIN_MARCADOS_PAGADOS}: statement timeout`,
    );
  });

  it('una excepción del cliente tampoco sale: mapa vacío y warn', async () => {
    const { sb, logger } = cliente({ revienta: true });
    await expect(
      marcadosPagadosEnBitacora(sb, ['g1'], logger),
    ).resolves.toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledWith(
      `${AVISO_SIN_MARCADOS_PAGADOS}: fetch failed`,
    );
  });
});
