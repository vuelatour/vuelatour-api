import {
  COLORES_EVENTO_GOOGLE,
  colorIdGoogleDe,
  colorIdGoogleDescanso,
  colorIdGoogleDeVuelo,
  colorIdGoogleEvento,
  colorIdGoogleMantenimiento,
  estadoHttpGoogle,
  eventoAusenteEnGoogle,
  nombreCortoPiloto,
  parsearServiceAccountJson,
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
 *  - `nombreCortoPiloto` pone el primer nombre del piloto en el título.
 * Ambos PUROS: ninguna llamada a Google ni a la BD.
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
