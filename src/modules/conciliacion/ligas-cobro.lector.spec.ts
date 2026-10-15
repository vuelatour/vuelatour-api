import {
  colsEspejoLigas,
  colsPuenteLigas,
  leerLigasDeCobros,
  leerPartesDeCobros,
  partesDeAbonos,
  partesDeLigas,
  PAGINA_LIGAS,
} from './ligas-cobro.lector';
import {
  cobroEstaConciliado,
  MOV_LIGA_COLS_CON_INGRESO,
} from '../../common/cobro-conciliado.util';
import { coberturaCobro } from '../../common/cobro-banco.util';

const MOV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MOV3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';
const CTA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Fila = Record<string, unknown>;
type Consulta = {
  tabla: string;
  cols: string;
  columna: string;
  ids: string[];
  orden: string[];
  rango: [number, number] | null;
};

/**
 * PostgREST falso: `movimiento_bancario` con el espejo (MOV1 ↔ C1 directo,
 * MOV2 ↔ sobre S1), la puente con un LOTE (MOV2 paga C2 y C3 — su espejo
 * cobro_id es NULL) y la cuenta embebida. Respeta `order`, `range` y el
 * max-rows de 1,000 (corta SIN avisar); con un orden que NO es total
 * revuelve los empates en cada consulta (como Postgres, que no garantiza el
 * orden de los empates entre páginas). `sinPuente` ⇒ 42P01.
 */
function fake(
  opts: { sinPuente?: boolean; movs?: Fila[]; puente?: Fila[] } = {},
) {
  const consultas: Consulta[] = [];
  const cuentas: Fila[] = [
    { id: CTA, alias: 'EJE SCOTIA', moneda: 'MXN', tipo: 'BANCO' },
  ];
  const movs: Fila[] = opts.movs ?? [
    {
      id: MOV1,
      cobro_id: C1,
      cobro_grupo_id: null,
      ingreso_id: null,
      fecha: '2026-09-15',
      monto: 1700,
      cobros_n: 1,
      cuenta_bancaria_id: CTA,
      created_at: '2026-10-06T15:22:46.58996+00:00',
    },
    {
      id: MOV2,
      cobro_id: null,
      cobro_grupo_id: S1,
      ingreso_id: null,
      fecha: '2026-09-16',
      monto: 3500,
      cobros_n: 2,
      cuenta_bancaria_id: CTA,
      created_at: '2026-10-06T15:22:46.58996+00:00',
    },
  ];
  const puente: Fila[] = opts.puente ?? [
    {
      movimiento_id: MOV1,
      cobro_id: C1,
      monto_parte: 1700,
      created_at: '2026-10-12T09:00:00Z',
      created_by: null,
    },
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
  let semilla = 7;
  const azar = () => {
    semilla = (semilla * 1103515245 + 12345) % 2147483648;
    return semilla / 2147483648;
  };
  const conCuenta = (m: Fila | undefined, cols: string): Fila | null => {
    if (!m) return null;
    return cols.includes('cuenta:cuenta_bancaria')
      ? {
          ...m,
          cuenta: cuentas.find((c) => c.id === m.cuenta_bancaria_id) ?? null,
        }
      : { ...m };
  };
  const sb = {
    from(tabla: string) {
      const q: Consulta = {
        tabla,
        cols: '',
        columna: '',
        ids: [],
        orden: [],
        rango: null,
      };
      const ejecutar = () => {
        consultas.push(q);
        if (tabla === 'movimiento_bancario_cobro' && opts.sinPuente) {
          return {
            data: null,
            error: {
              code: '42P01',
              message:
                'relation "public.movimiento_bancario_cobro" does not exist',
            },
          };
        }
        let rows: Fila[];
        if (tabla === 'movimiento_bancario') {
          rows = movs
            .filter((m) => q.ids.includes(String(m[q.columna])))
            .map((m) => conCuenta(m, q.cols) as Fila);
        } else if (tabla === 'movimiento_bancario_cobro') {
          rows = puente
            .filter((p) => q.ids.includes(String(p[q.columna])))
            .map((p) =>
              q.cols.includes('movimiento:')
                ? {
                    ...p,
                    movimiento: conCuenta(
                      movs.find((m) => m.id === p.movimiento_id),
                      q.cols,
                    ),
                  }
                : { ...p },
            );
        } else {
          rows = [];
        }
        // Empates revueltos en CADA consulta (Postgres no garantiza su orden).
        rows = rows
          .map((r) => ({ r, k: azar() }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.r);
        for (const col of [...q.orden].reverse()) {
          rows.sort((a, b) =>
            String(a[col]) < String(b[col])
              ? -1
              : String(a[col]) > String(b[col])
                ? 1
                : 0,
          );
        }
        if (q.rango) rows = rows.slice(q.rango[0], q.rango[1] + 1);
        rows = rows.slice(0, 1000); // max-rows de PostgREST
        return { data: rows, error: null };
      };
      const api: Record<string, unknown> = {
        select(cols: string) {
          q.cols = cols;
          return api;
        },
        in(columna: string, ids: string[]) {
          q.columna = columna;
          q.ids = ids;
          return api;
        },
        order(col: string) {
          q.orden.push(col);
          return api;
        },
        range(a: number, b: number) {
          q.rango = [a, b];
          return api;
        },
        limit() {
          return api;
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar()).then(res, rej),
      };
      return api;
    },
  };
  return { sb: sb as never, consultas };
}

describe('ligas-cobro.lector — espejo + puente como UNA lista de ligas', () => {
  it('un cobro de un LOTE se ve ligado aunque su espejo cobro_id sea NULL', async () => {
    const { sb, consultas } = fake();
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1, C2, C3],
      sobreIds: [S1],
      conPuente: true,
    });
    expect(cobroEstaConciliado({ id: C1 }, ligas)).toBe(true); // puente + espejo
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

  it('la PUENTE va primero (invariante 77): la liga que sobrevive trae monto_parte', async () => {
    const { sb } = fake();
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1],
      conPuente: true,
    });
    expect(ligas.filter((l) => l.cobro_id === C1)).toHaveLength(1);
    expect(ligas[0]).toMatchObject({
      id: MOV1,
      cobro_id: C1,
      monto_parte: 1700,
    });
  });

  it('selects: espejo con el abono para la cobertura; puente PAGINADA por (cobro_id, movimiento_id) con el abono embebido', async () => {
    const { sb, consultas } = fake();
    await leerLigasDeCobros(sb, {
      cobroIds: [C1],
      cols: MOV_LIGA_COLS_CON_INGRESO,
      conPuente: true,
    });
    const espejo = consultas.find((c) => c.tabla === 'movimiento_bancario')!;
    expect(espejo.cols).toBe(
      'id, cobro_id, cobro_grupo_id, ingreso_id, fecha, monto, cuenta_bancaria_id, created_at, cuenta:cuenta_bancaria!cuenta_bancaria_id(alias, moneda, tipo)',
    );
    expect(espejo.cols).toBe(colsEspejoLigas(MOV_LIGA_COLS_CON_INGRESO));
    const puente = consultas.find(
      (c) => c.tabla === 'movimiento_bancario_cobro',
    )!;
    expect(puente.cols).toBe(
      'movimiento_id, cobro_id, monto_parte, movimiento:movimiento_bancario!movimiento_id(id, cobro_id, cobro_grupo_id, ingreso_id, fecha, monto, cobros_n, cuenta_bancaria_id, created_at, cuenta:cuenta_bancaria!cuenta_bancaria_id(alias, moneda, tipo))',
    );
    expect(puente.cols).toBe(colsPuenteLigas(MOV_LIGA_COLS_CON_INGRESO));
    expect(puente.orden).toEqual(['cobro_id', 'movimiento_id']);
    expect(puente.rango).toEqual([0, PAGINA_LIGAS - 1]);
    // El espejo también se pagina (por su PK): con M:N el `cobro_id` de 150
    // cobros ya no está acotado a 150 filas.
    expect(espejo.orden).toEqual(['id']);
    expect(espejo.rango).toEqual([0, PAGINA_LIGAS - 1]);
    // El espejo JAMÁS nombra `cobros_n` (no existe sin 20261012000002).
    expect(espejo.cols).not.toMatch(/\bcobros_n\b/);
    for (const c of consultas) {
      expect(c.cols).not.toMatch(/numero_cuenta|clabe|storage_path/);
    }
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
    const dePuente = consultas.filter(
      (c) => c.tabla === 'movimiento_bancario_cobro',
    );
    expect(dePuente.map((c) => c.ids.length)).toEqual([150, 150, 2]);
  });

  it('M:N con MÁS de 1,000 partes en un lote de ids: pagina sin saltar ni repetir (150 cobros × 7 abonos)', async () => {
    const cobros = Array.from(
      { length: 150 },
      (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const movs: Fila[] = Array.from({ length: 7 }, (_, j) => ({
      id: `a0000000-0000-4000-8000-${String(j).padStart(12, '0')}`,
      cobro_id: null,
      cobro_grupo_id: null,
      fecha: `2026-09-1${j}`,
      monto: 1050,
      cobros_n: 150,
      cuenta_bancaria_id: CTA,
      created_at: '2026-10-06T15:00:00Z',
    }));
    const puente: Fila[] = cobros.flatMap((c) =>
      movs.map((m) => ({
        movimiento_id: m.id,
        cobro_id: c,
        monto_parte: 1,
        created_at: '2026-10-13T00:00:00Z',
        created_by: null,
      })),
    );
    expect(puente.length).toBe(1050);
    const { sb, consultas } = fake({ movs, puente });
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: cobros,
      conPuente: true,
    });
    const paginas = consultas.filter(
      (c) => c.tabla === 'movimiento_bancario_cobro',
    );
    expect(paginas.map((p) => p.rango)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    const llaves = ligas.map((l) => `${String(l.id)}|${String(l.cobro_id)}`);
    expect(new Set(llaves).size).toBe(1050);
    expect(llaves).toHaveLength(1050);
    const partes = partesDeLigas(ligas);
    expect(partes.size).toBe(150);
    expect([...partes.values()].every((ps) => ps.length === 7)).toBe(true);
    // Y la misma paginación en leerPartesDeCobros.
    const { sb: sb2 } = fake({ movs, puente });
    const porCobro = await leerPartesDeCobros(sb2, cobros);
    expect([...porCobro.values()].reduce((a, ps) => a + ps.length, 0)).toBe(
      1050,
    );
  });

  it('el ESPEJO también pagina: 150 cobros × 7 abonos de UN cobro cada uno (1,050 filas con cobro_id)', async () => {
    const cobros = Array.from(
      { length: 150 },
      (_, i) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const movs: Fila[] = [];
    const puente: Fila[] = [];
    cobros.forEach((c, i) => {
      for (let j = 0; j < 7; j += 1) {
        const id = `a${String(i).padStart(3, '0')}${j}0000-0000-4000-8000-000000000000`;
        movs.push({
          id,
          cobro_id: c,
          cobro_grupo_id: null,
          fecha: '2026-09-15',
          monto: 10,
          cobros_n: 1,
          cuenta_bancaria_id: CTA,
          created_at: '2026-10-06T15:00:00Z',
        });
        puente.push({ movimiento_id: id, cobro_id: c, monto_parte: 10 });
      }
    });
    const { sb, consultas } = fake({ movs, puente });
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: cobros,
      conPuente: true,
    });
    const espejo = consultas.filter(
      (c) => c.tabla === 'movimiento_bancario' && c.columna === 'cobro_id',
    );
    expect(espejo.map((c) => c.rango)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(ligas).toHaveLength(1050);
    expect(
      [...partesDeLigas(ligas).values()].every((ps) => ps.length === 7),
    ).toBe(true);
  });

  it('partesDeAbonos: filas normalizadas en orden de alta (paginada por movimiento_id, cobro_id)', async () => {
    const { sb, consultas } = fake();
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
    expect(consultas[0].orden).toEqual(['movimiento_id', 'cobro_id']);
    expect(consultas[0].rango).toEqual([0, PAGINA_LIGAS - 1]);
  });
});

describe('partesDeLigas — las partes de cada cobro para coberturaCobro (invariante 77)', () => {
  it('con la puente: cada parte con su monto_parte, la cuenta del abono y por antigüedad', async () => {
    const MOV_TARDE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const movs: Fila[] = [
      {
        id: MOV_TARDE,
        cobro_id: C1,
        cobro_grupo_id: null,
        fecha: '2026-09-16',
        monto: 1700,
        cobros_n: 1,
        cuenta_bancaria_id: CTA,
        created_at: '2026-10-06T15:22:46Z',
      },
      {
        id: MOV3,
        cobro_id: C1,
        cobro_grupo_id: null,
        fecha: '2026-09-15',
        monto: -1700,
        cobros_n: 1,
        cuenta_bancaria_id: CTA,
        created_at: '2026-10-06T15:22:46Z',
      },
    ];
    const puente: Fila[] = [
      { movimiento_id: MOV_TARDE, cobro_id: C1, monto_parte: 1700 },
      { movimiento_id: MOV3, cobro_id: C1, monto_parte: 1700 },
    ];
    const { sb } = fake({ movs, puente });
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1],
      conPuente: true,
    });
    const partes = partesDeLigas(ligas).get(C1)!;
    expect(partes).toEqual([
      {
        movimiento_id: MOV3,
        cobro_id: C1,
        monto_parte: 1700,
        moneda_cuenta: 'MXN',
        pasarela: false,
        fecha: '2026-09-15',
        created_at: '2026-10-06T15:22:46Z',
        monto_abono: 1700,
        cobros_n: 1,
        cuenta_bancaria_id: CTA,
        cuenta_alias: 'EJE SCOTIA',
      },
      expect.objectContaining({
        movimiento_id: MOV_TARDE,
        fecha: '2026-09-16',
      }),
    ]);
    // Dos SPEI de $1,700 cubren el cobro de $3,400 de las camionetas.
    expect(
      coberturaCobro({ monto: 3400, moneda: 'MXN' }, partes),
    ).toMatchObject({ cubierto: true, n_partes: 2, faltante: 0 });
  });

  it('sin la puente: la liga del ESPEJO es una parte del |abono| completo (cobros_n 1); sobres y anticipos no son partes', async () => {
    const { sb } = fake({ sinPuente: true });
    const ligas = await leerLigasDeCobros(sb, {
      cobroIds: [C1],
      sobreIds: [S1],
      conPuente: false,
    });
    const partes = partesDeLigas(ligas);
    expect([...partes.keys()]).toEqual([C1]);
    expect(partes.get(C1)).toEqual([
      expect.objectContaining({
        movimiento_id: MOV1,
        monto_parte: 1700,
        monto_abono: 1700,
        cobros_n: 1,
        moneda_cuenta: 'MXN',
      }),
    ]);
  });

  it('no repite (abono, cobro) aunque llegue dos veces; una liga sin cuenta legible ⇒ moneda null', () => {
    const liga = {
      id: MOV1,
      cobro_id: C1,
      cobro_grupo_id: null,
      monto_parte: 10,
      monto: 10,
      fecha: '2026-09-15',
    };
    const partes = partesDeLigas([liga, { ...liga }]).get(C1)!;
    expect(partes).toHaveLength(1);
    expect(partes[0]).toMatchObject({
      monto_parte: 10,
      moneda_cuenta: null,
      pasarela: false,
      cuenta_alias: null,
    });
  });
});
