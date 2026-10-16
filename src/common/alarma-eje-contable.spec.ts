import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ALARMA DE PARIDAD del EJE CONTABLE (16-oct-2026, API 0.0.88, invariante
 * 89). Los cuatro lectores de DINERO filtran los vuelos por
 * `colPeriodoContable(contable)` (= `fecha_contable` con la migración). Todo
 * filtro de periodo que siga sobre `fecha_vuelo` en ellos debe ser de HORAS u
 * OPERATIVO y estar comentado «eje REAL a propósito (invariante 89)» en una
 * de las 3 líneas anteriores. Agregar un `.gte('fecha_vuelo', …)` de dinero
 * sin pensar en el cierre de mes hace saltar esta alarma.
 */
const ARCHIVOS = [
  ['modules', 'profit-sharing', 'profit-sharing.service.ts'],
  ['modules', 'profit-sharing', 'dinero-report.service.ts'],
  ['modules', 'aircraft', 'aircraft-balance.service.ts'],
  ['modules', 'dashboards', 'dashboards.service.ts'],
] as const;

describe('ALARMA DE PARIDAD — eje contable de los lectores de dinero', () => {
  it.each(ARCHIVOS.map((a) => [a.join('/'), a]))(
    '%s: cada filtro por fecha_vuelo está marcado como «eje REAL a propósito»',
    (_n, partes) => {
      const lineas = readFileSync(
        join(__dirname, '..', ...partes),
        'utf8',
      ).split('\n');
      const sinMarca: string[] = [];
      lineas.forEach((l, i) => {
        if (!/\.(gte|gt|lte|lt)\('(vuelo\.)?fecha_vuelo'/.test(l)) return;
        const previas = lineas.slice(Math.max(0, i - 3), i).join('\n');
        if (!previas.includes('eje REAL a propósito (invariante 89)')) {
          sinMarca.push(`${i + 1}: ${l.trim()}`);
        }
      });
      expect(sinMarca).toEqual([]);
    },
  );

  it('los lectores de dinero usan la columna del periodo contable', () => {
    for (const partes of ARCHIVOS.slice(0, 3)) {
      const fuente = readFileSync(join(__dirname, '..', ...partes), 'utf8');
      expect(fuente).toContain('colPeriodoContable(');
      expect(fuente).toContain('cierreMesDisponible(');
    }
  });
});
