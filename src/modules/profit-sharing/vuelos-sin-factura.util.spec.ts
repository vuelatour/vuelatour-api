import type { FacturaDeVuelo } from '../flights/factura-cliente-etiquetas';
import {
  CLAVE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA,
  TITULO_PRECIERRE_VUELOS_SIN_FACTURA,
  entraAlPrecierreSinFactura,
  vuelosCobradosSinFactura,
} from './vuelos-sin-factura.util';

/**
 * PRE-CIERRE · VUELOS COBRADOS EN CUENTAS QUE EXIGEN FACTURA SIN FACTURA
 * REGISTRADA (13-oct-2026, invariante 60): helper PURO. Entra solo con
 * exigencia EXIGE y sin factura registrada (cualquier estado del vuelo); la
 * solicitud viva no lo mete ni lo saca; matrícula del mapa o null; orden por
 * fecha_vuelo, empate por folio, sin fecha al final.
 */
function factura(extra: Partial<FacturaDeVuelo> = {}): FacturaDeVuelo {
  return {
    registrada: null,
    exigencia: 'EXIGE',
    solicitada: false,
    estado: 'COMPLETADO',
    cuentas_exigen: ['HSBC Pesos'],
    etiqueta: 'Pendiente de factura',
    origenes_exigen: ['en HSBC Pesos'],
    solicitud_automatica: false,
    solicitud_ya_no_aplica: false,
    cobros_exigen_sin_factura: 0,
    facturas_con_cobro: 0,
    ...extra,
  };
}

const MATRICULAS = new Map([
  ['av-vgv', 'XA-VGV'],
  ['av-42r', 'N4142R'],
]);

describe('vuelosCobradosSinFactura (puro)', () => {
  it('textos y clave del item', () => {
    expect(CLAVE_PRECIERRE_VUELOS_SIN_FACTURA).toBe(
      'vuelos_cobrados_sin_factura',
    );
    expect(TITULO_PRECIERRE_VUELOS_SIN_FACTURA).toBe(
      'Vuelos cobrados en cuentas que exigen factura sin factura registrada',
    );
    // Decisión del cliente del 14-oct-2026: un anticipo devuelto completo,
    // por cualquier vía, no lleva factura (API 0.0.77).
    // Facturas por cobro (16-oct-2026, invariante 84): la frase del vuelo
    // que YA tiene factura pero con cobros que exigen sin amparar.
    expect(DETALLE_PRECIERRE_VUELOS_SIN_FACTURA).toBe(
      'Cobros que entraron a HSBC Dólares, HSBC Pesos, Scotiabank Dólares o Scotiabank Pesos (o por link de pago HSBC, transferencia o cheque sin cuenta capturada) y siguen ahí —un anticipo devuelto completo, por cualquier vía, no lleva factura; si se devolvió solo una parte, lo retenido sí—, en vuelos del periodo que no tienen factura del servicio registrada. Regístrala en Facturas emitidas (o pídela desde el vuelo; si el vuelo está cancelado, regístrala directo en Facturas emitidas); si el cobro entró a otra cuenta, corrígelo en el detalle del vuelo; si el dinero se devolvió, regístralo como reembolso. Un vuelo que ya tiene factura aparece si alguno de sus cobros que exigen factura no está amparado por ninguna (asígnala desde el cobro o registra la que falta). No bloquea el cierre.',
    );
    expect(DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA).toBe(
      'No se pudo verificar qué vuelos cobrados en cuentas que exigen factura siguen sin factura registrada: revisa Facturas emitidas → Por facturar antes de cerrar.',
    );
  });

  it('entra EXIGE + registrada null (completado, cancelado y pendiente; con solicitud o sin ella)', () => {
    const out = vuelosCobradosSinFactura({
      vuelos: [
        {
          id: 'a',
          folio: 1,
          fecha_vuelo: '2026-09-10T15:00:00+00:00',
          aeronave_id: 'av-vgv',
        },
        {
          id: 'b',
          folio: 2,
          fecha_vuelo: '2026-09-11T15:00:00+00:00',
          aeronave_id: 'av-42r',
        },
        {
          id: 'c',
          folio: 3,
          fecha_vuelo: '2026-09-12T15:00:00+00:00',
          aeronave_id: 'av-vgv',
        },
      ],
      facturas: new Map([
        ['a', factura({ estado: 'COMPLETADO', solicitada: false })],
        [
          'b',
          factura({
            estado: 'CANCELADO',
            solicitada: true,
            cuentas_exigen: ['Transferencia sin cuenta destino'],
          }),
        ],
        [
          'c',
          factura({
            estado: 'CONFIRMADO',
            cuentas_exigen: ['HSBC Dólares', 'Scotiabank Pesos'],
          }),
        ],
      ]),
      matriculas: MATRICULAS,
    });
    expect(out).toEqual([
      {
        id: 'a',
        folio: 1,
        fecha_vuelo: '2026-09-10T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['HSBC Pesos'],
        registrada: null,
        cobros_sin_factura: 0,
      },
      {
        id: 'b',
        folio: 2,
        fecha_vuelo: '2026-09-11T15:00:00+00:00',
        matricula: 'N4142R',
        solicitada: true,
        cuentas: ['Transferencia sin cuenta destino'],
        registrada: null,
        cobros_sin_factura: 0,
        // Solo en el CANCELADO (para él no existe «pídela desde el vuelo»).
        estado: 'CANCELADO',
      },
      {
        id: 'c',
        folio: 3,
        fecha_vuelo: '2026-09-12T15:00:00+00:00',
        matricula: 'XA-VGV',
        solicitada: false,
        cuentas: ['HSBC Dólares', 'Scotiabank Pesos'],
        registrada: null,
        cobros_sin_factura: 0,
      },
    ]);
  });

  describe('facturas por cobro (16-oct-2026, invariante 84)', () => {
    const vuelo = (id: string, folio: number) => ({
      id,
      folio,
      fecha_vuelo: '2026-09-21T15:00:00+00:00',
      aeronave_id: 'av-vgv',
    });

    it('#332 tras el backfill (A-0420 ampara 1 cobro, 3 que exigen sin factura) ENTRA con `registrada` y el conteo', () => {
      const out = vuelosCobradosSinFactura({
        vuelos: [vuelo('v332', 332)],
        facturas: new Map([
          [
            'v332',
            factura({
              registrada: 'A-0420',
              etiqueta: 'A-0420',
              cuentas_exigen: ['Scotiabank Pesos'],
              facturas_con_cobro: 1,
              cobros_exigen_sin_factura: 3,
            }),
          ],
        ]),
        matriculas: MATRICULAS,
      });
      expect(out).toEqual([
        {
          id: 'v332',
          folio: 332,
          fecha_vuelo: '2026-09-21T15:00:00+00:00',
          matricula: 'XA-VGV',
          solicitada: false,
          cuentas: ['Scotiabank Pesos'],
          registrada: 'A-0420',
          cobros_sin_factura: 3,
        },
      ]);
      expect(
        entraAlPrecierreSinFactura(
          factura({
            registrada: 'A-0420',
            facturas_con_cobro: 1,
            cobros_exigen_sin_factura: 3,
          }),
        ),
      ).toBe(true);
    });

    it('factura GLOBAL con 0 ligas (A-0430) NO entra aunque queden cobros que exigen (como hoy); todo amparado tampoco; sin sonda (0/0) = hoy', () => {
      const out = vuelosCobradosSinFactura({
        vuelos: [vuelo('g', 259), vuelo('t', 427), vuelo('s', 364)],
        facturas: new Map([
          [
            'g',
            factura({
              registrada: 'A-0430',
              facturas_con_cobro: 0,
              cobros_exigen_sin_factura: 2,
            }),
          ],
          [
            't',
            factura({
              registrada: 'FA-A-0447',
              facturas_con_cobro: 1,
              cobros_exigen_sin_factura: 0,
            }),
          ],
          ['s', factura({ registrada: 'FA-A-0434' })],
        ]),
        matriculas: MATRICULAS,
      });
      expect(out).toEqual([]);
      // Sin factura registrada sigue entrando aunque no exija el conteo.
      expect(entraAlPrecierreSinFactura(factura({ registrada: null }))).toBe(
        true,
      );
      expect(
        entraAlPrecierreSinFactura(
          factura({ exigencia: 'NO_EXIGE', registrada: null }),
        ),
      ).toBe(false);
    });
  });

  it('NO entra: NO_EXIGE, SIN_COBROS, registrada («A-0424», «Facturado») ni la solicitud viva sola', () => {
    const vuelos = ['n', 's', 'r1', 'r2', 'v'].map((id, i) => ({
      id,
      folio: i + 1,
      fecha_vuelo: '2026-09-10T15:00:00+00:00',
      aeronave_id: 'av-vgv',
    }));
    const out = vuelosCobradosSinFactura({
      vuelos,
      facturas: new Map([
        [
          'n',
          factura({
            exigencia: 'NO_EXIGE',
            cuentas_exigen: [],
            etiqueta: 'No lleva factura',
          }),
        ],
        [
          's',
          factura({
            exigencia: 'SIN_COBROS',
            cuentas_exigen: [],
            etiqueta: null,
          }),
        ],
        ['r1', factura({ registrada: 'A-0424', etiqueta: 'A-0424' })],
        ['r2', factura({ registrada: 'Facturado', etiqueta: 'Facturado' })],
        // Solicitud viva con cobros que NO exigen: la columna dice «Pendiente
        // de factura» pero el pre-cierre no lo lista (no es por cuenta).
        [
          'v',
          factura({
            exigencia: 'NO_EXIGE',
            solicitada: true,
            cuentas_exigen: [],
            etiqueta: 'Pendiente de factura',
          }),
        ],
      ]),
      matriculas: MATRICULAS,
    });
    expect(out).toEqual([]);
  });

  it('matrícula del mapa o null (externo / sin avión / avión desconocido); vuelo sin factura leída se omite; ids repetidos una vez', () => {
    const out = vuelosCobradosSinFactura({
      vuelos: [
        {
          id: 'x',
          folio: 10,
          fecha_vuelo: '2026-09-10T15:00:00+00:00',
          aeronave_id: null,
        },
        {
          id: 'y',
          folio: 11,
          fecha_vuelo: '2026-09-10T15:00:00+00:00',
          aeronave_id: 'av-otro',
        },
        {
          id: 'z',
          folio: 12,
          fecha_vuelo: '2026-09-10T15:00:00+00:00',
          aeronave_id: 'av-vgv',
        },
        {
          id: 'x',
          folio: 10,
          fecha_vuelo: '2026-09-10T15:00:00+00:00',
          aeronave_id: null,
        },
      ],
      facturas: new Map([
        ['x', factura()],
        ['y', factura()],
      ]),
      matriculas: MATRICULAS,
    });
    expect(out.map((v) => [v.folio, v.matricula])).toEqual([
      [10, null],
      [11, null],
    ]);
  });

  it('orden: fecha_vuelo, empate por folio, sin fecha al final', () => {
    const out = vuelosCobradosSinFactura({
      vuelos: [
        { id: 'a', folio: 351, fecha_vuelo: '2026-09-27T15:00:00+00:00' },
        { id: 'b', folio: 350, fecha_vuelo: '2026-09-27T15:00:00+00:00' },
        { id: 'c', folio: 200, fecha_vuelo: '2026-09-25T15:00:00+00:00' },
        { id: 'd', folio: 5, fecha_vuelo: null },
        { id: 'e', folio: 341, fecha_vuelo: '2026-09-20T15:00:00+00:00' },
      ],
      facturas: new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, factura()])),
      matriculas: new Map(),
    });
    expect(out.map((v) => v.folio)).toEqual([341, 200, 350, 351, 5]);
  });
});
