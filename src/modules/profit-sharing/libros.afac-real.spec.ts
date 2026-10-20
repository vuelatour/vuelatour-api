// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) => f ?? 'TC oficial',
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));
// AFAC POR VUELO (invariante 90): con la migración 20261016000005.
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));

import type { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from './profit-sharing.service';
import { DineroReportService } from './dinero-report.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type {
  BalanceAvionPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';
import { PAGO_AFAC_CLAVE_DETALLE } from '../../common/afac-real.util';

/**
 * Mundo COPIADO de `libros.cierre-mes.spec` (un avión XB-TST, K 20, sin
 * diferir) para probar la marca «Pago de AFAC» en los tres libros
 * (invariante 90). Ver el bloque de abajo.
 */

const AV = 'av-1';
const V1 = 'v-901';
const V2 = 'v-902';
const V3 = 'v-903';
const ALE = 'u-ale';
const PERIODO_OCT = '2026-10-01T00:00:00-05:00';

const SEP = { desde: '2026-09-01', hasta: '2026-09-30' };

function vuelo(
  id: string,
  folio: number,
  fecha: string,
  monto: number,
  extra: Fila = {},
): Fila {
  return {
    id,
    folio,
    cliente_id: 'cli-1',
    aeronave_id: AV,
    estado: 'COMPLETADO',
    tipo: 'CHARTER',
    es_externo: false,
    operador_externo: null,
    costo_externo_usd: null,
    fecha_vuelo: fecha,
    fecha_solicitud: null,
    fecha_traslado_final: null,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    tiempo_cobrable_hr: 1,
    tarifa_hora_usd: monto,
    iva_pct: 0,
    iva_usd: 0,
    subtotal_vuelo_usd: monto,
    ajuste_final_usd: 0,
    tuas_usd: 0,
    extras_total_usd: 0,
    viaticos_pernocta_usd: 0,
    comision_vendedor_usd: 0,
    comision_vendedor_nombre: null,
    monto_total_usd: monto,
    monto_total_mxn: monto * 20,
    tc_usd_mxn: 20,
    cobrado: true,
    calculo_snapshot: null,
    periodo_contable: null,
    cliente: { nombre: 'Cliente Uno' },
    ...extra,
  };
}

function escala(
  id: string,
  vueloId: string,
  salida: number,
  llegada: number,
  fecha: string,
): Fila {
  return {
    id,
    vuelo_id: vueloId,
    orden: 1,
    aeronave_id: null,
    cancelada_at: null,
    taco_salida: salida,
    taco_llegada: llegada,
    solo_operativa: false,
    es_ferry: false,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    es_sobrevuelo: false,
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    fecha_salida_plan: fecha,
    revision_requerida: false,
  };
}

function mundo(opts: { diferido?: boolean } = {}): Record<string, Fila[]> {
  const diferido = opts.diferido !== false;
  const v2 = vuelo(V2, 902, '2026-09-25T15:00:00Z', 1000, {
    periodo_contable: diferido ? PERIODO_OCT : null,
  });
  const embV2 = {
    fecha_vuelo: v2.fecha_vuelo,
    periodo_contable: v2.periodo_contable,
    fecha_contable: v2.periodo_contable ?? v2.fecha_vuelo,
    aeronave_id: AV,
    es_externo: false,
    folio: 902,
  };
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        activa: true,
        color_calendario: '#3B82F6',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    cliente: [{ id: 'cli-1', nombre: 'Cliente Uno', es_interno: false }],
    vuelo: [
      vuelo(V1, 901, '2026-09-10T15:00:00Z', 2000),
      v2,
      vuelo(V3, 903, '2026-10-05T15:00:00Z', 500, { cobrado: false }),
    ],
    escala: [
      escala('e-1', V1, 100, 102, '2026-09-10T15:00:00Z'),
      escala('e-2', V2, 102, 103.5, '2026-09-25T15:00:00Z'),
      escala('e-3', V3, 103.5, 104, '2026-10-05T15:00:00Z'),
    ],
    cobro_vuelo: [
      {
        id: 'c-1',
        vuelo_id: V1,
        monto: 2000,
        moneda: 'USD',
        tc_usd_mxn: 20,
        fecha_cobro: '2026-09-12T16:00:00Z',
        metodo_cobro: 'TRANSFERENCIA',
        comision_banco_monto: null,
        comision_banco_pct: null,
        cobro_grupo_id: null,
      },
      {
        id: 'c-2',
        vuelo_id: V2,
        monto: 1000,
        moneda: 'USD',
        tc_usd_mxn: 20,
        fecha_cobro: '2026-10-02T16:00:00Z',
        metodo_cobro: 'TRANSFERENCIA',
        comision_banco_monto: null,
        comision_banco_pct: null,
        cobro_grupo_id: null,
      },
    ],
    gasto: [
      {
        id: 'g-op',
        vuelo_id: V2,
        escala_id: null,
        aeronave_id: AV,
        categoria: 'OPERACIONES',
        monto: 2000,
        propina: 0,
        moneda: 'MXN',
        tc_gasto: 20,
        litros: null,
        fecha_gasto: '2026-09-28',
        notas: null,
        lugar: 'CUN',
        medio_pago: 'TRANSFERENCIA',
        tarjeta_terminacion: null,
        inventario_movimiento_id: null,
        valor_ia_extraido: null,
        proveedor: null,
        created_at: '2026-09-28T16:00:00Z',
        escala: null,
        vuelo: embV2,
      },
    ],
    gasto_reparto: [],
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: 'socio-1',
        porcentaje: 100,
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
        usuario: { nombre: 'Socio Uno', es_empresa: false },
      },
    ],
    usuario: [
      { id: 'socio-1', nombre: 'Socio Uno' },
      { id: ALE, nombre: 'Ale Martínez' },
    ],
    reserva_overhaul: [
      { aeronave_id: AV, monto_por_hora_usd: 10, horas_acumuladas: 0 },
    ],
    aeropuerto: [],
    cierre_mes: diferido
      ? [
          {
            periodo: '2026-09-01',
            estado: 'CERRADO',
            cerrado_at: '2026-10-16T19:02:00Z',
            cerrado_por: ALE,
            reabierto_at: null,
            reabierto_por: null,
            reabierto_motivo: null,
            version: 1,
            totales: { por_avion: [{ aeronave_id: AV, saldo_usd: 1965 }] },
            updated_at: '2026-10-16T19:02:00Z',
          },
        ]
      : [],
    cierre_mes_vuelo: diferido
      ? [
          {
            id: 'b-1',
            periodo: '2026-09-01',
            cierre_version: 1,
            vuelo_id: V2,
            periodo_origen: '2026-09-01',
            periodo_destino: '2026-10-01',
            folio: 902,
            cliente: 'Cliente Uno',
            aeronave_id: AV,
            matricula: 'XB-TST',
            venta_usd: 1000,
            cobrado_usd: 0,
            por_cobrar_usd: 1000,
            motivo: 'COBRO_POSTERIOR',
            revertido_at: null,
            created_at: '2026-10-16T19:02:00Z',
          },
        ]
      : [],
  };
}

const config = {
  fecha: (_c: string, porDefecto: string) => Promise.resolve(porDefecto),
};
const tipoCambio = { oficialDetallePara: () => Promise.resolve(null) };

function reparto(tablas: Record<string, Fila[]>, sinMigracion = false) {
  const f = fakeCierre(tablas, { sinMigracion });
  return new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    tipoCambio as never,
    {} as never,
    config as never,
  );
}

function balance(tablas: Record<string, Fila[]>, sinMigracion = false) {
  const f = fakeCierre(tablas, { sinMigracion });
  return new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { proximoServicio: () => null } as never,
    tipoCambio as never,
    {} as never,
    config as never,
  ) as unknown as {
    buildPayload: (
      a: string | null,
      d: string,
      h: string,
    ) => Promise<BalanceAvionPayload>;
  };
}

function dinero(tablas: Record<string, Fila[]>, sinMigracion = false) {
  const f = fakeCierre(tablas, { sinMigracion });
  return new DineroReportService(
    f.supabase as unknown as SupabaseService,
    {} as never,
  ) as unknown as {
    buildPayload: (d: string, h: string) => Promise<DineroXlsxPayload>;
  };
}

/**
 * AFAC POR VUELO — UN PAGO DE AFAC MARCADO EN LOS TRES LIBROS (16-oct-2026,
 * API 0.0.89, invariante 90; decisión 4 del cliente). Mundo del cierre (sin
 * diferir) + un PERMISO de $5,000 MXN del XB-TST sin vuelo el 1-sep
 * («Permisos Vuelos Privados VGV · Yousefh Pineda», T.C. del gasto 20):
 *  - SIN marca: resta en el balance (hoja «permisos» ⇒ `permisos_usd`), en el
 *    reparto (grupo PERMISO ⇒ `gastos.permisos_usd`) y en el Libro Dinero
 *    (utilidades ⇒ `permisos_mxn`).
 *  - MARCADO «Pago de AFAC»: sale de los TRES por la MISMA fuente única
 *    (`esPagoAfac`), cada libro con su propia conversión, y el delta
 *    balance↔reparto no cambia.
 */
const PERMISO_VGV: Fila = {
  id: 'g-permiso-vgv',
  vuelo_id: null,
  escala_id: null,
  aeronave_id: AV,
  categoria: 'PERMISO',
  monto: 5000,
  propina: 0,
  moneda: 'MXN',
  tc_gasto: 20,
  litros: null,
  fecha_gasto: '2026-09-01',
  notas: 'Permisos Vuelos Privados VGV · Yousefh Pineda',
  lugar: null,
  medio_pago: 'TRANSFERENCIA',
  tarjeta_terminacion: null,
  inventario_movimiento_id: null,
  valor_ia_extraido: null,
  proveedor: null,
  created_at: '2026-09-01T16:00:00Z',
  escala: null,
  vuelo: null,
};

function mundoAfac(marcado: boolean | null): Record<string, Fila[]> {
  const t = mundo({ diferido: false });
  if (marcado != null) {
    t.gasto = [...t.gasto, { ...PERMISO_VGV, es_pago_afac: marcado }];
  }
  return t;
}

async function tresLibros(marcado: boolean | null) {
  const t = mundoAfac(marcado);
  const [b, r, d] = await Promise.all([
    balance(t).buildPayload(AV, SEP.desde, SEP.hasta),
    reparto(t).compute(SEP),
    dinero(t).buildPayload(SEP.desde, SEP.hasta),
  ]);
  return { b, r: r.aviones[0], d };
}

describe('PAGO DE AFAC marcado en los tres libros (invariante 90)', () => {
  it('SIN marca: el permiso resta en el balance, en el reparto y en el Libro Dinero (cada uno con su conversión)', async () => {
    const base = await tresLibros(null);
    const sin = await tresLibros(false);
    expect(sin.b.permisos.total_mxn).toBe(5000);
    expect(
      r2(sin.b.balance.permisos_usd! - (base.b.balance.permisos_usd ?? 0)),
    ).toBe(250);
    expect(r2(sin.r.gastos.permisos_usd - base.r.gastos.permisos_usd)).toBe(
      250,
    );
    const permisosDinero = (p: DineroXlsxPayload) =>
      p.utilidades_aviones?.find((u) => u.matricula === 'XB-TST')
        ?.permisos_mxn ?? 0;
    expect(r2(permisosDinero(sin.d) - permisosDinero(base.d))).toBe(5000);
  });

  it('MARCADO: sale de los TRES (balance, reparto, Libro Dinero por avión) y el delta balance↔reparto NO cambia', async () => {
    const base = await tresLibros(null);
    const sin = await tresLibros(false);
    const con = await tresLibros(true);
    // Balance: fuera de la hoja «permisos» y de la cascada; viaja aparte.
    expect(con.b.permisos.total_mxn).toBe(base.b.permisos.total_mxn);
    expect(con.b.balance.permisos_usd).toBe(base.b.balance.permisos_usd);
    expect(con.b.balance.utilidad_cobrada_usd).toBe(
      base.b.balance.utilidad_cobrada_usd,
    );
    expect(con.b.pagos_afac!.filas).toEqual([
      expect.objectContaining({ gasto_id: PERMISO_VGV.id, monto_mxn: 5000 }),
    ]);
    // Reparto: grupo EXCLUIDO con su clave propia; saldo como sin el gasto.
    expect(con.r.gastos.permisos_usd).toBe(base.r.gastos.permisos_usd);
    expect(con.r.saldo_disponible_usd).toBe(base.r.saldo_disponible_usd);
    expect(
      con.r.detalle.gastos_por_categoria.find(
        (c) => c.categoria === PAGO_AFAC_CLAVE_DETALLE,
      ),
    ).toMatchObject({
      grupo: 'EXCLUIDO',
      etiqueta: 'Permiso (pago AFAC · VuelaTour)',
      count: 1,
      usd: 250,
    });
    // Libro Dinero: la fila sigue en «otros gastos» (es caja) con su sufijo,
    // pero NO se acredita al avión en utilidades.
    const permisosDinero = (p: DineroXlsxPayload) =>
      p.utilidades_aviones?.find((u) => u.matricula === 'XB-TST')
        ?.permisos_mxn ?? 0;
    expect(permisosDinero(con.d)).toBe(permisosDinero(base.d));
    const fila = con.d.otros_gastos.find((f) =>
      f.concepto.includes('Permisos Vuelos Privados VGV'),
    );
    expect(fila?.concepto).toContain(
      'pago de AFAC (lo paga VuelaTour; no se acredita al avión)',
    );
    expect(fila?.monto_mxn).toBe(5000);
    // balance = reparto: el delta entre los dos libros es el MISMO con y sin
    // la marca (el pago sale de los dos por la misma regla).
    const delta = (x: {
      b: BalanceAvionPayload;
      r: { gastos: { permisos_usd: number } };
    }) => r2((x.b.balance.permisos_usd ?? 0) - x.r.gastos.permisos_usd);
    expect(delta(con)).toBe(delta(base));
    expect(delta(sin)).toBe(delta(base));
  });
});

/**
 * REVISIÓN ADVERSARIA (16-oct-2026): el MISMO gasto con la forma REAL de
 * prod (SELECT del 16-oct, id a03433b7…): «Permisos Vuelos Privados VGV»
 * $5,000.00 MXN, PERMISO, SIN `tc_gasto`, sin vuelo, 1-sep-2026,
 * TRANSFERENCIA conciliada; T.C. oficial del 1-sep = 17.0077. Sin T.C.
 * propio, balance y reparto lo convierten con el oficial del día ⇒ 5000 /
 * 17.0077 = 293.98 USD (desde el 0.0.98, invariante 96: hasta el 0.0.97 el
 * balance usaba el T.C. de las hojas); Libro Dinero: pesos. Marcarlo debe sacar EXACTAMENTE esa conversión de cada uno (nada
 * más se mueve) y `pagos_afac` lo lleva con la MISMA conversión que tenía
 * en la hoja «permisos».
 */
describe('PAGO DE AFAC marcado — caso real de prod sin T.C. propio (revisión)', () => {
  const PERMISO_REAL: Fila = { ...PERMISO_VGV, tc_gasto: null };
  const tcOficial = {
    oficialDetallePara: () =>
      Promise.resolve({
        tc: 17.0077,
        fecha_dato: '2026-09-01',
        fuente: 'OPEN_ER_API',
      }),
  };
  function tablasReal(marcado: boolean | null): Record<string, Fila[]> {
    const t = mundo({ diferido: false });
    if (marcado != null) {
      t.gasto = [...t.gasto, { ...PERMISO_REAL, es_pago_afac: marcado }];
    }
    return t;
  }
  async function libros(marcado: boolean | null) {
    const t = tablasReal(marcado);
    const fb = fakeCierre(t, {});
    const b = await (
      new AircraftBalanceService(
        fb.supabase as unknown as SupabaseService,
        {} as never,
        { proximoServicio: () => null } as never,
        tcOficial as never,
        {} as never,
        config as never,
      ) as unknown as {
        buildPayload: (
          a: string | null,
          d: string,
          h: string,
        ) => Promise<BalanceAvionPayload>;
      }
    ).buildPayload(AV, SEP.desde, SEP.hasta);
    const fr = fakeCierre(t, {});
    const r = await new ProfitSharingService(
      fr.supabase as unknown as SupabaseService,
      {} as never,
      tcOficial as never,
      {} as never,
      config as never,
    ).compute(SEP);
    const d = await dinero(t).buildPayload(SEP.desde, SEP.hasta);
    return { b, r: r.aviones[0], d };
  }
  const permisosDinero = (p: DineroXlsxPayload) =>
    p.utilidades_aviones?.find((u) => u.matricula === 'XB-TST')?.permisos_mxn ??
    0;

  it('sin marca resta su conversión en cada libro; MARCADO sale EXACTO de los tres y viaja en `pagos_afac` con el MISMO T.C.', async () => {
    const base = await libros(null);
    const sin = await libros(false);
    const con = await libros(true);
    // Sin marca: 5,000 en la hoja (MXN: `tc_aplicado` null); su USD es el
    // del oficial del día, 293.98, IGUAL en balance y reparto (0.0.98,
    // invariante 96; hasta el 0.0.97 el balance daba 250 con el T.C. de las
    // hojas = 20 de este mundo); Libro Dinero 5,000 pesos.
    expect(sin.b.permisos.total_mxn).toBe(5000);
    const filaPermiso = sin.b.permisos.filas.find(
      (f) => f.gasto_id === PERMISO_REAL.id,
    )!;
    expect(filaPermiso).toMatchObject({ monto_mxn: 5000, tc_aplicado: null });
    const deltaBalanceUsd = r2(
      sin.b.balance.permisos_usd! - (base.b.balance.permisos_usd ?? 0),
    );
    expect(deltaBalanceUsd).toBe(293.98);
    expect(r2(sin.r.gastos.permisos_usd - base.r.gastos.permisos_usd)).toBe(
      293.98,
    );
    expect(r2(permisosDinero(sin.d) - permisosDinero(base.d))).toBe(5000);
    // Marcado: los tres libros vuelven EXACTO a como estaban sin el gasto.
    expect(con.b.permisos.total_mxn).toBe(base.b.permisos.total_mxn);
    expect(con.b.balance.permisos_usd).toBe(base.b.balance.permisos_usd);
    expect(con.b.balance.utilidad_cobrada_usd).toBe(
      base.b.balance.utilidad_cobrada_usd,
    );
    expect(con.b.balance.socios).toEqual(base.b.balance.socios);
    expect(con.r.gastos.permisos_usd).toBe(base.r.gastos.permisos_usd);
    expect(con.r.saldo_disponible_usd).toBe(base.r.saldo_disponible_usd);
    expect(permisosDinero(con.d)).toBe(permisosDinero(base.d));
    // Viaja aparte con la MISMA conversión que tenía en «permisos».
    expect(con.b.pagos_afac!.filas).toEqual([
      expect.objectContaining({
        gasto_id: PERMISO_REAL.id,
        monto_mxn: 5000,
        tc_aplicado: null,
      }),
    ]);
    expect(con.b.pagos_afac!.total_mxn).toBe(5000);
    expect(r2(con.b.pagos_afac!.usd ?? 0)).toBe(deltaBalanceUsd);
    // El reparto lo lista EXCLUIDO con el oficial del día (transparencia).
    expect(
      con.r.detalle.gastos_por_categoria.find(
        (c) => c.categoria === PAGO_AFAC_CLAVE_DETALLE,
      ),
    ).toMatchObject({ grupo: 'EXCLUIDO', count: 1, usd: 293.98 });
  });
});

const r2 = (x: number) => Math.round(x * 100) / 100;
