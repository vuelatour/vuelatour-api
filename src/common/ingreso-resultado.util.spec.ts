import type { SupabaseClient } from '@supabase/supabase-js';
import {
  filaLibroDeIngreso,
  ingresoEsDelAvion,
  ingresoParaLibroDeFila,
  leerIngresosDeResultado,
  netoIngresoUsd,
  partirIngresosPorAvion,
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

/**
 * INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67): los
 * campos aditivos del lector, la partición ÚNICA (su avión XOR VuelaTour) y
 * el neto en USD del reparto.
 */
describe('ingreso asignado a un avión (invariante 67)', () => {
  const crudo = (extra: Record<string, unknown> = {}) => ({
    id: 'i-4',
    folio: 4,
    categoria: 'REEMBOLSO_DEVOLUCION',
    fecha: '2026-09-04',
    descripcion: 'TRANSF INTERBANCARIA SPEI',
    monto: '46550.80',
    comision_monto: null,
    moneda: 'MXN',
    tc_usd_mxn: null,
    pagador: 'angel alvarez',
    cliente: null,
    vuelo: null,
    aeronave: { matricula: 'N990GG', color_calendario: '#F59E0B' },
    aeronave_id: 'av-n990gg',
    notas: '  reembolso del pago del serv de 50 hrs en toledo, fact 53  ',
    cuenta: { alias: 'EJE SCOTIA', banco: 'Scotiabank' },
    ...extra,
  });

  it('ingresoParaLibroDeFila mapea aeronave_id, notas (recortadas) y la cuenta (embed objeto o arreglo)', () => {
    const i = ingresoParaLibroDeFila(crudo());
    expect(i).toMatchObject({
      aeronave_id: 'av-n990gg',
      notas: 'reembolso del pago del serv de 50 hrs en toledo, fact 53',
      cuenta_alias: 'EJE SCOTIA',
      cuenta_banco: 'Scotiabank',
      matricula: 'N990GG',
      monto: 46550.8,
    });
    const arreglo = ingresoParaLibroDeFila(
      crudo({ cuenta: [{ alias: 'BBVA MXN', banco: 'BBVA' }] }),
    );
    expect([arreglo.cuenta_alias, arreglo.cuenta_banco]).toEqual([
      'BBVA MXN',
      'BBVA',
    ]);
  });

  it('campos ausentes ⇒ null (notas vacías, sin cuenta, sin avión)', () => {
    const i = ingresoParaLibroDeFila(
      crudo({
        aeronave_id: undefined,
        notas: '   ',
        cuenta: null,
        aeronave: null,
      }),
    );
    expect([i.aeronave_id, i.notas, i.cuenta_alias, i.cuenta_banco]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const sinLlaves = ingresoParaLibroDeFila({
      id: 'x',
      folio: 1,
      categoria: 'OTRO_INGRESO',
      fecha: '2026-09-01',
      descripcion: 'abc',
      monto: 1,
      moneda: 'MXN',
    });
    expect([
      sinLlaves.aeronave_id,
      sinLlaves.notas,
      sinLlaves.cuenta_alias,
      sinLlaves.cuenta_banco,
    ]).toEqual([null, null, null, null]);
  });

  it('filaLibroDeIngreso sale BYTE-IDÉNTICA con los campos nuevos presentes', () => {
    const conCampos: IngresoParaLibro = {
      ...base,
      aeronave_id: 'av-1',
      notas: 'nota',
      cuenta_alias: 'EJE SCOTIA',
      cuenta_banco: 'Scotiabank',
    };
    expect(JSON.stringify(filaLibroDeIngreso(conCampos))).toBe(
      JSON.stringify(filaLibroDeIngreso(base)),
    );
  });

  const ing = (
    id: string,
    folio: number,
    aeronave_id: string | null,
    categoria = 'OTRO_INGRESO',
  ): IngresoParaLibro => ({ ...base, id, folio, aeronave_id, categoria });

  it('partirIngresosPorAvion: cada ingreso de resultado en EXACTAMENTE un lado, en el orden del lector', () => {
    const lista = [
      ing('e1', 1, null),
      ing('a1', 2, 'av-A', 'REEMBOLSO_DEVOLUCION'),
      ing('b1', 3, 'av-B', 'VENTA_ACTIVO'),
      ing('e2', 4, null, 'INGRESO_BANCARIO'),
      ing('a2', 5, 'av-A', 'INGRESO_BANCARIO'),
      // Anticipo con avión FORZADO (imposible tras el CHECK): ningún lado.
      ing('x1', 6, 'av-A', 'ANTICIPO_CLIENTE'),
      ing('x2', 7, null, 'APORTACION_PRESTAMO'),
    ];
    const p = partirIngresosPorAvion(lista);
    expect(p.empresa.map((i) => i.id)).toEqual(['e1', 'e2']);
    expect(p.porAvion.get('av-A')?.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(p.porAvion.get('av-B')?.map((i) => i.id)).toEqual(['b1']);
    expect([...p.porAvion.keys()].sort()).toEqual(['av-A', 'av-B']);
    const lados = [...p.empresa, ...[...p.porAvion.values()].flat()].map(
      (i) => i.id,
    );
    expect(lados.sort()).toEqual(['a1', 'a2', 'b1', 'e1', 'e2']);
    expect(partirIngresosPorAvion([])).toEqual({
      empresa: [],
      porAvion: new Map(),
    });
  });

  it('ingresoEsDelAvion: de resultado Y con avión', () => {
    expect(ingresoEsDelAvion(ing('a', 1, 'av-A'))).toBe(true);
    expect(ingresoEsDelAvion(ing('b', 2, null))).toBe(false);
    expect(ingresoEsDelAvion(ing('c', 3, 'av-A', 'ANTICIPO_CLIENTE'))).toBe(
      false,
    );
    expect(ingresoEsDelAvion({ categoria: 'OTRO_INGRESO' })).toBe(false);
  });

  it('netoIngresoUsd: USD neto; MXN ÷ T.C.; sin T.C. (o 0) ⇒ null', () => {
    expect(
      netoIngresoUsd({ monto: 100, comision_monto: 5, moneda: 'USD' }, null),
    ).toBe(95);
    expect(
      netoIngresoUsd(
        { monto: 46550.8, comision_monto: null, moneda: 'MXN' },
        18,
      ),
    ).toBe(2586.16);
    expect(
      netoIngresoUsd({ monto: 1000, comision_monto: 50, moneda: 'MXN' }, 20),
    ).toBe(47.5);
    expect(
      netoIngresoUsd(
        { monto: 46550.8, comision_monto: null, moneda: 'MXN' },
        null,
      ),
    ).toBeNull();
    expect(
      netoIngresoUsd(
        { monto: 46550.8, comision_monto: null, moneda: 'MXN' },
        0,
      ),
    ).toBeNull();
  });
});
