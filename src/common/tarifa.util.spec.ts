import {
  TARIFA_DECIMALES,
  TARIFA_TOLERANCIA_ECO,
  esEcoDeTarifa,
  normalizarTarifa,
  round6,
  tarifaPersistida,
} from './tarifa.util';

/**
 * Réplica PURA de la fórmula del backfill de la migración
 * `20260922000002_tarifa_hora_seis_decimales.sql`, para congelarla con los
 * casos REALES de producción. Si esto cambia, la migración cambia (y
 * viceversa).
 *
 * Las TRES guardas, en el mismo orden que el `do $$` de la migración:
 *  1. las HORAS no pueden ser la causa (`round(h, 2) = h`);
 *  2. la diferencia de tarifa es PURO truncamiento (≤ media unidad del 2.º
 *     decimal);
 *  3. la tarifa recuperada reproduce el subtotal AL CENTAVO.
 */
function tarifaBackfill(v: {
  tiempo_cobrable_hr: number;
  tarifa_hora_usd: number;
  subtotal_vuelo_usd: number;
}): {
  t6: number;
  reproduce: number;
  horasSonLaCausa: boolean;
  aplica: boolean;
} | null {
  if (!(v.tarifa_hora_usd > 0) || !(v.tiempo_cobrable_hr > 0)) return null;
  const horasSonLaCausa =
    Math.round(v.tiempo_cobrable_hr * 100) / 100 !== v.tiempo_cobrable_hr;
  const t6 = round6(v.subtotal_vuelo_usd / v.tiempo_cobrable_hr);
  const reproduce = subtotalExacto(v.tiempo_cobrable_hr, t6);
  return {
    t6,
    reproduce,
    horasSonLaCausa,
    aplica:
      !horasSonLaCausa &&
      Math.abs(t6 - v.tarifa_hora_usd) <= TARIFA_TOLERANCIA_ECO &&
      reproduce === v.subtotal_vuelo_usd,
  };
}

/**
 * `round(horas × tarifa, 2)` con la aritmética EXACTA de Postgres (numeric),
 * no con floats: el backfill vive en la BD y la réplica tiene que redondear
 * como la BD (mismo criterio y mismo helper que `horas.util.spec`).
 * Horas en 1e-8, tarifa en 1e-6 ⇒ producto en 1e-14.
 */
function subtotalExacto(horas: number, tarifa: number): number {
  const h = Math.round(horas * 10 ** 8);
  const t = Math.round(tarifa * 10 ** 6);
  const prod = h * t; // USD en 1e-14
  return Math.round(prod / 10 ** 12) / 100;
}

describe('tarifa.util — precisión única de la tarifa por hora (6 decimales)', () => {
  it('TARIFA_DECIMALES es 6 (contrato con numeric(14,6) de la BD)', () => {
    expect(TARIFA_DECIMALES).toBe(6);
  });

  it('la tolerancia del eco es media unidad del 2.º decimal', () => {
    expect(TARIFA_TOLERANCIA_ECO).toBe(0.005);
  });

  describe('round6', () => {
    it('redondea a 6 decimales', () => {
      expect(round6(989.5833333333)).toBe(989.583333);
      expect(round6(2375 / 2.4)).toBe(989.583333);
      expect(round6(1650 / 3)).toBe(550);
    });

    it('es idempotente sobre una tarifa ya normalizada', () => {
      const t = round6(2375 / 2.4);
      expect(round6(t)).toBe(t);
    });

    it('no pierde el .5 en el borde', () => {
      expect(round6(1.0000005)).toBe(1.000001);
      expect(round6(989.5849995)).toBe(989.585);
    });

    it('propaga no-números como NaN (nunca 0 en falso)', () => {
      expect(round6(NaN)).toBeNaN();
      expect(round6(Infinity)).toBeNaN();
    });
  });

  describe('normalizarTarifa', () => {
    it('normaliza una tarifa tecleada con muchos decimales', () => {
      expect(normalizarTarifa(989.5833333333)).toBe(989.583333);
      expect(normalizarTarifa('989.583333')).toBe(989.583333);
    });

    it('null para "sin tarifa" (null, vacío, 0, negativo, basura)', () => {
      expect(normalizarTarifa(null)).toBeNull();
      expect(normalizarTarifa(undefined)).toBeNull();
      expect(normalizarTarifa('')).toBeNull();
      // El 0 del cliente INTERNO no se rehidrata como override: el motor lo
      // re-deriva solo desde `es_interno`.
      expect(normalizarTarifa(0)).toBeNull();
      expect(normalizarTarifa(-100)).toBeNull();
      expect(normalizarTarifa('mil')).toBeNull();
    });

    it('es idempotente (motor y persistencia dan el MISMO número)', () => {
      const t = normalizarTarifa(2375 / 2.4)!;
      expect(normalizarTarifa(t)).toBe(t);
    });
  });

  describe('esEcoDeTarifa', () => {
    it('#105: 989.58 devuelto sobre 989.583333 persistido ES el eco', () => {
      expect(esEcoDeTarifa(989.58, 989.583333)).toBe(true);
    });

    it('una EDICIÓN real se respeta (990, 989.59, 1000)', () => {
      expect(esEcoDeTarifa(990, 989.583333)).toBe(false);
      expect(esEcoDeTarifa(989.59, 989.583333)).toBe(false);
      expect(esEcoDeTarifa(1000, 989.583333)).toBe(false);
    });

    it('MÁS precisión tecleada a mano nunca es eco', () => {
      expect(esEcoDeTarifa(989.583333, 989.58)).toBe(false);
      expect(esEcoDeTarifa(989.5834, 989.58)).toBe(false);
    });

    it('la banda es «medio centavo por hora», no «2 decimales»', () => {
      // Deliberado: cualquier entrante con MENOS decimales dentro de medio
      // centavo por hora se trata como eco. 6.7e-5 USD/hr no mueve un centavo
      // ni en el vuelo más largo que admite el DTO (48 hr).
      expect(esEcoDeTarifa(989.5834, 989.583333)).toBe(true);
      expect(esEcoDeTarifa(989.5833, 989.583333)).toBe(true);
      // Justo fuera de la banda: se respeta.
      expect(esEcoDeTarifa(989.589, 989.583333)).toBe(false);
    });

    it('el mismo número no es eco de sí mismo', () => {
      expect(esEcoDeTarifa(989.583333, 989.583333)).toBe(false);
      expect(esEcoDeTarifa(650, 650)).toBe(false);
    });

    it('una tarifa de CATÁLOGO (2 decimales) jamás dispara el anclaje', () => {
      // Los catálogos son numeric(_,2): lo persistido nunca tiene más
      // decimales que lo entrante, así que el eco no puede darse.
      expect(esEcoDeTarifa(650, 650.0)).toBe(false);
      expect(esEcoDeTarifa(555, 555.0)).toBe(false);
      expect(esEcoDeTarifa(1650, 1650.0)).toBe(false);
    });

    it('no-números: false (jamás se ancla a ciegas)', () => {
      expect(esEcoDeTarifa(NaN, 989.583333)).toBe(false);
      expect(esEcoDeTarifa(989.58, NaN)).toBe(false);
    });
  });

  describe('tarifaPersistida', () => {
    it('gana el snapshot cuando la columna está truncada (#105 sin migración)', () => {
      expect(tarifaPersistida(989.583333, 989.58)).toBe(989.583333);
    });

    it('gana la columna cuando el snapshot es el truncado', () => {
      expect(tarifaPersistida(989.58, 989.583333)).toBe(989.583333);
    });

    it('acepta strings de PostgREST (numeric llega como texto)', () => {
      expect(tarifaPersistida('989.583333', '989.58')).toBe(989.583333);
    });

    it('con uno solo devuelve ese', () => {
      expect(tarifaPersistida(null, 650)).toBe(650);
      expect(tarifaPersistida(650, null)).toBe(650);
      expect(tarifaPersistida(null, null)).toBeNull();
    });

    it('si divergen DE VERDAD manda el snapshot (el registro del motor)', () => {
      expect(tarifaPersistida(1000, 650)).toBe(1000);
    });
  });

  describe('fórmula del BACKFILL (réplica de la migración 20260922000002)', () => {
    it('#105 SE CORRIGE: 2,375.00 ÷ 2.4 recupera 989.583333', () => {
      const r = tarifaBackfill({
        tiempo_cobrable_hr: 2.4,
        tarifa_hora_usd: 989.58,
        subtotal_vuelo_usd: 2375,
      })!;
      expect(r.horasSonLaCausa).toBe(false);
      expect(r.t6).toBe(989.583333);
      expect(r.reproduce).toBe(2375);
      expect(r.aplica).toBe(true);
      // Y lo que hacía el bug: con la tarifa guardada NO cuadraba.
      expect(subtotalExacto(2.4, 989.58)).toBe(2374.99);
    });

    it('#26 NO SE TOCA aunque "cuadraría": su causa son las HORAS', () => {
      // 1,902.14 ÷ 3.4273 = 554.996645 — dentro de la tolerancia (0.003355)
      // y reproduce el subtotal al centavo. Sin la guarda de las horas, el
      // backfill le habría inventado una tarifa de $554.996645/hr a un vuelo
      // cuya tarifa pactada es $555.00 clavados.
      const r = tarifaBackfill({
        tiempo_cobrable_hr: 3.4273,
        tarifa_hora_usd: 555,
        subtotal_vuelo_usd: 1902.14,
      })!;
      expect(r.t6).toBe(554.996645);
      expect(Math.abs(r.t6 - 555)).toBeLessThanOrEqual(TARIFA_TOLERANCIA_ECO);
      expect(r.reproduce).toBe(1902.14);
      // …y aun así NO aplica, por la guarda de las horas.
      expect(r.horasSonLaCausa).toBe(true);
      expect(r.aplica).toBe(false);
      // La causa real: 344 nm ÷ 110 kts + 0.30 de calzos = 3.42727273 hr,
      // que sí reproduce el subtotal con la tarifa redonda de $555.
      expect(subtotalExacto(3.42727273, 555)).toBe(1902.14);
    });

    /** Los OTROS 10 del lote: horas de la regla truncadas, tarifa redonda. */
    const horasDeLaRegla: Array<[number, number, number, number]> = [
      // folio, horas guardadas, tarifa, subtotal
      [6, 1.0083, 650, 655.42],
      [13, 2.3833, 575, 1370.42],
      [22, 2.3067, 900, 2076.0],
      [27, 2.4833, 600, 1490.0],
      [30, 2.2033, 1600, 3525.33],
      [62, 2.9083, 670, 1948.58],
      [166, 1.5267, 850, 1297.67],
      [192, 3.1667, 700, 2216.67],
      [240, 3.6333, 1650, 5995.0],
      [312, 2.6567, 950, 2523.83],
    ];

    it.each(horasDeLaRegla)(
      'vuelo #%s (%s hr × $%s): NO se toca — horas de la regla',
      (_folio, horas, tarifa, subtotal) => {
        const r = tarifaBackfill({
          tiempo_cobrable_hr: horas,
          tarifa_hora_usd: tarifa,
          subtotal_vuelo_usd: subtotal,
        })!;
        expect(r.horasSonLaCausa).toBe(true);
        expect(r.aplica).toBe(false);
      },
    );

    it('el lote de prod da exactamente 1 corregido y 11 intactos', () => {
      const lote = [
        { tiempo_cobrable_hr: 1.0083, tarifa_hora_usd: 650, subtotal_vuelo_usd: 655.42 },
        { tiempo_cobrable_hr: 2.3833, tarifa_hora_usd: 575, subtotal_vuelo_usd: 1370.42 },
        { tiempo_cobrable_hr: 2.3067, tarifa_hora_usd: 900, subtotal_vuelo_usd: 2076.0 },
        { tiempo_cobrable_hr: 3.4273, tarifa_hora_usd: 555, subtotal_vuelo_usd: 1902.14 },
        { tiempo_cobrable_hr: 2.4833, tarifa_hora_usd: 600, subtotal_vuelo_usd: 1490.0 },
        { tiempo_cobrable_hr: 2.2033, tarifa_hora_usd: 1600, subtotal_vuelo_usd: 3525.33 },
        { tiempo_cobrable_hr: 2.9083, tarifa_hora_usd: 670, subtotal_vuelo_usd: 1948.58 },
        { tiempo_cobrable_hr: 2.4, tarifa_hora_usd: 989.58, subtotal_vuelo_usd: 2375 },
        { tiempo_cobrable_hr: 1.5267, tarifa_hora_usd: 850, subtotal_vuelo_usd: 1297.67 },
        { tiempo_cobrable_hr: 3.1667, tarifa_hora_usd: 700, subtotal_vuelo_usd: 2216.67 },
        { tiempo_cobrable_hr: 3.6333, tarifa_hora_usd: 1650, subtotal_vuelo_usd: 5995.0 },
        { tiempo_cobrable_hr: 2.6567, tarifa_hora_usd: 950, subtotal_vuelo_usd: 2523.83 },
      ];
      const corregidos = lote.filter((v) => tarifaBackfill(v)!.aplica);
      expect(corregidos).toHaveLength(1);
      expect(corregidos[0].tarifa_hora_usd).toBe(989.58);
    });

    it('una tarifa de verdad distinta NO se "recupera" (guarda 2)', () => {
      // Subtotal que no corresponde a la tarifa guardada por una razón real
      // (precio pactado, edición posterior): delta enorme ⇒ no se adivina.
      const r = tarifaBackfill({
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        subtotal_vuelo_usd: 1800,
      })!;
      expect(r.t6).toBe(900);
      expect(r.aplica).toBe(false);
    });
  });
});
