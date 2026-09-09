import {
  buscarClientePorNombre,
  nombreClienteParaCrear,
  normalizarNombreCliente,
} from './nombre-cliente.util';

/**
 * Cliente por nombre (alta sin internet, 9-sep-2026): la comparación es por
 * nombre NORMALIZADO (trim, espacios colapsados, sin acentos, minúsculas)
 * contra TODOS los clientes; se prefiere el activo y se devuelve el inactivo
 * para reactivarlo en vez de crear un duplicado.
 */
describe('normalizarNombreCliente', () => {
  it('trim + colapsa espacios + sin acentos + minúsculas', () => {
    expect(normalizarNombreCliente('  Juan   PÉREZ ')).toBe('juan perez');
    expect(normalizarNombreCliente('José Ángel Núñez')).toBe(
      'jose angel nunez',
    );
    expect(normalizarNombreCliente('Juan\tPerez\n')).toBe('juan perez');
  });

  it('nombres equivalentes normalizan igual', () => {
    const a = normalizarNombreCliente('Juan Pérez');
    expect(normalizarNombreCliente('juan perez')).toBe(a);
    expect(normalizarNombreCliente('JUAN  PÉREZ')).toBe(a);
  });

  it('vacío o solo espacios → cadena vacía', () => {
    expect(normalizarNombreCliente('   ')).toBe('');
  });
});

describe('buscarClientePorNombre', () => {
  const lista = [
    { id: 'c-inactivo', nombre: 'Juan Pérez', activo: false },
    { id: 'c-otro', nombre: 'Juana Pérez', activo: true },
    { id: 'c-activo', nombre: 'juan  perez', activo: true },
  ];

  it('prefiere el cliente ACTIVO cuando hay homónimos', () => {
    expect(buscarClientePorNombre(lista, 'JUAN PEREZ')?.id).toBe('c-activo');
  });

  it('si solo hay INACTIVO lo devuelve (el caller lo reactiva)', () => {
    const solo = [lista[0], lista[1]];
    expect(buscarClientePorNombre(solo, 'juan pérez')?.id).toBe('c-inactivo');
  });

  it('sin coincidencia exacta normalizada → null (Juana ≠ Juan)', () => {
    expect(buscarClientePorNombre([lista[1]], 'Juan Pérez')).toBeNull();
  });

  it('nombre vacío → null (nunca "coincide" con todos)', () => {
    expect(buscarClientePorNombre(lista, '   ')).toBeNull();
  });
});

describe('nombreClienteParaCrear', () => {
  it('conserva mayúsculas y acentos; solo limpia espacios', () => {
    expect(nombreClienteParaCrear('  Juan   Pérez ')).toBe('Juan Pérez');
  });
});
