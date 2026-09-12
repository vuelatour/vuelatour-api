import { avisoAeronaveEnTaller } from './aviso-taller.util';

/**
 * Texto ÚNICO del aviso de taller (11-sep-2026). El panel y la app lo pintan
 * tal cual en ámbar: si alguien lo reescribe "mejor", los tres repos dejan de
 * decir lo mismo — por eso se congela aquí letra por letra.
 */
describe('avisoAeronaveEnTaller', () => {
  it('arma el texto EXACTO acordado con la matrícula al frente', () => {
    expect(avisoAeronaveEnTaller('XA-VGV')).toBe(
      'XA-VGV está en taller (mantenimiento en curso). Se guardó de todas formas: confirma con el mecánico que estará listo para el vuelo.',
    );
  });

  it('nunca dice "no se puede" ni promete un candado', () => {
    const txt = avisoAeronaveEnTaller('XB-ANU');
    expect(txt).not.toMatch(/no se puede/i);
    expect(txt).toMatch(/Se guardó de todas formas/);
  });

  it('sin matrícula (null, undefined, vacío o espacios) arranca con «El avión», jamás con un hueco', () => {
    const esperado =
      'El avión está en taller (mantenimiento en curso). Se guardó de todas formas: confirma con el mecánico que estará listo para el vuelo.';
    expect(avisoAeronaveEnTaller(null)).toBe(esperado);
    expect(avisoAeronaveEnTaller(undefined)).toBe(esperado);
    expect(avisoAeronaveEnTaller('')).toBe(esperado);
    expect(avisoAeronaveEnTaller('   ')).toBe(esperado);
  });

  it('recorta espacios de la matrícula (viene de la BD tal cual se capturó)', () => {
    expect(avisoAeronaveEnTaller('  XA-VGV  ')).toBe(
      avisoAeronaveEnTaller('XA-VGV'),
    );
  });
});
