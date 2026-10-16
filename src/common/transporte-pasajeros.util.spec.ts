import {
  RE_EXTRA_TRANSPORTE,
  RE_TRANSPORTE_DEBIL,
  RE_TRANSPORTE_FUERTE,
  RE_TRANSPORTE_VETO,
  TEXTO_GASTO_TRANSPORTE_MAX,
  cotizoTransporte,
  pareceTransporteDePasajeros,
  textoDeGasto,
  textoGastoTransporte,
  type GastoTextoTransporte,
} from './transporte-pasajeros.util';

/**
 * Heurística «¿transporte de PASAJEROS?» (15-oct-2026, PEDIDO 4) congelada
 * con los textos REALES de prod (gastos TAXI jul-oct 2026 y los de
 * OPERACIONES/COMIDA con palabras de transporte; SELECT por MCP del
 * 15-oct-2026). `lugar`, `notas` (primera línea + resto) y el proveedor de la
 * IA tal cual están en la BD.
 */
const g = (
  categoria: string,
  notas: string,
  proveedor: string | null = null,
  lugar: string | null = null,
): GastoTextoTransporte => ({
  categoria,
  notas,
  lugar,
  valor_ia_extraido: proveedor ? { proveedor } : null,
});

describe('pareceTransporteDePasajeros — textos reales de prod', () => {
  it.each<[string, GastoTextoTransporte, boolean]>([
    // ── POSITIVOS ─────────────────────────────────────────────────────────
    [
      '2ec3386d #44 (DÉBIL «privado»)',
      g(
        'TAXI',
        'Servicio de taxi puerto y aeropuerto, round trip privado · Proveedor: Costa Maya Taxis',
        'Costa Maya Taxis',
      ),
      true,
    ],
    [
      '6970df1d #104 (FUERTE «Transfers»/«Traslado»)',
      g(
        'TAXI',
        'City Taxi Transfers & Tours - Agencia Turística · Traslado privado redondo Aeropuerto de Chetumal - Taco Loco',
        'City Taxi Transfers & Tours - Agencia Turística',
      ),
      true,
    ],
    [
      '0fbb6275 #134 (FUERTE)',
      g(
        'TAXI',
        'Coati Transfers & Tours · Traslado privado redondo Aeropuerto Chetumal - VIPS',
        'Coati Transfers & Tours',
      ),
      true,
    ],
    [
      '66d575d8 #190 (FUERTE «Transporte»)',
      g(
        'TAXI',
        "Costa Maya Transportes Turísticos S.A. · Transporte Chetumal a Carl's Jr\n\n[IA al sincronizar]\nCOSTA MAYA TRANSPORTES TURISTICOS S.A. · Servicio de taxi Chetumal - Carls Jr (round trip)",
        'COSTA MAYA TRANSPORTES TURISTICOS S.A.',
      ),
      true,
    ],
    [
      '37b8a58f #351 (FUERTE «TRANSPORTES»)',
      g(
        'TAXI',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A. · Servicio de taxi privado Chetumal - Plaza (ida), 2 pasajeros PENDIENTE FACTURA',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A.',
      ),
      true,
    ],
    [
      'b7a60bde #404 (DÉBIL «privado»)',
      g(
        'TAXI',
        'CITY TAXI, SAFE & FAST S.A. DE C.V. · Servicio de taxi privado, origen Aeropuerto Internacional de Chetumal, 1 pax',
        'CITY TAXI, SAFE & FAST S.A. DE C.V.',
      ),
      true,
    ],
    [
      '1cccba02 #320 (gasto; el vuelo no está COMPLETADO)',
      g(
        'TAXI',
        'transporte Master Ruben · Proveedor: Ruben Lozano · Matrícula: N4142R',
        'Ruben Lozano',
      ),
      true,
    ],
    [
      'b79fb798 #450 (gasto; EN_VUELO hoy)',
      g(
        'TAXI',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A. · Servicio de taxi puerto y aeropuerto, round trip privado, Chetumal',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A.',
      ),
      true,
    ],
    // ── #74: viajes en app de la tripulación (TODOS fuera) ───────────────
    [
      'f894b9de #74 (veto «app de transporte» + «km»)',
      g(
        'TAXI',
        'Viaje en app de transporte, 14.7 km en Mérida\n\nDesglose:\nTarifa base - $167.38 MXN\nMonto adicional por gasolina - $4.62 MXN',
      ),
      false,
    ],
    ['23638b01 #74', g('TAXI', 'taxi ADO-FBO EFECTIVO'), false],
    [
      '34d04d72 #74',
      g(
        'TAXI',
        'Viaje 5.8 km\n\nDesglose:\nTarifa base - $82.79 MXN\nMonto adicional por gasolina - $2.21 MXN',
      ),
      false,
    ],
    [
      '4b133bb4 #74',
      g(
        'TAXI',
        'Didi/Uber (app de viajes) · Viaje en San Francisco de Campeche, 6.5 km',
        'Didi/Uber (app de viajes)',
      ),
      false,
    ],
    [
      'b5771bba #74',
      g(
        'TAXI',
        'Uber · Viaje al aeropuerto (13.2 km)\n\nDesglose:\nTarifa base - $125.41 MXN\nTarifa de traslado al aeropuerto - $40.00 MXN',
        'Uber',
      ),
      false,
    ],
    [
      'c051782a #74',
      g('TAXI', 'DiDi · Viaje en San Francisco de Campeche, 5.9 km', 'DiDi'),
      false,
    ],
    [
      'c1c6bbef #74',
      g('TAXI', 'DiDi · Viaje en San Francisco de Campeche (7.6 km)', 'DiDi'),
      false,
    ],
    // ── Tripulación / logística ───────────────────────────────────────────
    [
      '2acde018 #124 (veto «Tren», «km»)',
      g(
        'TAXI',
        'Mega Tours Garde Vanguardia Turistica S.A.S · Traslado de Estación Tren Maya Mérida a Aeropuerto de Mérida (25 km)',
        'Mega Tours Garde Vanguardia Turistica S.A.S',
      ),
      false,
    ],
    [
      '53eed934 #293 (veto «ADO» suelto, no el «…ado» de «Traslado»)',
      g(
        'TAXI',
        'Sindicato de Taxistas Lázaro Cárdenas del Río · Traslado ADO Turística a Aeropuerto',
        'Sindicato de Taxistas Lázaro Cárdenas del Río',
      ),
      false,
    ],
    [
      '7e9a7278 #350 (veto «Muelle»)',
      g(
        'TAXI',
        'Sindicato Unico de Choferes Taxistas y Similares de la Isla de Cozumel · Traslado taxi Aeródromo Toledo → Muelle',
        'Sindicato Unico de Choferes Taxistas y Similares de la Isla de Cozumel',
        'Cozumel',
      ),
      false,
    ],
    [
      'fb6678db #350 (veto «FBO», «pilotos»)',
      g('TAXI', 'taxi Playa del Carmen al FBO Cancún 2 pilotos'),
      false,
    ],
    [
      '7dc862ee #350 (veto «ferry», «boletos»)',
      g(
        'TAXI',
        'Ultramar Ferry (Ticket Tours SA de CV) · 2 boletos ferry Playa del Carmen - Cozumel adulto sencillo',
        'Ultramar Ferry (Ticket Tours SA de CV)',
      ),
      false,
    ],
    [
      'a09d548c #167 (sin señal: falso negativo conocido)',
      g(
        'TAXI',
        'City Taxi Safe y Fast SA de CV · Servicio de taxi en Chetumal',
        'City Taxi Safe y Fast SA de CV',
      ),
      false,
    ],
    [
      '1c4561f0 #211 (sin señal)',
      g(
        'TAXI',
        'Taxis Azules · Servicio de taxi Tuxtla-Aeropuerto\n[29-ago] año corregido (auditoría)',
        'Taxis Azules',
      ),
      false,
    ],
    ['82a35bdf #126', g('TAXI', 'Uber a apto'), false],
    ['fabe015c #126', g('TAXI', 'Uber a restaurante'), false],
    ['10d89c73 #211', g('TAXI', 'taxi de hotel a apto'), false],
    ['41981bc1 #306', g('TAXI', 'Uber  de tren a apto'), false],
    ['d8bf2aa1 #165', g('TAXI', 'mototaxi CZM'), false],
    ['b077afb9 #293', g('TAXI', 'moto taxi Cozumel aeropuerto - ferry'), false],
    [
      '0523a939 #163',
      g(
        'TAXI',
        'gasolina a PCE · [CARGA-EXCEL-AGO28] reclasificado de OTRO → TAXI: Excel piloto: Gasolina pce 250.0',
      ),
      false,
    ],
    [
      '64ef1bd8 #109',
      g(
        'TAXI',
        'Boleto de tren Cancún Aeropuerto - Mérida Teya, clase turista · Proveedor: Tren Maya',
        'Tren Maya',
      ),
      false,
    ],
    [
      '94f907ff #124',
      g(
        'TAXI',
        'Estacionamiento de Autos SAAB · Proveedor: AEROPUERTO DE CANCUN (ASUR) · [CARGA-EXCEL-AGO28] reclasificado de OPERACIONES → TAXI',
        'AEROPUERTO DE CANCUN (ASUR)',
      ),
      false,
    ],
    [
      '2500a6b1 #236',
      g(
        'TAXI',
        'ADO (Autobuses de Oriente) · Boleto de autobús Mérida Centro Histórico - Cancún, servicio Primera\n\nTarjeta personal SAAB reembolsar',
        'ADO (Autobuses de Oriente)',
      ),
      false,
    ],
    // ── OPERACIONES / otras categorías ────────────────────────────────────
    [
      'bab8a1af #40 OPERACIONES («transferencia» no es transfer)',
      g(
        'OPERACIONES',
        'Zamora lo pago en efectivo y se le rembolso en transferencia por Pablo.\n\nViaticos de ayer barco 80\nTaxi de playa al fbo 250',
      ),
      false,
    ],
    [
      '5f0acbc7 #158 OPERACIONES («Tours» es DÉBIL)',
      g(
        'OPERACIONES',
        'Tiempo de vuelo CUN-MHL / MHL-CUN, Cessna U-206-G · Proveedor: AVIALOGIA / Dolphin Air Tours\n\nDesglose:\nIVA (Traslados 002) - $3763.20 MXN',
        'AVIALOGIA / Dolphin Air Tours',
      ),
      false,
    ],
    [
      '01cb3b64 #151 OPERACIONES (sin señal)',
      g(
        'OPERACIONES',
        'Aeropuerto Internacional de Chichen Itzá · Servicios de aeropuerto (operaciones y taxi)',
        'Aeropuerto Internacional de Chichen Itzá',
        'CZA',
      ),
      false,
    ],
    ['6a4cb70f #42 OPERACIONES', g('OPERACIONES', 'Taxi a restaurante'), false],
    [
      'ff179e30 #149 OPERACIONES («camiones» ≠ camioneta, veto FBO)',
      g('OPERACIONES', 'TAXI DEL FBO A TERMINALES ZAMORA- CAMIONES'),
      false,
    ],
    [
      '21d2a024 #271 COMIDA (categoría fuera)',
      g('COMIDA', 'didis comida'),
      false,
    ],
  ])('%s ⇒ %p', (_n, gasto, esperado) => {
    expect(pareceTransporteDePasajeros(gasto)).toBe(esperado);
  });

  it('una señal FUERTE en otra categoría (COMIDA/HOTEL/OTRO) no cuenta', () => {
    for (const cat of ['COMIDA', 'HOTEL', 'OTRO', 'TUAS', null]) {
      expect(
        pareceTransporteDePasajeros(g(cat as string, 'Traslado privado')),
      ).toBe(false);
    }
  });

  it('DÉBIL solo en TAXI: «privado» en OPERACIONES no basta; FUERTE sí', () => {
    expect(
      pareceTransporteDePasajeros(g('OPERACIONES', 'Servicio privado')),
    ).toBe(false);
    expect(pareceTransporteDePasajeros(g('TAXI', 'Servicio privado'))).toBe(
      true,
    );
    expect(
      pareceTransporteDePasajeros(g('OPERACIONES', 'Camioneta a la terminal')),
    ).toBe(true);
  });
});

describe('regex: límites de palabra', () => {
  it('«Traslado» y «privado» NO disparan el veto «ado»; «ADO» suelto sí', () => {
    expect(RE_TRANSPORTE_VETO.test('Traslado privado')).toBe(false);
    expect(RE_TRANSPORTE_VETO.test('taxi a la terminal ADO')).toBe(true);
  });
  it('«turista» no es «turístic»; «Turística»/«turistico» sí', () => {
    expect(RE_TRANSPORTE_DEBIL.test('clase turista')).toBe(false);
    expect(RE_TRANSPORTE_DEBIL.test('Agencia Turística')).toBe(true);
    expect(RE_TRANSPORTE_DEBIL.test('servicio turistico')).toBe(true);
  });
  it('«transferencia» no es transfer (ni fuerte ni extra); «Transfers» sí', () => {
    expect(RE_TRANSPORTE_FUERTE.test('rembolso en transferencia')).toBe(false);
    expect(RE_EXTRA_TRANSPORTE.test('Comision transferencia')).toBe(false);
    expect(RE_TRANSPORTE_FUERTE.test('City Taxi Transfers')).toBe(true);
  });
});

describe('textoDeGasto', () => {
  it('lugar · proveedor IA · PRIMERA línea de notas (sin vacíos)', () => {
    expect(
      textoDeGasto(
        g(
          'OPERACIONES',
          'Aeropuerto Internacional de Chichen Itzá · Servicios de aeropuerto (operaciones y taxi)\nsegunda línea',
          'Aeropuerto Internacional de Chichen Itzá',
          'CZA',
        ),
      ),
    ).toBe(
      'CZA · Aeropuerto Internacional de Chichen Itzá · Aeropuerto Internacional de Chichen Itzá · Servicios de aeropuerto (operaciones y taxi)',
    );
    expect(textoDeGasto(g('TAXI', 'Uber a apto'))).toBe('Uber a apto');
    expect(
      textoDeGasto({
        categoria: 'TAXI',
        notas: null,
        lugar: '  ',
        valor_ia_extraido: { proveedor: 5 },
      }),
    ).toBe('');
  });
});

describe('cotizoTransporte — conceptos reales de vuelo.extras (jul-oct)', () => {
  it.each([
    'Camionetas',
    'Camioneta',
    'CAMIONETAS',
    'Transfer',
    'Transfer Jetset',
    'Tranfer',
    'TRANFER',
    'Transfer terminales',
    'transfer terrestre',
    'Trasnfer FBO-T',
  ])('«%s» ⇒ true', (concepto) => {
    expect(cotizoTransporte([{ concepto }])).toBe(true);
  });

  it.each([
    'Espera',
    'ESPERA',
    'Pablo',
    'Handler',
    'Pernocta',
    'TOUR CHICHEN X 5',
    'Tour para 4 pax',
    'TOUR x2',
    'Tour CZA (sin cenote/buffet) x3',
    'Silla de ruedas CZM y CUN',
    'Comision transferencia',
    '5% pay wise',
    'Extensión de servicios',
    'Viaticos Piloto',
    'Gastos',
    'Extra',
    'TUA',
    'ajuste Ale',
  ])('«%s» ⇒ false', (concepto) => {
    expect(cotizoTransporte([{ concepto }])).toBe(false);
  });

  it('jsonb crudo: no arreglo / vacío / concepto no-texto ⇒ false', () => {
    expect(cotizoTransporte(null)).toBe(false);
    expect(cotizoTransporte({})).toBe(false);
    expect(cotizoTransporte([])).toBe(false);
    expect(cotizoTransporte([{ concepto: 5 }])).toBe(false);
    expect(cotizoTransporte([null, 'Transfer'])).toBe(false);
  });

  it('basta UN extra de transporte entre varios', () => {
    expect(
      cotizoTransporte([{ concepto: 'Espera' }, { concepto: 'Camionetas' }]),
    ).toBe(true);
  });
});

describe('textoGastoTransporte (chip, ≤ 60)', () => {
  it.each<[string, GastoTextoTransporte, string]>([
    [
      '#44',
      g(
        'TAXI',
        'Servicio de taxi puerto y aeropuerto, round trip privado · Proveedor: Costa Maya Taxis',
        'Costa Maya Taxis',
      ),
      'Servicio de taxi puerto y aeropuerto, round trip privado',
    ],
    [
      '#104',
      g(
        'TAXI',
        'City Taxi Transfers & Tours - Agencia Turística · Traslado privado redondo Aeropuerto de Chetumal - Taco Loco',
        'City Taxi Transfers & Tours - Agencia Turística',
      ),
      'Traslado privado redondo Aeropuerto de Chetumal - Taco Loco',
    ],
    [
      '#134',
      g(
        'TAXI',
        'Coati Transfers & Tours · Traslado privado redondo Aeropuerto Chetumal - VIPS',
        'Coati Transfers & Tours',
      ),
      'Traslado privado redondo Aeropuerto Chetumal - VIPS',
    ],
    [
      '#190',
      g(
        'TAXI',
        "Costa Maya Transportes Turísticos S.A. · Transporte Chetumal a Carl's Jr\n\n[IA al sincronizar]",
        'COSTA MAYA TRANSPORTES TURISTICOS S.A.',
      ),
      "Transporte Chetumal a Carl's Jr",
    ],
    [
      '#351',
      g(
        'TAXI',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A. · Servicio de taxi privado Chetumal - Plaza (ida), 2 pasajeros PENDIENTE FACTURA',
        'COSTA MAYA TRANSPORTES TURISTICOS S.A.',
      ),
      // Regla 59 + «…» (el ejemplo del contrato, «…2 pasajer…», contó 58).
      'Servicio de taxi privado Chetumal - Plaza (ida), 2 pasajero…',
    ],
    [
      '#404',
      g(
        'TAXI',
        'CITY TAXI, SAFE & FAST S.A. DE C.V. · Servicio de taxi privado, origen Aeropuerto Internacional de Chetumal, 1 pax',
        'CITY TAXI, SAFE & FAST S.A. DE C.V.',
      ),
      'Servicio de taxi privado, origen Aeropuerto Internacional d…',
    ],
    [
      '#320 («Proveedor:»/«Matrícula:» fuera)',
      g(
        'TAXI',
        'transporte Master Ruben · Proveedor: Ruben Lozano · Matrícula: N4142R',
        'Ruben Lozano',
      ),
      'transporte Master Ruben',
    ],
  ])('%s', (_n, gasto, esperado) => {
    const t = textoGastoTransporte(gasto);
    expect(t).toBe(esperado);
    expect(t.length).toBeLessThanOrEqual(TEXTO_GASTO_TRANSPORTE_MAX);
  });

  it('sin notas útiles ⇒ proveedor IA ⇒ lugar ⇒ etiqueta de la categoría', () => {
    expect(
      textoGastoTransporte(
        g('TAXI', 'Proveedor: X', 'Costa Maya Taxis', 'CTM'),
      ),
    ).toBe('Costa Maya Taxis');
    expect(textoGastoTransporte(g('TAXI', '', null, 'CTM'))).toBe('CTM');
    expect(textoGastoTransporte(g('TAXI', ''))).toBe('Taxi / estacionamiento');
  });

  it('recorte: 59 caracteres + «…» cuando pasa del máximo', () => {
    const largo = 'x'.repeat(61);
    expect(textoGastoTransporte(g('TAXI', largo))).toBe(`${'x'.repeat(59)}…`);
    expect(textoGastoTransporte(g('TAXI', 'x'.repeat(60)))).toBe(
      'x'.repeat(60),
    );
    expect(textoGastoTransporte(g('TAXI', 'abcdef'), 4)).toBe('abc…');
  });
});
