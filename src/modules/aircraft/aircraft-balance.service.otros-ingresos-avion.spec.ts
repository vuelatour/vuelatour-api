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
import { DineroReportService } from '../profit-sharing/dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceEmpresaBloquePayload,
  BalanceHojaOtrosMovimientosPayload,
  DineroXlsxPayload,
} from '../pyservices/pyservices.service';
import {
  partirIngresosPorAvion,
  type IngresosDeResultadoPartidos,
} from '../../common/ingreso-resultado.util';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  fakeSupabase,
  mundoLibros,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67) en
 * el BALANCE: un ingreso de resultado con `aeronave_id` cuenta UNA vez, en
 * el mes de su `fecha`, para ESE avión — hoja «Otros ingresos» de su libro
 * y línea «(+) OTROS INGRESOS USD» que SUMA en la cascada (de ahí la
 * utilidad cobrada y los socios) — y deja de estar en «otros movimientos» y
 * en el bloque VUELATOUR (empresa).
 *
 * Mundo de los libros (XB-TST, vuelo #501, K 20) + socios 51 / 49 (Aero
 * Charter `es_empresa`) + `ING_AVION`, el caso real ING-4 de N990GG
 * (reembolso de $46,550.80 MXN del 4-sep-2026) re-apuntado al XB-TST.
 *
 * CONVERSIÓN ÚNICA (14-oct-2026, API 0.0.77): el USD de cada ingreso sale de
 * `usdDeIngresoAvion` (la MISMA del reparto y del tablero), NO del T.C. de
 * las hojas de gastos: ING_AVION (MXN sin T.C. propio) con el oficial de SU
 * día — el mock lo da en 18 ⇒ 46,550.80 ÷ 18 = 2,586.16 aunque el libro
 * promedie 20 (antes ÷ 20 = 2,327.54).
 */

const AV2 = 'av-2';
const r2 = (x: number) => Math.round(x * 100) / 100;

const ING_AVION: Fila = {
  id: 'i-av',
  folio: 14,
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
  deleted_at: null,
  cliente: null,
  vuelo: null,
};

/** La fila EXACTA de la hoja «Otros ingresos» del XB-TST (oficial 18). */
const FILA_ING_AVION = {
  ingreso_id: 'i-av',
  clave: 'ING-14',
  fecha: '2026-09-04',
  categoria: 'Reembolsos y devoluciones recibidos',
  detalle: 'ING-14 · TRANSF INTERBANCARIA SPEI · angel alvarez',
  moneda_original: 'MXN',
  monto_original: 46550.8,
  tc_aplicado: null,
  ingreso_mxn: 46550.8,
  comision_mxn: null,
  neto_mxn: 46550.8,
  cuenta: 'EJE SCOTIA · Scotiabank',
  notas: 'reembolso del pago del serv de 50 hrs en toledo, fact 53',
  // ADITIVOS del 0.0.77: la conversión ÚNICA por ingreso.
  tc_usd: 18,
  neto_usd: 2586.16,
  tc_usd_origen: 'OFICIAL_DEL_DIA',
  tc_usd_nota:
    'T.C. oficial de referencia del día del ingreso (open.er-api, dato del 2026-09-04): el ingreso en pesos no traía tipo de cambio.',
};

/** Hoja vacía (0.0.77: con la bandera `usd_por_ingreso` SIEMPRE). */
const HOJA_VACIA = {
  filas: [],
  total_mxn: 0,
  usd: 0,
  usd_por_ingreso: true,
};

/** Socios del XB-TST (51 / 49 con la empresa) y del XB-DOS (70 / 30). */
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
const SOCIOS: Fila[] = [
  socio(AV, 'u-ang', '51.000', 'Angel Alvarez', false),
  socio(AV, 'u-acc', '49.000', 'Aero Charter Cancun', true),
  socio(AV2, 'u-mau', '70.000', 'Mauricio Roque', false),
  socio(AV2, 'u-acc', '30.000', 'Aero Charter Cancun', true),
];

/** El mundo de los libros + socios (+ un segundo avión SIN vuelos ni gastos). */
function mundo(ingresos: Fila[] = []): Record<string, Fila[]> {
  const m = mundoLibros(ingresos);
  return {
    ...m,
    aeronave: [
      ...m.aeronave,
      {
        ...m.aeronave[0],
        id: AV2,
        matricula: 'XB-DOS',
        color_calendario: '#10B981',
      },
    ],
    aeronave_socio: SOCIOS,
  };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  empresa: BalanceEmpresaBloquePayload;
};

type Privado = {
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
    memoTc?: Map<string, unknown>,
    memoFactura?: Map<string, unknown>,
    vigenciaComisiones?: string,
    ingresosPartidos?: IngresosDeResultadoPartidos,
  ) => Promise<BalanceAvionPayload>;
};

function servicio(m: Record<string, Fila[]>, tcOficial: number | null = null) {
  const f = fakeSupabase(m);
  const enviados: { individual?: BalanceAvionPayload; general?: General } = {};
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
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
    {
      oficialDetallePara: (dia: string) =>
        Promise.resolve(
          tcOficial == null
            ? null
            : { tc: tcOficial, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        ),
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados, tablas: f.tablasLeidas, supabase: f.supabase };
}

async function libro(
  m: Record<string, Fila[]>,
  avion: string = AV,
  tcOficial: number | null = null,
): Promise<BalanceAvionPayload> {
  const s = servicio(m, tcOficial);
  await s.service.xlsx(avion, DESDE, HASTA);
  return s.enviados.individual!;
}

async function general(
  m: Record<string, Fila[]>,
  tcOficial: number | null = null,
): Promise<{ g: General; tablas: string[] }> {
  const s = servicio(m, tcOficial);
  await s.service.xlsxGeneral(DESDE, HASTA);
  return { g: s.enviados.general!, tablas: s.tablas };
}

async function dinero(m: Record<string, Fila[]>): Promise<DineroXlsxPayload> {
  const f = fakeSupabase(m);
  return (
    new DineroReportService(
      f.supabase as unknown as SupabaseService,
      {} as never,
    ) as unknown as {
      buildPayload: (a: string, b: string) => Promise<DineroXlsxPayload>;
    }
  ).buildPayload(DESDE, HASTA);
}

/** Rutas (a.b.0.c) donde dos payloads difieren. */
function diferencias(a: unknown, b: unknown, ruta = ''): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...claves].flatMap((k) =>
      diferencias(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        ruta ? `${ruta}.${k}` : k,
      ),
    );
  }
  return [ruta];
}

const om = (g: General): BalanceHojaOtrosMovimientosPayload =>
  g.consolidado.otros_movimientos!;
const libroDe = (g: General, matricula: string) =>
  g.aviones.find((a) => a.matricula === matricula);

describe('Balance por avión — hoja «Otros ingresos» (invariante 67)', () => {
  it('(a) libro individual con ING_AVION: hoja de 1 fila EXACTA, 2,586.16 USD (oficial de SU día, no el promedio 20) que SUMAN en la cascada, en la cobrada y en los socios', async () => {
    const sin = await libro(mundo(), AV, 18);
    const con = await libro(mundo([ING_AVION]), AV, 18);
    // El libro promedia 20 (K del #501) pero el ingreso NO usa ese T.C.
    expect(con.totales.tc_promedio).toBe(20);
    expect(con.otros_ingresos_avion).toEqual({
      filas: [FILA_ING_AVION],
      total_mxn: 46550.8,
      usd: 2586.16,
      usd_por_ingreso: true,
    });
    expect(con.otros_ingresos_avion?.usd).toBe(r2(46550.8 / 18));
    expect(con.otros_ingresos_avion?.usd).not.toBe(r2(46550.8 / 20));
    expect(Object.keys(con.otros_ingresos_avion!).at(-1)).toBe(
      'usd_por_ingreso',
    );
    expect(Object.keys(con.otros_ingresos_avion!.filas[0]).slice(-4)).toEqual([
      'tc_usd',
      'neto_usd',
      'tc_usd_origen',
      'tc_usd_nota',
    ]);
    expect(con.balance.otros_ingresos_avion_usd).toBe(2586.16);
    expect(con.balance.utilidad_despues_usd).toBe(
      r2(sin.balance.utilidad_despues_usd! + 2586.16),
    );
    expect(con.balance.utilidad_cobrada_usd).toBe(
      r2(sin.balance.utilidad_cobrada_usd! + 2586.16),
    );
    expect(
      con.balance.socios.map((s) => [s.nombre, s.porcentaje, s.monto_usd]),
    ).toEqual([
      ['Angel Alvarez', 51, r2(0.51 * con.balance.utilidad_cobrada_usd!)],
      ['Aero Charter Cancun', 49, r2(0.49 * con.balance.utilidad_cobrada_usd!)],
    ]);
    // Llaves nuevas AL FINAL de su objeto.
    expect(Object.keys(con.balance).at(-1)).toBe('otros_ingresos_avion_usd');
    expect(Object.keys(con).at(-1)).toBe('otros_ingresos_avion');
    // La venta y todo lo de antes de la cascada, intactos.
    expect(con.balance.utilidad_antes_usd).toBe(sin.balance.utilidad_antes_usd);
  });

  it('(a′) con el ingreso, lo ÚNICO que cambia del libro es la hoja, su línea y lo que la cascada deriva', async () => {
    const sin = await libro(mundo(), AV, 18);
    const con = await libro(mundo([ING_AVION]), AV, 18);
    // Las dos hojas traen la bandera (no es una diferencia).
    expect(sin.otros_ingresos_avion?.usd_por_ingreso).toBe(true);
    expect(con.otros_ingresos_avion?.usd_por_ingreso).toBe(true);
    expect(diferencias(sin, con).sort()).toEqual(
      [
        'balance.otros_ingresos_avion_usd',
        'balance.socios.0.monto_usd',
        'balance.socios.1.monto_usd',
        'balance.utilidad_cobrada_usd',
        'balance.utilidad_despues_usd',
        'otros_ingresos_avion.filas.0',
        'otros_ingresos_avion.total_mxn',
        'otros_ingresos_avion.usd',
      ].sort(),
    );
  });

  it('(b) sin ingresos con avión: hoja vacía y línea en 0; los ingresos de VuelaTour NO tocan el libro del avión', async () => {
    const vacio = await libro(mundo());
    expect(vacio.otros_ingresos_avion).toEqual(HOJA_VACIA);
    expect(vacio.balance.otros_ingresos_avion_usd).toBe(0);
    const conVuelatour = await libro(mundo(INGRESOS_LIBROS));
    expect(diferencias(vacio, conVuelatour)).toEqual([]);
  });

  it('(c) NO entran a este libro: un ingreso del avión B ni un ANTICIPO con avión forzado', async () => {
    const ajenos: Fila[] = [
      { ...ING_AVION, id: 'i-b', folio: 20, aeronave_id: AV2 },
      {
        ...ING_AVION,
        id: 'i-ant',
        folio: 21,
        categoria: 'ANTICIPO_CLIENTE',
        cliente: { nombre: 'Leticia León Alvarado' },
      },
    ];
    const p = await libro(mundo(ajenos));
    expect(p.otros_ingresos_avion).toEqual(HOJA_VACIA);
    const b = await libro(mundo(ajenos), AV2, 18);
    expect(b.otros_ingresos_avion?.filas.map((f) => f.clave)).toEqual([
      'ING-20',
    ]);
  });

  it('(d) EXTERNOS: hoja vacía y NINGUNA lectura de `ingreso` (con la partición del general o sin ella)', async () => {
    const s = servicio(mundo([ING_AVION]));
    const priv = s.service as unknown as Privado;
    const partidos = partirIngresosPorAvion([]);
    const ext = await priv.buildPayload(
      null,
      DESDE,
      HASTA,
      new Map(),
      new Map(),
      undefined,
      partidos,
    );
    expect(ext.otros_ingresos_avion).toEqual(HOJA_VACIA);
    const ext2 = await priv.buildPayload(null, DESDE, HASTA);
    expect(ext2.otros_ingresos_avion).toEqual(HOJA_VACIA);
    expect(s.tablas).not.toContain('ingreso');
  });

  it('(e) avión SIN vuelos ni gastos con un ingreso MXN: SIN respaldo del cierre (0.0.77), el ingreso vale neto ÷ el oficial de SU día (18), utilidad numérica, sin pendiente del respaldo y bloque VUELATOUR con número', async () => {
    const ingDos: Fila = {
      ...ING_AVION,
      id: 'i-dos',
      folio: 30,
      aeronave_id: AV2,
      aeronave: { matricula: 'XB-DOS', color_calendario: '#10B981' },
    };
    const p = await libro(mundo([ingDos]), AV2, 18);
    expect(p.vuelos).toHaveLength(0);
    // Sin gastos no hay respaldo del cierre: el ingreso ya no lo necesita.
    expect(p.totales.tc_promedio).toBeNull();
    expect(p.otros_ingresos_avion?.usd).toBe(r2(46550.8 / 18));
    expect(p.otros_ingresos_avion?.filas[0]).toMatchObject({
      tc_usd: 18,
      neto_usd: 2586.16,
      tc_usd_origen: 'OFICIAL_DEL_DIA',
    });
    expect(p.balance.otros_ingresos_avion_usd).toBe(2586.16);
    expect(p.balance.utilidad_despues_usd).toBe(2586.16);
    expect(p.balance.utilidad_cobrada_usd).toBe(2586.16);
    expect(p.pendientes.join('\n')).not.toContain(
      'se convirtieron a USD con el T.C. oficial de referencia',
    );
    expect(p.pendientes.join('\n')).not.toContain('la pérdida de esos gastos');
    // En el general: el avión con solo el ingreso entra y la empresa (30 %)
    // recibe su parte: el bloque VUELATOUR tiene número.
    const { g } = await general(mundo([ingDos]), 18);
    const dos = libroDe(g, 'XB-DOS');
    expect(dos?.balance.otros_ingresos_avion_usd).toBe(2586.16);
    const part = g.empresa.participaciones.find(
      (x) => x.matricula === 'XB-DOS',
    );
    expect(part?.monto_usd).toBe(r2(0.3 * 2586.16));
    expect(g.empresa.participacion_usd).not.toBeNull();
    expect(g.empresa.resultado_usd).not.toBeNull();
  });

  it('(e′) sin ingresos ni gastos el pendiente del respaldo es el de siempre (byte a byte)', async () => {
    const gastoDos: Fila = {
      ...mundoLibros().gasto[1],
      id: 'g-gas-dos',
      aeronave_id: AV2,
    };
    const m = mundo();
    const p = await libro({ ...m, gasto: [...m.gasto, gastoDos] }, AV2, 18);
    expect(p.pendientes).toContain(
      'Avión XB-DOS: sin vuelos en el periodo — sus hojas de gastos se convirtieron a USD con el T.C. oficial de referencia del 2026-09-30 (18.0000, open.er-api); la utilidad del periodo es la pérdida de esos gastos',
    );
  });

  it('(e″) avión sin vuelos CON gastos E ingreso: las hojas de gastos con el oficial del cierre, el ingreso con el de SU día y el pendiente nuevo (literal)', async () => {
    const gastoDos: Fila = {
      ...mundoLibros().gasto[1],
      id: 'g-gas-dos',
      aeronave_id: AV2,
    };
    const ingDos: Fila = {
      ...ING_AVION,
      id: 'i-dos',
      folio: 30,
      aeronave_id: AV2,
      aeronave: { matricula: 'XB-DOS', color_calendario: '#10B981' },
    };
    const m = mundo([ingDos]);
    const p = await libro({ ...m, gasto: [...m.gasto, gastoDos] }, AV2, 18);
    expect(p.vuelos).toHaveLength(0);
    expect(p.totales.tc_promedio).toBe(18);
    expect(p.otros_ingresos_avion?.usd).toBe(2586.16);
    expect(p.pendientes).toContain(
      'Avión XB-DOS: sin vuelos en el periodo — sus hojas de gastos se convirtieron a USD con el T.C. oficial de referencia del 2026-09-30 (18.0000, open.er-api) y cada uno de sus otros ingresos con su T.C. propio o el oficial de su día; la utilidad del periodo es el resultado de esos movimientos',
    );
    expect(p.pendientes.join('\n')).not.toContain('la pérdida de esos gastos');
  });
});

describe('Balance GENERAL — otros ingresos asignados a aviones (invariante 67)', () => {
  it('(f) UNA lectura de `ingreso`; el ingreso con avión sale de las sueltas y entra a su libro, al consolidado y a la bandera', async () => {
    const { g, tablas } = await general(
      mundo([...INGRESOS_LIBROS, ING_AVION]),
      18,
    );
    expect(tablas.filter((t) => t === 'ingreso')).toHaveLength(1);
    // Sueltas: ING-12 e ING-13 (VuelaTour) como siempre; ING-14 (avión) NO.
    const sueltasIng = om(g)
      .filas_sueltas.filter((f) => f.clave.startsWith('ING-'))
      .map((f) => f.clave);
    expect(sueltasIng).toEqual(['ING-12', 'ING-13']);
    expect(om(g).otros_ingresos_por_avion).toBe(true);
    expect(Object.keys(om(g)).at(-1)).toBe('otros_ingresos_por_avion');
    // Libro del avión dentro del general.
    const tst = libroDe(g, 'XB-TST')!;
    expect(tst.otros_ingresos_avion?.filas).toEqual([FILA_ING_AVION]);
    expect(tst.balance.otros_ingresos_avion_usd).toBe(2586.16);
    // Hoja consolidada: «MATRÍCULA · », color y matrícula; ÚLTIMA llave.
    expect(g.consolidado.otros_ingresos_avion).toEqual({
      filas: [
        {
          ...FILA_ING_AVION,
          detalle:
            'XB-TST · ING-14 · TRANSF INTERBANCARIA SPEI · angel alvarez',
          matricula: 'XB-TST',
          avion_color: '#3B82F6',
        },
      ],
      total_mxn: 46550.8,
      usd: 2586.16,
      usd_por_ingreso: true,
    });
    expect(Object.keys(g.consolidado).at(-1)).toBe('otros_ingresos_avion');
    // El bloque de «balance» del general es el MISMO que el libro individual.
    const ind = await libro(mundo([...INGRESOS_LIBROS, ING_AVION]), AV, 18);
    expect(tst.balance).toEqual(ind.balance);
  });

  it('(f′) sin ingresos con avión el consolidado NO trae la llave (la bandera sí, siempre)', async () => {
    const { g } = await general(mundo(INGRESOS_LIBROS));
    expect('otros_ingresos_avion' in g.consolidado).toBe(false);
    expect(om(g).otros_ingresos_por_avion).toBe(true);
    for (const a of g.aviones) {
      expect(a.otros_ingresos_avion).toEqual(HOJA_VACIA);
    }
  });

  it('(f″) bloque VUELATOUR: INGRESOS PROPIOS sin el ingreso del avión; la participación de la empresa sube SU % de lo que sube el avión', async () => {
    const { g: sin } = await general(mundo(INGRESOS_LIBROS), 18);
    const { g: con } = await general(
      mundo([...INGRESOS_LIBROS, ING_AVION]),
      18,
    );
    // Antes del 0.0.75 el mismo ingreso era una suelta de VuelaTour:
    const { g: comoVuelatour } = await general(
      mundo([
        ...INGRESOS_LIBROS,
        { ...ING_AVION, aeronave_id: null, aeronave: null },
      ]),
      18,
    );
    expect(con.empresa.ingresos_propios_usd).toBe(
      sin.empresa.ingresos_propios_usd,
    );
    expect(comoVuelatour.empresa.ingresos_propios_usd!).toBeGreaterThan(
      sin.empresa.ingresos_propios_usd!,
    );
    const cobrada = (g: General) =>
      libroDe(g, 'XB-TST')!.balance.utilidad_cobrada_usd!;
    expect(r2(cobrada(con) - cobrada(sin))).toBe(2586.16);
    const empresa = (g: General) =>
      g.empresa.participaciones.find((x) => x.matricula === 'XB-TST')!
        .monto_usd!;
    expect(empresa(con)).toBe(r2(0.49 * cobrada(con)));
    expect(
      Math.abs(r2(empresa(con) - empresa(sin)) - 0.49 * 2586.16),
    ).toBeLessThanOrEqual(0.01);
  });

  it('(g) CRUCE «nunca dos veces»: Σ remanente ING del Libro Dinero (las dos listas) == Σ sueltas ING del general + Σ hojas de los aviones', async () => {
    const m = mundo([...INGRESOS_LIBROS, ING_AVION]);
    const d = await dinero(m);
    const { g } = await general(m);
    const suma = (filas: Array<{ remanente_mxn?: number | null }>) =>
      r2(filas.reduce((a, f) => a + (f.remanente_mxn ?? 0), 0));
    const dineroIng = r2(
      suma(d.otros_ingresos.filter((f) => f.clave.startsWith('ING-'))) +
        suma(d.otros_ingresos_avion ?? []),
    );
    const generalIng = r2(
      suma(om(g).filas_sueltas.filter((f) => f.clave.startsWith('ING-'))) +
        g.aviones.reduce(
          (a, p) => a + (p.otros_ingresos_avion?.total_mxn ?? 0),
          0,
        ),
    );
    expect(dineroIng).toBe(generalIng);
    expect(dineroIng).toBe(r2(4950 + 1850 + 46550.8));
    // Y el ingreso del avión está UNA vez en cada libro.
    expect(
      d.otros_ingresos.filter((f) => f.clave === 'ING-14').length +
        (d.otros_ingresos_avion ?? []).filter((f) => f.clave === 'ING-14')
          .length,
    ).toBe(1);
  });
});
