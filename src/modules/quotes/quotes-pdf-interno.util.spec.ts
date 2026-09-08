import {
  armarCotizacionInternaPayload,
  horasTacoDe,
  type CobroInternoRow,
  type CotizacionInternaInsumos,
  type EscalaInternaRow,
} from './quotes-pdf-interno.util';

/**
 * Armador del PDF «Cotización interna» con el caso de la foto del cliente
 * (8-sep-2026): Seneca N4142R, 4 tramos de 0.4 h de tacómetro (= 1.6 h),
 * comisión del vendedor "Saab" $280, cobro Paywise en MXN con comisión
 * bancaria 8.857 % = $3,236.36 → neto $33,303.64. Nada se recalcula: el
 * armador solo LEE el snapshot y las fuentes únicas.
 */
const SENECA = 'aaaaaaaa-0000-0000-0000-00000000a142';
const KODIAK = 'aaaaaaaa-0000-0000-0000-00000000k621';
const PILOTO = 'uuuuuuuu-0000-0000-0000-000000000001';
const VENDEDOR_USR = 'uuuuuuuu-0000-0000-0000-000000000002';
const ADMIN = 'uuuuuuuu-0000-0000-0000-000000000003';

/** Snapshot canónico v1.3 (forma exacta de QuotesService.calculate). */
function snapshot(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aeronave: {
      id: SENECA,
      matricula: 'N4142R',
      modelo: 'Seneca V',
      pais_registro: 'US',
      velocidad_crucero_kts: 170,
    },
    tiempos: {
      vuelo_hr: 1.0,
      cobrable_hr_regla: 1.6,
      cobrable_proviene_de_override: false,
      calzos_hr: 0.6,
      sobrevuelo_hr: 0,
      cobrable_hr: 1.6,
      minimo_hora_aplicado: false,
    },
    tarifa: {
      tipo: 'PUBLICO',
      usd_por_hora: 1000,
      proviene_de_override: false,
      preferencial_cliente: false,
    },
    tuas: {
      pasajeros: 4,
      aeropuertos: [
        {
          iata: 'CUN',
          aplica: false,
          usd_pax: 0,
          monto_pax: 0,
          moneda: 'USD',
          tc_aplicado: null,
          razon: 'Matrícula N exenta',
        },
        {
          iata: 'CZM',
          aplica: true,
          usd_pax: 20,
          monto_pax: 20,
          moneda: 'USD',
          tc_aplicado: null,
          razon: 'TUAS aplica',
        },
      ],
      filas: [
        {
          iata: 'CZM',
          aplica: true,
          usd_pax: 20,
          monto_pax: 20,
          moneda: 'USD',
          tc_aplicado: null,
          razon: 'TUAS aplica',
          pax: 4,
          total_nativo: 80,
          total_usd: 80,
        },
      ],
      total_usd: 80,
      total_mxn_nativo: 0,
    },
    tramos: [
      {
        orden: 1,
        origen: 'CUN',
        destino: 'CZM',
        millas: 60,
        pasajeros: 4,
        es_ferry: false,
        tiempo_hr: 0.4,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
      },
      {
        orden: 2,
        origen: 'CZM',
        destino: 'CUN',
        millas: 60,
        pasajeros: 4,
        es_ferry: false,
        tiempo_hr: 0.4,
        tuas_usd: 80,
        requiere_pernocta: false,
        pernocta_usd: 0,
      },
      {
        orden: 3,
        origen: 'CUN',
        destino: 'CZM',
        millas: 60,
        pasajeros: 4,
        es_ferry: false,
        tiempo_hr: 0.4,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
      },
      {
        orden: 4,
        origen: 'CZM',
        destino: 'CUN',
        millas: 60,
        pasajeros: 4,
        es_ferry: false,
        tiempo_hr: 0.4,
        tuas_usd: 0,
        requiere_pernocta: false,
        pernocta_usd: 0,
      },
    ],
    iva: {
      aplica_por_metodo_pago: true,
      porcentaje: 0.16,
      base_usd: 2130,
      monto_usd: 340.8,
      nota: 'Pago facturable: IVA 16% sobre (subtotal + TUAS + extras gravados)',
    },
    extras: [
      {
        concepto: 'Tour',
        monto_usd: 170,
        moneda: 'USD',
        monto_nativo: 170,
        tc_aplicado: null,
        aplica_iva: true,
        cantidad: 2,
        unitario: 85,
      },
    ],
    desglose: [
      {
        clave: 'TIEMPO_VUELO',
        concepto: 'Tiempo de vuelo · 1.6 hr × $1000/hr',
        monto_usd: 1600,
      },
      { clave: 'TUAS', concepto: 'TUA CZM · $20.00 × 4 pax', monto_usd: 80 },
      { clave: 'EXTRA', concepto: 'Tour · 2 × $85.00', monto_usd: 170 },
      {
        clave: 'COMISION_VENDEDOR',
        concepto: 'Comisión del vendedor (Saab)',
        monto_usd: 280,
      },
      { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 340.8 },
    ],
    totales: {
      subtotal_vuelo_usd: 1600,
      tuas_total_usd: 80,
      viaticos_pernocta_usd: 0,
      extras_total_usd: 170,
      ajuste_final_usd: 0,
      iva_usd: 340.8,
      total_usd: 2470.8,
      mxn_nativos: 0,
      usd_de_mxn: 0,
      total_mxn: 36543.13,
    },
    meta: {
      calculado_at: '2026-09-01T15:00:00.000Z',
      version_motor: '1.3.1',
      comision_billpocket_pct: null,
      total_pactado_usd: null,
      redondeo_automatico: false,
      redondeo_auto_usd: null,
      descuento_usd: null,
      comision_vendedor_usd: 280,
      comision_vendedor_nombre: 'Saab',
      comision_vendedor_modo: 'FIJA',
      comision_vendedor_tarifa_hr: null,
      neto_vuelatour_usd: 2146,
    },
    ...extra,
  };
}

/** Fila de vuelo como la devuelve quotes.findById (VUELO_COLS + fichas). */
function quote(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vvvvvvvv-0000-0000-0000-000000000001',
    folio: 1042,
    cliente_id: 'cccccccc-0000-0000-0000-000000000001',
    aeronave_id: SENECA,
    piloto_id: PILOTO,
    copiloto_id: null,
    tipo: 'REDONDO',
    estado: 'COMPLETADO',
    es_externo: false,
    cotizacion_version: 3,
    origen_iata: 'CUN',
    destino_iata: 'CUN',
    pasajeros: 4,
    tiempo_cobrable_hr: 1.6,
    tarifa_tipo: 'PUBLICO',
    tarifa_hora_usd: 1000,
    subtotal_vuelo_usd: 1600,
    tuas_usd: 80,
    iva_pct: 0.16,
    iva_usd: 340.8,
    monto_total_usd: 2470.8,
    viaticos_pernocta_usd: 0,
    extras_total_usd: 170,
    ajuste_final_usd: 0,
    comision_vendedor_usd: 280,
    comision_vendedor_nombre: 'Saab',
    comision_vendedor_modo: 'FIJA',
    comision_vendedor_tarifa_hr: null,
    tc_usd_mxn: 14.79,
    monto_total_mxn: 36543.13,
    metodo_cobro: 'TRANSFERENCIA',
    metodo_cobro_detalle: null,
    cotizacion_abierta: false,
    itinerario_operativo: false,
    extras: [
      {
        concepto: 'Tour',
        monto_usd: 170,
        moneda: 'USD',
        monto_nativo: 170,
        aplica_iva: true,
        cantidad: 2,
        unitario: 85,
      },
    ],
    fecha_solicitud: '2026-08-28T16:00:00.000Z',
    fecha_vuelo: '2026-09-03T14:00:00.000Z',
    fecha_traslado_final: '2026-09-03T20:00:00.000Z',
    fecha_confirmacion: '2026-08-29T10:00:00.000Z',
    facturado: false,
    cobrado: false,
    notas: 'Cliente pide agua fría',
    notas_internas: 'Cobrado en Paywise el 3 sep',
    calculo_snapshot: snapshot(),
    created_at: '2026-08-28T16:00:00.000Z',
    grupo_id: null,
    grupo_posicion: null,
    grupo: null,
    combinado: null,
    aeronave_cotizada: { id: SENECA, matricula: 'N4142R', modelo: 'Seneca V' },
    aeronave_operativa: { id: SENECA, matricula: 'N4142R', modelo: 'Seneca V' },
    ...extra,
  };
}

function escala(
  orden: number,
  origen: string,
  destino: string,
  extra: Partial<EscalaInternaRow> = {},
): EscalaInternaRow {
  return {
    id: `eeeeeeee-0000-0000-0000-00000000000${orden}`,
    orden,
    origen_iata: origen,
    destino_iata: destino,
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    pasajeros: 4,
    es_ferry: false,
    es_sobrevuelo: false,
    solo_operativa: false,
    requiere_pernocta: false,
    pernocta_costo_usd: 0,
    fecha_salida_plan: `2026-09-03T1${orden}:00:00.000Z`,
    taco_salida: null,
    taco_llegada: null,
    taco_salida_origen: null,
    taco_llegada_origen: null,
    hora_salida: null,
    hora_llegada: null,
    revision_requerida: false,
    cancelada_at: null,
    cancelada_motivo: null,
    ...extra,
  };
}

/** 4 tramos con 0.4 h de taco cada uno (foto del cliente). */
function escalasConTacos(): EscalaInternaRow[] {
  return [
    escala(1, 'CUN', 'CZM', {
      taco_salida: 1200.0,
      taco_llegada: 1200.4,
      taco_salida_origen: 'DEDUCIDO',
      taco_llegada_origen: 'PILOTO',
    }),
    escala(2, 'CZM', 'CUN', {
      taco_salida: 1200.4,
      taco_llegada: 1200.8,
      taco_salida_origen: 'DEDUCIDO',
      taco_llegada_origen: 'PILOTO',
    }),
    escala(3, 'CUN', 'CZM', {
      taco_salida: 1200.8,
      taco_llegada: 1201.2,
      taco_salida_origen: 'DEDUCIDO',
      taco_llegada_origen: 'PILOTO',
    }),
    escala(4, 'CZM', 'CUN', {
      taco_salida: 1201.2,
      taco_llegada: 1201.6,
      taco_salida_origen: 'DEDUCIDO',
      taco_llegada_origen: 'PILOTO',
    }),
  ];
}

/** Cobro Paywise de la foto: bruto 36,540 MXN, comisión 8.857 % = 3,236.36. */
function cobroPaywise(extra: Partial<CobroInternoRow> = {}): CobroInternoRow {
  return {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    monto: 36540,
    moneda: 'MXN',
    metodo_cobro: 'PAYWISE',
    tc_usd_mxn: 14.79,
    comision_banco_pct: 8.857,
    comision_banco_monto: 3236.36,
    cuenta_destino: 'Paywise',
    referencia: 'PW-88123',
    fecha_cobro: '2026-09-03T18:30:00.000Z',
    registrado_por: ADMIN,
    notas: null,
    created_at: '2026-09-03T18:31:00.000Z',
    cobro_grupo_id: null,
    grupo_factor: null,
    cobro_grupo: null,
    conciliado: true,
    movimiento_bancario_id: 'mmmmmmmm-0000-0000-0000-000000000001',
    ...extra,
  };
}

function insumos(
  over: Partial<CotizacionInternaInsumos> = {},
): CotizacionInternaInsumos {
  return {
    quote: quote(),
    escalas: escalasConTacos(),
    cobros: [cobroPaywise()],
    gastos: [],
    facturas: [],
    cliente: {
      nombre: 'Juan Pérez',
      razon_social_default: 'Viajes Caribe SA de CV',
      rfc: 'VCA010101AAA',
      es_broker: false,
    },
    nombrePorId: new Map([
      [PILOTO, 'Luis Ramírez'],
      [VENDEDOR_USR, 'Saab'],
      [ADMIN, 'Ana Admin'],
    ]),
    aeronavePorId: new Map([
      [SENECA, { matricula: 'N4142R', modelo: 'Seneca V' }],
      [KODIAK, { matricula: 'N621TX', modelo: 'Kodiak 100' }],
    ]),
    apoyos: [],
    creadoPorId: ADMIN,
    generadoPor: 'Ana Admin',
    ahora: new Date('2026-09-08T19:32:00.000Z'),
    ...over,
  };
}

describe('armarCotizacionInternaPayload — cabecera y pie', () => {
  it('cabecera completa: folio/versión/estado, cliente y razón social, avión cotizado con matrícula, piloto, TC, vendedor, quién cotizó', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.folio).toBe('1042');
    expect(p.version).toBe(3);
    expect(p.estado).toBe('COMPLETADO');
    expect(p.estado_label).toBe('Completado');
    expect(p.cliente).toBe('Juan Pérez');
    expect(p.razon_social).toBe('Viajes Caribe SA de CV');
    expect(p.cliente_rfc).toBe('VCA010101AAA');
    expect(p.fecha).toBe('2026-08-28T16:00:00.000Z');
    expect(p.tarifa_tipo).toBe('PUBLICO');
    expect(p.tarifa_tipo_label).toBe('Público');
    expect(p.tarifa_hora_usd).toBe(1000);
    expect(p.metodo_cobro_label).toBe('Transferencia');
    expect(p.tc_usd_mxn).toBe(14.79);
    expect(p.vendedor).toBe('Saab');
    expect(p.cotizado_por).toBe('Ana Admin');
    // La matrícula SIEMPRE se ve en el interno (no aplica la regla VGV del cliente).
    expect(p.aeronave_cotizada_modelo).toBe('Seneca V');
    expect(p.aeronave_cotizada_matricula).toBe('N4142R');
    // Mismo avión operativo que el cotizado → no se repite.
    expect(p.aeronave_operativa).toBeNull();
    expect(p.piloto).toBe('Luis Ramírez');
    expect(p.copiloto).toBeNull();
    expect(p.fecha_traslado_inicial).toBe('2026-09-03T14:00:00.000Z');
    expect(p.fecha_traslado_final).toBe('2026-09-03T20:00:00.000Z');
    expect(p.ruta).toBe('CUN → CZM → CUN → CZM → CUN');
    expect(p.notas_cliente).toBe('Cliente pide agua fría');
    expect(p.notas_internas).toBe('Cobrado en Paywise el 3 sep');
    // Pie: instante ISO + versión Cancún (UTC−5) + usuario.
    expect(p.generado).toBe('2026-09-08T19:32:00.000Z');
    expect(p.generado_cancun).toBe('2026-09-08 14:32');
    expect(p.generado_por).toBe('Ana Admin');
  });

  it('avión operativo distinto del cotizado se anuncia; externo muestra el avión ajeno y no operativo', () => {
    const otro = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          aeronave_id: KODIAK,
          aeronave_operativa: {
            id: KODIAK,
            matricula: 'N621TX',
            modelo: 'Kodiak 100',
          },
        }),
      }),
    );
    expect(otro.aeronave_cotizada_matricula).toBe('N4142R');
    expect(otro.aeronave_operativa).toBe('Kodiak 100 · N621TX');

    const externo = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          es_externo: true,
          operador_externo: 'Aerolíneas del Sur',
          avion_externo_modelo: 'Hawker 400',
          avion_externo_matricula: 'XA-REG',
          aeronave_operativa: null,
          costo_externo_usd: 1500,
        }),
      }),
    );
    expect(externo.es_externo).toBe(true);
    expect(externo.avion_externo).toBe('Hawker 400 · XA-REG');
    expect(externo.operador_externo).toBe('Aerolíneas del Sur');
    expect(externo.aeronave_operativa).toBeNull();
    // Tramos sin avión propio vuelan en el avión ajeno.
    expect(externo.tramos[0].matricula).toBe('XA-REG');
    expect(externo.costo_externo_usd).toBe(1500);
    expect(externo.participacion_aviones).toEqual([]);
  });
});

describe('armarCotizacionInternaPayload — desglose canónico', () => {
  it('líneas canónicas → payload con la operación de cada una; Σ == total; comisión visible con pago al vendedor c/IVA', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.lineas.map((l) => l.clave)).toEqual([
      'TIEMPO_VUELO',
      'TUAS',
      'TUAS', // CUN exento (sintética, $0)
      'EXTRA',
      'COMISION_VENDEDOR',
      'IVA',
    ]);
    const suma = p.lineas.reduce((acc, l) => acc + l.monto_usd, 0);
    expect(Math.round(suma * 100) / 100).toBe(2470.8);
    expect(p.total_usd).toBe(2470.8);

    const tiempo = p.lineas[0];
    expect(tiempo).toMatchObject({
      cantidad: 1.6,
      unitario: 1000,
      moneda: 'USD',
      monto_usd: 1600,
      exento: false,
    });
    const tua = p.lineas[1];
    expect(tua).toMatchObject({
      concepto: 'TUA CZM · $20.00 × 4 pax',
      cantidad: 4,
      unitario: 20,
      moneda: 'USD',
      monto_nativo: 80,
      monto_usd: 80,
    });
    const exento = p.lineas[2];
    expect(exento).toMatchObject({
      clave: 'TUAS',
      monto_usd: 0,
      exento: true,
      cantidad: 4,
      unitario: 0,
    });
    expect(exento.concepto).toBe('TUA CUN · exento · Matrícula N exenta');
    expect(p.tuas_exentos).toEqual(['CUN']);
    const extra = p.lineas[3];
    expect(extra).toMatchObject({
      cantidad: 2,
      unitario: 85,
      moneda: 'USD',
      aplica_iva: true,
      monto_usd: 170,
    });
    const comision = p.lineas[4];
    expect(comision).toMatchObject({
      concepto: 'Comisión del vendedor (Saab)',
      monto_usd: 280,
    });
    expect(comision.cantidad).toBeUndefined(); // FIJA: sin operación

    expect(p.comision_vendedor_usd).toBe(280);
    expect(p.comision_vendedor_nombre).toBe('Saab');
    expect(p.comision_vendedor_modo).toBe('FIJA');
    // pagoVendedorUsd = comisión + su IVA (280 × 0.16 = 44.80).
    expect(p.iva_comision_vendedor_usd).toBe(44.8);
    expect(p.pago_vendedor_usd).toBe(324.8);
    expect(p.neto_vuelatour_usd).toBe(2146);

    expect(p.subtotal_vuelo_usd).toBe(1600);
    expect(p.tuas_usd).toBe(80);
    expect(p.extras_total_usd).toBe(170);
    expect(p.subtotal_usd).toBe(2130); // total − IVA
    expect(p.iva_pct).toBe(16);
    expect(p.iva_base_usd).toBe(2130);
    expect(p.iva_usd).toBe(340.8);
    expect(p.total_mxn).toBe(36543.13);
    // Partición (particionIngresoVuelo): avión = 1600 + IVA prop. (1600/2130 × 340.8 = 256).
    expect(p.venta_avion_usd).toBe(1856);
    expect(p.otros_ingresos_vuelatour_usd).toBe(614.8);
    expect(p.particion_fuente).toBe('desglose');
    expect(p.particion_inconsistente).toBe(false);
    expect(p.participacion_aviones).toEqual([]);
  });

  it('comisión POR_HORA lleva su operación (hr × tarifa) y el descuento/redondeo viajan del meta', () => {
    const snap = snapshot({
      desglose: [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1.6 hr × $1000/hr',
          monto_usd: 1600,
        },
        { clave: 'TUAS', concepto: 'TUA CZM · $20.00 × 4 pax', monto_usd: 80 },
        { clave: 'EXTRA', concepto: 'Tour · 2 × $85.00', monto_usd: 170 },
        {
          clave: 'COMISION_VENDEDOR',
          concepto: 'Comisión del vendedor (Saab) · $175.00/hr × 1.6 hr',
          monto_usd: 280,
        },
        { clave: 'AJUSTE', concepto: 'Descuento', monto_usd: -100 },
        { clave: 'IVA', concepto: 'IVA 16%', monto_usd: 324.8 },
      ],
      iva: { porcentaje: 0.16, base_usd: 2030, monto_usd: 324.8, nota: null },
      totales: {
        subtotal_vuelo_usd: 1600,
        tuas_total_usd: 80,
        viaticos_pernocta_usd: 0,
        extras_total_usd: 170,
        ajuste_final_usd: -100,
        iva_usd: 324.8,
        total_usd: 2354.8,
        total_mxn: null,
      },
      meta: {
        version_motor: '1.3.1',
        comision_vendedor_usd: 280,
        comision_vendedor_nombre: 'Saab',
        comision_vendedor_modo: 'POR_HORA',
        comision_vendedor_tarifa_hr: 175,
        descuento_usd: 100,
        redondeo_auto_usd: null,
      },
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          calculo_snapshot: snap,
          monto_total_usd: 2354.8,
          ajuste_final_usd: -100,
          iva_usd: 324.8,
        }),
      }),
    );
    const com = p.lineas.find((l) => l.clave === 'COMISION_VENDEDOR')!;
    expect(com).toMatchObject({ cantidad: 1.6, unitario: 175, monto_usd: 280 });
    expect(p.comision_vendedor_modo).toBe('POR_HORA');
    expect(p.comision_vendedor_tarifa_hr).toBe(175);
    expect(p.ajuste_final_usd).toBe(-100);
    expect(p.descuento_usd).toBe(100);
    expect(p.lineas.find((l) => l.clave === 'AJUSTE')).toMatchObject({
      concepto: 'Descuento',
      monto_usd: -100,
    });
    const suma = p.lineas.reduce((acc, l) => acc + l.monto_usd, 0);
    expect(Math.round(suma * 100) / 100).toBe(2354.8);
  });

  it('cotización sin snapshot (motor viejo): líneas desde las columnas espejo, misma suma que la partición por columnas', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          calculo_snapshot: null,
          aeronave_cotizada: null,
          aeronave_operativa: {
            id: SENECA,
            matricula: 'N4142R',
            modelo: 'Seneca V',
          },
        }),
      }),
    );
    expect(p.lineas.map((l) => [l.clave, l.monto_usd])).toEqual([
      ['TIEMPO_VUELO', 1600],
      ['TUAS', 80],
      ['EXTRA', 170],
      ['COMISION_VENDEDOR', 280],
      ['IVA', 340.8],
    ]);
    expect(p.lineas[0]).toMatchObject({ cantidad: 1.6, unitario: 1000 });
    expect(p.particion_fuente).toBe('columnas');
    expect(p.pago_vendedor_usd).toBe(324.8);
    expect(p.iva_pct).toBe(16);
    expect(p.horas_cotizadas_hr).toBe(1.6); // cae a tiempo_cobrable_hr
    expect(p.tuas_exentos).toEqual([]);
    // Sin ficha cotizada ni snapshot: se anuncia el avión operativo como tal.
    expect(p.aeronave_cotizada_matricula).toBeNull();
    expect(p.aeronave_operativa).toBe('Seneca V · N4142R');
  });

  it('CANCELADO con comisión: pago al vendedor 0 explícito (no se provisiona)', () => {
    const p = armarCotizacionInternaPayload(
      insumos({ quote: quote({ estado: 'CANCELADO' }), cobros: [] }),
    );
    expect(p.pago_vendedor_usd).toBe(0);
    expect(p.neto_vuelatour_usd).toBeNull();
    expect(p.iva_comision_vendedor_usd).toBe(0);
    expect(p.semaforo_cobro).toBe('gris');
    expect(p.semaforo_cobro_label).toBe('—');
  });
});

describe('armarCotizacionInternaPayload — itinerario y horas', () => {
  it('con tacos: 4 × 0.4 h = 1.6 h voladas, horas cotizadas por tramo cruzadas por orden y par origen/destino', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.tramos).toHaveLength(4);
    expect(p.tramos.map((t) => t.horas_taco)).toEqual([0.4, 0.4, 0.4, 0.4]);
    expect(p.tramos.map((t) => t.horas_cotizadas)).toEqual([
      0.4, 0.4, 0.4, 0.4,
    ]);
    expect(p.tramos[0]).toMatchObject({
      orden: 1,
      orden_real: 1,
      origen: 'CUN',
      destino: 'CZM',
      pasajeros: 4,
      matricula: 'N4142R', // herencia del vuelo
      piloto: 'Luis Ramírez', // herencia del vuelo
      taco_salida: 1200,
      taco_llegada: 1200.4,
      taco_salida_origen: 'DEDUCIDO',
      taco_llegada_origen: 'PILOTO',
      cancelado: false,
    });
    expect(p.horas_voladas_hr).toBe(1.6);
    expect(p.horas_cotizadas_hr).toBe(1.6); // vuelo 1.0 + calzos 0.6
    expect(p.delta_horas_hr).toBe(0); // voladas − cotizadas, ya calculado aquí
    expect(p.vuelo_hr).toBe(1.0);
    expect(p.calzos_hr).toBe(0.6);
    expect(p.tiempo_cobrable_hr).toBe(1.6);
    expect(p.hora_minima_aplicada).toBe(false);
  });

  it('sin tacos: horas_taco null por tramo y horas_voladas null (nunca 0 falso); cotizadas intactas', () => {
    const sinTacos = escalasConTacos().map((e) => ({
      ...e,
      taco_salida: null,
      taco_llegada: null,
    }));
    const p = armarCotizacionInternaPayload(insumos({ escalas: sinTacos }));
    expect(p.tramos.every((t) => t.horas_taco === null)).toBe(true);
    expect(p.horas_voladas_hr).toBeNull();
    expect(p.delta_horas_hr).toBeNull();
    expect(p.horas_cotizadas_hr).toBe(1.6);
  });

  it('tramo cancelado se marca y NO suma horas; tramo operativo de otra base no hereda horas cotizadas ajenas', () => {
    const escalas = [
      // Ferry operativo agregado a mano (orden 100) desde otra base.
      escala(100, 'MID', 'CUN', {
        es_ferry: true,
        solo_operativa: true,
        taco_salida: 1199.0,
        taco_llegada: 1200.0,
        pasajeros: 0,
      }),
      ...escalasConTacos().map((e, i) =>
        i === 3
          ? {
              ...e,
              cancelada_at: '2026-09-03T19:00:00.000Z',
              cancelada_motivo: 'Cliente se quedó',
            }
          : e,
      ),
    ];
    const p = armarCotizacionInternaPayload(insumos({ escalas }));
    // Numeración visible 1..5, orden real conservado.
    expect(p.tramos.map((t) => t.orden)).toEqual([1, 2, 3, 4, 5]);
    expect(p.tramos.map((t) => t.orden_real)).toEqual([1, 2, 3, 4, 100]);
    const ferry = p.tramos[4];
    expect(ferry).toMatchObject({
      es_ferry: true,
      solo_operativa: true,
      pasajeros: 0,
      horas_taco: 1.0,
      horas_cotizadas: null,
    });
    const cancelado = p.tramos[3];
    expect(cancelado).toMatchObject({
      cancelado: true,
      cancelada_motivo: 'Cliente se quedó',
      horas_taco: 0.4,
    });
    // 0.4 × 3 vivos + 1.0 ferry = 2.2 (el cancelado no suma).
    expect(p.horas_voladas_hr).toBe(2.2);
    // La ruta ignora el cancelado.
    expect(p.ruta).toBe('CUN → CZM → CUN → CZM → MID → CUN');
  });

  it('sin escalas vivas cae al itinerario del snapshot (sin tacos)', () => {
    const p = armarCotizacionInternaPayload(insumos({ escalas: [] }));
    expect(p.tramos).toHaveLength(4);
    expect(p.tramos[1]).toMatchObject({
      origen: 'CZM',
      destino: 'CUN',
      horas_cotizadas: 0.4,
      horas_taco: null,
      matricula: 'N4142R',
    });
    expect(p.horas_voladas_hr).toBeNull();
  });

  it('helper horasTacoDe: 1 decimal, null sin ambos', () => {
    expect(horasTacoDe(1200, 1200.4)).toBe(0.4);
    expect(horasTacoDe('1200', '')).toBeNull();
    expect(horasTacoDe('1200.0', '1201.65')).toBe(1.7);
    expect(horasTacoDe(1200, null)).toBeNull();
  });
});

describe('armarCotizacionInternaPayload — cobros', () => {
  it('cobro Paywise de la foto: bruto, comisión 8.857 % = 3,236.36, neto 33,303.64, USD por cobrosEnUsd, conciliado; total/saldo/semáforo', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.cobros).toHaveLength(1);
    const c = p.cobros[0];
    expect(c).toMatchObject({
      fecha: '2026-09-03T18:30:00.000Z',
      metodo: 'PAYWISE',
      metodo_label: 'Paywise',
      monto: 36540,
      moneda: 'MXN',
      tc: 14.79,
      comision_pct: 8.857,
      comision_monto: 3236.36,
      neto: 33303.64,
      cuenta_destino: 'Paywise',
      referencia: 'PW-88123',
      conciliado: true,
      es_reembolso: false,
      sobre_grupo_folio: null,
      registrado_por: 'Ana Admin',
    });
    // 36,540 / 14.79 = 2,470.59 USD.
    expect(c.monto_usd).toBe(2470.59);
    expect(p.total_cobrado_usd).toBe(2470.59);
    expect(p.cobros_sin_tc_count).toBe(0);
    // Comisión bancaria a USD con la misma regla: 3,236.36 / 14.79.
    expect(p.comision_banco_usd).toBe(218.82);
    expect(p.total_cobrado_neto_usd).toBe(2251.77);
    // Saldo crudo 0.21 (redondeo multi-moneda) → tolerancia: COBRADO/verde.
    expect(p.saldo_usd).toBe(0.21);
    expect(p.cobrado_flag).toBe(false);
    expect(p.semaforo_cobro).toBe('verde');
    expect(p.semaforo_cobro_key).toBe('COBRADO');
  });

  it('sin cobros: lista vacía, cobrado 0, saldo = total, semáforo rojo; sin gastos → utilidad null', () => {
    const p = armarCotizacionInternaPayload(insumos({ cobros: [] }));
    expect(p.cobros).toEqual([]);
    expect(p.total_cobrado_usd).toBe(0);
    expect(p.saldo_usd).toBe(2470.8);
    expect(p.comision_banco_usd).toBe(0);
    expect(p.total_cobrado_neto_usd).toBeNull();
    expect(p.semaforo_cobro).toBe('rojo');
    expect(p.semaforo_cobro_label).toBe('Sin cobro');
    expect(p.gastos_total_usd).toBeNull();
    expect(p.utilidad_bruta_usd).toBeNull();
  });

  it('abono parcial USD + reembolso + parte de sobre de grupo + MXN sin TC (se expone, no se suma); orden cronológico', () => {
    const q = quote({ tc_usd_mxn: null });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: q,
        cobros: [
          cobroPaywise({
            id: 'b2',
            monto: -200,
            moneda: 'USD',
            metodo_cobro: 'TRANSFERENCIA',
            tc_usd_mxn: null,
            comision_banco_pct: null,
            comision_banco_monto: null,
            fecha_cobro: '2026-09-05T10:00:00.000Z',
            conciliado: false,
            movimiento_bancario_id: null,
          }),
          cobroPaywise({
            id: 'b1',
            monto: 1000,
            moneda: 'USD',
            metodo_cobro: 'TRANSFERENCIA',
            tc_usd_mxn: null,
            comision_banco_pct: null,
            comision_banco_monto: null,
            fecha_cobro: '2026-09-01T10:00:00.000Z',
            cobro_grupo_id: 's1',
            grupo_factor: 0.5,
            cobro_grupo: { grupo_folio: 12, monto_total: 2000, moneda: 'USD' },
          }),
          cobroPaywise({
            id: 'b3',
            monto: 5000,
            moneda: 'MXN',
            metodo_cobro: 'EFECTIVO',
            tc_usd_mxn: null,
            comision_banco_pct: null,
            comision_banco_monto: null,
            fecha_cobro: '2026-09-06T10:00:00.000Z',
            conciliado: false,
          }),
        ],
      }),
    );
    expect(p.cobros.map((c) => c.fecha)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-05T10:00:00.000Z',
      '2026-09-06T10:00:00.000Z',
    ]);
    expect(p.cobros[0]).toMatchObject({
      monto: 1000,
      neto: 1000,
      comision_monto: null,
      monto_usd: 1000,
      sobre_grupo_folio: 'G-12',
      sobre_grupo_monto_total: 2000,
      grupo_factor: 0.5,
      conciliado: true,
    });
    expect(p.cobros[1]).toMatchObject({
      monto: -200,
      es_reembolso: true,
      monto_usd: -200,
      conciliado: false,
    });
    // MXN sin TC de cobro ni del vuelo: no convierte, se expone.
    expect(p.cobros[2]).toMatchObject({
      moneda: 'MXN',
      monto_usd: null,
      metodo_label: 'Efectivo',
    });
    expect(p.total_cobrado_usd).toBe(800);
    expect(p.cobros_sin_tc_count).toBe(1);
    expect(p.cobros_sin_tc_mxn).toBe(5000);
    expect(p.saldo_usd).toBe(1670.8);
    expect(p.semaforo_cobro).toBe('amarillo');
    expect(p.semaforo_cobro_key).toBe('PARCIAL');
  });

  it('bandera cobrado del vuelo manda: verde aunque el lote no cuadre', () => {
    const p = armarCotizacionInternaPayload(
      insumos({ quote: quote({ cobrado: true }), cobros: [] }),
    );
    expect(p.semaforo_cobro).toBe('verde');
    expect(p.cobrado_flag).toBe(true);
  });
});

describe('armarCotizacionInternaPayload — multi-avión, gastos y CFDI', () => {
  it('multi-avión: ida en Seneca, regreso en Kodiak → mitad y mitad de la venta del avión (repartirUsd, Σ exacta)', () => {
    const escalas = [
      escala(1, 'CUN', 'CZM', {
        aeronave_id: SENECA,
        taco_salida: 1200,
        taco_llegada: 1200.4,
      }),
      escala(2, 'CZM', 'CUN', {
        aeronave_id: KODIAK,
        taco_salida: 500,
        taco_llegada: 500.6,
      }),
    ];
    const p = armarCotizacionInternaPayload(insumos({ escalas }));
    expect(p.participacion_aviones).toHaveLength(2);
    expect(p.participacion_aviones[0]).toMatchObject({
      aeronave_id: SENECA,
      matricula: 'N4142R',
      factor: 0.5,
      tramos: 1,
      venta_usd: 928,
    });
    expect(p.participacion_aviones[1]).toMatchObject({
      aeronave_id: KODIAK,
      matricula: 'N621TX',
      factor: 0.5,
      tramos: 1,
      venta_usd: 928,
    });
    const suma = p.participacion_aviones.reduce(
      (acc, a) => acc + a.venta_usd,
      0,
    );
    expect(suma).toBe(p.venta_avion_usd);
    // Matrícula por tramo con el avión de cada uno.
    expect(p.tramos.map((t) => t.matricula)).toEqual(['N4142R', 'N621TX']);
    expect(p.horas_voladas_hr).toBe(1.0);
  });

  it('gastos por categoría en USD (MXN ÷ tc_gasto, respaldo TC del vuelo, sin TC se expone) + utilidad bruta de referencia sobre lo cobrado', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        gastos: [
          { categoria: 'GAS', monto: 100, moneda: 'USD', tc_gasto: null },
          { categoria: 'GAS', monto: 1479, moneda: 'MXN', tc_gasto: 14.79 }, // 100 USD
          { categoria: 'COMIDA', monto: 295.8, moneda: 'MXN', tc_gasto: null }, // respaldo TC vuelo → 20 USD
          {
            categoria: 'PERSONAL_DUENO',
            monto: 999,
            moneda: 'USD',
            tc_gasto: null,
          }, // fuera
        ],
      }),
    );
    expect(p.gastos_por_categoria).toEqual([
      {
        categoria: 'GAS',
        etiqueta: 'Gasavión / Turbosina',
        total_usd: 200,
        n: 2,
      },
      { categoria: 'COMIDA', etiqueta: 'Comida', total_usd: 20, n: 1 },
    ]);
    expect(p.gastos_total_usd).toBe(220);
    expect(p.gastos_sin_tc_count).toBe(0);
    expect(p.utilidad_base).toBe('cobrado');
    // 2,470.59 cobrado − 220.
    expect(p.utilidad_bruta_usd).toBe(2250.59);

    const sinTc = armarCotizacionInternaPayload(
      insumos({
        quote: quote({ tc_usd_mxn: null }),
        cobros: [],
        gastos: [
          { categoria: 'HOTEL', monto: 1500, moneda: 'MXN', tc_gasto: null },
        ],
      }),
    );
    expect(sinTc.gastos_por_categoria).toEqual([]);
    expect(sinTc.gastos_sin_tc_count).toBe(1);
    expect(sinTc.gastos_sin_tc_mxn).toBe(1500);
    expect(sinTc.gastos_total_usd).toBe(0);
    expect(sinTc.utilidad_base).toBe('total');
    expect(sinTc.utilidad_bruta_usd).toBe(2470.8);
  });

  it('externo: el costo del operador entra a los gastos y a la utilidad', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          es_externo: true,
          costo_externo_usd: 1500,
          aeronave_operativa: null,
        }),
        gastos: [
          { categoria: 'FBO', monto: 50, moneda: 'USD', tc_gasto: null },
        ],
      }),
    );
    expect(p.gastos_total_usd).toBe(1550);
    expect(p.utilidad_bruta_usd).toBe(920.59);
  });

  it('CFDI: factura vigente manda; cancelada se etiqueta; sin factura y bandera facturado se aclara', () => {
    const timbrada = armarCotizacionInternaPayload(
      insumos({
        facturas: [
          {
            serie: 'A',
            folio: 120,
            uuid_fiscal: 'uuid-1',
            estado: 'TIMBRADA',
            total: 36543.13,
            moneda: 'MXN',
            fecha_timbrado: '2026-09-04T12:00:00.000Z',
            facturado_a_nombre: 'Viajes Caribe',
            cancelada_at: '2026-09-05T12:00:00.000Z',
          },
          {
            serie: 'A',
            folio: 121,
            uuid_fiscal: 'uuid-2',
            estado: 'TIMBRADA',
            total: 36543.13,
            moneda: 'MXN',
            fecha_timbrado: '2026-09-05T13:00:00.000Z',
            facturado_a_nombre: 'Viajes Caribe',
            cancelada_at: null,
          },
        ],
      }),
    );
    expect(timbrada.facturas).toHaveLength(2);
    expect(timbrada.facturas[0].cancelada).toBe(true);
    expect(timbrada.cfdi_estatus).toBe('TIMBRADA');
    expect(timbrada.cfdi_folio).toBe('A-121');

    const cancelada = armarCotizacionInternaPayload(
      insumos({
        facturas: [
          {
            serie: null,
            folio: null,
            uuid_fiscal: 'uuid-9',
            estado: 'TIMBRADA',
            cancelada_at: '2026-09-05T12:00:00.000Z',
          },
        ],
      }),
    );
    expect(cancelada.cfdi_estatus).toBe('CANCELADA');
    expect(cancelada.cfdi_folio).toBe('uuid-9');

    const bandera = armarCotizacionInternaPayload(
      insumos({ quote: quote({ facturado: true }) }),
    );
    expect(bandera.cfdi_estatus).toContain('Facturado');
    expect(bandera.cfdi_folio).toBeNull();
    const nada = armarCotizacionInternaPayload(insumos());
    expect(nada.cfdi_estatus).toBeNull();
  });

  it('hijo de grupo y vuelo combinado se anuncian', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          grupo_id: 'g1',
          grupo_posicion: 2,
          grupo: { id: 'g1', folio: 12, nombre: 'Boda', pasajeros_total: 20 },
          combinado: [{ folio: 1040 }],
          calculo_snapshot: snapshot({
            meta: {
              ...(snapshot().meta as object),
              grupo: {
                id: 'g1',
                folio: 12,
                posicion: 2,
                total_aviones: 3,
                pax: 4,
              },
            },
          }),
        }),
      }),
    );
    expect(p.grupo_folio).toBe('G-12');
    expect(p.grupo_posicion).toBe(2);
    expect(p.grupo_total_aviones).toBe(3);
    expect(p.combinado_con_folio).toBe('1040');
  });
});
