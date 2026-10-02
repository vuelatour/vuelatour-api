// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { participacionPorAeronave } from '../../common/participacion-aeronave.util';
import { Rol } from '../../common/types/auth.types';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from './profit-sharing.service';
import {
  CLAVE_PRECIERRE_SOCIOS_ADELANTADOS,
  CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR,
} from './reparto-cuenta.util';

/**
 * PRE-CIERRE · CUENTAS DE LOS SOCIOS (v2, 2-oct-2026): avisos NO
 * bloqueantes «Socios con utilidad por entregar» (utilidades HASTA el mes
 * del cierre y TODAS las entregas) y «Socios con entregas adelantadas»
 * (saldo SIN el mes en curso < −$1: el mismo número del candado del
 * adelanto), SOLO cuando el periodo es un mes calendario. La
 * utilidad sale del reparto REAL (`computeAvion`): N4142R, septiembre 2026,
 * un vuelo cobrado en $2,023.10 y socios 69 / 29 / 2 ⇒ $1,395.94 · $586.70
 * · $40.46 (residuo mayor en centavos). «Hoy» = 1-oct-2026 (Cancún).
 */
type Fila = Record<string, unknown>;

const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';
const SEPTIEMBRE = { desde: '2026-09-01', hasta: '2026-09-30' };

type Privado = {
  computeAvion: (
    a: Fila,
    ctx: Record<string, unknown>,
  ) => {
    saldo_disponible_usd: number;
    reparto: Array<{
      socio_id: string;
      socio_nombre: string;
      porcentaje: number;
      monto_usd: number;
    }>;
    aeronave: { id: string; matricula: string; modelo: string };
  };
};

/** El reparto REAL de N4142R en septiembre (computeAvion, sin atajos). */
function avionN4142R(svc: ProfitSharingService) {
  const vuelo = {
    id: 'v-sep',
    aeronave_id: N4142R,
    cliente_id: null,
    estado: 'COMPLETADO',
    monto_total_usd: '2023.10',
    tc_usd_mxn: null,
    cobrado: true,
    comision_vendedor_usd: null,
    subtotal_vuelo_usd: '2023.10',
    ajuste_final_usd: '0',
    iva_usd: '0',
    iva_pct: '0',
    tuas_usd: '0',
    extras_total_usd: '0',
    viaticos_pernocta_usd: '0',
    calculo_snapshot: null,
    folio: 361,
    fecha_vuelo: '2026-09-20T15:00:00+00:00',
    fecha_solicitud: null,
    origen_iata: 'CUN',
    destino_iata: 'CZM',
    es_externo: false,
    costo_externo_usd: null,
  };
  const socio = (socio_id: string, porcentaje: string) => ({
    aeronave_id: N4142R,
    socio_id,
    porcentaje,
    vigente_desde: '2026-01-01',
    vigente_hasta: null,
  });
  return (svc as unknown as Privado).computeAvion(
    { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
    {
      vuelos: [vuelo],
      cobrosPorVuelo: new Map([
        [
          'v-sep',
          [
            {
              vuelo_id: 'v-sep',
              monto: '2023.10',
              moneda: 'USD',
              tc_usd_mxn: null,
            },
          ],
        ],
      ]),
      horasPorAvion: new Map(),
      participacionPorVuelo: new Map([
        ['v-sep', participacionPorAeronave(vuelo, [])],
      ]),
      escalaPorId: new Map(),
      escalasPorVuelo: new Map(),
      vueloAvion: new Map([['v-sep', N4142R]]),
      matriculas: new Map([[N4142R, 'N4142R']]),
      clientes: new Map(),
      gastos: [],
      socios: [
        socio(MAURICIO, '69.000'),
        socio(AERO, '29.000'),
        socio(SAAB, '2.000'),
      ],
      reservas: [],
      nombres: new Map([
        [MAURICIO, 'Mauricio Roque'],
        [AERO, 'Aero Charter Cancun S.A. de C.V.'],
        [SAAB, 'Alexander E. Saab'],
      ]),
      otrosPorAvion: 0,
      periodo: SEPTIEMBRE,
      tcOficialVuelo: new Map(),
      tcOficialGasto: new Map(),
    },
  );
}

interface Opciones {
  pagos?: Fila[];
  cuentas?: Fila[];
  sinMigracion?: boolean;
  /** Utilidad de Mauricio en OCTUBRE (mes en curso); default: sin avión. */
  octubreMauricio?: number;
}

const SEMBRADAS = new Set([
  'reparto_pago',
  'reparto_cuenta_socio',
  'aeronave_socio',
  'aeronave',
  'usuario',
]);

function armar(opts: Opciones = {}) {
  const tablas: Record<string, Fila[]> = {
    reparto_pago: opts.pagos ?? [],
    reparto_cuenta_socio: opts.cuentas ?? [],
    aeronave_socio: [MAURICIO, AERO, SAAB].map((socio_id, i) => ({
      aeronave_id: N4142R,
      socio_id,
      porcentaje: ['69.000', '29.000', '2.000'][i],
      vigente_desde: '2026-01-01',
      vigente_hasta: null,
    })),
    aeronave: [{ id: N4142R, matricula: 'N4142R', activa: true }],
    usuario: [
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
        es_empresa: true,
      },
      {
        id: SAAB,
        nombre: 'Alexander E. Saab',
        rol: 'PILOTO',
        estado: 'ACTIVO',
      },
      { id: ALE, nombre: 'Ale Canales', rol: 'ADMIN', estado: 'ACTIVO' },
    ],
  };
  const consultasPagos: Array<Array<[string, unknown]>> = [];
  const from = (tabla: string) => {
    const filtros: Array<[string, unknown, 'eq' | 'in' | 'gte' | 'lte']> = [];
    let cols = '*';
    const q: Record<string, unknown> = {};
    for (const m of ['neq', 'not', 'or', 'order', 'limit', 'range']) {
      q[m] = () => q;
    }
    q.select = (c?: string) => {
      if (typeof c === 'string') cols = c;
      return q;
    };
    q.eq = (c: string, v: unknown) => {
      filtros.push([c, v, 'eq']);
      return q;
    };
    q.is = (c: string, v: unknown) => {
      filtros.push([c, v, 'eq']);
      return q;
    };
    q.in = (c: string, v: unknown) => {
      filtros.push([c, v, 'in']);
      return q;
    };
    q.gte = (c: string, v: unknown) => {
      filtros.push([c, v, 'gte']);
      return q;
    };
    q.lte = (c: string, v: unknown) => {
      filtros.push([c, v, 'lte']);
      return q;
    };
    q.maybeSingle = () => Promise.resolve({ data: null, error: null });
    q.then = (res: (v: unknown) => unknown) => {
      if (
        opts.sinMigracion &&
        (tabla === 'reparto_cuenta_socio' ||
          (tabla === 'reparto_pago' && cols.includes('saldo_snapshot_usd')))
      ) {
        return Promise.resolve({
          data: null,
          error: {
            code: '42703',
            message: 'column reparto_pago.saldo_snapshot_usd does not exist',
          },
        }).then(res);
      }
      if (!SEMBRADAS.has(tabla)) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(res);
      }
      if (tabla === 'reparto_pago') {
        consultasPagos.push(filtros.map(([c, v]) => [c, v]));
      }
      const filas = tablas[tabla].filter((f) =>
        filtros.every(([c, v, op]) => {
          if (op === 'in') return (v as unknown[]).includes(f[c]);
          if (op === 'gte') return String(f[c]) >= String(v);
          if (op === 'lte') return String(f[c]) <= String(v);
          return v === null ? f[c] == null : f[c] === v;
        }),
      );
      return Promise.resolve({ data: filas, error: null }).then(res);
    };
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const conciliacion = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  const svc = new ProfitSharingService(supabase, nada, nada, conciliacion);
  svc.ahora = () => new Date('2026-10-01T18:00:00Z'); // 13:00 Cancún
  const avion = avionN4142R(svc);
  // `compute` de cada mes: septiembre = el avión REAL de arriba; octubre
  // (en curso) todavía sin vuelos cerrados — o, con `octubreMauricio`, el
  // avión con la utilidad parcial de octubre (p. ej. negativa: gastos ya
  // capturados y ningún vuelo cobrado).
  const octubre =
    opts.octubreMauricio == null
      ? []
      : [
          {
            aeronave: avion.aeronave,
            reparto_porcentaje_total: 100,
            reparto: avion.reparto.map((r) => ({
              ...r,
              monto_usd: r.socio_id === MAURICIO ? opts.octubreMauricio : 0,
            })),
          },
        ];
  const compute = jest.spyOn(svc, 'compute').mockImplementation((q) =>
    Promise.resolve({
      aviones: q.desde === '2026-09-01' ? [avion] : octubre,
    } as unknown as Awaited<ReturnType<ProfitSharingService['compute']>>),
  );
  return { svc, compute, avion, consultasPagos };
}

function entrega(p: Fila): Fila {
  return {
    id: `p-${Math.random()}`,
    aeronave_id: null,
    socio_id: MAURICIO,
    periodo: null,
    monto: 1000,
    moneda: 'USD',
    tc_usd_mxn: null,
    monto_usd: 1000,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    entregado_por: ALE,
    created_by: ALE,
    created_at: '2026-10-01T15:00:00Z',
    updated_at: '2026-10-01T15:00:00Z',
    deleted_at: null,
    ...p,
  };
}

type Respuesta = { listo: boolean; items: Array<Record<string, unknown>> };

const porEntregarDe = (r: Respuesta) =>
  r.items.find((i) => i.clave === CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR);
const adelantadosDe = (r: Respuesta) =>
  r.items.find((i) => i.clave === CLAVE_PRECIERRE_SOCIOS_ADELANTADOS);

describe('ProfitSharingService.preCierre — cuentas de los socios', () => {
  it('el reparto REAL de N4142R: $2,023.10 ⇒ 1,395.94 / 586.70 / 40.46', () => {
    const { avion } = armar();
    expect(avion.saldo_disponible_usd).toBe(2023.1);
    expect(
      avion.reparto.map((r) => [r.socio_nombre, r.porcentaje, r.monto_usd]),
    ).toEqual([
      ['Mauricio Roque', 69, 1395.94],
      ['Aero Charter Cancun S.A. de C.V.', 29, 586.7],
      ['Alexander E. Saab', 2, 40.46],
    ]);
  });

  it('septiembre sin entregas: los 3 socios POR ENTREGAR (mayor primero), compute UNO por mes, y NO bloquea el cierre', async () => {
    const { svc, compute } = armar();
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    // Un compute por MES calendario (septiembre y el mes en curso).
    expect(compute.mock.calls.map((c) => [c[0].desde, c[0].hasta])).toEqual([
      ['2026-09-01', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
    ]);
    expect(porEntregarDe(r)).toMatchObject({
      titulo: 'Socios con utilidad por entregar',
      mes: '2026-09',
      count: 3,
      monto_usd: 2023.1,
      lectura_fallida: false,
      disponible: true,
      socios: [
        {
          socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
          por_entregar_usd: 1395.94,
        },
        {
          // La propia empresa como socio viaja MARCADA (la oficina decide).
          socio: {
            id: AERO,
            nombre: 'Aero Charter Cancun S.A. de C.V.',
            es_empresa: true,
          },
          por_entregar_usd: 586.7,
        },
        {
          socio: {
            id: SAAB,
            nombre: 'Alexander E. Saab',
            es_empresa: false,
          },
          por_entregar_usd: 40.46,
        },
      ],
    });
    expect(String(porEntregarDe(r)!.detalle)).toContain(
      '3 socio(s) con utilidad por entregar hasta septiembre 2026 por $2,023.10 USD',
    );
    expect(porEntregarDe(r)).not.toHaveProperty('informativo');
    // Misma forma que «por entregar» (incluye `disponible`).
    expect(adelantadosDe(r)).toMatchObject({
      count: 0,
      lectura_fallida: false,
      disponible: true,
    });
    expect(r.listo).toBe(true);
    // Mes cerrado memoizado: otra corrida solo recalcula el mes en curso.
    await svc.preCierre(SEPTIEMBRE, Rol.ADMIN);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('una entrega de OCTUBRE por la utilidad de septiembre limpia septiembre; el ADELANTO de 70,000 MXN sale en adelantados; las borradas no cuentan', async () => {
    const { svc, consultasPagos } = armar({
      pagos: [
        entrega({
          monto: 1395.94,
          monto_usd: 1395.94,
          periodo: '2026-09-01',
          aeronave_id: N4142R,
        }),
        entrega({
          socio_id: AERO,
          monto: 70000,
          moneda: 'MXN',
          tc_usd_mxn: 18.5,
          monto_usd: 3783.78,
          metodo: 'EFECTIVO',
        }),
        entrega({
          socio_id: SAAB,
          monto_usd: 40.46,
          deleted_at: '2026-10-01T16:00:00Z',
        }),
      ],
    });
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    expect(porEntregarDe(r)).toMatchObject({
      count: 1,
      monto_usd: 40.46,
      socios: [{ socio: { id: SAAB }, por_entregar_usd: 40.46 }],
    });
    expect(adelantadosDe(r)).toMatchObject({
      titulo: 'Socios con entregas adelantadas (más de lo generado)',
      count: 1,
      monto_usd: 3197.08,
      socios: [
        {
          socio: { id: AERO, nombre: 'Aero Charter Cancun S.A. de C.V.' },
          por_entregar_usd: -3197.08,
          adelantado_usd: 3197.08,
        },
      ],
      lectura_fallida: false,
    });
    expect(String(adelantadosDe(r)!.detalle)).toContain(
      'Aero Charter Cancun S.A. de C.V. $3,197.08 USD',
    );
    expect(r.listo).toBe(true);
    // Las entregas se leen VIVAS.
    expect(consultasPagos.find((f) => f.length > 0)).toEqual(
      expect.arrayContaining([['deleted_at', null]]),
    );
  });

  it('mes en curso NEGATIVO (gastos de octubre ya capturados): entregar EXACTAMENTE lo que dice «por entregar» de septiembre deja al socio al corriente, no «adelantado» (el MISMO criterio del candado del 409)', async () => {
    const { svc } = armar({
      octubreMauricio: -345,
      pagos: [
        entrega({
          monto: 1395.94,
          monto_usd: 1395.94,
          periodo: '2026-09-01',
          aeronave_id: N4142R,
        }),
      ],
    });
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    const ids = (x: Record<string, unknown> | undefined) =>
      (x!.socios as Array<{ socio: { id: string } }>).map((s) => s.socio.id);
    expect(ids(porEntregarDe(r))).toEqual([AERO, SAAB]);
    // Antes (saldo de HOY, con octubre −345) salía «Mauricio Roque $345 USD
    // … recibieron más de lo generado».
    expect(adelantadosDe(r)).toMatchObject({ count: 0, monto_usd: 0 });
    expect(ids(adelantadosDe(r))).toEqual([]);
  });

  it('mes en curso POSITIVO a medias: una entrega por encima de lo CERRADO sí sale como adelanto en el pre-cierre (utilidad no realizada)', async () => {
    const { svc } = armar({
      octubreMauricio: 500,
      pagos: [entrega({ monto: 1895.94, monto_usd: 1895.94 })],
    });
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    expect(adelantadosDe(r)).toMatchObject({
      count: 1,
      monto_usd: 500,
      socios: [
        {
          socio: { id: MAURICIO, es_empresa: false },
          por_entregar_usd: -500,
          adelantado_usd: 500,
        },
      ],
    });
  });

  it('agosto (antes del arranque default de las cuentas): count 0 con el texto que lo explica', async () => {
    const { svc } = armar();
    const r = (await svc.preCierre(
      { desde: '2026-08-01', hasta: '2026-08-31' },
      Rol.ADMIN,
    )) as unknown as Respuesta;
    expect(porEntregarDe(r)).toMatchObject({
      count: 0,
      lectura_fallida: false,
    });
    expect(String(porEntregarDe(r)!.detalle)).toBe(
      'Las cuentas de los socios arrancan después de agosto 2026: no hay nada que revisar en este mes.',
    );
  });

  it('periodo que NO es un mes completo: los avisos no aparecen ni se calcula nada', async () => {
    const { svc, compute } = armar();
    for (const q of [
      { desde: '2026-09-01', hasta: '2026-09-15' },
      { desde: '2026-08-01', hasta: '2026-09-30' },
      { desde: '2026-10-01', hasta: '2026-10-01' },
    ]) {
      const r = (await svc.preCierre(q, Rol.ADMIN)) as unknown as Respuesta;
      expect(porEntregarDe(r)).toBeUndefined();
      expect(adelantadosDe(r)).toBeUndefined();
    }
    expect(compute).not.toHaveBeenCalled();
  });

  it('sin la migración: count 0 MARCADO como lectura fallida (no «no hay pendientes»), sin adelantados ni cálculo', async () => {
    const { svc, compute } = armar({ sinMigracion: true });
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    expect(porEntregarDe(r)).toMatchObject({
      count: 0,
      lectura_fallida: true,
      disponible: false,
      socios: [],
    });
    expect(String(porEntregarDe(r)!.detalle)).toContain(
      'todavía no están habilitadas',
    );
    expect(adelantadosDe(r)).toBeUndefined();
    expect(compute).not.toHaveBeenCalled();
    expect(r.listo).toBe(true);
  });

  it('si el cálculo falla: count 0 con lectura_fallida y un texto que lo dice; el pre-cierre no se cae', async () => {
    const { svc, compute } = armar();
    compute.mockRejectedValueOnce(new Error('timeout'));
    const r = (await svc.preCierre(
      SEPTIEMBRE,
      Rol.ADMIN,
    )) as unknown as Respuesta;
    expect(porEntregarDe(r)).toMatchObject({
      count: 0,
      lectura_fallida: true,
      disponible: true,
    });
    expect(String(porEntregarDe(r)!.detalle)).toContain(
      'No se pudieron leer las cuentas de los socios',
    );
    expect(adelantadosDe(r)).toBeUndefined();
  });

  it('COORDINADOR (y sin rol): NO recibe los avisos de las cuentas ni se calcula nada — ningún otro endpoint le da esas cifras', async () => {
    const { svc, compute } = armar({ pagos: [entrega({})] });
    for (const rol of [Rol.COORDINADOR, undefined]) {
      const r = (await svc.preCierre(SEPTIEMBRE, rol)) as unknown as Respuesta;
      expect(porEntregarDe(r)).toBeUndefined();
      expect(adelantadosDe(r)).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain('Mauricio Roque');
    }
    expect(compute).not.toHaveBeenCalled();
    for (const rol of [Rol.ANALISTA, Rol.FACTURACION]) {
      const r = (await svc.preCierre(SEPTIEMBRE, rol)) as unknown as Respuesta;
      expect(porEntregarDe(r)).toBeDefined();
    }
  });
});
