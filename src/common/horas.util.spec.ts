import {
  HORAS_DECIMALES,
  HORAS_TOLERANCIA_ECO,
  esEcoDeHorasPactadas,
  horasPactadasPersistidas,
  normalizarHoras,
  round8,
} from './horas.util';

/**
 * Réplica PURA de la fórmula del backfill de la migración
 * `20260922000001_horas_pactadas_ocho_decimales.sql`, para congelarla con los
 * casos REALES de producción. Si esto cambia, la migración cambia (y
 * viceversa).
 */
function horasBackfill(v: {
  tiempo_cobrable_hr: number;
  tarifa_hora_usd: number;
  subtotal_vuelo_usd: number;
}): { h8: number; reproduce: number; aplica: boolean } | null {
  if (!(v.tarifa_hora_usd > 0)) return null;
  const h8 = round8(v.subtotal_vuelo_usd / v.tarifa_hora_usd);
  const reproduce = subtotalExacto(h8, v.tarifa_hora_usd);
  return {
    h8,
    reproduce,
    aplica:
      Math.abs(h8 - v.tiempo_cobrable_hr) <= HORAS_TOLERANCIA_ECO &&
      reproduce === v.subtotal_vuelo_usd,
  };
}

/**
 * `round(horas × tarifa, 2)` con la aritmética EXACTA de Postgres (numeric),
 * no con floats: en enteros de centésimas de millonésima. Hace falta en el
 * borde — #313 da 3.2095 × 650 = 2,086.175 clavados, que `numeric` sube a
 * 2,086.18 y un float64 (2086.17499999…) bajaría a 2,086.17. El backfill vive
 * en la BD: la réplica tiene que redondear como la BD.
 */
function subtotalExacto(horas: number, tarifa: number): number {
  const h = Math.round(horas * 10 ** 8); // horas en 1e-8
  const t = Math.round(tarifa * 100); // tarifa en centavos
  const prod = h * t; // USD en 1e-10
  return Math.round(prod / 10 ** 8) / 100;
}

describe('horas.util — precisión única de las horas pactadas (8 decimales)', () => {
  it('HORAS_DECIMALES es 8 (contrato con numeric(14,8) de la BD)', () => {
    expect(HORAS_DECIMALES).toBe(8);
  });

  describe('round8', () => {
    it('redondea a 8 decimales', () => {
      expect(round8(2.333333333)).toBe(2.33333333);
      expect(round8(7 / 3)).toBe(2.33333333);
      expect(round8(1.153846153846)).toBe(1.15384615);
      expect(round8(0.78947368421)).toBe(0.78947368);
    });

    it('es idempotente sobre unas horas ya normalizadas', () => {
      expect(round8(round8(2.333333333))).toBe(2.33333333);
      expect(round8(2.5)).toBe(2.5);
      expect(round8(2.3333)).toBe(2.3333);
      expect(round8(1)).toBe(1);
    });

    it('propaga no-números como NaN (nunca 0 en falso)', () => {
      expect(Number.isNaN(round8(Number.NaN))).toBe(true);
      expect(Number.isNaN(round8(Number.POSITIVE_INFINITY))).toBe(true);
    });
  });

  describe('normalizarHoras', () => {
    it('normaliza horas capturadas con muchos decimales', () => {
      expect(normalizarHoras(2.333333333)).toBe(2.33333333);
      expect(normalizarHoras('2.333333333')).toBe(2.33333333);
    });

    it('«sin horas pactadas» se propaga como null, jamás como 0', () => {
      expect(normalizarHoras(null)).toBeNull();
      expect(normalizarHoras(undefined)).toBeNull();
      expect(normalizarHoras('')).toBeNull();
      expect(normalizarHoras(0)).toBeNull();
      expect(normalizarHoras(-1)).toBeNull();
      expect(normalizarHoras('abc')).toBeNull();
    });

    it('es idempotente (el motor la llama al calcular y al persistir)', () => {
      const h = normalizarHoras(2.333333333)!;
      expect(normalizarHoras(h)).toBe(h);
    });
  });

  describe('esEcoDeHorasPactadas — copia truncada vs edición real', () => {
    it('2.3333 devuelto contra 2.33333333 persistido ES un eco', () => {
      expect(esEcoDeHorasPactadas(2.3333, 2.33333333)).toBe(true);
    });

    it('teclear MÁS precisión NUNCA es un eco (se respeta la edición)', () => {
      expect(esEcoDeHorasPactadas(2.33333333, 2.3333)).toBe(false);
    });

    it('un pactado distinto de verdad se respeta (2.3334 = 6 centavos a $600)', () => {
      expect(esEcoDeHorasPactadas(2.3334, 2.33333333)).toBe(false);
      expect(esEcoDeHorasPactadas(2.5, 2.33333333)).toBe(false);
      expect(esEcoDeHorasPactadas(1, 2.33333333)).toBe(false);
    });

    it('el mismo número no es eco, y los no-números tampoco', () => {
      expect(esEcoDeHorasPactadas(2.33333333, 2.33333333)).toBe(false);
      expect(esEcoDeHorasPactadas(Number.NaN, 2.33333333)).toBe(false);
      expect(esEcoDeHorasPactadas(2.3333, Number.NaN)).toBe(false);
    });
  });

  describe('horasPactadasPersistidas — gana el que conserve más decimales', () => {
    it('snapshot truncado + columna completa ⇒ la columna', () => {
      expect(horasPactadasPersistidas(2.3333, 2.33333333)).toBe(2.33333333);
    });

    it('snapshot completo + columna truncada ⇒ el snapshot', () => {
      expect(horasPactadasPersistidas(2.33333333, 2.3333)).toBe(2.33333333);
    });

    it('si divergen DE VERDAD manda el snapshot (registro del motor)', () => {
      expect(horasPactadasPersistidas(2.5, 3)).toBe(2.5);
    });

    it('con uno solo de los dos, ese', () => {
      expect(horasPactadasPersistidas(null, 2.33333333)).toBe(2.33333333);
      expect(horasPactadasPersistidas(2.33333333, null)).toBe(2.33333333);
      expect(horasPactadasPersistidas(null, null)).toBeNull();
      expect(horasPactadasPersistidas(0, 0)).toBeNull();
    });

    /**
     * PostgREST entrega un `numeric` como NÚMERO o como CADENA según versión
     * y cliente, y `to_jsonb(2.5::numeric(14,8))` conserva los ceros de cola
     * («2.50000000»). Ninguna de las dos formas puede cambiar el número que
     * se rehidrata: ahí es donde se perdía el centavo de la #322. Los ocho
     * valores son los REALES del backfill más el mínimo y un h:mm redondo.
     */
    it.each([
      2.33333333, 1.15384615, 0.78947368, 2.53846154, 3.2969697, 3.20949231,
      0.83333333, 1.75,
    ])('number o string dan lo MISMO (%s)', (h) => {
      const truncado = Number(h.toFixed(4));
      expect(horasPactadasPersistidas(h, h.toFixed(8))).toBe(h);
      expect(horasPactadasPersistidas(h.toFixed(8), h)).toBe(h);
      expect(horasPactadasPersistidas(truncado.toFixed(4), h.toFixed(8))).toBe(
        h,
      );
      expect(horasPactadasPersistidas(h.toFixed(8), truncado)).toBe(h);
      if (truncado !== h) {
        expect(esEcoDeHorasPactadas(truncado, h)).toBe(true);
        expect(
          esEcoDeHorasPactadas(normalizarHoras(truncado.toFixed(4))!, h),
        ).toBe(true);
      }
    });

    it('PUNTO CIEGO: un redondeo deliberado a 4 decimales SÍ se ancla', () => {
      // #309, $1,650/hr: la oficina teclea «3.297» a propósito (5 centavos
      // más) y es EXACTAMENTE round4 de lo persistido: indistinguible de un
      // eco. Se congela el comportamiento para que nadie lo cambie sin saber.
      expect(esEcoDeHorasPactadas(3.297, 3.2969697)).toBe(true);
      // En cambio 2.3334 sobre 2.33333333 queda FUERA de la tolerancia
      // (6.67e-5 > 5e-5) y se respeta: no todo 4 decimales se ancla.
      expect(esEcoDeHorasPactadas(2.3334, 2.33333333)).toBe(false);
    });

    it('ceros de cola de to_jsonb no inventan precisión', () => {
      expect(horasPactadasPersistidas('2.50000000', '2.5000')).toBe(2.5);
      expect(normalizarHoras('2.50000000')).toBe(2.5);
      expect(esEcoDeHorasPactadas(2.5, 2.5)).toBe(false);
    });
  });

  describe('fórmula del backfill (migración 20260922000001) con datos REALES', () => {
    // Medidos en prod bjesduasnzbzywofukbf el 22-sep-2026: los 12 vuelos con
    // horas pactadas a mano cuyo subtotal ya no cuadraba con sus horas.
    const casos: Array<[number, number, number, number, number]> = [
      // folio, horas guardadas, tarifa, subtotal, horas que recupera
      [188, 1.1538, 650, 750, 1.15384615],
      [222, 1.1538, 650, 750, 1.15384615],
      [242, 0.7895, 950, 750, 0.78947368],
      [254, 2.3333, 600, 1400, 2.33333333],
      [255, 2.3333, 600, 1400, 2.33333333],
      [261, 0.7895, 950, 750, 0.78947368],
      [267, 0.7895, 950, 750, 0.78947368],
      [280, 2.5385, 650, 1650, 2.53846154],
      [301, 2.3333, 600, 1400, 2.33333333],
      [302, 2.3333, 600, 1400, 2.33333333],
      [309, 3.297, 1650, 5440, 3.2969697],
      [313, 3.2095, 650, 2086.17, 3.20949231],
    ];

    it.each(casos)(
      'vuelo #%s: %s hr → recupera %s',
      (_folio, h4, tarifa, subtotal, esperado) => {
        const r = horasBackfill({
          tiempo_cobrable_hr: h4,
          tarifa_hora_usd: tarifa,
          subtotal_vuelo_usd: subtotal,
        })!;
        expect(r.h8).toBe(esperado);
        // Las dos guardas de la migración: truncamiento puro y reproduce el
        // subtotal AL CENTAVO (el dinero que el cliente vio no se mueve).
        expect(r.aplica).toBe(true);
        expect(r.reproduce).toBe(subtotal);
        // Y lo que hacía el bug: con las horas guardadas NO cuadraba (mismo
        // redondeo exacto que el WHERE de la migración).
        expect(subtotalExacto(h4, tarifa)).not.toBe(subtotal);
      },
    );

    it('#313 (el borde): 3.2095 × 650 = 2,086.175 y numeric lo sube a 2,086.18', () => {
      // Por eso la réplica redondea en enteros: con float64 el producto es
      // 2086.17499999… y el vuelo se habría quedado fuera del backfill.
      expect(subtotalExacto(3.2095, 650)).toBe(2086.18);
      expect(subtotalExacto(3.20949231, 650)).toBe(2086.17);
    });

    it('#302: 1,400.00 ÷ 600 devuelve exactamente el pactado de 2 h 20 min', () => {
      const r = horasBackfill({
        tiempo_cobrable_hr: 2.3333,
        tarifa_hora_usd: 600,
        subtotal_vuelo_usd: 1400,
      })!;
      expect(r.h8).toBe(2.33333333);
      expect(r.reproduce).toBe(1400);
      expect(Math.round(2.3333 * 600 * 100) / 100).toBe(1399.98); // el bug
    });

    it('#322 NO entra: su subtotal ya está dañado y SÍ cuadra con 2.3333', () => {
      // 2.3333 × 600 = 1,399.98 == subtotal persistido ⇒ el WHERE de la
      // migración ni siquiera lo selecciona. Se corrige re-guardándolo.
      expect(Math.round(2.3333 * 600 * 100) / 100).toBe(1399.98);
    });

    it('#105 NO entra: descuadra por la TARIFA, no por las horas', () => {
      // 2.4 hr × 989.583333/hr = 2,375.00 persistido, pero la tarifa se guarda
      // como numeric(10,2) = 989.58. La hora "recuperada" sería 2.40000809 —
      // un número falso: la guarda de truncamiento lo deja pasar (delta
      // 8.1e-6) pero el vuelo NO tiene horas pactadas a mano, así que el
      // WHERE de la migración lo excluye. Queda documentado como pendiente.
      const r = horasBackfill({
        tiempo_cobrable_hr: 2.4,
        tarifa_hora_usd: 989.58,
        subtotal_vuelo_usd: 2375,
      })!;
      expect(r.h8).not.toBe(2.4);
      expect(Math.round(2.4 * 989.583333 * 100) / 100).toBe(2375);
    });
  });
});
