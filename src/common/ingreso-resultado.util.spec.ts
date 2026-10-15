import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COLS_INGRESO_LIBRO,
  LUGAR_TC_PONDERADO,
  avisosReembolsoGasto,
  diaTcOficialIngreso,
  excedenteSobreCargado,
  filaLibroDeIngreso,
  gastosLigadosDelLibro,
  ingresoEsDelAvion,
  ingresoParaLibroDeFila,
  leerIngresosDeResultado,
  netoIngresoUsd,
  partirIngresosPorAvion,
  usdDeIngresoAvion,
  type IngresoParaLibro,
  type TcGastoLigado,
  type TcOficialDia,
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

/**
 * CONVERSIÓN ÚNICA DEL INGRESO DE UN AVIÓN (decisión del cliente del
 * 14-oct-2026, API 0.0.77): `usdDeIngresoAvion` es la MISMA en balance,
 * reparto y tablero; ING-4 (N990GG, $46,550.80 del 4-sep, sin T.C. propio)
 * con el oficial de su día 16.9479 = 2,746.70 USD.
 */
describe('conversión única del ingreso de un avión (14-oct-2026, API 0.0.77)', () => {
  const ING4: IngresoParaLibro = {
    ...base,
    id: 'i-4',
    folio: 4,
    categoria: 'REEMBOLSO_DEVOLUCION',
    fecha: '2026-09-04',
    descripcion: 'TRANSF INTERBANCARIA SPEI',
    monto: 46550.8,
    aeronave_id: 'av-n990gg',
  };
  const OFICIAL_0904: TcOficialDia = {
    tc: 16.9479,
    fecha_dato: '2026-09-04',
    fuente: 'OPEN_ER_API',
  };

  it('el lector pide y mapea `gasto_id` (ADITIVO, al final del select)', () => {
    expect(COLS_INGRESO_LIBRO.endsWith(', gasto_id')).toBe(true);
    const fila = {
      id: 'i-9',
      folio: 9,
      categoria: 'REEMBOLSO_DEVOLUCION',
      fecha: '2026-09-04',
      descripcion: 'x',
      monto: 1,
      moneda: 'MXN',
    };
    expect(
      ingresoParaLibroDeFila({ ...fila, gasto_id: '70e8c3a4-0000' }).gasto_id,
    ).toBe('70e8c3a4-0000');
    expect(ingresoParaLibroDeFila({ ...fila, gasto_id: null }).gasto_id).toBe(
      null,
    );
    expect(ingresoParaLibroDeFila(fila).gasto_id).toBe(null);
  });

  it('diaTcOficialIngreso: MXN sin T.C. ⇒ su fecha; con T.C. propio, USD o fecha inválida ⇒ null', () => {
    expect(diaTcOficialIngreso(ING4)).toBe('2026-09-04');
    expect(diaTcOficialIngreso({ ...ING4, tc_usd_mxn: 17.5 })).toBeNull();
    expect(
      diaTcOficialIngreso({ ...ING4, moneda: 'USD', tc_usd_mxn: null }),
    ).toBeNull();
    for (const fecha of [
      '2026-02-30',
      '04/09/2026',
      '2026-09-04T00:00:00Z',
      '',
    ]) {
      expect([fecha, diaTcOficialIngreso({ ...ING4, fecha })]).toEqual([
        fecha,
        null,
      ]);
    }
  });

  it('ING-4: oficial del día 16.9479 ⇒ 2,746.70 (OFICIAL_DEL_DIA); T.C. propio 17.5 ⇒ 2,660.05 (PROPIO); sin oficial ⇒ null', () => {
    expect(usdDeIngresoAvion(ING4, { oficialDelDia: OFICIAL_0904 })).toEqual({
      usd: 2746.7,
      tc: 16.9479,
      origen: 'OFICIAL_DEL_DIA',
      oficial: OFICIAL_0904,
      gasto: null,
    });
    expect(
      usdDeIngresoAvion(
        { ...ING4, tc_usd_mxn: 17.5 },
        { oficialDelDia: OFICIAL_0904 },
      ),
    ).toEqual({
      usd: 2660.05,
      tc: 17.5,
      origen: 'PROPIO',
      oficial: null,
      gasto: null,
    });
    expect(usdDeIngresoAvion(ING4, {})).toEqual({
      usd: null,
      tc: null,
      origen: null,
      oficial: null,
      gasto: null,
    });
    // Oficial con T.C. 0: como si no hubiera.
    expect(
      usdDeIngresoAvion(ING4, { oficialDelDia: { ...OFICIAL_0904, tc: 0 } })
        .usd,
    ).toBeNull();
  });

  it('USD: su neto tal cual (1,000 − 30 ⇒ 970.00), sin T.C. aunque traiga uno propio', () => {
    expect(
      usdDeIngresoAvion(
        {
          ...ING4,
          moneda: 'USD',
          monto: 1000,
          comision_monto: 30,
          tc_usd_mxn: 18.0243,
        },
        { oficialDelDia: OFICIAL_0904 },
      ),
    ).toEqual({ usd: 970, tc: null, origen: null, oficial: null, gasto: null });
  });

  it('reembolso LIGADO: con el T.C. de SU gasto en este libro (GASTO_LIGADO); otro gasto_id u otra categoría ⇒ nunca', () => {
    const ligado: TcGastoLigado = {
      gasto_id: '70e8c3a4-aaaa',
      tc: 17.237699,
      fecha: '2026-09-15',
      lugar: 'T.C. promedio de las hojas',
      cargado_mxn: 45483.6,
    };
    const reembolso = {
      ...ING4,
      monto: 45483.6,
      gasto_id: '70e8c3a4-aaaa',
    };
    expect(
      usdDeIngresoAvion(reembolso, {
        oficialDelDia: OFICIAL_0904,
        gastoLigado: ligado,
      }),
    ).toEqual({
      usd: 2638.61,
      tc: 17.237699,
      origen: 'GASTO_LIGADO',
      oficial: null,
      gasto: ligado,
    });
    // El gasto ligado de OTRO gasto ⇒ el oficial del día.
    expect(
      usdDeIngresoAvion(reembolso, {
        oficialDelDia: OFICIAL_0904,
        gastoLigado: { ...ligado, gasto_id: 'otro' },
      }).origen,
    ).toBe('OFICIAL_DEL_DIA');
    // Otra categoría (con gasto_id forzado) ⇒ jamás GASTO_LIGADO.
    expect(
      usdDeIngresoAvion(
        { ...reembolso, categoria: 'OTRO_INGRESO' },
        { oficialDelDia: OFICIAL_0904, gastoLigado: ligado },
      ).origen,
    ).toBe('OFICIAL_DEL_DIA');
    // El T.C. PROPIO manda sobre el gasto ligado (captura explícita).
    expect(
      usdDeIngresoAvion(
        { ...reembolso, tc_usd_mxn: 17.5 },
        { gastoLigado: ligado },
      ).origen,
    ).toBe('PROPIO');
    // Divisor 0 ⇒ se ignora.
    expect(
      usdDeIngresoAvion(reembolso, { gastoLigado: { ...ligado, tc: 0 } })
        .origen,
    ).toBeNull();
    // Un gasto que el libro NO le carga al avión (revisión del 14-oct-2026)
    // jamás es «ligado»: el oficial de su día.
    expect(
      usdDeIngresoAvion(reembolso, {
        oficialDelDia: OFICIAL_0904,
        gastoLigado: { ...ligado, cargado_mxn: 0 },
      }).origen,
    ).toBe('OFICIAL_DEL_DIA');
  });
});

/**
 * REEMBOLSO LIGADO: lo que el libro le CARGA al avión del gasto (revisión
 * del 14-oct-2026, invariante 67). Casos reales de prod: 8ab208c4 (#192,
 * N4142R, OPERACIONES $4,549.06 del 06-sep, extensión de horario COMPLETA:
 * el avión no carga nada) y 8c60e428 (#383, N990GG, $1,925.27 = Operaciones
 * 1,365.64 + Tarifa TUA 559.63: el avión carga solo la operación).
 */
describe('gastos ligables de un libro y avisos del reembolso (revisión 14-oct-2026)', () => {
  const parte = (
    gasto_id: string,
    tc: number,
    mxn: number,
    lugar = 'T.C. promedio de las hojas',
  ) => ({ gasto_id, tc, mxn, fecha: '2026-09-06', lugar });

  it('gastosLigadosDelLibro: Σ de las partes que RESTAN por gasto; sin cargo (Σ ≤ 0) no entra; un divisor ⇒ ese; varios ⇒ el ponderado', () => {
    const m = gastosLigadosDelLibro([
      // #383: el vínculo 'suma' de la operación (la TUA es solo nota).
      parte('8c60e428', 17.6, 1365.64, 'T.C. de costos del vuelo #383'),
      // #192: extensión completa ⇒ el libro no lo carga (0, se ignora).
      parte('8ab208c4', 16.8925, 0),
      // Un reparto manual con dos partes al MISMO avión.
      parte('g-rep', 20, 100),
      parte('g-rep', 20, 50.01),
      // Mezcla imposible por construcción (fila + hoja con otro T.C.).
      parte('g-mix', 20, 1000),
      parte('g-mix', 10, 1000),
      // Negativo que deja la Σ en 0 ⇒ fuera; divisor inválido ⇒ fuera.
      parte('g-cero', 20, 100),
      parte('g-cero', 20, -100),
      parte('g-sin-tc', 0, 100),
      parte('', 20, 100),
    ]);
    expect([...m.keys()]).toEqual(['8c60e428', 'g-rep', 'g-mix']);
    expect(m.get('8c60e428')).toEqual({
      gasto_id: '8c60e428',
      tc: 17.6,
      fecha: '2026-09-06',
      lugar: 'T.C. de costos del vuelo #383',
      cargado_mxn: 1365.64,
    });
    expect(m.get('g-rep')).toMatchObject({ tc: 20, cargado_mxn: 150.01 });
    // 2,000 ÷ (1,000/20 + 1,000/10) = 13.3333…: 2,000 pesos ⇒ 150 USD, lo
    // mismo que las dos partes.
    const mix = m.get('g-mix')!;
    expect(mix.lugar).toBe(LUGAR_TC_PONDERADO);
    expect(mix.cargado_mxn).toBe(2000);
    expect(Math.round((2000 / mix.tc) * 100) / 100).toBe(150);
  });

  it('excedenteSobreCargado: ≥ 0 a centavos; medio centavo no cuenta', () => {
    expect(excedenteSobreCargado(1925.27, { cargado_mxn: 1365.64 })).toBe(
      559.63,
    );
    expect(excedenteSobreCargado(1365.645, { cargado_mxn: 1365.64 })).toBe(0);
    expect(excedenteSobreCargado(1000, { cargado_mxn: 1365.64 })).toBe(0);
  });

  const REEMBOLSO: IngresoParaLibro = {
    ...base,
    id: 'i-99',
    folio: 99,
    categoria: 'REEMBOLSO_DEVOLUCION',
    fecha: '2026-09-20',
    monto: 4549.06,
    aeronave_id: 'av-n4142r',
    gasto_id: '8ab208c4',
  };
  const OFICIAL_0920: TcOficialDia = {
    tc: 17.2123,
    fecha_dato: '2026-09-20',
    fuente: 'OPEN_ER_API',
  };

  it('#192 (extensión completa: el libro NO le carga el gasto) ⇒ el oficial de su día en los dos libros y el aviso LITERAL', () => {
    const conv = usdDeIngresoAvion(REEMBOLSO, {
      oficialDelDia: OFICIAL_0920,
      gastoLigado: null,
    });
    expect(conv).toMatchObject({ usd: 264.29, origen: 'OFICIAL_DEL_DIA' });
    expect(avisosReembolsoGasto(REEMBOLSO, 'ING-99', conv, null)).toEqual([
      'ING-99 reembolsa un gasto que este libro no le carga al avión (otro mes, otro avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo sin venta): se convirtió con el T.C. oficial de su día y no se anula con su gasto',
    ]);
    // Con T.C. propio, lo dice.
    const propio = { ...REEMBOLSO, tc_usd_mxn: 17.5 };
    expect(
      avisosReembolsoGasto(
        propio,
        'ING-99',
        usdDeIngresoAvion(propio, {}),
        undefined,
      )[0],
    ).toContain('se convirtió con su T.C. propio y no se anula con su gasto');
  });

  it('#383 (el libro carga 1,365.64 de 1,925.27): GASTO_LIGADO y aviso del EXCESO de 559.63; igual o menor ⇒ sin aviso', () => {
    const ligado: TcGastoLigado = {
      gasto_id: '8c60e428',
      tc: 17.6,
      fecha: '2026-09-25',
      lugar: 'T.C. de costos del vuelo #383',
      cargado_mxn: 1365.64,
    };
    const completo = { ...REEMBOLSO, monto: 1925.27, gasto_id: '8c60e428' };
    const conv = usdDeIngresoAvion(completo, { gastoLigado: ligado });
    expect(conv).toMatchObject({ usd: 109.39, origen: 'GASTO_LIGADO' });
    expect(avisosReembolsoGasto(completo, 'ING-99', conv, ligado)).toEqual([
      'ING-99 reembolsa $1,925.27 MXN de un gasto del que este libro solo le carga $1,365.64 MXN al avión: $559.63 MXN no se anulan con nada y suman al avión — si esa parte no es suya, corrige el monto o el avión del ingreso',
    ]);
    for (const monto of [1365.64, 1000]) {
      const r = { ...completo, monto };
      expect(
        avisosReembolsoGasto(
          r,
          'ING-99',
          usdDeIngresoAvion(r, { gastoLigado: ligado }),
          ligado,
        ),
      ).toEqual([]);
    }
    // La comisión bancaria se descuenta: 1,925.27 − 559.63 ⇒ sin exceso.
    const neto = { ...completo, comision_monto: 559.63 };
    expect(
      avisosReembolsoGasto(
        neto,
        'ING-99',
        usdDeIngresoAvion(neto, { gastoLigado: ligado }),
        ligado,
      ),
    ).toEqual([]);
  });

  it('T.C. PROPIO con el gasto en el libro: no se anula al centavo ⇒ aviso LITERAL (y el del exceso si aplica); el MISMO T.C. ⇒ nada', () => {
    const ligado: TcGastoLigado = {
      gasto_id: '70e8c3a4',
      tc: 17.237699,
      fecha: '2026-09-15',
      lugar: 'T.C. promedio de las hojas',
      cargado_mxn: 45483.6,
    };
    const propio = {
      ...REEMBOLSO,
      monto: 45483.6,
      gasto_id: '70e8c3a4',
      tc_usd_mxn: 17.5,
    };
    const conv = usdDeIngresoAvion(propio, { gastoLigado: ligado });
    expect(conv.origen).toBe('PROPIO');
    expect(avisosReembolsoGasto(propio, 'ING-99', conv, ligado)).toEqual([
      'ING-99 trae T.C. propio (17.5000) y este libro convierte el gasto que reembolsa con 17.2377 (T.C. promedio de las hojas): reembolso y gasto no se anulan exactos',
    ]);
    const exceso = { ...propio, monto: 46000 };
    expect(
      avisosReembolsoGasto(
        exceso,
        'ING-99',
        usdDeIngresoAvion(exceso, { gastoLigado: ligado }),
        ligado,
      ),
    ).toHaveLength(2);
    const igual = { ...propio, tc_usd_mxn: 17.237699 };
    expect(
      avisosReembolsoGasto(
        igual,
        'ING-99',
        usdDeIngresoAvion(igual, { gastoLigado: ligado }),
        ligado,
      ),
    ).toEqual([]);
  });

  it('otra categoría, USD, sin gasto_id o sin USD ⇒ sin avisos', () => {
    const conv = usdDeIngresoAvion(REEMBOLSO, { oficialDelDia: OFICIAL_0920 });
    expect(
      avisosReembolsoGasto(
        { ...REEMBOLSO, categoria: 'OTRO_INGRESO' },
        'ING-99',
        conv,
        null,
      ),
    ).toEqual([]);
    expect(
      avisosReembolsoGasto(
        { ...REEMBOLSO, gasto_id: null },
        'ING-99',
        conv,
        null,
      ),
    ).toEqual([]);
    expect(
      avisosReembolsoGasto(
        { ...REEMBOLSO, moneda: 'USD' },
        'ING-99',
        conv,
        null,
      ),
    ).toEqual([]);
    expect(
      avisosReembolsoGasto(
        REEMBOLSO,
        'ING-99',
        usdDeIngresoAvion(REEMBOLSO, {}),
        null,
      ),
    ).toEqual([]);
  });
});
