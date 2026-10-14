jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { Logger } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import * as lectura from '../../common/clave-cliente-lectura.util';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';
import type { VueloSeguimientoService } from '../flights/vuelo-seguimiento.service';

/**
 * COTIZACIONES + ID DE VUELO POR CLIENTE (13-oct-2026, API 0.0.75,
 * invariante 68): `clave_cliente` ADITIVO en la lista y en `detalle`
 * (`findById` no cambia) y búsqueda `?q=` por ID («january02» o
 * «JANUARY02-211026») en la lista y en las flechas, con la MISMA condición.
 *
 * La BD es EN MEMORIA y además INTERPRETA lo que el servicio le pide (copia
 * del doble de `quotes.service.vecinos.spec.ts`, más el embed del alias y la
 * sonda): el lector REAL corre contra ella.
 */

type Fila = Record<string, unknown>;
type Op = [string, ...unknown[]];
interface Llamada {
  tabla: string;
  ops: Op[];
}

const CLI_JANUARY = 'cccccccc-0000-4000-8000-000000000375';
const CLI_MAQAR = 'cccccccc-0000-4000-8000-000000000001';
const idDe = (folio: number) =>
  `vvvvvvvv-0000-4000-8000-${String(folio).padStart(12, '0')}`;

const cancun = (dia: string, hora: string): string => {
  const d = new Date(`${dia}T${hora}:00-05:00`);
  return d.toISOString().replace('.000Z', '+00:00');
};

function vuelo(
  folio: number,
  fecha: string | null,
  extra: Partial<Fila> = {},
): Fila {
  return {
    id: idDe(folio),
    folio,
    fecha_vuelo: fecha,
    fecha_solicitud: fecha,
    estado: 'COTIZADO',
    cliente_id: CLI_MAQAR,
    aeronave_id: null,
    es_externo: false,
    grupo_id: null,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    consecutivo_cliente: 1,
    cliente: { nombre: 'Maqar', alias: 'maqar' },
    ...extra,
  };
}

/** #375 y #376 de January Davila (alias january, números 1 y 2) + #341. */
const VUELOS: Fila[] = [
  vuelo(341, cancun('2026-09-20', '10:00'), { consecutivo_cliente: 7 }),
  vuelo(375, cancun('2026-10-15', '09:00'), {
    cliente_id: CLI_JANUARY,
    consecutivo_cliente: 1,
    cliente: { nombre: 'January Davila', alias: 'january' },
  }),
  vuelo(376, cancun('2026-10-21', '09:00'), {
    cliente_id: CLI_JANUARY,
    consecutivo_cliente: 2,
    cliente: [{ nombre: 'January Davila', alias: 'january' }],
  }),
];
const CLIENTES: Fila[] = [
  { id: CLI_JANUARY, nombre: 'January Davila', alias: 'january' },
  { id: CLI_MAQAR, nombre: 'Maqar Machinery', alias: 'maqar' },
];

function texto(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);
}

function comparar(a: unknown, b: unknown): number {
  if (a == null || b == null) return Number.NaN;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  const sa = texto(a);
  const sb = texto(b);
  const ta = Date.parse(sa);
  const tb = Date.parse(sb);
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(sa) &&
    !Number.isNaN(ta) &&
    !Number.isNaN(tb)
  ) {
    return ta - tb;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function ilike(valor: unknown, patron: string): boolean {
  if (valor == null) return false;
  const re = new RegExp(
    '^' +
      patron
        .split('')
        .map((ch) =>
          ch === '%'
            ? '.*'
            : ch === '_'
              ? '.'
              : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('') +
      '$',
    'i',
  );
  return re.test(texto(valor));
}

function partirOr(s: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let actual = '';
  for (const ch of s) {
    if (ch === '(') prof++;
    if (ch === ')') prof--;
    if (ch === ',' && prof === 0) {
      out.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual) out.push(actual);
  return out;
}

function condicionOr(cond: string, f: Fila): boolean {
  const [col, op, ...resto] = cond.split('.');
  const valor = resto.join('.');
  if (op === 'eq') return comparar(f[col], valor) === 0;
  if (op === 'ilike') return ilike(f[col], valor);
  if (op === 'in') {
    const lista = valor.replace(/^\(|\)$/g, '').split(',');
    return lista.includes(String(f[col]));
  }
  throw new Error(`condición no soportada por el doble: ${cond}`);
}

const esSonda = (l: Llamada) =>
  l.tabla === 'vuelo' &&
  l.ops.some((o) => o[0] === 'select' && o[1] === 'consecutivo_cliente');

/** Supabase en memoria que registra cada consulta. */
function bd(
  tablas: Record<string, Fila[]>,
  opts: { sinMigracion?: boolean } = {},
) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const llamada: Llamada = { tabla, ops: [] };
    llamadas.push(llamada);
    const filtros: Array<(f: Fila) => boolean> = [];
    const orden: Array<[string, boolean]> = [];
    let limite: number | null = null;
    let unica = false;
    const b: Record<string, unknown> = {};
    const reg = (op: string, ...args: unknown[]) => {
      llamada.ops.push([op, ...args]);
      return b;
    };
    b.select = (...a: unknown[]) => reg('select', ...a);
    b.eq = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) === 0);
      return reg('eq', c, v);
    };
    b.gt = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) > 0);
      return reg('gt', c, v);
    };
    b.lt = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) < 0);
      return reg('lt', c, v);
    };
    b.gte = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) >= 0);
      return reg('gte', c, v);
    };
    b.lte = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) <= 0);
      return reg('lte', c, v);
    };
    b.ilike = (c: string, p: string) => {
      filtros.push((f) => ilike(f[c], p));
      return reg('ilike', c, p);
    };
    b.in = (c: string, vs: unknown[]) => {
      filtros.push((f) => vs.includes(f[c]));
      return reg('in', c, vs);
    };
    b.or = (s: string) => {
      const conds = partirOr(s);
      filtros.push((f) => conds.some((c) => condicionOr(c, f)));
      return reg('or', s);
    };
    b.order = (c: string, o?: { ascending?: boolean }) => {
      orden.push([c, o?.ascending !== false]);
      return reg('order', c, o);
    };
    b.limit = (n: number) => {
      limite = n;
      return reg('limit', n);
    };
    b.range = (a: number, z: number) => reg('range', a, z);
    b.maybeSingle = () => {
      unica = true;
      return reg('maybeSingle');
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const ejecutar = () => {
        if (opts.sinMigracion && esSonda(llamada)) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column vuelo.consecutivo_cliente does not exist',
            },
          };
        }
        let filas = (tablas[tabla] ?? []).filter((f) =>
          filtros.every((fn) => fn(f)),
        );
        filas = [...filas].sort((x, y) => {
          for (const [c, asc] of orden) {
            const d = comparar(x[c], y[c]);
            if (d !== 0 && !Number.isNaN(d)) return asc ? d : -d;
          }
          return 0;
        });
        if (limite != null) filas = filas.slice(0, limite);
        if (unica) return { data: filas[0] ?? null, error: null };
        return { data: filas, error: null, count: filas.length };
      };
      return Promise.resolve(ejecutar()).then(res, rej);
    };
    return b;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return { supabase, llamadas };
}

function servicio(
  supabase: SupabaseService,
  seguimiento?: Partial<VueloSeguimientoService>,
): QuotesService {
  return new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
    undefined,
    undefined,
    seguimiento as VueloSeguimientoService | undefined,
  );
}

const mundo = () => ({
  vuelo: VUELOS,
  cliente: CLIENTES,
  aeropuerto: [] as Fila[],
  escala: [] as Fila[],
});

/** El `.or()` de la consulta de la lista (la que lleva `range`). */
const orDeLista = (ls: Llamada[]) =>
  ls
    .find((l) => l.tabla === 'vuelo' && l.ops.some((o) => o[0] === 'range'))
    ?.ops.find((o) => o[0] === 'or')?.[1] as string | undefined;
/** Condición `id.in.(…)` de la búsqueda por ID (no `cliente_id.in.(…)`). */
const CONDICION_ID = /(^|,)id\.in\./;
/** Consultas de vuelos por número de cliente (solo la búsqueda por ID). */
const porConsecutivo = (ls: Llamada[]) =>
  ls.filter(
    (l) =>
      l.tabla === 'vuelo' &&
      l.ops.some((o) => o[0] === 'eq' && o[1] === 'consecutivo_cliente'),
  );

describe('QuotesService.list / detalle — clave_cliente (ADITIVO)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('la lista trae clave_cliente por fila AL FINAL (embed objeto o arreglo)', async () => {
    const { supabase } = bd(mundo());
    const r = await servicio(supabase).list({ limit: 50, offset: 0 });
    // `r.data` es la fila cruda (`Record<string, unknown>`) más lo aditivo.
    const claves = new Map(
      r.data.map((d) => [Number((d as Fila).folio), d.clave_cliente]),
    );
    expect(claves.get(375)).toBe('january01-151026');
    expect(claves.get(376)).toBe('january02-211026');
    expect(claves.get(341)).toBe('maqar07-200926');
    expect(Object.keys(r.data[0]).at(-1)).toBe('clave_cliente');
  });

  it('el lector se llama UNA vez por página con todos los ids', async () => {
    const espia = jest.spyOn(lectura, 'clavesClienteDeVuelos');
    const { supabase } = bd(mundo());
    await servicio(supabase).list({ limit: 50, offset: 0 });
    expect(espia).toHaveBeenCalledTimes(1);
    expect([...(espia.mock.calls[0][1] as string[])].sort()).toEqual(
      [idDe(341), idDe(375), idDe(376)].sort(),
    );
  });

  it('detalle trae clave_cliente y conserva el bloque del seguimiento', async () => {
    const bloque = {
      seguimiento_pendientes: 1,
      seguimiento_cotizacion_pendientes: 0,
      seguimiento_pendientes_detalle: [],
    };
    const { supabase } = bd(mundo());
    const svc = servicio(supabase, {
      deCotizacion: jest.fn().mockResolvedValue(bloque),
    });
    const d = (await svc.detalle(idDe(376))) as Fila;
    expect(d.clave_cliente).toBe('january02-211026');
    expect(d).toMatchObject(bloque);
    expect(d.folio).toBe(376);
  });

  it('findById NO llama al lector (revise/confirm/cancel/PDF siguen igual)', async () => {
    const espia = jest.spyOn(lectura, 'clavesClienteDeVuelos');
    const { supabase, llamadas } = bd(mundo());
    const f = (await servicio(supabase).findById(idDe(376))) as Fila;
    expect(f.folio).toBe(376);
    expect(f).not.toHaveProperty('clave_cliente');
    expect(espia).not.toHaveBeenCalled();
    expect(llamadas.some(esSonda)).toBe(false);
  });

  it('sin la migración: clave_cliente null en todas las filas', async () => {
    const { supabase } = bd(mundo(), { sinMigracion: true });
    const r = await servicio(supabase).list({ limit: 50, offset: 0 });
    for (const d of r.data) expect(d.clave_cliente).toBeNull();
  });
});

describe('QuotesService — búsqueda ?q= por ID del cliente', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['january02', 'JANUARY02-211026', ' january2 ', 'january02-010199'])(
    '%p ⇒ el .or() suma id.in.(<#376>) y la lista lo devuelve (la fecha escrita se ignora)',
    async (q) => {
      const { supabase, llamadas } = bd(mundo());
      const r = await servicio(supabase).list({ q, limit: 50, offset: 0 });
      expect(orDeLista(llamadas)).toContain(`id.in.(${idDe(376)})`);
      expect(r.data.map((d) => Number((d as Fila).folio))).toEqual([376]);
      // El .or() JAMÁS nombra la columna nueva.
      expect(orDeLista(llamadas)).not.toContain('consecutivo_cliente');
    },
  );

  it("'january09' (no existe) ⇒ sin condición extra", async () => {
    const { supabase, llamadas } = bd(mundo());
    await servicio(supabase).list({ q: 'january09', limit: 50, offset: 0 });
    expect(orDeLista(llamadas)).not.toMatch(CONDICION_ID);
    expect(porConsecutivo(llamadas)).toHaveLength(1);
  });

  it('sin la migración (42703 en la sonda) ⇒ sin condición extra y sin consultas por número', async () => {
    const { supabase, llamadas } = bd(mundo(), { sinMigracion: true });
    await servicio(supabase).list({ q: 'january02', limit: 50, offset: 0 });
    expect(orDeLista(llamadas)).not.toMatch(CONDICION_ID);
    expect(porConsecutivo(llamadas)).toHaveLength(0);
    // Ni una consulta de cliente por alias.
    expect(
      llamadas.some((l) =>
        l.ops.some((o) => o[0] === 'eq' && o[1] === 'alias'),
      ),
    ).toBe(false);
  });

  it.each(['maqar', '341', 'CUN'])(
    "'%s' (sin forma de ID) ⇒ CERO consultas nuevas: 1 a cliente y 1 a aeropuerto, como hoy",
    async (q) => {
      const { supabase, llamadas } = bd(mundo());
      await servicio(supabase).list({ q, limit: 50, offset: 0 });
      expect(llamadas.filter((l) => l.tabla === 'cliente')).toHaveLength(1);
      expect(llamadas.filter((l) => l.tabla === 'aeropuerto')).toHaveLength(1);
      expect(porConsecutivo(llamadas)).toHaveLength(0);
      expect(orDeLista(llamadas)).not.toMatch(CONDICION_ID);
    },
  );

  it('vecinos(q=january02) arma la MISMA condición que la lista (paridad de las flechas)', async () => {
    const { supabase, llamadas } = bd(mundo());
    const svc = servicio(supabase);
    await svc.list({ q: 'january02', limit: 50, offset: 0 });
    const orLista = orDeLista(llamadas);
    llamadas.length = 0;
    const r = await svc.vecinos(idDe(375), { q: 'january02' });
    const orVecinos = llamadas
      .filter((l) => l.tabla === 'vuelo' && !esSonda(l))
      .map((l) => l.ops.find((o) => o[0] === 'or')?.[1])
      .filter((x) => x !== undefined);
    expect(orVecinos).toEqual([orLista, orLista, orLista, orLista]);
    // Desde el #375 (15-oct), el único que cumple es el #376 (21-oct).
    expect(r.siguiente?.folio).toBe(376);
    expect(r.anterior).toBeNull();
  });
});
