import {
  COLORES_EVENTO_GOOGLE,
  colorIdGoogleDe,
  estadoHttpGoogle,
  eventoAusenteEnGoogle,
  nombreCortoPiloto,
  parsearServiceAccountJson,
} from './google-evento.util';

/**
 * C4/C3 del pedido del 12-sep-2026 (sync sistema → Google Calendar):
 *  - `colorIdGoogleDe` traduce el hex del sistema (`aeronave.color_calendario`)
 *    al colorId de Google más cercano, para que el calendario de la oficina
 *    espeje los colores por avión;
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

  it('coincide con los colores FIJOS que ya usaba la sync (externo y evento de flota)', () => {
    // #F0DCDB (externos del calendario interno) → Flamenco = EXTERNAL_COLOR_ID.
    expect(colorIdGoogleDe('#F0DCDB')).toBe('4');
    // #0EA5E9 (eventos NO-vuelo) → Pavo real = EVENTO_FLOTA_COLOR_ID.
    expect(colorIdGoogleDe('#0EA5E9')).toBe('7');
    // Ámbar del sistema (#F59E0B, mantenimiento PROGRAMADO) → Banana.
    expect(colorIdGoogleDe('#F59E0B')).toBe('5');
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
