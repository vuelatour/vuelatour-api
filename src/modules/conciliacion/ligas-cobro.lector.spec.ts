import { leerLigasDeCobros, partesDeAbonos } from './ligas-cobro.lector';
import { cobroEstaConciliado } from '../../common/cobro-conciliado.util';

const MOV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';

type Consulta = { tabla: string; cols: string; columna: string; ids: string[] };

/**
 * PostgREST falso: `movimiento_bancario` con el espejo (MOV1 ↔ C1 directo,
 * MOV2 ↔ sobre S1) y la puente con un LOTE (MOV2 paga C2 y C3 — su espejo
 * cobro_id es NULL). `sinPuente` ⇒ 42703 para cualquier consulta a la
 * puente (migración no aplicada).
 */
function fake(opts: { sinPuente?: boolean } = {}) {
  const consultas: Consulta[] = [];
  const movs = [
    { id: MOV1, cobro_id: C1, cobro_grupo_id: null, ingreso_id: null },
    { id: MOV2, cobro_id: null, cobro_grupo_id: S1, ingreso_id: null },
  ];
  const puente = [
    {
      movimiento_id: MOV2,
      cobro_id: C2,
      monto_parte: 1000,
      created_at: '2026-10-12T10:00:00Z',
      created_by: null,
    },
    {
      movimiento_id: MOV2,
      cobro_id: C3,
      monto_parte: 2500,
      created_at: '2026-10-12T10:00:01Z',
      created_by: null,
    },
  ];
  const sb = {
    from(tabla: string) {
      return {
        select(cols: string) {
          return {
            in(columna: string, ids: string[]) {
              consultas.push({ tabla, cols, columna, ids });
              if (tabla === 'movimiento_bancario') {
                const rows = movs.filter((m) =>
                  ids.includes(String((m as Record<string, unknown>)[columna])),
                );
                return Promise.resolve({ data: rows, error: null });
              }
              if (tabla === 'movimiento_bancario_cobro') {
                if (opts.sinPuente) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: '42P01',
                      message:
                        'relation "public.movimiento_bancario_cobro" does not exist',
                    },
                  });
                }
                const rows = puente
                  .filter((p) =>
                    ids.includes(
                      String((p as Record<string, unknown>)[columna]),
                    ),
                  )
                  .map((p) =>
                    cols.includes('movimiento:')
                      ? {
                          ...p,
                          movimiento:
                            movs.find((m) => m.id === p.movimiento_id) ?? null,
                        }
                      : p,
                  );
                return Promise.resolve({ data: rows, error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
            limit() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
  return { sb: sb as never, consultas };
}

describe('ligas-cobro.lector — espejo + puente como UNA lista de ligas', () => {
  it('un cobro de un LOTE se ve conciliado aunque su espejo cobro_id sea NULL', async () => {
    const { sb, consultas } = fake();
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1, C2, C3],
      sobreIds: [S1],
      conPuente: true,
    });
    expect(cobroEstaConciliado({ id: C1 }, ligas)).toBe(true); // espejo
    expect(cobroEstaConciliado({ id: C2 }, ligas)).toBe(true); // puente
    expect(cobroEstaConciliado({ id: C3 }, ligas)).toBe(true); // puente
    expect(cobroEstaConciliado({ id: 'otro', cobro_grupo_id: S1 }, ligas)).toBe(
      true,
    ); // sobre
    // Las ligas de la puente llevan el id del MOVIMIENTO que las paga.
    expect(ligas.filter((l) => l.cobro_id === C2).map((l) => l.id)).toEqual([
      MOV2,
    ]);
    // Una lectura por columna del espejo que SÍ trae ids + una de la puente
    // (sin anticipos no se pregunta por `ingreso_id`).
    expect(consultas.map((c) => `${c.tabla}:${c.columna}`)).toEqual([
      'movimiento_bancario:cobro_id',
      'movimiento_bancario:cobro_grupo_id',
      'movimiento_bancario_cobro:cobro_id',
    ]);
  });

  it('sin la migración (conPuente false) SOLO mira el espejo, como el 0.0.70', async () => {
    const { sb, consultas } = fake({ sinPuente: true });
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1, C2],
      conPuente: false,
    });
    expect(cobroEstaConciliado({ id: C1 }, ligas)).toBe(true);
    expect(cobroEstaConciliado({ id: C2 }, ligas)).toBe(false);
    expect(consultas.some((c) => c.tabla === 'movimiento_bancario_cobro')).toBe(
      false,
    );
  });

  it('sin cobros no toca la puente ni sondea; sin ids no consulta nada', async () => {
    const { sb, consultas } = fake();
    const ligas = await leerLigasDeCobros(sb, {
      sobreIds: [S1],
      conPuente: true,
    });
    expect(ligas.map((l) => l.cobro_grupo_id)).toEqual([S1]);
    expect(consultas.some((c) => c.tabla === 'movimiento_bancario_cobro')).toBe(
      false,
    );
    const { sb: sb2, consultas: c2 } = fake();
    expect(await leerLigasDeCobros(sb2, { conPuente: true })).toEqual([]);
    expect(c2).toEqual([]);
  });

  it('parte en lotes de 150 ids y no repite la misma liga', async () => {
    const { sb, consultas } = fake();
    const muchos = Array.from({ length: 301 }, (_, i) => `id-${i}`).concat([
      C1,
      C1,
    ]);
    await leerLigasDeCobros(sb, { cobroIds: muchos, conPuente: true });
    const deCobro = consultas.filter(
      (c) => c.columna === 'cobro_id' && c.tabla === 'movimiento_bancario',
    );
    expect(deCobro.map((c) => c.ids.length)).toEqual([150, 150, 2]);
  });

  it('partesDeAbonos: filas normalizadas en orden de alta', async () => {
    const { sb } = fake();
    const partes = await partesDeAbonos(sb, [MOV2]);
    expect(partes).toEqual([
      {
        movimiento_id: MOV2,
        cobro_id: C2,
        monto_parte: 1000,
        created_at: '2026-10-12T10:00:00Z',
        created_by: null,
      },
      {
        movimiento_id: MOV2,
        cobro_id: C3,
        monto_parte: 2500,
        created_at: '2026-10-12T10:00:01Z',
        created_by: null,
      },
    ]);
  });
});
