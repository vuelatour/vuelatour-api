import {
  COLUMNAS_ANTICIPOS,
  COLUMNAS_COBROS,
  COLUMNAS_INGRESOS,
  COLUMNAS_RESUMEN,
  ddmmaaaa,
  filaExcelCobro,
  filaExcelIngreso,
  nombreArchivoIngresos,
  payloadExcelIngresos,
} from './ingresos-xlsx';
import type {
  EntradaDinero,
  Ingreso,
  ResumenIngresos,
  ResumenIngresosMoneda,
} from './ingresos.types';

/**
 * Excel de INGRESOS (contrato §5.2): 4 hojas, montos nominales por moneda,
 * fechas dd/mm/aaaa y lo sin conciliar en naranja.
 */
const ingreso = (extra: Partial<Ingreso> = {}): Ingreso => ({
  id: 'i-1',
  folio: 12,
  etiqueta: 'ING-12',
  categoria: 'OTRO_INGRESO',
  categoria_etiqueta: 'Otros ingresos',
  suma_a_resultados: true,
  fecha: '2026-09-10',
  descripcion: 'Renta de hangar',
  monto: 5000,
  comision_monto: 50,
  neto: 4950,
  moneda: 'MXN',
  tc_usd_mxn: null,
  metodo: 'TRANSFERENCIA',
  metodo_etiqueta: 'Transferencia',
  cuenta_bancaria_id: 'cta',
  cuenta: {
    id: 'cta',
    alias: 'Scotia MXN',
    banco: 'Scotiabank',
    moneda: 'MXN',
    tipo: 'BANCO',
  },
  referencia: null,
  pagador: 'Aeroclub',
  cliente_id: null,
  cliente_nombre: null,
  vuelo_id: null,
  vuelo_folio: null,
  aeronave_id: null,
  matricula: null,
  gasto_id: null,
  notas: null,
  archivo: null,
  conciliacion: {
    estado: 'SIN_CONCILIAR',
    movimiento_id: null,
    movimiento_fecha: null,
    movimiento_monto: null,
  },
  anticipo: null,
  registrado_por_nombre: 'Mary Cruz',
  created_at: '2026-09-10T12:00:00Z',
  updated_at: '2026-09-10T12:00:00Z',
  baja: null,
  ...extra,
});

const cobro = (extra: Partial<EntradaDinero> = {}): EntradaDinero => ({
  origen: 'COBRO_VUELO',
  id: 'c-1',
  dia: '2026-09-11',
  etiqueta: 'Vuelo #312',
  categoria: 'COBRO_VUELO',
  categoria_etiqueta: 'Cobro de vuelo',
  cliente_nombre: 'Cristy Chavez',
  concepto: null,
  monto: 20400,
  comision: 1020,
  neto: 19380,
  moneda: 'MXN',
  metodo: 'TRANSFERENCIA',
  metodo_etiqueta: 'Transferencia',
  vuelo_id: 'v',
  vuelo_folio: 312,
  grupo_folio: null,
  vuelo_estado: 'COMPLETADO',
  por_volar: false,
  anticipo_etiqueta: null,
  cuenta_en_total: true,
  es_reembolso: false,
  conciliacion: { estado: 'CONCILIADO', movimiento_id: 'm' },
  registrado_por_nombre: 'Itzi',
  ...extra,
});

const moneda = (m: 'MXN' | 'USD'): ResumenIngresosMoneda => ({
  moneda: m,
  cobros_vuelo: {
    recibido: 100,
    reembolsos: 0,
    n: 1,
    conciliado: 100,
    sin_conciliar: 0,
    no_bancario: 0,
  },
  depositos_por_volar: { monto: 0, n: 0 },
  aplicado_de_anticipos: { monto: 0, n: 0 },
  otros_ingresos: {
    monto: 5000,
    n: 1,
    conciliado: 0,
    sin_conciliar: 5000,
    no_bancario: 0,
  },
  anticipos: {
    recibido: 0,
    aplicado: 0,
    saldo: 0,
    n: 0,
    conciliado: 0,
    sin_conciliar: 0,
    no_bancario: 0,
  },
  fuera_de_resultados: { monto: 0, n: 0 },
  total_recibido: 5100,
  neto_de_reembolsos: 5100,
  abonos_por_identificar: { n: 2, monto: 700 },
});

describe('ingresos-xlsx', () => {
  it('fechas dd/mm/aaaa y nombre del archivo', () => {
    expect(ddmmaaaa('2026-09-10')).toBe('10/09/2026');
    expect(ddmmaaaa('2026-09-10T12:00:00Z')).toBe('10/09/2026');
    expect(ddmmaaaa(null)).toBe('');
    expect(nombreArchivoIngresos('2026-09-01', '2026-09-30')).toBe(
      'Ingresos 2026-09-01 a 2026-09-30.xlsx',
    );
  });

  it('fila de un ingreso: destino, cuenta, conciliación y vuelo', () => {
    const f = filaExcelIngreso(
      ingreso({ vuelo_folio: 312, matricula: 'XA-VGV' }),
    );
    expect(f).toHaveLength(COLUMNAS_INGRESOS.length);
    expect(f).toEqual([
      'ING-12',
      '10/09/2026',
      'Otros ingresos',
      'Otros ingresos (Balance general VuelaTour y Libro Dinero)',
      'Renta de hangar',
      'Aeroclub',
      'Scotia MXN · Scotiabank',
      'Transferencia',
      'MXN',
      5000,
      50,
      4950,
      null,
      'Sin conciliar',
      '#312',
      'XA-VGV',
      'Mary Cruz',
      '',
    ]);
    expect(
      filaExcelIngreso(ingreso({ cuenta: null, cuenta_bancaria_id: null }))[6],
    ).toBe('Efectivo / caja');
  });

  it('fila de un cobro: reembolso en negativo y anticipo', () => {
    const f = filaExcelCobro(
      cobro({
        monto: -300,
        neto: -300,
        comision: null,
        es_reembolso: true,
        anticipo_etiqueta: 'ING-7',
        conciliacion: { estado: 'VIA_ANTICIPO', movimiento_id: 'm' },
      }),
    );
    expect(f).toHaveLength(COLUMNAS_COBROS.length);
    expect(f.slice(4, 10)).toEqual([
      'MXN',
      -300,
      null,
      -300,
      'Conciliado vía anticipo',
      'ING-7',
    ]);
  });

  it('4 hojas; Resumen una fila por moneda (jamás se suman); naranja lo SIN conciliar', () => {
    const resumen: ResumenIngresos = {
      desde: '2026-09-01',
      hasta: '2026-09-30',
      por_moneda: [moneda('MXN'), moneda('USD')],
      anticipos_con_saldo: [],
    };
    const p = payloadExcelIngresos({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      resumen,
      ingresos: [
        ingreso(),
        ingreso({
          id: 'i-2',
          conciliacion: {
            estado: 'CONCILIADO',
            movimiento_id: 'm',
            movimiento_fecha: null,
            movimiento_monto: null,
          },
        }),
      ],
      cobros: [
        cobro(),
        cobro({
          id: 'c-2',
          conciliacion: { estado: 'SIN_CONCILIAR', movimiento_id: null },
        }),
      ],
      anticipos: [
        ingreso({
          id: 'ant',
          etiqueta: 'ING-7',
          categoria: 'ANTICIPO_CLIENTE',
          monto: 1000,
          anticipo: { aplicado: 600, saldo: 400, aplicaciones_n: 1 },
          cliente_nombre: 'Cristy Chavez',
        }),
      ],
      vuelosPorAnticipo: new Map([['ant', [312]]]),
    });
    expect(p.hojas?.map((h) => h.titulo)).toEqual([
      'Resumen',
      'Ingresos',
      'Cobros de vuelos',
      'Anticipos',
    ]);
    const [res, ing, cob, ant] = p.hojas!;
    expect(res.columnas).toBe(COLUMNAS_RESUMEN);
    expect(res.filas.map((f) => f[0])).toEqual(['MXN', 'USD']);
    expect(res.filas[0]).toHaveLength(COLUMNAS_RESUMEN.length);
    expect(ing.resaltes).toEqual([{ fila: 0, col: 9 }]);
    expect(cob.resaltes).toEqual([{ fila: 1, col: 5 }]);
    expect(ant.columnas).toBe(COLUMNAS_ANTICIPOS);
    expect(ant.filas).toEqual([
      ['ING-7', '10/09/2026', 'Cristy Chavez', 'MXN', 1000, 600, 400, '#312'],
    ]);
    expect(res.subtitulo).toMatch(/no es utilidad/);
  });
});
