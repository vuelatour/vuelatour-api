import type { SupabaseClient } from '@supabase/supabase-js';
import {
  filaLibroDeIngreso,
  leerIngresosDeResultado,
  type IngresoParaLibro,
} from './ingreso-resultado.util';

/**
 * Fila de libro de un ingreso sin vuelo: la MISMA para el Libro Dinero y el
 * Balance general (contrato §7.5).
 */
const base: IngresoParaLibro = {
  id: 'i-1',
  folio: 12,
  categoria: 'OTRO_INGRESO',
  fecha: '2026-09-10',
  descripcion: 'Renta de hangar a tercero',
  monto: 5000,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  cliente_nombre: null,
  pagador: 'Aeroclub Cancún',
  vuelo_folio: null,
  matricula: null,
  aeronave_color: null,
};

describe('filaLibroDeIngreso', () => {
  it('MXN: el monto tal cual, sin egreso; remanente = ingreso', () => {
    expect(filaLibroDeIngreso(base)).toEqual({
      clave: 'ING-12',
      fecha: '2026-09-10',
      concepto_ingreso:
        'Otros ingresos · Renta de hangar a tercero · Aeroclub Cancún',
      ingreso_mxn: 5000,
      concepto_egreso: null,
      egreso_mxn: null,
      remanente_mxn: 5000,
      aeronave_color: null,
    });
  });

  it('USD con TC: convierte con SU tc (sin promedio) y redondea a centavos', () => {
    const f = filaLibroDeIngreso({
      ...base,
      categoria: 'INGRESO_BANCARIO',
      descripcion: 'Intereses cuenta USD',
      moneda: 'USD',
      monto: 100.5,
      tc_usd_mxn: 18.123456,
      pagador: null,
    });
    expect(f?.ingreso_mxn).toBe(1821.41);
    expect(f?.remanente_mxn).toBe(1821.41);
    expect(f?.concepto_ingreso).toBe(
      'Ingresos en cuentas de banco · Intereses cuenta USD',
    );
  });

  it('USD SIN TC: ingreso null y la nota (nunca crudo como pesos)', () => {
    const f = filaLibroDeIngreso({
      ...base,
      moneda: 'USD',
      monto: 250,
      tc_usd_mxn: null,
    });
    expect(f?.ingreso_mxn).toBeNull();
    expect(f?.remanente_mxn).toBeNull();
    expect(f?.concepto_ingreso).toMatch(/\(USD sin TC — no suma\)$/);
  });

  it('comisión bancaria = egreso con la MISMA conversión; remanente = ingreso − comisión', () => {
    const mxn = filaLibroDeIngreso({ ...base, comision_monto: 50 });
    expect(mxn).toMatchObject({
      ingreso_mxn: 5000,
      concepto_egreso: 'comisión bancaria',
      egreso_mxn: 50,
      remanente_mxn: 4950,
    });
    const usd = filaLibroDeIngreso({
      ...base,
      moneda: 'USD',
      monto: 1000,
      comision_monto: 88.6,
      tc_usd_mxn: 18.5,
    });
    expect(usd).toMatchObject({
      ingreso_mxn: 18500,
      egreso_mxn: 1639.1,
      remanente_mxn: 16860.9,
    });
  });

  it('reembolso con vuelo, cliente y matrícula en el concepto', () => {
    const f = filaLibroDeIngreso({
      ...base,
      categoria: 'REEMBOLSO_DEVOLUCION',
      descripcion: 'Reembolso aseguradora',
      cliente_nombre: 'GNP',
      pagador: 'ignorado porque hay cliente',
      vuelo_folio: 312,
      matricula: 'XA-VGV',
      aeronave_color: '#3B82F6',
    });
    expect(f?.concepto_ingreso).toBe(
      'Reembolsos y devoluciones recibidos · Reembolso aseguradora · GNP · vuelo #312 · XA-VGV',
    );
    expect(f?.aeronave_color).toBe('#3B82F6');
  });

  it('ANTICIPO y APORTACION ⇒ null (no son resultado)', () => {
    expect(
      filaLibroDeIngreso({ ...base, categoria: 'ANTICIPO_CLIENTE' }),
    ).toBeNull();
    expect(
      filaLibroDeIngreso({ ...base, categoria: 'APORTACION_PRESTAMO' }),
    ).toBeNull();
  });
});

describe('leerIngresosDeResultado', () => {
  it('SIN la migración devuelve [] y no toca la tabla ingreso', async () => {
    const tablas: string[] = [];
    const sb = {
      from: (t: string) => {
        tablas.push(t);
        return {
          select: () => ({
            limit: () =>
              Promise.resolve({
                data: null,
                error: { code: '42703', message: 'no existe' },
              }),
          }),
        };
      },
    } as unknown as SupabaseClient;
    await expect(
      leerIngresosDeResultado(sb, '2026-09-01', '2026-09-30'),
    ).resolves.toEqual([]);
    expect(tablas).toEqual(['movimiento_bancario']);
  });

  it('pagina de 1000 en 1000 hasta una página corta', async () => {
    const rangos: Array<[number, number]> = [];
    const filasPagina = (n: number, desde: number) =>
      Array.from({ length: n }, (_, k) => ({
        id: `i-${desde + k}`,
        folio: desde + k,
        categoria: 'OTRO_INGRESO',
        fecha: '2026-09-10',
        descripcion: 'x x x',
        monto: 1,
        comision_monto: null,
        moneda: 'MXN',
        tc_usd_mxn: null,
        pagador: null,
        cliente: null,
        vuelo: null,
        aeronave: null,
      }));
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      is: () => q,
      in: () => q,
      gte: () => q,
      lte: () => q,
      order: () => q,
      limit: () => Promise.resolve({ data: [], error: null }),
      range: (a: number, b: number) => {
        rangos.push([a, b]);
        return Promise.resolve({
          data: filasPagina(a === 0 ? 1000 : 3, a),
          error: null,
        });
      },
    });
    const sb = { from: () => q } as unknown as SupabaseClient;
    const r = await leerIngresosDeResultado(sb, '2026-09-01', '2026-09-30');
    expect(r).toHaveLength(1003);
    expect(rangos).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});
