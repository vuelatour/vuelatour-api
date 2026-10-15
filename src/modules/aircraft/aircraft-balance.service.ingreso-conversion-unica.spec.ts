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
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import { DashboardsService } from '../dashboards/dashboards.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  fakeSupabase,
  gastoBase,
  mundoLibros,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * INGRESO DE UN AVIÓN: LA MISMA CONVERSIÓN EN BALANCE, REPARTO Y TABLERO
 * (decisión del cliente del 14-oct-2026, API 0.0.77; invariante 67).
 *
 * Hasta el 0.0.76 el balance dividía el NETO MXN de la hoja «Otros ingresos»
 * entre el T.C. de las hojas de gastos (el promedio del libro) y el reparto
 * entre el T.C. propio ?? oficial del día del ingreso: ING-4 (N990GG,
 * $46,550.80 MXN del 4-sep-2026, sin T.C. propio) daba 2,710.47 en el
 * balance (÷ 17.17442) y 2,746.70 en el reparto (÷ 16.9479). Hoy los TRES
 * libros usan la fuente única `usdDeIngresoAvion`: 2,746.70.
 *
 * Mundo de los libros (XB-TST, vuelo #501 con K 20 ⇒ promedio 20: si la hoja
 * dividiera entre el promedio saldría 2,327.54) + un segundo avión XB-DOS
 * SIN vuelos ni gastos. T.C. oficial POR DÍA con las cifras reales de
 * septiembre de 2026.
 */

const AV2 = 'av-2';
const MAU = 'u-mau';
const ACC = 'u-acc';
const r2 = (x: number) => Math.round(x * 100) / 100;

/** T.C. oficial real por día (open.er-api); otro día ⇒ sin dato. */
const OFICIAL: Record<string, number> = {
  '2026-09-04': 16.9479,
  '2026-09-10': 17.2,
  '2026-09-15': 17.1211,
  '2026-09-18': 17.1851,
  '2026-09-30': 18.0243,
};

/** ING-4 real: reembolso MXN sin T.C. propio, re-apuntado al XB-TST. */
const ING_4: Fila = {
  id: 'i-4r',
  folio: 4,
  categoria: 'REEMBOLSO_DEVOLUCION',
  fecha: '2026-09-04',
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  monto: 46550.8,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  pagador: 'angel alvarez',
  aeronave_id: AV,
  aeronave: { matricula: 'XB-TST', color_calendario: '#3B82F6' },
  cuenta: { alias: 'EJE SCOTIA', banco: 'Scotiabank' },
  notas: 'reembolso del pago del serv de 50 hrs en toledo, fact 53',
  gasto_id: null,
  deleted_at: null,
  cliente: null,
  vuelo: null,
};

/** 46,550.80 ÷ 16.9479 (oficial del 4-sep). */
const USD_ING_4 = 2746.7;

function mundo(
  ingresos: Fila[] = [],
  gastosExtra: Fila[] = [],
): Record<string, Fila[]> {
  const m = mundoLibros(ingresos);
  const socio = (
    aeronave: string,
    id: string,
    pct: string,
    nombre: string,
    esEmpresa: boolean,
  ): Fila => ({
    aeronave_id: aeronave,
    socio_id: id,
    porcentaje: pct,
    vigente_desde: '2020-01-01',
    vigente_hasta: null,
    usuario: { nombre, es_empresa: esEmpresa },
  });
  return {
    ...m,
    aeronave: [
      ...m.aeronave.map((a) => ({ ...a, activa: true })),
      {
        ...m.aeronave[0],
        id: AV2,
        matricula: 'XB-DOS',
        color_calendario: '#10B981',
        activa: true,
      },
    ],
    aeronave_socio: [
      socio(AV, MAU, '51.000', 'Mauricio Roque', false),
      socio(AV, ACC, '49.000', 'Aero Charter Cancun', true),
      socio(AV2, MAU, '70.000', 'Mauricio Roque', false),
      socio(AV2, ACC, '30.000', 'Aero Charter Cancun', true),
    ],
    usuario: [
      { id: MAU, nombre: 'Mauricio Roque' },
      { id: ACC, nombre: 'Aero Charter Cancun' },
    ],
    reserva_overhaul: [],
    gasto: [...m.gasto, ...gastosExtra],
  };
}

/** Puerta del T.C. oficial que cuenta las consultas por día. */
function tipoCambio() {
  const dias: string[] = [];
  return {
    dias,
    svc: {
      oficialDetallePara: (dia: string) => {
        dias.push(dia);
        const tc = OFICIAL[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    },
  };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  empresa: BalanceEmpresaBloquePayload;
};

function balance(m: Record<string, Fila[]>) {
  const tc = tipoCambio();
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    fakeSupabase(m).supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviados.individual = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
      generateBalanceGeneralXlsx: (p: General) => {
        enviados.general = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    tc.svc as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados, dias: tc.dias };
}

async function libro(
  m: Record<string, Fila[]>,
  avion: string = AV,
): Promise<BalanceAvionPayload> {
  const b = balance(m);
  await b.service.xlsx(avion, DESDE, HASTA);
  return b.enviados.individual!;
}

function repartoSvc(m: Record<string, Fila[]>) {
  return new ProfitSharingService(
    fakeSupabase(m).supabase as unknown as SupabaseService,
    {} as never,
    tipoCambio().svc as never,
    {} as never,
  );
}

async function reparto(m: Record<string, Fila[]>, avion: string = AV) {
  const r = await repartoSvc(m).compute({ desde: DESDE, hasta: HASTA });
  const a = r.aviones.find((x) => x.aeronave.id === avion);
  if (!a) throw new Error(`sin avión ${avion} en el reparto`);
  return a;
}

async function tablero(m: Record<string, Fila[]>, avion: string = AV) {
  const service = new DashboardsService(
    {} as unknown as SupabaseService,
    repartoSvc(m),
    {} as never,
  );
  Object.assign(service as unknown as Record<string, unknown>, {
    fetchEstadosAbiertos: () => Promise.resolve([]),
    fetchVuelosPeriodo: () => Promise.resolve([]),
    buildTopClientes: () => Promise.resolve([]),
  });
  const r = await service.overview({ desde: DESDE, hasta: HASTA });
  const fila = r.por_avion.find((x) => x.aeronave_id === avion);
  if (!fila) throw new Error(`sin avión ${avion} en el tablero`);
  return { fila, resumen: r.resumen };
}

/** Los TRES libros del mismo mundo y avión. */
async function tres(m: Record<string, Fila[]>, avion: string = AV) {
  const [b, r, t] = await Promise.all([
    libro(m, avion),
    reparto(m, avion),
    tablero(m, avion),
  ]);
  return {
    balanceHoja: b.otros_ingresos_avion?.usd ?? null,
    balanceLinea: b.balance.otros_ingresos_avion_usd ?? null,
    reparto: r.ingresos.otros_ingresos_avion_usd,
    tablero: t.fila.otros_ingresos_avion_usd,
    libro: b,
    repartoAvion: r,
  };
}

describe('Ingreso de un avión: LA MISMA conversión en balance, reparto y tablero (0.0.77)', () => {
  it('(1) ING-4 (MXN sin T.C. propio) en un libro que promedia 20: 2,746.70 en los TRES (÷ el oficial de SU día, 16.9479; jamás ÷ el promedio)', async () => {
    const x = await tres(mundo([ING_4]));
    expect(x.libro.totales.tc_promedio).toBe(20);
    expect(x.balanceHoja).toBe(USD_ING_4);
    expect(x.balanceLinea).toBe(USD_ING_4);
    expect(x.reparto).toBe(USD_ING_4);
    expect(x.tablero).toBe(USD_ING_4);
    expect(USD_ING_4).toBe(r2(46550.8 / 16.9479));
    expect(x.balanceHoja).not.toBe(r2(46550.8 / 20));
    const fila = x.libro.otros_ingresos_avion!.filas[0];
    expect(fila).toMatchObject({
      tc_usd: 16.9479,
      neto_usd: USD_ING_4,
      tc_usd_origen: 'OFICIAL_DEL_DIA',
      tc_usd_nota:
        'T.C. oficial de referencia del día del ingreso (open.er-api, dato del 2026-09-04): el ingreso en pesos no traía tipo de cambio.',
    });
    expect(x.repartoAvion.detalle.otros_ingresos_avion[0]).toMatchObject({
      usd: USD_ING_4,
      tc: 16.9479,
      tc_origen: 'OFICIAL_DEL_DIA',
    });
  });

  it('(2) USD 1,000 con comisión 30: 970.00 (su neto en dólares) en los TRES; la hoja no lleva T.C. A USD', async () => {
    const usd: Fila = {
      ...ING_4,
      id: 'i-usd',
      folio: 5,
      categoria: 'VENTA_ACTIVO',
      moneda: 'USD',
      monto: 1000,
      comision_monto: 30,
      tc_usd_mxn: 18.5,
    };
    const x = await tres(mundo([usd]));
    expect([x.balanceHoja, x.balanceLinea, x.reparto, x.tablero]).toEqual([
      970, 970, 970, 970,
    ]);
    expect(x.libro.otros_ingresos_avion!.filas[0]).toMatchObject({
      tc_usd: null,
      neto_usd: 970,
      tc_usd_origen: null,
      tc_usd_nota: null,
    });
  });

  it('(3) el MISMO ingreso en un avión SIN vuelos ni gastos (XB-DOS): 2,746.70 en los tres, sin respaldo del cierre', async () => {
    const x = await tres(
      mundo([
        {
          ...ING_4,
          aeronave_id: AV2,
          aeronave: { matricula: 'XB-DOS', color_calendario: '#10B981' },
        },
      ]),
      AV2,
    );
    expect(x.libro.vuelos).toHaveLength(0);
    expect(x.libro.totales.tc_promedio).toBeNull();
    expect([x.balanceHoja, x.balanceLinea, x.reparto, x.tablero]).toEqual([
      USD_ING_4,
      USD_ING_4,
      USD_ING_4,
      USD_ING_4,
    ]);
    expect(x.libro.balance.utilidad_despues_usd).toBe(USD_ING_4);
  });

  it('(4) el Balance GENERAL pide el oficial de un día UNA vez aunque dos libros tengan ingresos de ese día, y su consolidado suma lo de los libros', async () => {
    const m = mundo([
      ING_4,
      {
        ...ING_4,
        id: 'i-4b',
        folio: 6,
        monto: 1000,
        aeronave_id: AV2,
        aeronave: { matricula: 'XB-DOS', color_calendario: '#10B981' },
      },
    ]);
    const b = balance(m);
    await b.service.xlsxGeneral(DESDE, HASTA);
    const g = b.enviados.general!;
    expect(b.dias.filter((d) => d === '2026-09-04')).toHaveLength(1);
    const usdDe = (mat: string) =>
      g.aviones.find((a) => a.matricula === mat)!.otros_ingresos_avion!.usd;
    expect(usdDe('XB-TST')).toBe(USD_ING_4);
    expect(usdDe('XB-DOS')).toBe(r2(1000 / 16.9479));
    expect(g.consolidado.otros_ingresos_avion?.usd).toBe(
      r2(USD_ING_4 + r2(1000 / 16.9479)),
    );
    expect(g.consolidado.otros_ingresos_avion?.usd_por_ingreso).toBe(true);
  });

  describe('REEMBOLSO LIGADO a un gasto en pesos: cada libro lo anula con SU conversión del gasto', () => {
    const SERV: Fila = {
      ...gastoBase,
      id: 'g-servicio-50h',
      aeronave_id: AV,
      categoria: 'SERVICIOS',
      monto: 45483.6,
      fecha_gasto: '2026-09-15',
      notas: 'Servicio 50hrs Toledo',
    };
    const reembolsoDe = (gastoId: string, monto: number): Fila => ({
      ...ING_4,
      id: 'i-lig',
      folio: 7,
      monto,
      gasto_id: gastoId,
    });

    it('(5) gasto de la HOJA «Gastos Indirectos» (SERVICIOS 45,483.60 sin vuelo): balance ÷ el T.C. de las hojas (20) y reparto ÷ el oficial del día del gasto (17.1211, 15-sep); neto 0.00 en los dos', async () => {
      const sinNada = mundo();
      const conAmbos = mundo([reembolsoDe(SERV.id as string, 45483.6)], [SERV]);
      const conGasto = mundo([], [SERV]);
      // Balance.
      const bNada = await libro(sinNada);
      const bAmbos = await libro(conAmbos);
      const bGasto = await libro(conGasto);
      const fila = bAmbos.otros_ingresos_avion!.filas[0];
      expect(fila).toMatchObject({
        tc_usd: 20,
        neto_usd: r2(45483.6 / 20),
        tc_usd_origen: 'GASTO_LIGADO',
        tc_usd_nota:
          'T.C. con el que este libro convierte el gasto que reembolsa (gasto g-servic del 15-sep-2026, T.C. promedio de las hojas): reembolso y gasto se anulan en este libro.',
      });
      expect(
        r2(
          bNada.balance.utilidad_despues_usd! -
            bGasto.balance.utilidad_despues_usd!,
        ),
      ).toBe(r2(45483.6 / 20));
      expect(
        Math.abs(
          bAmbos.balance.utilidad_despues_usd! -
            bNada.balance.utilidad_despues_usd!,
        ),
      ).toBeLessThanOrEqual(0.01);
      expect(bAmbos.pendientes.join('\n')).not.toContain(
        'reembolsa un gasto que este libro no le carga',
      );
      expect(bAmbos.pendientes.join('\n')).not.toContain('ING-7');
      // Reparto (y su tablero).
      const rNada = await reparto(sinNada);
      const rAmbos = await reparto(conAmbos);
      expect(rAmbos.detalle.otros_ingresos_avion[0]).toMatchObject({
        usd: r2(45483.6 / 17.1211),
        tc: 17.1211,
        tc_origen: 'GASTO_LIGADO',
      });
      expect(
        Math.abs(rAmbos.saldo_disponible_usd - rNada.saldo_disponible_usd),
      ).toBeLessThanOrEqual(0.01);
      const t = await tablero(conAmbos);
      expect(t.fila.otros_ingresos_avion_usd).toBe(
        rAmbos.ingresos.otros_ingresos_avion_usd,
      );
    });

    it('(6) gasto de la FILA de un vuelo (OPERACIONES 2,000 del #501): el balance usa el T.C. de costos de esa fila y se anulan', async () => {
      const OPS: Fila = {
        ...gastoBase,
        id: 'g-operaciones-501',
        vuelo_id: V1,
        vuelo: { folio: 501, aeronave_id: AV },
        categoria: 'OPERACIONES',
        monto: 2000,
        notas: 'Aterrizaje y plataforma',
      };
      const bNada = await libro(mundo());
      const bAmbos = await libro(
        mundo([reembolsoDe(OPS.id as string, 2000)], [OPS]),
      );
      const v501 = bAmbos.vuelos.find((v) => v.vuelo_id === V1)!;
      expect(v501.tc_costos).toBe(20);
      expect(bAmbos.otros_ingresos_avion!.filas[0]).toMatchObject({
        tc_usd: 20,
        neto_usd: 100,
        tc_usd_origen: 'GASTO_LIGADO',
        tc_usd_nota:
          'T.C. con el que este libro convierte el gasto que reembolsa (gasto g-operac del 10-sep-2026, T.C. de costos del vuelo #501): reembolso y gasto se anulan en este libro.',
      });
      expect(
        Math.abs(
          bAmbos.balance.utilidad_despues_usd! -
            bNada.balance.utilidad_despues_usd!,
        ),
      ).toBeLessThanOrEqual(0.01);
    });

    it('(7) gasto de OTRO mes (este libro no lo cuenta): la regla por ingreso (oficial de SU día, igual en los tres) y el pendiente literal', async () => {
      const AGOSTO: Fila = {
        ...SERV,
        id: 'g-agosto',
        fecha_gasto: '2026-08-20',
        monto: 3000,
      };
      const m = mundo([reembolsoDe('g-agosto', 3000)], [AGOSTO]);
      const x = await tres(m);
      const usd = r2(3000 / 16.9479);
      expect([x.balanceHoja, x.reparto, x.tablero]).toEqual([usd, usd, usd]);
      expect(x.libro.otros_ingresos_avion!.filas[0].tc_usd_origen).toBe(
        'OFICIAL_DEL_DIA',
      );
      expect(x.libro.pendientes).toContain(
        'Hoja "Otros ingresos" (2026-09-04): ING-7 reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con el T.C. oficial de su día y no se anula con su gasto',
      );
      expect(x.repartoAvion.detalle.otros_ingresos_avion[0].tc_aviso).toBe(
        'ING-7 reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con el T.C. oficial de su día y no se anula con su gasto',
      );
    });

    // Revisión del 14-oct-2026 (hallazgo del reembolso ligado): lo que el
    // libro le CARGA al avión del gasto, no solo su T.C.
    it('(8) EXTENSIÓN DE HORARIO completa en la fila del #501 (caso #192: el avión no la carga): ni el balance ni el reparto la ligan — el oficial de SU día en los TRES, pendiente y `tc_aviso`', async () => {
      const EXT: Fila = {
        ...gastoBase,
        id: 'g-extension-501',
        vuelo_id: V1,
        vuelo: { folio: 501, aeronave_id: AV },
        categoria: 'OPERACIONES',
        monto: 4549.06,
        notas: 'extensión de servicio inspector Baraona',
      };
      const x = await tres(
        mundo([reembolsoDe(EXT.id as string, 4549.06)], [EXT]),
      );
      const v501 = x.libro.vuelos.find((v) => v.vuelo_id === V1)!;
      expect(v501.op_vinculos).toContainEqual({
        id: 'g-extension-501',
        rol: 'nota',
        monto_mxn: null,
        gasto_mxn: 4549.06,
      });
      const usd = r2(4549.06 / 16.9479);
      expect([x.balanceHoja, x.reparto, x.tablero]).toEqual([usd, usd, usd]);
      expect(x.libro.otros_ingresos_avion!.filas[0].tc_usd_origen).toBe(
        'OFICIAL_DEL_DIA',
      );
      expect(x.repartoAvion.detalle.otros_ingresos_avion[0].tc_origen).toBe(
        'OFICIAL_DEL_DIA',
      );
      const aviso =
        'ING-7 reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con el T.C. oficial de su día y no se anula con su gasto';
      expect(x.libro.pendientes).toContain(
        `Hoja "Otros ingresos" (2026-09-04): ${aviso}`,
      );
      expect(x.repartoAvion.detalle.otros_ingresos_avion[0].tc_aviso).toBe(
        aviso,
      );
    });

    it('(9) TUA de la oficina en la factura del #501 (2,000 = operación 1,500 + TUA 500): los dos libros ligan por lo CARGADO (1,500); un reembolso de 2,000 se avisa en los dos y deja +500 ÷ su T.C.', async () => {
      const OPS: Fila = {
        ...gastoBase,
        id: 'g-op-tua-501',
        vuelo_id: V1,
        vuelo: { folio: 501, aeronave_id: AV },
        categoria: 'OPERACIONES',
        monto: 2000,
        tua_incluida: 500,
        notas: 'Aterrizaje y TUA',
      };
      const bNada = await libro(mundo());
      const x = await tres(mundo([reembolsoDe(OPS.id as string, 2000)], [OPS]));
      const v501 = x.libro.vuelos.find((v) => v.vuelo_id === V1)!;
      expect(v501.op_vinculos).toContainEqual({
        id: 'g-op-tua-501',
        rol: 'suma',
        monto_mxn: 1500,
        gasto_mxn: 2000,
      });
      expect(x.libro.otros_ingresos_avion!.filas[0]).toMatchObject({
        tc_usd: 20,
        neto_usd: 100,
        tc_usd_origen: 'GASTO_LIGADO',
        tc_usd_nota:
          'T.C. con el que este libro convierte el gasto que reembolsa (gasto g-op-tua del 10-sep-2026, T.C. de costos del vuelo #501): este libro solo le carga $1,500 MXN de ese gasto al avión; los $500 MXN restantes del reembolso no se anulan con nada.',
      });
      const aviso =
        'ING-7 reembolsa $2,000 MXN de un gasto del que este libro solo le carga $1,500 MXN al avión: $500 MXN no se anulan con nada y suman al avión — si esa parte no es suya, corrige el monto o el avión del ingreso';
      expect(x.libro.pendientes).toContain(
        `Hoja "Otros ingresos" (2026-09-04): ${aviso}`,
      );
      // Balance: el gasto restó 1,500 ÷ 20 = 75 y el reembolso suma 100.
      expect(
        r2(
          x.libro.balance.utilidad_despues_usd! -
            bNada.balance.utilidad_despues_usd!,
        ),
      ).toBe(25);
      // Reparto: el divisor del gasto (oficial del 10-sep, 17.2) y el MISMO aviso.
      expect(x.repartoAvion.detalle.otros_ingresos_avion[0]).toMatchObject({
        usd: r2(2000 / 17.2),
        tc: 17.2,
        tc_origen: 'GASTO_LIGADO',
        tc_aviso: aviso,
      });
    });

    it('(10) gasto del TRAMO CANCELADO que voló otro avión (fila «solo gastos» del XB-DOS, sin parte en la venta): el balance NO lo resta ni lo liga (oficial de su día + pendiente); el reparto sí lo resta y lo liga (diferencia de diseño entre libros, invariante 67)', async () => {
      const V7 = 'v-7';
      const DIA7 = '2026-09-26T15:00:00+00:00';
      const GASTO: Fila = {
        ...gastoBase,
        id: 'g-tramo-cancelado',
        vuelo_id: V7,
        escala_id: 'e-7b',
        aeronave_id: AV2,
        categoria: 'OPERACIONES',
        monto: 500,
        tc_gasto: 17.5,
        fecha_gasto: '2026-09-27',
        notas: 'Aterrizaje del tramo cancelado',
        vuelo: { folio: 507, aeronave_id: AV },
      };
      const m = mundo(
        [
          {
            ...reembolsoDe(GASTO.id as string, 500),
            aeronave_id: AV2,
            aeronave: { matricula: 'XB-DOS', color_calendario: '#10B981' },
          },
        ],
        [GASTO],
      );
      const e1 = m.escala[0];
      m.vuelo = [
        ...m.vuelo,
        { ...m.vuelo[0], id: V7, folio: 507, fecha_vuelo: DIA7 },
      ];
      m.escala = [
        ...m.escala,
        {
          ...e1,
          id: 'e-7a',
          vuelo_id: V7,
          orden: 1,
          taco_salida: 102,
          taco_llegada: 104,
          fecha_salida_plan: DIA7,
          vuelo: { fecha_vuelo: DIA7, aeronave_id: AV },
        },
        {
          ...e1,
          id: 'e-7b',
          vuelo_id: V7,
          orden: 2,
          aeronave_id: AV2,
          cancelada_at: '2026-09-26T12:00:00+00:00',
          taco_salida: null,
          taco_llegada: null,
          origen_iata: 'MID',
          destino_iata: 'CUN',
          fecha_salida_plan: '2026-09-27T18:00:00+00:00',
          vuelo: { fecha_vuelo: DIA7, aeronave_id: AV },
        },
      ];
      const x = await tres(m, AV2);
      const fila = x.libro.vuelos.find((v) => v.vuelo_id === V7)!;
      expect(fila.solo_gastos_tramo_cancelado).toBe(true);
      expect(fila.ganancia_usd).toBeNull();
      // La fila SÍ tiene T.C. de costos (el del gasto) y su vínculo 'suma':
      // antes de la revisión el balance lo ligaba aunque ese costo no restara.
      expect(fila.tc_costos).toBe(17.5);
      expect(fila.op_vinculos).toContainEqual({
        id: 'g-tramo-cancelado',
        rol: 'suma',
        monto_mxn: 500,
      });
      expect(x.libro.otros_ingresos_avion!.filas[0]).toMatchObject({
        neto_usd: r2(500 / 16.9479),
        tc_usd_origen: 'OFICIAL_DEL_DIA',
      });
      expect(x.libro.pendientes).toContain(
        'Hoja "Otros ingresos" (2026-09-04): ING-7 reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con el T.C. oficial de su día y no se anula con su gasto',
      );
      expect(x.repartoAvion.detalle.otros_ingresos_avion[0]).toMatchObject({
        usd: r2(500 / 17.5),
        tc: 17.5,
        tc_origen: 'GASTO_LIGADO',
        tc_aviso: null,
      });
    });
  });
});
