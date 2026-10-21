/**
 * Datos REALES de prod (SELECT por MCP, 15-oct-2026 ≈ 01:30 Cancún) para
 * «Cobrado de más» (invariante 77, D13/D14): los 7 vuelos que hoy cobran de
 * más (#81, #84, #111, #193, #217, #259, #285), #92 (cobrado de MENOS, mismo
 * cliente que #81/#84) y #315/#332 (Beh Kay: el «antes» de la corrección del
 * 14-oct-2026 y el estado de hoy). Montos y T.C. como los manda PostgREST
 * (numeric ⇒ texto). Fuera del build (`*spec.ts`) y de jest (no termina en
 * `.spec.ts`): patrón `*.fixture-spec.ts` del repo. Lo comparten
 * `cobrado-de-mas.util.spec`, `flights.service.cobrado-de-mas.spec` y
 * `profit-sharing.service.pre-cierre-cobrados-de-mas.spec`.
 */
export type FilaReal = Record<string, unknown>;

interface LineaDesglose {
  clave: string;
  concepto: string;
  monto_usd: number;
}

const NOTA_BILLPOCKET = 'Método BILLPOCKET: sin IVA por default';
const NOTA_FACTURABLE =
  'Pago facturable: IVA 16% sobre (subtotal + TUAS + extras gravados)';
const NOTA_EFECTIVO = 'Pago en efectivo: sin IVA (subtotal)';

function snapshot(
  lineas: LineaDesglose[],
  iva: {
    base_usd: number;
    monto_usd: number;
    porcentaje: number;
    nota: string;
    aplica_por_metodo_pago: boolean;
  },
): FilaReal {
  return {
    desglose: lineas,
    iva,
    meta: { redondeo_auto_usd: null },
  };
}

function vuelo(
  folio: number,
  id: string,
  extra: FilaReal & { calculo_snapshot: FilaReal },
): FilaReal {
  return {
    id,
    folio,
    estado: 'COMPLETADO',
    cotizacion_abierta: false,
    grupo_id: null,
    ajuste_final_usd: '0.00',
    comision_vendedor_usd: '0.00',
    iva_usd: '0.00',
    iva_pct: '0.0000',
    tuas_usd: '0.00',
    extras_total_usd: '0.00',
    viaticos_pernocta_usd: '0.00',
    cobrado: true,
    es_externo: false,
    aeronave_id: null,
    piloto_id: null,
    ...extra,
  };
}

export const CLIENTE_ANDY = 'ad128023-1e71-43c5-a622-6878d8766af5';
export const CLIENTE_BEH_KAY = '4331f4ec-aeea-4e70-953b-590846aaa41a';

/** Clientes reales de esos vuelos (ninguno interno). */
export const CLIENTES_REALES: FilaReal[] = [
  { id: CLIENTE_ANDY, nombre: 'Andy de León', es_interno: false },
  {
    id: '33eb6292-63b2-49b8-b114-865832a53c9f',
    nombre: 'Francisco Martínez Cidon',
    es_interno: false,
  },
  {
    id: '37c8e340-3857-4591-88ff-22a1bd07690b',
    nombre: 'Jet Planes',
    es_interno: false,
  },
  {
    id: 'ed044d7b-d510-4da8-a3ba-c11288d3fb2f',
    nombre: 'Palma',
    es_interno: false,
  },
  {
    id: '85a18252-74d8-42ae-bcf0-297d1c961ab0',
    nombre: 'Hector Villanueva',
    es_interno: false,
  },
  {
    id: 'b1959f3e-9a49-4353-ab1a-56b1a8ba267e',
    nombre: 'Tatiana Diaz Leal',
    es_interno: false,
  },
  { id: CLIENTE_BEH_KAY, nombre: 'Beh Kay ', es_interno: false },
];

/** Vuelos reales por folio. */
export const VUELOS_REALES: Record<number, FilaReal> = {
  81: vuelo(81, 'ea7cc71c-036b-49a3-996d-6d76a60126c3', {
    cliente_id: CLIENTE_ANDY,
    monto_total_usd: '2629.29',
    tc_usd_mxn: '17.500000',
    fecha_vuelo: '2026-07-25T20:00:00+00:00',
    fecha_solicitud: '2026-07-25T18:21:48.557706+00:00',
    subtotal_vuelo_usd: '2400.00',
    comision_vendedor_usd: '75.00',
    extras_total_usd: '154.29',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1.5 hr × $1600/hr',
          monto_usd: 2400,
        },
        {
          clave: 'EXTRA',
          concepto: 'Camioneta · $2700.00 MXN',
          monto_usd: 154.29,
        },
        {
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión del vendedor · $50.00/hr × 1.5 hr',
          monto_usd: 75,
        },
      ],
      {
        base_usd: 2629.29,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_BILLPOCKET,
        aplica_por_metodo_pago: false,
      },
    ),
  }),
  84: vuelo(84, '5735ee82-1dac-41f0-953d-4408a4c528dc', {
    cliente_id: CLIENTE_ANDY,
    monto_total_usd: '1267.01',
    tc_usd_mxn: '17.500000',
    fecha_vuelo: '2026-07-27T13:30:00+00:00',
    fecha_solicitud: '2026-07-27T01:07:12.409258+00:00',
    subtotal_vuelo_usd: '1200.00',
    comision_vendedor_usd: '37.50',
    tuas_usd: '29.51',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1 hr × $1200/hr (mínimo 1 hr)',
          monto_usd: 1200,
        },
        {
          clave: 'TUAS',
          concepto: 'TUA PCE · $103.29 MXN × 5 pax = $516.45 MXN',
          monto_usd: 29.51,
        },
        {
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión del vendedor',
          monto_usd: 37.5,
        },
      ],
      {
        base_usd: 1267.01,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_BILLPOCKET,
        aplica_por_metodo_pago: false,
      },
    ),
  }),
  92: vuelo(92, '977904cb-f82b-46c1-8873-a1d2eda28c91', {
    cliente_id: CLIENTE_ANDY,
    monto_total_usd: '1237.50',
    tc_usd_mxn: '17.500000',
    fecha_vuelo: '2026-07-28T22:00:00+00:00',
    fecha_solicitud: '2026-07-28T21:49:48.575789+00:00',
    subtotal_vuelo_usd: '1200.00',
    comision_vendedor_usd: '37.50',
    cobrado: false,
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1 hr × $1200/hr (mínimo 1 hr)',
          monto_usd: 1200,
        },
        {
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión del vendedor',
          monto_usd: 37.5,
        },
      ],
      {
        base_usd: 1237.5,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_BILLPOCKET,
        aplica_por_metodo_pago: false,
      },
    ),
  }),
  111: vuelo(111, 'ee0dfeaa-50d2-4931-877a-d09eee1f785a', {
    cliente_id: '33eb6292-63b2-49b8-b114-865832a53c9f',
    monto_total_usd: '870.00',
    tc_usd_mxn: '17.500000',
    fecha_vuelo: '2026-08-03T17:30:00+00:00',
    fecha_solicitud: '2026-08-02T15:10:11.00906+00:00',
    subtotal_vuelo_usd: '750.00',
    iva_usd: '120.00',
    iva_pct: '0.1600',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1 hr × $750/hr',
          monto_usd: 750,
        },
        { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 120 },
      ],
      {
        base_usd: 750,
        monto_usd: 120,
        porcentaje: 0.16,
        nota: NOTA_FACTURABLE,
        aplica_por_metodo_pago: true,
      },
    ),
  }),
  193: vuelo(193, '145eb0e0-f728-436d-a5d2-b9d7e381f43d', {
    cliente_id: '37c8e340-3857-4591-88ff-22a1bd07690b',
    monto_total_usd: '325.00',
    tc_usd_mxn: '16.971200',
    fecha_vuelo: '2026-08-26T13:30:00+00:00',
    fecha_solicitud: '2026-08-25T23:01:02.497815+00:00',
    subtotal_vuelo_usd: '325.00',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 0.5 hr × $650/hr',
          monto_usd: 325,
        },
      ],
      {
        base_usd: 325,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_FACTURABLE,
        aplica_por_metodo_pago: true,
      },
    ),
  }),
  217: vuelo(217, 'b9456b39-d89a-4ac8-a237-f399e543dd9b', {
    cliente_id: 'ed044d7b-d510-4da8-a3ba-c11288d3fb2f',
    monto_total_usd: '3100.00',
    tc_usd_mxn: '16.959955',
    fecha_vuelo: '2026-08-30T14:00:00+00:00',
    fecha_solicitud: '2026-08-29T23:08:21.066962+00:00',
    subtotal_vuelo_usd: '3100.00',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 2 hr × $1550/hr',
          monto_usd: 3100,
        },
      ],
      {
        base_usd: 3100,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_FACTURABLE,
        aplica_por_metodo_pago: true,
      },
    ),
  }),
  259: vuelo(259, '55b7d53e-cf8f-494d-94ed-b750b4c75d00', {
    cliente_id: '85a18252-74d8-42ae-bcf0-297d1c961ab0',
    monto_total_usd: '2600.00',
    tc_usd_mxn: '17.000000',
    fecha_vuelo: '2026-09-07T14:00:00+00:00',
    fecha_solicitud: '2026-09-07T04:47:04.252426+00:00',
    subtotal_vuelo_usd: '2600.00',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 4 hr × $650/hr',
          monto_usd: 2600,
        },
      ],
      {
        base_usd: 2600,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_EFECTIVO,
        aplica_por_metodo_pago: false,
      },
    ),
  }),
  285: vuelo(285, 'a753eac6-97d7-41b4-b9dd-c4386a1d66f9', {
    cliente_id: 'b1959f3e-9a49-4353-ab1a-56b1a8ba267e',
    monto_total_usd: '1530.00',
    tc_usd_mxn: '17.500000',
    fecha_vuelo: '2026-09-18T15:00:00+00:00',
    fecha_solicitud: '2026-09-10T18:48:25.5903+00:00',
    subtotal_vuelo_usd: '1280.00',
    tuas_usd: '200.00',
    extras_total_usd: '50.00',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 0.8 hr × $1600/hr',
          monto_usd: 1280,
        },
        {
          clave: 'TUAS',
          concepto: 'TUA CZM · $25.00 × 8 pax',
          monto_usd: 200,
        },
        { clave: 'EXTRA', concepto: 'Espera', monto_usd: 50 },
      ],
      {
        base_usd: 1530,
        monto_usd: 0,
        porcentaje: 0,
        nota: NOTA_EFECTIVO,
        aplica_por_metodo_pago: false,
      },
    ),
  }),
  315: vuelo(315, 'e3851d95-b022-4825-883f-1e81068712cb', {
    cliente_id: CLIENTE_BEH_KAY,
    monto_total_usd: '4175.25',
    tc_usd_mxn: '17.150000',
    fecha_vuelo: '2026-09-17T13:30:00+00:00',
    fecha_solicitud: '2026-09-16T12:27:31.538246+00:00',
    subtotal_vuelo_usd: '3579.00',
    ajuste_final_usd: '-150.55',
    iva_usd: '548.55',
    iva_pct: '0.1600',
    extras_total_usd: '198.25',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 2 hr × $1789.5/hr',
          monto_usd: 3579,
        },
        {
          clave: 'EXTRA',
          concepto: 'Camionetas · 2 × $1,700.00 MXN = $3,400.00 MXN (sin IVA)',
          monto_usd: 198.25,
        },
        { clave: 'AJUSTE', concepto: 'Descuento', monto_usd: -150.55 },
        { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 548.55 },
      ],
      {
        base_usd: 3428.45,
        monto_usd: 548.55,
        porcentaje: 0.16,
        nota: NOTA_FACTURABLE,
        aplica_por_metodo_pago: true,
      },
    ),
  }),
  332: vuelo(332, '6f1825e3-0c54-45f1-bb66-d8f27a71fb7e', {
    cliente_id: CLIENTE_BEH_KAY,
    monto_total_usd: '4172.44',
    tc_usd_mxn: '17.396374',
    fecha_vuelo: '2026-09-24T13:30:00+00:00',
    fecha_solicitud: '2026-09-22T16:36:06.506878+00:00',
    subtotal_vuelo_usd: '3579.00',
    ajuste_final_usd: '-150.55',
    iva_usd: '548.55',
    iva_pct: '0.1600',
    extras_total_usd: '195.44',
    calculo_snapshot: snapshot(
      [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 2 hr × $1789.5/hr',
          monto_usd: 3579,
        },
        {
          clave: 'EXTRA',
          concepto: 'Camionetas · 2 × $1,700.00 MXN = $3,400.00 MXN (sin IVA)',
          monto_usd: 195.44,
        },
        { clave: 'AJUSTE', concepto: 'Descuento', monto_usd: -150.55 },
        { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 548.55 },
      ],
      {
        base_usd: 3428.45,
        monto_usd: 548.55,
        porcentaje: 0.16,
        nota: NOTA_FACTURABLE,
        aplica_por_metodo_pago: true,
      },
    ),
  }),
};

function cobro(
  folio: number,
  id: string,
  monto: string,
  extra: FilaReal = {},
): FilaReal {
  return {
    id,
    vuelo_id: VUELOS_REALES[folio].id,
    monto,
    moneda: 'MXN',
    tc_usd_mxn: VUELOS_REALES[folio].tc_usd_mxn,
    comision_banco_monto: null,
    comision_banco_pct: null,
    metodo_cobro: 'TRANSFERENCIA',
    fecha_cobro: '2026-09-15T17:00:00+00:00',
    cobro_grupo_id: null,
    grupo_factor: null,
    cuenta_destino: null,
    referencia: null,
    foto_voucher_url: null,
    registrado_por: null,
    notas: null,
    created_at: '2026-09-15T17:00:00+00:00',
    updated_at: '2026-09-15T17:00:00+00:00',
    ...extra,
  };
}

/** Cobros REALES de hoy (después de la corrección del 14-oct-2026). */
export const COBROS_REALES: FilaReal[] = [
  cobro(81, '5433841c-b009-422f-846f-a53883c9038c', '22577.00', {
    metodo_cobro: 'BILLPOCKET',
    fecha_cobro: '2026-07-13T17:00:00+00:00',
  }),
  cobro(81, '0c8f10a0-394d-45b2-b12f-63beb41bf967', '27185.18', {
    metodo_cobro: 'HSBC_LINK',
    comision_banco_monto: '3749.68',
    comision_banco_pct: '13.7931',
    fecha_cobro: '2026-07-27T17:00:00+00:00',
  }),
  cobro(84, 'd067d299-7f4e-4dce-b9ab-a1d5e6dd2d69', '25720.30', {
    metodo_cobro: 'HSBC_LINK',
    comision_banco_monto: '3547.62',
    comision_banco_pct: '13.7931',
    fecha_cobro: '2026-07-27T17:00:00+00:00',
  }),
  cobro(92, 'e00840ca-e710-4861-95aa-2698a9525a0c', '21389.38', {
    metodo_cobro: 'HSBC_LINK',
    comision_banco_monto: '2950.01',
    comision_banco_pct: '13.7919',
    cuenta_destino: 'HSBC Pesos',
    fecha_cobro: '2026-07-27T17:00:00+00:00',
  }),
  cobro(111, '97957505-2f24-4ad3-8a9f-6f33d0b403b4', '15255.00', {
    metodo_cobro: 'HSBC_LINK',
    comision_banco_monto: '563.33',
    comision_banco_pct: '3.6928',
    fecha_cobro: '2026-08-03T17:00:00+00:00',
  }),
  cobro(193, '04ef4e64-cc15-4ce7-8be9-669b657bf2ec', '6398.14', {
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-08-31T17:00:00+00:00',
  }),
  cobro(217, '8da8501d-5b75-4d03-8e25-eca232a06085', '60988.00', {
    tc_usd_mxn: '16.960000',
    fecha_cobro: '2026-08-28T17:00:00+00:00',
  }),
  cobro(259, 'b13a2664-1937-40f6-b215-28a970d20069', '24344.00', {
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-09-07T17:00:00+00:00',
  }),
  cobro(259, 'e1348c91-4258-4514-99a7-fa2d2d0cc694', '20000.00', {
    metodo_cobro: 'EFECTIVO',
    fecha_cobro: '2026-09-07T17:00:00+00:00',
  }),
  cobro(285, '1591ec87-509f-4525-8d57-2a11ee618197', '15050.00', {
    metodo_cobro: 'EFECTIVO',
    fecha_cobro: '2026-09-14T17:00:00+00:00',
  }),
  cobro(285, '850cdbf2-c9ab-4d41-b3ee-7f8035bc7090', '11750.00', {
    metodo_cobro: 'EFECTIVO',
    fecha_cobro: '2026-09-21T17:00:00+00:00',
  }),
  cobro(315, '3643f03c-a3f7-45ec-bf29-03a1afc18774', '1700.00', {
    cuenta_destino: 'Scotiabank Pesos',
  }),
  cobro(315, '46c6dae8-6751-4faa-8caa-b8d952817209', '68205.55', {
    cuenta_destino: 'Scotiabank Pesos',
  }),
  cobro(315, 'abca82f3-ef73-4a19-b0df-1920d07eca05', '1700.00', {
    cuenta_destino: 'Scotiabank Pesos',
  }),
  cobro(332, 'd7b0890c-9d0f-441f-a5cd-edd27fa50f0f', '977.45', {
    tc_usd_mxn: '17.150000',
    cuenta_destino: 'Scotiabank Pesos',
  }),
  cobro(332, '15d97e3a-6256-4ae2-97ea-1479e9f419f5', '1700.00', {
    tc_usd_mxn: '17.400000',
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-09-21T17:00:00+00:00',
  }),
  cobro(332, '4e938868-7aa9-4e26-8a06-ded566ae092a', '68208.00', {
    tc_usd_mxn: '17.400000',
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-09-21T17:00:00+00:00',
  }),
  cobro(332, '6f2e65dd-1bf8-4c1f-81e5-d2601dd5c842', '1700.00', {
    tc_usd_mxn: '17.400000',
    cuenta_destino: 'Scotiabank Pesos',
    fecha_cobro: '2026-09-21T17:00:00+00:00',
  }),
];

/** El cobro de $977.45 del #332 (el que quedó «sin banco» antes de la corrección). */
export const COBRO_332_977 = 'd7b0890c-9d0f-441f-a5cd-edd27fa50f0f';

/**
 * #315 ANTES de la corrección del 14-oct-2026: el cobro de $68,205.55 se
 * había editado a $69,183 (el SPEI que también pagó $977.45 del #332) y las
 * camionetas eran UN cobro de $3,400.
 */
export const COBROS_315_ANTES: FilaReal[] = [
  cobro(315, '46c6dae8-6751-4faa-8caa-b8d952817209', '69183.00', {
    cuenta_destino: 'Scotiabank Pesos',
  }),
  cobro(315, '3643f03c-a3f7-45ec-bf29-03a1afc18774', '3400.00', {
    cuenta_destino: 'Scotiabank Pesos',
  }),
];

/** Los cobros reales de un vuelo. */
export function cobrosDe(folio: number): FilaReal[] {
  const id = VUELOS_REALES[folio].id;
  return COBROS_REALES.filter((c) => c.vuelo_id === id);
}

/**
 * Lo que prod dice hoy de los 7 (el pedido: solo #217 y #193 piden
 * revisión). `null` = sin aviso.
 */
export const ESPERADO_REAL: ReadonlyArray<{
  folio: number;
  causa: string | null;
  excedente: number | null;
  requiere_revision: boolean | null;
}> = [
  {
    folio: 81,
    causa: 'COMISION_PAGADA_POR_CLIENTE',
    excedente: 214.26,
    requiere_revision: false,
  },
  {
    folio: 84,
    causa: 'COMISION_PAGADA_POR_CLIENTE',
    excedente: 202.72,
    requiere_revision: false,
  },
  { folio: 92, causa: null, excedente: null, requiere_revision: null },
  {
    folio: 111,
    causa: 'REDONDEO_TC',
    excedente: 1.71,
    requiere_revision: false,
  },
  {
    folio: 193,
    causa: 'IVA_NO_COTIZADO',
    excedente: 52,
    requiere_revision: true,
  },
  {
    folio: 217,
    causa: 'IVA_NO_COTIZADO',
    excedente: 496, // pesos primero (20-oct-2026): 495.99 con el T.C. de cada cobro
    requiere_revision: true,
  },
  {
    folio: 259,
    causa: 'REDONDEO_TC',
    excedente: 8.47,
    requiere_revision: false,
  },
  {
    folio: 285,
    causa: 'REDONDEO_TC',
    excedente: 1.43,
    requiere_revision: false,
  },
  { folio: 315, causa: null, excedente: null, requiere_revision: null },
  { folio: 332, causa: null, excedente: null, requiere_revision: null },
];
