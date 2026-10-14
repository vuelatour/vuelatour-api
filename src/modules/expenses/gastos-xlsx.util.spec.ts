import {
  aCargoDeGasto,
  ordenarCargosDeGasto,
  type CargoDeGastoDetalle,
  type CargosDeGastoLeidos,
} from '../conciliacion/cargos-de-gasto.util';
import { lineaNotaCargo } from '../../common/vinculo-no-bancario.util';
import {
  COLUMNAS_BANCO_PRINCIPAL,
  COLUMNAS_HOJA_CARGOS_BANCO,
  conceptoDeGasto,
  etiquetaCargoReporte,
  etiquetaCargosGastoReporte,
  etiquetaEstadoCuentaCargo,
  etiquetaEstadosCuentaReporte,
  filasHojaCargosBanco,
  notaTruncadoXlsx,
  PAGINA_XLSX_GASTOS,
  subtituloHojaCargosBanco,
  TEXTO_CONCILIADO_SIN_CARGO,
  TITULO_HOJA_CARGOS_BANCO,
  TOPE_XLSX_GASTOS,
} from './gastos-xlsx.util';

/**
 * EXCEL DE GASTOS con el detalle del banco (13-oct-2026, invariante 71):
 * etiquetas EXACTAS con los datos REALES de prod del 13-oct (#345 SAESA,
 * #201 EJE SCOTIA con 0.02, #269 con dos cargos, el cruzado 913a7d19, el
 * sin archivo 20abe352 del 16-jul y Paywise).
 */
type Row = Record<string, unknown>;

const GNRAL = {
  id: '76a931e0-7c06-47c6-a574-6c7d4a698c14',
  alias: 'GASTOS GNRAL',
  banco: 'Scotiabank',
  moneda: 'MXN',
  tipo: 'BANCO',
};
const EJE = {
  id: '212add6c-c4e5-44cc-a30c-0635c0ab3036',
  alias: 'EJE SCOTIA',
  banco: 'Scotiabank',
  moneda: 'MXN',
  tipo: 'BANCO',
};
const PAYWISE = {
  id: 'cta-paywise',
  alias: 'Paywise',
  banco: 'Paywise',
  moneda: 'MXN',
  tipo: 'PASARELA',
};
const archivo = (filename: string, created_at: string) => ({
  id: `ec-${filename}`,
  filename,
  formato: 'pdf',
  movimientos_importados: 90,
  created_at,
  importo: { nombre: 'Alejandro Canales' },
});

function cargo(args: {
  mov: Row;
  monto_parte: number;
  gasto: { id: string; moneda: string };
  created_at?: string | null;
  ligada_por?: string | null;
  moneda_parte?: string;
}): CargoDeGastoDetalle {
  return aCargoDeGasto({
    parte: {
      movimiento_id: args.mov.id as string,
      monto_parte: args.monto_parte,
      moneda: args.moneda_parte ?? 'MXN',
      created_at: args.created_at ?? '2026-10-02T00:00:00Z',
      ligada_por: args.ligada_por ?? null,
    },
    mov: args.mov,
    gasto: args.gasto,
  });
}

const G345 = { id: '4e29c476-a956-440f-bd83-2c70f78279d4', moneda: 'MXN' };
const SAESA = cargo({
  mov: {
    id: '73a8d809-6468-4554-add4-f874a0c4ed9c',
    fecha: '2026-09-30',
    tipo: 'CARGO',
    monto: -11205.6,
    descripcion: 'SEL TRANSF. INTERBANCARIA SPEI',
    referencia: '00000000000000000001',
    conciliado: true,
    origen: 'IMPORTADO',
    created_at: '2026-10-06T15:22:46.58996+00:00',
    estado_cuenta_id: 'ec-eje',
    cuenta: EJE,
    estado_cuenta: archivo(
      'scotia eje sep.pdf',
      '2026-10-06T15:22:46.413405+00:00',
    ),
    gastos_n: 4,
    gastos: [],
    gastos_suma: 11205.6,
    gastos_diferencia: 0,
  },
  monto_parte: 2801.4,
  gasto: G345,
  created_at: '2026-10-13T21:43:29.382119+00:00',
  ligada_por: 'Diego Ramírez',
});

const G201 = { id: '92bd5379-66de-4536-b3be-d25d2096a8db', moneda: 'MXN' };
const EJE_6694 = cargo({
  mov: {
    id: '165c7783-f5df-44e3-899b-d1af4713cfd4',
    fecha: '2026-09-07',
    tipo: 'CARGO',
    monto: -6694.13,
    conciliado: true,
    origen: 'IMPORTADO',
    estado_cuenta_id: 'ec-eje-ago',
    cuenta: EJE,
    estado_cuenta: archivo('scotia eje ago.pdf', '2026-09-08T17:00:00Z'),
    gastos_n: 3,
    gastos: [],
    gastos_suma: 6694.11,
    gastos_diferencia: 0.02,
  },
  monto_parte: 2231.37,
  gasto: G201,
  created_at: '2026-10-13T18:00:00Z',
  ligada_por: 'Alejandro Canales',
});

const G269 = { id: '0e8ead24-46c8-4b47-a128-64a2ad493321', moneda: 'MXN' };
const ASUR = (id: string, monto: number) =>
  cargo({
    mov: {
      id,
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: -monto,
      descripcion: 'ASUR CANCUN',
      conciliado: true,
      origen: 'IMPORTADO',
      estado_cuenta_id: 'ec-5',
      cuenta: GNRAL,
      estado_cuenta: archivo('scotia gastos (5).pdf', '2026-09-08T17:00:00Z'),
      gastos_n: 1,
    },
    monto_parte: monto,
    gasto: G269,
    created_at: '2026-10-05T16:00:00Z',
    ligada_por: 'Jimmy Chi',
  });

const G_USD = { id: '913a7d19-6a35-42c8-8494-65597d07f300', moneda: 'USD' };
const SPRUCE = cargo({
  mov: {
    id: 'bf543597-31f2-4624-bec9-a28e362d4825',
    fecha: '2026-08-07',
    tipo: 'CARGO',
    monto: -12451.49,
    descripcion: 'AIRCRAFT SPRUCE AND SP',
    conciliado: true,
    origen: 'IMPORTADO',
    estado_cuenta_id: 'ec-3',
    cuenta: GNRAL,
    estado_cuenta: archivo('scotia gastos (3).pdf', '2026-08-18T17:00:00Z'),
    gastos_n: 1,
  },
  monto_parte: 12451.49,
  gasto: G_USD,
});

const G6 = { id: '20abe352-c924-4e9a-8769-b965a6d63ec6', moneda: 'MXN' };
const COZUMEL = cargo({
  mov: {
    id: '3013be8a-72bb-4de4-ab8e-e106b563a42e',
    fecha: '2026-07-01',
    tipo: 'CARGO',
    monto: -317.39,
    descripcion: 'Aeropuerto de Cozumel',
    conciliado: true,
    origen: 'IMPORTADO',
    created_at: '2026-07-17T00:34:09.441Z',
    estado_cuenta_id: null,
    estado_cuenta: null,
    creo: { nombre: 'Jimmy Chi' },
    cuenta: GNRAL,
    gastos_n: 1,
  },
  monto_parte: 317.39,
  gasto: G6,
});

const G_PW = { id: 'cdfbf491-e326-43b7-b182-b7a05f81ed76', moneda: 'MXN' };
const PAGO_PW = cargo({
  mov: {
    id: '4f79c20b-0000-4000-8000-000000000001',
    fecha: '2026-09-30',
    tipo: 'CARGO',
    monto: -7500,
    descripcion: 'itzy 2da sep',
    conciliado: true,
    origen: 'IMPORTADO',
    estado_cuenta_id: 'ec-pw',
    cuenta: PAYWISE,
    estado_cuenta: archivo(
      'Reporte de Movimientos paywise Septiembre-2026.pdf',
      '2026-10-06T16:00:00Z',
    ),
    gastos_n: 1,
  },
  monto_parte: 7500,
  gasto: G_PW,
});

describe('paginado y concepto', () => {
  it('página 1000 y tope 20,000', () => {
    expect(PAGINA_XLSX_GASTOS).toBe(1000);
    expect(TOPE_XLSX_GASTOS).toBe(20000);
  });

  it('notaTruncadoXlsx: con corte, sin corte y sin gastos', () => {
    expect(notaTruncadoXlsx(20000, 25310)).toBe(
      ' · OJO: se exportaron 20,000 de 25,310 gastos (tope del Excel); acota los filtros',
    );
    expect(notaTruncadoXlsx(1112, 1112)).toBe('');
    expect(notaTruncadoXlsx(0, 0)).toBe('');
  });

  it('conceptoDeGasto = la columna «Concepto» de siempre', () => {
    // La expresión que vivía dentro de listXlsx.
    const deHoy = (x: Row) => {
      const notas = ((x.notas as string | null) ?? '').split('\n')[0].trim();
      const lugar = ((x.lugar as string | null) ?? '').trim();
      return notas || lugar;
    };
    for (const x of [
      { notas: '  Pago VIP SAESA \nvuelo #345', lugar: 'CUN' },
      { notas: 'Primera\r\nsegunda', lugar: null },
      { notas: '', lugar: '  Aeropuerto de Cozumel ' },
      { notas: null, lugar: null },
      { notas: '\nsolo la segunda', lugar: 'MID' },
    ] as Row[]) {
      expect(conceptoDeGasto(x)).toBe(deHoy(x));
    }
    expect(conceptoDeGasto({ notas: 'Pago VIP SAESA\nvuelo #345' })).toBe(
      'Pago VIP SAESA',
    );
    expect(conceptoDeGasto({ notas: '', lugar: 'Cozumel' })).toBe('Cozumel');
  });
});

describe('etiquetas de la pestaña principal (datos reales)', () => {
  it('#345 (lote SAESA)', () => {
    expect(etiquetaCargoReporte(SAESA, null)).toBe(
      '30-sep-2026 · EJE SCOTIA · $11,205.60 (paga 4 gastos; a este $2,801.40)',
    );
    expect(etiquetaEstadosCuentaReporte([SAESA])).toBe(
      'scotia eje sep.pdf (importado 06-oct-2026)',
    );
  });

  it('#201 (EJE SCOTIA de 6,694.13 que paga 3)', () => {
    expect(etiquetaCargoReporte(EJE_6694, null)).toBe(
      '07-sep-2026 · EJE SCOTIA · $6,694.13 (paga 3 gastos; a este $2,231.37)',
    );
  });

  it('#269: dos cargos, por fecha e id, y UN estado de cuenta', () => {
    const cargos = ordenarCargosDeGasto([
      ASUR('d7259736-0000-4000-8000-000000000000', 121.91),
      ASUR('5f7ce959-0000-4000-8000-000000000000', 15.08),
    ]);
    expect(
      etiquetaCargosGastoReporte({
        estado: 'CONCILIADO',
        cargos,
        monto: 136.99,
        moneda: 'MXN',
        faltante: 0,
        tcGasto: null,
      }),
    ).toBe(
      '07-sep-2026 · GASTOS GNRAL · $15.08 | 07-sep-2026 · GASTOS GNRAL · $121.91',
    );
    expect(etiquetaEstadosCuentaReporte(cargos)).toBe(
      'scotia gastos (5).pdf (importado 08-sep-2026)',
    );
  });

  it('cruzado 913a7d19: el T.C. GUARDADO; sin él, «sin registrar»', () => {
    expect(etiquetaCargoReporte(SPRUCE, 17.2244)).toBe(
      '07-ago-2026 · GASTOS GNRAL · $12,451.49 (T.C. 17.2244)',
    );
    expect(etiquetaCargoReporte(SPRUCE, null)).toBe(
      '07-ago-2026 · GASTOS GNRAL · $12,451.49 (T.C. sin registrar)',
    );
    expect(etiquetaEstadoCuentaCargo(SPRUCE)).toBe(
      'scotia gastos (3).pdf (importado 18-ago-2026)',
    );
  });

  it('sin archivo (20abe352): el DÍA CANCÚN del alta, 16-jul (en UTC ya es 17)', () => {
    expect(etiquetaCargoReporte(COZUMEL, null)).toBe(
      '01-jul-2026 · GASTOS GNRAL · $317.39',
    );
    expect(etiquetaEstadoCuentaCargo(COZUMEL)).toBe(
      'Sin archivo (importado el 16-jul-2026)',
    );
    expect(
      etiquetaEstadoCuentaCargo({
        ...COZUMEL,
        sin_archivo: 'CAPTURA_MANUAL',
      }),
    ).toBe('Sin archivo (capturado a mano)');
    expect(etiquetaEstadoCuentaCargo({ ...COZUMEL, sin_archivo: null })).toBe(
      '',
    );
  });

  it('Paywise', () => {
    expect(etiquetaCargoReporte(PAGO_PW, null)).toBe(
      '30-sep-2026 · Paywise · $7,500.00',
    );
    expect(etiquetaEstadosCuentaReporte([PAGO_PW])).toBe(
      'Reporte de Movimientos paywise Septiembre-2026.pdf (importado 06-oct-2026)',
    );
  });

  it('PARCIAL ⇒ « · faltan $X de $Y»; conciliado sin cargos; sin conciliar vacío', () => {
    expect(
      etiquetaCargosGastoReporte({
        estado: 'PARCIAL',
        cargos: [
          {
            ...PAGO_PW,
            monto: 1200,
            parte: { ...PAGO_PW.parte, monto_parte: 1200 },
          },
        ],
        monto: 1800,
        moneda: 'MXN',
        faltante: 600,
        tcGasto: null,
      }),
    ).toBe('30-sep-2026 · Paywise · $1,200.00 · faltan $600.00 de $1,800.00');
    expect(
      etiquetaCargosGastoReporte({
        estado: 'CONCILIADO',
        cargos: [],
        monto: 100,
        moneda: 'MXN',
        faltante: 0,
        tcGasto: null,
      }),
    ).toBe(TEXTO_CONCILIADO_SIN_CARGO);
    expect(TEXTO_CONCILIADO_SIN_CARGO).toBe(
      'Marcado como conciliado, sin cargo ligado',
    );
    expect(
      etiquetaCargosGastoReporte({
        estado: 'SIN_CONCILIAR',
        cargos: [],
        monto: 100,
        moneda: 'MXN',
        faltante: 100,
        tcGasto: null,
      }),
    ).toBe('');
  });

  it('ligado con justificación', () => {
    const linea = lineaNotaCargo(
      {
        id: G269.id,
        fecha_gasto: '2026-09-28',
        monto: 212,
        moneda: 'MXN',
        medio_pago: 'EFECTIVO',
        categoria: 'TAXI',
        vuelo_folio: 330,
      },
      {
        justificacion: 'Mari lo facturó',
        usuario: 'Mary Cruz',
        hoy: '2026-10-06',
      },
    );
    const conRazon = cargo({
      mov: {
        id: 'm212',
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: -212,
        notas: linea,
        cuenta: GNRAL,
        gastos_n: 1,
      },
      monto_parte: 212,
      gasto: G269,
    });
    expect(etiquetaCargoReporte(conRazon, null)).toBe(
      '07-sep-2026 · GASTOS GNRAL · $212.00 (ligado con justificación)',
    );
  });

  it('las 3 columnas nuevas, de texto', () => {
    expect(COLUMNAS_BANCO_PRINCIPAL).toEqual([
      { label: 'Factura' },
      { label: 'Cargo del banco' },
      { label: 'Estado de cuenta' },
    ]);
  });
});

describe('pestaña «Cargos del banco»', () => {
  const leidos = (
    cargos: CargoDeGastoDetalle[],
    fuente: CargosDeGastoLeidos['fuente'] = 'PUENTE',
  ): CargosDeGastoLeidos => ({ fuente, vista: null, cargos });
  const fila345: Row = {
    id: G345.id,
    fecha_gasto: '2026-09-28',
    categoria: 'OPERACIONES',
    notas: 'Pago VIP SAESA\nvuelo #345',
    lugar: null,
    monto: '2801.40',
    moneda: 'MXN',
    tc_gasto: null,
    vuelo: { folio: 345 },
  };

  it('22 columnas en el orden del contrato; «T.C. del gasto» es texto', () => {
    expect(COLUMNAS_HOJA_CARGOS_BANCO.map((c) => c.label)).toEqual([
      'Fecha gasto',
      'Categoría',
      'Vuelo',
      'Concepto',
      'Factura',
      'Monto del gasto',
      'Moneda del gasto',
      'Banco',
      'Fecha del cargo',
      'Cuenta',
      'Leyenda del banco',
      'Referencia',
      'Monto del cargo',
      'Moneda del cargo',
      'Aplicado a este gasto',
      'Gastos que paga el cargo',
      'Diferencia del lote',
      'T.C. del gasto',
      'Estado de cuenta',
      'Línea del archivo',
      'Registró la liga',
      'Justificación',
    ]);
    const tipo = (l: string) =>
      COLUMNAS_HOJA_CARGOS_BANCO.find((c) => c.label === l)?.tipo;
    expect(tipo('T.C. del gasto')).toBeUndefined();
    expect(tipo('Aplicado a este gasto')).toBe('money');
    expect(tipo('Gastos que paga el cargo')).toBe('entero');
    expect(TITULO_HOJA_CARGOS_BANCO).toBe('Cargos del banco');
  });

  it('el lote SAESA: el cargo completo y lo aplicado a ESTE gasto; quién registró la liga', () => {
    const r = filasHojaCargosBanco({
      fila: fila345,
      leidos: leidos([SAESA]),
      etiquetaBanco: 'Conciliado',
      folio: 'A-0411',
    });
    expect(r.filas).toEqual([
      [
        '2026-09-28',
        'Operaciones',
        '#345',
        'Pago VIP SAESA',
        'A-0411',
        2801.4,
        'MXN',
        'Conciliado',
        '2026-09-30',
        'EJE SCOTIA',
        'SEL TRANSF. INTERBANCARIA SPEI',
        '00000000000000000001',
        11205.6,
        'MXN',
        2801.4,
        4,
        0,
        '',
        'scotia eje sep.pdf (importado 06-oct-2026)',
        null,
        'Diego Ramírez · 13-oct-2026',
        '',
      ],
    ]);
    // Diferencia 0 ⇒ sin resalte.
    expect(r.resaltes).toEqual([]);
  });

  it('la diferencia 0.02 de #201 sale resaltada en «Diferencia del lote»', () => {
    const r = filasHojaCargosBanco({
      fila: { ...fila345, id: G201.id, vuelo: { folio: 201 } },
      leidos: leidos([EJE_6694]),
      etiquetaBanco: 'Conciliado',
      folio: null,
    });
    const col = COLUMNAS_HOJA_CARGOS_BANCO.findIndex(
      (c) => c.label === 'Diferencia del lote',
    );
    expect(r.filas[0][col]).toBe(0.02);
    expect(r.resaltes).toEqual([{ fila: 0, col }]);
    expect(r.filas[0][4]).toBe('');
  });

  it('cruzado: T.C. como TEXTO; la liga del backfill dice «(anterior al 02-oct-2026)»; pasarela', () => {
    const r = filasHojaCargosBanco({
      fila: {
        ...fila345,
        id: G_USD.id,
        moneda: 'USD',
        tc_gasto: '17.224400',
        monto: 722.9,
        vuelo: null,
      },
      leidos: leidos([SPRUCE]),
      etiquetaBanco: 'Conciliado',
      folio: '',
    });
    const fila = r.filas[0];
    expect(fila[2]).toBe('');
    expect(
      fila[
        COLUMNAS_HOJA_CARGOS_BANCO.findIndex(
          (c) => c.label === 'T.C. del gasto',
        )
      ],
    ).toBe('17.2244');
    expect(fila[20]).toBe('(anterior al 02-oct-2026)');
    const pw = filasHojaCargosBanco({
      fila: fila345,
      leidos: leidos([PAGO_PW], 'ESPEJO'),
      etiquetaBanco: 'Conciliado',
      folio: '',
    });
    expect(pw.filas[0][9]).toBe('Paywise (pasarela)');
    // En el espejo no hay registro que decir.
    expect(pw.filas[0][20]).toBe('');
  });

  it('un gasto sin cargos no aparece', () => {
    expect(
      filasHojaCargosBanco({
        fila: fila345,
        leidos: leidos([]),
        etiquetaBanco: 'Sin conciliar',
        folio: '',
      }),
    ).toEqual({ filas: [], resaltes: [] });
  });

  it('subtítulos con y sin pares', () => {
    expect(subtituloHojaCargosBanco(' · 2026-09-01 a 2026-09-30', true)).toBe(
      'Una fila por gasto y cargo del banco. Suma la columna «Aplicado a este gasto»: el monto del cargo y la diferencia de un cargo que paga varios gastos se repiten en cada uno. · 2026-09-01 a 2026-09-30',
    );
    expect(subtituloHojaCargosBanco('', false)).toBe(
      'Ningún gasto de este filtro tiene cargos del banco ligados.',
    );
  });
});
