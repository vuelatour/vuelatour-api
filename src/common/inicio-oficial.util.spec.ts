import { HttpException } from '@nestjs/common';
import {
  corteTs,
  esAntesDelInicio,
  exigirPeriodoDesdeInicio,
  fechaInicioCorta,
  inicioOficialDe,
  pisoDia,
  rangoConPiso,
} from './inicio-oficial.util';

/** INICIO OFICIAL (16-oct-2026, invariante 86): reglas puras del piso. */
const INICIO = '2026-09-01';

describe('inicio-oficial.util', () => {
  describe('pisoDia', () => {
    it('sin inicio ⇒ desde tal cual (también undefined)', () => {
      expect(pisoDia('2026-08-01', null)).toBe('2026-08-01');
      expect(pisoDia(undefined, null)).toBeUndefined();
    });
    it('sin desde ⇒ el inicio', () => {
      expect(pisoDia(undefined, INICIO)).toBe(INICIO);
      expect(pisoDia(null, INICIO)).toBe(INICIO);
    });
    it('menor ⇒ inicio; mayor o igual ⇒ desde', () => {
      expect(pisoDia('2026-08-15', INICIO)).toBe(INICIO);
      expect(pisoDia('2026-09-10', INICIO)).toBe('2026-09-10');
      expect(pisoDia(INICIO, INICIO)).toBe(INICIO);
    });
  });

  describe('rangoConPiso', () => {
    it('vacío cuando hasta < inicio', () => {
      expect(
        rangoConPiso({ desde: '2026-08-01', hasta: '2026-08-31' }, INICIO),
      ).toEqual({ desde: INICIO, hasta: '2026-08-31', vacio: true });
    });
    it('cruza el inicio ⇒ sube desde, no vacío', () => {
      expect(
        rangoConPiso({ desde: '2026-08-25', hasta: '2026-09-10' }, INICIO),
      ).toEqual({ desde: INICIO, hasta: '2026-09-10', vacio: false });
    });
    it('sin inicio ⇒ intacto', () => {
      expect(rangoConPiso({ hasta: '2026-08-31' }, null)).toEqual({
        desde: undefined,
        hasta: '2026-08-31',
        vacio: false,
      });
    });
  });

  describe('exigirPeriodoDesdeInicio', () => {
    it('sube el desde', () => {
      expect(
        exigirPeriodoDesdeInicio('2026-08-15', '2026-09-30', INICIO),
      ).toEqual({ desde: INICIO, hasta: '2026-09-30' });
    });
    it('periodo ≥ inicio ⇒ el mismo', () => {
      expect(
        exigirPeriodoDesdeInicio('2026-09-01', '2026-09-30', INICIO),
      ).toEqual({ desde: '2026-09-01', hasta: '2026-09-30' });
    });
    it('hasta < inicio ⇒ 400 PERIODO_ANTES_DEL_INICIO con details.inicio', () => {
      try {
        exigirPeriodoDesdeInicio('2026-08-01', '2026-08-31', INICIO);
        throw new Error('no lanzó');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(400);
        expect((e as HttpException).getResponse()).toEqual({
          message:
            'El sistema arranca el 1-sep-2026. Elige un periodo a partir de esa fecha.',
          error: 'PERIODO_ANTES_DEL_INICIO',
          details: { inicio: INICIO },
        });
      }
    });
    it('null ⇒ intacto', () => {
      expect(
        exigirPeriodoDesdeInicio('2026-08-01', '2026-08-31', null),
      ).toEqual({ desde: '2026-08-01', hasta: '2026-08-31' });
    });
  });

  it('corteTs ⇒ medianoche Cancún', () => {
    expect(corteTs(INICIO)).toBe('2026-09-01T00:00:00-05:00');
  });

  describe('esAntesDelInicio', () => {
    it('date', () => {
      expect(esAntesDelInicio('2026-08-31', INICIO)).toBe(true);
      expect(esAntesDelInicio('2026-09-01', INICIO)).toBe(false);
    });
    it('timestamptz en el borde Cancún', () => {
      expect(esAntesDelInicio('2026-09-01T04:59:59Z', INICIO)).toBe(true);
      expect(esAntesDelInicio('2026-09-01T05:00:00Z', INICIO)).toBe(false);
    });
    it('sin inicio, sin fecha o fecha inválida ⇒ false', () => {
      expect(esAntesDelInicio('2026-08-31', null)).toBe(false);
      expect(esAntesDelInicio(null, INICIO)).toBe(false);
      expect(esAntesDelInicio('basura', INICIO)).toBe(false);
    });
  });

  it('fechaInicioCorta', () => {
    expect(fechaInicioCorta('2026-09-01')).toBe('1-sep-2026');
    expect(fechaInicioCorta('2026-10-15')).toBe('15-oct-2026');
    expect(fechaInicioCorta('x')).toBe('x');
  });

  describe('inicioOficialDe', () => {
    it('sin servicio o mock sin el método ⇒ null', async () => {
      await expect(inicioOficialDe(undefined)).resolves.toBeNull();
      await expect(inicioOficialDe(null)).resolves.toBeNull();
      await expect(
        inicioOficialDe({ fecha: jest.fn() } as unknown as {
          inicioOficial?: () => Promise<string | null>;
        }),
      ).resolves.toBeNull();
    });
    it('con el método ⇒ su valor; si lanza ⇒ null', async () => {
      await expect(
        inicioOficialDe({ inicioOficial: () => Promise.resolve(INICIO) }),
      ).resolves.toBe(INICIO);
      await expect(
        inicioOficialDe({
          inicioOficial: () => Promise.reject(new Error('x')),
        }),
      ).resolves.toBeNull();
    });
  });
});
