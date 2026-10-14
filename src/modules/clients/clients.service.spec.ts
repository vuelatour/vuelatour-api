import { Logger } from '@nestjs/common';
import { ClientsService } from './clients.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { MENSAJE_ALIAS_INVALIDO } from '../../common/clave-cliente.util';
import {
  MENSAJE_ID_CLIENTE_NO_DISPONIBLE,
  MIGRACION_ID_CLIENTE,
} from '../../common/id-cliente-disponible.util';

/**
 * CLIENTES + ID DE VUELO POR CLIENTE (13-oct-2026, API 0.0.75, invariante
 * 68). La sonda (`vuelo.consecutivo_cliente`) decide TODO: con la migración
 * la fila suma `alias` y `alias_compartido_con`, `q` busca en el alias y la
 * lista dice `alias_disponible: true`; sin ella, las filas son byte a byte
 * las del 0.0.74 y un `alias` en el body es 503 ANTES de escribir.
 *
 * La BD es en memoria: interpreta `eq/neq/in` sobre `cliente`, registra cada
 * consulta (tabla + operaciones) y deja inyectar errores.
 */

const COLS =
  'id, nombre, telefono, email, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal, domicilio_fiscal, pais_residencia, canal_origen, es_broker, es_interno, notas, activo, created_at, updated_at';

type Fila = Record<string, unknown>;
type Op = [string, ...unknown[]];
interface Llamada {
  tabla: string;
  ops: Op[];
}
interface ErrorPg {
  code?: string;
  message: string;
}

const ID_DIEGO = 'cccccccc-0000-4000-8000-000000000001';
const ID_JCHACON = 'cccccccc-0000-4000-8000-000000000002';

/** Juan ×4 + Victor ×3 de prod (resumidos) + Diego, sin repetir alias. */
function catalogo(): Fila[] {
  const c = (id: string, nombre: string, alias: string, activo = true) => ({
    id,
    nombre,
    alias,
    activo,
  });
  return [
    c(ID_DIEGO, 'Diego Ramírez', 'diego'),
    c(ID_JCHACON, 'Juan Chacon', 'juan'),
    c(
      'cccccccc-0000-4000-8000-000000000003',
      'Juan Pablo Morales Patriot',
      'juan',
    ),
    c('cccccccc-0000-4000-8000-000000000004', '  Juan Satin ', 'juan', false),
    c('cccccccc-0000-4000-8000-000000000005', 'Juan Satin', 'juan'),
    c('cccccccc-0000-4000-8000-000000000006', 'Ángel Álvarez', 'juan'),
    c('cccccccc-0000-4000-8000-000000000007', 'Zoe Juan', 'juan'),
    c('cccccccc-0000-4000-8000-000000000008', 'Éder Juan', 'juan'),
  ];
}

function bd(opts: {
  migracion: boolean;
  clientes?: Fila[];
  /** Error para la consulta que cumpla el predicado. */
  falla?: (l: Llamada) => ErrorPg | null;
  /** Fila que devuelve un insert/update (default: el payload + id). */
  escrita?: (payload: Fila) => Fila;
}) {
  const llamadas: Llamada[] = [];
  const clientes = opts.clientes ?? catalogo();
  const from = (tabla: string) => {
    const llamada: Llamada = { tabla, ops: [] };
    llamadas.push(llamada);
    const filtros: Array<(f: Fila) => boolean> = [];
    let unica = false;
    let payload: Fila | null = null;
    const b: Record<string, unknown> = {};
    const reg =
      (op: string, filtro?: (...a: unknown[]) => (f: Fila) => boolean) =>
      (...args: unknown[]) => {
        llamada.ops.push([op, ...args]);
        if (filtro) filtros.push(filtro(...args));
        return b;
      };
    b.select = reg('select');
    b.order = reg('order');
    b.range = reg('range');
    b.limit = reg('limit');
    b.or = reg('or');
    b.eq = reg('eq', (c, v) => (f) => f[c as string] === v);
    b.neq = reg('neq', (c, v) => (f) => f[c as string] !== v);
    b.in = reg(
      'in',
      (c, vs) => (f) => (vs as unknown[]).includes(f[c as string]),
    );
    b.insert = (p: Fila) => {
      payload = p;
      llamada.ops.push(['insert', p]);
      return b;
    };
    b.update = (p: Fila) => {
      payload = p;
      llamada.ops.push(['update', p]);
      return b;
    };
    b.maybeSingle = () => {
      unica = true;
      llamada.ops.push(['maybeSingle']);
      return b;
    };
    const ejecutar = () => {
      const esSonda =
        tabla === 'vuelo' &&
        llamada.ops.some(
          (o) => o[0] === 'select' && o[1] === 'consecutivo_cliente',
        );
      if (esSonda) {
        return opts.migracion
          ? { data: [], error: null }
          : {
              data: null,
              error: {
                code: '42703',
                message: 'column vuelo.consecutivo_cliente does not exist',
              },
            };
      }
      const error = opts.falla?.(llamada) ?? null;
      if (error) return { data: null, error, count: null };
      if (payload) {
        const fila = opts.escrita
          ? opts.escrita(payload)
          : { id: ID_DIEGO, ...payload };
        return { data: fila, error: null };
      }
      const filas = clientes.filter((f) => filtros.every((fn) => fn(f)));
      return unica
        ? { data: filas[0] ?? null, error: null }
        : { data: filas, error: null, count: filas.length };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(res, rej);
    return b;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return { svc: new ClientsService(supabase), llamadas };
}

const selectDe = (l: Llamada | undefined) =>
  l?.ops.find((o) => o[0] === 'select')?.[1];
/** Consultas a `cliente` (sin la sonda ni las de alias compartido). */
const principales = (ls: Llamada[]) =>
  ls.filter(
    (l) =>
      l.tabla === 'cliente' &&
      selectDe(l) !== 'id, nombre, alias' &&
      selectDe(l) !== 'id, nombre, activo',
  );
const escrituras = (ls: Llamada[]) =>
  ls.filter((l) => l.ops.some((o) => o[0] === 'insert' || o[0] === 'update'));

const LISTA = { limit: 50, offset: 0 } as const;

describe('ClientsService — CON la migración del ID por cliente', () => {
  it('list: select COLS + alias, q busca también en el alias y alias_disponible: true AL FINAL', async () => {
    const { svc, llamadas } = bd({ migracion: true });
    const r = await svc.list({ ...LISTA, q: 'juan' });
    const [lista] = principales(llamadas);
    expect(selectDe(lista)).toBe(`${COLS}, alias`);
    const or = lista.ops.find((o) => o[0] === 'or')?.[1];
    expect(or).toBe(
      'nombre.ilike.%juan%,email.ilike.%juan%,telefono.ilike.%juan%,rfc.ilike.%juan%,alias.ilike.%juan%',
    );
    expect(Object.keys(r)).toEqual([
      'data',
      'count',
      'limit',
      'offset',
      'alias_disponible',
    ]);
    expect(r.alias_disponible).toBe(true);
    for (const f of r.data) expect(f).toHaveProperty('alias_compartido_con');
  });

  it('alias_compartido_con: OTROS clientes (sin sí mismo), inactivos incluidos, orden es-MX, máximo 5; [] si nadie', async () => {
    const { svc } = bd({ migracion: true });
    const r = await svc.list(LISTA);
    const por = new Map(r.data.map((f) => [f.id, f.alias_compartido_con]));
    // Diego: nadie más usa «diego».
    expect(por.get(ID_DIEGO)).toEqual([]);
    // Juan Chacon: los otros 6 «juan», recortados y en orden es-MX (Á/É
    // junto a A/E), solo 5. Juan Satin (inactivo) entra; él mismo no.
    expect(por.get(ID_JCHACON)).toEqual([
      'Ángel Álvarez',
      'Éder Juan',
      'Juan Pablo Morales Patriot',
      'Juan Satin',
      'Juan Satin',
    ]);
  });

  it('alias_compartido_con: UNA lectura con todos los alias de la página (activos e inactivos)', async () => {
    const { svc, llamadas } = bd({ migracion: true });
    await svc.list(LISTA);
    const compartido = llamadas.filter(
      (l) => selectDe(l) === 'id, nombre, alias',
    );
    expect(compartido).toHaveLength(1);
    const op = compartido[0].ops.find((o) => o[0] === 'in');
    expect(op?.[1]).toBe('alias');
    expect([...(op?.[2] as string[])].sort()).toEqual(['diego', 'juan']);
    // Sin filtro de `activo`: el aviso cubre todo el catálogo.
    expect(compartido[0].ops.some((o) => o[0] === 'eq')).toBe(false);
  });

  it('si la lectura de alias compartidos falla ⇒ null en TODAS las filas (jamás un [] falso) y warn', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { svc } = bd({
      migracion: true,
      falla: (l) =>
        selectDe(l) === 'id, nombre, alias' ? { message: 'boom' } : null,
    });
    const r = await svc.list(LISTA);
    expect(r.data.length).toBeGreaterThan(0);
    for (const f of r.data) expect(f.alias_compartido_con).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'alias_compartido_con: no se pudo leer (boom); se omite',
    );
    warn.mockRestore();
  });

  it('findById, create y update: select con alias y la fila con alias_compartido_con', async () => {
    const { svc, llamadas } = bd({
      migracion: true,
      escrita: (p) => ({
        id: ID_JCHACON,
        nombre: 'Juan Chacon',
        alias: 'juan',
        ...p,
      }),
    });
    const uno = await svc.findById(ID_JCHACON);
    expect(uno.alias).toBe('juan');
    expect((uno.alias_compartido_con as string[]).length).toBe(5);
    const nuevo = await svc.create({ nombre: 'Diego Ramírez Dos' }, 'u-1');
    expect(nuevo).toHaveProperty('alias_compartido_con');
    const editado = await svc.update(ID_JCHACON, { alias: 'jchacon' }, 'u-1');
    expect(editado.alias).toBe('jchacon');
    expect(editado.alias_compartido_con).toEqual([]);
    for (const l of principales(llamadas)) {
      expect(selectDe(l)).toBe(`${COLS}, alias`);
    }
  });

  it('update({ alias: null }) manda alias null (el trigger vuelve al sugerido)', async () => {
    const { svc, llamadas } = bd({ migracion: true });
    await svc.update(ID_DIEGO, { alias: null }, 'u-1');
    const [w] = escrituras(llamadas);
    expect(w.ops.find((o) => o[0] === 'update')?.[1]).toEqual({
      alias: null,
      updated_by: 'u-1',
    });
  });

  it('23514 del CHECK cliente_alias_chk ⇒ 400 ALIAS_INVALIDO con el mensaje exacto (create y update)', async () => {
    const chk = {
      code: '23514',
      message:
        'new row for relation "cliente" violates check constraint "cliente_alias_chk"',
    };
    const { svc } = bd({
      migracion: true,
      falla: (l) => (escrituras([l]).length ? chk : null),
    });
    for (const intento of [
      () => svc.create({ nombre: 'X', alias: 'x' }, 'u-1'),
      () => svc.update(ID_DIEGO, { alias: 'x' }, 'u-1'),
    ]) {
      await expect(intento()).rejects.toMatchObject({
        status: 400,
        response: { error: 'ALIAS_INVALIDO', message: MENSAJE_ALIAS_INVALIDO },
      });
    }
  });

  it('OTRO 23514 se comporta como hoy (error crudo, no ALIAS_INVALIDO)', async () => {
    const otro = {
      code: '23514',
      message:
        'new row for relation "cliente" violates check constraint "otro_chk"',
    };
    const { svc } = bd({
      migracion: true,
      falla: (l) => (escrituras([l]).length ? otro : null),
    });
    await expect(svc.update(ID_DIEGO, { notas: 'x' }, 'u-1')).rejects.toThrow(
      otro.message,
    );
    await expect(
      svc.update(ID_DIEGO, { notas: 'x' }, 'u-1'),
    ).rejects.not.toMatchObject({ status: 400 });
  });

  it('aliasEnUso: eq alias + neq excluir + order nombre, activos e inactivos', async () => {
    const { svc, llamadas } = bd({ migracion: true });
    const r = await svc.aliasEnUso('juan', ID_JCHACON);
    expect(r.alias).toBe('juan');
    expect(r.clientes).toHaveLength(6);
    expect(r.clientes.map((c) => c.id)).not.toContain(ID_JCHACON);
    expect(r.clientes.find((c) => c.activo === false)?.nombre).toBe(
      '  Juan Satin ',
    );
    const l = llamadas.find((x) => selectDe(x) === 'id, nombre, activo')!;
    expect(l.ops).toEqual([
      ['select', 'id, nombre, activo'],
      ['eq', 'alias', 'juan'],
      ['order', 'nombre', { ascending: true }],
      ['neq', 'id', ID_JCHACON],
    ]);
    // Sin excluir: no hay neq.
    llamadas.length = 0;
    await svc.aliasEnUso('diego');
    const sinExcluir = llamadas.find(
      (x) => selectDe(x) === 'id, nombre, activo',
    )!;
    expect(sinExcluir.ops.some((o) => o[0] === 'neq')).toBe(false);
  });
});

describe('ClientsService — SIN la migración (API 0.0.75 antes de aplicarla)', () => {
  it('list: COLS byte a byte, sin alias en q, filas sin llaves nuevas y alias_disponible: false', async () => {
    const { svc, llamadas } = bd({
      migracion: false,
      clientes: [{ id: ID_DIEGO, nombre: 'Diego Ramírez', activo: true }],
    });
    const r = await svc.list({ ...LISTA, q: 'die' });
    const [lista] = principales(llamadas);
    expect(selectDe(lista)).toBe(COLS);
    expect(lista.ops.find((o) => o[0] === 'or')?.[1]).toBe(
      'nombre.ilike.%die%,email.ilike.%die%,telefono.ilike.%die%,rfc.ilike.%die%',
    );
    expect(r.data).toEqual([
      { id: ID_DIEGO, nombre: 'Diego Ramírez', activo: true },
    ]);
    expect(r.alias_disponible).toBe(false);
    // Ni una lectura de alias compartidos.
    expect(llamadas.some((l) => selectDe(l) === 'id, nombre, alias')).toBe(
      false,
    );
  });

  it('findById / create / update sin alias: COLS de siempre y sin llaves nuevas', async () => {
    const { svc, llamadas } = bd({
      migracion: false,
      clientes: [{ id: ID_DIEGO, nombre: 'Diego Ramírez', activo: true }],
    });
    const uno = await svc.findById(ID_DIEGO);
    expect(uno).not.toHaveProperty('alias_compartido_con');
    const nuevo = await svc.create({ nombre: 'Otro' }, 'u-1');
    expect(nuevo).not.toHaveProperty('alias_compartido_con');
    await svc.update(ID_DIEGO, { notas: 'x' }, 'u-1');
    for (const l of principales(llamadas)) expect(selectDe(l)).toBe(COLS);
  });

  it.each([
    [
      'create con alias',
      (s: ClientsService) => s.create({ nombre: 'X', alias: 'diego' }, 'u-1'),
    ],
    [
      'create con alias null',
      (s: ClientsService) => s.create({ nombre: 'X', alias: null }, 'u-1'),
    ],
    [
      'update con alias',
      (s: ClientsService) => s.update(ID_DIEGO, { alias: 'diego' }, 'u-1'),
    ],
    [
      'update con alias null',
      (s: ClientsService) => s.update(ID_DIEGO, { alias: null }, 'u-1'),
    ],
  ])('%s ⇒ 503 ID_CLIENTE_NO_DISPONIBLE SIN escribir', async (_n, intento) => {
    const { svc, llamadas } = bd({ migracion: false });
    await expect(intento(svc)).rejects.toMatchObject({
      status: 503,
      response: {
        error: 'ID_CLIENTE_NO_DISPONIBLE',
        message: MENSAJE_ID_CLIENTE_NO_DISPONIBLE,
        details: { migracion: MIGRACION_ID_CLIENTE },
      },
    });
    expect(escrituras(llamadas)).toHaveLength(0);
  });

  it('aliasEnUso ⇒ 503 sin consultar cliente', async () => {
    const { svc, llamadas } = bd({ migracion: false });
    await expect(svc.aliasEnUso('juan')).rejects.toMatchObject({
      status: 503,
    });
    expect(llamadas.some((l) => l.tabla === 'cliente')).toBe(false);
  });
});
