import {
  COLORES_EVENTO_GOOGLE,
  colorIdGoogleDe,
  colorIdGoogleDescanso,
  colorIdGoogleDeVuelo,
  colorIdGoogleEvento,
  colorIdGoogleMantenimiento,
  descripcionEventoVuelo,
  estadoHttpGoogle,
  eventoAusenteEnGoogle,
  horaCortaCancun,
  nombreCortoPiloto,
  parsearServiceAccountJson,
  rutaMinusculas,
  tituloEventoVuelo,
  ventanaEventoVuelo,
} from './google-evento.util';
import {
  CANCELADO_COLOR,
  DESCANSO_COLOR,
  EVENTO_COLOR,
  EXTERNO_COLOR,
  MANTENIMIENTO_PROGRAMADO_COLOR,
  MANTENIMIENTO_TALLER_COLOR,
  PERMISO_PENDIENTE_COLOR,
  SIN_ASIGNAR_COLOR,
  SIN_AVION_COLOR,
  TENTATIVO_COLOR,
} from './colores-calendario.util';

/**
 * C4/C3 del pedido del 12-sep-2026 (sync sistema → Google Calendar):
 *  - `colorIdGoogleDe` traduce CUALQUIER hex del sistema
 *    (`colores-calendario.util`: semánticos y `aeronave.color_calendario`) al
 *    colorId de Google más cercano, para que el calendario de la oficina
 *    espeje «los mismos colores que usamos para cada cosa»;
 *  - `nombreCortoPiloto` pone el nombre corto del piloto en el título.
 * Ambos PUROS: ninguna llamada a Google ni a la BD.
 *
 * Desde el 15-sep-2026 viven aquí también los helpers del FORMATO DE LA
 * OFICINA —`rutaMinusculas`, `horaCortaCancun`, `tituloEventoVuelo`,
 * `descripcionEventoVuelo`, `ventanaEventoVuelo`—: el vuelo entero es UNA
 * SOLA FILA («Saab N621TX cun-pce-ctm-pce-cun 6:50») porque el Google
 * Calendar lo lee UNA persona, Luis el mecánico.
 */
describe('colorIdGoogleDe', () => {
  it('la paleta son los 11 colores oficiales de evento de Google', () => {
    expect(COLORES_EVENTO_GOOGLE.map((c) => c.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
    ]);
    expect(COLORES_EVENTO_GOOGLE.map((c) => c.hex)).toEqual([
      '#7986cb',
      '#33b679',
      '#8e24aa',
      '#e67c73',
      '#f6bf26',
      '#f4511e',
      '#039be5',
      '#616161',
      '#3f51b5',
      '#0b8043',
      '#d50000',
    ]);
  });

  it('cada color de la paleta se mapea a SÍ MISMO (distancia 0)', () => {
    for (const c of COLORES_EVENTO_GOOGLE) {
      expect(colorIdGoogleDe(c.hex)).toBe(c.id);
      // Mayúsculas y sin '#' también (los hex del sistema vienen #RRGGBB).
      expect(colorIdGoogleDe(c.hex.toUpperCase().replace('#', ''))).toBe(c.id);
    }
  });

  it('congela el mapeo de la FLOTA REAL (cambiarlo cambia el color que ve la oficina)', () => {
    // Colores vivos en `aeronave.color_calendario` (prod, 12-sep-2026).
    expect(colorIdGoogleDe('#F97316')).toBe('6'); // N4142R naranja → Mandarina
    expect(colorIdGoogleDe('#84CC16')).toBe('5'); // N58BT lima → Banana
    expect(colorIdGoogleDe('#EC4899')).toBe('4'); // N621TX rosa → Flamenco
    expect(colorIdGoogleDe('#3B82F6')).toBe('7'); // N990GG azul → Pavo real
    expect(colorIdGoogleDe('#06B6D4')).toBe('7'); // XA-VGV cian → Pavo real
    expect(colorIdGoogleDe('#EAB308')).toBe('5'); // XB-ANU amarillo → Banana
    expect(colorIdGoogleDe('#6366F1')).toBe('1'); // XB-IJP índigo → Lavanda
    expect(colorIdGoogleDe('#10B981')).toBe('2'); // XB-PEV esmeralda → Salvia
  });

  it('acepta el atajo de 3 dígitos', () => {
    expect(colorIdGoogleDe('#f00')).toBe('11'); // rojo puro → Tomate
  });

  it('sin color o con basura devuelve null (el llamador cae a su default)', () => {
    expect(colorIdGoogleDe(null)).toBeNull();
    expect(colorIdGoogleDe(undefined)).toBeNull();
    expect(colorIdGoogleDe('')).toBeNull();
    expect(colorIdGoogleDe('rojo')).toBeNull();
    expect(colorIdGoogleDe('#12')).toBeNull();
    expect(colorIdGoogleDe('#12345')).toBeNull();
    expect(colorIdGoogleDe('#GGGGGG')).toBeNull();
  });
});

/**
 * TABLA CONGELADA «cosa del sistema → hex → colorId de Google» (pedido del
 * cliente del 12-sep-2026: «los mismos colores que usamos para cada cosa»).
 *
 * Los hex salen de `colores-calendario.util` (fuente única del calendario del
 * sistema), así que si alguien cambia un color allá, ESTA tabla se rompe y hay
 * que decidir a conciencia qué ve la oficina en Google. Google solo tiene 11
 * colores de evento: varias cosas del sistema CAEN EN EL MISMO colorId y eso
 * está documentado abajo — el color en Google es una ayuda, el TÍTULO es el
 * dato confiable.
 */
describe('espejo de colores del sistema → Google (tabla congelada)', () => {
  /** [cosa del sistema, hex del sistema, colorId, nombre del color]. */
  const TABLA: ReadonlyArray<readonly [string, string, string, string]> = [
    // --- vuelos, en orden de PRECEDENCIA ---
    // El cancelado NO viaja a Google (su evento se BORRA); se congela igual
    // para que la tabla cubra toda la paleta del sistema.
    ['vuelo cancelado (no viaja a Google)', CANCELADO_COLOR, '6', 'Mandarina'],
    ['vuelo tentativo (RESERVA)', TENTATIVO_COLOR, '8', 'Grafito'],
    [
      'vuelo sin asignar (falta avión o piloto)',
      SIN_ASIGNAR_COLOR,
      '1',
      'Lavanda',
    ],
    ['permiso de pista pendiente', PERMISO_PENDIENTE_COLOR, '5', 'Banana'],
    ['vuelo externo', EXTERNO_COLOR, '4', 'Flamenco'],
    ['vuelo propio sin color de avión', SIN_AVION_COLOR, '1', 'Lavanda'],
    // --- otros eventos ---
    ['descanso de piloto', DESCANSO_COLOR, '2', 'Salvia'],
    ['evento de flota sin avión', EVENTO_COLOR, '7', 'Pavo real'],
    ['mantenimiento PROGRAMADO', MANTENIMIENTO_PROGRAMADO_COLOR, '5', 'Banana'],
    // --- la FLOTA REAL (aeronave.color_calendario en prod, 12-sep-2026) ---
    ['N4142R (naranja)', '#F97316', '6', 'Mandarina'],
    ['N58BT (lima)', '#84CC16', '5', 'Banana'],
    ['N621TX (rosa)', '#EC4899', '4', 'Flamenco'],
    ['N990GG (azul)', '#3B82F6', '7', 'Pavo real'],
    ['XA-VGV (cian)', '#06B6D4', '7', 'Pavo real'],
    ['XB-ANU (amarillo)', '#EAB308', '5', 'Banana'],
    ['XB-IJP (índigo)', '#6366F1', '1', 'Lavanda'],
    ['XB-PEV (esmeralda)', '#10B981', '2', 'Salvia'],
  ];

  it.each(TABLA)('%s (%s) → colorId %s (%s)', (_cosa, hex, id, nombre) => {
    expect(colorIdGoogleDe(hex)).toBe(id);
    expect(COLORES_EVENTO_GOOGLE.find((c) => c.id === id)?.nombre).toBe(nombre);
  });

  it('EN_TALLER es la ÚNICA excepción al "más cercano": Tomate FIJO (11)', () => {
    // El rojo del sistema (#EF4444) por redmean cae en Mandarina (6, d≈3 714)
    // antes que en Flamenco (4, ≈17 375) y que en Tomate (11, ≈30 217), y
    // Mandarina es el naranja de N4142R: el taller debe leerse ROJO.
    expect(colorIdGoogleDe(MANTENIMIENTO_TALLER_COLOR)).toBe('6');
    expect(colorIdGoogleMantenimiento(true)).toBe('11');
    expect(colorIdGoogleMantenimiento(false)).toBe('5');
  });

  it('las funciones semánticas devuelven lo que dice la tabla', () => {
    // Vuelos: la precedencia completa, con la asignación del tramo.
    expect(
      colorIdGoogleDeVuelo({
        estado: 'RESERVA',
        aeronaveId: 'a',
        pilotoId: 'p',
      }),
    ).toBe('8'); // tentativo gana incluso asignado y con permiso pendiente
    expect(
      colorIdGoogleDeVuelo({
        estado: 'RESERVA',
        permisoPendiente: true,
        colorAvion: '#10B981',
      }),
    ).toBe('8');
    expect(colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', pilotoId: 'p' })).toBe(
      '1',
    ); // sin avión asignado
    expect(
      colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', aeronaveId: 'a' }),
    ).toBe('1'); // sin piloto asignado
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        permisoPendiente: true,
        colorAvion: '#10B981',
      }),
    ).toBe('5'); // permiso pendiente > color del avión
    expect(
      colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', esExterno: true }),
    ).toBe('4'); // externo: no exige asignación
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        colorAvion: '#F97316',
      }),
    ).toBe('6'); // color del avión
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        colorAvion: null,
      }),
    ).toBe('1'); // sin color de avión
    // Un `color_calendario` con basura NO deja el evento sin color: cae al
    // gris "sin avión" del sistema.
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        colorAvion: 'azul cielo',
      }),
    ).toBe('1');
    // Descanso y eventos de flota.
    expect(colorIdGoogleDescanso()).toBe('2');
    expect(colorIdGoogleEvento(null)).toBe('7');
    expect(colorIdGoogleEvento('#F97316')).toBe('6');
    expect(colorIdGoogleEvento('no es un hex')).toBe('7');
  });

  it('COLISIONES conocidas: qué cosas comparten colorId en Google (y qué ids quedan libres)', () => {
    const porId = new Map<string, string[]>();
    for (const [cosa, , id] of TABLA) {
      porId.set(id, [...(porId.get(id) ?? []), cosa]);
    }
    // EN_TALLER va aparte (Tomate fijo, sin colisión).
    porId.set('11', ['mantenimiento EN_TALLER']);

    // Congelado a propósito: 11 colores para 18 cosas ⇒ hay empates. Si el
    // cliente quiere distinguirlos, se re-pintan los `color_calendario` del
    // sistema (y no alcanzan para los 8 aviones + 6 significados).
    expect(Object.fromEntries([...porId].sort())).toEqual({
      '1': [
        'vuelo sin asignar (falta avión o piloto)',
        'vuelo propio sin color de avión',
        'XB-IJP (índigo)',
      ],
      '11': ['mantenimiento EN_TALLER'],
      '2': ['descanso de piloto', 'XB-PEV (esmeralda)'],
      '4': ['vuelo externo', 'N621TX (rosa)'],
      '5': [
        'permiso de pista pendiente',
        'mantenimiento PROGRAMADO',
        'N58BT (lima)',
        'XB-ANU (amarillo)',
      ],
      '6': ['vuelo cancelado (no viaja a Google)', 'N4142R (naranja)'],
      '7': ['evento de flota sin avión', 'N990GG (azul)', 'XA-VGV (cian)'],
      '8': ['vuelo tentativo (RESERVA)'],
    });
    // Ids que NADIE usa hoy (quedan para futuros significados): Uva (3),
    // Arándano (9) —era el viejo default de la sync— y Albahaca (10).
    const usados = new Set(porId.keys());
    expect(
      COLORES_EVENTO_GOOGLE.filter((c) => !usados.has(c.id)).map((c) => c.id),
    ).toEqual(['3', '9', '10']);
  });
});

describe('nombreCortoPiloto', () => {
  it('devuelve el PRIMER nombre tal cual se capturó', () => {
    expect(nombreCortoPiloto('Luis Alberto Ramírez')).toBe('Luis');
    expect(nombreCortoPiloto('  Itzi   Pérez ')).toBe('Itzi');
    expect(nombreCortoPiloto('Ángel')).toBe('Ángel');
  });

  it('sin piloto asignado: "sin piloto" (acción pendiente, visible)', () => {
    expect(nombreCortoPiloto(null)).toBe('sin piloto');
    expect(nombreCortoPiloto(undefined)).toBe('sin piloto');
    expect(nombreCortoPiloto('   ')).toBe('sin piloto');
  });

  it('vuelo externo: "externo" aunque haya nombre capturado', () => {
    expect(nombreCortoPiloto('Quien Sea', true)).toBe('externo');
    expect(nombreCortoPiloto(null, true)).toBe('externo');
  });

  /**
   * APODO (`usuario.apodo`, 17-sep-2026): el primer nombre NO es como la
   * oficina conoce al piloto, y el calendario lo lee el mecánico. Casos
   * REALES del cliente.
   */
  it('el apodo GANA sobre el primer nombre (casos reales de la oficina)', () => {
    expect(nombreCortoPiloto('Alexander E. Saab', false, 'Saab')).toBe('Saab');
    expect(nombreCortoPiloto('Abraham Zamora', false, 'Zamora')).toBe('Zamora');
    expect(nombreCortoPiloto('Pablo Canales', false, 'Pab')).toBe('Pab');
  });

  it('apodo vacío / en blanco / ausente: cae al primer nombre', () => {
    expect(nombreCortoPiloto('Luis Alberto Ramírez', false, null)).toBe('Luis');
    expect(nombreCortoPiloto('Luis Alberto Ramírez', false, '')).toBe('Luis');
    expect(nombreCortoPiloto('Luis Alberto Ramírez', false, '   ')).toBe(
      'Luis',
    );
    expect(nombreCortoPiloto(null, false, '  ')).toBe('sin piloto');
  });

  it('externo manda sobre el apodo (la tripulación no es nuestra)', () => {
    expect(nombreCortoPiloto('Quien Sea', true, 'Saab')).toBe('externo');
  });
});

/**
 * FORMATO DE LA OFICINA — pedido del cliente del 15-sep-2026: «que no se
 * divida en tramos, mejor que esté todo en UNA SOLA FILA» y «le quitamos lo
 * de T1 y la cantidad de pasajeros, para nada más dejar piloto, avión, ruta
 * y hora».
 *
 * Los títulos de abajo son MUESTRAS REALES de los eventos que la oficina
 * capturaba a mano en el calendario de
 * `aerochartercancunflightplanner@gmail.com` (15-sep-2026). Si esta tabla se
 * rompe, el mecánico deja de reconocer su calendario.
 */
describe('formato de la oficina: rutaMinusculas / horaCortaCancun / tituloEventoVuelo', () => {
  it('rutaMinusculas: origen del primero + destino de cada tramo, en minúsculas', () => {
    expect(
      rutaMinusculas([
        { origen: 'CUN', destino: 'MID' },
        { origen: 'MID', destino: 'CUN' },
      ]),
    ).toBe('cun-mid-cun');
    expect(
      rutaMinusculas([
        { origen: 'CUN', destino: 'PCE' },
        { origen: 'PCE', destino: 'CTM' },
        { origen: 'CTM', destino: 'PCE' },
        { origen: 'PCE', destino: 'CUN' },
      ]),
    ).toBe('cun-pce-ctm-pce-cun');
    // Un solo tramo (vuelo sencillo sin escalas capturadas).
    expect(rutaMinusculas([{ origen: 'ILS', destino: 'CZM' }])).toBe('ils-czm');
  });

  it('rutaMinusculas: un tramo LOCAL (origen = destino) se escribe «mid-mid», nunca «mid»', () => {
    // Formato de la oficina para pruebas/servicios: «msss-msss Vuelo de prueba».
    expect(rutaMinusculas([{ origen: 'MID', destino: 'MID' }])).toBe('mid-mid');
    expect(
      rutaMinusculas([
        { origen: 'CUN', destino: 'CUN' },
        { origen: 'CUN', destino: 'MID' },
      ]),
    ).toBe('cun-cun-mid');
  });

  it('rutaMinusculas: un tramo que NO empieza donde terminó el anterior escribe su origen', () => {
    // Traslado no capturado: la ruta lo dice en vez de mentir por callar.
    expect(
      rutaMinusculas([
        { origen: 'CUN', destino: 'MID' },
        { origen: 'CZM', destino: 'CUN' },
      ]),
    ).toBe('cun-mid-czm-cun');
  });

  it('rutaMinusculas: códigos vacíos o nulos se omiten; sin tramos, cadena vacía', () => {
    expect(rutaMinusculas([])).toBe('');
    expect(rutaMinusculas([{ origen: null, destino: '  ' }])).toBe('');
    expect(rutaMinusculas([{ origen: 'CUN', destino: null }])).toBe('cun');
  });

  it('horaCortaCancun: hora de PARED en Cancún (UTC−5), sin cero a la izquierda', () => {
    expect(horaCortaCancun('2026-09-15T11:50:00.000Z')).toBe('6:50');
    expect(horaCortaCancun('2026-09-15T12:00:00.000Z')).toBe('7:00');
    expect(horaCortaCancun('2026-09-15T15:00:00.000Z')).toBe('10:00');
    expect(horaCortaCancun('2026-09-15T21:00:00.000Z')).toBe('16:00');
    // Medianoche Cancún (05:00Z): "0:00", nunca "24:00".
    expect(horaCortaCancun('2026-09-15T05:00:00.000Z')).toBe('0:00');
    // Cancún NO tiene horario de verano: en junio sigue siendo UTC−5.
    expect(horaCortaCancun('2026-06-15T15:00:00.000Z')).toBe('10:00');
  });

  it('horaCortaCancun: nulo o basura devuelve cadena vacía (nunca lanza)', () => {
    expect(horaCortaCancun(null)).toBe('');
    expect(horaCortaCancun(undefined)).toBe('');
    expect(horaCortaCancun('')).toBe('');
    expect(horaCortaCancun('no es una fecha')).toBe('');
  });

  it('TÍTULOS REALES de la oficina (15-sep-2026): congelados', () => {
    const titulo = (
      piloto: string,
      avion: string,
      tramos: Array<{ origen: string; destino: string }>,
      salidaIso: string,
    ) =>
      tituloEventoVuelo({
        pilotoCorto: piloto,
        aeronave: avion,
        ruta: rutaMinusculas(tramos),
        hora: horaCortaCancun(salidaIso),
      });

    expect(
      titulo(
        'Saab',
        'N621TX',
        [
          { origen: 'CUN', destino: 'PCE' },
          { origen: 'PCE', destino: 'CTM' },
          { origen: 'CTM', destino: 'PCE' },
          { origen: 'PCE', destino: 'CUN' },
        ],
        '2026-09-15T11:50:00.000Z',
      ),
    ).toBe('Saab N621TX cun-pce-ctm-pce-cun 6:50');

    expect(
      titulo(
        'Luis',
        'XB-PEV',
        [
          { origen: 'CUN', destino: 'CTM' },
          { origen: 'CTM', destino: 'CUN' },
        ],
        '2026-09-15T12:00:00.000Z',
      ),
    ).toBe('Luis XB-PEV cun-ctm-cun 7:00');

    expect(
      titulo(
        'Zamora',
        'XA-VGV',
        [
          { origen: 'CET', destino: 'CZM' },
          { origen: 'CZM', destino: 'CET' },
        ],
        '2026-09-15T21:00:00.000Z',
      ),
    ).toBe('Zamora XA-VGV cet-czm-cet 16:00');

    expect(
      titulo(
        'Saab',
        'XB-PEV',
        [
          { origen: 'CUN', destino: 'MID' },
          { origen: 'MID', destino: 'CUN' },
        ],
        '2026-09-15T15:00:00.000Z',
      ),
    ).toBe('Saab XB-PEV cun-mid-cun 10:00');

    expect(
      titulo(
        'Pab',
        'N4142R',
        [
          { origen: 'ILS', destino: 'CZM' },
          { origen: 'CZM', destino: 'CUN' },
        ],
        '2026-09-15T16:00:00.000Z',
      ),
    ).toBe('Pab N4142R ils-czm-cun 11:00');
  });

  it('el título NUNCA lleva T1, pax ni el ⚠ del permiso (el color y la descripción lo dicen)', () => {
    const t = tituloEventoVuelo({
      pilotoCorto: 'Luis',
      aeronave: 'N4142R',
      ruta: 'cun-mid-cun',
      hora: '10:00',
    });
    expect(t).toBe('Luis N4142R cun-mid-cun 10:00');
    expect(t).not.toMatch(/T1|pax|⚠|·/);
  });

  it('partes vacías se omiten (nunca dobles espacios)', () => {
    expect(
      tituloEventoVuelo({
        pilotoCorto: 'sin piloto',
        aeronave: 'sin avión',
        ruta: '',
        hora: '',
      }),
    ).toBe('sin piloto sin avión');
  });
});

describe('descripcionEventoVuelo', () => {
  const BASE = {
    id: 'v-1',
    folio: 247,
    estado: 'CONFIRMADO',
    cliente: 'ACME',
    pasajeros: 2,
    esExterno: false,
    matricula: 'N4142R',
    pilotoNombre: 'Alexander E. Saab',
    montoUsd: '4200',
    notas: null as string | null,
    tramos: [
      {
        orden: 1,
        origen: 'CUN',
        destino: 'MID',
        salida: '2026-09-15T15:00:00.000Z',
        pasajeros: 2,
      },
      {
        orden: 2,
        origen: 'MID',
        destino: 'CUN',
        salida: '2026-09-15T23:00:00.000Z',
        ferry: true,
      },
    ],
  };

  it('formato de la oficina: una línea por tramo, con el ancla al final', () => {
    expect(descripcionEventoVuelo(BASE).split('\n')).toEqual([
      'Folio: #247',
      'Estado: CONFIRMADO',
      'Cliente: ACME',
      'Pasajeros: 2',
      'Aeronave: N4142R',
      'Piloto: Alexander E. Saab',
      'T1 cun-mid 10:00 · 2 pax',
      'T2 mid-cun 18:00 · ferry',
      'Monto: $4200 USD',
      '',
      'VuelaTour · vuelo v-1',
    ]);
  });

  it('permiso pendiente y notas SÍ salen (el título ya no los lleva)', () => {
    const lineas = descripcionEventoVuelo({
      ...BASE,
      permisoPendiente: true,
      notas: 'avisar al FBO',
    }).split('\n');
    expect(lineas).toContain('Permiso de pista: PENDIENTE');
    expect(lineas).toContain('Notas: avisar al FBO');
    // El pendiente va ANTES de los tramos (se lee primero).
    expect(lineas.indexOf('Permiso de pista: PENDIENTE')).toBeLessThan(
      lineas.indexOf('T1 cun-mid 10:00 · 2 pax'),
    );
  });

  it('externo: operador en vez de matrícula y «(externo)» de piloto', () => {
    const lineas = descripcionEventoVuelo({
      ...BASE,
      esExterno: true,
      operadorExterno: 'Jet Amigo',
    }).split('\n');
    expect(lineas).toContain('Operador externo: Jet Amigo');
    expect(lineas).toContain('Piloto: (externo)');
    expect(lineas.join('\n')).not.toContain('Aeronave:');
  });

  it('tramo SIN hora: la línea sale igual, solo sin hora', () => {
    const lineas = descripcionEventoVuelo({
      ...BASE,
      tramos: [{ orden: 1, origen: 'CUN', destino: 'MID', salida: null }],
    }).split('\n');
    // Sin `pasajeros` propios cae a los del vuelo.
    expect(lineas).toContain('T1 cun-mid · 2 pax');
  });

  /**
   * MULTI-AVIÓN / ROTACIÓN DE PILOTO: el título lleva UN avión y UN piloto
   * (los del primer tramo activo). Quien difiera se dice en su línea, que es
   * lo que el formato viejo daba con un evento por tramo. Solo aparece cuando
   * difiere: la línea normal no cambia (ver la prueba del formato).
   */
  it('tramo con avión o piloto DISTINTOS: se anexan a su línea', () => {
    const lineas = descripcionEventoVuelo({
      ...BASE,
      tramos: [
        BASE.tramos[0],
        {
          orden: 2,
          origen: 'MID',
          destino: 'CUN',
          salida: '2026-09-15T23:00:00.000Z',
          pasajeros: 2,
          aeronave: 'N990GG',
          piloto: 'Zamora',
        },
      ],
    }).split('\n');
    expect(lineas).toContain('T1 cun-mid 10:00 · 2 pax');
    expect(lineas).toContain('T2 mid-cun 18:00 · 2 pax · N990GG · Zamora');
  });

  it('sin cliente / sin piloto / sin monto: guiones y omisiones, nunca "undefined"', () => {
    const texto = descripcionEventoVuelo({
      ...BASE,
      cliente: null,
      pilotoNombre: null,
      matricula: null,
      montoUsd: null,
    });
    expect(texto).toContain('Cliente: —');
    expect(texto).toContain('Aeronave: —');
    expect(texto).toContain('Piloto: sin asignar');
    expect(texto).not.toContain('Monto');
    expect(texto).not.toContain('undefined');
  });
});

/**
 * VENTANA de la fila única: un redondo debe ser UNA barra de la mañana a la
 * tarde y un viaje con pernocta debe abarcar sus días — no dos bloques
 * sueltos de 2 h como en el formato viejo.
 */
describe('ventanaEventoVuelo', () => {
  const T = (iso: string) => new Date(iso).toISOString();

  it('del primer despegue al último instante conocido + 1 h', () => {
    const v = ventanaEventoVuelo('2026-09-15T15:00:00.000Z', [
      '2026-09-15T18:00:00.000Z',
      '2026-09-15T23:00:00.000Z',
    ]);
    expect(v?.inicio.toISOString()).toBe(T('2026-09-15T15:00:00.000Z'));
    expect(v?.fin.toISOString()).toBe(T('2026-09-16T00:00:00.000Z'));
  });

  it('viaje multi-día (pernocta): la fila abarca los días', () => {
    const v = ventanaEventoVuelo('2026-09-15T15:00:00.000Z', [
      '2026-09-18T20:00:00.000Z',
    ]);
    expect(v?.fin.toISOString()).toBe(T('2026-09-18T21:00:00.000Z'));
  });

  it('sin más instantes conocidos: 1 h mínima', () => {
    const v = ventanaEventoVuelo('2026-09-15T15:00:00.000Z', [null, undefined]);
    expect(v?.fin.toISOString()).toBe(T('2026-09-15T16:00:00.000Z'));
  });

  it('instantes ANTERIORES al inicio o con basura se ignoran', () => {
    const v = ventanaEventoVuelo('2026-09-15T15:00:00.000Z', [
      '2026-09-14T10:00:00.000Z',
      'no es una fecha',
    ]);
    expect(v?.fin.toISOString()).toBe(T('2026-09-15T16:00:00.000Z'));
  });

  it('un fin absurdo (año mal capturado) NO pinta una barra de meses', () => {
    const v = ventanaEventoVuelo('2026-09-15T15:00:00.000Z', [
      '2027-09-15T15:00:00.000Z',
    ]);
    expect(v?.fin.toISOString()).toBe(T('2026-09-15T16:00:00.000Z'));
  });

  it('sin inicio válido no hay fila', () => {
    expect(ventanaEventoVuelo(null)).toBeNull();
    expect(ventanaEventoVuelo('')).toBeNull();
    expect(ventanaEventoVuelo('no es una fecha')).toBeNull();
  });
});

/**
 * `eventoAusenteEnGoogle` decide si un evento con id guardado se puede
 * RE-CREAR (o dar por borrado). Solo 404/410 lo autorizan: con un 403 de
 * cuota o un 5xx, re-crear duplicaría el evento en el calendario de la
 * oficina y dejaría huérfano al anterior.
 */
describe('estadoHttpGoogle / eventoAusenteEnGoogle', () => {
  it('lee el código HTTP de las tres formas que trae googleapis', () => {
    expect(estadoHttpGoogle({ code: 404 })).toBe(404);
    expect(estadoHttpGoogle({ code: '410' })).toBe(410);
    expect(estadoHttpGoogle({ response: { status: 403 } })).toBe(403);
    expect(estadoHttpGoogle({ status: 500, code: 'ERR' })).toBe(500);
  });

  it('sin código HTTP (error de red, string, null) devuelve null', () => {
    expect(estadoHttpGoogle(new Error('socket hang up'))).toBeNull();
    expect(estadoHttpGoogle({ code: 'ENOTFOUND' })).toBeNull();
    expect(estadoHttpGoogle(null)).toBeNull();
    expect(estadoHttpGoogle('404')).toBeNull();
  });

  it('SOLO 404/410 dicen que el evento ya no está en Google', () => {
    expect(eventoAusenteEnGoogle({ code: 404 })).toBe(true);
    expect(eventoAusenteEnGoogle({ response: { status: 410 } })).toBe(true);
    // Cuota, límite de escrituras, caída de Google y red: NO autorizan re-crear.
    for (const err of [
      { code: 403 },
      { code: 429 },
      { response: { status: 500 } },
      { code: 'ETIMEDOUT' },
      new Error('socket hang up'),
    ]) {
      expect(eventoAusenteEnGoogle(err)).toBe(false);
    }
  });
});

describe('parsearServiceAccountJson (variable pegada con tolerancia)', () => {
  const cred = {
    type: 'service_account',
    client_email: 'sa@vuelatour.iam.gserviceaccount.com',
    private_key:
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  };
  const plano = JSON.stringify(cred);

  it('lee el JSON en una línea tal cual', () => {
    expect(parsearServiceAccountJson(plano)).toEqual({
      client_email: cred.client_email,
      private_key: cred.private_key,
    });
  });

  it('tolera comillas envolventes (incidente Railway 12-sep-2026) y espacios', () => {
    expect(parsearServiceAccountJson(`  "${plano}"  `).client_email).toBe(
      cred.client_email,
    );
    expect(parsearServiceAccountJson(`'${plano}'`).client_email).toBe(
      cred.client_email,
    );
  });

  it('acepta base64 del JSON', () => {
    const b64 = Buffer.from(plano, 'utf8').toString('base64');
    expect(parsearServiceAccountJson(b64).client_email).toBe(cred.client_email);
  });

  it('normaliza saltos de línea escapados dentro de private_key', () => {
    const escapado = JSON.stringify({
      ...cred,
      private_key: cred.private_key.replace(/\n/g, '\\n'),
    });
    expect(parsearServiceAccountJson(escapado).private_key).toBe(
      cred.private_key,
    );
  });

  it('el motivo del JSON roto NO hace eco del valor (la llave privada va ahí)', () => {
    // V8 cita un trozo de la entrada («Unexpected token 'x', "x{\"priv"… is
    // not valid JSON») y ese mensaje viaja en `motivo` de
    // GET /v1/calendar/sync-estado y en el chip del panel.
    let msg = '';
    try {
      parsearServiceAccountJson(
        'x{"private_key":"-----BEGIN PRIVATE KEY-----"}',
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/no es un JSON válido/);
    expect(msg).not.toContain('private_key');
    expect(msg).not.toContain('BEGIN PRIVATE KEY');
    expect(msg).toContain('«…»');
  });

  it('rechaza sin secretos: JSON roto y JSON sin llaves', () => {
    expect(() => parsearServiceAccountJson('"{"type":"x"')).toThrow(
      /no es un JSON válido/,
    );
    expect(() =>
      parsearServiceAccountJson('{"type":"service_account"}'),
    ).toThrow(/client_email\/private_key/);
    try {
      parsearServiceAccountJson(plano.slice(0, 40));
    } catch (e) {
      expect((e as Error).message).not.toContain('BEGIN PRIVATE');
    }
  });
});
