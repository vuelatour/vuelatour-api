import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resetColumnasOpcionales } from './columna-opcional.util';
import {
  LOTE_IDS_CLAVE,
  clavesClienteDeVuelos,
  consecutivosClienteDeVuelos,
  vueloIdsPorClaveCliente,
} from './clave-cliente-lectura.util';

/**
 * LECTOR ÚNICO del ID de vuelo por cliente (13-oct-2026, invariante 68):
 * best-effort, todo o nada por llamada y NUNCA lanza. El cliente falso
 * registra cada consulta (tabla + operaciones) y responde con `responder`.
 */

type Op = [string, ...unknown[]];
interface Llamada {
  tabla: string;
  ops: Op[];
}
type Respuesta = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

function sbFalso(responder: (l: Llamada) => Respuesta) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const llamada: Llamada = { tabla, ops: [] };
    llamadas.push(llamada);
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'in', 'eq', 'limit', 'order']) {
      b[op] = (...args: unknown[]) => {
        llamada.ops.push([op, ...args]);
        return b;
      };
    }
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(responder(llamada)).then(res, rej);
    return b;
  };
  const sb = { from } as unknown as SupabaseClient;
  return { sb, llamadas };
}

const esSonda = (l: Llamada) =>
  l.tabla === 'vuelo' &&
  l.ops.some((o) => o[0] === 'select' && o[1] === 'consecutivo_cliente');
const lecturasDeLote = (ls: Llamada[]) =>
  ls.filter((l) => l.tabla === 'vuelo' && !esSonda(l));

const vid = (n: number) =>
  `vvvvvvvv-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Mundo: vuelos con su alias embebido como lo devuelve PostgREST. */
function mundo(filas: Array<Record<string, unknown>>) {
  return (l: Llamada): Respuesta => {
    if (esSonda(l)) return { data: [], error: null };
    const inIds = l.ops.find((o) => o[0] === 'in')?.[2] as string[] | undefined;
    return {
      data: filas.filter((f) => !inIds || inIds.includes(f.id as string)),
      error: null,
    };
  };
}

describe('clavesClienteDeVuelos', () => {
  let warn: jest.SpyInstance;
  const usados: SupabaseClient[] = [];
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const sb of usados.splice(0)) resetColumnasOpcionales(sb);
    jest.restoreAllMocks();
  });
  const armar = (responder: (l: Llamada) => Respuesta) => {
    const f = sbFalso(responder);
    usados.push(f.sb);
    return f;
  };
  const warnsLectura = () =>
    (warn.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).startsWith('ID de vuelo por cliente: no se pudo leer'),
    );

  it('sin ids ⇒ Map vacío y CERO consultas (ni la sonda)', async () => {
    const { sb, llamadas } = armar(mundo([]));
    const r = await clavesClienteDeVuelos(sb, []);
    expect(r.size).toBe(0);
    expect(await clavesClienteDeVuelos(sb, [null, undefined, ''])).toEqual(
      new Map(),
    );
    expect(llamadas).toHaveLength(0);
  });

  it('sin la migración (42703 en la sonda) ⇒ Map vacío y ninguna lectura de lote', async () => {
    const { sb, llamadas } = armar((l) =>
      esSonda(l)
        ? {
            data: null,
            error: {
              code: '42703',
              message: 'column vuelo.consecutivo_cliente does not exist',
            },
          }
        : { data: [], error: null },
    );
    const r = await clavesClienteDeVuelos(sb, [vid(1)]);
    expect(r.size).toBe(0);
    expect(lecturasDeLote(llamadas)).toHaveLength(0);
    expect(warnsLectura()).toHaveLength(0);
  });

  it('arma el ID por vuelo: embed objeto o arreglo, día Cancún y sin fecha', async () => {
    const { sb, llamadas } = armar(
      mundo([
        {
          id: vid(364),
          fecha_vuelo: '2026-10-01T15:00:00+00:00',
          consecutivo_cliente: 5,
          cliente: { alias: 'beh' },
        },
        {
          id: vid(376),
          fecha_vuelo: '2026-10-21T14:00:00+00:00',
          consecutivo_cliente: '2',
          cliente: [{ alias: 'january' }],
        },
        {
          id: vid(166),
          fecha_vuelo: null,
          consecutivo_cliente: 10,
          cliente: { alias: 'francisco' },
        },
      ]),
    );
    const r = await clavesClienteDeVuelos(sb, [vid(364), vid(376), vid(166)]);
    expect([...r.entries()]).toEqual([
      [vid(364), 'beh05-011026'],
      [vid(376), 'january02-211026'],
      [vid(166), 'francisco10'],
    ]);
    const [lectura] = lecturasDeLote(llamadas);
    expect(lectura.ops).toContainEqual([
      'select',
      'id, fecha_vuelo, consecutivo_cliente, cliente:cliente_id(alias)',
    ]);
  });

  it('sin alias, alias inválido o sin número ⇒ ESA fila no entra', async () => {
    const { sb } = armar(
      mundo([
        {
          id: vid(1),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: 1,
          cliente: null,
        },
        {
          id: vid(2),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: 1,
          cliente: { alias: 'Diego' },
        },
        {
          id: vid(3),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: null,
          cliente: { alias: 'diego' },
        },
        {
          id: vid(4),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: 4,
          cliente: { alias: 'diego' },
        },
      ]),
    );
    const r = await clavesClienteDeVuelos(sb, [vid(1), vid(2), vid(3), vid(4)]);
    expect([...r.entries()]).toEqual([[vid(4), 'diego04-131026']]);
  });

  it('151 ids ⇒ DOS lecturas en paralelo, de 150 y de 1', async () => {
    const ids = Array.from({ length: 151 }, (_, i) => vid(i + 1));
    const { sb, llamadas } = armar(
      mundo(
        ids.map((id, i) => ({
          id,
          fecha_vuelo: null,
          consecutivo_cliente: i + 1,
          cliente: { alias: 'mike' },
        })),
      ),
    );
    const r = await clavesClienteDeVuelos(sb, ids);
    expect(r.size).toBe(151);
    expect(r.get(vid(151))).toBe('mike151');
    const lotes = lecturasDeLote(llamadas).map(
      (l) => (l.ops.find((o) => o[0] === 'in')?.[2] as string[]).length,
    );
    expect(LOTE_IDS_CLAVE).toBe(150);
    expect(lotes).toEqual([150, 1]);
  });

  it('error de PostgREST en el 2.º lote ⇒ Map VACÍO (jamás parcial) y un warn', async () => {
    const ids = Array.from({ length: 151 }, (_, i) => vid(i + 1));
    let n = 0;
    const { sb } = armar((l) => {
      if (esSonda(l)) return { data: [], error: null };
      n += 1;
      if (n === 2) return { data: null, error: { message: 'boom' } };
      return {
        data: ids.map((id) => ({
          id,
          fecha_vuelo: null,
          consecutivo_cliente: 1,
          cliente: { alias: 'mike' },
        })),
        error: null,
      };
    });
    const r = await clavesClienteDeVuelos(sb, ids);
    expect(r.size).toBe(0);
    expect(warnsLectura()).toEqual([
      ['ID de vuelo por cliente: no se pudo leer (boom); se omite'],
    ]);
  });

  it('un cliente sin `.from` (spec viejo) ⇒ Map vacío, sin lanzar', async () => {
    const sb = {} as unknown as SupabaseClient;
    usados.push(sb);
    await expect(clavesClienteDeVuelos(sb, [vid(1)])).resolves.toEqual(
      new Map(),
    );
    expect(warnsLectura()).toHaveLength(1);
    // Ni siquiera sin cliente Supabase.
    await expect(
      clavesClienteDeVuelos(undefined as unknown as SupabaseClient, [vid(1)]),
    ).resolves.toEqual(new Map());
  });

  it('ids duplicados o null se leen UNA vez', async () => {
    const { sb, llamadas } = armar(
      mundo([
        {
          id: vid(1),
          fecha_vuelo: null,
          consecutivo_cliente: 1,
          cliente: { alias: 'diego' },
        },
      ]),
    );
    const r = await clavesClienteDeVuelos(sb, [vid(1), null, vid(1), '']);
    expect(r.get(vid(1))).toBe('diego01');
    const [lectura, ...resto] = lecturasDeLote(llamadas);
    expect(resto).toHaveLength(0);
    expect(lectura.ops.find((o) => o[0] === 'in')).toEqual([
      'in',
      'id',
      [vid(1)],
    ]);
  });
});

describe('vueloIdsPorClaveCliente', () => {
  let warn: jest.SpyInstance;
  const usados: SupabaseClient[] = [];
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const sb of usados.splice(0)) resetColumnasOpcionales(sb);
    jest.restoreAllMocks();
  });
  const armar = (responder: (l: Llamada) => Respuesta) => {
    const f = sbFalso(responder);
    usados.push(f.sb);
    return f;
  };

  it('sin la migración ⇒ [] SIN consultar cliente ni vuelo', async () => {
    const { sb, llamadas } = armar((l) =>
      esSonda(l)
        ? { data: null, error: { code: 'PGRST204', message: 'x' } }
        : { data: [], error: null },
    );
    const r = await vueloIdsPorClaveCliente(sb, {
      alias: 'january',
      consecutivo: 2,
    });
    expect(r).toEqual([]);
    expect(llamadas.filter((l) => !esSonda(l))).toHaveLength(0);
  });

  it('alias sin clientes ⇒ [] tras UNA consulta a cliente', async () => {
    const { sb, llamadas } = armar(() => ({ data: [], error: null }));
    const r = await vueloIdsPorClaveCliente(sb, {
      alias: 'nadie',
      consecutivo: 1,
    });
    expect(r).toEqual([]);
    const sinSonda = llamadas.filter((l) => !esSonda(l));
    expect(sinSonda.map((l) => l.tabla)).toEqual(['cliente']);
    expect(sinSonda[0].ops).toEqual([
      ['select', 'id'],
      ['eq', 'alias', 'nadie'],
      ['limit', 50],
    ]);
  });

  it('con clientes ⇒ los ids de sus vuelos con ese número (in cliente_id + eq consecutivo + limit 50)', async () => {
    const { sb, llamadas } = armar((l) => {
      if (esSonda(l)) return { data: [], error: null };
      if (l.tabla === 'cliente') {
        return { data: [{ id: 'cli-jan' }, { id: 'cli-jan2' }], error: null };
      }
      return { data: [{ id: vid(376) }], error: null };
    });
    const r = await vueloIdsPorClaveCliente(sb, {
      alias: 'january',
      consecutivo: 2,
    });
    expect(r).toEqual([vid(376)]);
    const vuelo = llamadas.filter((l) => !esSonda(l) && l.tabla === 'vuelo');
    expect(vuelo).toHaveLength(1);
    expect(vuelo[0].ops).toEqual([
      ['select', 'id'],
      ['in', 'cliente_id', ['cli-jan', 'cli-jan2']],
      ['eq', 'consecutivo_cliente', 2],
      ['limit', 50],
    ]);
  });

  it('error ⇒ [] y warn, sin lanzar', async () => {
    const { sb } = armar((l) =>
      esSonda(l)
        ? { data: [], error: null }
        : { data: null, error: { message: 'timeout' } },
    );
    await expect(
      vueloIdsPorClaveCliente(sb, { alias: 'january', consecutivo: 2 }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'ID de vuelo por cliente: no se pudo buscar «january2» (timeout); la búsqueda sigue sin él',
    );
  });
});

/**
 * CONSECUTIVO DEL VUELO POR CLIENTE PARA LOS DOCUMENTOS (23-oct-2026, API
 * 0.0.105, invariante 106): la misma lectura (sonda + lotes de 150, todo o
 * nada, nunca lanza), pero devuelve el NÚMERO (`vuelo.consecutivo_cliente`)
 * sin exigir alias: es la columna CONSECUTIVO de balances, Dinero, AFAC,
 * reparto y listas del cierre, que ya no imprimen el ID.
 */
describe('consecutivosClienteDeVuelos (documentos)', () => {
  let warn: jest.SpyInstance;
  const usados: SupabaseClient[] = [];
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const sb of usados.splice(0)) resetColumnasOpcionales(sb);
    jest.restoreAllMocks();
  });
  const armar = (responder: (l: Llamada) => Respuesta) => {
    const f = sbFalso(responder);
    usados.push(f.sb);
    return f;
  };
  const warnsLectura = () =>
    (warn.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).startsWith(
        'Consecutivo de vuelo por cliente: no se pudo leer',
      ),
    );

  it('sin ids ⇒ Map vacío y CERO consultas (ni la sonda)', async () => {
    const { sb, llamadas } = armar(mundo([]));
    expect(await consecutivosClienteDeVuelos(sb, [])).toEqual(new Map());
    expect(await consecutivosClienteDeVuelos(sb, [null, ''])).toEqual(
      new Map(),
    );
    expect(llamadas).toHaveLength(0);
  });

  it('sin la migración (42703 en la sonda) ⇒ Map vacío sin lectura de lote ni warn', async () => {
    const { sb, llamadas } = armar((l) =>
      esSonda(l)
        ? {
            data: null,
            error: {
              code: '42703',
              message: 'column vuelo.consecutivo_cliente does not exist',
            },
          }
        : { data: [], error: null },
    );
    expect((await consecutivosClienteDeVuelos(sb, [vid(1)])).size).toBe(0);
    expect(lecturasDeLote(llamadas)).toHaveLength(0);
    expect(warnsLectura()).toHaveLength(0);
  });

  it('el número por vuelo: number o string de dígitos; SIN exigir alias ni fecha; inválidos fuera', async () => {
    const { sb, llamadas } = armar(
      mundo([
        {
          id: vid(364),
          fecha_vuelo: '2026-10-01T15:00:00+00:00',
          consecutivo_cliente: 5,
          cliente: { alias: 'beh' },
        },
        {
          id: vid(376),
          fecha_vuelo: null,
          consecutivo_cliente: '2',
          cliente: null,
        },
        {
          id: vid(2),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: 1,
          cliente: { alias: 'Diego' },
        },
        {
          id: vid(3),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: null,
          cliente: { alias: 'diego' },
        },
        {
          id: vid(4),
          fecha_vuelo: '2026-10-13',
          consecutivo_cliente: 0,
          cliente: { alias: 'diego' },
        },
      ]),
    );
    const r = await consecutivosClienteDeVuelos(sb, [
      vid(364),
      vid(376),
      vid(2),
      vid(3),
      vid(4),
    ]);
    expect([...r.entries()]).toEqual([
      [vid(364), 5],
      [vid(376), 2],
      [vid(2), 1],
    ]);
    // La MISMA lectura que el ID (una sola consulta por lote).
    const [lectura] = lecturasDeLote(llamadas);
    expect(lectura.ops).toContainEqual([
      'select',
      'id, fecha_vuelo, consecutivo_cliente, cliente:cliente_id(alias)',
    ]);
  });

  it('151 ids ⇒ lotes de 150 y de 1; error en un lote ⇒ Map VACÍO (jamás parcial) y un warn', async () => {
    const ids = Array.from({ length: 151 }, (_, i) => vid(i + 1));
    const ok = armar(
      mundo(ids.map((id, i) => ({ id, consecutivo_cliente: i + 1 }))),
    );
    const r = await consecutivosClienteDeVuelos(ok.sb, ids);
    expect(r.size).toBe(151);
    expect(r.get(vid(151))).toBe(151);
    expect(
      lecturasDeLote(ok.llamadas).map(
        (l) => (l.ops.find((o) => o[0] === 'in')?.[2] as string[]).length,
      ),
    ).toEqual([150, 1]);

    let n = 0;
    const mal = armar((l) => {
      if (esSonda(l)) return { data: [], error: null };
      n += 1;
      if (n === 2) return { data: null, error: { message: 'boom' } };
      return {
        data: ids.map((id) => ({ id, consecutivo_cliente: 1 })),
        error: null,
      };
    });
    expect((await consecutivosClienteDeVuelos(mal.sb, ids)).size).toBe(0);
    expect(warnsLectura()).toEqual([
      ['Consecutivo de vuelo por cliente: no se pudo leer (boom); se omite'],
    ]);
  });

  it('un cliente sin `.from` ⇒ Map vacío con warn, sin lanzar', async () => {
    const sb = {} as unknown as SupabaseClient;
    usados.push(sb);
    await expect(consecutivosClienteDeVuelos(sb, [vid(1)])).resolves.toEqual(
      new Map(),
    );
    expect(warnsLectura()).toHaveLength(1);
  });
});
