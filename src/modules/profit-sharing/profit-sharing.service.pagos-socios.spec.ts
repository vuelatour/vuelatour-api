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
  CLAVE_PRECIERRE_PAGOS_SOCIOS,
  CLAVE_PRECIERRE_SOBREPAGOS_SOCIOS,
} from './reparto-pago.util';

/**
 * PRE-CIERRE · PAGOS A SOCIOS (1-oct-2026): aviso NO bloqueante «Socios con
 * utilidad del mes sin pagar o con pago parcial», SOLO cuando el periodo es
 * un mes calendario. La utilidad sale del reparto REAL (`computeAvion`):
 * N4142R, septiembre 2026, un vuelo cobrado en $2,023.10 y socios 69 / 29 /
 * 2 ⇒ $1,395.94 · $586.70 · $40.46 (residuo mayor en centavos).
 */
type Fila = Record<string, unknown>;

const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
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
  sinTabla?: boolean;
}

function armar(opts: Opciones = {}) {
  const consultasPagos: Array<Array<[string, unknown]>> = [];
  const from = (tabla: string) => {
    const filtros: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'neq',
      'in',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'limit',
      'range',
    ]) {
      q[m] = () => q;
    }
    q.eq = (c: string, v: unknown) => {
      filtros.push([c, v]);
      return q;
    };
    q.is = (c: string, v: unknown) => {
      filtros.push([c, v]);
      return q;
    };
    q.maybeSingle = () => Promise.resolve({ data: null, error: null });
    q.then = (res: (v: unknown) => unknown) => {
      if (tabla === 'reparto_pago') {
        if (opts.sinTabla) {
          return Promise.resolve({
            data: null,
            error: {
              code: 'PGRST205',
              message:
                "Could not find the table 'public.reparto_pago' in the schema cache",
            },
          }).then(res);
        }
        consultasPagos.push(filtros);
        const filas = (opts.pagos ?? []).filter((p) =>
          filtros.every(([c, v]) => (v === null ? p[c] == null : p[c] === v)),
        );
        return Promise.resolve({ data: filas, error: null }).then(res);
      }
      return Promise.resolve({ data: [], error: null, count: 0 }).then(res);
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
  const avion = avionN4142R(svc);
  // `compute` del mes = el avión REAL de arriba (el resto del cómputo se
  // prueba en sus propios specs).
  const compute = jest
    .spyOn(svc, 'compute')
    .mockResolvedValue({ aviones: [avion] } as unknown as Awaited<
      ReturnType<ProfitSharingService['compute']>
    >);
  return { svc, compute, avion, consultasPagos };
}

function pago(p: Fila): Fila {
  return {
    id: `p-${Math.random()}`,
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
    entregado_por: MAURICIO,
    created_at: '2026-10-01T15:00:00Z',
    updated_at: '2026-10-01T15:00:00Z',
    deleted_at: null,
    ...p,
  };
}

function itemDe(r: { items: Array<Record<string, unknown>> }) {
  return r.items.find((i) => i.clave === CLAVE_PRECIERRE_PAGOS_SOCIOS);
}

function sobrepagosDe(r: { items: Array<Record<string, unknown>> }) {
  return r.items.find((i) => i.clave === CLAVE_PRECIERRE_SOBREPAGOS_SOCIOS);
}

describe('ProfitSharingService.preCierre — pagos a socios', () => {
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

  it('mes completo: lista PENDIENTE y PARCIAL (sin borrados) y NO bloquea el cierre', async () => {
    const { svc, compute, consultasPagos } = armar({
      pagos: [
        pago({}),
        pago({ socio_id: SAAB, monto: 40.46, monto_usd: 40.46 }),
        // Borrado: no cuenta (el lector filtra deleted_at is null).
        pago({
          socio_id: AERO,
          monto: 586.7,
          monto_usd: 586.7,
          deleted_at: '2026-10-01T16:00:00Z',
        }),
      ],
    });
    const r = (await svc.preCierre(SEPTIEMBRE, Rol.ADMIN)) as unknown as {
      listo: boolean;
      items: Array<Record<string, unknown>>;
    };
    expect(compute).toHaveBeenCalledWith({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    const item = itemDe(r)!;
    expect(item).toMatchObject({
      titulo: 'Socios con utilidad del mes sin pagar o con pago parcial',
      mes: '2026-09',
      count: 2,
      monto_usd: 982.64,
      lectura_fallida: false,
      disponible: true,
    });
    expect(
      (
        item.socios as Array<{
          socio: { nombre: string };
          aeronave: { matricula: string };
          pendiente_usd: number;
          estado: string;
        }>
      ).map((s) => [
        s.socio.nombre,
        s.aeronave.matricula,
        s.pendiente_usd,
        s.estado,
      ]),
    ).toEqual([
      ['Aero Charter Cancun S.A. de C.V.', 'N4142R', 586.7, 'PENDIENTE'],
      ['Mauricio Roque', 'N4142R', 395.94, 'PARCIAL'],
    ]);
    expect(String(item.detalle)).toContain(
      '2 pago(s) a socios pendientes de septiembre 2026',
    );
    expect(item).not.toHaveProperty('informativo');
    expect(r.listo).toBe(true);
    // [0] es la sonda (select id limit 1); la lectura del mes trae filtros.
    expect(consultasPagos.find((f) => f.length > 0)).toEqual(
      expect.arrayContaining([
        ['periodo', '2026-09-01'],
        ['deleted_at', null],
      ]),
    );
  });

  it('todo pagado: count 0, sin lectura fallida', async () => {
    const { svc } = armar({
      pagos: [
        pago({ monto: 1395.94, monto_usd: 1395.94 }),
        pago({ socio_id: AERO, monto: 586.7, monto_usd: 586.7 }),
        pago({ socio_id: SAAB, monto: 40.46, monto_usd: 40.46 }),
      ],
    });
    const item = itemDe(await svc.preCierre(SEPTIEMBRE, Rol.ADMIN))!;
    expect(item).toMatchObject({
      count: 0,
      socios: [],
      lectura_fallida: false,
    });
    expect(String(item.detalle)).toContain('tienen su pago registrado');
  });

  it('periodo que NO es un mes completo: el aviso no aparece ni se calcula el reparto', async () => {
    const { svc, compute } = armar();
    for (const q of [
      { desde: '2026-09-01', hasta: '2026-09-15' },
      { desde: '2026-08-01', hasta: '2026-09-30' },
      { desde: '2026-10-01', hasta: '2026-10-01' },
    ]) {
      expect(itemDe(await svc.preCierre(q, Rol.ADMIN))).toBeUndefined();
    }
    expect(compute).not.toHaveBeenCalled();
  });

  it('sin la migración: count 0 MARCADO como lectura fallida (no «no hay pendientes»)', async () => {
    const { svc, compute } = armar({ sinTabla: true });
    const r = (await svc.preCierre(SEPTIEMBRE, Rol.ADMIN)) as unknown as {
      listo: boolean;
      items: Array<Record<string, unknown>>;
    };
    const item = itemDe(r)!;
    expect(item).toMatchObject({
      count: 0,
      lectura_fallida: true,
      disponible: false,
      socios: [],
    });
    expect(String(item.detalle)).toContain('todavía no está habilitado');
    expect(compute).not.toHaveBeenCalled();
    expect(r.listo).toBe(true);
  });

  it('si el cálculo falla: count 0 con lectura_fallida y un texto que lo dice; el pre-cierre no se cae', async () => {
    const { svc, compute } = armar();
    compute.mockRejectedValueOnce(new Error('timeout'));
    const item = itemDe(await svc.preCierre(SEPTIEMBRE, Rol.ADMIN))!;
    expect(item).toMatchObject({
      count: 0,
      lectura_fallida: true,
      disponible: true,
    });
    expect(String(item.detalle)).toContain(
      'No se pudieron leer los pagos a socios',
    );
  });
  it('COORDINADOR (y sin rol): NO recibe los items de pagos a socios ni se calcula el reparto — ningún otro endpoint le da esas cifras', async () => {
    const { svc, compute } = armar({ pagos: [pago({})] });
    for (const rol of [Rol.COORDINADOR, undefined]) {
      const r = (await svc.preCierre(SEPTIEMBRE, rol)) as unknown as {
        items: Array<Record<string, unknown>>;
      };
      expect(itemDe(r)).toBeUndefined();
      expect(sobrepagosDe(r)).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain('Mauricio Roque');
    }
    expect(compute).not.toHaveBeenCalled();
    // ANALISTA y FACTURACION sí (leen la relación de pagos).
    for (const rol of [Rol.ANALISTA, Rol.FACTURACION]) {
      const r = (await svc.preCierre(SEPTIEMBRE, rol)) as unknown as {
        items: Array<Record<string, unknown>>;
      };
      expect(itemDe(r)).toBeDefined();
    }
  });

  it('SOBREPAGOS: con todo pagado pero un pago de más, el item aparte trae count > 0 (el panel oculta los de count 0) y no bloquea', async () => {
    const { svc } = armar({
      pagos: [
        pago({ monto: 1895.94, monto_usd: 1895.94 }),
        pago({ socio_id: AERO, monto: 586.7, monto_usd: 586.7 }),
        pago({ socio_id: SAAB, monto: 40.46, monto_usd: 40.46 }),
      ],
    });
    const r = (await svc.preCierre(SEPTIEMBRE, Rol.ADMIN)) as unknown as {
      listo: boolean;
      items: Array<Record<string, unknown>>;
    };
    expect(itemDe(r)).toMatchObject({ count: 0, sobrepagos: 1 });
    expect(String(itemDe(r)!.detalle)).toContain(
      'pero 1 pago(s) quedaron por encima de la utilidad',
    );
    const sobre = sobrepagosDe(r)!;
    expect(sobre).toMatchObject({
      titulo: 'Pagos a socios por encima de la utilidad del mes',
      mes: '2026-09',
      count: 1,
      monto_usd: 500,
      lectura_fallida: false,
    });
    // La lista va en `sobrepagados`, NO en `socios` (el panel pinta
    // `socios` como pendientes).
    expect(sobre).not.toHaveProperty('socios');
    expect(sobre.sobrepagados).toEqual([
      {
        socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
        aeronave: { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
        exceso_usd: 500,
        estado: 'PAGADO',
      },
    ]);
    expect(String(sobre.detalle)).toContain(
      'Mauricio Roque (N4142R) $500 USD de más',
    );
    expect(r.listo).toBe(true);
  });

  it('lectura fallida: sin item de sobrepagos (el principal ya dice «sin verificar»)', async () => {
    const { svc } = armar({ sinTabla: true });
    const r = (await svc.preCierre(SEPTIEMBRE, Rol.ADMIN)) as unknown as {
      items: Array<Record<string, unknown>>;
    };
    expect(itemDe(r)).toMatchObject({ lectura_fallida: true });
    expect(sobrepagosDe(r)).toBeUndefined();
  });
});
