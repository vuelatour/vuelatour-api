// La utilidad sale de ProfitSharingService.compute (aquí un doble): el
// servicio real arrastra pyservices/tipo de cambio/conciliación.
jest.mock('./profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));

import { HttpException } from '@nestjs/common';
import { Rol } from '../../common/types/auth.types';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ProfitSharingService } from './profit-sharing.service';
import type { CrearPagoSocioDto } from './dto/reparto-pago.dto';
import { RepartoPagoService } from './reparto-pago.service';
import type { RepartoAvionInput } from './reparto-pago.util';

/**
 * PAGOS DE UTILIDADES A SOCIOS (1-oct-2026) contra una BD en memoria
 * mínima: listado por mes (SOCIO solo lo suyo), alta USD/MXN, exceso 409 y
 * con `aceptar_exceso`, SIN_UTILIDAD, socio ajeno, idempotencia, PATCH con
 * estado fusionado y CAS, soft delete, comprobante y 503 sin la migración.
 * Números REALES: N4142R, septiembre 2026, saldo $2,023.10 ⇒ 69 / 29 / 2.
 */
type Fila = Record<string, unknown>;

const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const N990GG = 'aaaaaaaa-0000-4000-8000-000000000990';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';
const MARY = 'cccccccc-0000-4000-8000-0000000000a2';
const BAJA = 'cccccccc-0000-4000-8000-0000000000b0';
const KEY = 'eeeeeeee-0000-4000-8000-000000000001';

const ADMIN = { userId: ALE, rol: Rol.ADMIN };

const AVION_N4142R: RepartoAvionInput = {
  aeronave: { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
  reparto: [
    {
      socio_id: MAURICIO,
      socio_nombre: 'Mauricio Roque',
      porcentaje: 69,
      monto_usd: 1395.94,
    },
    {
      socio_id: AERO,
      socio_nombre: 'Aero Charter Cancun S.A. de C.V.',
      porcentaje: 29,
      monto_usd: 586.7,
    },
    {
      socio_id: SAAB,
      socio_nombre: 'Alexander E. Saab',
      porcentaje: 2,
      monto_usd: 40.46,
    },
  ],
};

interface Opciones {
  /** La migración 20261001000001 no está aplicada. */
  sinTabla?: boolean;
  /** Se ejecuta justo antes de cada UPDATE de reparto_pago (carreras). */
  antesDeUpdate?: (tablas: Record<string, Fila[]>) => void;
  /** Error de Postgres que devuelve el INSERT de reparto_pago. */
  errorEnInsert?: { code: string; message: string };
}

function fakeDb(datos: Record<string, Fila[]>, opts: Opciones = {}) {
  const tablas: Record<string, Fila[]> = {};
  for (const [k, v] of Object.entries(datos))
    tablas[k] = v.map((f) => ({ ...f }));
  const tabla = (t: string) => (tablas[t] ??= []);
  const consultas: Array<{
    tabla: string;
    op: string;
    filtros: Array<[string, unknown]>;
  }> = [];
  const escrituras: Array<{ tabla: string; op: string; valor: Fila }> = [];
  let seq = 100;
  let reloj = 0;
  const sello = () =>
    `2026-10-01T16:00:${String(++reloj).padStart(2, '0')}.000000+00:00`;

  const from = (t: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    let valor: Fila = {};
    const filtros: Array<(f: Fila) => boolean> = [];
    const filtrosLog: Array<[string, unknown]> = [];
    let orden: { col: string; asc: boolean } | null = null;
    let rango: [number, number] | null = null;
    const ejecutar = (): { data: unknown; error: unknown } => {
      consultas.push({ tabla: t, op, filtros: filtrosLog });
      if (t === 'reparto_pago' && opts.sinTabla) {
        return {
          data: null,
          error: {
            code: 'PGRST205',
            message:
              "Could not find the table 'public.reparto_pago' in the schema cache",
          },
        };
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
            error: {
              code: '23505',
              message: 'duplicate key uq_reparto_pago_client_request',
            },
          };
        }
        const ts = sello();
        const nueva: Fila = {
          id: `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          comprobante_path: null,
          created_at: ts,
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
      if (op === 'update' && t === 'reparto_pago') opts.antesDeUpdate?.(tablas);
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
    q.select = () => q;
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
      filtrosLog.push([c, v]);
      filtros.push((f) => f[c] === v);
      return q;
    };
    q.in = (c: string, arr: unknown[]) => {
      filtrosLog.push([c, arr]);
      filtros.push((f) => arr.includes(f[c]));
      return q;
    };
    q.is = (c: string, v: unknown) => {
      filtrosLog.push([c, v]);
      filtros.push((f) => (v === null ? f[c] == null : f[c] === v));
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
    consultas,
    escrituras,
    archivos,
    removidos,
  };
}

function base(
  opts: Opciones & { pagos?: Fila[]; aviones?: RepartoAvionInput[] } = {},
) {
  const db = fakeDb(
    {
      usuario: [
        { id: ALE, nombre: 'Ale Canales', estado: 'ACTIVO' },
        { id: MARY, nombre: 'Mary Cruz', estado: 'ACTIVO' },
        { id: BAJA, nombre: 'Ex empleado', estado: 'INACTIVO' },
        { id: MAURICIO, nombre: 'Mauricio Roque', estado: 'ACTIVO' },
        {
          id: AERO,
          nombre: 'Aero Charter Cancun S.A. de C.V.',
          estado: 'INACTIVO',
        },
        { id: SAAB, nombre: 'Alexander E. Saab', estado: 'ACTIVO' },
      ],
      aeronave: [
        { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
        { id: N990GG, matricula: 'N990GG', modelo: 'C182' },
      ],
      aeronave_socio: [
        {
          aeronave_id: N4142R,
          socio_id: MAURICIO,
          porcentaje: 69,
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          aeronave_id: N4142R,
          socio_id: AERO,
          porcentaje: 29,
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          aeronave_id: N4142R,
          socio_id: SAAB,
          porcentaje: 2,
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        // Socio de N990GG solo hasta julio: no toca septiembre.
        {
          aeronave_id: N990GG,
          socio_id: MAURICIO,
          porcentaje: 50,
          vigente_desde: '2026-01-01',
          vigente_hasta: '2026-07-31',
        },
      ],
      reparto_pago: opts.pagos ?? [],
    },
    opts,
  );
  const aviones = opts.aviones ?? [AVION_N4142R];
  const compute = jest.fn((q: { aeronave_id?: string }) =>
    Promise.resolve({
      aviones: q.aeronave_id
        ? aviones.filter((a) => a.aeronave.id === q.aeronave_id)
        : aviones,
    }),
  );
  const svc = new RepartoPagoService(db.supabase, {
    compute,
  } as unknown as ProfitSharingService);
  svc.ahora = () => new Date('2026-10-01T18:00:00Z'); // 13:00 Cancún
  return { svc, compute, ...db };
}

function pagoFila(p: Partial<Fila> = {}): Fila {
  return {
    id: 'dddddddd-0000-4000-8000-000000000001',
    aeronave_id: N4142R,
    socio_id: MAURICIO,
    periodo: '2026-09-01',
    monto: 1000,
    moneda: 'USD',
    tc_usd_mxn: null,
    monto_usd: 1000,
    utilidad_snapshot_usd: 1395.94,
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
    updated_at: '2026-10-01T15:00:00.000000+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...p,
  };
}

function dtoAlta(p: Partial<CrearPagoSocioDto> = {}): CrearPagoSocioDto {
  return {
    aeronave_id: N4142R,
    socio_id: MAURICIO,
    mes: '2026-09',
    monto: 1395.94,
    moneda: 'USD',
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    ...p,
  };
}

async function errorDe(
  p: Promise<unknown>,
): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as { error?: string; details?: unknown };
      return {
        status: e.getStatus(),
        code: String(r.error),
        details: r.details,
      };
    }
    throw e;
  }
  throw new Error('se esperaba un error');
}

describe('RepartoPagoService.listar', () => {
  it('renglones del mes con utilidad, pagos (nombres + URL 8 h), consolidado y totales', async () => {
    const { svc, compute, consultas } = base({
      pagos: [
        pagoFila({ comprobante_path: `${N4142R}/2026-09/p1/u.pdf` }),
        // Borrado: no cuenta ni se lista.
        pagoFila({
          id: 'dddddddd-0000-4000-8000-000000000009',
          monto_usd: 500,
          deleted_at: '2026-10-01T17:00:00Z',
        }),
        // Otro mes: no cuenta.
        pagoFila({
          id: 'dddddddd-0000-4000-8000-000000000008',
          periodo: '2026-08-01',
        }),
      ],
    });
    const r = await svc.listar('2026-09', undefined, ADMIN);
    expect(compute).toHaveBeenCalledWith({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      aeronave_id: undefined,
    });
    expect(r).toMatchObject({
      disponible: true,
      mes: '2026-09',
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(
      r.filas.map((f) => [
        f.socio.nombre,
        f.utilidad_usd,
        f.pagado_usd,
        f.pendiente_usd,
        f.estado,
      ]),
    ).toEqual([
      ['Mauricio Roque', 1395.94, 1000, 395.94, 'PARCIAL'],
      ['Aero Charter Cancun S.A. de C.V.', 586.7, 0, 586.7, 'PENDIENTE'],
      ['Alexander E. Saab', 40.46, 0, 40.46, 'PENDIENTE'],
    ]);
    const p = r.filas[0].pagos[0];
    expect(p).toMatchObject({
      entregado_por: MARY,
      entregado_por_nombre: 'Mary Cruz',
      created_by_nombre: 'Ale Canales',
      comprobante_url: `https://firmada/reparto-comprobantes/${N4142R}/2026-09/p1/u.pdf?exp=28800`,
    });
    expect(r.totales).toEqual({
      utilidad_usd: 2023.1,
      pagado_usd: 1000,
      pendiente_usd: 1023.1,
      socios_pendientes: 3,
    });
    expect(r.por_socio).toHaveLength(3);
    // La lectura: mes (día 1) y solo vivos.
    const q = consultas.find(
      (c) =>
        c.tabla === 'reparto_pago' && c.filtros.some(([k]) => k === 'periodo'),
    )!;
    expect(q.filtros).toEqual(
      expect.arrayContaining([
        ['periodo', '2026-09-01'],
        ['deleted_at', null],
      ]),
    );
  });

  it('SOCIO: solo SUS renglones (y la consulta ya filtra por él)', async () => {
    const { svc, consultas } = base({
      pagos: [
        pagoFila(),
        pagoFila({
          id: 'dddddddd-0000-4000-8000-000000000002',
          socio_id: SAAB,
          monto_usd: 40.46,
          monto: 40.46,
        }),
      ],
    });
    const r = await svc.listar('2026-09', undefined, {
      userId: MAURICIO,
      rol: Rol.SOCIO,
    });
    expect(r.filas.map((f) => f.socio.id)).toEqual([MAURICIO]);
    expect(r.por_socio.map((s) => s.socio.id)).toEqual([MAURICIO]);
    expect(r.totales).toEqual({
      utilidad_usd: 1395.94,
      pagado_usd: 1000,
      pendiente_usd: 395.94,
      socios_pendientes: 1,
    });
    const q = consultas.find(
      (c) =>
        c.tabla === 'reparto_pago' && c.filtros.some(([k]) => k === 'periodo'),
    )!;
    expect(q.filtros).toContainEqual(['socio_id', MAURICIO]);
  });

  it('sin la migración: disponible:false con listas vacías (sin calcular el reparto)', async () => {
    const { svc, compute } = base({ sinTabla: true });
    const r = await svc.listar('2026-09', undefined, ADMIN);
    expect(r).toEqual({
      disponible: false,
      mes: '2026-09',
      desde: '2026-09-01',
      hasta: '2026-09-30',
      filas: [],
      por_socio: [],
      totales: {
        utilidad_usd: 0,
        pagado_usd: 0,
        pendiente_usd: 0,
        socios_pendientes: 0,
      },
    });
    expect(compute).not.toHaveBeenCalled();
  });

  it('pagos en un avión dado de baja (no viene en el cálculo): renglón con el aviso del AVIÓN, no de captura', async () => {
    const { svc } = base({
      pagos: [pagoFila({ aeronave_id: N990GG, monto_usd: 25, monto: 25 })],
    });
    const r = await svc.listar('2026-09', undefined, ADMIN);
    const f = r.filas.find((x) => x.aeronave.id === N990GG)!;
    expect(f).toMatchObject({
      aeronave: { matricula: 'N990GG' },
      socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
      utilidad_usd: 0,
      estado: 'SIN_UTILIDAD',
      exceso_usd: 25,
      vigente: false,
    });
    expect(f.aviso).toBe(
      'El avión está dado de baja: el reparto no calcula su utilidad de septiembre 2026, así que no hay nada que pagar desde aquí. Los pagos que ya se registraron se conservan en esta relación.',
    );
    expect(f.aviso).not.toContain('avión correcto');
  });

  it('pagos de un socio que ya no está en el reparto de un avión ACTIVO: aviso de revisar la captura', async () => {
    const { svc } = base({
      pagos: [pagoFila({ socio_id: MARY, monto_usd: 25, monto: 25 })],
    });
    const r = await svc.listar('2026-09', undefined, ADMIN);
    const f = r.filas.find((x) => x.socio.id === MARY)!;
    expect(f).toMatchObject({
      aeronave: { matricula: 'N4142R' },
      socio: { nombre: 'Mary Cruz' },
      vigente: false,
    });
    expect(f.aviso).toContain('ya no está en el reparto');
  });
});

describe('RepartoPagoService.crear', () => {
  it('alta USD: monto_usd = monto, foto de la utilidad, entregó = el actor; fila recalculada', async () => {
    const { svc, tablas } = base();
    const r = await svc.crear(
      dtoAlta({ monto: 1000, referencia: '  SPEI 0012345 ', notas: '' }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toHaveLength(1);
    expect(tablas.reparto_pago[0]).toMatchObject({
      aeronave_id: N4142R,
      socio_id: MAURICIO,
      periodo: '2026-09-01',
      monto: 1000,
      moneda: 'USD',
      tc_usd_mxn: null,
      monto_usd: 1000,
      utilidad_snapshot_usd: 1395.94,
      fecha_pago: '2026-10-01',
      metodo: 'TRANSFERENCIA',
      referencia: 'SPEI 0012345',
      notas: null,
      entregado_por: ALE,
      created_by: ALE,
    });
    expect(r.pago).toMatchObject({
      monto_usd: 1000,
      entregado_por_nombre: 'Ale Canales',
    });
    expect(r.fila).toMatchObject({
      socio: { id: MAURICIO },
      utilidad_usd: 1395.94,
      pagado_usd: 1000,
      pendiente_usd: 395.94,
      estado: 'PARCIAL',
    });
    expect(r).not.toHaveProperty('idempotente');
  });

  it('alta MXN: T.C. de 6 decimales y monto_usd = round(monto / tc, 2); entregó otra persona', async () => {
    const { svc, tablas } = base();
    const r = await svc.crear(
      dtoAlta({
        monto: 10000,
        moneda: 'MXN',
        tc_usd_mxn: 18.2345674,
        entregado_por_id: MARY,
        recibido_por: 'Contador del socio',
        factura_folio: 'A-123',
      }),
      ADMIN,
    );
    expect(tablas.reparto_pago[0]).toMatchObject({
      monto: 10000,
      moneda: 'MXN',
      tc_usd_mxn: 18.234567,
      monto_usd: 548.41,
      entregado_por: MARY,
      recibido_por: 'Contador del socio',
      factura_folio: 'A-123',
    });
    expect(r.fila).toMatchObject({
      pagado_usd: 548.41,
      pendiente_usd: 847.53,
      estado: 'PARCIAL',
    });
  });

  it('exceso: 409 PAGO_EXCEDE_UTILIDAD sin escribir; con aceptar_exceso y la MISMA llave se guarda', async () => {
    const { svc, tablas } = base({ pagos: [pagoFila()] });
    const e = await errorDe(
      svc.crear(dtoAlta({ monto: 500, client_request_id: KEY }), ADMIN),
    );
    expect(e).toEqual({
      status: 409,
      code: 'PAGO_EXCEDE_UTILIDAD',
      details: {
        utilidad_usd: 1395.94,
        pagado_usd: 1000,
        monto_usd: 500,
        exceso_usd: 104.06,
      },
    });
    expect(tablas.reparto_pago).toHaveLength(1);
    const r = await svc.crear(
      dtoAlta({ monto: 500, client_request_id: KEY, aceptar_exceso: true }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toHaveLength(2);
    expect(r.fila).toMatchObject({
      pagado_usd: 1500,
      estado: 'PAGADO',
      exceso_usd: 104.06,
      pendiente_usd: 0,
    });
  });

  it('dentro de la tolerancia de $1 no es exceso', async () => {
    const { svc, tablas } = base({ pagos: [pagoFila()] });
    await svc.crear(dtoAlta({ monto: 396.94 }), ADMIN);
    expect(tablas.reparto_pago).toHaveLength(2);
  });

  it('SIN utilidad: 409 SIN_UTILIDAD_QUE_PAGAR, también con aceptar_exceso', async () => {
    const perdida: RepartoAvionInput = {
      ...AVION_N4142R,
      reparto: AVION_N4142R.reparto.map((x) => ({
        ...x,
        monto_usd: -x.monto_usd,
      })),
    };
    const { svc, tablas } = base({ aviones: [perdida] });
    for (const aceptar of [undefined, true]) {
      const e = await errorDe(
        svc.crear(dtoAlta({ monto: 10, aceptar_exceso: aceptar }), ADMIN),
      );
      expect(e.status).toBe(409);
      expect(e.code).toBe('SIN_UTILIDAD_QUE_PAGAR');
      expect(e.details).toMatchObject({
        utilidad_usd: -1395.94,
        avion_activo: true,
        mes: '2026-09',
      });
    }
    expect(tablas.reparto_pago).toHaveLength(0);
  });

  it('socio que no es del avión (o cuya vigencia no toca el mes): 400 sin calcular nada', async () => {
    const { svc, compute, tablas } = base();
    const ajeno = await errorDe(svc.crear(dtoAlta({ socio_id: MARY }), ADMIN));
    expect(ajeno).toMatchObject({
      status: 400,
      code: 'SOCIO_NO_ES_DE_LA_AERONAVE',
    });
    // Mauricio fue socio de N990GG hasta julio: septiembre no.
    const vencido = await errorDe(
      svc.crear(dtoAlta({ aeronave_id: N990GG }), ADMIN),
    );
    expect(vencido).toMatchObject({
      status: 400,
      code: 'SOCIO_NO_ES_DE_LA_AERONAVE',
    });
    expect(compute).not.toHaveBeenCalled();
    expect(tablas.reparto_pago).toHaveLength(0);
  });

  it('reglas de forma: T.C. según moneda, fecha no futura, quién entregó activo', async () => {
    const { svc, tablas } = base();
    expect(
      (await errorDe(svc.crear(dtoAlta({ moneda: 'MXN', monto: 100 }), ADMIN)))
        .code,
    ).toBe('TC_REQUERIDO');
    expect(
      (await errorDe(svc.crear(dtoAlta({ tc_usd_mxn: 18.2 }), ADMIN))).code,
    ).toBe('TC_NO_APLICA');
    expect(
      (await errorDe(svc.crear(dtoAlta({ fecha_pago: '2026-10-02' }), ADMIN)))
        .code,
    ).toBe('FECHA_PAGO_FUTURA');
    expect(
      (await errorDe(svc.crear(dtoAlta({ entregado_por_id: BAJA }), ADMIN)))
        .code,
    ).toBe('ENTREGADO_POR_INVALIDO');
    expect(tablas.reparto_pago).toHaveLength(0);
  });

  it('idempotencia: el replay devuelve el MISMO pago (idempotente) sin escribir otra vez', async () => {
    const { svc, tablas } = base();
    const a = await svc.crear(
      dtoAlta({ monto: 1000, client_request_id: KEY }),
      ADMIN,
    );
    // El replay llega aunque ahora «excedería» (va ANTES de todo candado).
    const b = await svc.crear(
      dtoAlta({ monto: 1000, client_request_id: KEY }),
      ADMIN,
    );
    expect(tablas.reparto_pago).toHaveLength(1);
    expect(b.idempotente).toBe(true);
    expect(b.pago.id).toBe(a.pago.id);
    expect(b.fila).toMatchObject({ pagado_usd: 1000 });
    // La misma llave para OTRO renglón ⇒ 409, jamás el pago ajeno.
    const e = await errorDe(
      svc.crear(
        dtoAlta({ socio_id: SAAB, monto: 10, client_request_id: KEY }),
        ADMIN,
      ),
    );
    expect(e).toMatchObject({ status: 409, code: 'CLIENT_REQUEST_ID_EN_USO' });
  });

  it('sin la migración: 503 PAGOS_SOCIOS_NO_DISPONIBLE', async () => {
    const { svc } = base({ sinTabla: true });
    expect(await errorDe(svc.crear(dtoAlta(), ADMIN))).toMatchObject({
      status: 503,
      code: 'PAGOS_SOCIOS_NO_DISPONIBLE',
      details: { migracion: '20261001000001' },
    });
  });
});

describe('RepartoPagoService.actualizar', () => {
  const P1 = 'dddddddd-0000-4000-8000-000000000001';

  it('solo metadatos: no re-valida el exceso y escribe SOLO lo que cambió', async () => {
    const { svc, escrituras } = base({
      pagos: [pagoFila({ monto: 1500, monto_usd: 1500 })],
    });
    const r = await svc.actualizar(
      P1,
      {
        notas: 'Entregado en la oficina',
        referencia: 'SPEI 001',
      },
      ADMIN,
    );
    const upd = escrituras.filter(
      (w) => w.tabla === 'reparto_pago' && w.op === 'update',
    );
    expect(upd).toHaveLength(1);
    expect(upd[0].valor).toEqual({ notas: 'Entregado en la oficina' });
    expect(r.pago.notas).toBe('Entregado en la oficina');
    expect(r.fila).toMatchObject({ pagado_usd: 1500, exceso_usd: 104.06 });
  });

  it('subir el monto re-valida el exceso sobre el estado fusionado; con aceptar_exceso pasa y renueva la foto', async () => {
    const { svc, tablas } = base({
      pagos: [pagoFila({ utilidad_snapshot_usd: 1200 })],
    });
    const e = await errorDe(svc.actualizar(P1, { monto: 1500 }, ADMIN));
    expect(e).toMatchObject({
      status: 409,
      code: 'PAGO_EXCEDE_UTILIDAD',
      details: { pagado_usd: 0, monto_usd: 1500 },
    });
    await svc.actualizar(P1, { monto: 1500, aceptar_exceso: true }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      monto: 1500,
      monto_usd: 1500,
      utilidad_snapshot_usd: 1395.94,
    });
  });

  it('bajar el monto nunca se bloquea (aunque hoy no haya utilidad)', async () => {
    const perdida: RepartoAvionInput = {
      ...AVION_N4142R,
      reparto: AVION_N4142R.reparto.map((x) => ({
        ...x,
        monto_usd: -x.monto_usd,
      })),
    };
    const { svc, tablas } = base({ pagos: [pagoFila()], aviones: [perdida] });
    await svc.actualizar(P1, { monto: 900 }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      monto: 900,
      monto_usd: 900,
    });
  });

  it('moneda: a MXN exige T.C.; a USD lo limpia solo', async () => {
    const { svc, tablas } = base({ pagos: [pagoFila()] });
    expect(
      (await errorDe(svc.actualizar(P1, { moneda: 'MXN' }, ADMIN))).code,
    ).toBe('TC_REQUERIDO');
    await svc.actualizar(
      P1,
      {
        moneda: 'MXN',
        monto: 18234.57,
        tc_usd_mxn: 18.234567,
      },
      ADMIN,
    );
    expect(tablas.reparto_pago[0]).toMatchObject({
      moneda: 'MXN',
      tc_usd_mxn: 18.234567,
      monto_usd: 1000,
    });
    await svc.actualizar(P1, { moneda: 'USD', monto: 1000 }, ADMIN);
    expect(tablas.reparto_pago[0]).toMatchObject({
      moneda: 'USD',
      tc_usd_mxn: null,
      monto_usd: 1000,
    });
  });

  it('cuerpo vacío ⇒ 400; pago borrado ⇒ 404; quién entregó inactivo ⇒ 400', async () => {
    const { svc } = base({
      pagos: [
        pagoFila(),
        pagoFila({
          id: 'dddddddd-0000-4000-8000-000000000002',
          deleted_at: '2026-10-01T17:00:00Z',
        }),
      ],
    });
    expect(
      (await errorDe(svc.actualizar(P1, { aceptar_exceso: true }, ADMIN))).code,
    ).toBe('PAGO_SIN_CAMBIOS');
    expect(
      await errorDe(
        svc.actualizar(
          'dddddddd-0000-4000-8000-000000000002',
          { notas: 'x' },
          ADMIN,
        ),
      ),
    ).toMatchObject({ status: 404, code: 'PAGO_NO_EXISTE' });
    expect(
      (await errorDe(svc.actualizar(P1, { entregado_por_id: BAJA }, ADMIN)))
        .code,
    ).toBe('ENTREGADO_POR_INVALIDO');
  });

  it('CAS por updated_at: otra persona lo cambió entre la lectura y la escritura ⇒ 409', async () => {
    const { svc } = base({
      pagos: [pagoFila()],
      antesDeUpdate: (t) => {
        t.reparto_pago[0].updated_at = '2026-10-01T16:59:59.000000+00:00';
      },
    });
    expect(
      await errorDe(svc.actualizar(P1, { notas: 'x' }, ADMIN)),
    ).toMatchObject({
      status: 409,
      code: 'PAGO_CAMBIO_CONCURRENTE',
    });
  });
});

describe('RepartoPagoService.eliminar', () => {
  const P1 = 'dddddddd-0000-4000-8000-000000000001';

  it('soft delete: la fila se conserva con quién/cuándo/motivo y el renglón vuelve a PENDIENTE', async () => {
    const { svc, tablas } = base({ pagos: [pagoFila()] });
    const r = await svc.eliminar(P1, '  Capturado dos veces  ', {
      userId: MARY,
      rol: Rol.FACTURACION,
    });
    expect(tablas.reparto_pago).toHaveLength(1);
    expect(tablas.reparto_pago[0]).toMatchObject({
      deleted_by: MARY,
      motivo_baja: 'Capturado dos veces',
    });
    expect(tablas.reparto_pago[0].deleted_at).toBeTruthy();
    expect(r).toMatchObject({
      deleted: true,
      fila: {
        pagado_usd: 0,
        estado: 'PENDIENTE',
        pendiente_usd: 1395.94,
        pagos: [],
      },
    });
    // Ya borrado ⇒ 404.
    expect(await errorDe(svc.eliminar(P1, 'otra vez', ADMIN))).toMatchObject({
      status: 404,
      code: 'PAGO_NO_EXISTE',
    });
  });

  it('motivo corto ⇒ 400; sin migración ⇒ 503', async () => {
    const { svc } = base({ pagos: [pagoFila()] });
    expect((await errorDe(svc.eliminar(P1, 'ups', ADMIN))).code).toBe(
      'MOTIVO_INVALIDO',
    );
    const sin = base({ sinTabla: true });
    expect(
      (await errorDe(sin.svc.eliminar(P1, 'Capturado dos veces', ADMIN)))
        .status,
    ).toBe(503);
  });
});

describe('RepartoPagoService.subirComprobante', () => {
  const P1 = 'dddddddd-0000-4000-8000-000000000001';
  const pdf = (bytes = 2048) => ({
    buffer: Buffer.alloc(bytes, 1),
    nombre: 'spei.pdf',
    mime: 'application/pdf',
  });

  it('sube a <avión>/<mes>/<pago>/<uuid>.pdf, guarda el path y firma 8 h; reemplazar CONSERVA el anterior', async () => {
    const { svc, tablas, archivos, removidos } = base({ pagos: [pagoFila()] });
    const r1 = await svc.subirComprobante(P1, pdf(), ADMIN);
    const path1 = String(tablas.reparto_pago[0].comprobante_path);
    expect(path1).toMatch(
      new RegExp(`^${N4142R}/2026-09/${P1}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(archivos.has(`reparto-comprobantes/${path1}`)).toBe(true);
    expect(r1.pago.comprobante_url).toBe(
      `https://firmada/reparto-comprobantes/${path1}?exp=28800`,
    );
    await svc.subirComprobante(
      P1,
      { buffer: Buffer.alloc(10, 1), nombre: 'foto.jpg', mime: 'image/jpeg' },
      ADMIN,
    );
    const path2 = String(tablas.reparto_pago[0].comprobante_path);
    expect(path2).not.toBe(path1);
    expect(path2.endsWith('.jpg')).toBe(true);
    expect(removidos).toEqual([]);
  });

  it('tipo inválido ⇒ 400; más de 10 MB ⇒ 413; pago borrado ⇒ 404', async () => {
    const { svc } = base({
      pagos: [pagoFila({ deleted_at: '2026-10-01T17:00:00Z' })],
    });
    expect(
      (
        await errorDe(
          svc.subirComprobante(
            P1,
            {
              buffer: Buffer.alloc(10),
              nombre: 'x.exe',
              mime: 'application/x-msdownload',
            },
            ADMIN,
          ),
        )
      ).code,
    ).toBe('ARCHIVO_TIPO_INVALIDO');
    expect(
      (
        await errorDe(
          svc.subirComprobante(P1, pdf(10 * 1024 * 1024 + 1), ADMIN),
        )
      ).status,
    ).toBe(413);
    expect((await errorDe(svc.subirComprobante(P1, pdf(), ADMIN))).code).toBe(
      'PAGO_NO_EXISTE',
    );
  });
});

describe('RepartoPagoService — revisión adversaria (1-oct-2026)', () => {
  const KEY2 = 'eeeeeeee-0000-4000-8000-000000000002';

  /** Puerta: las primeras `n` llamadas a compute esperan a que lleguen todas. */
  function barrera(compute: jest.Mock, n: number) {
    let llegadas = 0;
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const original = compute.getMockImplementation() as (q: {
      aeronave_id?: string;
    }) => Promise<unknown>;
    compute.mockImplementation(async (q: { aeronave_id?: string }) => {
      llegadas += 1;
      if (llegadas === n) soltar();
      if (llegadas <= n) await puerta;
      return original(q);
    });
  }

  it('doble envío con la MISMA llave: la 2.ª ve el pago de la 1.ª como «pagado» y aun así responde 200 idempotente (no 409)', async () => {
    const { svc, compute, tablas } = base();
    // La 2.ª petición pasa la búsqueda de la llave ANTES de que la 1.ª
    // inserte, y su compute espera a que la 1.ª termine.
    let soltar!: () => void;
    const r1Lista = new Promise<void>((r) => (soltar = r));
    const original = compute.getMockImplementation()!;
    let llamada = 0;
    compute.mockImplementation(async (q: { aeronave_id?: string }) => {
      llamada += 1;
      if (llamada === 2) await r1Lista;
      return original(q);
    });
    const dto = dtoAlta({ client_request_id: KEY });
    const p1 = svc.crear(dto, ADMIN);
    const p2 = svc.crear({ ...dto }, ADMIN);
    const r1 = await p1;
    soltar();
    const r2 = await p2;
    expect(r1).not.toHaveProperty('idempotente');
    expect(r2.idempotente).toBe(true);
    expect(r2.pago.id).toBe(r1.pago.id);
    expect(tablas.reparto_pago).toHaveLength(1);
  });

  it('dos altas simultáneas con llaves DISTINTAS que juntas rebasan: la capturada después se da de baja (llave libre) y responde 409; confirmarla con la MISMA llave la guarda', async () => {
    const { svc, compute, tablas } = base();
    barrera(compute, 2);
    const MARY_FACT = { userId: MARY, rol: Rol.FACTURACION };
    const res = await Promise.allSettled([
      svc.crear(dtoAlta({ client_request_id: KEY }), ADMIN),
      svc.crear(dtoAlta({ client_request_id: KEY2 }), MARY_FACT),
    ]);
    // Las DOS pasaron el candado previo (las dos filas se insertaron)…
    expect(tablas.reparto_pago).toHaveLength(2);
    // …y solo una se queda: la capturada primero.
    const ganadora = res.findIndex((r) => r.status === 'fulfilled');
    const perdedora = res.findIndex((r) => r.status === 'rejected');
    expect([ganadora, perdedora].sort()).toEqual([0, 1]);
    const razon = (res[perdedora] as PromiseRejectedResult).reason as Error;
    const e = await errorDe(Promise.reject(razon));
    expect(e).toEqual({
      status: 409,
      code: 'PAGO_EXCEDE_UTILIDAD',
      details: {
        utilidad_usd: 1395.94,
        pagado_usd: 1395.94,
        monto_usd: 1395.94,
        exceso_usd: 1395.94,
      },
    });
    const llaves = [KEY, KEY2];
    const vivas = tablas.reparto_pago.filter((f) => f.deleted_at == null);
    expect(vivas.map((f) => f.client_request_id)).toEqual([llaves[ganadora]]);
    const baja = tablas.reparto_pago.find((f) => f.deleted_at != null)!;
    // La viva es la capturada ANTES (orden determinista para las dos).
    expect(String(vivas[0].created_at) < String(baja.created_at)).toBe(true);
    expect(baja).toMatchObject({
      deleted_by: [ALE, MARY][perdedora],
      client_request_id: null,
    });
    expect(String(baja.motivo_baja)).toContain('al mismo tiempo');
    // El renglón NO quedó sobrepagado.
    const lista = await svc.listar('2026-09', undefined, ADMIN);
    expect(lista.filas[0]).toMatchObject({
      pagado_usd: 1395.94,
      exceso_usd: 0,
      estado: 'PAGADO',
    });
    // El panel confirma «¿Registrar de todas formas?» con la MISMA llave.
    const r = await svc.crear(
      dtoAlta({ client_request_id: llaves[perdedora], aceptar_exceso: true }),
      [ADMIN, MARY_FACT][perdedora],
    );
    expect(r).not.toHaveProperty('idempotente');
    expect(r.fila).toMatchObject({ pagado_usd: 2791.88, exceso_usd: 1395.94 });
  });

  it('dos altas simultáneas que juntas NO rebasan: las dos se quedan', async () => {
    const { svc, compute, tablas } = base();
    barrera(compute, 2);
    await Promise.all([
      svc.crear(dtoAlta({ monto: 600, client_request_id: KEY }), ADMIN),
      svc.crear(dtoAlta({ monto: 700, client_request_id: KEY2 }), ADMIN),
    ]);
    expect(
      tablas.reparto_pago.filter((f) => f.deleted_at == null),
    ).toHaveLength(2);
  });

  it('paridad del 409 y del renglón con un socio de DOS vigencias en el mes (una sola suma)', async () => {
    const dosVigencias: RepartoAvionInput = {
      aeronave: AVION_N4142R.aeronave,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 50,
          monto_usd: 1011.55,
        },
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 19,
          monto_usd: 384.39,
        },
      ],
    };
    const { svc } = base({
      aviones: [dosVigencias],
      pagos: [pagoFila({ monto: '600.10', monto_usd: '600.10' })],
    });
    const e = await errorDe(svc.crear(dtoAlta({ monto: 900 }), ADMIN));
    const lista = await svc.listar('2026-09', undefined, ADMIN);
    const f = lista.filas[0];
    expect(e.code).toBe('PAGO_EXCEDE_UTILIDAD');
    expect(e.details).toMatchObject({
      utilidad_usd: f.utilidad_usd,
      pagado_usd: f.pagado_usd,
    });
    expect([f.utilidad_usd, f.pagado_usd, f.porcentaje]).toEqual([
      1395.94, 600.1, 69,
    ]);
  });

  it('T.C. fuera de la banda razonable ⇒ 400 TC_FUERA_DE_RANGO sin escribir (antes: 500 por numeric overflow)', async () => {
    const { svc, tablas } = base();
    for (const tc of [1_000_000, 999_999.9999999, 1.8, 180, 0.000001]) {
      const e = await errorDe(
        svc.crear(
          dtoAlta({ monto: 10000, moneda: 'MXN', tc_usd_mxn: tc }),
          ADMIN,
        ),
      );
      expect([tc, e.status, e.code]).toEqual([tc, 400, 'TC_FUERA_DE_RANGO']);
    }
    expect(tablas.reparto_pago).toHaveLength(0);
  });

  it('22003 (numeric fuera de rango) de la BD ⇒ 400 PAGO_INVALIDO, nunca 500', async () => {
    const { svc } = base({
      errorEnInsert: { code: '22003', message: 'numeric field overflow' },
    });
    expect(await errorDe(svc.crear(dtoAlta(), ADMIN))).toMatchObject({
      status: 400,
      code: 'PAGO_INVALIDO',
    });
  });
});
