import {
  mismoArchivoCompleto,
  ordenarComoEstadoDeCuenta,
} from './orden-estado-cuenta.util';

const linea = (
  id: string,
  fecha: string,
  extra: Partial<{
    created_at: string;
    estado_cuenta_id: string | null;
    orden_archivo: number | null;
  }> = {},
) => ({ id, fecha, created_at: '2026-10-01T00:00:00Z', ...extra });

describe('ordenarComoEstadoDeCuenta (invariante 55)', () => {
  it('un solo archivo con posiciones: el orden del archivo tal cual, aunque vaya del más nuevo al más viejo', () => {
    const lineas = [
      linea('a', '2026-09-03', { estado_cuenta_id: 'f1', orden_archivo: 2 }),
      linea('b', '2026-09-30', { estado_cuenta_id: 'f1', orden_archivo: 1 }),
      linea('c', '2026-09-01', { estado_cuenta_id: 'f1', orden_archivo: 3 }),
    ];
    expect(mismoArchivoCompleto(lineas)).toBe(true);
    expect(ordenarComoEstadoDeCuenta(lineas).map((l) => l.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('sin posiciones (importado antes del 0.0.69): cronológico y luego por captura, como siempre', () => {
    const lineas = [
      linea('tarde', '2026-09-05', { created_at: '2026-10-01T10:00:00Z' }),
      linea('temprano', '2026-09-05', { created_at: '2026-10-01T09:00:00Z' }),
      linea('antes', '2026-09-01'),
    ];
    expect(mismoArchivoCompleto(lineas)).toBe(false);
    expect(ordenarComoEstadoDeCuenta(lineas).map((l) => l.id)).toEqual([
      'antes',
      'temprano',
      'tarde',
    ]);
  });

  it('mezcla de archivos y líneas a mano: por fecha; en el mismo día primero las del archivo en su orden, luego las demás', () => {
    const lineas = [
      linea('mano', '2026-09-05', { created_at: '2026-09-05T08:00:00Z' }),
      linea('f2-1', '2026-09-05', { estado_cuenta_id: 'f2', orden_archivo: 1 }),
      linea('f1-9', '2026-09-05', { estado_cuenta_id: 'f1', orden_archivo: 9 }),
      linea('f1-2', '2026-09-05', { estado_cuenta_id: 'f1', orden_archivo: 2 }),
      linea('ayer', '2026-09-04', { estado_cuenta_id: 'f2', orden_archivo: 7 }),
    ];
    expect(mismoArchivoCompleto(lineas)).toBe(false);
    expect(ordenarComoEstadoDeCuenta(lineas).map((l) => l.id)).toEqual([
      'ayer',
      'f1-2',
      'f1-9',
      'f2-1',
      'mano',
    ]);
  });

  it('un archivo con una línea sin posición no cuenta como completo; una posición no numérica se ignora', () => {
    const lineas = [
      linea('a', '2026-09-02', { estado_cuenta_id: 'f1', orden_archivo: 1 }),
      linea('b', '2026-09-01', { estado_cuenta_id: 'f1', orden_archivo: null }),
    ];
    expect(mismoArchivoCompleto(lineas)).toBe(false);
    expect(ordenarComoEstadoDeCuenta(lineas).map((l) => l.id)).toEqual([
      'b',
      'a',
    ]);
    expect(mismoArchivoCompleto([])).toBe(false);
    expect(
      mismoArchivoCompleto([
        {
          ...linea('x', '2026-09-01'),
          estado_cuenta_id: 'f',
          orden_archivo: '1',
        },
      ]),
    ).toBe(false);
  });

  it('no muta la lista de entrada', () => {
    const lineas = [linea('b', '2026-09-02'), linea('a', '2026-09-01')];
    ordenarComoEstadoDeCuenta(lineas);
    expect(lineas.map((l) => l.id)).toEqual(['b', 'a']);
  });
});
