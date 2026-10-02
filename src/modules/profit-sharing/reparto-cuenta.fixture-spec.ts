import { HttpException } from '@nestjs/common';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ProfitSharingService } from './profit-sharing.service';
import { RepartoCuentaService } from './reparto-cuenta.service';
import {
  utilidadMesDesdeAviones,
  type RepartoAvionInput,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import { RepartoPagoService } from './reparto-pago.service';

/**
 * MUNDO de los specs de la CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026):
 * `reparto-cuenta.service.spec` y `reparto-pago.service.spec`. BD en
 * memoria mínima (PostgREST falso que INTERPRETA eq/in/is/gte/lte/order/
 * range) + un doble de `ProfitSharingService.utilidadesSociosPorMes` que
 * arma cada mes con `utilidadMesDesdeAviones` (la MISMA lectura del
 * reparto que el servicio real).
 *
 * Números REALES: N4142R, septiembre 2026, saldo $2,023.10 repartido 69 /
 * 29 / 2 por residuo mayor ⇒ Mauricio Roque $1,395.94 · Aero Charter
 * Cancun $586.70 · Alexander E. Saab $40.46. «Hoy» = 1-oct-2026 13:00
 * Cancún ⇒ mes en curso 2026-10.
 *
 * `*-spec.ts` (sin punto) ⇒ fuera del build y fuera de jest.
 */
export type Fila = Record<string, unknown>;

export const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
export const N990GG = 'aaaaaaaa-0000-4000-8000-000000000990';
export const XBAJA = 'aaaaaaaa-0000-4000-8000-0000000000b0';
export const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
export const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
export const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
export const ALE = 'cccccccc-0000-4000-8000-0000000000a1';
export const MARY = 'cccccccc-0000-4000-8000-0000000000a2';
export const BAJA = 'cccccccc-0000-4000-8000-0000000000b0';
export const PILOTO = 'cccccccc-0000-4000-8000-0000000000c1';
export const KEY = 'eeeeeeee-0000-4000-8000-000000000001';
export const KEY2 = 'eeeeeeee-0000-4000-8000-000000000002';

export const HOY = new Date('2026-10-01T18:00:00Z'); // 13:00 Cancún

export function avionN4142R(
  saldo: '2023.10' | 'cero' = '2023.10',
): RepartoAvionInput {
  const m = (v: number) => (saldo === 'cero' ? 0 : v);
  return {
    aeronave: { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
    reparto: [
      {
        socio_id: MAURICIO,
        socio_nombre: 'Mauricio Roque',
        porcentaje: 69,
        monto_usd: m(1395.94),
      },
      {
        socio_id: AERO,
        socio_nombre: 'Aero Charter Cancun S.A. de C.V.',
        porcentaje: 29,
        monto_usd: m(586.7),
      },
      {
        socio_id: SAAB,
        socio_nombre: 'Alexander E. Saab',
        porcentaje: 2,
        monto_usd: m(40.46),
      },
    ],
  };
}

/** Utilidades por mes del mundo: septiembre real, el resto en cero. */
export const UTILIDADES_DEFAULT: Record<string, RepartoAvionInput[]> = {
  '2026-09': [avionN4142R()],
};

interface OpcionesDb {
  /** La migración 20261002000001 no está aplicada. */
  sinMigracion?: boolean;
  /** Error de Postgres que devuelve el INSERT de reparto_pago. */
  errorEnInsert?: { code: string; message: string };
}

export function fakeDb(datos: Record<string, Fila[]>, opts: OpcionesDb = {}) {
  const tablas: Record<string, Fila[]> = {};
  for (const [k, v] of Object.entries(datos)) {
    tablas[k] = v.map((f) => ({ ...f }));
  }
  const tabla = (t: string) => (tablas[t] ??= []);
  const escrituras: Array<{ tabla: string; op: string; valor: Fila }> = [];
  let seq = 100;
  let reloj = 0;
  const sello = () =>
    `2026-10-01T16:00:${String(++reloj).padStart(2, '0')}.000000+00:00`;

  const from = (t: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    let cols = '*';
    let valor: Fila = {};
    const filtros: Array<(f: Fila) => boolean> = [];
    let orden: { col: string; asc: boolean } | null = null;
    let rango: [number, number] | null = null;
    const ejecutar = (): { data: unknown; error: unknown } => {
      if (opts.sinMigracion) {
        if (t === 'reparto_cuenta_socio') {
          return {
            data: null,
            error: {
              code: 'PGRST205',
              message:
                "Could not find the table 'public.reparto_cuenta_socio' in the schema cache",
            },
          };
        }
        if (t === 'reparto_pago' && cols.includes('saldo_snapshot_usd')) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column reparto_pago.saldo_snapshot_usd does not exist',
            },
          };
        }
      }
      if (op === 'insert') {
        if (t === 'reparto_pago' && opts.errorEnInsert) {
          return { data: null, error: opts.errorEnInsert };
        }
        if (
          valor.client_request_id &&
          tabla(t).some((f) => f.client_request_id === valor.client_request_id)
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          };
        }
        if (
          t === 'reparto_cuenta_socio' &&
          tabla(t).some((f) => f.socio_id === valor.socio_id)
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'reparto_cuenta_socio_pkey' },
          };
        }
        const ts = sello();
        const nueva: Fila =
          t === 'reparto_cuenta_socio'
            ? { created_at: ts, updated_at: ts, ...valor }
            : {
                id: `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
                comprobante_path: null,
                created_at: ts,
                updated_by: null,
                updated_at: ts,
                deleted_at: null,
                deleted_by: null,
                motivo_baja: null,
                ...valor,
              };
        tabla(t).push(nueva);
        escrituras.push({ tabla: t, op, valor });
        return { data: [{ ...nueva }], error: null };
      }
      let filas = tabla(t).filter((f) => filtros.every((fn) => fn(f)));
      if (op === 'update') {
        const ts = sello();
        for (const f of filas) Object.assign(f, valor, { updated_at: ts });
        escrituras.push({ tabla: t, op, valor });
      }
      if (orden) {
        const { col, asc } = orden;
        filas = [...filas].sort((a, b) =>
          String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      if (rango) filas = filas.slice(rango[0], rango[1] + 1);
      return { data: filas.map((f) => ({ ...f })), error: null };
    };
    const q: Record<string, unknown> = {};
    q.select = (c?: string) => {
      if (typeof c === 'string') cols = c;
      return q;
    };
    q.insert = (v: Fila) => {
      op = 'insert';
      valor = v;
      return q;
    };
    q.update = (v: Fila) => {
      op = 'update';
      valor = v;
      return q;
    };
    q.eq = (c: string, v: unknown) => {
      filtros.push((f) => f[c] === v);
      return q;
    };
    q.in = (c: string, arr: unknown[]) => {
      filtros.push((f) => arr.includes(f[c]));
      return q;
    };
    q.is = (c: string, v: unknown) => {
      filtros.push((f) => (v === null ? f[c] == null : f[c] === v));
      return q;
    };
    q.gte = (c: string, v: string) => {
      filtros.push((f) => String(f[c]) >= v);
      return q;
    };
    q.lte = (c: string, v: string) => {
      filtros.push((f) => String(f[c]) <= v);
      return q;
    };
    q.order = (col: string, o?: { ascending?: boolean }) => {
      orden = { col, asc: o?.ascending !== false };
      return q;
    };
    q.range = (a: number, b: number) => {
      rango = [a, b];
      return q;
    };
    q.limit = () => q;
    const uno = () => {
      const r = ejecutar();
      return Promise.resolve({
        data: Array.isArray(r.data)
          ? ((r.data as unknown[])[0] ?? null)
          : r.data,
        error: r.error,
      });
    };
    q.maybeSingle = uno;
    q.single = uno;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(res, rej);
    return q;
  };

  const archivos = new Map<string, Buffer>();
  const removidos: string[] = [];
  const storage = {
    from: (bucket: string) => ({
      upload: (path: string, buf: Buffer) => {
        archivos.set(`${bucket}/${path}`, buf);
        return Promise.resolve({ data: { path }, error: null });
      },
      remove: (paths: string[]) => {
        removidos.push(...paths);
        return Promise.resolve({ data: [], error: null });
      },
      createSignedUrls: (paths: string[], seg: number) =>
        Promise.resolve({
          data: paths.map((p) => ({
            path: p,
            signedUrl: `https://firmada/${bucket}/${p}?exp=${seg}`,
            error: null,
          })),
          error: null,
        }),
    }),
  };

  return {
    supabase: { service: { from, storage } } as unknown as SupabaseService,
    tablas,
    escrituras,
    archivos,
    removidos,
  };
}

export function pagoFila(p: Partial<Fila> = {}): Fila {
  return {
    id: 'dddddddd-0000-4000-8000-000000000001',
    aeronave_id: N4142R,
    socio_id: MAURICIO,
    periodo: '2026-09-01',
    monto: 1000,
    moneda: 'USD',
    tc_usd_mxn: null,
    monto_usd: 1000,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: 1395.94,
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    referencia: 'SPEI 001',
    entregado_por: MARY,
    recibido_por: null,
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ALE,
    created_at: '2026-10-01T15:00:00.000000+00:00',
    updated_by: null,
    updated_at: '2026-10-01T15:00:00.000000+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...p,
  };
}

export interface OpcionesMundo extends OpcionesDb {
  pagos?: Fila[];
  cuentas?: Fila[];
  /** Utilidades por mes (default: septiembre real, el resto en cero). */
  utilidades?: Record<string, RepartoAvionInput[]>;
}

/** El mundo completo: BD en memoria + los dos servicios con el reloj fijo. */
export function mundo(opts: OpcionesMundo = {}) {
  const db = fakeDb(
    {
      usuario: [
        { id: ALE, nombre: 'Ale Canales', rol: 'ADMIN', estado: 'ACTIVO' },
        { id: MARY, nombre: 'Mary Cruz', rol: 'FACTURACION', estado: 'ACTIVO' },
        { id: BAJA, nombre: 'Ex empleado', rol: 'ADMIN', estado: 'INACTIVO' },
        {
          id: MAURICIO,
          nombre: 'Mauricio Roque',
          rol: 'SOCIO',
          estado: 'ACTIVO',
        },
        {
          id: AERO,
          nombre: 'Aero Charter Cancun S.A. de C.V.',
          rol: 'SOCIO',
          estado: 'INACTIVO',
          // La propia empresa registrada como socio (seed 20260512000005).
          es_empresa: true,
        },
        {
          id: SAAB,
          nombre: 'Alexander E. Saab',
          rol: 'PILOTO',
          estado: 'ACTIVO',
        },
        { id: PILOTO, nombre: 'Piloto X', rol: 'PILOTO', estado: 'ACTIVO' },
      ],
      aeronave: [
        { id: N4142R, matricula: 'N4142R', activa: true },
        { id: N990GG, matricula: 'N990GG', activa: true },
        { id: XBAJA, matricula: 'XA-OLD', activa: false },
      ],
      aeronave_socio: [
        {
          aeronave_id: N4142R,
          socio_id: MAURICIO,
          porcentaje: '69.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          aeronave_id: N4142R,
          socio_id: AERO,
          porcentaje: '29.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          aeronave_id: N4142R,
          socio_id: SAAB,
          porcentaje: '2.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        // Mauricio fue socio de N990GG solo hasta julio.
        {
          aeronave_id: N990GG,
          socio_id: MAURICIO,
          porcentaje: '50.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: '2026-07-31',
        },
      ],
      reparto_pago: opts.pagos ?? [],
      reparto_cuenta_socio: opts.cuentas ?? [],
    },
    opts,
  );
  const porMes = opts.utilidades ?? UTILIDADES_DEFAULT;
  const utilidadesSociosPorMes = jest.fn(
    (meses: ReadonlyArray<string>, mesActual: string) =>
      Promise.resolve<UtilidadMesSocios[]>(
        meses.map((m) =>
          utilidadMesDesdeAviones(m, porMes[m] ?? [], m === mesActual),
        ),
      ),
  );
  const profitSharing = {
    utilidadesSociosPorMes,
  } as unknown as ProfitSharingService;
  const cuentas = new RepartoCuentaService(db.supabase, profitSharing);
  cuentas.ahora = () => HOY;
  const pagos = new RepartoPagoService(db.supabase, cuentas);
  return { ...db, cuentas, pagos, utilidadesSociosPorMes };
}

export async function errorDe(p: Promise<unknown>): Promise<{
  status: number;
  code: string;
  details?: unknown;
  message?: string;
}> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as {
        error?: string;
        details?: unknown;
        message?: string;
      };
      return {
        status: e.getStatus(),
        code: String(r.error),
        details: r.details,
        message: r.message,
      };
    }
    throw e;
  }
  throw new Error('se esperaba un error');
}
