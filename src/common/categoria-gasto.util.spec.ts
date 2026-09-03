import { CategoriaGasto } from '../modules/expenses/dto/expenses.dto';
import {
  CATEGORIA_GASTO_DESTINO,
  CATEGORIA_GASTO_LABEL,
  descripcionCategoriasGasto,
  destinoCategoriaGasto,
  etiquetaCategoriaGasto,
} from './categoria-gasto.util';

describe('categoria-gasto.util (etiquetas y destino por default, 2-sep-2026)', () => {
  const codigos = Object.values(CategoriaGasto);

  it('el enum tiene las 19 categorías conocidas', () => {
    expect(codigos).toHaveLength(19);
  });

  it('toda categoría del enum tiene etiqueta y destino no vacíos (y nada extra)', () => {
    for (const c of codigos) {
      expect(CATEGORIA_GASTO_LABEL[c]).toEqual(expect.any(String));
      expect(CATEGORIA_GASTO_LABEL[c].trim().length).toBeGreaterThan(0);
      expect(CATEGORIA_GASTO_DESTINO[c]).toEqual(expect.any(String));
      expect(CATEGORIA_GASTO_DESTINO[c].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(CATEGORIA_GASTO_LABEL).sort()).toEqual(
      [...codigos].sort(),
    );
    expect(Object.keys(CATEGORIA_GASTO_DESTINO).sort()).toEqual(
      [...codigos].sort(),
    );
  });

  it('tabla canónica: las dos categorías renombradas por el cliente', () => {
    expect(etiquetaCategoriaGasto('GAS')).toBe('Gasavión / Turbosina');
    expect(etiquetaCategoriaGasto('OTRO')).toBe('Otros gastos VuelaTour');
  });

  it('tabla canónica: el resto de las etiquetas (sentence case, homologadas)', () => {
    expect(etiquetaCategoriaGasto(CategoriaGasto.ATERRIZAJE)).toBe(
      'Aterrizaje',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.OPERACIONES)).toBe(
      'Operaciones',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.TUAS)).toBe('TUAS');
    expect(etiquetaCategoriaGasto(CategoriaGasto.FBO)).toBe('FBO');
    expect(etiquetaCategoriaGasto(CategoriaGasto.COMIDA)).toBe('Comida');
    expect(etiquetaCategoriaGasto(CategoriaGasto.HOTEL)).toBe('Hotel');
    expect(etiquetaCategoriaGasto(CategoriaGasto.TAXI)).toBe(
      'Taxi / estacionamiento',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.REFACCION)).toBe('Refacción');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PERMISO)).toBe('Permiso');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PILOTO_EXTERNO)).toBe(
      'Piloto externo (honorario)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.FIJO)).toBe('Gasto fijo');
    expect(etiquetaCategoriaGasto(CategoriaGasto.INDIRECTO)).toBe(
      'Gastos indirectos de avión',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.NOMINA)).toBe('Nómina');
    expect(etiquetaCategoriaGasto(CategoriaGasto.SERVICIOS)).toBe(
      'Servicios (avión)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.GASOLINA)).toBe(
      'Gasolina (vehículos)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.VISITA)).toBe('Visita');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PERSONAL_DUENO)).toBe(
      'Gasto personal del dueño',
    );
  });

  it('tabla canónica: destino por default por familia', () => {
    const directos = [
      CategoriaGasto.OPERACIONES,
      CategoriaGasto.ATERRIZAJE,
      CategoriaGasto.TUAS,
      CategoriaGasto.FBO,
      CategoriaGasto.COMIDA,
      CategoriaGasto.HOTEL,
      CategoriaGasto.TAXI,
      CategoriaGasto.PILOTO_EXTERNO,
    ];
    for (const c of directos) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Gastos directos del vuelo (en el balance del avión)',
      );
    }
    expect(destinoCategoriaGasto(CategoriaGasto.GAS)).toBe(
      'Combustible (en el balance del avión)',
    );
    expect(destinoCategoriaGasto(CategoriaGasto.REFACCION)).toBe(
      'Inventario en el Balance general VuelaTour; al salir del inventario se vende al avión y cae en sus Gastos Indirectos',
    );
    expect(destinoCategoriaGasto(CategoriaGasto.PERMISO)).toBe(
      'Hoja de permisos (en el balance del avión)',
    );
    for (const c of [CategoriaGasto.INDIRECTO, CategoriaGasto.SERVICIOS]) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Gastos indirectos del avión (en el balance del avión)',
      );
    }
    for (const c of [
      CategoriaGasto.NOMINA,
      CategoriaGasto.GASOLINA,
      CategoriaGasto.OTRO,
      CategoriaGasto.FIJO,
      CategoriaGasto.VISITA,
    ]) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Otros gastos (Balance general VuelaTour)',
      );
    }
    expect(destinoCategoriaGasto(CategoriaGasto.PERSONAL_DUENO)).toBe(
      'Gastos personales de los dueños (fuera de la empresa)',
    );
  });

  it('fallback: código desconocido → capitalizado; vacío/null → cadena vacía', () => {
    expect(etiquetaCategoriaGasto('FOO_BAR')).toBe('Foo bar');
    expect(etiquetaCategoriaGasto('reanalisis')).toBe('Reanalisis');
    expect(etiquetaCategoriaGasto('')).toBe('');
    expect(etiquetaCategoriaGasto(null)).toBe('');
    expect(etiquetaCategoriaGasto(undefined)).toBe('');
    expect(destinoCategoriaGasto('FOO_BAR')).toBeNull();
    expect(destinoCategoriaGasto(null)).toBeNull();
  });

  it('descripción Swagger: una línea código → etiqueta → destino por cada categoría', () => {
    const texto = descripcionCategoriasGasto();
    for (const c of codigos) {
      expect(texto).toContain(
        `${c} → ${CATEGORIA_GASTO_LABEL[c]} → ${CATEGORIA_GASTO_DESTINO[c]}`,
      );
    }
    expect(texto.split('\n')).toHaveLength(codigos.length + 1);
  });
});
