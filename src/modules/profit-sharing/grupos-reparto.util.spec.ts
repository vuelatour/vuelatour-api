import { readFileSync } from 'fs';
import { join } from 'path';
import { CategoriaGasto } from '../expenses/dto/expenses.dto';
import {
  COMBUSTIBLE,
  DIRECTO,
  FIJO,
  INDIRECTO,
  OTROS_MOVIMIENTOS_CAT,
  PERMISO,
  TUAS_CAT,
} from './grupos-reparto.util';

/**
 * Grupos del clasificador del reparto a socios (14-oct-2026, invariante
 * 74): se MUDARON tal cual de `profit-sharing.service.ts`. La membresía se
 * CONGELA: mover una categoría de grupo cambia la utilidad de los socios y
 * tiene que fallar aquí antes que en un reparto. Los specs del reparto
 * siguen verdes SIN tocarse (la mudanza no cambia ninguna conducta).
 */
describe('grupos-reparto.util — membresía congelada', () => {
  it('COMBUSTIBLE = {GAS} (23-oct-2026, invariante 104): el combustible es su propia línea, FUERA de DIRECTO', () => {
    expect([...COMBUSTIBLE]).toEqual(['GAS']);
    expect(DIRECTO.has('GAS')).toBe(false);
  });

  it('DIRECTO: las 9 categorías directas del vuelo SIN combustible (sin TUAS ni OTRO; «Otros gastos directos del vuelo» desde el 20-oct-2026)', () => {
    expect([...DIRECTO].sort()).toEqual(
      [
        'OPERACIONES',
        'ATERRIZAJE',
        'FBO',
        'COMIDA',
        'HOTEL',
        'TAXI',
        'PILOTO_EXTERNO',
        'COMISARIATO',
        'OTROS_DIRECTOS_VUELO',
      ].sort(),
    );
  });

  it('INDIRECTO = {REFACCION, SERVICIOS, INDIRECTO (20-oct-2026, invariante 99)}; PERMISO = {PERMISO}; FIJO y TUAS_CAT', () => {
    // La CATEGORÍA INDIRECTO sellada a un avión cuenta como gasto indirecto
    // del avión, igual que en la hoja «Gastos Indirectos» del balance
    // (decisión del cliente del 20-oct-2026: «que cuadren»).
    expect([...INDIRECTO].sort()).toEqual([
      'INDIRECTO',
      'REFACCION',
      'SERVICIOS',
    ]);
    expect([...PERMISO]).toEqual(['PERMISO']);
    expect(FIJO).toBe('FIJO');
    expect(TUAS_CAT).toBe('TUAS');
    // 23-oct-2026 (invariante 107): EXCLUIDO como la TUA, con clave propia.
    expect(OTROS_MOVIMIENTOS_CAT).toBe('OTROS_MOVIMIENTOS');
  });

  it('ninguna categoría está en dos grupos y todas existen en el enum', () => {
    const todas = [
      ...COMBUSTIBLE,
      ...DIRECTO,
      ...INDIRECTO,
      ...PERMISO,
      FIJO,
      TUAS_CAT,
      OTROS_MOVIMIENTOS_CAT,
    ];
    expect(new Set(todas).size).toBe(todas.length);
    const enumValores = Object.values(CategoriaGasto) as string[];
    for (const c of todas) expect(enumValores).toContain(c);
  });

  it('NOMINA, OTRO, el pago al vendedor y «Otros movimientos (VuelaTour)» NO están en ningún grupo (caen a EXCLUIDO)', () => {
    for (const c of [
      'NOMINA',
      'OTRO',
      'GASOLINA',
      'VISITA',
      'PERSONAL_DUENO',
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
      // 23-oct-2026 (invariante 107): egreso de VuelaTour, EXCLUIDO como TUAS.
      'OTROS_MOVIMIENTOS',
      'PAQUETERIA',
    ]) {
      expect(
        COMBUSTIBLE.has(c) ||
          DIRECTO.has(c) ||
          INDIRECTO.has(c) ||
          PERMISO.has(c),
      ).toBe(false);
    }
  });
});

describe('profit-sharing.service.ts los IMPORTA (sin copias locales)', () => {
  const fuente = readFileSync(
    join(__dirname, 'profit-sharing.service.ts'),
    'utf8',
  );

  it('ya no declara los conjuntos: los lee de grupos-reparto.util', () => {
    expect(fuente).not.toContain('const DIRECTO = new Set(');
    expect(fuente).not.toContain('const INDIRECTO = new Set(');
    expect(fuente).not.toContain('const PERMISO = new Set(');
    expect(fuente).not.toContain("const FIJO = 'FIJO'");
    expect(fuente).not.toContain('const TUAS_CAT =');
    expect(fuente).toContain("from './grupos-reparto.util'");
  });

  it('el ternario de computeAvion y el pool de FIJO siguen usándolos', () => {
    const sinEspacios = fuente.replace(/\s+/g, '');
    for (const patron of [
      'const esTuas = g.categoria === TUAS_CAT;',
      'const esOtrosMovimientos = g.categoria === OTROS_MOVIMIENTOS_CAT;',
      'esTuas || esPagoVendedor || pagoAfac || esOtrosMovimientos',
      ': COMBUSTIBLE.has(g.categoria)',
      ': DIRECTO.has(g.categoria)',
      ': INDIRECTO.has(g.categoria)',
      ': PERMISO.has(g.categoria)',
      'if (g.categoria !== FIJO || g.es_reparto_parcial) continue;',
    ]) {
      expect(sinEspacios).toContain(patron.replace(/\s+/g, ''));
    }
  });
});
