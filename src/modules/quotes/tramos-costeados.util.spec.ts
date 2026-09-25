import {
  consolidarTramosCosteados,
  costearTramos,
  costoDeTramo,
  horasADecimal,
  horasAHhmm,
  horasTexto,
  motivoAjusteTramos,
  repartirHorasDecimales,
  type HorasDelAjuste,
} from './tramos-costeados.util';
import {
  armarCotizacionInternaPayload,
  type AeropuertoInternoRow,
  type CotizacionInternaInsumos,
  type EscalaInternaRow,
} from './quotes-pdf-interno.util';

/**
 * COSTEO POR TRAMO — fuente ÚNICA compartida por el PDF interno y
 * `POST /v1/quotes/calculate` (22-sep-2026).
 *
 * Dos contratos se congelan aquí:
 *
 * 1. **La aritmética** (helpers puros): el único número nuevo es
 *    `round2(tiempo_hr × tarifa)` por tramo, y la diferencia contra la línea
 *    canónica TIEMPO_VUELO viaja EXPLÍCITA como `tramos_ajuste_usd` con su
 *    motivo — nunca repartida entre tramos, nunca escondida.
 * 2. **La PARIDAD con lo que hoy imprime el PDF interno**, medida sobre
 *    payloads REALES de producción leídos el 22-sep-2026 (#329 con horas
 *    pactadas y ajuste de $165.00, #311 que cuadra exacto y #294, el de 8
 *    tramos con ferries ocultos y dos días). Si el refactor hubiera movido un
 *    centavo o un texto, estos tres casos lo dirían.
 */

const HORAS_NEUTRAS: HorasDelAjuste = {
  tiempo_cobrable_hr: null,
  sobrevuelo_hr: null,
  hora_minima_aplicada: false,
  cobrable_override: false,
};

describe('tramos-costeados.util — aritmética del tramo', () => {
  it('costoDeTramo: round2(tiempo × tarifa); el importe del snapshot GANA; sin tarifa, 0 (jamás se inventa)', () => {
    expect(costoDeTramo(0.33, 1650)).toBe(544.5);
    expect(costoDeTramo(0.57, 1650)).toBe(940.5);
    expect(costoDeTramo(1.2567, 1000)).toBe(1256.7);
    // Tarifa con 6 decimales (invariante 23): se multiplica con todo y se
    // redondea UNA vez, al final.
    expect(costoDeTramo(2.4, 989.583333)).toBe(2375);
    // Lo que el motor ya congeló manda sobre el producto.
    expect(costoDeTramo(0.33, 1650, 500)).toBe(500);
    expect(costoDeTramo(0.33, 1650, 0)).toBe(0);
    // Sin tarifa y sin importe no hay costo posible: 0, no un inventado.
    expect(costoDeTramo(0.33, null)).toBe(0);
  });

  it('horasAHhmm / horasTexto: minutos redondeados a dos dígitos y horas sin ceros de relleno', () => {
    expect(horasAHhmm(1.3)).toBe('01:18');
    expect(horasAHhmm(0.4)).toBe('00:24');
    expect(horasAHhmm(7.2)).toBe('07:12');
    expect(horasAHhmm(0)).toBe('00:00');
    // Nunca negativo (un tiempo negativo sería un dato roto, no "-01:00").
    expect(horasAHhmm(-3)).toBe('00:00');
    expect(horasTexto(1.75)).toBe('1.75');
    expect(horasTexto(2)).toBe('2');
    expect(horasTexto(0.5)).toBe('0.5');
    expect(horasTexto(2.333333333)).toBe('2.33');
  });

  it('motivoAjusteTramos: horas pactadas manda; sobrevuelo + hora mínima se concatenan; < medio centavo = null', () => {
    expect(motivoAjusteTramos(0.004, HORAS_NEUTRAS, 1650)).toBeNull();
    expect(motivoAjusteTramos(-0.004, HORAS_NEUTRAS, 1650)).toBeNull();
    expect(
      motivoAjusteTramos(
        165,
        {
          tiempo_cobrable_hr: 1.75,
          sobrevuelo_hr: 0.5,
          hora_minima_aplicada: true,
          cobrable_override: true,
        },
        1650,
      ),
      // Con pactado a mano, ese ES el motivo: sobrevuelo y hora mínima ya
      // quedaron absorbidos en el número que tecleó la oficina.
    ).toBe('Horas pactadas 1.75 h');
    expect(
      motivoAjusteTramos(
        200,
        {
          tiempo_cobrable_hr: 2,
          sobrevuelo_hr: 0.5,
          hora_minima_aplicada: true,
          cobrable_override: false,
        },
        1000,
      ),
    ).toBe('Sobrevuelo 0.5 h · Hora mínima 1.0 h');
    // Sin explicación de horas: el ajuste es el redondeo del desglose.
    expect(motivoAjusteTramos(4.5, HORAS_NEUTRAS, 1000)).toBe('Redondeo');
    // Sin tarifa no se pudo costear ni un tramo: se dice, no se disfraza.
    expect(motivoAjusteTramos(1000, HORAS_NEUTRAS, null)).toBe(
      'Tarifa no disponible',
    );
  });

  it('consolidarTramosCosteados: Σ tramos + ajuste == servicio aéreo canónico, al centavo', () => {
    const pie = consolidarTramosCosteados(
      [
        { tiempo_hr: 0.33, total_usd: 544.5 },
        { tiempo_hr: 0.57, total_usd: 940.5 },
        { tiempo_hr: 0.75, total_usd: 1237.5 },
      ],
      2887.5,
      1650,
      {
        tiempo_cobrable_hr: 1.75,
        sobrevuelo_hr: 0,
        hora_minima_aplicada: false,
        cobrable_override: true,
      },
    );
    expect(pie).toEqual({
      tramos_tiempo_total_hr: 1.65,
      tramos_tiempo_total_hhmm: '01:39',
      tramos_total_usd: 2722.5,
      tramos_ajuste_usd: 165,
      tramos_ajuste_motivo: 'Horas pactadas 1.75 h',
      tramos_tiempo_total_horas: '1.65',
    });
    expect(pie.tramos_total_usd + pie.tramos_ajuste_usd).toBe(2887.5);
  });

  it('costearTramos sin catálogo ni escalas (el caso de /quotes/calculate): IATA como nombre y fecha null', () => {
    const r = costearTramos({
      tramos: [
        { orden: 1, origen: 'cun', destino: 'hol', millas: 42, tiempo_hr: 0.5 },
        { orden: 2, origen: 'HOL', destino: 'CUN', millas: 42, tiempo_hr: 0.5 },
      ],
      tarifaHora: 750,
      servicioAereoUsd: 750,
      horas: HORAS_NEUTRAS,
    });
    expect(r.tramos.map((t) => t.ruta)).toEqual(['CUN-HOL', 'HOL-CUN']);
    expect(r.tramos.map((t) => t.fecha)).toEqual([null, null]);
    expect(r.tramos.map((t) => t.total_usd)).toEqual([375, 375]);
    expect(r.tramos_total_usd).toBe(750);
    expect(r.tramos_ajuste_usd).toBe(0);
    expect(r.tramos_ajuste_motivo).toBeNull();
  });

  it('costearTramos: el ferry va a 0 pax, la numeración es 1..N y la fecha se arrastra al tramo siguiente', () => {
    const r = costearTramos({
      tramos: [
        {
          orden: 7,
          origen: 'CUN',
          destino: 'PCE',
          tiempo_hr: 0.33,
          pasajeros: 4,
          es_ferry: true,
          requiere_pernocta: true,
          pernocta_usd: 150,
          tuas_usd: 25,
        },
        { orden: 8, origen: 'PCE', destino: 'CUN', tiempo_hr: 0.33 },
      ],
      tarifaHora: 1650,
      servicioAereoUsd: 1089,
      horas: HORAS_NEUTRAS,
      fechaVuelo: '2026-09-23',
      // Solo el PRIMER tramo tiene día propio: el segundo hereda el anterior.
      fechaBaseDeTramo: (orden) => (orden === 7 ? '2026-09-24' : null),
    });
    expect(r.tramos.map((t) => t.orden)).toEqual([1, 2]);
    expect(r.tramos.map((t) => t.fecha)).toEqual(['2026-09-24', '2026-09-24']);
    expect(r.tramos[0].pax).toBe(0);
    expect(r.tramos[0].pernocta).toBe(true);
    expect(r.tramos[0].pernocta_usd).toBe(150);
    expect(r.tramos[0].tuas_usd).toBe(25);
    expect(r.tramos[1].pax).toBeNull();
    expect(r.tramos[1].pernocta_usd).toBe(0);
  });

  it('costearTramos: sin tramos, la tabla va vacía y TODO el servicio aéreo queda como ajuste visible', () => {
    const r = costearTramos({
      tramos: [],
      tarifaHora: 1000,
      servicioAereoUsd: 1000,
      horas: HORAS_NEUTRAS,
    });
    expect(r.tramos).toEqual([]);
    expect(r.tramos_total_usd).toBe(0);
    expect(r.tramos_ajuste_usd).toBe(1000);
    expect(r.tramos_ajuste_motivo).toBe('Redondeo');
  });
});

// ===== TIEMPO VUELO (HRS): horas decimales con SUMA CUADRADA (24-sep-2026) =====

/**
 * Casos de la columna TIEMPO VUELO (HRS). Esta MISMA tabla vive copiada en
 * el panel (`vuelatour-next/src/lib/admin/__tests__/quote-sheet-interna.test.ts`,
 * `CASOS_HORAS_DECIMALES`) para su espejo `repartirHorasDecimales`, y en
 * pyservices (`tests/test_cotizacion_interna_pdf.py`) para su respaldo: si
 * cambia una regla aquí, cambia en los tres.
 */
const CASOS_HORAS_DECIMALES: ReadonlyArray<{
  caso: string;
  tiempos: (number | null | undefined)[];
  tramos: (string | null)[];
  total: string;
}> = [
  {
    // La captura del cliente: 125 nm / 120 kt + 0.15 = 1.19166… h por tramo.
    // En hh:mm era «01:12» + «01:12» ≠ «02:23».
    caso: 'CUN–PTU–CUN de la captura: 1.19166… × 2',
    tiempos: [1.1916666667, 1.1916666667],
    tramos: ['1.19', '1.19'],
    total: '2.38',
  },
  {
    caso: 'el mismo caso ya en round4 (como lo guarda el snapshot)',
    tiempos: [1.1917, 1.1917],
    tramos: ['1.19', '1.19'],
    total: '2.38',
  },
  {
    // Redondeados cada uno por su lado: 0.34 × 3 = 1.02 ≠ 1.01.
    caso: 'residuo mayor hacia ARRIBA: tres tramos de 0.335',
    tiempos: [0.335, 0.335, 0.335],
    tramos: ['0.34', '0.34', '0.33'],
    total: '1.01',
  },
  {
    // Redondeados cada uno por su lado: 0.33 × 3 = 0.99 ≠ 1.00. La centésima
    // que falta va al residuo MÁS GRANDE (0.3349), no al primer tramo.
    caso: 'residuo mayor hacia ABAJO: gana el residuo más grande, no el orden',
    tiempos: [0.333, 0.3349, 0.3349],
    tramos: ['0.33', '0.34', '0.33'],
    total: '1.00',
  },
  {
    caso: 'empate de residuos: decide el ORDEN del tramo (determinista)',
    tiempos: [0.005, 0.005],
    tramos: ['0.01', '0.00'],
    total: '0.01',
  },
  {
    caso: 'un solo tramo: su celda ES el total',
    tiempos: [1.1916666667],
    tramos: ['1.19'],
    total: '1.19',
  },
  {
    caso: 'dos decimales FIJOS: 1.2 → «1.20», 1 → «1.00»',
    tiempos: [1.2, 1],
    tramos: ['1.20', '1.00'],
    total: '2.20',
  },
  {
    // #294 (8 tramos): 1.6433/1.2567 ya suman exacto 7.20.
    caso: 'ocho tramos que ya cuadran (#294)',
    tiempos: [1.6433, 0.35, 1.2567, 0.35, 1.6433, 0.35, 1.2567, 0.35],
    tramos: ['1.64', '0.35', '1.26', '0.35', '1.64', '0.35', '1.26', '0.35'],
    total: '7.20',
  },
  {
    caso: 'tramo SIN tiempo: «—» y no suma (igual que hoy, que cuenta 0)',
    tiempos: [1.1917, null, 0.5],
    tramos: ['1.19', null, '0.50'],
    total: '1.69',
  },
  {
    caso: 'ningún tramo con tiempo',
    tiempos: [null, undefined],
    tramos: [null, null],
    total: '0.00',
  },
  { caso: 'sin tramos', tiempos: [], tramos: [], total: '0.00' },
  {
    caso: 'nunca negativo (un tiempo negativo es un dato roto)',
    tiempos: [-3, 0.5],
    tramos: ['0.00', '0.50'],
    total: '0.50',
  },
];

/** Generador pseudoaleatorio DETERMINISTA (la prueba nunca parpadea). */
function lcg(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('tramos-costeados.util — TIEMPO VUELO (HRS) en horas decimales', () => {
  it('horasADecimal: 2 decimales FIJOS, medio hacia arriba en aritmética entera', () => {
    expect(horasADecimal(1.1916666667)).toBe('1.19');
    expect(horasADecimal(2.3833333333)).toBe('2.38');
    expect(horasADecimal(1.2)).toBe('1.20');
    expect(horasADecimal(1)).toBe('1.00');
    expect(horasADecimal(10.5)).toBe('10.50');
    expect(horasADecimal(0)).toBe('0.00');
    // Donde `toFixed(2)` falla por el binario del flotante.
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(horasADecimal(1.005)).toBe('1.01');
    expect(horasADecimal(2.675)).toBe('2.68');
    expect(horasADecimal(-3)).toBe('0.00');
  });

  it.each(CASOS_HORAS_DECIMALES)(
    'repartirHorasDecimales · $caso',
    ({ tiempos, tramos, total }) => {
      const r = repartirHorasDecimales(tiempos);
      expect(r).toEqual({ tramos, total });
      // La suma de lo que se VE es el total que se VE.
      const suma = r.tramos.reduce(
        (acc, t) => acc + (t == null ? 0 : Math.round(Number(t) * 100)),
        0,
      );
      expect(suma).toBe(Math.round(Number(r.total) * 100));
    },
  );

  it('SUMA CUADRADA en 2,000 tablas al azar: Σ tramos = total y cada tramo a ≤ 0.01 de su propio redondeo', () => {
    const azar = lcg(20260924);
    for (let caso = 0; caso < 2000; caso++) {
      const n = 1 + Math.floor(azar() * 9);
      // Tiempos como los del snapshot: round4 entre 0.15 y ~4 h.
      const tiempos = Array.from(
        { length: n },
        () => Math.round((0.15 + azar() * 4) * 10000) / 10000,
      );
      const r = repartirHorasDecimales(tiempos);
      const cent = r.tramos.map((t) => Math.round(Number(t) * 100));
      expect(cent.reduce((a, b) => a + b, 0)).toBe(
        Math.round(Number(r.total) * 100),
      );
      expect(r.total).toBe(horasADecimal(tiempos.reduce((a, b) => a + b, 0)));
      tiempos.forEach((h, i) => {
        const propio = Math.round(Number(horasADecimal(h)) * 100);
        expect(Math.abs(cent[i] - propio)).toBeLessThanOrEqual(1);
        // Piso o techo de su propio valor, nunca otra cosa.
        expect(cent[i]).toBeGreaterThanOrEqual(Math.floor(h * 100 + 1e-9));
        expect(cent[i]).toBeLessThanOrEqual(Math.ceil(h * 100 - 1e-9));
      });
    }
  });

  it('costearTramos: la captura del cliente (CUN–PTU–CUN a $746/hr, horas pactadas 2.4) — tramos «1.19» + «1.19» = «2.38» y el dinero idéntico', () => {
    const r = costearTramos({
      tramos: [
        {
          orden: 1,
          origen: 'CUN',
          destino: 'PTU',
          millas: 125,
          tiempo_hr: 1.1917,
        },
        {
          orden: 2,
          origen: 'PTU',
          destino: 'CUN',
          millas: 125,
          tiempo_hr: 1.1917,
        },
      ],
      tarifaHora: 746,
      servicioAereoUsd: 1790.4,
      horas: {
        tiempo_cobrable_hr: 2.4,
        sobrevuelo_hr: 0,
        hora_minima_aplicada: false,
        cobrable_override: true,
      },
    });
    expect(r.tramos.map((t) => t.tiempo_horas)).toEqual(['1.19', '1.19']);
    expect(r.tramos_tiempo_total_horas).toBe('2.38');
    // Lo LEGADO sigue viajando igual (compatibilidad), y era lo que no cuadraba.
    expect(r.tramos.map((t) => t.tiempo_hhmm)).toEqual(['01:12', '01:12']);
    expect(r.tramos_tiempo_total_hhmm).toBe('02:23');
    // El dinero NO se mueve: es solo presentación.
    expect(r.tramos.map((t) => t.tiempo_hr)).toEqual([1.1917, 1.1917]);
    expect(r.tramos.map((t) => t.total_usd)).toEqual([889.01, 889.01]);
    expect(r.tramos_total_usd).toBe(1778.02);
    expect(r.tramos_ajuste_usd).toBe(12.38);
    expect(r.tramos_ajuste_motivo).toBe('Horas pactadas 2.4 h');
  });

  it('costearTramos: un tramo SIN tiempo en el snapshot pinta «—» (null) y el total suma los demás', () => {
    const r = costearTramos({
      tramos: [
        { orden: 1, origen: 'CUN', destino: 'HOL', tiempo_hr: 0.5 },
        { orden: 2, origen: 'HOL', destino: 'CUN' },
        { orden: 3, origen: 'CUN', destino: 'CZM', tiempo_hr: 0.335 },
      ],
      tarifaHora: 1000,
      servicioAereoUsd: 835,
      horas: HORAS_NEUTRAS,
    });
    expect(r.tramos.map((t) => t.tiempo_horas)).toEqual(['0.50', null, '0.34']);
    // Como hoy: el tiempo numérico del tramo faltante vale 0.
    expect(r.tramos[1].tiempo_hr).toBe(0);
    expect(r.tramos_tiempo_total_horas).toBe('0.84');
  });
});

// ===== PARIDAD con el PDF interno (payloads REALES de producción) =====

type Fixture = {
  folio: number;
  quote: Record<string, unknown>;
  escalas: EscalaInternaRow[];
  aeropuertos: AeropuertoInternoRow[];
};

/** Fila de `escala` tal como la lee `ESCALA_INTERNA_COLS`. */
function esc(
  orden: number,
  origen: string,
  destino: string,
  plan: string | null = null,
  pdf: string | null = null,
): EscalaInternaRow {
  return {
    orden,
    origen_iata: origen,
    destino_iata: destino,
    fecha_salida_plan: plan,
    pdf_fecha: pdf,
    solo_operativa: false,
    cancelada_at: null,
  };
}

/** Tramo del snapshot (forma EXACTA de `QuotesService.calculate`). */
function tr(
  orden: number,
  origen: string,
  destino: string,
  millas: number,
  tiempo_hr: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orden,
    millas,
    origen,
    destino,
    es_ferry: false,
    tuas_usd: 0,
    pasajeros: 0,
    tiempo_hr,
    pdf_oculto: null,
    tipo_parada: 'NORMAL',
    pernocta_usd: 0,
    servicio_notas: null,
    requiere_pernocta: false,
    ...extra,
  };
}

/**
 * #329 — la cotización de la foto del cliente: 3 tramos (ferry de ida y de
 * regreso) con horas PACTADAS a 1.75 hr sobre 1.65 reales ⇒ la tabla cierra
 * en $2,722.50 y el desglose dice $2,887.50: los $165.00 de diferencia son el
 * ajuste con su motivo.
 */
const F329: Fixture = {
  folio: 329,
  quote: {
    fecha_vuelo: '2026-09-23T13:00:00+00:00',
    subtotal_vuelo_usd: 2887.5,
    tarifa_hora_usd: 1650,
    tiempo_cobrable_hr: 1.75,
    pasajeros: 4,
    calculo_snapshot: {
      tiempos: {
        vuelo_hr: 1.2,
        calzos_hr: 0.45,
        cobrable_hr: 1.75,
        sobrevuelo_hr: 0,
        cobrable_hr_regla: 1.65,
        minimo_hora_aplicado: false,
        cobrable_proviene_de_override: true,
      },
      tarifa: {
        tipo: 'BROKER',
        usd_por_hora: 1650,
        preferencial_cliente: false,
        proviene_de_override: false,
      },
      tramos: [
        tr(1, 'CUN', 'PCE', 27, 0.33, { es_ferry: true }),
        tr(2, 'PCE', 'PPS', 63, 0.57, { tuas_usd: 100, pasajeros: 4 }),
        tr(3, 'PPS', 'CUN', 90, 0.75, { es_ferry: true }),
      ],
      totales: { subtotal_vuelo_usd: 2887.5 },
      desglose: [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1.75 hr × $1650/hr',
          monto_usd: 2887.5,
        },
      ],
    },
  },
  escalas: [
    esc(1, 'CUN', 'PCE', '2026-09-23T13:00:00+00:00'),
    esc(2, 'PCE', 'PPS'),
    esc(3, 'PPS', 'CUN'),
  ],
  aeropuertos: [
    {
      iata: 'CUN',
      nombre: 'Aeropuerto Internacional de Cancun',
      ciudad: 'Cancun',
    },
    { iata: 'PCE', nombre: 'Playa Del Carmen ', ciudad: 'Playa del Carmen ' },
    { iata: 'PPS', nombre: 'Punta Pajaros ', ciudad: 'Carrillo Puerto ' },
  ],
};

/** #311 — redondo simple que CUADRA exacto: ajuste 0 y motivo null. */
const F311: Fixture = {
  folio: 311,
  quote: {
    fecha_vuelo: '2026-12-20T17:00:00+00:00',
    subtotal_vuelo_usd: 750,
    tarifa_hora_usd: 750,
    tiempo_cobrable_hr: 1,
    pasajeros: 2,
    calculo_snapshot: {
      tiempos: {
        vuelo_hr: 0.7,
        calzos_hr: 0.3,
        cobrable_hr: 1,
        sobrevuelo_hr: 0,
        cobrable_hr_regla: 1,
        minimo_hora_aplicado: false,
        cobrable_proviene_de_override: false,
      },
      tarifa: {
        tipo: 'PUBLICO',
        usd_por_hora: 750,
        preferencial_cliente: false,
        proviene_de_override: false,
      },
      tramos: [
        tr(1, 'CUN', 'HOL', 42, 0.5, { pasajeros: 2 }),
        tr(2, 'HOL', 'CUN', 42, 0.5, { pasajeros: 2 }),
      ],
      totales: { subtotal_vuelo_usd: 750 },
      desglose: [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 1 hr × $750/hr',
          monto_usd: 750,
        },
      ],
    },
  },
  escalas: [
    esc(1, 'CUN', 'HOL', '2026-12-20T17:00:00+00:00'),
    esc(2, 'HOL', 'CUN', '2026-12-20T17:30:00+00:00'),
  ],
  aeropuertos: [
    {
      iata: 'CUN',
      nombre: 'Aeropuerto Internacional de Cancun',
      ciudad: 'Cancun',
    },
    { iata: 'HOL', nombre: 'Aeropuerto de Holbox', ciudad: 'Isla Holbox' },
  ],
};

/**
 * #294 — el de 8 tramos: ferries ocultos del PDF, dos días (28-sep y 10-oct)
 * y millas de tres cifras. Es el caso que más veces multiplica y suma.
 */
const F294: Fixture = {
  folio: 294,
  quote: {
    fecha_vuelo: '2026-09-28T12:00:00+00:00',
    subtotal_vuelo_usd: 7200,
    tarifa_hora_usd: 1000,
    tiempo_cobrable_hr: 7.2,
    pasajeros: 3,
    calculo_snapshot: {
      tiempos: {
        vuelo_hr: 6,
        calzos_hr: 1.2,
        cobrable_hr: 7.2,
        sobrevuelo_hr: 0,
        cobrable_hr_regla: 7.2,
        minimo_hora_aplicado: false,
        cobrable_proviene_de_override: false,
      },
      tarifa: {
        tipo: 'PUBLICO',
        usd_por_hora: 1000,
        preferencial_cliente: false,
        proviene_de_override: true,
      },
      tramos: [
        tr(1, 'CUN', 'BZE', 224, 1.6433, { pasajeros: 3 }),
        tr(2, 'BZE', 'SPR', 30, 0.35, { pasajeros: 3 }),
        tr(3, 'SPR', 'CZM', 166, 1.2567, { es_ferry: true, pdf_oculto: true }),
        tr(4, 'CZM', 'CUN', 30, 0.35, { es_ferry: true, pdf_oculto: true }),
        tr(5, 'CUN', 'BZE', 224, 1.6433, { es_ferry: true, pdf_oculto: true }),
        tr(6, 'BZE', 'SPR', 30, 0.35, { es_ferry: true, pdf_oculto: true }),
        tr(7, 'SPR', 'CZM', 166, 1.2567, { pasajeros: 3 }),
        tr(8, 'CZM', 'CUN', 30, 0.35, { tuas_usd: 75, pasajeros: 3 }),
      ],
      totales: { subtotal_vuelo_usd: 7200 },
      desglose: [
        {
          clave: 'TIEMPO_VUELO',
          concepto: 'Tiempo de vuelo · 7.2 hr × $1000/hr',
          monto_usd: 7200,
        },
      ],
    },
  },
  escalas: [
    esc(1, 'CUN', 'BZE', '2026-09-28T12:00:00+00:00', '2026-09-28'),
    esc(2, 'BZE', 'SPR', null, '2026-09-28'),
    esc(3, 'SPR', 'CZM'),
    esc(4, 'CZM', 'CUN'),
    esc(5, 'CUN', 'BZE'),
    esc(6, 'BZE', 'SPR'),
    esc(7, 'SPR', 'CZM', null, '2026-10-10'),
    esc(8, 'CZM', 'CUN', '2026-10-10T12:00:00+00:00', '2026-10-10'),
  ],
  aeropuertos: [
    {
      iata: 'BZE',
      nombre: 'Philip S W Goldson International Belize City, Belize, BZ',
      ciudad: 'Belize City, Belize, BZ',
    },
    {
      iata: 'CUN',
      nombre: 'Aeropuerto Internacional de Cancun',
      ciudad: 'Cancun',
    },
    {
      iata: 'CZM',
      nombre: 'Aeropuerto Internacional de Cozumel',
      ciudad: 'Cozumel',
    },
    {
      iata: 'SPR',
      nombre: 'John Greif II BZ',
      ciudad: 'San Pedro, Belize, BZ',
    },
  ],
};

function payloadDe(f: Fixture) {
  const aeropuertoPorIata = new Map<string, AeropuertoInternoRow>();
  for (const a of f.aeropuertos) {
    aeropuertoPorIata.set((a.iata ?? '').toUpperCase(), a);
  }
  const insumos: CotizacionInternaInsumos = {
    quote: f.quote,
    escalas: f.escalas,
    cobros: [],
    cliente: null,
    nombrePorId: new Map(),
    aeropuertoPorIata,
    apoyos: [],
    creadoPorId: null,
    generadoPor: null,
    ahora: new Date('2026-09-22T12:00:00-05:00'),
  };
  return armarCotizacionInternaPayload(insumos);
}

/** Lo que la oficina lee en cada renglón de la tabla del Excel. */
function filas(f: Fixture) {
  return payloadDe(f).tramos_cotizados.map((t) => [
    t.orden,
    t.ruta,
    t.fecha,
    t.millas,
    t.tiempo_hr,
    t.tiempo_hhmm,
    t.tarifa_hora_usd,
    t.total_usd,
  ]);
}

describe('PARIDAD del costeo por tramo con el PDF interno (payloads REALES de prod, 22-sep-2026)', () => {
  it('#329 (3 tramos, horas PACTADAS): la tabla cierra en $2,722.50 y el ajuste de $165.00 dice por qué', () => {
    const p = payloadDe(F329);
    // Fila COMPLETA (todas las llaves del contrato con pyservices).
    expect(p.tramos_cotizados[0]).toEqual({
      orden: 1,
      ruta: 'Cancun-Playa del Carmen',
      origen_iata: 'CUN',
      destino_iata: 'PCE',
      origen_nombre: 'Cancun',
      destino_nombre: 'Playa del Carmen',
      fecha: '2026-09-23',
      millas: 27,
      tiempo_hr: 0.33,
      tiempo_hhmm: '00:20',
      tiempo_horas: '0.33',
      tarifa_hora_usd: 1650,
      total_usd: 544.5,
      pax: 0,
      es_ferry: true,
      pernocta: false,
      pernocta_usd: 0,
      tuas_usd: 0,
      consolidado: false,
    });
    expect(filas(F329)).toEqual([
      [
        1,
        'Cancun-Playa del Carmen',
        '2026-09-23',
        27,
        0.33,
        '00:20',
        1650,
        544.5,
      ],
      [
        2,
        'Playa del Carmen-Carrillo Puerto',
        '2026-09-23',
        63,
        0.57,
        '00:34',
        1650,
        940.5,
      ],
      [
        3,
        'Carrillo Puerto-Cancun',
        '2026-09-23',
        90,
        0.75,
        '00:45',
        1650,
        1237.5,
      ],
    ]);
    expect(p.tramos_tiempo_total_hr).toBe(1.65);
    expect(p.tramos_tiempo_total_hhmm).toBe('01:39');
    // TIEMPO VUELO (HRS), API 0.0.33: 0.33 + 0.57 + 0.75 = 1.65.
    expect(p.tramos_cotizados.map((t) => t.tiempo_horas)).toEqual([
      '0.33',
      '0.57',
      '0.75',
    ]);
    expect(p.tramos_tiempo_total_horas).toBe('1.65');
    expect(p.tramos_total_usd).toBe(2722.5);
    expect(p.tramos_ajuste_usd).toBe(165);
    expect(p.tramos_ajuste_motivo).toBe('Horas pactadas 1.75 h');
    // La identidad que sostiene toda la hoja interna.
    expect(p.tramos_total_usd + p.tramos_ajuste_usd).toBe(p.subtotal_vuelo_usd);
    expect(p.ruta).toBe('CUN → PCE → PPS → CUN');
  });

  it('#311 (2 tramos): cuadra exacto — ajuste 0 y SIN motivo', () => {
    const p = payloadDe(F311);
    expect(filas(F311)).toEqual([
      [1, 'Cancun-Isla Holbox', '2026-12-20', 42, 0.5, '00:30', 750, 375],
      [2, 'Isla Holbox-Cancun', '2026-12-20', 42, 0.5, '00:30', 750, 375],
    ]);
    expect(p.tramos_tiempo_total_hr).toBe(1);
    expect(p.tramos_tiempo_total_hhmm).toBe('01:00');
    expect(p.tramos_cotizados.map((t) => t.tiempo_horas)).toEqual([
      '0.50',
      '0.50',
    ]);
    expect(p.tramos_tiempo_total_horas).toBe('1.00');
    expect(p.tramos_total_usd).toBe(750);
    expect(p.tramos_ajuste_usd).toBe(0);
    expect(p.tramos_ajuste_motivo).toBeNull();
    expect(p.ruta).toBe('CUN → HOL → CUN');
  });

  it('#294 (8 tramos, dos días): 8 renglones, Σ $7,200.00 exactos y las fechas de los tramos intermedios heredadas', () => {
    const p = payloadDe(F294);
    expect(filas(F294)).toEqual([
      [
        1,
        'Cancun-Belize City',
        '2026-09-28',
        224,
        1.6433,
        '01:39',
        1000,
        1643.3,
      ],
      [2, 'Belize City-San Pedro', '2026-09-28', 30, 0.35, '00:21', 1000, 350],
      [
        3,
        'San Pedro-Cozumel',
        '2026-09-28',
        166,
        1.2567,
        '01:15',
        1000,
        1256.7,
      ],
      [4, 'Cozumel-Cancun', '2026-09-28', 30, 0.35, '00:21', 1000, 350],
      [
        5,
        'Cancun-Belize City',
        '2026-09-28',
        224,
        1.6433,
        '01:39',
        1000,
        1643.3,
      ],
      [6, 'Belize City-San Pedro', '2026-09-28', 30, 0.35, '00:21', 1000, 350],
      [
        7,
        'San Pedro-Cozumel',
        '2026-10-10',
        166,
        1.2567,
        '01:15',
        1000,
        1256.7,
      ],
      [8, 'Cozumel-Cancun', '2026-10-10', 30, 0.35, '00:21', 1000, 350],
    ]);
    expect(p.tramos_tiempo_total_hr).toBe(7.2);
    expect(p.tramos_tiempo_total_hhmm).toBe('07:12');
    // Los 8 tramos (ferries ocultos incluidos: el documento INTERNO los
    // imprime todos) suman exacto el total.
    expect(p.tramos_cotizados.map((t) => t.tiempo_horas)).toEqual([
      '1.64',
      '0.35',
      '1.26',
      '0.35',
      '1.64',
      '0.35',
      '1.26',
      '0.35',
    ]);
    expect(p.tramos_tiempo_total_horas).toBe('7.20');
    expect(p.tramos_total_usd).toBe(7200);
    expect(p.tramos_ajuste_usd).toBe(0);
    expect(p.tramos_ajuste_motivo).toBeNull();
    // Ferry ⇒ 0 pax aunque el PDF los oculte; el ocultamiento es del PDF.
    expect(p.tramos_cotizados.map((t) => t.pax)).toEqual([
      3, 3, 0, 0, 0, 0, 3, 3,
    ]);
    expect(p.ruta).toBe('CUN → BZE → SPR → CZM → CUN → BZE → SPR → CZM → CUN');
  });

  it('el snapshot que YA trae `total_usd`/`tarifa_usd_hr` por tramo (cotizaciones nuevas) se LEE, no se recalcula', () => {
    const conImportes: Fixture = {
      ...F311,
      quote: {
        ...F311.quote,
        calculo_snapshot: {
          ...(F311.quote.calculo_snapshot as Record<string, unknown>),
          tramos: [
            tr(1, 'CUN', 'HOL', 42, 0.5, {
              pasajeros: 2,
              tarifa_usd_hr: 750,
              total_usd: 375,
            }),
            tr(2, 'HOL', 'CUN', 42, 0.5, {
              pasajeros: 2,
              tarifa_usd_hr: 750,
              total_usd: 375,
            }),
          ],
        },
      },
    };
    expect(filas(conImportes)).toEqual(filas(F311));
  });
});
