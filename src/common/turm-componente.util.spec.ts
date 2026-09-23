import {
  mensajeTurmNegativo,
  mensajeTurmSuperaTotales,
  resolverTsoBase,
} from './turm-componente.util';

/**
 * T.U.R.M. = TSO (22-sep-2026). Aquí se congela la lectura correcta de la
 * bitácora física y el caso REAL que reportó la oficina.
 */
describe('resolverTsoBase (T.U.R.M. de la bitácora = horas DESDE el overhaul)', () => {
  it('CASO REAL XB-ANU: T.T. 2708 · T.U.R.M. 364 ⇒ tso_base 364 (antes 2344)', () => {
    // Hélice s/n 782316, TBO 2000. Con la lectura vieja (2708 − 364 = 2344)
    // la ficha pintaba «Restantes −344.00 · Vida usada 100 %».
    expect(resolverTsoBase(2708, 364)).toEqual({ ok: true, tso_base: 364 });
  });

  it('el componente recién overhauleado queda en 0 (no en las horas totales)', () => {
    expect(resolverTsoBase(2708, 0)).toEqual({ ok: true, tso_base: 0 });
  });

  it('T.U.R.M. == T.T. (componente que nunca se reparó pero se capturó igual) sí pasa', () => {
    expect(resolverTsoBase(1630, 1630)).toEqual({ ok: true, tso_base: 1630 });
  });

  it('redondea a 1 decimal, como el resto de las horas del repo', () => {
    expect(resolverTsoBase(2708, 364.06)).toEqual({
      ok: true,
      tso_base: 364.1,
    });
    expect(resolverTsoBase(2708.04, 2708.04)).toEqual({
      ok: true,
      tso_base: 2708,
    });
  });

  it('null = SIN overhaul registrado ⇒ tso_base null (respaldo «TSO = horas de vida»)', () => {
    expect(resolverTsoBase(2708, null)).toEqual({ ok: true, tso_base: null });
    expect(resolverTsoBase(null, null)).toEqual({ ok: true, tso_base: null });
  });

  it('T.U.R.M. > T.T. ⇒ 400 con el texto que explica cuál se capturó al revés', () => {
    const r = resolverTsoBase(364, 2708);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('debía fallar');
    expect(r.mensaje).toBe(mensajeTurmSuperaTotales(2708, 364));
    expect(r.mensaje).toContain('2,708.0');
    expect(r.mensaje).toContain('364.0');
  });

  it('sin horas totales capturadas (T.T. 0) cualquier T.U.R.M. > 0 se rechaza', () => {
    // Caso N58BT (ht = 0 en prod): el 400 obliga a capturar primero las
    // horas de vida en vez de dejar un TSO mayor que el TSN.
    const r = resolverTsoBase(0, 387.4);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('debía fallar');
    expect(r.mensaje).toBe(mensajeTurmSuperaTotales(387.4, 0));
  });

  it('T.U.R.M. negativo ⇒ 400 (el DTO ya lo veta; el util no confía)', () => {
    const r = resolverTsoBase(2708, -1);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('debía fallar');
    expect(r.mensaje).toBe(mensajeTurmNegativo(-1));
  });

  it('horas base undefined cuenta como 0 (create sin horas_totales)', () => {
    expect(resolverTsoBase(undefined, 0)).toEqual({ ok: true, tso_base: 0 });
    expect(resolverTsoBase(undefined, 5).ok).toBe(false);
  });

  /**
   * El T.U.R.M. que se teclea es el de HOY; `tso_base` vive en el marco del
   * ANCLA (`aeronave_horas_ref`). Caso REAL: las dos hélices del N4142R están
   * ancladas en 4448.9 con el taco en 5546.9 ⇒ delta 1,098 h.
   */
  describe('delta del taco (el T.U.R.M. es el de HOY)', () => {
    it('resta lo volado desde el ancla: 500 de hoy ⇒ tso_base 1,098 menos', () => {
      expect(resolverTsoBase(4448.9, 500, 1098)).toEqual({
        ok: true,
        tso_base: -598,
      });
    });

    it('el negativo es legítimo: tso_base + delta reconstruye el TSO tecleado', () => {
      const r = resolverTsoBase(4448.9, 12, 1098);
      if (!r.ok) throw new Error('debía pasar');
      expect((r.tso_base as number) + 1098).toBe(12);
    });

    it('el techo es la vida VIVA (base + delta), no la base anclada', () => {
      expect(resolverTsoBase(4448.9, 5000, 1098)).toEqual({
        ok: true,
        tso_base: 3902,
      });
      const r = resolverTsoBase(4448.9, 5600, 1098);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('debía fallar');
      expect(r.mensaje).toBe(mensajeTurmSuperaTotales(5600, 5546.9));
    });

    it('delta 0, ausente, negativo o basura ⇒ el T.U.R.M. entra tal cual', () => {
      expect(resolverTsoBase(2708, 364, 0)).toEqual({
        ok: true,
        tso_base: 364,
      });
      expect(resolverTsoBase(2708, 364)).toEqual({ ok: true, tso_base: 364 });
      expect(resolverTsoBase(2708, 364, null)).toEqual({
        ok: true,
        tso_base: 364,
      });
      // Un ancla por delante del taco jamás RESTA vida (misma regla que
      // `deltaDesdeReferencia` con `recortar: true`).
      expect(resolverTsoBase(2708, 364, -50)).toEqual({
        ok: true,
        tso_base: 364,
      });
      expect(resolverTsoBase(2708, 364, Number.NaN)).toEqual({
        ok: true,
        tso_base: 364,
      });
    });
  });
});
