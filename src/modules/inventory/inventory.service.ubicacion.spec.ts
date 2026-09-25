jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// notifications arrastra el gateway y `jose` (ESM), que jest no parsea.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InventoryService, LOTE_IDS_INVENTARIO } from './inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  ListUbicacionesQuery,
  type ListInventarioQuery,
} from './dto/inventory.dto';

/**
 * UBICACIONES DE BODEGA (25-sep-2026, migración 20260925000001) sobre un
 * PostgREST FALSO en memoria: el catálogo, mover en lote, la regla de
 * ubicación en createItem/updateItem (catálogo gana; texto viejo se liga si
 * coincide, si no queda «(anterior)»; jamás se adivina «Bodega Cancún»), la
 * lista con sus llaves nuevas y el Excel. Y la tolerancia: sin la migración,
 * todo como el API 0.0.34 y 503 en lo nuevo.
 */

type Fila = Record<string, unknown>;
type Err = { code?: string; message: string } | null;
type Op = { m: string; a: unknown[] };

interface Opciones {
  migracion?: boolean;
  /** Error forzado en el UPDATE de inventario_ubicacion (simula el trigger). */
  errorUpdateUbicacion?: Err;
}

class Fake {
  tablas: Record<string, Fila[]>;
  escrituras: Array<{
    tabla: string;
    tipo: string;
    ops: Op[];
    payload: unknown;
  }> = [];
  private seq = 0;
  constructor(
    tablas: Record<string, Fila[]>,
    private readonly o: Opciones = {},
  ) {
    this.tablas = tablas;
  }

  /** Espejo del trigger: con ubicacion_id, el texto es el nombre del catálogo. */
  private espejo(row: Fila) {
    if (row.ubicacion_id) {
      const u = this.tablas.inventario_ubicacion.find(
        (x) => x.id === row.ubicacion_id,
      );
      row.ubicacion = u ? u.nombre : null;
    }
  }

  from(tabla: string) {
    const ops: Op[] = [];
    let tipo: 'select' | 'insert' | 'update' = 'select';
    let payload: unknown = null;
    let conCount = false;
    const q: Record<string, unknown> = {};
    const reg =
      (m: string) =>
      (...a: unknown[]) => {
        ops.push({ m, a });
        if (m === 'insert') {
          tipo = 'insert';
          payload = a[0];
        }
        if (m === 'update') {
          tipo = 'update';
          payload = a[0];
        }
        if (m === 'select' && (a[1] as { count?: string })?.count) {
          conCount = true;
        }
        return q;
      };
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = reg(m);
    }
    const filtra = (rows: Fila[]) =>
      rows.filter((r) =>
        ops.every((op) => {
          const [c, v, w] = op.a as [string, unknown, unknown];
          if (op.m === 'eq') return r[c] === v;
          if (op.m === 'neq') return r[c] !== v;
          if (op.m === 'in') return (v as unknown[]).includes(r[c]);
          if (op.m === 'is') return (r[c] ?? null) === v;
          if (op.m === 'not') return v === 'is' ? (r[c] ?? null) !== w : true;
          return true;
        }),
      );
    const resolver = (): { data: unknown; error: Err; count?: number } => {
      const sel = ops.find((x) => x.m === 'select')?.a[0];
      // Sonda de la columna opcional.
      if (
        tipo === 'select' &&
        tabla === 'inventario_item' &&
        sel === 'ubicacion_id' &&
        ops.some((x) => x.m === 'limit')
      ) {
        return this.o.migracion === false
          ? {
              data: null,
              error: {
                code: '42703',
                message: 'column inventario_item.ubicacion_id does not exist',
              },
            }
          : { data: [], error: null };
      }
      const rows = (this.tablas[tabla] ??= []);
      if (tipo === 'insert') {
        this.escrituras.push({ tabla, tipo, ops, payload });
        const nuevo: Fila = {
          id: `${tabla}-${++this.seq}`,
          activo: true,
          created_at: '2026-09-25T15:00:00Z',
          updated_at: '2026-09-25T15:00:00Z',
          ...(payload as Fila),
        };
        if (tabla === 'inventario_ubicacion') {
          const k = String(nuevo.nombre).toLowerCase();
          if (rows.some((r) => String(r.nombre).toLowerCase() === k)) {
            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "uq_inventario_ubicacion_nombre"',
              },
            };
          }
        }
        if (tabla === 'inventario_item') this.espejo(nuevo);
        rows.push(nuevo);
        return { data: { ...nuevo }, error: null };
      }
      if (tipo === 'update') {
        this.escrituras.push({ tabla, tipo, ops, payload });
        if (tabla === 'inventario_ubicacion' && this.o.errorUpdateUbicacion) {
          return { data: null, error: this.o.errorUpdateUbicacion };
        }
        const hits = filtra(rows);
        for (const r of hits) {
          Object.assign(r, payload as Fila);
          if (tabla === 'inventario_item') this.espejo(r);
          if (tabla === 'inventario_ubicacion' && (payload as Fila).nombre) {
            for (const it of this.tablas.inventario_item ?? []) {
              if (it.ubicacion_id === r.id) it.ubicacion = r.nombre;
            }
          }
        }
        const out = hits.map((r) => ({ ...r }));
        return {
          data: ops.some((x) => x.m === 'select') ? out : null,
          error: null,
        };
      }
      let out = filtra(rows).map((r) => ({ ...r }));
      const orders = ops.filter((x) => x.m === 'order').reverse();
      for (const o of orders) {
        const [c, opt] = o.a as [string, { ascending?: boolean }];
        const dir = opt?.ascending === false ? -1 : 1;
        out = [...out].sort((a, b) =>
          a[c] === b[c] ? 0 : (a[c] as string) < (b[c] as string) ? -dir : dir,
        );
      }
      const total = out.length;
      const range = ops.find((x) => x.m === 'range');
      if (range) {
        const [a, b] = range.a as [number, number];
        out = out.slice(a, b + 1);
      }
      return { data: out, error: null, ...(conCount ? { count: total } : {}) };
    };
    q.maybeSingle = () => {
      const r = resolver();
      const d: unknown = Array.isArray(r.data)
        ? ((r.data as unknown[])[0] ?? null)
        : r.data;
      return Promise.resolve({ ...r, data: d });
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  }
}

const CATALOGO = (): Fila[] => [
  { id: 'u-vieja', nombre: 'Oficina vieja', orden: 1, activo: true },
  { id: 'u-nueva', nombre: 'Oficina nueva', orden: 2, activo: true },
  { id: 'u-locker', nombre: 'Locker del aeropuerto', orden: 3, activo: true },
  {
    id: 'u-mer',
    nombre: 'Bodega del taller de Mérida',
    orden: 4,
    activo: true,
  },
  {
    id: 'u-czm',
    nombre: 'Bodega del taller de Cozumel',
    orden: 5,
    activo: true,
  },
  { id: 'u-baja', nombre: 'Hangar 3', orden: 6, activo: false },
];

const ITEMS = (): Fila[] => [
  {
    id: 'i-aceite',
    nombre: 'Aceite 15W-50',
    categoria: 'Aceites',
    ubicacion: 'Bodega Cancún',
    ubicacion_id: null,
    activo: true,
    stock_minimo: 0,
  },
  {
    id: 'i-balata',
    nombre: 'Balata 66-105',
    categoria: 'Frenos',
    ubicacion: 'Oficina nueva',
    ubicacion_id: 'u-nueva',
    activo: true,
    stock_minimo: 0,
  },
  {
    id: 'i-pitot',
    nombre: 'Cubre pitot',
    categoria: 'Otros',
    ubicacion: 'Corner',
    ubicacion_id: null,
    activo: true,
    stock_minimo: 0,
  },
  {
    id: 'i-baja',
    nombre: 'Producto dado de baja',
    categoria: 'Otros',
    ubicacion: 'Hangar 3',
    ubicacion_id: 'u-baja',
    activo: false,
    stock_minimo: 0,
  },
  {
    id: 'i-hangar',
    nombre: 'Producto en ubicación inactiva',
    categoria: 'Otros',
    ubicacion: 'Hangar 3',
    ubicacion_id: 'u-baja',
    activo: true,
    stock_minimo: 0,
  },
];

function armar(o: Opciones & { tablas?: Record<string, Fila[]> } = {}) {
  const sinCol = (rows: Fila[]) =>
    o.migracion === false
      ? rows.map((r) => {
          const copia = { ...r };
          delete copia.ubicacion_id;
          return copia;
        })
      : rows;
  const fake = new Fake(
    o.tablas ?? {
      inventario_ubicacion: o.migracion === false ? [] : CATALOGO(),
      inventario_item: sinCol(ITEMS()),
      inventario_movimiento: [],
      inventario_item_empaque: [],
    },
    o,
  );
  const tablaXlsx: { payload: unknown } = { payload: null };
  const pyservices = {
    generateTablaXlsx: (p: unknown) => {
      tablaXlsx.payload = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
  };
  const svc = new InventoryService(
    {
      service: { from: (t: string) => fake.from(t) },
    } as unknown as SupabaseService,
    pyservices as never,
  );
  return { svc, fake, tablaXlsx };
}

const q = (x: Partial<ListInventarioQuery> = {}): ListInventarioQuery => ({
  limit: 100,
  offset: 0,
  ...x,
});

async function error(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('no lanzó');
}

describe('Ubicaciones: catálogo', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('GET: activas por orden con sus productos ACTIVOS; incluir_inactivas trae la desactivada', async () => {
    const { svc } = armar();
    const activas = await svc.listUbicaciones();
    expect(activas.map((u) => u.nombre)).toEqual([
      'Oficina vieja',
      'Oficina nueva',
      'Locker del aeropuerto',
      'Bodega del taller de Mérida',
      'Bodega del taller de Cozumel',
    ]);
    expect(activas.find((u) => u.id === 'u-nueva')?.productos).toBe(1);
    expect(activas.find((u) => u.id === 'u-vieja')?.productos).toBe(0);
    const todas = await svc.listUbicaciones(true);
    // El dado de baja NO cuenta; el activo en la inactiva sí.
    expect(todas.find((u) => u.id === 'u-baja')).toMatchObject({
      activo: false,
      productos: 1,
    });
  });

  it('POST: duplicado sin acentos/mayúsculas ⇒ 409 UBICACION_DUPLICADA; alta al final del orden', async () => {
    const { svc } = armar();
    const e = await error(
      svc.createUbicacion({ nombre: 'bodega del taller de MERIDA' }, 'u-1'),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({
      error: 'UBICACION_DUPLICADA',
      message: 'Ya existe la ubicación «Bodega del taller de Mérida».',
    });
    const nueva = await svc.createUbicacion(
      { nombre: '  Bodega   Tulum ' },
      'u-1',
    );
    expect(nueva).toMatchObject({
      nombre: 'Bodega Tulum',
      orden: 7,
      activo: true,
      productos: 0,
    });
  });

  it('PATCH: 404 si no existe; renombrar a un nombre ocupado ⇒ 409; renombrar propaga a sus productos', async () => {
    const { svc, fake } = armar();
    expect(
      await error(svc.updateUbicacion('u-nada', { orden: 3 }, 'u-1')),
    ).toBeInstanceOf(NotFoundException);
    const dup = await error(
      svc.updateUbicacion('u-vieja', { nombre: 'OFICINA NUEVA' }, 'u-1'),
    );
    expect((dup as ConflictException).getResponse()).toMatchObject({
      error: 'UBICACION_DUPLICADA',
    });
    const r = await svc.updateUbicacion(
      'u-nueva',
      { nombre: 'Oficina nueva (planta alta)' },
      'u-1',
    );
    expect(r).toMatchObject({
      nombre: 'Oficina nueva (planta alta)',
      productos: 1,
    });
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-balata')?.ubicacion,
    ).toBe('Oficina nueva (planta alta)');
    expect(
      await error(svc.updateUbicacion('u-nueva', {}, 'u-1')),
    ).toBeInstanceOf(BadRequestException);
  });

  it('PATCH activo=false con productos activos ⇒ 409 UBICACION_EN_USO con el conteo; sin productos sí', async () => {
    const { svc, fake } = armar();
    const e = await error(
      svc.updateUbicacion('u-nueva', { activo: false }, 'u-1'),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({
      error: 'UBICACION_EN_USO',
      details: { productos: 1 },
    });
    expect(
      fake.escrituras.filter((w) => w.tabla === 'inventario_ubicacion'),
    ).toHaveLength(0);
    const ok = await svc.updateUbicacion('u-vieja', { activo: false }, 'u-1');
    expect(ok).toMatchObject({ activo: false, productos: 0 });
  });

  it('PATCH: el 23514 del trigger (carrera) ⇒ 409 UBICACION_EN_USO, nunca 500', async () => {
    const { svc } = armar({
      errorUpdateUbicacion: {
        code: '23514',
        message:
          'UBICACION_EN_USO: «Oficina vieja» tiene 2 producto(s) activo(s); muévelos primero a otra ubicación.',
      },
    });
    const e = await error(
      svc.updateUbicacion('u-vieja', { activo: false }, 'u-1'),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({
      error: 'UBICACION_EN_USO',
      details: { productos: 2 },
    });
  });
});

describe('Ubicaciones: mover en lote', () => {
  it('UNA escritura; movidos / sin_cambio / no_encontrados / inactivos', async () => {
    const { svc, fake } = armar();
    const r = await svc.moverUbicacion(
      {
        item_ids: ['i-aceite', 'i-pitot', 'i-balata', 'i-baja', 'i-fantasma'],
        ubicacion_id: 'u-nueva',
      },
      'u-1',
    );
    expect(r).toEqual({
      movidos: 2,
      sin_cambio: 1,
      no_encontrados: ['i-fantasma'],
      inactivos: ['i-baja'],
      ubicacion: { id: 'u-nueva', nombre: 'Oficina nueva' },
    });
    const updates = fake.escrituras.filter(
      (w) => w.tabla === 'inventario_item' && w.tipo === 'update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      ubicacion_id: 'u-nueva',
      updated_by: 'u-1',
    });
    // El espejo escribe el texto del catálogo.
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-aceite'),
    ).toMatchObject({ ubicacion_id: 'u-nueva', ubicacion: 'Oficina nueva' });
    // El dado de baja NO se movió.
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-baja')?.ubicacion_id,
    ).toBe('u-baja');
  });

  it('destino inexistente ⇒ 404; desactivado ⇒ 400 UBICACION_INACTIVA', async () => {
    const { svc } = armar();
    const e404 = await error(
      svc.moverUbicacion({ item_ids: ['i-aceite'], ubicacion_id: 'u-x' }, 'u'),
    );
    expect((e404 as NotFoundException).getResponse()).toMatchObject({
      error: 'UBICACION_NO_EXISTE',
    });
    const e400 = await error(
      svc.moverUbicacion(
        { item_ids: ['i-aceite'], ubicacion_id: 'u-baja' },
        'u',
      ),
    );
    expect((e400 as BadRequestException).getResponse()).toMatchObject({
      error: 'UBICACION_INACTIVA',
      message:
        'La ubicación «Hangar 3» está desactivada; actívala o elige otra.',
    });
  });

  it('500 productos (tope del DTO) ⇒ `in (…)` en lotes de ≤ 150 (la URL de PostgREST revienta con ~200 uuids) y los conteos cuadran', async () => {
    const muchos: Fila[] = Array.from({ length: 500 }, (_, i) => ({
      id: `i-${String(i).padStart(3, '0')}`,
      nombre: `Producto ${i}`,
      categoria: 'Otros',
      ubicacion: 'Bodega Cancún',
      ubicacion_id: i < 7 ? 'u-nueva' : null,
      activo: i !== 499,
      stock_minimo: 0,
    }));
    const { svc, fake } = armar({
      tablas: {
        inventario_ubicacion: CATALOGO(),
        inventario_item: muchos,
        inventario_movimiento: [],
        inventario_item_empaque: [],
      },
    });
    const inSpy: number[] = [];
    const from = fake.from.bind(fake);
    fake.from = (t: string) => {
      const qb = from(t);
      const inOriginal = qb.in as (...a: unknown[]) => unknown;
      qb.in = (c: unknown, v: unknown) => {
        if (t === 'inventario_item') inSpy.push((v as unknown[]).length);
        return inOriginal(c, v);
      };
      return qb;
    };
    const r = await svc.moverUbicacion(
      { item_ids: muchos.map((m) => m.id as string), ubicacion_id: 'u-nueva' },
      'u-1',
    );
    expect(Math.max(...inSpy)).toBeLessThanOrEqual(LOTE_IDS_INVENTARIO);
    expect(r).toMatchObject({
      movidos: 492,
      sin_cambio: 7,
      no_encontrados: [],
      inactivos: ['i-499'],
    });
    expect(
      fake.tablas.inventario_item.filter((i) => i.ubicacion_id === 'u-nueva'),
    ).toHaveLength(499);
  });
});

describe('ListUbicacionesQuery: incluir_inactivas lee el valor CRUDO', () => {
  // main.ts usa enableImplicitConversion: con `({ value })` el texto 'false'
  // ya llegaba convertido a Boolean('false') = true (revisión adversaria
  // 25-sep-2026).
  it.each([
    ['true', true],
    [true, true],
    ['false', false],
    [false, false],
    ['0', false],
    ['1', false],
  ])('%p ⇒ %p', (crudo, esperado) => {
    const o = plainToInstance(
      ListUbicacionesQuery,
      { incluir_inactivas: crudo },
      { enableImplicitConversion: true },
    );
    expect(o.incluir_inactivas).toBe(esperado);
    expect(validateSync(o)).toHaveLength(0);
  });

  it('ausente ⇒ solo activas', () => {
    const o = plainToInstance(
      ListUbicacionesQuery,
      {},
      { enableImplicitConversion: true },
    );
    expect(o.incluir_inactivas).not.toBe(true);
  });
});

describe('Ubicaciones: alta y edición del producto', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const alta = { nombre: 'Filtro', categoria: 'Filtros' };

  it('ubicacion_id GANA al texto; el texto se ignora', async () => {
    const { svc, fake } = armar();
    const it = await svc.createItem(
      { ...alta, ubicacion_id: 'u-mer', ubicacion: 'Oficina vieja' },
      'u-1',
    );
    expect(it).toMatchObject({
      ubicacion: 'Bodega del taller de Mérida',
      ubicacion_id: 'u-mer',
      ubicacion_nombre: 'Bodega del taller de Mérida',
      ubicacion_legado: null,
    });
    const ins = fake.escrituras.find(
      (w) => w.tabla === 'inventario_item' && w.tipo === 'insert',
    )!;
    expect(ins.payload).toMatchObject({ ubicacion_id: 'u-mer' });
  });

  it('solo TEXTO (app vieja): «Bodega del taller de Merida» se liga; «Bodega Cancún» queda como legado', async () => {
    const { svc } = armar();
    expect(
      await svc.createItem(
        { ...alta, ubicacion: 'Bodega del taller de Merida' },
        'u-1',
      ),
    ).toMatchObject({
      ubicacion_id: 'u-mer',
      ubicacion_nombre: 'Bodega del taller de Mérida',
    });
    expect(
      await svc.createItem({ ...alta, ubicacion: 'Bodega Cancún' }, 'u-1'),
    ).toMatchObject({
      ubicacion_id: null,
      ubicacion: 'Bodega Cancún',
      ubicacion_legado: 'Bodega Cancún',
      ubicacion_nombre: null,
    });
  });

  it('sin nada ⇒ SIN ubicación (ya no «Bodega Cancún» por default)', async () => {
    const { svc, fake } = armar();
    const it = await svc.createItem({ ...alta }, 'u-1');
    const ins = fake.escrituras.find(
      (w) => w.tabla === 'inventario_item' && w.tipo === 'insert',
    )!;
    expect(ins.payload).not.toHaveProperty('ubicacion');
    expect(ins.payload).not.toHaveProperty('ubicacion_id');
    expect(it).toMatchObject({
      ubicacion: null,
      ubicacion_id: null,
      ubicacion_nombre: null,
      ubicacion_legado: null,
    });
  });

  it('id inexistente ⇒ 404; inactivo ⇒ 400 en el alta', async () => {
    const { svc } = armar();
    expect(
      await error(svc.createItem({ ...alta, ubicacion_id: 'u-x' }, 'u-1')),
    ).toBeInstanceOf(NotFoundException);
    expect(
      await error(svc.createItem({ ...alta, ubicacion_id: 'u-baja' }, 'u-1')),
    ).toBeInstanceOf(BadRequestException);
  });

  it('PATCH: null ⇒ «Sin ubicación» (id y texto null); la inactiva ACTUAL se acepta; texto vacío ⇒ 400', async () => {
    const { svc, fake } = armar();
    await svc.updateItem('i-balata', { ubicacion_id: null }, 'u-1');
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-balata'),
    ).toMatchObject({ ubicacion_id: null, ubicacion: null });
    // i-hangar ya está en «Hangar 3» (desactivada): re-guardarla no es error…
    await svc.updateItem('i-hangar', { ubicacion_id: 'u-baja' }, 'u-1');
    // …pero llevar OTRO producto ahí sí.
    expect(
      await error(
        svc.updateItem('i-aceite', { ubicacion_id: 'u-baja' }, 'u-1'),
      ),
    ).toBeInstanceOf(BadRequestException);
    expect(
      await error(svc.updateItem('i-aceite', { ubicacion: '  ' }, 'u-1')),
    ).toBeInstanceOf(BadRequestException);
  });

  it('PATCH con solo texto (app vieja): coincide ⇒ id; no coincide ⇒ legado sin id', async () => {
    const { svc, fake } = armar();
    await svc.updateItem(
      'i-aceite',
      { ubicacion: 'locker DEL aeropuerto' },
      'u',
    );
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-aceite'),
    ).toMatchObject({
      ubicacion_id: 'u-locker',
      ubicacion: 'Locker del aeropuerto',
    });
    await svc.updateItem('i-balata', { ubicacion: 'Estante 4' }, 'u');
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-balata'),
    ).toMatchObject({ ubicacion_id: null, ubicacion: 'Estante 4' });
    // La app manda el texto de la ubicación que YA tiene aunque esté inactiva.
    await svc.updateItem('i-hangar', { ubicacion: 'Hangar 3' }, 'u');
    expect(
      fake.tablas.inventario_item.find((i) => i.id === 'i-hangar'),
    ).toMatchObject({ ubicacion_id: 'u-baja' });
  });
});

describe('Ubicaciones: lista y Excel', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('cada ítem trae ubicacion (a mostrar) + ubicacion_id/_nombre/_legado; filtro «sin» e id', async () => {
    const { svc } = armar();
    const r = await svc.listItems(q());
    const porId = new Map(r.data.map((d) => [d.id, d as Fila]));
    expect(porId.get('i-aceite')).toMatchObject({
      ubicacion: 'Bodega Cancún',
      ubicacion_id: null,
      ubicacion_nombre: null,
      ubicacion_legado: 'Bodega Cancún',
    });
    expect(porId.get('i-balata')).toMatchObject({
      ubicacion: 'Oficina nueva',
      ubicacion_id: 'u-nueva',
      ubicacion_nombre: 'Oficina nueva',
      ubicacion_legado: null,
    });
    const sin = await svc.listItems(q({ ubicacion: 'sin' }));
    expect(sin.data.map((d) => d.id).sort()).toEqual(['i-aceite', 'i-pitot']);
    const enNueva = await svc.listItems(q({ ubicacion: 'u-nueva' }));
    expect(enNueva.data.map((d) => d.id)).toEqual(['i-balata']);
    expect(r).toMatchObject({
      utilidad_total_mxn: 0,
      utilidad_total_usd: 0,
      margen_venta_pct: 25,
    });
  });

  it('Excel: Ubicación con «(anterior)» y Utilidad MXN/USD en DOS columnas con totales separados', async () => {
    const mov = (
      id: string,
      item_id: string,
      tipo: string,
      cantidad: number,
      costo: number,
      moneda: 'MXN' | 'USD',
      extra: Fila = {},
    ): Fila => ({
      id,
      item_id,
      tipo,
      cantidad,
      costo_unitario_usd: costo,
      moneda,
      costo_unitario_mxn: moneda === 'MXN' ? costo : null,
      tc_usd_mxn: moneda === 'MXN' ? 18 : null,
      venta_unitaria: null,
      venta_moneda: null,
      para_flota: false,
      fecha_movimiento: '2026-09-01',
      created_at: `2026-09-01T1${id.length}:00:00Z`,
      ...extra,
    });
    const tablas = {
      inventario_ubicacion: CATALOGO(),
      inventario_item: ITEMS(),
      inventario_item_empaque: [],
      inventario_movimiento: [
        mov('e1', 'i-aceite', 'ENTRADA', 10, 21.25, 'USD', {
          created_at: '2026-09-01T10:00:00Z',
        }),
        mov('s1', 'i-aceite', 'SALIDA', 4, 21.25, 'USD', {
          venta_unitaria: 26.5625,
          venta_moneda: 'USD',
          created_at: '2026-09-01T11:00:00Z',
        }),
        mov('e2', 'i-balata', 'ENTRADA', 10, 100, 'MXN', {
          created_at: '2026-09-01T10:00:00Z',
        }),
        mov('s2', 'i-balata', 'SALIDA', 2, 100, 'MXN', {
          venta_unitaria: 125,
          venta_moneda: 'MXN',
          created_at: '2026-09-01T11:00:00Z',
        }),
      ],
    };
    const { svc, tablaXlsx } = armar({ tablas });
    await svc.itemsXlsx(q({ desde: '2026-09-01', hasta: '2026-09-30' }));
    const p = tablaXlsx.payload as {
      subtitulo: string;
      columnas: Array<{ label: string }>;
      filas: unknown[][];
      totales: unknown[];
    };
    const labels = p.columnas.map((c) => c.label);
    expect(labels).toEqual([
      'Ítem',
      'Código',
      'No. parte',
      'Categoría',
      'Ubicación',
      'Stock',
      'Unidad',
      'Mínimo',
      'Costo FIFO (MXN)',
      'Valor (MXN)',
      'Valor USD (sin T.C.)',
      'Utilidad (MXN)',
      'Utilidad (USD)',
    ]);
    const col = (l: string) => labels.indexOf(l);
    const fila = (nombre: string) => p.filas.find((f) => f[0] === nombre)!;
    expect(fila('Aceite 15W-50')[col('Ubicación')]).toBe(
      'Bodega Cancún (anterior)',
    );
    expect(fila('Aceite 15W-50')[col('Utilidad (USD)')]).toBe(21.25);
    expect(fila('Aceite 15W-50')[col('Utilidad (MXN)')]).toBeNull();
    expect(fila('Balata 66-105')[col('Ubicación')]).toBe('Oficina nueva');
    expect(fila('Balata 66-105')[col('Utilidad (MXN)')]).toBe(50);
    expect(fila('Balata 66-105')[col('Utilidad (USD)')]).toBeNull();
    expect(fila('Cubre pitot')[col('Utilidad (MXN)')]).toBeNull();
    // Totales: cada moneda en SU columna, jamás sumadas.
    expect(p.totales[col('Utilidad (MXN)')]).toBe(50);
    expect(p.totales[col('Utilidad (USD)')]).toBe(21.25);
    expect(p.subtitulo).toContain('utilidad: del 2026-09-01 al 2026-09-30');
    expect(p.subtitulo).toContain('margen vigente 25 %');
  });
});

describe('Detalle del producto: utilidad por salida y ubicación', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const tablas = () => ({
    inventario_ubicacion: CATALOGO(),
    inventario_item: ITEMS(),
    inventario_item_empaque: [],
    compra_linea: [],
    gasto: [{ id: 'g-s1', inventario_movimiento_id: 's1' }],
    inventario_movimiento: [
      {
        id: 'e1',
        item_id: 'i-aceite',
        tipo: 'ENTRADA',
        cantidad: 120,
        costo_unitario_usd: 21.25,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
        venta_unitaria: null,
        venta_moneda: null,
        para_flota: false,
        aeronave_id: null,
        fecha_movimiento: '2026-08-29',
        created_at: '2026-08-29T17:36:43Z',
      },
      {
        id: 's1',
        item_id: 'i-aceite',
        tipo: 'SALIDA',
        cantidad: 12,
        costo_unitario_usd: 21.25,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
        venta_unitaria: 26.5625,
        venta_moneda: 'USD',
        para_flota: false,
        aeronave_id: 'a-xavgv',
        aeronave: { matricula: 'XA-VGV' },
        fecha_movimiento: '2026-09-01',
        created_at: '2026-09-22T14:13:06Z',
      },
    ],
  });

  it('GET items/:id/resumen: ubicación, margen y cada venta con su utilidad USD', async () => {
    const { svc } = armar({ tablas: tablas() });
    const r = await svc.resumenItem('i-aceite');
    expect(r.item).toMatchObject({
      ubicacion: 'Bodega Cancún',
      ubicacion_id: null,
      ubicacion_nombre: null,
      ubicacion_legado: 'Bodega Cancún',
    });
    expect(r.margen_venta_pct).toBe(25);
    expect(r.ventas).toHaveLength(1);
    expect(r.ventas[0]).toMatchObject({
      movimiento_id: 's1',
      fecha: '2026-09-01',
      cantidad: 12,
      venta_moneda: 'USD',
      venta_unitaria_capturada: 26.5625,
      a_costo: false,
      ganancia_mxn: null,
      venta_total: 318.75,
      costo_fifo_usd: 255,
      ganancia_usd: 63.75,
      moneda_utilidad: 'USD',
      utilidad_incompleta: false,
      vendido_a: 'XA-VGV',
      gasto_id: 'g-s1',
    });
    expect(r.totales).toMatchObject({
      ventas_usd: 318.75,
      costo_ventas_usd: 255,
      utilidad_usd: 63.75,
      ventas_sin_utilidad: 0,
    });
    expect(
      r.resumen_diario.find((d) => d.fecha === '2026-09-01'),
    ).toMatchObject({
      ventas_usd: 318.75,
      costo_ventas_usd: 255,
      utilidad_usd: 63.75,
    });
  });

  it('GET items/:id: la SALIDA trae ganancia_usd junto a ganancia_mxn (ausente)', async () => {
    const { svc } = armar({ tablas: tablas() });
    const d = await svc.getItemDetail('i-aceite');
    const s1 = (d.movimientos as Fila[]).find((m) => m.id === 's1')!;
    expect(s1.ganancia_usd).toBe(63.75);
    expect(s1).not.toHaveProperty('ganancia_mxn');
    expect(d).toMatchObject({ ubicacion_legado: 'Bodega Cancún' });
  });
});

describe('Ubicaciones: SIN la migración 20260925000001 (API desplegado antes)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('la lista viaja SIN las llaves nuevas; lo nuevo responde 503 MIGRACION_PENDIENTE', async () => {
    const { svc } = armar({ migracion: false });
    const r = await svc.listItems(q());
    for (const d of r.data) {
      expect(d).not.toHaveProperty('ubicacion_id');
      expect(d).not.toHaveProperty('ubicacion_nombre');
      expect(d).not.toHaveProperty('ubicacion_legado');
    }
    for (const p of [
      svc.listUbicaciones(),
      svc.createUbicacion({ nombre: 'Bodega' }, 'u'),
      svc.updateUbicacion('u-nueva', { orden: 1 }, 'u'),
      svc.moverUbicacion({ item_ids: ['i-aceite'], ubicacion_id: 'u' }, 'u'),
      svc.listItems(q({ ubicacion: 'sin' })),
      svc.createItem(
        { nombre: 'x', categoria: 'y', ubicacion_id: 'u-nueva' },
        'u',
      ),
      svc.updateItem('i-aceite', { ubicacion_id: null }, 'u'),
    ]) {
      const e = await error(p);
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as ServiceUnavailableException).getResponse()).toMatchObject({
        error: 'MIGRACION_PENDIENTE',
        details: { migracion: '20260925000001' },
      });
    }
  });

  it('alta sin ubicación ⇒ «Bodega Cancún» como siempre; texto ⇒ tal cual', async () => {
    const { svc, fake } = armar({ migracion: false });
    await svc.createItem({ nombre: 'x', categoria: 'y' }, 'u');
    await svc.createItem(
      { nombre: 'z', categoria: 'y', ubicacion: 'Corner' },
      'u',
    );
    const altas = fake.escrituras.filter(
      (w) => w.tabla === 'inventario_item' && w.tipo === 'insert',
    );
    expect(altas.map((a) => (a.payload as Fila).ubicacion)).toEqual([
      'Bodega Cancún',
      'Corner',
    ]);
    for (const a of altas) {
      expect(a.payload).not.toHaveProperty('ubicacion_id');
    }
    await svc.updateItem('i-aceite', { ubicacion: ' Estante 2 ' }, 'u');
    const upd = fake.escrituras.find(
      (w) => w.tabla === 'inventario_item' && w.tipo === 'update',
    )!;
    expect(upd.payload).toMatchObject({ ubicacion: 'Estante 2' });
    expect(upd.payload).not.toHaveProperty('ubicacion_id');
  });
});
