import { MAX_IDS_PRECIERRE, idsPrecierre } from './pre-cierre-ids.util';

/**
 * PRE-CIERRE · `ids` por renglón (15-oct-2026, API 0.0.81, invariante 81).
 * Helper PURO: orden de la lista, dedupe, ids no-string fuera, tope 500 con
 * `ids_truncado` SOLO al cortar.
 */
describe('idsPrecierre', () => {
  it('el tope es 500', () => {
    expect(MAX_IDS_PRECIERRE).toBe(500);
  });

  it('conserva el orden de la lista y quita repetidos (gana el primer lugar)', () => {
    expect(
      idsPrecierre([{ id: 'c' }, { id: 'a' }, { id: 'c' }, { id: 'b' }]),
    ).toEqual({ ids: ['c', 'a', 'b'] });
  });

  it('salta lo que no es string no vacío (jamás inventa)', () => {
    expect(
      idsPrecierre([
        { id: 'a' },
        { id: 7 },
        { id: null },
        {},
        { id: '' },
        { id: '   ' },
        { id: { x: 1 } },
        { id: 'b' },
      ]),
    ).toEqual({ ids: ['a', 'b'] });
  });

  it('lista vacía ⇒ `ids: []` sin llave extra', () => {
    const r = idsPrecierre([]);
    expect(r).toEqual({ ids: [] });
    expect(Object.keys(r)).toEqual(['ids']);
  });

  it('exactamente 500 ⇒ todos, sin `ids_truncado`', () => {
    const filas = Array.from({ length: 500 }, (_, i) => ({ id: `g${i}` }));
    const r = idsPrecierre(filas);
    expect(r.ids).toHaveLength(500);
    expect(r).not.toHaveProperty('ids_truncado');
  });

  it('501 ⇒ los primeros 500 + `ids_truncado: true`', () => {
    const filas = Array.from({ length: 501 }, (_, i) => ({ id: `g${i}` }));
    const r = idsPrecierre(filas);
    expect(r.ids).toHaveLength(500);
    expect(r.ids[0]).toBe('g0');
    expect(r.ids[499]).toBe('g499');
    expect(r.ids_truncado).toBe(true);
    expect(Object.keys(r)).toEqual(['ids', 'ids_truncado']);
  });

  it('el tope cuenta ids ÚNICOS: 501 filas con un repetido no cortan', () => {
    const filas = [
      ...Array.from({ length: 500 }, (_, i) => ({ id: `g${i}` })),
      { id: 'g0' },
    ];
    const r = idsPrecierre(filas);
    expect(r.ids).toHaveLength(500);
    expect(r).not.toHaveProperty('ids_truncado');
  });
});
