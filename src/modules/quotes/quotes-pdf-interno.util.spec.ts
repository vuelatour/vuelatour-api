import {
  armarCotizacionInternaPayload,
  horasAHhmm,
  nombreCortoAeropuerto,
  type AeropuertoInternoRow,
  type CobroInternoRow,
  type CotizacionInternaInsumos,
  type EscalaInternaRow,
} from './quotes-pdf-interno.util';

/**
 * Armador del PDF «Cotización interna» v2 (feedback de administración
 * 8-sep-2026): SOLO lo de la cotización. Caso base = foto del cliente:
 * Seneca N4142R, 4 tramos CUN↔CZM de 0.4 h cotizadas (con calzo) × $1,000
 * = $400 c/u (Σ $1,600 == TIEMPO_VUELO), TUA CZM cobrada ($80) y CUN exenta,
 * comisión del vendedor "Saab" $280, cobro Paywise en MXN con comisión
 * bancaria 8.857 % = $3,236.36 → neto $33,303.64. Nada se recalcula: el
 * armador solo LEE el snapshot y las fuentes únicas; el único número nuevo es
 * el total por tramo (tiempo × tarifa) y su ajuste explícito contra la línea
 * canónica.
 */
const SENECA = 'aaaaaaaa-0000-0000-0000-00000000a142';
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
    ruta: {
      ruta_id: null,
      origen_iata: 'CUN',
      destino_iata: 'CUN',
      millas_nauticas_base: 240,
      millas_nauticas_totales: 240,
      es_redondo_auto: false,
      num_aterrizajes: 4,
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
      tramoSnap(1, 'CUN', 'CZM'),
      tramoSnap(2, 'CZM', 'CUN', { tuas_usd: 80 }),
      tramoSnap(3, 'CUN', 'CZM'),
      tramoSnap(4, 'CZM', 'CUN'),
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

/** Tramo del snapshot (millas 60 @ 170 kts + calzo 0.15 → 0.4 h redondeado como el motor). */
function tramoSnap(
  orden: number,
  origen: string,
  destino: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orden,
    origen,
    destino,
    millas: 60,
    pasajeros: 4,
    es_ferry: false,
    tiempo_hr: 0.4,
    tuas_usd: 0,
    requiere_pernocta: false,
    pernocta_usd: 0,
    tipo_parada: null,
    servicio_notas: null,
    pdf_oculto: false,
    ...extra,
  };
}

/**
 * Snapshot "solo servicio aéreo" (sin TUAS/extras/comisión/IVA) para probar
 * la conciliación tramos ↔ TIEMPO_VUELO con distintos tiempos.
 */
function snapshotSoloTiempo(args: {
  tramos: Array<Record<string, unknown>>;
  tiempos: Record<string, unknown>;
  tarifa?: number;
  tiempoVueloUsd: number;
  meta?: Record<string, unknown>;
}): Record<string, unknown> {
  const tarifa = args.tarifa ?? 1000;
  return snapshot({
    tramos: args.tramos,
    tiempos: {
      cobrable_proviene_de_override: false,
      sobrevuelo_hr: 0,
      minimo_hora_aplicado: false,
      ...args.tiempos,
    },
    tarifa: {
      tipo: 'PUBLICO',
      usd_por_hora: tarifa,
      proviene_de_override: false,
      preferencial_cliente: false,
    },
    tuas: { pasajeros: 4, aeropuertos: [], filas: [], total_usd: 0 },
    extras: [],
    iva: { porcentaje: 0, base_usd: 0, monto_usd: 0, nota: null },
    desglose: [
      {
        clave: 'TIEMPO_VUELO',
        concepto: 'Tiempo de vuelo',
        monto_usd: args.tiempoVueloUsd,
      },
    ],
    totales: {
      subtotal_vuelo_usd: args.tiempoVueloUsd,
      tuas_total_usd: 0,
      viaticos_pernocta_usd: 0,
      extras_total_usd: 0,
      ajuste_final_usd: 0,
      iva_usd: 0,
      total_usd: args.tiempoVueloUsd,
      total_mxn: null,
    },
    meta: {
      version_motor: '1.3.1',
      comision_vendedor_usd: 0,
      comision_vendedor_nombre: null,
      comision_vendedor_modo: null,
      ...(args.meta ?? {}),
    },
  });
}

/** Columnas espejo del vuelo para un snapshot "solo servicio aéreo". */
function quoteSoloTiempo(
  snap: Record<string, unknown>,
  tiempoVueloUsd: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return quote({
    calculo_snapshot: snap,
    subtotal_vuelo_usd: tiempoVueloUsd,
    tuas_usd: 0,
    extras_total_usd: 0,
    comision_vendedor_usd: 0,
    comision_vendedor_nombre: null,
    comision_vendedor_modo: null,
    iva_usd: 0,
    iva_pct: 0,
    monto_total_usd: tiempoVueloUsd,
    monto_total_mxn: null,
    extras: [],
    ...extra,
  });
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
    tipo: 'MULTIESCALA',
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
    // 09:00 Cancún del 3-sep.
    fecha_vuelo: '2026-09-03T14:00:00.000Z',
    fecha_traslado_final: '2026-09-03T20:00:00.000Z',
    fecha_fin: null,
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

/** Escala mínima (solo lo que fecha el tramo): plan a las 11/12/13/14 Z del 3-sep = madrugada/mañana Cancún. */
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
    fecha_salida_plan: `2026-09-03T1${orden}:00:00.000Z`,
    pdf_fecha: null,
    solo_operativa: false,
    cancelada_at: null,
    ...extra,
  };
}

function escalasPlan(): EscalaInternaRow[] {
  return [
    escala(1, 'CUN', 'CZM'),
    escala(2, 'CZM', 'CUN'),
    escala(3, 'CUN', 'CZM'),
    escala(4, 'CZM', 'CUN'),
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

/** Catálogo `aeropuerto` como está en prod (comas, espacios sobrantes, minúsculas, nulos). */
function aeropuertos(): Map<string, AeropuertoInternoRow> {
  return new Map<string, AeropuertoInternoRow>([
    [
      'CUN',
      {
        iata: 'CUN',
        nombre: 'Aeropuerto Internacional de Cancun',
        ciudad: 'Cancun',
      },
    ],
    [
      'CZM',
      {
        iata: 'CZM',
        nombre: 'Aeropuerto Internacional de Cozumel',
        ciudad: 'Cozumel',
      },
    ],
    [
      'MID',
      {
        iata: 'MID',
        nombre: 'Aeropuerto Internacional de Merida',
        ciudad: 'Merida',
      },
    ],
    [
      'TGZ',
      {
        iata: 'TGZ',
        nombre: 'TUXTLA Angel Albino Corzo',
        ciudad: 'Tuxtla Gutierrez, Chiapas, MX',
      },
    ],
    ['FCQ', { iata: 'FCQ', nombre: 'Felipe Carrillo Puerto', ciudad: null }],
    ['CET', { iata: 'CET', nombre: 'TOLEDO', ciudad: 'cozumel' }],
  ]);
}

function insumos(
  over: Partial<CotizacionInternaInsumos> = {},
): CotizacionInternaInsumos {
  return {
    quote: quote(),
    escalas: escalasPlan(),
    cobros: [cobroPaywise()],
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
    aeropuertoPorIata: aeropuertos(),
    apoyos: [],
    creadoPorId: ADMIN,
    generadoPor: 'Ana Admin',
    ahora: new Date('2026-09-08T19:32:00.000Z'),
    ...over,
  };
}

/** Claves retiradas del contrato v2 (operación / partición / gastos / CFDI / traslados). */
const CLAVES_RETIRADAS = [
  'aeronave_operativa',
  'fecha_traslado_inicial',
  'fecha_traslado_final',
  'tramos',
  'horas_voladas_hr',
  'delta_horas_hr',
  'tuas_exentos',
  'neto_vuelatour_usd',
  'venta_avion_usd',
  'otros_ingresos_vuelatour_usd',
  'iva_avion_usd',
  'iva_vuelatour_usd',
  'particion_fuente',
  'particion_inconsistente',
  'participacion_aviones',
  'gastos_por_categoria',
  'gastos_total_usd',
  'costo_externo_usd',
  'utilidad_bruta_usd',
  'utilidad_base',
  'facturado',
  'facturas',
  'cfdi_estatus',
  'cfdi_folio',
];

describe('armarCotizacionInternaPayload — cabecera y pie', () => {
  it('cabecera: fecha del VUELO protagonista (día Cancún), fecha de cotización en pequeño, cliente, avión cotizado con matrícula, piloto, TC, vendedor; nada operativo ni de partición viaja', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.folio).toBe('1042');
    expect(p.version).toBe(3);
    expect(p.estado).toBe('COMPLETADO');
    expect(p.estado_label).toBe('Completado');
    expect(p.cliente).toBe('Juan Pérez');
    expect(p.razon_social).toBe('Viajes Caribe SA de CV');
    expect(p.cliente_rfc).toBe('VCA010101AAA');
    // 2026-09-03T14:00Z = 09:00 Cancún → mismo día.
    expect(p.fecha_vuelo).toBe('2026-09-03');
    expect(p.fecha_vuelo_fin).toBeNull();
    expect(p.fecha).toBe('2026-08-28T16:00:00.000Z');
    expect(p.fecha_confirmacion).toBe('2026-08-29T10:00:00.000Z');
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
    expect(p.piloto).toBe('Luis Ramírez');
    expect(p.copiloto).toBeNull();
    expect(p.pasajeros).toBe(4);
    expect(p.ruta).toBe('CUN → CZM → CUN → CZM → CUN');
    expect(p.notas_cliente).toBe('Cliente pide agua fría');
    expect(p.notas_internas).toBe('Cobrado en Paywise el 3 sep');
    // Pie: instante ISO + versión Cancún (UTC−5) + usuario.
    expect(p.generado).toBe('2026-09-08T19:32:00.000Z');
    expect(p.generado_cancun).toBe('2026-09-08 14:32');
    expect(p.generado_por).toBe('Ana Admin');
    for (const k of CLAVES_RETIRADAS) expect(p).not.toHaveProperty(k);
  });

  it('viaje multi-día: fecha_vuelo_fin solo cuando el último día (Cancún) difiere', () => {
    const multi = armarCotizacionInternaPayload(
      insumos({ quote: quote({ fecha_fin: '2026-09-05T20:00:00.000Z' }) }),
    );
    expect(multi.fecha_vuelo).toBe('2026-09-03');
    expect(multi.fecha_vuelo_fin).toBe('2026-09-05');
    // 2026-09-04T03:00Z = 22:00 Cancún del 3-sep → mismo día, no se repite.
    const mismoDia = armarCotizacionInternaPayload(
      insumos({ quote: quote({ fecha_fin: '2026-09-04T03:00:00.000Z' }) }),
    );
    expect(mismoDia.fecha_vuelo_fin).toBeNull();
  });

  it('externo: avión ajeno y operador; el cotizado sigue siendo el del snapshot', () => {
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
    expect(externo.aeronave_cotizada_matricula).toBe('N4142R');
  });

  it('sin snapshot ni ficha cotizada: el avión cotizado cae al avión del vuelo', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({ calculo_snapshot: null, aeronave_cotizada: null }),
      }),
    );
    expect(p.aeronave_cotizada_modelo).toBe('Seneca V');
    expect(p.aeronave_cotizada_matricula).toBe('N4142R');
  });
});

describe('armarCotizacionInternaPayload — tramos cotizados (tabla de administración)', () => {
  it('foto del cliente: 4 tramos de 0.4 h (con calzo) × $1,000 = $400 c/u, ruta con ciudad, hh:mm, fecha del plan por tramo; Σ == TIEMPO_VUELO sin ajuste', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.tramos_cotizados).toHaveLength(4);
    expect(p.tramos_cotizados[0]).toEqual({
      orden: 1,
      ruta: 'Cancun-Cozumel',
      origen_iata: 'CUN',
      destino_iata: 'CZM',
      origen_nombre: 'Cancun',
      destino_nombre: 'Cozumel',
      fecha: '2026-09-03',
      millas: 60,
      tiempo_hr: 0.4,
      tiempo_hhmm: '00:24',
      tarifa_hora_usd: 1000,
      total_usd: 400,
      pax: 4,
      es_ferry: false,
      pernocta: false,
      pernocta_usd: 0,
      tuas_usd: 0,
      consolidado: false,
    });
    expect(p.tramos_cotizados.map((t) => t.ruta)).toEqual([
      'Cancun-Cozumel',
      'Cozumel-Cancun',
      'Cancun-Cozumel',
      'Cozumel-Cancun',
    ]);
    expect(p.tramos_cotizados.map((t) => t.fecha)).toEqual([
      '2026-09-03',
      '2026-09-03',
      '2026-09-03',
      '2026-09-03',
    ]);
    expect(p.tramos_cotizados[1].tuas_usd).toBe(80);
    expect(p.tramos_tiempo_total_hr).toBe(1.6);
    expect(p.tramos_tiempo_total_hhmm).toBe('01:36');
    expect(p.tramos_total_usd).toBe(1600);
    expect(p.tramos_ajuste_usd).toBe(0);
    expect(p.tramos_ajuste_motivo).toBeNull();
    const tiempoVuelo = p.lineas.find((l) => l.clave === 'TIEMPO_VUELO')!;
    expect(p.tramos_total_usd + p.tramos_ajuste_usd).toBe(
      tiempoVuelo.monto_usd,
    );
    // Escalares de horas del snapshot siguen (son de la cotización).
    expect(p.horas_cotizadas_hr).toBe(1.6);
    expect(p.vuelo_hr).toBe(1.0);
    expect(p.calzos_hr).toBe(0.6);
    expect(p.tiempo_cobrable_hr).toBe(1.6);
    expect(p.hora_minima_aplicada).toBe(false);
    expect(p.cobrable_override).toBe(false);
  });

  it('ejemplo del formato de administración: Cancun-Merida, 157 millas, 1.3 h × $900 = $1,170 → "01:18", fecha 26-jun del plan', () => {
    const snap = snapshotSoloTiempo({
      tramos: [
        tramoSnap(1, 'CUN', 'MID', {
          millas: 157,
          pasajeros: 3,
          tiempo_hr: 1.3,
        }),
      ],
      tiempos: { vuelo_hr: 1.15, calzos_hr: 0.15, cobrable_hr: 1.3 },
      tarifa: 900,
      tiempoVueloUsd: 1170,
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 1170, {
          tarifa_hora_usd: 900,
          tiempo_cobrable_hr: 1.3,
          fecha_vuelo: '2026-06-26T13:00:00.000Z',
        }),
        escalas: [
          escala(1, 'CUN', 'MID', {
            fecha_salida_plan: '2026-06-26T13:00:00.000Z',
          }),
        ],
        cobros: [],
      }),
    );
    expect(p.tramos_cotizados).toHaveLength(1);
    expect(p.tramos_cotizados[0]).toMatchObject({
      ruta: 'Cancun-Merida',
      fecha: '2026-06-26',
      millas: 157,
      tiempo_hr: 1.3,
      tiempo_hhmm: '01:18',
      tarifa_hora_usd: 900,
      total_usd: 1170,
      pax: 3,
    });
    expect(p.tramos_total_usd).toBe(1170);
    expect(p.tramos_ajuste_usd).toBe(0);
    expect(p.tramos_ajuste_motivo).toBeNull();
    expect(p.fecha_vuelo).toBe('2026-06-26');
  });

  it('hora mínima: 2 tramos de 0.4 h (0.8 h) cobrados como 1.0 h → Σ tramos $800 y ajuste +$200 "Hora mínima 1.0 h" (Σ + ajuste == canónico)', () => {
    const snap = snapshotSoloTiempo({
      tramos: [tramoSnap(1, 'CUN', 'CZM'), tramoSnap(2, 'CZM', 'CUN')],
      tiempos: {
        vuelo_hr: 0.5,
        calzos_hr: 0.3,
        cobrable_hr_regla: 1,
        cobrable_hr: 1,
        minimo_hora_aplicado: true,
      },
      tiempoVueloUsd: 1000,
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 1000, { tiempo_cobrable_hr: 1 }),
        escalas: [escala(1, 'CUN', 'CZM'), escala(2, 'CZM', 'CUN')],
        cobros: [],
      }),
    );
    expect(p.tramos_cotizados.map((t) => t.total_usd)).toEqual([400, 400]);
    expect(p.tramos_tiempo_total_hr).toBe(0.8);
    expect(p.tramos_total_usd).toBe(800);
    expect(p.tramos_ajuste_usd).toBe(200);
    expect(p.tramos_ajuste_motivo).toBe('Hora mínima 1.0 h');
    expect(p.hora_minima_aplicada).toBe(true);
    expect(p.tramos_total_usd + p.tramos_ajuste_usd).toBe(1000);
    // El desglose canónico NO se toca: la línea sigue en $1,000.
    expect(p.lineas.find((l) => l.clave === 'TIEMPO_VUELO')!.monto_usd).toBe(
      1000,
    );
    expect(p.subtotal_vuelo_usd).toBe(1000);
  });

  it('sobrevuelo: horas globales fuera de los tramos → ajuste con motivo "Sobrevuelo 0.5 h"', () => {
    const snap = snapshotSoloTiempo({
      tramos: [
        tramoSnap(1, 'CUN', 'CZM'),
        tramoSnap(2, 'CZM', 'CUN'),
        tramoSnap(3, 'CUN', 'CZM'),
        tramoSnap(4, 'CZM', 'CUN'),
      ],
      tiempos: {
        vuelo_hr: 1.0,
        calzos_hr: 0.6,
        sobrevuelo_hr: 0.5,
        cobrable_hr_regla: 2.1,
        cobrable_hr: 2.1,
      },
      tiempoVueloUsd: 2100,
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 2100, { tiempo_cobrable_hr: 2.1 }),
        cobros: [],
      }),
    );
    expect(p.tramos_total_usd).toBe(1600);
    expect(p.tramos_ajuste_usd).toBe(500);
    expect(p.tramos_ajuste_motivo).toBe('Sobrevuelo 0.5 h');
    expect(p.sobrevuelo_hr).toBe(0.5);
    expect(p.horas_cotizadas_hr).toBe(2.1);
  });

  it('horas pactadas a mano (cobrable override): motivo "Horas pactadas 2 h"', () => {
    const snap = snapshotSoloTiempo({
      tramos: [
        tramoSnap(1, 'CUN', 'CZM'),
        tramoSnap(2, 'CZM', 'CUN'),
        tramoSnap(3, 'CUN', 'CZM'),
        tramoSnap(4, 'CZM', 'CUN'),
      ],
      tiempos: {
        vuelo_hr: 1.0,
        calzos_hr: 0.6,
        cobrable_hr_regla: 1.6,
        cobrable_hr: 2,
        cobrable_proviene_de_override: true,
      },
      tiempoVueloUsd: 2000,
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 2000, { tiempo_cobrable_hr: 2 }),
        cobros: [],
      }),
    );
    expect(p.tramos_total_usd).toBe(1600);
    expect(p.tramos_ajuste_usd).toBe(400);
    expect(p.tramos_ajuste_motivo).toBe('Horas pactadas 2 h');
    expect(p.cobrable_override).toBe(true);
  });

  it('redondeo del motor: 3 × round2(0.4167 h × $950) = $1,187.61 vs canónico $1,187.60 → ajuste −0.01 "Redondeo" (nunca se reparte entre tramos)', () => {
    const snap = snapshotSoloTiempo({
      tramos: [
        tramoSnap(1, 'CUN', 'MID', { millas: 45, tiempo_hr: 0.4167 }),
        tramoSnap(2, 'MID', 'CZM', { millas: 45, tiempo_hr: 0.4167 }),
        tramoSnap(3, 'CZM', 'CUN', { millas: 45, tiempo_hr: 0.4167 }),
      ],
      tiempos: { vuelo_hr: 0.8001, calzos_hr: 0.45, cobrable_hr: 1.2501 },
      tarifa: 950,
      tiempoVueloUsd: 1187.6,
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 1187.6, {
          tarifa_hora_usd: 950,
          tiempo_cobrable_hr: 1.2501,
        }),
        escalas: [],
        cobros: [],
      }),
    );
    expect(p.tramos_cotizados.map((t) => t.total_usd)).toEqual([
      395.87, 395.87, 395.87,
    ]);
    expect(p.tramos_cotizados.map((t) => t.tiempo_hhmm)).toEqual([
      '00:25',
      '00:25',
      '00:25',
    ]);
    expect(p.tramos_total_usd).toBe(1187.61);
    expect(p.tramos_ajuste_usd).toBe(-0.01);
    expect(p.tramos_ajuste_motivo).toBe('Redondeo');
    expect(p.tramos_tiempo_total_hr).toBe(1.2501);
    expect(p.tramos_tiempo_total_hhmm).toBe('01:15');
  });

  it('cliente interno (tarifa $0): tabla en $0, sin ajuste ni motivo', () => {
    const snap = snapshotSoloTiempo({
      tramos: [tramoSnap(1, 'CUN', 'CZM'), tramoSnap(2, 'CZM', 'CUN')],
      tiempos: { vuelo_hr: 0.5, calzos_hr: 0.3, cobrable_hr: 0.8 },
      tarifa: 0,
      tiempoVueloUsd: 0,
      meta: { cliente_interno: true },
    });
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quoteSoloTiempo(snap, 0, {
          tarifa_hora_usd: 0,
          tiempo_cobrable_hr: 0.8,
        }),
        cobros: [],
      }),
    );
    expect(p.es_interno).toBe(true);
    expect(p.tramos_cotizados.map((t) => t.total_usd)).toEqual([0, 0]);
    expect(p.tramos_cotizados[0].tarifa_hora_usd).toBe(0);
    expect(p.tramos_total_usd).toBe(0);
    expect(p.tramos_ajuste_usd).toBe(0);
    expect(p.tramos_ajuste_motivo).toBeNull();
  });

  it('fecha del tramo: plan de la escala → pdf_fecha → hereda del anterior → día del vuelo; instantes en día Cancún; escala de otro par no cruza', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        escalas: [
          escala(1, 'CUN', 'CZM', {
            fecha_salida_plan: '2026-09-03T14:00:00.000Z',
          }),
          escala(2, 'CZM', 'CUN', {
            fecha_salida_plan: null,
            pdf_fecha: '2026-09-04',
          }),
          escala(3, 'CUN', 'CZM', { fecha_salida_plan: null }),
          // 03:30 Z del 5-sep = 22:30 Cancún del 4-sep.
          escala(4, 'CZM', 'CUN', {
            fecha_salida_plan: '2026-09-05T03:30:00.000Z',
          }),
        ],
      }),
    );
    expect(p.tramos_cotizados.map((t) => t.fecha)).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-04', // hereda del tramo anterior (mismo día)
      '2026-09-04',
    ]);

    // Sin escalas: todos al día del vuelo.
    const sinEscalas = armarCotizacionInternaPayload(insumos({ escalas: [] }));
    expect(sinEscalas.tramos_cotizados.map((t) => t.fecha)).toEqual([
      '2026-09-03',
      '2026-09-03',
      '2026-09-03',
      '2026-09-03',
    ]);

    // Itinerario operativo distinto (otra base): la escala con el mismo
    // orden pero otro par NO fecha el tramo cotizado.
    const ajena = armarCotizacionInternaPayload(
      insumos({
        escalas: [
          escala(1, 'MID', 'CUN', {
            fecha_salida_plan: '2026-09-10T14:00:00.000Z',
          }),
        ],
      }),
    );
    expect(ajena.tramos_cotizados[0].fecha).toBe('2026-09-03');
  });

  it('nombre de aeropuerto: ciudad del catálogo recortada a la coma, sin espacios, inicial mayúscula; fallback nombre; fallback IATA (también en la fila)', () => {
    expect(
      nombreCortoAeropuerto('TGZ', {
        ciudad: 'Tuxtla Gutierrez, Chiapas, MX',
        nombre: 'TUXTLA Angel Albino Corzo',
      }),
    ).toBe('Tuxtla Gutierrez');
    expect(nombreCortoAeropuerto('CPE', { ciudad: 'Campeche ' })).toBe(
      'Campeche',
    );
    expect(
      nombreCortoAeropuerto('CET', { nombre: 'TOLEDO', ciudad: 'cozumel' }),
    ).toBe('Cozumel');
    expect(
      nombreCortoAeropuerto('FCQ', {
        nombre: 'Felipe Carrillo Puerto',
        ciudad: null,
      }),
    ).toBe('Felipe Carrillo Puerto');
    expect(
      nombreCortoAeropuerto('PLJ', { nombre: 'Placencia, BZ', ciudad: null }),
    ).toBe('Placencia');
    expect(nombreCortoAeropuerto('ROA', undefined)).toBe('ROA');
    expect(nombreCortoAeropuerto('FLL', { nombre: '', ciudad: '  ' })).toBe(
      'FLL',
    );

    // En la tabla: ROA no está en el catálogo cargado → IATA en la ruta.
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          calculo_snapshot: snapshot({
            tramos: [
              tramoSnap(1, 'CUN', 'ROA'),
              tramoSnap(2, 'ROA', 'TGZ'),
              tramoSnap(3, 'TGZ', 'CUN'),
            ],
          }),
        }),
        escalas: [],
      }),
    );
    expect(p.tramos_cotizados.map((t) => t.ruta)).toEqual([
      'Cancun-ROA',
      'ROA-Tuxtla Gutierrez',
      'Tuxtla Gutierrez-Cancun',
    ]);
    expect(p.tramos_cotizados[0].destino_nombre).toBe('ROA');
    expect(p.ruta).toBe('CUN → ROA → TGZ → CUN');
  });

  it('helper horasAHhmm: minutos redondeados, dos dígitos', () => {
    expect(horasAHhmm(1.3)).toBe('01:18');
    expect(horasAHhmm(0.4)).toBe('00:24');
    expect(horasAHhmm(2.1)).toBe('02:06');
    expect(horasAHhmm(1.2501)).toBe('01:15');
    expect(horasAHhmm(0)).toBe('00:00');
    expect(horasAHhmm(10.5)).toBe('10:30');
  });

  it('respaldo: snapshot sin tramos → UNA fila consolidada con vuelo+calzos del snapshot; sin snapshot (motor viejo) → fila con el servicio aéreo del vuelo, ajuste 0', () => {
    const viejoSnap = armarCotizacionInternaPayload(
      insumos({
        quote: quote({ calculo_snapshot: snapshot({ tramos: null }) }),
      }),
    );
    expect(viejoSnap.tramos_cotizados).toHaveLength(1);
    expect(viejoSnap.tramos_cotizados[0]).toMatchObject({
      orden: 1,
      consolidado: true,
      ruta: 'Cancun-Cozumel-Cancun-Cozumel-Cancun',
      origen_iata: 'CUN',
      destino_iata: 'CUN',
      fecha: '2026-09-03',
      millas: 240,
      tiempo_hr: 1.6, // vuelo 1.0 + calzos 0.6
      tiempo_hhmm: '01:36',
      tarifa_hora_usd: 1000,
      total_usd: 1600,
      pax: 4,
    });
    expect(viejoSnap.tramos_total_usd).toBe(1600);
    expect(viejoSnap.tramos_ajuste_usd).toBe(0);
    expect(viejoSnap.ruta).toBe('CUN → CZM → CUN → CZM → CUN');

    const sinSnapshot = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          calculo_snapshot: null,
          tipo: 'REDONDO',
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          es_redondo_auto: true,
          millas_nauticas_one_way: 60,
        }),
        escalas: [],
      }),
    );
    expect(sinSnapshot.tramos_cotizados).toHaveLength(1);
    expect(sinSnapshot.tramos_cotizados[0]).toMatchObject({
      consolidado: true,
      ruta: 'Cancun-Cozumel-Cancun',
      millas: 120,
      tiempo_hr: 1.6, // tiempo_cobrable_hr del vuelo
      tarifa_hora_usd: 1000,
      total_usd: 1600, // subtotal_vuelo_usd tal cual
    });
    expect(sinSnapshot.ruta).toBe('CUN → CZM → CUN');
    expect(sinSnapshot.tramos_ajuste_usd).toBe(0);
    expect(sinSnapshot.tramos_ajuste_motivo).toBeNull();
  });
});

describe('armarCotizacionInternaPayload — desglose canónico', () => {
  it('líneas canónicas con su operación; Σ == total; TUAS solo las COBRADAS (la exenta CUN no viaja); comisión con pago al vendedor c/IVA', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.lineas.map((l) => l.clave)).toEqual([
      'TIEMPO_VUELO',
      'TUAS',
      'EXTRA',
      'COMISION_VENDEDOR',
      'IVA',
    ]);
    const suma = p.lineas.reduce((acc, l) => acc + l.monto_usd, 0);
    expect(Math.round(suma * 100) / 100).toBe(2470.8);
    expect(p.total_usd).toBe(2470.8);
    // Ya no hay líneas sintéticas ni bandera de exento.
    expect(p.lineas.every((l) => !('exento' in l))).toBe(true);
    expect(p).not.toHaveProperty('tuas_exentos');

    const tiempo = p.lineas[0];
    expect(tiempo).toMatchObject({
      cantidad: 1.6,
      unitario: 1000,
      moneda: 'USD',
      monto_usd: 1600,
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
    expect(p.tuas_cobradas).toEqual([
      {
        iata: 'CZM',
        pax: 4,
        unitario: 20,
        moneda: 'USD',
        total_nativo: 80,
        tc_aplicado: null,
        total_usd: 80,
      },
    ]);
    const extra = p.lineas[2];
    expect(extra).toMatchObject({
      cantidad: 2,
      unitario: 85,
      moneda: 'USD',
      aplica_iva: true,
      monto_usd: 170,
    });
    const comision = p.lineas[3];
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

    expect(p.subtotal_vuelo_usd).toBe(1600);
    expect(p.tuas_usd).toBe(80);
    expect(p.extras_total_usd).toBe(170);
    expect(p.subtotal_usd).toBe(2130); // total − IVA
    expect(p.iva_pct).toBe(16);
    expect(p.iva_base_usd).toBe(2130);
    expect(p.iva_usd).toBe(340.8);
    expect(p.total_mxn).toBe(36543.13);
  });

  it('TUA cobrada en MXN: unitario nativo, TC congelado y el USD de la línea canónica; la exenta sigue fuera', () => {
    const snap = snapshot({
      tuas: {
        pasajeros: 4,
        aeropuertos: [
          {
            iata: 'CUN',
            aplica: false,
            monto_pax: 0,
            razon: 'Matrícula N exenta',
          },
          { iata: 'MID', aplica: true, monto_pax: 350, moneda: 'MXN' },
        ],
        filas: [
          {
            iata: 'MID',
            aplica: true,
            usd_pax: 20.5,
            monto_pax: 350,
            moneda: 'MXN',
            tc_aplicado: 17.07,
            razon: 'TUAS aplica',
            pax: 4,
            total_nativo: 1400,
            total_usd: 82.02,
          },
        ],
        total_usd: 82.02,
        total_mxn_nativo: 1400,
      },
      desglose: [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1.6 hr × $1000/hr',
          monto_usd: 1600,
        },
        {
          clave: 'TUAS',
          concepto: 'TUA MID · $350.00 MXN × 4 pax = $1400.00 MXN',
          monto_usd: 82.02,
        },
      ],
    });
    const p = armarCotizacionInternaPayload(
      insumos({ quote: quote({ calculo_snapshot: snap }), cobros: [] }),
    );
    expect(p.lineas.map((l) => l.clave)).toEqual(['TIEMPO_VUELO', 'TUAS']);
    expect(p.lineas[1]).toMatchObject({
      cantidad: 4,
      unitario: 350,
      moneda: 'MXN',
      monto_nativo: 1400,
      tc_aplicado: 17.07,
      monto_usd: 82.02,
    });
    expect(p.tuas_cobradas).toEqual([
      {
        iata: 'MID',
        pax: 4,
        unitario: 350,
        moneda: 'MXN',
        total_nativo: 1400,
        tc_aplicado: 17.07,
        total_usd: 82.02,
      },
    ]);
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

  it('cotización sin snapshot (motor viejo): líneas desde las columnas espejo, sin TUAS por aeropuerto', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({ calculo_snapshot: null, aeronave_cotizada: null }),
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
    expect(p.pago_vendedor_usd).toBe(324.8);
    expect(p.iva_pct).toBe(16);
    expect(p.horas_cotizadas_hr).toBe(1.6); // cae a tiempo_cobrable_hr
    expect(p.tuas_cobradas).toEqual([]);
    expect(p.tuas_usd).toBe(80); // el escalar sigue diciendo que hubo TUAS
  });

  it('CANCELADO con comisión: pago al vendedor 0 explícito (no se provisiona)', () => {
    const p = armarCotizacionInternaPayload(
      insumos({ quote: quote({ estado: 'CANCELADO' }), cobros: [] }),
    );
    expect(p.pago_vendedor_usd).toBe(0);
    expect(p.iva_comision_vendedor_usd).toBe(0);
    expect(p.semaforo_cobro).toBe('gris');
    expect(p.semaforo_cobro_label).toBe('—');
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

  it('sin cobros: lista vacía, cobrado 0, saldo = total, semáforo rojo', () => {
    const p = armarCotizacionInternaPayload(insumos({ cobros: [] }));
    expect(p.cobros).toEqual([]);
    expect(p.total_cobrado_usd).toBe(0);
    expect(p.saldo_usd).toBe(2470.8);
    expect(p.comision_banco_usd).toBe(0);
    expect(p.total_cobrado_neto_usd).toBeNull();
    expect(p.semaforo_cobro).toBe('rojo');
    expect(p.semaforo_cobro_label).toBe('Sin cobro');
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

describe('armarCotizacionInternaPayload — grupo y combinado', () => {
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

/**
 * «Aeronave cotizada» vs «aeronave utilizada» (11-sep-2026, control interno):
 * el PDF del CLIENTE solo muestra el modelo COTIZADO; el interno pinta los
 * dos, porque la cotización se pacta con un avión y la operación puede salir
 * en otro (cambio de avión, rotación por tramo) y el dinero del balance
 * cuelga del UTILIZADO.
 */
describe('armarCotizacionInternaPayload — aeronave cotizada vs utilizada', () => {
  const C206 = 'aaaaaaaa-0000-0000-0000-00000000c206';

  it('mismo avión cotizado y utilizado: se manda el objeto y NO se marca diferencia', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          aeronave_utilizada: {
            id: SENECA,
            matricula: 'N4142R',
            modelo: 'Seneca V',
          },
        }),
      }),
    );
    expect(p.aeronave_cotizada_modelo).toBe('Seneca V');
    expect(p.aeronave_utilizada).toEqual({
      matricula: 'N4142R',
      modelo: 'Seneca V',
    });
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });

  it('cotizado en Seneca y volando en Cessna 206: los dos datos por separado + ⚠ difiere', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          aeronave_utilizada: {
            id: C206,
            matricula: 'XB-ANU',
            modelo: 'Cessna 206',
          },
        }),
      }),
    );
    // El cliente ve SIEMPRE el modelo cotizado; la matrícula solo en interno.
    expect(p.aeronave_cotizada_modelo).toBe('Seneca V');
    expect(p.aeronave_cotizada_matricula).toBe('N4142R');
    expect(p.aeronave_utilizada).toEqual({
      matricula: 'XB-ANU',
      modelo: 'Cessna 206',
    });
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(true);
  });

  it('API sin el campo nuevo (skew): cae a aeronave_operativa, sin inventar diferencia', () => {
    const p = armarCotizacionInternaPayload(insumos());
    expect(p.aeronave_utilizada).toEqual({
      matricula: 'N4142R',
      modelo: 'Seneca V',
    });
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
  });

  it('externo: no hay avión propio utilizado (su ficha ajena va en avion_externo)', () => {
    const p = armarCotizacionInternaPayload(
      insumos({
        quote: quote({
          es_externo: true,
          operador_externo: 'Aerolíneas del Sur',
          avion_externo_modelo: 'Hawker 400',
          avion_externo_matricula: 'XA-REG',
          aeronave_operativa: null,
          aeronave_utilizada: null,
        }),
      }),
    );
    expect(p.aeronave_utilizada).toBeNull();
    expect(p.aeronave_cotizada_vs_utilizada_difiere).toBe(false);
    expect(p.avion_externo).toBe('Hawker 400 · XA-REG');
  });
});
