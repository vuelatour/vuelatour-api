// Mismos stubs que compras.service.candidatos.spec.ts: InventoryService
// arrastra el gateway de notificaciones (`jose`, ESM puro).
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException, Logger } from '@nestjs/common';
import { COLUMNA_OPCIONAL_REINTENTO_MS } from '../../common/columna-opcional.util';
import type { InventoryService } from '../inventory/inventory.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  ALTA_A_MEDIAS_MIN_EDAD_MS,
  ComprasService,
  faltanteDeAlta,
  mensajeCompraEnProceso,
  mensajeCompraIncompleta,
} from './compras.service';
import type { CreateCompraDto } from './dto/compras.dto';

/**
 * `POST /v1/compras` IDEMPOTENTE por `client_request_id` (17-nov-2026, API
 * 0.0.142, invariante 137). La app 1.1.4+92 registra una «compra de la
 * tienda» desde el teléfono y reenvía cuando se pierde la respuesta: sin
 * llave nacían DOS compras.
 *
 * PostgREST falso por tabla, con el mismo trato que el del spec de
 * candidatos (cada consulta registra sus llamadas) pero CON ESTADO: filtra,
 * proyecta las columnas del `select`, escribe, respeta el índice único de la
 * llave y la cascada de las líneas, y deja inyectar fallas y carreras. Así
 * las pruebas dicen qué quedó guardado, no solo qué se llamó.
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };
type Consulta = { tabla: string; ops: Op[] };
type ErrorFalso = { code?: string; message: string };
type Resultado = { data: unknown; error: ErrorFalso | null };

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const UQ_LLAVE =
  'duplicate key value violates unique constraint "uq_compra_client_request"';

/** Operación que manda en una consulta (`insert` > `update` > `delete` > `select`). */
function operacion(ops: Op[]): string {
  for (const m of ['insert', 'update', 'delete']) {
    if (ops.some((o) => o.m === m)) return m;
  }
  return 'select';
}

/** Columnas simples del `select` (los embebidos `alias:tabla!fk(...)` no se resuelven). */
function columnasDe(ops: Op[]): string[] | null {
  const sel = ops.find((o) => o.m === 'select');
  if (!sel || typeof sel.args[0] !== 'string') return null;
  const partes: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of sel.args[0]) {
    if (ch === '(') nivel++;
    if (ch === ')') nivel--;
    if (ch === ',' && nivel === 0) {
      partes.push(actual.trim());
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual.trim()) partes.push(actual.trim());
  return partes.filter((p) => /^[a-z_]+$/.test(p));
}

function baseFalsa(
  opciones: { columna?: boolean; tablas?: Record<string, Fila[]> } = {},
) {
  const tablas: Record<string, Fila[]> = {
    compra: [],
    compra_linea: [],
    gasto: [],
  };
  for (const [t, filas] of Object.entries(opciones.tablas ?? {})) {
    tablas[t] = filas.map((f) => ({ ...f }));
  }
  /** `columna: false` = la migración 20261117000002 todavía no está aplicada. */
  const estado = { columna: opciones.columna !== false };
  const consultas: Consulta[] = [];
  const fallas: Array<{
    tabla: string;
    m: string;
    error: ErrorFalso;
    veces: number;
  }> = [];
  let antes: ((c: Consulta) => void) | null = null;
  let serie = 0;
  let folio = 40;

  const filtradas = (tabla: string, ops: Op[]): Fila[] => {
    let r = tablas[tabla].slice();
    for (const o of ops) {
      const [a, b, c] = o.args as [string, unknown, unknown];
      if (o.m === 'eq') r = r.filter((f) => f[a] === b);
      if (o.m === 'in') r = r.filter((f) => (b as unknown[]).includes(f[a]));
      if (o.m === 'is') r = r.filter((f) => f[a] == null);
      if (o.m === 'not') {
        if (b !== 'is' || c !== null) throw new Error('not no soportado');
        r = r.filter((f) => f[a] != null);
      }
    }
    const rango = ops.find((o) => o.m === 'range');
    if (rango) {
      r = r.slice(rango.args[0] as number, (rango.args[1] as number) + 1);
    }
    return r;
  };

  const proyectar = (filas: Fila[], ops: Op[]): Fila[] => {
    const cols = columnasDe(ops);
    if (!cols) return filas.map((f) => ({ ...f }));
    return filas.map((f) => {
      const out: Fila = {};
      for (const c of cols) out[c] = f[c] ?? null;
      return out;
    });
  };

  const resolver = (tabla: string, ops: Op[], unica: boolean): Resultado => {
    if (antes) antes({ tabla, ops });
    const op = operacion(ops);
    const ins = ops.find((o) => o.m === 'insert');
    const entrada = ins ? (ins.args[0] as Fila | Fila[]) : [];
    const cuerpos: Fila[] = (Array.isArray(entrada) ? entrada : [entrada]).map(
      (f) =>
        Object.fromEntries(
          // Como el JSON real: lo `undefined` no viaja (default de la BD).
          Object.entries(f).filter(([, v]) => v !== undefined),
        ),
    );
    // Sin la columna, Postgres / PostgREST rechazan TODO lo que la nombre.
    if (tabla === 'compra' && !estado.columna) {
      if (cuerpos.some((f) => 'client_request_id' in f)) {
        return {
          data: null,
          error: {
            code: 'PGRST204',
            message:
              "Could not find the 'client_request_id' column of 'compra' in the schema cache",
          },
        };
      }
      const laNombra =
        (columnasDe(ops) ?? []).includes('client_request_id') ||
        ops.some((o) => o.m === 'eq' && o.args[0] === 'client_request_id');
      if (laNombra) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column compra.client_request_id does not exist',
          },
        };
      }
    }
    const falla = fallas.find(
      (f) => f.tabla === tabla && f.m === op && f.veces > 0,
    );
    if (falla) {
      falla.veces -= 1;
      return { data: null, error: falla.error };
    }
    if (op === 'insert') {
      const sello = new Date(Date.now()).toISOString();
      const nuevas = cuerpos.map((f): Fila => {
        const id = uuid(++serie);
        if (tabla === 'compra') {
          return {
            id,
            folio: ++folio,
            fecha: '2026-11-17',
            recibida_at: null,
            created_at: sello,
            updated_at: sello,
            ...(estado.columna ? { client_request_id: null } : {}),
            ...f,
          };
        }
        return {
          id,
          inventario_movimiento_id: null,
          created_at: sello,
          updated_at: sello,
          ...f,
        };
      });
      // Índice ÚNICO PARCIAL de la llave (solo llaves no nulas).
      if (
        tabla === 'compra' &&
        nuevas.some(
          (n) =>
            n.client_request_id != null &&
            tablas.compra.some(
              (c) => c.client_request_id === n.client_request_id,
            ),
        )
      ) {
        return { data: null, error: { code: '23505', message: UQ_LLAVE } };
      }
      tablas[tabla].push(...nuevas);
      const vistas = proyectar(nuevas, ops);
      return { data: unica ? vistas[0] : vistas, error: null };
    }
    if (op === 'update') {
      const tocadas = filtradas(tabla, ops);
      const cambio = ops.find((o) => o.m === 'update')!.args[0] as Fila;
      for (const f of tocadas) Object.assign(f, cambio);
      const vistas = proyectar(tocadas, ops);
      return { data: unica ? (vistas[0] ?? null) : vistas, error: null };
    }
    if (op === 'delete') {
      const fuera = filtradas(tabla, ops);
      tablas[tabla] = tablas[tabla].filter((f) => !fuera.includes(f));
      if (tabla === 'compra') {
        // FK de `compra_linea.compra_id`: las líneas se van con su compra.
        const ids = fuera.map((f) => f.id);
        tablas.compra_linea = tablas.compra_linea.filter(
          (l) => !ids.includes(l.compra_id),
        );
      }
      return { data: null, error: null };
    }
    const vistas = proyectar(filtradas(tabla, ops), ops);
    if (unica && vistas.length > 1) {
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      };
    }
    return { data: unica ? (vistas[0] ?? null) : vistas, error: null };
  };

  const from = (tabla: string) => {
    const ops: Op[] = [];
    consultas.push({ tabla, ops });
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'in',
      'is',
      'not',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push({ m, args });
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve(resolver(tabla, ops, true));
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver(tabla, ops, false)).then(res, rej);
    return q;
  };

  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    tablas,
    estado,
    consultas,
    /** `tabla.operación` de cada consulta desde la posición `desde`. */
    traza: (desde = 0): string[] =>
      consultas.slice(desde).map((c) => `${c.tabla}.${operacion(c.ops)}`),
    /** Solo las escrituras (insert / update / delete) desde `desde`. */
    escrituras: (desde = 0): string[] =>
      consultas
        .slice(desde)
        .map((c) => `${c.tabla}.${operacion(c.ops)}`)
        .filter((t) => !t.endsWith('.select')),
    /** Cuerpo de la n-ésima escritura `m` sobre `tabla`. */
    cuerpo(tabla: string, m: 'insert' | 'update', n = 0): unknown {
      const c = consultas.filter(
        (x) => x.tabla === tabla && operacion(x.ops) === m,
      )[n];
      if (!c) throw new Error(`no hubo ${m} #${n} en ${tabla}`);
      return c.ops.find((o) => o.m === m)!.args[0];
    },
    /** Las próximas `veces` consultas `m` sobre `tabla` responden `error`. */
    fallar(tabla: string, m: string, error: ErrorFalso, veces = 1) {
      fallas.push({ tabla, m, error, veces });
    },
    /** Gancho previo a cada consulta (simular que OTRO proceso escribió en medio). */
    antesDeCadaConsulta(fn: ((c: Consulta) => void) | null) {
      antes = fn;
    },
  };
}

function armar(opciones: Parameters<typeof baseFalsa>[0] = {}) {
  const base = baseFalsa(opciones);
  const service = new ComprasService(
    base.supabase,
    {} as unknown as InventoryService,
  );
  return { service, base };
}

async function falla(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as {
        error?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      return {
        status: e.getStatus(),
        code: r.error,
        message: r.message,
        details: r.details,
      };
    }
    throw e;
  }
  throw new Error('no falló');
}

const USER = 'u-oficina';
const KEY = '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b';
const OTRA_KEY = '1c3d5e70-2f4a-4b6c-8d0e-9f1a2b3c4d5e';
const PROVEEDOR = 'a0000000-0000-4000-8000-000000000002';
const AHORA = Date.parse('2026-11-17T18:00:00.000Z');

/** El cuerpo que manda la app para una compra de la tienda (`cuerpoCrearCompra`). */
const tienda = (extra: Partial<CreateCompraDto> = {}): CreateCompraDto => ({
  proveedor_id: PROVEEDOR,
  fecha: '2026-11-17',
  referencia: 'T-881',
  moneda: 'MXN',
  tc_usd_mxn: 18.5,
  notas: 'Registrada desde la app (control 9B2C7A10)',
  lineas: [
    { nombre: 'Aceite 15W-50', cantidad: 12, costo_unitario: 210 },
    { nombre: 'Filtro CH48110', cantidad: 2, costo_unitario: 485.5 },
  ],
  cargos_factura: [
    { concepto: 'IVA y otros cargos del ticket', monto: 558.56 },
  ],
  ...extra,
});

/** Gasto REFACCION suelto: la factura de mercancía de «compra desde un gasto». */
const GASTO = {
  id: 'g-ref',
  categoria: 'REFACCION',
  monto: '722.90',
  moneda: 'USD',
  tc_gasto: null,
  fecha_gasto: '2026-11-16T17:00:00+00:00',
  proveedor_id: null,
  notas: 'Filtros y bujías',
  compra_id: null,
  compra_rol: null,
  valor_ia_extraido: null,
  aeronave_id: null,
  vuelo_id: null,
  escala_id: null,
  medio_pago: 'TRANSFERENCIA',
  inventario_movimiento_id: null,
  foto_url: null,
  conciliado: false,
};

/** Una compra ya guardada con la llave (lo que dejó un alta anterior). */
const compraGuardada = (extra: Fila = {}): Fila => ({
  id: uuid(900),
  folio: 77,
  proveedor_id: null,
  fecha: '2026-11-17',
  referencia: null,
  moneda: 'USD',
  tc_usd_mxn: null,
  estado: 'ABIERTA',
  cargos_factura: [],
  recibida_at: null,
  notas: null,
  created_at: new Date(AHORA).toISOString(),
  updated_at: new Date(AHORA).toISOString(),
  created_by: USER,
  updated_by: USER,
  client_request_id: KEY,
  ...extra,
});

const lineaGuardada = (compraId: string, n: number): Fila => ({
  id: uuid(950 + n),
  compra_id: compraId,
  orden: n,
  item_id: null,
  nombre: `Pieza ${n}`,
  numero_parte: null,
  categoria: null,
  cantidad: 1,
  costo_unitario: 100,
  inventario_movimiento_id: null,
});

const haceMs = (ms: number): string => new Date(AHORA - ms).toISOString();

/** Los `warn` del Logger de Nest (callados: la salida de jest queda limpia). */
let avisos: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(AHORA));
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  avisos = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('faltanteDeAlta (PURA): el ÚLTIMO paso del alta que pide el cuerpo', () => {
  it('con líneas: completa si la compra tiene líneas; sin ellas le faltan', () => {
    const dto = { lineas: tienda().lineas };
    expect(faltanteDeAlta(dto, { lineas: [{}], pagos: [] })).toBeNull();
    expect(faltanteDeAlta(dto, { lineas: [], pagos: [] })).toBe('LINEAS');
  });

  it('con gasto de mercancía: manda la liga (va DESPUÉS de las líneas) aunque ya tenga líneas', () => {
    const dto = { gasto_mercancia_id: 'g-ref' };
    expect(
      faltanteDeAlta(dto, { lineas: [{}], pagos: [{ id: 'g-ref' }] }),
    ).toBeNull();
    expect(faltanteDeAlta(dto, { lineas: [{}], pagos: [] })).toBe('GASTO');
    expect(faltanteDeAlta(dto, { lineas: [], pagos: [{ id: 'g-otro' }] })).toBe(
      'GASTO',
    );
    // La liga existe ⇒ las líneas ya habían entrado: no se vuelve a mirar.
    expect(
      faltanteDeAlta(
        { ...dto, lineas: tienda().lineas },
        { lineas: [], pagos: [{ id: 'g-ref' }] },
      ),
    ).toBeNull();
  });

  it('sin líneas ni gasto: el INSERT de la compra ERA el alta entera', () => {
    expect(faltanteDeAlta({}, { lineas: [], pagos: [] })).toBeNull();
    expect(
      faltanteDeAlta({ lineas: [] }, { lineas: [], pagos: [] }),
    ).toBeNull();
  });
});

describe('ComprasService.create — idempotente por client_request_id (invariante 137)', () => {
  it('alta con llave: la llave va en el INSERT, la compra nace completa y responde el detalle de siempre SIN `idempotente`', async () => {
    const { service, base } = armar();
    const r = await service.create(tienda({ client_request_id: KEY }), USER);

    expect(base.cuerpo('compra', 'insert')).toEqual({
      proveedor_id: PROVEEDOR,
      fecha: '2026-11-17',
      referencia: 'T-881',
      moneda: 'MXN',
      tc_usd_mxn: 18.5,
      estado: 'ABIERTA',
      cargos_factura: [
        { concepto: 'IVA y otros cargos del ticket', monto: 558.56 },
      ],
      notas: 'Registrada desde la app (control 9B2C7A10)',
      created_by: USER,
      updated_by: USER,
      client_request_id: KEY,
    });
    // Sonda de la columna y pre-check por llave ANTES de la primera escritura.
    expect(base.traza()).toEqual([
      'compra.select',
      'compra.select',
      'compra.insert',
      'compra_linea.insert',
      'compra.select',
      'compra_linea.select',
      'gasto.select',
    ]);
    expect(base.consultas[1].ops).toContainEqual({
      m: 'eq',
      args: ['client_request_id', KEY],
    });
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra[0].client_request_id).toBe(KEY);
    expect(base.tablas.compra_linea).toHaveLength(2);

    expect(r).toMatchObject({
      id: base.tablas.compra[0].id,
      folio: 41,
      estado: 'ABIERTA',
      moneda: 'MXN',
      pagos: [],
      resumen: {
        total_mercancia: 3491,
        cargos_factura: 558.56,
        total_factura: 4049.56,
        gasto_estado: 'SIN_GASTO',
      },
    });
    expect(r.lineas.map((l) => l.nombre)).toEqual([
      'Aceite 15W-50',
      'Filtro CH48110',
    ]);
    // Contrato con el panel: el alta normal NO trae el campo, y la llave no
    // sale en la respuesta.
    expect(r).not.toHaveProperty('idempotente');
    expect(r).not.toHaveProperty('client_request_id');
  });

  it('sin llave: exactamente las consultas y el INSERT de antes — ni sonda, ni pre-check, ni columna', async () => {
    const { service, base } = armar();
    const r = await service.create(tienda(), USER);

    expect(base.traza()).toEqual([
      'compra.insert',
      'compra_linea.insert',
      'compra.select',
      'compra_linea.select',
      'gasto.select',
    ]);
    expect(base.cuerpo('compra', 'insert')).not.toHaveProperty(
      'client_request_id',
    );
    expect(base.tablas.compra[0].client_request_id).toBeNull();
    expect(r).not.toHaveProperty('idempotente');
    expect(r.lineas).toHaveLength(2);

    // Sin llave no hay idempotencia: repetir el alta crea otra (como siempre).
    await service.create(tienda(), USER);
    expect(base.tablas.compra).toHaveLength(2);

    // El detalle es el MISMO con y sin llave (misma forma, mismos números).
    const conLlave = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    const sinVolatiles = (d: Record<string, unknown>) => ({
      ...d,
      id: null,
      folio: null,
      lineas: (d.lineas as Fila[]).map((l) => ({
        ...l,
        id: null,
        compra_id: null,
      })),
    });
    expect(sinVolatiles(conLlave)).toEqual(sinVolatiles(r));
  });

  it('replay: la misma llave devuelve la MISMA compra con idempotente:true y no escribe nada', async () => {
    const { service, base } = armar();
    const primera = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    const marca = base.consultas.length;
    const guardado = JSON.stringify(base.tablas);

    const replay = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );

    expect(replay).toEqual({ ...primera, idempotente: true });
    // Solo lecturas: la compra por su llave, sus líneas y sus pagos.
    expect(base.traza(marca)).toEqual([
      'compra.select',
      'compra_linea.select',
      'gasto.select',
    ]);
    expect(base.escrituras(marca)).toEqual([]);
    expect(JSON.stringify(base.tablas)).toBe(guardado);
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toHaveLength(2);

    // Otra llave SÍ es otra compra.
    const otra = await service.create(
      tienda({ client_request_id: OTRA_KEY }),
      USER,
    );
    expect(otra.id).not.toBe(primera.id);
    expect(otra).not.toHaveProperty('idempotente');
    expect(base.tablas.compra).toHaveLength(2);
  });

  it('respuesta perdida (todo se guardó pero la lectura final falló): el reintento responde ESA compra, no crea otra', async () => {
    const { service, base } = armar();
    // 1.ª lectura de `compra` = la sonda, 2.ª = el pre-check, 3.ª = el
    // detalle que se responde: esa es la que se cae.
    let lecturas = 0;
    base.antesDeCadaConsulta((c) => {
      if (c.tabla !== 'compra' || operacion(c.ops) !== 'select') return;
      if (++lecturas === 3) throw new Error('fetch failed');
    });

    await expect(
      service.create(tienda({ client_request_id: KEY }), USER),
    ).rejects.toThrow('fetch failed');
    // El cliente vio un 500, pero la compra quedó COMPLETA en la base.
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toHaveLength(2);
    const marca = base.consultas.length;

    const r = await service.create(tienda({ client_request_id: KEY }), USER);

    expect(r.idempotente).toBe(true);
    expect(r.id).toBe(base.tablas.compra[0].id);
    expect(r.lineas).toHaveLength(2);
    expect(r.resumen.total_factura).toBe(4049.56);
    expect(base.escrituras(marca)).toEqual([]);
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toHaveLength(2);
  });

  it('el replay NO re-valida: responde aunque el proveedor ya no exista y aunque el cuerpo del reintento ya no pasaría', async () => {
    const { service, base } = armar();
    const primera = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    // El proveedor se eliminó después (FK `set null`) y cualquier INSERT que
    // lo nombrara rebotaría 23503 → 400 «Proveedor no encontrado.».
    base.tablas.compra[0].proveedor_id = null;
    base.fallar(
      'compra',
      'insert',
      {
        code: '23503',
        message:
          'insert or update on table "compra" violates foreign key constraint "compra_proveedor_id_fkey"',
      },
      99,
    );
    const marca = base.consultas.length;

    const replay = await service.create(
      // Hasta con un artículo que ya no existe: el alta ya ocurrió.
      tienda({
        client_request_id: KEY,
        lineas: [
          {
            item_id: uuid(404),
            nombre: 'Ya no existe',
            cantidad: 1,
            costo_unitario: 1,
          },
        ],
      }),
      USER,
    );

    expect(replay.idempotente).toBe(true);
    expect(replay.id).toBe(primera.id);
    expect(replay.proveedor_id).toBeNull();
    expect(replay.lineas.map((l) => l.nombre)).toEqual([
      'Aceite 15W-50',
      'Filtro CH48110',
    ]);
    expect(base.escrituras(marca)).toEqual([]);

    // Contraste: con una llave NUEVA el alta sí llega a la base y rebota (400).
    expect(
      await falla(
        service.create(tienda({ client_request_id: OTRA_KEY }), USER),
      ),
    ).toMatchObject({ status: 400, message: 'Proveedor no encontrado.' });
  });

  it('el replay NO re-valida (compra desde un gasto): no relee el gasto, que ya no sería ligable', async () => {
    const { service, base } = armar({ tablas: { gasto: [GASTO] } });
    const dto: CreateCompraDto = {
      gasto_mercancia_id: 'g-ref',
      client_request_id: KEY,
    };
    const primera = await service.create(dto, USER);
    expect(base.tablas.gasto[0]).toMatchObject({
      compra_id: primera.id,
      compra_rol: 'MERCANCIA',
    });
    expect(primera.pagos.map((p) => p.id)).toEqual(['g-ref']);
    const marca = base.consultas.length;

    // Revalidar rebotaría 409 «Ese gasto ya pertenece a otra compra…»: el
    // gasto quedó ligado por el alta original.
    const replay = await service.create(dto, USER);

    expect(replay).toEqual({ ...primera, idempotente: true });
    expect(base.escrituras(marca)).toEqual([]);
    const leyoElGasto = base.consultas
      .slice(marca)
      .some(
        (c) =>
          c.tabla === 'gasto' &&
          c.ops.some((o) => o.m === 'eq' && o.args[0] === 'id'),
      );
    expect(leyoElGasto).toBe(false);
  });

  it('dos envíos a la vez con la misma llave (mismo proceso) se serializan: UNA compra, el segundo es el replay', async () => {
    const { service, base } = armar();
    const dto = tienda({ client_request_id: KEY });

    const [a, b] = await Promise.all([
      service.create(dto, USER),
      service.create(dto, USER),
    ]);

    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toHaveLength(2);
    expect(a).not.toHaveProperty('idempotente');
    expect(b).toEqual({ ...a, idempotente: true });
    expect(base.escrituras()).toEqual(['compra.insert', 'compra_linea.insert']);
  });

  it('23505 del índice de la llave (otro proceso ganó la carrera) ⇒ relectura por llave y la respuesta idempotente', async () => {
    const { service, base } = armar();
    const ajena = compraGuardada({ moneda: 'MXN', tc_usd_mxn: 18.5 });
    // Entre nuestro pre-check y nuestro INSERT, OTRO proceso dio de alta la
    // compra completa con la misma llave.
    base.antesDeCadaConsulta((c) => {
      if (c.tabla !== 'compra' || operacion(c.ops) !== 'insert') return;
      base.antesDeCadaConsulta(null);
      base.tablas.compra.push(ajena);
      base.tablas.compra_linea.push(
        lineaGuardada(uuid(900), 1),
        lineaGuardada(uuid(900), 2),
      );
    });

    const r = await service.create(tienda({ client_request_id: KEY }), USER);

    expect(r.idempotente).toBe(true);
    expect(r.id).toBe(uuid(900));
    expect(r.folio).toBe(77);
    expect(r.lineas.map((l) => l.nombre)).toEqual(['Pieza 1', 'Pieza 2']);
    // Lo nuestro no dejó nada: el único INSERT fue el que chocó.
    expect(base.escrituras()).toEqual(['compra.insert']);
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toHaveLength(2);
  });

  it('23505 y la otra todavía no termina, o ya no está ⇒ 503 COMPRA_EN_PROCESO (jamás un 500) sin tocar nada', async () => {
    // (a) El otro proceso apenas insertó la compra: sus líneas vienen en camino.
    const enCurso = armar();
    enCurso.base.antesDeCadaConsulta((c) => {
      if (c.tabla !== 'compra' || operacion(c.ops) !== 'insert') return;
      enCurso.base.antesDeCadaConsulta(null);
      enCurso.base.tablas.compra.push(compraGuardada());
    });
    expect(
      await falla(
        enCurso.service.create(tienda({ client_request_id: KEY }), USER),
      ),
    ).toEqual({
      status: 503,
      code: 'COMPRA_EN_PROCESO',
      message: mensajeCompraEnProceso(77),
      details: { client_request_id: KEY, compra_id: uuid(900), folio: 77 },
    });
    expect(enCurso.base.escrituras()).toEqual(['compra.insert']);
    expect(enCurso.base.tablas.compra).toHaveLength(1);

    // (b) Chocó y, al releer, el otro envío ya la había deshecho.
    const deshecha = armar();
    deshecha.base.fallar('compra', 'insert', {
      code: '23505',
      message: UQ_LLAVE,
    });
    expect(
      await falla(
        deshecha.service.create(tienda({ client_request_id: KEY }), USER),
      ),
    ).toEqual({
      status: 503,
      code: 'COMPRA_EN_PROCESO',
      message: mensajeCompraEnProceso(null),
      details: { client_request_id: KEY, compra_id: null, folio: null },
    });
    expect(deshecha.base.tablas.compra).toHaveLength(0);
    // El siguiente intento (misma llave) ya la crea.
    const r = await deshecha.service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    expect(r).not.toHaveProperty('idempotente');
    expect(deshecha.base.tablas.compra).toHaveLength(1);
  });

  it('los demás errores del INSERT siguen su camino de siempre: otro 23505 no se toma por la llave y el 23503 es 400', async () => {
    const { service, base } = armar();
    base.fallar('compra', 'insert', {
      code: '23505',
      message: 'duplicate key value violates unique constraint "otro_indice"',
    });
    await expect(
      service.create(tienda({ client_request_id: KEY }), USER),
    ).rejects.toThrow('otro_indice');
    base.fallar('compra', 'insert', {
      code: '23503',
      message: 'violates foreign key constraint "compra_proveedor_id_fkey"',
    });
    expect(
      await falla(service.create(tienda({ client_request_id: KEY }), USER)),
    ).toMatchObject({ status: 400, message: 'Proveedor no encontrado.' });
    expect(base.tablas.compra).toHaveLength(0);
  });

  it('una compra sin líneas ni gasto ES un alta completa: su replay es idempotente (no se toma por «a medias»)', async () => {
    const { service, base } = armar();
    const dto: CreateCompraDto = {
      notas: 'Pedido por armar',
      client_request_id: KEY,
    };
    const primera = await service.create(dto, USER);
    expect(primera.lineas).toEqual([]);
    jest.setSystemTime(AHORA + 60 * 60_000);

    const replay = await service.create(dto, USER);

    expect(replay).toEqual({ ...primera, idempotente: true });
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.escrituras()).toEqual(['compra.insert']);
  });
});

describe('alta a medias: un reintento con la misma llave JAMÁS la recibe como «ya creada»', () => {
  const ROTO = { message: 'connection reset by peer' };

  it('fallan las líneas: la compra se deshace (como siempre), la llave queda libre y el reintento crea la compra COMPLETA', async () => {
    const { service, base } = armar();
    base.fallar('compra_linea', 'insert', ROTO);

    await expect(
      service.create(tienda({ client_request_id: KEY }), USER),
    ).rejects.toThrow('connection reset by peer');
    expect(base.escrituras()).toEqual([
      'compra.insert',
      'compra_linea.insert',
      'gasto.update',
      'compra.delete',
    ]);
    expect(base.tablas.compra).toEqual([]);
    const marca = base.consultas.length;

    const r = await service.create(tienda({ client_request_id: KEY }), USER);

    expect(r).not.toHaveProperty('idempotente');
    expect(r.lineas).toHaveLength(2);
    expect(base.escrituras(marca)).toEqual([
      'compra.insert',
      'compra_linea.insert',
    ]);
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra[0].client_request_id).toBe(KEY);
  });

  it('fallan las líneas Y la compensación: joven ⇒ 503 sin tocar nada; pasados 5 min ⇒ se retira el cascarón y nace la compra completa', async () => {
    const { service, base } = armar();
    base.fallar('compra_linea', 'insert', ROTO);
    base.fallar('compra', 'delete', { message: 'timeout' });

    // El error que ve el cliente es el ORIGINAL (las líneas), no el de la limpieza.
    await expect(
      service.create(tienda({ client_request_id: KEY }), USER),
    ).rejects.toThrow('connection reset by peer');
    // Quedó el cascarón: la compra con la llave y sin una sola línea.
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra_linea).toEqual([]);
    const cascaron = { ...base.tablas.compra[0] };
    expect(cascaron.client_request_id).toBe(KEY);

    // Reintento inmediato: ni «ya creada» ni otra compra — 503 y nada escrito.
    let marca = base.consultas.length;
    const esperado = {
      status: 503,
      code: 'COMPRA_EN_PROCESO',
      message: mensajeCompraEnProceso(41),
      details: { client_request_id: KEY, compra_id: cascaron.id, folio: 41 },
    };
    expect(
      await falla(service.create(tienda({ client_request_id: KEY }), USER)),
    ).toEqual(esperado);
    expect(base.escrituras(marca)).toEqual([]);

    // Justo a los 5 min sigue siendo joven (otro envío podría terminarla).
    jest.setSystemTime(AHORA + ALTA_A_MEDIAS_MIN_EDAD_MS);
    expect(
      await falla(service.create(tienda({ client_request_id: KEY }), USER)),
    ).toEqual(esperado);
    expect(base.tablas.compra).toEqual([cascaron]);

    // Pasado el margen: se retira con la MISMA compensación del alta y se
    // da de alta de nuevo, completa.
    jest.setSystemTime(AHORA + ALTA_A_MEDIAS_MIN_EDAD_MS + 1);
    marca = base.consultas.length;
    const r = await service.create(tienda({ client_request_id: KEY }), USER);

    expect(base.escrituras(marca)).toEqual([
      'gasto.update',
      'compra.delete',
      'compra.insert',
      'compra_linea.insert',
    ]);
    expect(r).not.toHaveProperty('idempotente');
    expect(r.id).not.toBe(cascaron.id);
    expect(r.lineas).toHaveLength(2);
    expect(r.resumen.total_factura).toBe(4049.56);
    expect(base.tablas.compra).toHaveLength(1);
    expect(base.tablas.compra[0]).toMatchObject({
      id: r.id,
      client_request_id: KEY,
    });
    expect(base.tablas.compra_linea).toHaveLength(2);

    // Y desde ahí el replay es el de siempre.
    const replay = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    expect(replay).toEqual({ ...r, idempotente: true });
  });

  it('el cascarón se reconstruye con el cuerpo del REINTENTO (moneda, fecha y líneas corregidas), no con el del intento fallido', async () => {
    const { service, base } = armar({
      tablas: {
        compra: [compraGuardada({ created_at: haceMs(10 * 60_000) })],
      },
    });

    const r = await service.create(
      tienda({ client_request_id: KEY, fecha: '2026-11-15' }),
      USER,
    );

    expect(r).toMatchObject({ moneda: 'MXN', fecha: '2026-11-15' });
    expect(r.id).not.toBe(uuid(900));
    expect(r.lineas).toHaveLength(2);
    expect(base.tablas.compra).toHaveLength(1);
  });

  it('si el retiro del cascarón falla ⇒ 503 (se reintenta) y el cascarón sigue; el siguiente intento lo logra', async () => {
    const { service, base } = armar({
      tablas: {
        compra: [compraGuardada({ created_at: haceMs(10 * 60_000) })],
      },
    });
    base.fallar('compra', 'delete', { message: 'timeout' });

    expect(
      await falla(service.create(tienda({ client_request_id: KEY }), USER)),
    ).toMatchObject({
      status: 503,
      code: 'COMPRA_EN_PROCESO',
      details: { compra_id: uuid(900), folio: 77 },
    });
    expect(base.tablas.compra.map((c) => c.id)).toEqual([uuid(900)]);
    expect(base.escrituras()).toEqual(['gasto.update', 'compra.delete']);

    const r = await service.create(tienda({ client_request_id: KEY }), USER);
    expect(r).not.toHaveProperty('idempotente');
    expect(r.lineas).toHaveLength(2);
    expect(base.tablas.compra.map((c) => c.id)).toEqual([r.id]);
  });

  it('a medias pero con líneas (compra desde un gasto: faltó la liga) ⇒ joven 503; después 409 COMPRA_INCOMPLETA sin borrar ni completar a ciegas', async () => {
    const dto: CreateCompraDto = {
      gasto_mercancia_id: 'g-ref',
      client_request_id: KEY,
    };
    const tablas = (created_at: string) => ({
      compra: [compraGuardada({ created_at })],
      compra_linea: [lineaGuardada(uuid(900), 1)],
      gasto: [GASTO],
    });

    const joven = armar({ tablas: tablas(haceMs(60_000)) });
    expect(await falla(joven.service.create(dto, USER))).toMatchObject({
      status: 503,
      code: 'COMPRA_EN_PROCESO',
    });
    expect(joven.base.escrituras()).toEqual([]);

    const vieja = armar({ tablas: tablas(haceMs(10 * 60_000)) });
    expect(await falla(vieja.service.create(dto, USER))).toEqual({
      status: 409,
      code: 'COMPRA_INCOMPLETA',
      message: mensajeCompraIncompleta(77, 'GASTO'),
      details: {
        client_request_id: KEY,
        compra_id: uuid(900),
        folio: 77,
        falta: 'GASTO',
      },
    });
    expect(vieja.base.escrituras()).toEqual([]);
    expect(vieja.base.tablas.compra).toHaveLength(1);
    expect(vieja.base.tablas.compra_linea).toHaveLength(1);
    expect(vieja.base.tablas.gasto[0].compra_id).toBeNull();
  });

  it('a medias sin líneas pero con un pago ligado, o ya RECIBIDA ⇒ 409 (no es un cascarón: no se borra)', async () => {
    const conPago = armar({
      tablas: {
        compra: [compraGuardada({ created_at: haceMs(10 * 60_000) })],
        gasto: [{ ...GASTO, compra_id: uuid(900), compra_rol: 'ENVIO' }],
      },
    });
    expect(
      await falla(
        conPago.service.create(tienda({ client_request_id: KEY }), USER),
      ),
    ).toMatchObject({
      status: 409,
      code: 'COMPRA_INCOMPLETA',
      message: mensajeCompraIncompleta(77, 'LINEAS'),
      details: { falta: 'LINEAS' },
    });
    expect(conPago.base.escrituras()).toEqual([]);

    const recibida = armar({
      tablas: {
        compra: [
          compraGuardada({
            created_at: haceMs(10 * 60_000),
            estado: 'RECIBIDA',
          }),
        ],
      },
    });
    expect(
      await falla(
        recibida.service.create(tienda({ client_request_id: KEY }), USER),
      ),
    ).toMatchObject({ status: 409, code: 'COMPRA_INCOMPLETA' });
    expect(recibida.base.tablas.compra).toHaveLength(1);
  });

  it('una fecha de alta ilegible cuenta como joven: 503 y nada se borra', async () => {
    const { service, base } = armar({
      tablas: { compra: [compraGuardada({ created_at: 'no-es-fecha' })] },
    });
    expect(
      await falla(service.create(tienda({ client_request_id: KEY }), USER)),
    ).toMatchObject({ status: 503, code: 'COMPRA_EN_PROCESO' });
    expect(base.escrituras()).toEqual([]);
  });
});

describe('columna ausente (migración 20261117000002 sin aplicar): la llave se IGNORA', () => {
  it('alta idéntica a la de hoy, sin idempotencia y sin nombrar la columna más que en UNA sonda', async () => {
    const { service, base } = armar({ columna: false });
    const dto = tienda({ client_request_id: KEY });

    const r = await service.create(dto, USER);

    // El falso rechaza (42703 / PGRST204) cualquier consulta que nombre la
    // columna: que el alta pase ya dice que nadie la nombró.
    expect(base.traza()).toEqual([
      'compra.select', // la sonda
      'compra.insert',
      'compra_linea.insert',
      'compra.select',
      'compra_linea.select',
      'gasto.select',
    ]);
    expect(base.cuerpo('compra', 'insert')).not.toHaveProperty(
      'client_request_id',
    );
    expect(r).not.toHaveProperty('idempotente');
    expect(r.lineas).toHaveLength(2);

    // Sin columna no hay idempotencia (como hoy): el reenvío crea otra. La
    // sonda no se repite (memorizada ≤ 10 min).
    const marca = base.consultas.length;
    const otra = await service.create(dto, USER);
    expect(otra).not.toHaveProperty('idempotente');
    expect(otra.id).not.toBe(r.id);
    expect(base.tablas.compra).toHaveLength(2);
    expect(base.traza(marca)).toEqual([
      'compra.insert',
      'compra_linea.insert',
      'compra.select',
      'compra_linea.select',
      'gasto.select',
    ]);
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos).toHaveBeenCalledWith(
      expect.stringContaining('20261117000002'),
    );
  });

  it('se enciende sola: aplicada la migración y pasada la ventana de re-sondeo, la llave ya cuenta', async () => {
    const { service, base } = armar({ columna: false });
    await service.create(tienda({ client_request_id: KEY }), USER);
    base.estado.columna = true;

    // Dentro de la ventana sigue ignorándola (no re-sondea en cada alta).
    await service.create(tienda({ client_request_id: KEY }), USER);
    expect(base.tablas.compra).toHaveLength(2);
    expect(base.tablas.compra.map((c) => c.client_request_id ?? null)).toEqual([
      null,
      null,
    ]);

    jest.setSystemTime(AHORA + COLUMNA_OPCIONAL_REINTENTO_MS);
    const tercera = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    expect(tercera).not.toHaveProperty('idempotente');
    expect(base.tablas.compra).toHaveLength(3);
    expect(base.tablas.compra[2].client_request_id).toBe(KEY);

    const replay = await service.create(
      tienda({ client_request_id: KEY }),
      USER,
    );
    expect(replay).toEqual({ ...tercera, idempotente: true });
    expect(base.tablas.compra).toHaveLength(3);
  });
});
