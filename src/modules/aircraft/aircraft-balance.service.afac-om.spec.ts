// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionHojaGastosPayload,
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
  BalanceHojaOtrosMovimientosPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import type { ModoBalanceGeneral } from './balance-general-modo.util';
import {
  AV,
  DESDE,
  DIA,
  GOLDEN_OM,
  HASTA,
  V1,
  V2,
  fakeSupabase,
  gastoBase,
  mundoCon,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));
// AFAC POR VUELO (invariante 90): la sonda de la migración 20261016000005,
// encendida por defecto; cada caso «sin migración» la apaga.
jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));
import { afacRealDisponible } from '../../common/afac-real-disponible.util';

/**
 * AFAC POR VUELO en «otros movimientos» del Balance general (16-oct-2026,
 * API 0.0.89, invariante 90; SUPERSEDE las filas «AFAC · matrícula» de la
 * invariante 62). Pedido del cliente: las dos columnas juntas —lo RESERVADO
 * y lo que REALMENTE costó— y «mejor que sea en la columna de egreso».
 *
 * Contrato: `payloadGeneral` anexa al final de `filas` UNA fila por VUELO
 * con AFAC (`seccion: 'AFAC_VUELO'`): INGRESO = `fila.permiso_afac_mxn` del
 * libro (lo RESERVADO, tal cual), EGRESO = el COSTO REAL capturado
 * (`afac_vuelo`; null = sin capturar), con su T.C. (`tc_promedio` del libro)
 * y «por cobrar» 0 alineados; banderas `afac_por_vuelo` (penúltima) y
 * `afac_resumen` (última). Los gastos marcados «Pago de AFAC» salen de la
 * hoja «permisos» del avión y solo aparecen en `afac_resumen.pagos`.
 *
 * Mundo: el de los libros (XB-TST, vuelo #501, K 20, 2 h cobradas) + tarifa
 * AFAC 25 USD/hr y tres permisos PAGADOS sin marca: g1 MXN 2,500 el 05-sep
 * sin vuelo, g2 USD 100 con `tc_gasto` 18 el 12-sep sin vuelo (1,800 MXN) y
 * g3 MXN 1,000 ligado al #501 con `fecha_gasto` 03-OCT (cuenta en el MES DEL
 * VUELO, como en su hoja «permisos»).
 */

/** Vigencia de las comisiones a cargo del avión POSTERIOR a septiembre. */
const POSTERIOR = '2026-12-01';
const TARIFA = 25;

const G1: Fila = {
  ...gastoBase,
  id: 'g-permiso-1',
  aeronave_id: AV,
  categoria: 'PERMISO',
  monto: 2500,
  fecha_gasto: '2026-09-05',
  notas: 'AFAC anual',
};
const G2: Fila = {
  ...gastoBase,
  id: 'g-permiso-2',
  aeronave_id: AV,
  categoria: 'PERMISO',
  monto: 100,
  moneda: 'USD',
  tc_gasto: 18,
  fecha_gasto: '2026-09-12',
  notas: 'Internación',
};
const G3: Fila = {
  ...gastoBase,
  id: 'g-permiso-3',
  vuelo_id: V1,
  vuelo: { folio: 501, aeronave_id: AV },
  categoria: 'PERMISO',
  monto: 1000,
  fecha_gasto: '2026-10-03',
  notas: 'Permiso nocturno MID',
};
/** P = lo que pagó el XB-TST en permisos en el periodo (2,500 + 1,800 + 1,000). */
const P = 5300;

/** Costo real capturado del #501 (Ale, 16-oct-2026 14:05 Cancún). */
const REAL_501: Fila = {
  vuelo_id: V1,
  costo_real_mxn: 4500,
  notas: 'Factura gestor F-123',
  capturado_por: 'u-ale',
  capturado_at: '2026-10-16T19:05:00Z',
  updated_at: '2026-10-16T19:05:00Z',
  updated_by: 'u-ale',
  vuelo: { folio: 501, fecha_vuelo: `${DIA}T15:00:00+00:00` },
};

function conTarifa(
  mundo: Record<string, Fila[]>,
  tarifas: Record<string, number>,
): Record<string, Fila[]> {
  return {
    ...mundo,
    aeronave: mundo.aeronave.map((a) =>
      tarifas[a.id as string] != null
        ? { ...a, permiso_afac_usd_hr: tarifas[a.id as string] }
        : a,
    ),
  };
}

/** El mundo AFAC: tarifa 25 en el XB-TST + g1, g2 y g3 (+ extras). */
function mundoAfac(
  extra: Fila[] = [],
  opts: { reales?: Fila[]; v2?: Fila | null } = {},
): Record<string, Fila[]> {
  const m = conTarifa(
    mundoCon({ gastos: [G1, G2, G3, ...extra], v2: opts.v2 ?? null }),
    { [AV]: TARIFA },
  );
  return {
    ...m,
    escala: opts.v2
      ? [
          ...m.escala,
          {
            ...m.escala[0],
            id: 'e-2',
            vuelo_id: V2,
            taco_salida: 102,
            taco_llegada: 103,
            fecha_salida_plan: '2026-09-20T15:00:00+00:00',
            vuelo: {
              fecha_vuelo: '2026-09-20T15:00:00+00:00',
              aeronave_id: AV,
            },
          },
        ]
      : m.escala,
    afac_vuelo: opts.reales ?? [],
    usuario: [{ id: 'u-ale', nombre: 'Alejandra Pérez' }],
  };
}

/** Marca un gasto del mundo como «Pago de AFAC». */
const marcado = (g: Fila): Fila => ({ ...g, es_pago_afac: true });

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  gastos_empresa: BalanceAvionHojaGastosPayload;
  empresa: BalanceEmpresaBloquePayload;
  variante: ModoBalanceGeneral;
};

function servicio(mundo: Record<string, Fila[]>) {
  const enviados: { general?: General } = {};
  const fake = fakeSupabase(mundo);
  const service = new AircraftBalanceService(
    fake.supabase as unknown as SupabaseService,
    {
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
    { fecha: () => Promise.resolve(POSTERIOR) } as never,
  );
  return { service, enviados, tablasLeidas: fake.tablasLeidas };
}

/** El payload COMPLETO del Balance general (lo que recibe pyservices). */
async function general(
  mundo: Record<string, Fila[]>,
  modo: ModoBalanceGeneral = 'mensual',
): Promise<General> {
  const { service, enviados } = servicio(mundo);
  await service.xlsxGeneral(DESDE, HASTA, modo);
  return enviados.general!;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const om = (g: General): BalanceHojaOtrosMovimientosPayload =>
  g.consolidado.otros_movimientos!;
const filasAfac = (g: General): BalanceOtroMovimientoFilaPayload[] =>
  om(g).filas.filter((f) => f.seccion === 'AFAC_VUELO');
const libroDe = (g: General, matricula: string): BalanceAvionPayload =>
  g.aviones.find((a) => a.matricula === matricula)!;
/** Marca del amarillo de pyservices (`_MARCA_PROVISION`). */
const MARCA_PROVISION = /·\s*PROVISI[OÓ]N\s*\(/;
const fmt = (n: number) =>
  n.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Dinero total del general (receta de `comisiones-general.spec`): Σ
 * ganancia de los vuelos de los libros + Σ remanente de la pestaña.
 */
function dineroTotal(g: General): number {
  return r2(
    g.consolidado.vuelos.reduce((a, v) => a + (v.ganancia_mxn ?? 0), 0) +
      [...om(g).filas, ...om(g).filas_sueltas].reduce(
        (a, f) => a + (f.remanente_mxn ?? 0),
        0,
      ),
  );
}

const sondaAfac = afacRealDisponible as jest.MockedFunction<
  typeof afacRealDisponible
>;

describe('Balance GENERAL — AFAC POR VUELO en «otros movimientos» (invariante 90)', () => {
  beforeEach(() => {
    sondaAfac.mockReset();
    sondaAfac.mockResolvedValue(true);
  });

  it('(1) una fila AFAC_VUELO por vuelo al FINAL de `filas`: INGRESO = lo reservado de la fila del libro (TAL CUAL), EGRESO vacío «por capturar», remanente = reservado; las filas de antes intactas', async () => {
    const g = await general(mundoAfac());
    const tst = libroDe(g, 'XB-TST');
    const v = tst.vuelos[0];
    expect(v.permiso_afac_mxn).toBeGreaterThan(0);
    const filas = om(g).filas;
    const fila = filas.at(-1)!;
    expect(fila).toEqual({
      clave: v.clave,
      // CLAVES SIN APODO (invariante 106): copiados de la fila del libro.
      cliente: v.cliente,
      consecutivo_cliente: null,
      avion_color: tst.avion_color,
      estado: v.estado,
      fecha_vuelo: v.fecha,
      ruta: v.ruta,
      concepto_egreso: 'AFAC costo real · por capturar',
      egreso_mxn: null,
      fecha_egreso: null,
      concepto_ingreso: `AFAC reservado · XB-TST · ${Number(v.horas_cobradas).toFixed(2)} h × 25.00 USD/hr × T.C. ${Number(v.tc_costos).toFixed(6)}`,
      ingreso_mxn: v.permiso_afac_mxn,
      fecha_ingreso: null,
      remanente_mxn: v.permiso_afac_mxn,
      factura: null,
      nota_ingreso: `Reservado = tarifa AFAC del avión × T.C. de costos del vuelo × horas cobradas (columna PERMISO AFAC de la hoja de vuelos): 25.00 × ${Number(v.tc_costos).toFixed(6)} × ${Number(v.horas_cobradas).toFixed(2)} = $${fmt(v.permiso_afac_mxn!)}`,
      seccion: 'AFAC_VUELO',
      afac: {
        vuelo_id: V1,
        matricula: 'XB-TST',
        horas_cobradas: v.horas_cobradas,
        tarifa_usd_hr: 25,
        tc_costos: v.tc_costos,
        reservado_mxn: v.permiso_afac_mxn,
        costo_real_mxn: null,
        remanente_mxn: v.permiso_afac_mxn,
        capturado_por_nombre: null,
        capturado_at: null,
        notas: null,
        mes_contable: '2026-09',
        editable: true,
        motivo_no_editable: null,
        cierre_marca: null,
      },
    });
    expect(Object.keys(fila).at(-1)).toBe('afac');
    expect(Object.keys(fila).at(-2)).toBe('seccion');
    // Σ reservado = lo que el 0.0.88 ponía en la fila «AFAC · XB-TST».
    expect(r2(filasAfac(g).reduce((a, f) => a + (f.ingreso_mxn ?? 0), 0))).toBe(
      tst.totales.permiso_afac_mxn,
    );
    // Las filas de antes, intactas; ninguna fila por avión ni la marca 'AFAC'.
    expect(filas.slice(0, -1)).toEqual(GOLDEN_OM.filas);
    expect(om(g).filas_sueltas).toEqual(GOLDEN_OM.filas_sueltas);
    expect(filas.some((f) => f.seccion === 'AFAC')).toBe(false);
    // Los permisos SIN marca restan en el avión como siempre (hoja «permisos»).
    expect(tst.permisos.total_mxn).toBe(P);
    expect('pagos_afac' in tst).toBe(false);
    // Ningún texto con la marca del amarillo ni con «sin TC».
    for (const t of [
      fila.concepto_ingreso,
      fila.nota_ingreso,
      fila.concepto_egreso,
    ]) {
      expect(t).not.toMatch(MARCA_PROVISION);
      expect(t).not.toMatch(/\bsin TC\b/);
    }
  });

  it('(2) banderas: `afac_por_vuelo` penúltima y `afac_resumen` ÚLTIMA; `afac_en_filas` y `afac` ya no viajan; el resumen cuadra con las filas', async () => {
    const g = await general(mundoAfac([], { v2: vuelo2() }));
    const hoja = om(g);
    const llaves = Object.keys(hoja);
    expect(llaves.at(-1)).toBe('afac_resumen');
    expect(llaves.at(-2)).toBe('afac_por_vuelo');
    expect(hoja.afac_por_vuelo).toBe(true);
    expect('afac_en_filas' in hoja).toBe(false);
    expect('afac' in hoja).toBe(false);
    const afac = filasAfac(g);
    expect(afac.map((f) => f.afac!.vuelo_id)).toEqual([V1, V2]);
    const reservado = r2(afac.reduce((a, f) => a + (f.ingreso_mxn ?? 0), 0));
    expect(hoja.afac_resumen).toEqual({
      vuelos: 2,
      vuelos_con_reservado: 2,
      vuelos_con_real: 0,
      vuelos_sin_real: 2,
      reservado_mxn: reservado,
      costo_real_mxn: 0,
      remanente_mxn: reservado,
      pagado_mxn: 0,
      pagos_sin_tc: 0,
      diferencia_pagado_mxn: 0,
      reales_fuera_de_libro_mxn: 0,
      pagos: [],
    });
    // Aviso: 2 vuelos con reservado sin costo real (no bloquea).
    expect(
      g.consolidado.pendientes.filter((t) => t.startsWith('AFAC: ')),
    ).toEqual([
      `AFAC: 2 vuelo(s) con AFAC reservado ($${fmt(reservado)}) sin costo real capturado — captúralo en 'otros movimientos' del Balance general en pantalla (columna EGRESO de cada fila AFAC).`,
    ]);
  });

  it('(3) TOTALES: Σ remanente de toda la pestaña == Σ ingresos − Σ egresos, sin real y con real (las filas AFAC suman como cualquiera)', async () => {
    for (const reales of [[], [REAL_501]]) {
      const g = await general(mundoAfac([], { reales }));
      const todas = [...om(g).filas, ...om(g).filas_sueltas];
      const s = (k: 'ingreso_mxn' | 'egreso_mxn' | 'remanente_mxn') =>
        r2(todas.reduce((a, f) => a + (f[k] ?? 0), 0));
      expect(s('remanente_mxn')).toBe(r2(s('ingreso_mxn') - s('egreso_mxn')));
    }
  });

  it('(4) SIN reales ni marcas, bloque VUELATOUR = el del 0.0.88: ingresos propios suben EXACTAMENTE lo reservado ÷ T.C. promedio del libro (± 0.01) y los egresos propios NO cambian; la nota nueva', async () => {
    const base = await general(mundoCon());
    const g = await general(mundoAfac());
    const tst = libroDe(g, 'XB-TST');
    const tc = tst.totales.tc_promedio!;
    expect(tc).toBeGreaterThan(0);
    const e = g.empresa;
    expect(e.movimientos_sin_tc).toBe(base.empresa.movimientos_sin_tc);
    expect(
      Math.abs(
        e.ingresos_propios_usd! -
          r2(
            base.empresa.ingresos_propios_usd! +
              tst.totales.permiso_afac_mxn / tc,
          ),
      ),
    ).toBeLessThanOrEqual(0.01 + 1e-9);
    expect(e.pagos_vendedor_usd).toBe(base.empresa.pagos_vendedor_usd);
    expect(e.nota).toContain(
      "hoja 'otros movimientos' (por vuelo, AFAC por vuelo y sueltas)",
    );
    expect(e.nota).toContain('más el AFAC RESERVADO de cada vuelo');
    expect(e.nota).toContain(
      'gastos sueltos y el COSTO REAL AFAC capturado por vuelo (lo paga VuelaTour)',
    );
  });

  it('(5) COSTO REAL capturado (4,500 en el #501): egreso de VuelaTour en la fila (D), remanente = reservado − real, egresos propios += real ÷ T.C. del libro; el AVIÓN no cambia ni un centavo', async () => {
    const sin = await general(mundoAfac());
    const g = await general(mundoAfac([], { reales: [REAL_501] }));
    const fila = filasAfac(g)[0];
    const reservado = fila.ingreso_mxn!;
    expect(fila.egreso_mxn).toBe(4500);
    expect(fila.remanente_mxn).toBe(r2(reservado - 4500));
    expect(fila.concepto_egreso).toBe(
      'AFAC costo real · capturó Alejandra el 16/10/2026',
    );
    expect(fila.nota_egreso).toBe('Factura gestor F-123');
    expect(fila.afac).toMatchObject({
      costo_real_mxn: 4500,
      remanente_mxn: r2(reservado - 4500),
      capturado_por_nombre: 'Alejandra Pérez',
      capturado_at: '2026-10-16T19:05:00Z',
      notas: 'Factura gestor F-123',
      editable: true,
    });
    // El avión, IDÉNTICO (hoja de vuelos, cascada, socios).
    expect(g.aviones).toEqual(sin.aviones);
    // VUELATOUR: egresos propios suben real ÷ T.C. del libro; ingresos igual.
    const tc = libroDe(g, 'XB-TST').totales.tc_promedio!;
    expect(g.empresa.ingresos_propios_usd).toBe(
      sin.empresa.ingresos_propios_usd,
    );
    expect(
      Math.abs(
        g.empresa.pagos_vendedor_usd! -
          r2(sin.empresa.pagos_vendedor_usd! + 4500 / tc),
      ),
    ).toBeLessThanOrEqual(0.01 + 1e-9);
    // Grupo: el dinero total baja EXACTAMENTE el real (una vez).
    expect(dineroTotal(g)).toBe(r2(dineroTotal(sin) - 4500));
    const res = om(g).afac_resumen!;
    expect([
      res.vuelos_con_real,
      res.vuelos_sin_real,
      res.costo_real_mxn,
    ]).toEqual([1, 0, 4500]);
    // Real sin pagos marcados ⇒ aviso de diferencia (no bloquea).
    expect(res.diferencia_pagado_mxn).toBe(-4500);
    expect(
      g.consolidado.pendientes.some((t) =>
        t.startsWith('AFAC: pagado a AFAC en el periodo $0.00 (0 gasto(s)'),
      ),
    ).toBe(true);
  });

  it('(6) PAGO DE AFAC marcado (g1, 2,500): sale de la hoja «permisos» del avión y de su cascada, viaja en `pagos_afac` (última llave del libro) y en `afac_resumen.pagos`; NO egresa en VuelaTour ni en «otros gastos»', async () => {
    const sin = await general(mundoAfac([], { reales: [REAL_501] }));
    const mundo = mundoAfac([], { reales: [REAL_501] });
    mundo.gasto = mundo.gasto.map((x) => (x.id === G1.id ? marcado(x) : x));
    const g = await general(mundo);
    const tst = libroDe(g, 'XB-TST');
    const tstSin = libroDe(sin, 'XB-TST');
    expect(tst.permisos.total_mxn).toBe(P - 2500);
    expect(tst.permisos.filas.map((f) => f.gasto_id)).not.toContain(G1.id);
    // USD GASTO POR GASTO (0.0.98, invariante 96): g2 sus 100 USD tal cual
    // y g3 (1,000 MXN, sin oficial del día en este mundo) ÷ el T.C. de las
    // hojas. Hasta el 0.0.97: (P − 2,500) ÷ T.C. promedio = 140.
    expect(tst.balance.permisos_usd).toBe(
      r2(100 + (P - 2500 - 1800) / tst.totales.tc_promedio!),
    );
    // La utilidad del avión SUBE lo que dejó de restar (en USD de su hoja).
    expect(
      r2(
        tst.balance.utilidad_despues_usd! -
          tstSin.balance.utilidad_despues_usd!,
      ),
    ).toBe(r2(tstSin.balance.permisos_usd! - tst.balance.permisos_usd!));
    // El pago, aparte y con la MISMA conversión.
    // ÚLTIMA llave del libro (el general le agrega después `avion_color`).
    expect(
      Object.keys(tst)
        .filter((k) => k !== 'avion_color')
        .at(-1),
    ).toBe('pagos_afac');
    expect(tst.pagos_afac!.filas).toEqual([
      expect.objectContaining({
        gasto_id: G1.id,
        monto_mxn: 2500,
        detalle: 'AFAC anual',
      }),
    ]);
    const res = om(g).afac_resumen!;
    expect(res.pagos).toEqual([
      {
        gasto_id: G1.id,
        fecha: '2026-09-05',
        detalle: 'AFAC anual · XB-TST',
        matricula: 'XB-TST',
        monto_mxn: 2500,
        moneda_original: null,
        monto_original: null,
      },
    ]);
    expect([
      res.pagado_mxn,
      res.costo_real_mxn,
      res.diferencia_pagado_mxn,
    ]).toEqual([2500, 4500, 2000 * -1]);
    // NO egresa en VuelaTour: la pestaña (filas y sueltas) y «otros gastos»
    // son IDÉNTICAS con y sin la marca; solo cambia el resumen.
    expect(om(g).filas).toEqual(om(sin).filas);
    expect(om(g).filas_sueltas).toEqual(om(sin).filas_sueltas);
    expect(g.gastos_empresa).toEqual(sin.gastos_empresa);
    expect(g.empresa.pagos_vendedor_usd).toBe(sin.empresa.pagos_vendedor_usd);
  });

  it('(7) un avión cuyo ÚNICO dinero del mes es un permiso marcado sale del general (sin actividad) pero su pago NO se pierde del resumen', async () => {
    const AV3 = 'av-3';
    const m = mundoAfac([
      marcado({
        ...gastoBase,
        id: 'g-permiso-vgv',
        aeronave_id: AV3,
        categoria: 'PERMISO',
        monto: 5000,
        fecha_gasto: '2026-09-01',
        notas: 'Permisos Vuelos Privados VGV',
      }),
    ]);
    m.aeronave = [
      ...m.aeronave,
      {
        id: AV3,
        matricula: 'XA-VGV',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: 25,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ];
    const g = await general(m);
    expect(g.aviones.some((a) => a.matricula === 'XA-VGV')).toBe(false);
    expect(om(g).afac_resumen!.pagos).toEqual([
      expect.objectContaining({
        gasto_id: 'g-permiso-vgv',
        detalle: 'Permisos Vuelos Privados VGV · XA-VGV',
        matricula: 'XA-VGV',
        monto_mxn: 5000,
      }),
    ]);
    expect(om(g).afac_resumen!.pagado_mxn).toBe(5000);
  });

  it('(8) PERMISO SIN avión ni vuelo: sin marca sigue en «otros gastos» (UNA vez); marcado sale de ahí y va al resumen con la MISMA conversión', async () => {
    const empresa: Fila = {
      ...gastoBase,
      id: 'g-permiso-empresa',
      categoria: 'PERMISO',
      monto: 670,
      fecha_gasto: '2026-09-08',
      notas: 'AFAC · Pago de derechos',
    };
    const sinMarca = await general(mundoAfac([empresa]));
    const conMarca = await general(mundoAfac([marcado(empresa)]));
    expect(
      sinMarca.gastos_empresa.filas.filter((f) => f.gasto_id === empresa.id),
    ).toHaveLength(1);
    expect(
      conMarca.gastos_empresa.filas.some((f) => f.gasto_id === empresa.id),
    ).toBe(false);
    expect(
      r2(sinMarca.gastos_empresa.total_mxn - conMarca.gastos_empresa.total_mxn),
    ).toBe(670);
    expect(om(conMarca).afac_resumen!.pagos).toEqual([
      {
        gasto_id: empresa.id,
        fecha: '2026-09-08',
        detalle: 'AFAC · Pago de derechos',
        matricula: null,
        monto_mxn: 670,
        moneda_original: null,
        monto_original: null,
      },
    ]);
    expect(filasAfac(conMarca)).toEqual(filasAfac(sinMarca));
  });

  it('(9) SIN la migración: filas por vuelo SIN costo real (aunque la tabla tuviera) y NO editables con su motivo; ni `afac_vuelo` se lee; números = sin reales', async () => {
    const conMigracion = await general(mundoAfac());
    sondaAfac.mockResolvedValue(false);
    const { service, enviados, tablasLeidas } = servicio(
      mundoAfac([], { reales: [REAL_501] }),
    );
    await service.xlsxGeneral(DESDE, HASTA, 'mensual');
    const g = enviados.general!;
    expect(tablasLeidas).not.toContain('afac_vuelo');
    const fila = filasAfac(g)[0];
    expect(fila.egreso_mxn).toBeNull();
    expect(fila.afac!.editable).toBe(false);
    expect(fila.afac!.motivo_no_editable).toBe(
      'El costo real AFAC todavía no está habilitado.',
    );
    // Mismos números que con la migración sin reales; sin aviso de «sin real».
    expect(
      om(g).filas.map((f) => [f.ingreso_mxn, f.egreso_mxn, f.remanente_mxn]),
    ).toEqual(
      om(conMigracion).filas.map((f) => [
        f.ingreso_mxn,
        f.egreso_mxn,
        f.remanente_mxn,
      ]),
    );
    expect(g.empresa).toEqual(conMigracion.empresa);
    expect(om(g).afac_resumen!.vuelos_sin_real).toBe(0);
    expect(g.consolidado.pendientes.some((t) => t.startsWith('AFAC: '))).toBe(
      false,
    );
  });

  it('(10) SIN tarifa AFAC, sin reales y sin marcas: payload de la pestaña BYTE A BYTE el de siempre (`GOLDEN_OM`) y la nota del bloque sin AFAC', async () => {
    const g = await general(mundoCon());
    expect(JSON.stringify(om(g))).toBe(JSON.stringify(GOLDEN_OM));
    expect(g.empresa.nota).not.toContain('AFAC');
    // Con la tarifa pero sin la migración tampoco cambia el resto del libro.
    sondaAfac.mockResolvedValue(false);
    const g0 = await general(mundoCon());
    expect(JSON.stringify(om(g0))).toBe(JSON.stringify(GOLDEN_OM));
  });

  it('(11) `modo: general` (costo por hora) produce las MISMAS filas AFAC y el MISMO bloque que el mensual', async () => {
    const mensual = await general(
      mundoAfac([], { reales: [REAL_501] }),
      'mensual',
    );
    const gen = await general(mundoAfac([], { reales: [REAL_501] }), 'general');
    expect(gen.variante).toBe('general');
    expect(filasAfac(gen)).toEqual(filasAfac(mensual));
    expect(om(gen).afac_resumen).toEqual(om(mensual).afac_resumen);
    expect(gen.empresa).toEqual(mensual.empresa);
  });

  it('(12) el libro EXTERNOS no genera fila AFAC (sin tarifa) y su PERMISO se queda en su libro; un real de un vuelo que NO cae en ningún libro dispara la red de seguridad', async () => {
    const V9 = 'v-9';
    const f9 = '2026-09-25T15:00:00+00:00';
    const m = mundoAfac(
      [
        {
          ...gastoBase,
          id: 'g-permiso-externo',
          vuelo_id: V9,
          vuelo: { folio: 509, aeronave_id: null },
          categoria: 'PERMISO',
          monto: 700,
          notas: 'Permiso del operador externo',
        },
      ],
      {
        reales: [
          REAL_501,
          {
            ...REAL_501,
            vuelo_id: 'v-fantasma',
            costo_real_mxn: 300,
            vuelo: { folio: 777, fecha_vuelo: '2026-09-15T15:00:00+00:00' },
          },
        ],
      },
    );
    m.vuelo = [
      ...m.vuelo,
      vuelo2({
        id: V9,
        folio: 509,
        aeronave_id: null,
        es_externo: true,
        operador_externo: 'Operador Ajeno',
        costo_externo_usd: 500,
        fecha_vuelo: f9,
      }),
    ];
    const g = await general(m);
    expect(filasAfac(g).map((f) => f.afac!.matricula)).toEqual(['XB-TST']);
    expect(
      g.consolidado.permisos.filas.some((f) =>
        String(f.detalle).includes('Permiso del operador externo'),
      ),
    ).toBe(true);
    const res = om(g).afac_resumen!;
    expect(res.reales_fuera_de_libro_mxn).toBe(300);
    expect(res.costo_real_mxn).toBe(4500);
    expect(
      g.consolidado.pendientes.filter((t) =>
        t.includes('no aparecen en ningún libro'),
      ),
    ).toEqual([
      'AFAC: $300.00 de costo real capturado en 1 vuelo(s) que no aparecen en ningún libro del periodo (#777): revisa su avión y su fecha.',
    ]);
  });
});
