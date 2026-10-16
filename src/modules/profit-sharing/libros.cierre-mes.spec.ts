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

import type { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from './profit-sharing.service';
import { DineroReportService } from './dinero-report.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type {
  BalanceAvionPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';
import { fakeCierre, type Fila } from '../../common/cierre-mes.fixture-spec';

/**
 * CIERRE DE MES — LOS TRES LIBROS + EL REPARTO para un vuelo DIFERIDO
 * (16-oct-2026, API 0.0.88, invariante 89). Mundo de un avión (XB-TST, K 20,
 * reserva de overhaul 10 USD/h):
 *  - V1 #901 (10-sep): 2,000 USD cobrados el 12-sep ⇒ se queda en septiembre.
 *  - V2 #902 (25-sep): 1,000 USD cobrados el 2-OCT ⇒ el cierre de septiembre
 *    lo DIFIRIÓ a octubre (`periodo_contable` = 1-oct). Gasto OPERACIONES de
 *    2,000 MXN del 28-sep (T.C. 20 ⇒ 100 USD). Voló 1.5 h.
 *  - V3 #903 (5-oct): 500 USD sin cobro ⇒ en octubre abierto «pasará a
 *    noviembre al cerrar».
 * Decisión del cliente: el vuelo pasa COMPLETO (venta, gastos de eje vuelo,
 * comisiones) y las HORAS se quedan en su fecha real. balance = reparto =
 * Libro Dinero.
 */

const AV = 'av-1';
const V1 = 'v-901';
const V2 = 'v-902';
const V3 = 'v-903';
const ALE = 'u-ale';
const PERIODO_OCT = '2026-10-01T00:00:00-05:00';

const SEP = { desde: '2026-09-01', hasta: '2026-09-30' };
const OCT = { desde: '2026-10-01', hasta: '2026-10-31' };

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

const idsDetalle = (r: Awaited<ReturnType<ProfitSharingService['compute']>>) =>
  r.aviones.flatMap((a) => a.detalle.vuelos.map((v) => v.id));

describe('REPARTO con un vuelo diferido (septiembre ⇒ octubre)', () => {
  it('SEPTIEMBRE: el vuelo diferido NO reparte dinero (sale en `diferidos_salen`) pero sus HORAS sí cuentan (reserva de overhaul)', async () => {
    const r = await reparto(mundo()).compute(SEP);
    expect(idsDetalle(r)).toEqual([V1]);
    const a = r.aviones[0];
    expect(a.ingresos.cobrado_usd).toBe(2000);
    expect(a.gastos.directos_usd).toBe(0);
    // 2 h de V1 + 1.5 h de V2 (voló en septiembre) ⇒ reserva 35 USD.
    expect(a.horas_voladas_hr).toBe(3.5);
    expect(a.reserva_overhaul_usd).toBe(35);
    expect(r.cierre).toMatchObject({
      disponible: true,
      periodo: '2026-09',
      estado: 'CERRADO',
      cerrado_por_nombre: 'Ale Martínez',
      diferidos_entran: [],
      pendientes_que_pasarian: [],
    });
    expect(r.cierre?.diferidos_salen).toEqual([
      expect.objectContaining({
        id: V2,
        folio: 902,
        destino: '2026-10',
        venta_usd: 1000,
        cobrado_usd: 0,
        leyenda:
          'Pasa a octubre 2026 · pendiente de cobro: cobrado $0.00 USD de $1,000.00 USD',
      }),
    ]);
  });

  it('SEPTIEMBRE cerrado: `coincide_con_snapshot` compara el saldo de hoy con el guardado al cerrar', async () => {
    const r = await reparto(mundo()).compute(SEP);
    const saldo = r.aviones[0].saldo_disponible_usd;
    const t = mundo();
    t.cierre_mes[0].totales = {
      por_avion: [{ aeronave_id: AV, saldo_usd: saldo }],
    };
    expect((await reparto(t).compute(SEP)).cierre?.coincide_con_snapshot).toBe(
      true,
    );
    t.cierre_mes[0].totales = {
      por_avion: [{ aeronave_id: AV, saldo_usd: saldo + 5 }],
    };
    expect((await reparto(t).compute(SEP)).cierre?.coincide_con_snapshot).toBe(
      false,
    );
  });

  it('OCTUBRE: el vuelo diferido reparte COMPLETO (cobro + su gasto del 28-sep) con «Viene de septiembre 2026» y SIN horas; V3 sin cobro «pasará a noviembre»', async () => {
    const r = await reparto(mundo()).compute(OCT);
    expect(idsDetalle(r).sort()).toEqual([V2, V3]);
    const a = r.aviones[0];
    expect(a.ingresos.cobrado_usd).toBe(1000);
    expect(a.gastos.directos_usd).toBe(100);
    expect(a.horas_voladas_hr).toBe(0.5);
    const v2 = a.detalle.vuelos.find((v) => v.id === V2);
    expect(v2).toMatchObject({
      cierre_marca: 'Viene de septiembre 2026',
      diferido_de: '2026-09',
      diferido_a: null,
      fecha: '2026-09-25',
    });
    const v3 = a.detalle.vuelos.find((v) => v.id === V3);
    expect(v3?.cierre_marca).toBe(
      'Pendiente de cobro: pasará a noviembre 2026 al cerrar (cobrado $0.00 USD de $500.00 USD)',
    );
    expect(r.cierre?.estado).toBe('ABIERTO');
    expect(r.cierre?.diferidos_entran.map((d) => d.id)).toEqual([V2]);
    expect(r.cierre?.pendientes_que_pasarian).toEqual([
      expect.objectContaining({
        id: V3,
        motivo: 'SIN_COBRO',
        destino: '2026-11',
      }),
    ]);
  });
});

describe('BALANCE por avión con el vuelo diferido', () => {
  it('SEPTIEMBRE: fila SOMBRA (horas 1.5 reales, dinero null) que no suma; totales solo de V1', async () => {
    const p = await balance(mundo()).buildPayload(AV, SEP.desde, SEP.hasta);
    const sombra = p.vuelos.find((f) => f.vuelo_id === V2);
    expect(sombra).toMatchObject({
      fila_sombra: true,
      tiempo_vuelo: 1.5,
      total_mxn: null,
      op_mxn: null,
      cobrado_mxn: null,
      status_cobro: 'Pasa a oct-2026',
      diferido_a: '2026-10',
    });
    expect(sombra?.cierre_marca).toBe(
      'Pasa a octubre 2026 (pendiente de cobro: cobrado $0.00 MXN de $20,000.00 MXN)',
    );
    expect(p.totales.total_mxn).toBe(40000);
    expect(p.totales.op_mxn).toBe(0);
    expect(p.totales.tiempo_vuelo).toBe(3.5);
    expect(p.cierre?.pasan.map((x) => x.vuelo_id)).toEqual([V2]);
    expect(p.pendientes.some((t) => t.includes('pasan a octubre 2026'))).toBe(
      true,
    );
    // La cadena de tacómetros sigue completa (la sombra conserva sus tacos).
    expect(p.vuelos.every((f) => f.salto_taco_inicio !== true)).toBe(true);
  });

  it('OCTUBRE: la fila que VIENE suma venta y su gasto (Σ vínculos == celda), sin horas', async () => {
    const p = await balance(mundo()).buildPayload(AV, OCT.desde, OCT.hasta);
    const viene = p.vuelos.find((f) => f.vuelo_id === V2);
    expect(viene).toMatchObject({
      cierre_marca: 'Viene de septiembre 2026',
      diferido_de: '2026-09',
      tiempo_vuelo: null,
      taco_inicio: null,
      total_mxn: 20000,
      op_mxn: 2000,
      cobrado_mxn: 20000,
    });
    expect(
      (viene?.op_vinculos ?? [])
        .filter((v) => v.rol === 'suma')
        .reduce((s, v) => s + (v.monto_mxn ?? 0), 0),
    ).toBe(viene?.op_mxn);
    expect(p.totales.tiempo_vuelo).toBe(0.5);
    // El gasto del 28-sep NO es «fuera del periodo»: el vuelo es de sep/oct.
    expect(p.pendientes.some((t) => t.includes('FUERA del periodo'))).toBe(
      false,
    );
    expect(p.cierre?.vienen.map((x) => x.vuelo_id)).toEqual([V2]);
    expect(p.cierre?.pasarian.map((x) => x.vuelo_id)).toEqual([V3]);
  });
  it('OCTUBRE abierto: el que VIENE de septiembre y SIGUE sin cobrar también «pasará a noviembre» (marca doble) y suma como siempre', async () => {
    const m = mundo();
    m.cobro_vuelo = m.cobro_vuelo.filter((c) => c.vuelo_id !== V2);
    const p = await balance(m).buildPayload(AV, OCT.desde, OCT.hasta);
    const viene = p.vuelos.find((f) => f.vuelo_id === V2);
    expect(viene).toMatchObject({
      cierre_marca:
        'Viene de septiembre 2026 · Pendiente de cobro: pasará a noviembre 2026 al cerrar',
      diferido_de: '2026-09',
      diferido_a: '2026-11',
      total_mxn: 20000,
      tiempo_vuelo: null,
    });
    expect(p.cierre?.vienen.map((x) => x.vuelo_id)).toEqual([V2]);
    expect(p.cierre?.pasarian.map((x) => x.vuelo_id).sort()).toEqual(
      [V2, V3].sort(),
    );
  });
});

describe('LIBRO DINERO con el vuelo diferido', () => {
  it('septiembre NO lo trae (lo lista en `cierre.pasan`); octubre sí, con la marca y sin horas', async () => {
    const sep = await dinero(mundo()).buildPayload(SEP.desde, SEP.hasta);
    expect(sep.vuelos).toHaveLength(1);
    expect(sep.cierre?.pasan.map((x) => x.vuelo_id)).toEqual([V2]);
    const oct = await dinero(mundo()).buildPayload(OCT.desde, OCT.hasta);
    const fila = oct.vuelos.find(
      (f) => f.cierre_marca === 'Viene de septiembre 2026',
    );
    expect(fila).toBeDefined();
    expect(fila?.tiempo ?? null).toBeNull();
    expect(fila?.total_cobrado_mxn).toBe(20000);
  });
});

describe('balance = reparto = Libro Dinero para el vuelo diferido (octubre)', () => {
  it('la venta y el gasto del vuelo cuentan UNA vez, en el MISMO mes, en los tres', async () => {
    const r = await reparto(mundo()).compute(OCT);
    const b = await balance(mundo()).buildPayload(AV, OCT.desde, OCT.hasta);
    const d = await dinero(mundo()).buildPayload(OCT.desde, OCT.hasta);
    const lineaR = r.aviones[0].detalle.vuelos.find((v) => v.id === V2);
    const filaB = b.vuelos.find((f) => f.vuelo_id === V2);
    const filaD = d.vuelos.find(
      (f) => f.cierre_marca === 'Viene de septiembre 2026',
    );
    // Venta del avión: reparto (USD) × K == balance == Libro Dinero (MXN).
    expect((lineaR?.venta_avion_usd ?? 0) * 20).toBe(filaB?.total_mxn);
    expect(filaB?.total_mxn).toBe(filaD?.total_cobrado_mxn);
    // Gasto: reparto 100 USD × 20 == OPERACIONES de la fila del balance.
    expect(r.aviones[0].gastos.directos_usd * 20).toBe(filaB?.op_mxn);
    // Y en septiembre ninguno de los tres lo cuenta como dinero.
    const rs = await reparto(mundo()).compute(SEP);
    const bs = await balance(mundo()).buildPayload(AV, SEP.desde, SEP.hasta);
    const ds = await dinero(mundo()).buildPayload(SEP.desde, SEP.hasta);
    expect(idsDetalle(rs)).not.toContain(V2);
    expect(bs.vuelos.find((f) => f.vuelo_id === V2)?.total_mxn).toBeNull();
    expect(ds.vuelos.some((f) => f.clave.includes('902'))).toBe(false);
  });
});

describe('SIN la migración: todo como 0.0.87', () => {
  it('el reparto de septiembre trae los DOS vuelos por fecha_vuelo y no lleva `cierre`', async () => {
    const r = await reparto(mundo(), true).compute(SEP);
    expect(idsDetalle(r).sort()).toEqual([V1, V2]);
    expect('cierre' in r).toBe(false);
    for (const v of r.aviones[0].detalle.vuelos) {
      expect('cierre_marca' in v).toBe(false);
    }
  });

  it('balance y Libro Dinero: filas normales, sin llaves del cierre', async () => {
    const b = await balance(mundo(), true).buildPayload(
      AV,
      SEP.desde,
      SEP.hasta,
    );
    expect(b.vuelos).toHaveLength(2);
    expect('cierre' in b).toBe(false);
    expect(b.vuelos.every((f) => !('fila_sombra' in f))).toBe(true);
    const d = await dinero(mundo(), true).buildPayload(SEP.desde, SEP.hasta);
    expect(d.vuelos).toHaveLength(2);
    expect('cierre' in d).toBe(false);
  });

  it('con la migración PERO sin cierres: los MISMOS números que sin ella (solo cambian las llaves aditivas)', async () => {
    const limpia = (x: unknown): unknown =>
      JSON.parse(
        JSON.stringify(x, (k, v: unknown) =>
          [
            'cierre',
            'cierre_marca',
            'diferido_de',
            'diferido_a',
            'fila_sombra',
          ].includes(k)
            ? undefined
            : v,
        ),
      );
    const con = await reparto(mundo({ diferido: false })).compute(SEP);
    const sin = await reparto(mundo({ diferido: false }), true).compute(SEP);
    expect(limpia(con)).toEqual(limpia(sin));
    const bc = await balance(mundo({ diferido: false })).buildPayload(
      AV,
      SEP.desde,
      SEP.hasta,
    );
    const bsn = await balance(mundo({ diferido: false }), true).buildPayload(
      AV,
      SEP.desde,
      SEP.hasta,
    );
    expect(limpia({ ...bc, generado: 0 })).toEqual(
      limpia({ ...bsn, generado: 0 }),
    );
  });
});

describe('PRE-CIERRE con el cierre de mes', () => {
  it('octubre: el sin cobro dice «Pasará a noviembre 2026 al cerrar», el diferido sale en «vuelos que vienen» y el bloque `cierre` dice por qué aún no se cierra', async () => {
    const ps = reparto(mundo());
    ps.ahora = () => new Date('2026-10-16T17:00:00Z');
    const pre = await ps.preCierre(OCT);
    const items = pre.items as Array<Record<string, unknown>>;
    const pend = items.find((i) => i.clave === 'cobros_pendientes') as {
      vuelos: Array<Record<string, unknown>>;
      detalle: string;
    };
    expect(pend.vuelos).toEqual([
      expect.objectContaining({
        id: V3,
        pasara_a: '2026-11',
        cobrado_al_corte_usd: 0,
        leyenda:
          'Pasará a noviembre 2026 al cerrar (cobrado $0.00 USD de $500.00 USD)',
      }),
    ]);
    expect(pend.detalle).toContain('pasan completos al mes siguiente');
    const vienen = items.find((i) => i.clave === 'vuelos_que_vienen') as {
      count: number;
      vuelos: Array<Record<string, unknown>>;
      informativo: boolean;
    };
    expect(vienen.count).toBe(1);
    expect(vienen.vuelos[0]).toMatchObject({
      id: V2,
      origen: '2026-09',
      leyenda: 'Viene de septiembre 2026',
    });
    expect(vienen.informativo).toBe(true);
    expect((pre as { cierre?: unknown }).cierre).toMatchObject({
      disponible: true,
      periodo: '2026-10',
      estado: 'ABIERTO',
      puede_cerrar: false,
      motivo_no_cerrable: 'MES_EN_CURSO',
      roles_cierran: ['ADMIN', 'FACTURACION'],
    });
  });

  it('sin la migración: ni leyendas ni renglón nuevo ni bloque `cierre`', async () => {
    const ps = reparto(mundo(), true);
    const pre = await ps.preCierre(OCT);
    const items = pre.items as Array<Record<string, unknown>>;
    expect(items.some((i) => i.clave === 'vuelos_que_vienen')).toBe(false);
    expect('cierre' in pre).toBe(false);
  });
});

describe('REVISIÓN 16-oct-2026 — diferido que alguien regresó a EN_VUELO', () => {
  it('octubre: el diferido (voló en septiembre) que ya no está COMPLETADO es «sin completar» de OCTUBRE y BLOQUEA su cierre; septiembre no lo cuenta', async () => {
    const t = mundo();
    const v2 = t.vuelo.find((v) => v.id === V2) as Fila;
    v2.estado = 'EN_VUELO';
    const ps = reparto(t);
    ps.ahora = () => new Date('2026-11-03T17:00:00Z');
    const pre = await ps.preCierre(OCT);
    const items = pre.items as Array<Record<string, unknown>>;
    const sinCompletar = items.find(
      (i) => i.clave === 'vuelos_sin_completar',
    ) as { count: number; vuelos?: Array<{ id: string }> };
    expect(sinCompletar.count).toBe(1);
    expect(pre.listo).toBe(false);
    // Septiembre (su mes REAL) lo sigue viendo por fecha_vuelo, como antes.
    const preSep = await ps.preCierre(SEP);
    const sep = (preSep.items as Array<Record<string, unknown>>).find(
      (i) => i.clave === 'vuelos_sin_completar',
    ) as { count: number };
    expect(sep.count).toBe(1);
  });
});
