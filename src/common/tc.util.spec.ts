import { cobrosEnUsd } from './cobros-usd.util';
import { resolverCostoExterno } from './costo-externo.util';
import { TC_DECIMALES, normalizarTc, round6, totalMxnDeVuelo } from './tc.util';

/**
 * Réplica PURA de la fórmula del backfill de la migración
 * `20260917000002_tc_seis_decimales.sql`, para congelarla con los casos
 * REALES de producción. Si esto cambia, la migración cambia (y viceversa).
 */
function tcBackfill(v: {
  monto_total_usd: number;
  monto_total_mxn: number;
  mxn_nativos: number;
  usd_de_mxn: number;
}): { tc: number; recompuesto: number; aplica: boolean } | null {
  const denominador = v.monto_total_usd - v.usd_de_mxn;
  if (!(denominador > 0)) return null;
  const tc = round6((v.monto_total_mxn - v.mxn_nativos) / denominador);
  const recompuesto = Math.round(denominador * tc * 100) / 100 + v.mxn_nativos;
  return {
    tc,
    recompuesto,
    aplica: tc >= 10 && tc <= 30 && recompuesto === v.monto_total_mxn,
  };
}

describe('tc.util — precisión única del tipo de cambio (6 decimales)', () => {
  it('TC_DECIMALES es 6 (contrato con numeric(12,6) de la BD)', () => {
    expect(TC_DECIMALES).toBe(6);
  });

  describe('round6', () => {
    it('redondea a 6 decimales', () => {
      expect(round6(16.9916317491)).toBe(16.991632);
      expect(round6(17.2860847017)).toBe(17.286085);
      expect(round6(16.9499443826)).toBe(16.949944);
    });

    it('es idempotente sobre un TC ya normalizado', () => {
      expect(round6(round6(16.9916317491))).toBe(16.991632);
      expect(round6(17.5)).toBe(17.5);
      expect(round6(16.9916)).toBe(16.9916);
    });

    it('no inventa decimales ni pierde el .5 en el borde', () => {
      expect(round6(1.0000005)).toBe(1.000001);
      expect(round6(17)).toBe(17);
    });

    it('propaga no-números como NaN (nunca 0 en falso)', () => {
      expect(Number.isNaN(round6(Number.NaN))).toBe(true);
      expect(Number.isNaN(round6(Number.POSITIVE_INFINITY))).toBe(true);
    });
  });

  describe('normalizarTc', () => {
    it('normaliza un TC capturado con muchos decimales', () => {
      expect(normalizarTc(16.9916317491)).toBe(16.991632);
      expect(normalizarTc('16.9916317491')).toBe(16.991632);
    });

    it('null para "sin TC" (null, vacío, 0, negativo, basura)', () => {
      expect(normalizarTc(null)).toBeNull();
      expect(normalizarTc(undefined)).toBeNull();
      expect(normalizarTc('')).toBeNull();
      expect(normalizarTc(0)).toBeNull();
      expect(normalizarTc(-17)).toBeNull();
      expect(normalizarTc('no')).toBeNull();
    });

    it('es idempotente (motor y persistencia dan el MISMO número)', () => {
      const delDto = normalizarTc(100000 / 5885.25);
      expect(delDto).toBe(16.991632);
      expect(normalizarTc(delDto)).toBe(delDto);
    });
  });

  describe('composición del total MXN con el TC de 6 decimales', () => {
    // Regla del motor (quotes.service): componentes genuinamente USD × TC
    // (un solo redondeo) + renglones NATIVOS en MXN tal cual.
    const componer = (
      totalUsd: number,
      tc: number,
      usdDeMxn = 0,
      mxnNativos = 0,
    ): number =>
      Math.round(
        (Math.round((totalUsd - usdDeMxn) * tc * 100) / 100 + mxnNativos) * 100,
      ) / 100;

    it('vuelo #314: 5885.25 USD @ 16.991632 ⇒ $100,000.00 MXN exactos', () => {
      const tc = normalizarTc(100000 / 5885.25)!;
      expect(tc).toBe(16.991632);
      expect(componer(5885.25, tc)).toBe(100000);
    });

    it('vuelo #314 con el TC truncado a 4 decimales daba 99,999.81 (el bug)', () => {
      expect(componer(5885.25, 16.9916)).toBe(99999.81);
    });

    it('vuelo #140: 2314 USD @ 17.286085 ⇒ $40,000.00 MXN exactos', () => {
      const tc = normalizarTc(40000 / 2314)!;
      expect(tc).toBe(17.286085);
      expect(componer(2314, tc)).toBe(40000);
      // Con 4 decimales el total se iba 4 centavos arriba.
      expect(componer(2314, 17.2861)).toBe(40000.04);
    });
  });

  describe('totalMxnDeVuelo', () => {
    it('devuelve el total PERSISTIDO (lo que el cliente vio), no lo recalcula', () => {
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: 100000,
          monto_total_usd: 5885.25,
          tc_usd_mxn: 16.9916,
        }),
      ).toBe(100000);
    });

    it('acepta strings de PostgREST (numeric llega como texto)', () => {
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: '100000.00',
          monto_total_usd: '5885.25',
          tc_usd_mxn: '16.991632',
        }),
      ).toBe(100000);
    });

    it('un total 0 legítimo (cliente interno) se respeta', () => {
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: 0,
          monto_total_usd: 0,
          tc_usd_mxn: 17.5,
        }),
      ).toBe(0);
    });

    it('sin total persistido cae a round2(usd × tc)', () => {
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: null,
          monto_total_usd: 5885.25,
          tc_usd_mxn: 16.991632,
        }),
      ).toBe(100000);
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: null,
          monto_total_usd: 2314,
          tc_usd_mxn: 17.286085,
        }),
      ).toBe(40000);
    });

    it('sin total ni TC devuelve null (jamás 0 en falso)', () => {
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: null,
          monto_total_usd: 5885.25,
          tc_usd_mxn: null,
        }),
      ).toBeNull();
      expect(
        totalMxnDeVuelo({
          monto_total_mxn: null,
          monto_total_usd: null,
          tc_usd_mxn: 17.5,
        }),
      ).toBeNull();
    });
  });

  describe('cobrosEnUsd con el TC de 6 decimales (invariante 2)', () => {
    it('100,000 MXN @ 16.991632 ⇒ 5,885.25 USD (cierra el vuelo #314)', () => {
      const r = cobrosEnUsd(
        [{ monto: 100000, moneda: 'MXN', tc_usd_mxn: 16.991632 }],
        null,
      );
      expect(r.total_usd).toBe(5885.25);
      expect(r.sin_tc_count).toBe(0);
    });

    it('con el TC truncado a 4 decimales sobraba un centavo (5,885.26)', () => {
      expect(
        cobrosEnUsd(
          [{ monto: 100000, moneda: 'MXN', tc_usd_mxn: 16.9916 }],
          null,
        ).total_usd,
      ).toBe(5885.26);
    });

    it('el TC de respaldo del vuelo también entra con 6 decimales', () => {
      expect(
        cobrosEnUsd([{ monto: 40000, moneda: 'MXN' }], 17.286085).total_usd,
      ).toBe(2314);
    });
  });

  describe('costo del operador EXTERNO con el MISMO TC que se persiste', () => {
    // El costo de un externo en pesos se convierte a USD con el TC de la
    // cotización (`resolverCostoExterno`). Ese TC tiene que ser el MISMO que
    // queda en `vuelo.tc_usd_mxn` y en `costo_externo_tc`: con el TC crudo
    // del DTO, la columna guardaba un número que el vuelo nunca tuvo y el
    // `costo_externo_usd` derivado no volvía a salir al recalcularlo.
    const TC_CRUDO = 16.9916317491;

    it('el TC del costo externo es el NORMALIZADO, no el crudo del DTO', () => {
      const tc = normalizarTc(TC_CRUDO);
      const c = resolverCostoExterno({
        monto: 100000,
        moneda: 'MXN',
        tcVuelo: tc,
      });
      expect(tc).toBe(16.991632);
      expect(c.tc).toBe(16.991632);
      // El USD derivado se reproduce con el TC que quedó guardado.
      expect(c.usd).toBe(Math.round((100000 / 16.991632) * 100) / 100);
    });

    it('con el TC crudo el guardado ya no reproducía el derivado', () => {
      const crudo = resolverCostoExterno({
        monto: 100000,
        moneda: 'MXN',
        tcVuelo: TC_CRUDO,
      });
      // `costo_externo_tc` es numeric sin escala: guardaba el crudo, pero el
      // vuelo guardaba 16.991632 — dos TC distintos para el mismo dinero.
      expect(crudo.tc).not.toBe(normalizarTc(TC_CRUDO));
    });
  });

  describe('fórmula del BACKFILL (casos reales de producción)', () => {
    it('#314 · 5885.25 · 100,000.00 · 16.9916 ⇒ TC 16.991632', () => {
      const r = tcBackfill({
        monto_total_usd: 5885.25,
        monto_total_mxn: 100000,
        mxn_nativos: 0,
        usd_de_mxn: 0,
      })!;
      expect(r.tc).toBe(16.991632);
      expect(r.recompuesto).toBe(100000);
      expect(r.aplica).toBe(true);
    });

    it('#140 · 2314 · 40,000.00 · 17.2861 ⇒ TC 17.286085', () => {
      const r = tcBackfill({
        monto_total_usd: 2314,
        monto_total_mxn: 40000,
        mxn_nativos: 0,
        usd_de_mxn: 0,
      })!;
      expect(r.tc).toBe(17.286085);
      expect(r.recompuesto).toBe(40000);
      expect(r.aplica).toBe(true);
    });

    it('#179 · 3596 · 60,952.00 · 16.9499 ⇒ TC 16.949944', () => {
      const r = tcBackfill({
        monto_total_usd: 3596,
        monto_total_mxn: 60952,
        mxn_nativos: 0,
        usd_de_mxn: 0,
      })!;
      expect(r.tc).toBe(16.949944);
      expect(r.recompuesto).toBe(60952);
      expect(r.aplica).toBe(true);
    });

    it('#81 · TUAS en pesos: el TC 17.5 NO se mueve (el desfase era la composición)', () => {
      const r = tcBackfill({
        monto_total_usd: 2629.29,
        monto_total_mxn: 46012.5,
        mxn_nativos: 2700,
        usd_de_mxn: 154.29,
      })!;
      expect(r.tc).toBe(17.5);
      expect(r.recompuesto).toBe(46012.5);
      expect(r.aplica).toBe(true);
      // Por qué salía "inconsistente": usd × tc plano ignora los renglones
      // nativos en MXN y da 46,012.58.
      expect(Math.round(2629.29 * 17.5 * 100) / 100).toBe(46012.58);
    });

    it('sin denominador USD (todo el vuelo en pesos) no se toca nada', () => {
      expect(
        tcBackfill({
          monto_total_usd: 154.29,
          monto_total_mxn: 2700,
          mxn_nativos: 2700,
          usd_de_mxn: 154.29,
        }),
      ).toBeNull();
    });

    it('un TC fuera de la banda 10–30 NO se aplica (dato sucio)', () => {
      const r = tcBackfill({
        monto_total_usd: 100,
        monto_total_mxn: 100,
        mxn_nativos: 0,
        usd_de_mxn: 0,
      })!;
      expect(r.tc).toBe(1);
      expect(r.aplica).toBe(false);
    });
  });
});
