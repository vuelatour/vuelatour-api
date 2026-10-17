jest.mock('./afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>('./afac-real-disponible.util'),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { afacRealDisponible } from './afac-real-disponible.util';
import {
  LOTE_AFAC_REAL,
  leerAfacDeVuelos,
  leerAfacRealesDelPeriodo,
  leerMesContableDeVuelos,
} from './afac-real.lector';

/**
 * Lector del costo real AFAC (16-oct-2026, invariante 90): detrás de la
 * sonda, en lotes, nombres tolerantes, mes contable con y sin la migración
 * del cierre y la red de seguridad del periodo.
 */
type Llamada = { tabla: string; ops: Array<[string, unknown[]]> };

function fake(
  datos: Record<string, Array<Record<string, unknown>>>,
  errores: Record<string, string> = {},
) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const ll: Llamada = { tabla, ops: [] };
    llamadas.push(ll);
    const q: Record<string, unknown> = {};
    for (const op of ['select', 'in', 'not', 'gte', 'lte', 'eq']) {
      q[op] = (...args: unknown[]) => {
        ll.ops.push([op, args]);
        return q;
      };
    }
    q.then = (res: (v: unknown) => unknown) => {
      const lote = ll.ops.find(([o]) => o === 'in')?.[1][1] as
        | string[]
        | undefined;
      const filas = (datos[tabla] ?? []).filter((f) =>
        lote ? lote.includes(String(f.vuelo_id ?? f.id)) : true,
      );
      return Promise.resolve(
        errores[tabla]
          ? { data: null, error: { message: errores[tabla] } }
          : { data: filas, error: null },
      ).then(res);
    };
    return q;
  };
  return { sb: { from } as unknown as SupabaseClient, llamadas };
}

const sonda = afacRealDisponible as jest.MockedFunction<
  typeof afacRealDisponible
>;

describe('afac-real.lector (invariante 90)', () => {
  beforeEach(() => sonda.mockResolvedValue(true));

  it('sin la migración: mapas vacíos SIN consultar', async () => {
    sonda.mockResolvedValue(false);
    const { sb, llamadas } = fake({});
    expect((await leerAfacDeVuelos(sb, ['v-1'])).size).toBe(0);
    expect(
      await leerAfacRealesDelPeriodo(sb, '2026-09-01', '2026-09-30', true),
    ).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it('leerAfacDeVuelos: lotes de 200, solo costos no null (filtro en la consulta) y el nombre de quien capturó', async () => {
    const ids = Array.from(
      { length: LOTE_AFAC_REAL * 2 + 5 },
      (_, i) => `v-${i}`,
    );
    const { sb, llamadas } = fake({
      afac_vuelo: [
        {
          vuelo_id: 'v-3',
          costo_real_mxn: '4500.00',
          notas: 'F-1',
          capturado_por: 'u-1',
          capturado_at: 't',
          updated_at: 't',
        },
        {
          vuelo_id: 'v-401',
          costo_real_mxn: 0,
          notas: null,
          capturado_por: null,
          capturado_at: null,
          updated_at: null,
        },
      ],
      usuario: [{ id: 'u-1', nombre: 'Alejandra Pérez' }],
    });
    const m = await leerAfacDeVuelos(sb, ids);
    const consultas = llamadas.filter((l) => l.tabla === 'afac_vuelo');
    expect(consultas).toHaveLength(3);
    expect(consultas[0].ops).toContainEqual([
      'not',
      ['costo_real_mxn', 'is', null],
    ]);
    expect(m.get('v-3')).toEqual({
      vuelo_id: 'v-3',
      costo_real_mxn: 4500,
      notas: 'F-1',
      capturado_por: 'u-1',
      capturado_por_nombre: 'Alejandra Pérez',
      capturado_at: 't',
      updated_at: 't',
    });
    // 0 = «AFAC no cobró» (distinto de sin capturar): también es un real.
    expect(m.get('v-401')!.costo_real_mxn).toBe(0);
  });

  it('un nombre que no se lee jamás tumba el libro; un fallo del dinero SÍ lanza', async () => {
    const ok = fake(
      {
        afac_vuelo: [
          { vuelo_id: 'v-1', costo_real_mxn: 10, capturado_por: 'u-1' },
        ],
      },
      { usuario: 'boom' },
    );
    expect(
      (await leerAfacDeVuelos(ok.sb, ['v-1'])).get('v-1')!.capturado_por_nombre,
    ).toBeNull();
    const mal = fake({}, { afac_vuelo: 'timeout' });
    await expect(leerAfacDeVuelos(mal.sb, ['v-1'])).rejects.toThrow(
      'Costo real AFAC de los vuelos: timeout',
    );
  });

  it('leerMesContableDeVuelos: con la migración del cierre usa fecha_contable (diferido ⇒ mes destino); sin ella, fecha_vuelo', async () => {
    const vuelos = [
      {
        id: 'v-316',
        fecha_vuelo: '2026-09-28T15:00:00Z',
        periodo_contable: '2026-10-01T05:00:00Z',
        fecha_contable: '2026-10-01T05:00:00Z',
      },
      {
        id: 'v-236',
        fecha_vuelo: '2026-09-02T15:00:00Z',
        periodo_contable: null,
        fecha_contable: '2026-09-02T15:00:00Z',
      },
    ];
    const con = fake({ vuelo: vuelos });
    const m = await leerMesContableDeVuelos(con.sb, ['v-316', 'v-236'], true);
    expect([...m]).toEqual([
      ['v-316', '2026-10'],
      ['v-236', '2026-09'],
    ]);
    expect(con.llamadas[0].ops[0]).toEqual([
      'select',
      ['id, fecha_vuelo, periodo_contable, fecha_contable'],
    ]);
    const sin = fake({
      vuelo: vuelos.map(({ id, fecha_vuelo }) => ({ id, fecha_vuelo })),
    });
    const m0 = await leerMesContableDeVuelos(sin.sb, ['v-316'], false);
    expect(m0.get('v-316')).toBe('2026-09');
    expect(sin.llamadas[0].ops[0]).toEqual(['select', ['id, fecha_vuelo']]);
  });

  it('leerAfacRealesDelPeriodo: filtra por el EJE CONTABLE del vuelo en hora Cancún y trae el folio', async () => {
    const { sb, llamadas } = fake({
      afac_vuelo: [
        {
          vuelo_id: 'v-1',
          costo_real_mxn: 300,
          capturado_por: null,
          vuelo: { folio: 777 },
        },
      ],
    });
    const r = await leerAfacRealesDelPeriodo(
      sb,
      '2026-09-01',
      '2026-09-30',
      true,
    );
    expect(r).toEqual([
      expect.objectContaining({
        vuelo_id: 'v-1',
        costo_real_mxn: 300,
        folio: 777,
      }),
    ]);
    const ops = llamadas[0].ops;
    expect(ops).toContainEqual([
      'gte',
      ['vuelo.fecha_contable', '2026-09-01T00:00:00-05:00'],
    ]);
    expect(ops).toContainEqual([
      'lte',
      ['vuelo.fecha_contable', '2026-09-30T23:59:59-05:00'],
    ]);
    const sinCierre = fake({ afac_vuelo: [] });
    await leerAfacRealesDelPeriodo(
      sinCierre.sb,
      '2026-09-01',
      '2026-09-30',
      false,
    );
    expect(sinCierre.llamadas[0].ops).toContainEqual([
      'gte',
      ['vuelo.fecha_vuelo', '2026-09-01T00:00:00-05:00'],
    ]);
  });
});
