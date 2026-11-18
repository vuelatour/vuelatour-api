import {
  COLORES_EVENTO_GOOGLE,
  colorIdGoogleDe,
  colorIdGoogleDescanso,
  colorIdGoogleDeVuelo,
  colorIdGoogleEvento,
  colorIdGoogleMantenimiento,
  colorIdGoogleSemaforo,
  descripcionEventoVuelo,
  diaCancunDe,
  estadoHttpGoogle,
  ETIQUETA_FILA_VUELO,
  etiquetaFilaVuelo,
  EVENTO_DIA_TOPE_MS,
  fechaLargaDia,
  LINEA_DESCRIPCION_SERVICIO,
  eventoAusenteEnGoogle,
  horaCortaCancun,
  lineaDiaEventoVuelo,
  nombreCortoPiloto,
  parsearServiceAccountJson,
  partirTramosPorDia,
  rutaMinusculas,
  tituloEventoVuelo,
  ventanaDiaEventoVuelo,
  ventanaEventoVuelo,
} from './google-evento.util';
import { SEMAFORO } from './colores-calendario.util';

/**
 * C4/C3 del pedido del 12-sep-2026 (sync sistema → Google Calendar),
 * ACTUALIZADO el 22-sep-2026 al SEMÁFORO DE 5 COLORES, el 24-sep-2026 al de
 * 6 (PAGADO azul, descanso MORADO) y el 28-sep-2026 al de 7 (SERVICIO café):
 *  - `colorIdGoogleDe` traduce un hex del sistema al colorId de Google más
 *    cercano (redmean) y `colorIdGoogleSemaforo` le antepone las excepciones
 *    fijas, para que el calendario de la oficina espeje el mismo semáforo;
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
 * TABLA CONGELADA «color del semáforo → hex → colorId de Google»
 * (22-sep-2026, 6 colores desde el 24-sep-2026, 7 desde el 28-sep-2026).
 * Reemplaza a la tabla de 18 filas del 12-sep-2026, donde 6 significados y 8
 * colores de avión se repartían los 11 colores de Google con SEIS colisiones
 * y el color no era un dato confiable.
 *
 * Ahora son SIETE hex → SIETE colorId DISTINTOS. Los hex salen de
 * `colores-calendario.util` (fuente única), así que si alguien cambia un color
 * allá, ESTA tabla se rompe y hay que decidir a conciencia qué ve la oficina.
 */
describe('espejo del semáforo → Google (tabla congelada)', () => {
  /** [cosa del sistema, hex del semáforo, colorId, nombre del color]. */
  const TABLA: ReadonlyArray<readonly [string, string, string, string]> = [
    ['tentativo (antes de CONFIRMADO)', SEMAFORO.TENTATIVO, '8', 'Grafito'],
    [
      'pendiente: permiso, sin asignar y mantenimiento',
      SEMAFORO.PENDIENTE,
      '5',
      'Banana',
    ],
    [
      'confirmado (vuelo y evento de flota)',
      SEMAFORO.CONFIRMADO,
      '2',
      'Salvia',
    ],
    ['PAGADO: vuelo cobrado completo', SEMAFORO.PAGADO, '7', 'Pavo real'],
    // El cancelado NO viaja a Google (su evento se BORRA); se congela igual
    // para que la tabla cubra el semáforo completo.
    ['cancelado (no viaja a Google)', SEMAFORO.CANCELADO, '11', 'Tomate'],
    ['descanso de piloto (MORADO)', SEMAFORO.DESCANSO, '3', 'Uva'],
    // Google no tiene café: Mandarina, FIJO (ver la prueba del CAFÉ abajo).
    [
      'vuelo de SERVICIO (CAFÉ: taller / parada técnica)',
      SEMAFORO.SERVICIO,
      '6',
      'Mandarina',
    ],
  ];

  it.each(TABLA)('%s (%s) → colorId %s (%s)', (_cosa, hex, id, nombre) => {
    expect(colorIdGoogleSemaforo(hex)).toBe(id);
    expect(COLORES_EVENTO_GOOGLE.find((c) => c.id === id)?.nombre).toBe(nombre);
  });

  it('la tabla cubre el semáforo COMPLETO (ningún color queda sin colorId)', () => {
    expect(new Set(TABLA.map(([, hex]) => hex))).toEqual(
      new Set(Object.values(SEMAFORO)),
    );
  });

  it('los siete colorId son DISTINTOS: ya no hay colisiones', () => {
    const ids = TABLA.map(([, , id]) => id);
    expect(new Set(ids).size).toBe(7);
    // Libres para significados futuros: Lavanda (1), Flamenco (4),
    // Arándano (9) y Albahaca (10). Mandarina (6) es del SERVICIO desde el
    // 28-sep-2026.
    const usados = new Set(ids);
    expect(
      COLORES_EVENTO_GOOGLE.filter((c) => !usados.has(c.id)).map((c) => c.id),
    ).toEqual(['1', '4', '9', '10']);
  });

  /**
   * El CAFÉ del SERVICIO (28-sep-2026) es la TERCERA excepción fija. Google
   * no tiene café; por redmean #8B5E3C cae en Grafito (8, d≈7 848), que es el
   * gris del TENTATIVO — un vuelo al taller se leería «reserva sin
   * confirmar». Mandarina (6, ≈32 996) es el tono cálido más cercano y nadie
   * más lo usa.
   */
  it('el CAFÉ del servicio es fijo: Mandarina (6), no Grafito', () => {
    expect(colorIdGoogleDe(SEMAFORO.SERVICIO)).toBe('8');
    expect(colorIdGoogleSemaforo(SEMAFORO.SERVICIO)).toBe('6');
    expect(colorIdGoogleSemaforo(SEMAFORO.SERVICIO)).not.toBe(
      colorIdGoogleSemaforo(SEMAFORO.TENTATIVO),
    );
  });

  /**
   * El azul del PAGADO (#3B82F6) cae en Pavo real por REDMEAN (d≈9 983),
   * antes que Lavanda (≈13 993) y Arándano (≈21 292): sin excepción. Es el
   * MISMO colorId que el descanso tuvo del 22 al 24-sep: un evento de
   * descanso publicado antes del resync todavía puede verse azul.
   */
  it('el AZUL del pagado sale del "más cercano": Pavo real (7)', () => {
    expect(colorIdGoogleDe(SEMAFORO.PAGADO)).toBe('7');
    expect(colorIdGoogleSemaforo(SEMAFORO.PAGADO)).toBe('7');
  });

  /**
   * El MORADO del descanso es la SEGUNDA excepción fija. Por redmean #8B5CF6
   * cae en Lavanda (1, d≈12 469) antes que en Arándano (9, ≈25 306) y en Uva
   * (3, ≈26 702); Lavanda es un azul-lila pálido que junto al Pavo real del
   * PAGADO se lee «otro azul» en el calendario del mecánico.
   */
  it('el MORADO del descanso es fijo: Uva (3), no Lavanda', () => {
    expect(colorIdGoogleDe(SEMAFORO.DESCANSO)).toBe('1');
    expect(colorIdGoogleSemaforo(SEMAFORO.DESCANSO)).toBe('3');
    expect(colorIdGoogleDescanso()).toBe('3');
  });

  /**
   * El verde del semáforo (#22C55E) cae en Salvia por REDMEAN (d≈3 589);
   * Albahaca —el otro verde de Google— queda a ≈22 269 y es un verde muy
   * oscuro. Se respeta la regla de siempre («el más cercano») porque el
   * confirmado es la mayoría de los eventos del calendario.
   */
  it('el VERDE sale del "más cercano", no de una excepción', () => {
    expect(colorIdGoogleDe(SEMAFORO.CONFIRMADO)).toBe('2');
  });

  /**
   * El ROJO es una de las DOS excepciones al "más cercano" (la otra es el
   * morado del descanso). La del taller (EN_TALLER → 11 Tomate) se RETIRÓ el
   * 22-sep-2026: el mantenimiento pasó a amarillo porque el rojo significa
   * CANCELADO.
   */
  it('el ROJO es excepción fija: Tomate (11), no Mandarina', () => {
    // Por redmean, #EF4444 cae en Mandarina (6, d≈3 714) antes que en
    // Flamenco (4, ≈17 375) y que en Tomate (11, ≈30 217) — y Mandarina es un
    // NARANJA: «cancelado» tiene que leerse rojo.
    expect(colorIdGoogleDe(SEMAFORO.CANCELADO)).toBe('6');
    expect(colorIdGoogleSemaforo(SEMAFORO.CANCELADO)).toBe('11');
  });

  it('un hex ilegible cae al gris del tentativo, nunca a un color con significado', () => {
    expect(colorIdGoogleSemaforo(null)).toBe('8');
    expect(colorIdGoogleSemaforo('azul cielo')).toBe('8');
  });

  it('las funciones semánticas devuelven lo que dice la tabla', () => {
    // Vuelos: la precedencia completa, con la asignación del tramo.
    expect(
      colorIdGoogleDeVuelo({
        estado: 'RESERVA',
        aeronaveId: 'a',
        pilotoId: 'p',
      }),
    ).toBe('8'); // tentativo gana incluso asignado
    expect(
      colorIdGoogleDeVuelo({
        estado: 'COTIZADO',
        permisoPendiente: true,
      }),
    ).toBe('8'); // …y con permiso pendiente
    expect(colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', pilotoId: 'p' })).toBe(
      '5',
    ); // sin avión asignado = asunto pendiente
    expect(
      colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', aeronaveId: 'a' }),
    ).toBe('5'); // sin piloto asignado
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        permisoPendiente: true,
      }),
    ).toBe('5'); // permiso de pista pendiente
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
      }),
    ).toBe('2'); // en firme
    // PAGADO (24-sep-2026): cobrado completo ⇒ azul → Pavo real (7)…
    expect(
      colorIdGoogleDeVuelo({
        estado: 'COMPLETADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        cobrado: true,
        montoTotalUsd: '4200.00',
      }),
    ).toBe('7');
    // …pero el pendiente operativo NO se esconde detrás del dinero…
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        permisoPendiente: true,
        cobrado: true,
        montoTotalUsd: 4200,
      }),
    ).toBe('5');
    // …una RESERVA pagada sigue gris…
    expect(colorIdGoogleDeVuelo({ estado: 'RESERVA', cobrado: true })).toBe(
      '8',
    );
    // …y un vuelo en $0 nunca es azul.
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        cobrado: true,
        montoTotalUsd: 0,
      }),
    ).toBe('2');
    expect(
      colorIdGoogleDeVuelo({ estado: 'CONFIRMADO', esExterno: true }),
    ).toBe('2'); // el externo ya no tiene color propio
    // El color del AVIÓN no mueve nada (quedó solo para los Excel).
    for (const colorAvion of ['#F97316', '#10B981', null, 'azul cielo']) {
      expect(
        colorIdGoogleDeVuelo({
          estado: 'CONFIRMADO',
          aeronaveId: 'a',
          pilotoId: 'p',
          colorAvion,
        }),
      ).toBe('2');
    }
    // SERVICIO (28-sep-2026): café → Mandarina (6), después del cancelado y
    // antes de todo lo demás (pagado, pendiente, tentativo).
    expect(
      colorIdGoogleDeVuelo({
        estado: 'COMPLETADO',
        aeronaveId: 'a',
        pilotoId: 'p',
        servicio: true,
        cobrado: true,
        montoTotalUsd: 900,
      }),
    ).toBe('6');
    expect(
      colorIdGoogleDeVuelo({
        estado: 'CONFIRMADO',
        servicio: true,
        permisoPendiente: true,
      }),
    ).toBe('6');
    expect(colorIdGoogleDeVuelo({ estado: 'RESERVA', servicio: true })).toBe(
      '6',
    );
    expect(colorIdGoogleDeVuelo({ estado: 'CANCELADO', servicio: true })).toBe(
      '11',
    );
    // Descanso (MORADO → Uva), eventos de flota y mantenimientos.
    expect(colorIdGoogleDescanso()).toBe('3');
    expect(colorIdGoogleEvento()).toBe('2');
    expect(colorIdGoogleEvento('#F97316')).toBe('2');
    expect(colorIdGoogleEvento('no es un hex')).toBe('2');
    expect(colorIdGoogleMantenimiento()).toBe('5');
    expect(colorIdGoogleMantenimiento(false)).toBe('5');
    expect(colorIdGoogleMantenimiento(true)).toBe('5');
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

  /**
   * SERVICIO (28-sep-2026): en Google el café sale Mandarina, así que la
   * descripción lo dice con todas sus letras, justo después del estado. Sin
   * la bandera, la descripción es la de siempre (ver la prueba del formato).
   */
  it('vuelo de SERVICIO: un renglón que lo dice, después del estado', () => {
    const lineas = descripcionEventoVuelo({
      ...BASE,
      servicio: true,
    }).split('\n');
    expect(LINEA_DESCRIPCION_SERVICIO).toBe(
      'Vuelo de SERVICIO (taller / parada técnica, sin pasajeros)',
    );
    expect(lineas.indexOf(LINEA_DESCRIPCION_SERVICIO)).toBe(
      lineas.indexOf('Estado: CONFIRMADO') + 1,
    );
    expect(
      descripcionEventoVuelo({ ...BASE, servicio: false }).split('\n'),
    ).not.toContain(LINEA_DESCRIPCION_SERVICIO);
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
 * UNA FILA POR DÍA EN LOS VUELOS DE VARIOS DÍAS (17-nov-2026, vuelo #478).
 * Reporte de la oficina: «por ser un vuelo de dos días no sé por qué lo manda
 * a la barrita de arriba». Google sube a la franja de «todo el día» cualquier
 * evento de 24 h o más; la fila única del #478 iba del 18-nov 10:00 al 19-nov
 * 13:00. Estas piezas PURAS deciden cuántas filas lleva un vuelo y dónde va
 * cada una.
 */
describe('una fila por día: diaCancunDe / partirTramosPorDia', () => {
  // Los cuatro tramos REALES del #478 (horas de Cancún, UTC−5).
  const T478 = [
    { orden: 1, origen: 'CUN', destino: 'CTM', salida: '2026-11-18T15:00:00Z' },
    { orden: 2, origen: 'CTM', destino: 'MHL', salida: '2026-11-18T17:00:00Z' },
    { orden: 3, origen: 'MHL', destino: 'CTM', salida: '2026-11-19T15:00:00Z' },
    { orden: 4, origen: 'CTM', destino: 'CUN', salida: '2026-11-19T17:00:00Z' },
  ];
  const ordenes = (
    grupos: Array<{ dia: string; tramos: { orden: number }[] }>,
  ) => grupos.map((g) => [g.dia, g.tramos.map((t) => t.orden)]);

  it('diaCancunDe: el día es el de CANCÚN (UTC−5), no el de UTC', () => {
    // 23:59 del 18 en Cancún = 04:59Z del 19; medianoche del 19 = 05:00Z.
    expect(diaCancunDe('2026-11-19T04:59:59.000Z')).toBe('2026-11-18');
    expect(diaCancunDe('2026-11-19T05:00:00.000Z')).toBe('2026-11-19');
    expect(diaCancunDe(new Date('2026-11-18T15:00:00Z'))).toBe('2026-11-18');
    // Cancún NO tiene horario de verano: en junio sigue siendo UTC−5.
    expect(diaCancunDe('2026-06-16T04:59:59.000Z')).toBe('2026-06-15');
    // Cambio de año.
    expect(diaCancunDe('2027-01-01T03:00:00.000Z')).toBe('2026-12-31');
  });

  it('diaCancunDe: nulo o basura devuelve null (nunca lanza)', () => {
    expect(diaCancunDe(null)).toBeNull();
    expect(diaCancunDe(undefined)).toBeNull();
    expect(diaCancunDe('')).toBeNull();
    expect(diaCancunDe('no es una fecha')).toBeNull();
  });

  it('vuelo de UN día: un solo grupo con todos sus tramos', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: '2026-09-20T14:00:00Z' },
      { orden: 2, salida: '2026-09-20T20:00:00Z' },
    ]);
    expect(ordenes(grupos)).toEqual([['2026-09-20', [1, 2]]]);
  });

  it('el #478 REAL: dos días, dos tramos cada uno, en orden', () => {
    const grupos = partirTramosPorDia(T478);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [1, 2]],
      ['2026-11-19', [3, 4]],
    ]);
    // Devuelve los MISMOS objetos (el servicio los empata con sus escalas).
    expect(grupos[1].tramos[0]).toBe(T478[2]);
  });

  it('tres días con uno INTERMEDIO sin salidas: dos grupos, no tres', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: '2026-11-18T15:00:00Z' },
      { orden: 2, salida: '2026-11-20T15:00:00Z' },
      { orden: 3, salida: '2026-11-20T19:00:00Z' },
    ]);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [1]],
      ['2026-11-20', [2, 3]],
    ]);
  });

  it('una salida de madrugada cae en SU día de Cancún (23:30 y 0:30 son días distintos)', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: '2026-11-19T04:30:00Z' }, // 18-nov 23:30
      { orden: 2, salida: '2026-11-19T05:30:00Z' }, // 19-nov 0:30
    ]);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [1]],
      ['2026-11-19', [2]],
    ]);
  });

  it('tramo SIN fecha: va con el día del tramo anterior que sí la tiene', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: '2026-11-18T15:00:00Z' },
      { orden: 2, salida: null },
      { orden: 3, salida: '2026-11-19T15:00:00Z' },
      { orden: 4 },
      { orden: 5, salida: 'no es una fecha' },
    ]);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [1, 2]],
      ['2026-11-19', [3, 4, 5]],
    ]);
  });

  it('tramo SIN fecha al INICIO: va con el día del primer tramo con fecha (nunca abre un día)', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: null },
      { orden: 2, salida: null },
      { orden: 3, salida: '2026-11-18T15:00:00Z' },
      { orden: 4, salida: '2026-11-19T15:00:00Z' },
    ]);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [1, 2, 3]],
      ['2026-11-19', [4]],
    ]);
  });

  it('sin NINGÚN tramo con fecha (o sin tramos) no hay días', () => {
    expect(partirTramosPorDia([])).toEqual([]);
    expect(
      partirTramosPorDia([
        { orden: 1, salida: null },
        { orden: 2, salida: '' },
      ]),
    ).toEqual([]);
  });

  it('dato roto (fechas fuera de orden): JAMÁS dos grupos del mismo día, y los días salen cronológicos', () => {
    const grupos = partirTramosPorDia([
      { orden: 1, salida: '2026-11-19T15:00:00Z' },
      { orden: 2, salida: '2026-11-18T15:00:00Z' },
      { orden: 3, salida: '2026-11-19T19:00:00Z' },
      { orden: 4, salida: null },
    ]);
    expect(ordenes(grupos)).toEqual([
      ['2026-11-18', [2]],
      ['2026-11-19', [1, 3, 4]],
    ]);
  });

  it('PARTICIÓN: con alguna fecha, cada tramo aparece en exactamente un grupo y ningún día se repite (500 itinerarios al azar)', () => {
    // Generador determinista: sin Math.random, la prueba es reproducible.
    let semilla = 478;
    const azar = (n: number): number => {
      // mulberry32: determinista y bien repartido.
      semilla = (semilla + 0x6d2b79f5) | 0;
      let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const base = Date.parse('2026-11-18T05:00:00Z'); // medianoche Cancún
    for (let caso = 0; caso < 500; caso++) {
      const n = 1 + azar(7);
      const tramos = Array.from({ length: n }, (_x, i) => ({
        orden: i + 1,
        salida:
          azar(5) === 0
            ? null
            : new Date(
                base + azar(4) * 86_400_000 + azar(24 * 60) * 60_000,
              ).toISOString(),
      }));
      const grupos = partirTramosPorDia(tramos);
      const conFecha = tramos.filter((t) => t.salida != null);
      if (conFecha.length === 0) {
        expect(grupos).toEqual([]);
        continue;
      }
      const dias = grupos.map((g) => g.dia);
      expect(new Set(dias).size).toBe(dias.length);
      expect([...dias].sort()).toEqual(dias);
      expect(
        grupos
          .flatMap((g) => g.tramos.map((t) => t.orden))
          .sort((a, b) => a - b),
      ).toEqual(tramos.map((t) => t.orden));
      // Un tramo con fecha SIEMPRE está en el grupo de su propio día…
      for (const g of grupos) {
        for (const t of g.tramos) {
          if (t.salida != null) expect(diaCancunDe(t.salida)).toBe(g.dia);
        }
        // …y todo grupo tiene al menos una salida de ese día (hay fila).
        expect(g.tramos.some((t) => t.salida != null)).toBe(true);
      }
      // Los días son exactamente los días con salidas.
      expect(dias).toEqual(
        [...new Set(conFecha.map((t) => diaCancunDe(t.salida)))].sort(),
      );
    }
  });
});

describe('una fila por día: ventanaDiaEventoVuelo', () => {
  const grupo = (dia: string, ...salidas: Array<string | null>) => ({
    dia,
    tramos: salidas.map((salida) => ({ salida })),
  });
  const iso = (v: { inicio: Date; fin: Date } | null) =>
    v ? [v.inicio.toISOString(), v.fin.toISOString()] : null;

  it('el #478 REAL: cada día de 10:00 a 13:00 (última salida + 1 h), en su hora', () => {
    expect(
      iso(
        ventanaDiaEventoVuelo(
          grupo('2026-11-18', '2026-11-18T15:00:00Z', '2026-11-18T17:00:00Z'),
        ),
      ),
    ).toEqual(['2026-11-18T15:00:00.000Z', '2026-11-18T18:00:00.000Z']);
    expect(
      iso(
        ventanaDiaEventoVuelo(
          grupo('2026-11-19', '2026-11-19T15:00:00Z', '2026-11-19T17:00:00Z'),
        ),
      ),
    ).toEqual(['2026-11-19T15:00:00.000Z', '2026-11-19T18:00:00.000Z']);
  });

  it('una sola salida en el día: 1 h mínima', () => {
    expect(
      iso(ventanaDiaEventoVuelo(grupo('2026-11-18', '2026-11-18T15:00:00Z'))),
    ).toEqual(['2026-11-18T15:00:00.000Z', '2026-11-18T16:00:00.000Z']);
  });

  it('fecha_traslado_final SOLO cuenta en el día en que cae', () => {
    const dia18 = grupo('2026-11-18', '2026-11-18T15:00:00Z');
    const dia19 = grupo('2026-11-19', '2026-11-19T15:00:00Z');
    const traslado = '2026-11-19T21:00:00Z'; // 19-nov 16:00 Cancún
    // En SU día estira la fila hasta el traslado + 1 h…
    expect(iso(ventanaDiaEventoVuelo(dia19, traslado))).toEqual([
      '2026-11-19T15:00:00.000Z',
      '2026-11-19T22:00:00.000Z',
    ]);
    // …y en otro día no la toca (si no, el día 1 volvería a ser de 31 h).
    expect(iso(ventanaDiaEventoVuelo(dia18, traslado))).toEqual([
      '2026-11-18T15:00:00.000Z',
      '2026-11-18T16:00:00.000Z',
    ]);
    // Un traslado en un día SIN salidas no estira a nadie.
    expect(iso(ventanaDiaEventoVuelo(dia19, '2026-11-20T21:00:00Z'))).toEqual([
      '2026-11-19T15:00:00.000Z',
      '2026-11-19T16:00:00.000Z',
    ]);
  });

  it('un tramo SIN fecha que heredó el día no aporta instante', () => {
    expect(
      iso(
        ventanaDiaEventoVuelo(
          grupo('2026-11-18', null, '2026-11-18T15:00:00Z', null),
        ),
      ),
    ).toEqual(['2026-11-18T15:00:00.000Z', '2026-11-18T16:00:00.000Z']);
  });

  it('la fila empieza en la salida MÁS TEMPRANA del día aunque los tramos vengan desordenados', () => {
    expect(
      iso(
        ventanaDiaEventoVuelo(
          grupo('2026-11-18', '2026-11-18T17:00:00Z', '2026-11-18T15:00:00Z'),
        ),
      ),
    ).toEqual(['2026-11-18T15:00:00.000Z', '2026-11-18T18:00:00.000Z']);
  });

  it('SIEMPRE menos de 24 h: de las 0:15 a las 23:30 se corta en 23 h 59 min (si no, Google la sube a «todo el día»)', () => {
    const v = ventanaDiaEventoVuelo(
      grupo('2026-11-18', '2026-11-18T05:15:00Z', '2026-11-19T04:30:00Z'),
    );
    expect(EVENTO_DIA_TOPE_MS).toBe(24 * 60 * 60 * 1000 - 60 * 1000);
    expect(iso(v)).toEqual([
      '2026-11-18T05:15:00.000Z',
      '2026-11-19T05:14:00.000Z',
    ]);
    expect(
      (v as { inicio: Date; fin: Date }).fin.getTime() -
        (v as { inicio: Date; fin: Date }).inicio.getTime(),
    ).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('sin ninguna salida de ese día no hay fila', () => {
    expect(ventanaDiaEventoVuelo(grupo('2026-11-18'))).toBeNull();
    expect(ventanaDiaEventoVuelo(grupo('2026-11-18', null))).toBeNull();
    // Una salida de OTRO día no cuenta para este.
    expect(
      ventanaDiaEventoVuelo(grupo('2026-11-18', '2026-11-19T15:00:00Z')),
    ).toBeNull();
  });
});

describe('una fila por día: textos y etiqueta', () => {
  it('fechaLargaDia: día de la semana + DD/MM/AAAA', () => {
    expect(fechaLargaDia('2026-11-18')).toBe('miércoles 18/11/2026');
    expect(fechaLargaDia('2026-11-19')).toBe('jueves 19/11/2026');
    expect(fechaLargaDia('2026-11-21')).toBe('sábado 21/11/2026');
    expect(fechaLargaDia('2026-11-22')).toBe('domingo 22/11/2026');
    expect(fechaLargaDia('2026-09-01')).toBe('martes 01/09/2026');
    // El 29 de febrero de un año bisiesto existe; el 31 de febrero, no.
    expect(fechaLargaDia('2028-02-29')).toBe('martes 29/02/2028');
    expect(fechaLargaDia('2026-02-31')).toBe('');
    expect(fechaLargaDia('18/11/2026')).toBe('');
    expect(fechaLargaDia(null)).toBe('');
  });

  it('lineaDiaEventoVuelo: qué día es la fila y qué tramos salen ese día', () => {
    expect(
      lineaDiaEventoVuelo({
        numero: 1,
        total: 2,
        dia: '2026-11-18',
        ordenes: [1, 2],
      }),
    ).toBe('Día 1 de 2 · miércoles 18/11/2026 · tramos T1 y T2');
    expect(
      lineaDiaEventoVuelo({
        numero: 2,
        total: 3,
        dia: '2026-11-19',
        ordenes: [3],
      }),
    ).toBe('Día 2 de 3 · jueves 19/11/2026 · tramo T3');
    expect(
      lineaDiaEventoVuelo({
        numero: 3,
        total: 3,
        dia: '2026-11-20',
        ordenes: [4, 5, 6],
      }),
    ).toBe('Día 3 de 3 · viernes 20/11/2026 · tramos T4, T5 y T6');
    // Sin lista de tramos la línea se queda en el día.
    expect(
      lineaDiaEventoVuelo({ numero: 1, total: 2, dia: '2026-11-18' }),
    ).toBe('Día 1 de 2 · miércoles 18/11/2026');
  });

  it('etiquetaFilaVuelo: «vuelo» para el día 1 (y el vuelo de un día), «dia-N» para los siguientes', () => {
    expect(ETIQUETA_FILA_VUELO).toBe('vuelo');
    expect(etiquetaFilaVuelo(1)).toBe('vuelo');
    expect(etiquetaFilaVuelo(2)).toBe('dia-2');
    expect(etiquetaFilaVuelo(3)).toBe('dia-3');
    expect(etiquetaFilaVuelo(0)).toBe('vuelo');
    expect(etiquetaFilaVuelo(Number.NaN)).toBe('vuelo');
  });

  it('descripcionEventoVuelo: la línea del día va PRIMERO y, sin ella, la descripción no cambia ni un carácter', () => {
    const datos = {
      id: 'v-1',
      folio: 478,
      estado: 'CONFIRMADO',
      cliente: 'Hernan Garza',
      pasajeros: 5,
      esExterno: false,
      matricula: 'N621TX',
      pilotoNombre: 'Alejandro Canales',
      montoUsd: null,
      tramos: [
        {
          orden: 1,
          origen: 'CUN',
          destino: 'CTM',
          salida: '2026-11-18T15:00:00Z',
          pasajeros: 3,
        },
      ],
    };
    const deUnDia = descripcionEventoVuelo(datos);
    const linea = 'Día 1 de 2 · miércoles 18/11/2026 · tramo T1';
    expect(descripcionEventoVuelo({ ...datos, lineaDia: linea })).toBe(
      `${linea}\n${deUnDia}`,
    );
    expect(descripcionEventoVuelo({ ...datos, lineaDia: null })).toBe(deUnDia);
    expect(descripcionEventoVuelo({ ...datos, lineaDia: '   ' })).toBe(deUnDia);
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
