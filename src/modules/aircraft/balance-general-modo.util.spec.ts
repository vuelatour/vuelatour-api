import {
  MENSAJE_MODO_BALANCE_INVALIDO,
  MODO_BALANCE_GENERAL_DEFAULT,
  MODOS_BALANCE_GENERAL,
  esModoBalanceGeneral,
  nombreArchivoBalanceGeneral,
} from './balance-general-modo.util';

/**
 * «Balance mensual» / «Balance general» (6-oct-2026, API 0.0.64): fuente
 * única de los modos de la descarga y del nombre del archivo. Los valores
 * son los de `BalanceGeneralRequest.variante` en pyservices y los que manda el
 * panel (`modo=mensual` / `modo=general`).
 */
describe('balance-general-modo.util', () => {
  it('dos modos, en este orden, y el default es el libro de siempre', () => {
    expect(MODOS_BALANCE_GENERAL).toEqual(['mensual', 'general']);
    expect(MODO_BALANCE_GENERAL_DEFAULT).toBe('mensual');
  });

  it('esModoBalanceGeneral: exacto, sin recortar ni cambiar mayúsculas', () => {
    expect(esModoBalanceGeneral('mensual')).toBe(true);
    expect(esModoBalanceGeneral('general')).toBe(true);
    for (const otro of [
      'GENERAL',
      'Mensual',
      ' general',
      'general ',
      '',
      'anual',
      'consolidado',
      undefined,
      null,
      1,
      ['general'],
      { modo: 'general' },
    ]) {
      expect(esModoBalanceGeneral(otro)).toBe(false);
    }
  });

  it('nombre del archivo por modo (el libro de antes hoy es el MENSUAL)', () => {
    expect(
      nombreArchivoBalanceGeneral('mensual', '2026-09-01', '2026-09-30'),
    ).toBe('balance-mensual-vuelatour-2026-09-01-a-2026-09-30.xlsx');
    expect(
      nombreArchivoBalanceGeneral('general', '2026-09-01', '2026-09-30'),
    ).toBe('balance-general-vuelatour-2026-09-01-a-2026-09-30.xlsx');
  });

  it('texto del 400 en es-MX', () => {
    expect(MENSAJE_MODO_BALANCE_INVALIDO).toBe(
      'El modo del balance debe ser «mensual» o «general».',
    );
  });
});
