import {
  COLUMNAS_EXCEL_FACTURAS,
  ddmmaaaa,
  payloadExcelFacturas,
  textoFiltrosExcel,
} from './facturas-emitidas-xlsx';
import type {
  FacturaEmitida,
  ResumenFacturas,
} from './facturas-emitidas.types';

/** Excel del registro (24-sep-2026): jamás suma USD con MXN ni las canceladas. */
const factura = (p: Partial<FacturaEmitida>): FacturaEmitida => ({
  id: 'f',
  serie: 'A',
  folio: '123',
  folio_num: 123,
  etiqueta: 'A-123',
  uuid: null,
  fecha_emision: '2026-09-24',
  estatus: 'VIGENTE',
  emisor_rfc: null,
  emisor_nombre: null,
  emisora: null,
  receptor_rfc: 'MMA150622P83',
  receptor_nombre: 'MAQAR MACHINERY',
  cliente: null,
  moneda: 'USD',
  subtotal: 6940,
  iva: 1110.4,
  total: 8050.4,
  metodo_pago: 'PPD',
  forma_pago: '99',
  notas: null,
  es_parcial: false,
  pdf: null,
  xml: null,
  archivos_anteriores: 0,
  vuelos: [],
  alertas: ['SIN_PDF', 'SIN_VUELO'],
  cancelada: null,
  created_at: '2026-09-24T15:00:00Z',
  created_por_nombre: 'Mary Cruz',
  updated_at: '2026-09-24T15:00:00Z',
  ...p,
});

const resumen: ResumenFacturas = {
  registradas: 2,
  vigentes: 1,
  canceladas: 1,
  sin_pdf: 1,
  sin_vuelo: 1,
  vuelos_con_varias: 0,
  en_vuelo_cancelado: 0,
  por_facturar: 3,
  totales_vigentes: [{ moneda: 'USD', total: 8050.4 }],
  huecos: [
    {
      emisora: null,
      serie: 'A',
      etiqueta_serie: 'A',
      desde: 100,
      hasta: 130,
      total_faltantes: 25,
      faltantes: ['A-104', 'A-107'],
      truncado: true,
    },
  ],
};

describe('payloadExcelFacturas', () => {
  it('fila por factura con las columnas del contrato y total solo de VIGENTES', () => {
    const p = payloadExcelFacturas({
      facturas: [
        factura({}),
        factura({
          id: 'g',
          folio: '124',
          etiqueta: 'A-124',
          estatus: 'CANCELADA',
          total: 999,
        }),
      ],
      resumen,
      filtros: { desde: '2026-09-01', hasta: '2026-09-30', estatus: 'VIGENTE' },
      nombres: {},
      ahora: new Date('2026-09-24T20:00:00Z'),
    });
    expect(p.titulo).toBe('Facturas emitidas');
    expect(p.subtitulo).toBe(
      'Emitidas del 01/09/2026 al 30/09/2026 · Solo vigentes · Generado 24/09/2026 15:00',
    );
    expect(p.columnas).toBe(COLUMNAS_EXCEL_FACTURAS);
    expect(p.filas[0]).toHaveLength(COLUMNAS_EXCEL_FACTURAS.length);
    expect(p.filas[0].slice(0, 9)).toEqual([
      'A-123',
      '—',
      'A',
      '123',
      123,
      '',
      '24/09/2026',
      'Vigente',
      'No',
    ]);
    expect(p.totales?.[0]).toContain('Total vigentes');
    expect(p.totales?.[15]).toBe(8050.4);
    expect(p.resumen).toContainEqual([
      'Faltan en la serie A',
      'A-104, A-107 (y 23 más)',
    ]);
  });

  it('con dos monedas vigentes NO suma (el resumen trae cada moneda)', () => {
    const p = payloadExcelFacturas({
      facturas: [factura({}), factura({ id: 'm', moneda: 'MXN', total: 1000 })],
      resumen,
      filtros: {},
    });
    expect(p.totales?.[15]).toBeNull();
    expect(String(p.totales?.[0])).toContain('no se suman');
  });

  it('textos auxiliares', () => {
    expect(ddmmaaaa('2026-09-24')).toBe('24/09/2026');
    expect(
      textoFiltrosExcel(
        { cliente_id: 'c', serie: 'SIN_SERIE', alerta: 'sin_pdf', q: 'A-1' },
        { cliente: 'Maqar' },
      ),
    ).toBe('Cliente: Maqar · Sin serie · Alerta: Sin PDF · Búsqueda: «A-1»');
  });
});
