import {
  armarBalanceEmpresa,
  externosParaEmpresa,
  type LibroExternosParaEmpresa,
  type MovimientoParaEmpresa,
} from './balance-empresa.util';

/**
 * VUELOS CON AVIONES EXTERNOS en el bloque «VUELATOUR (empresa)»
 * (27-oct-2026, API 0.0.112, invariante 112). Pedido del cliente: «me falta
 * en el balance de VuelaTour los vuelos con aviones externos … que sea
 * claro cuánto dejaron de ingreso, cuánto de gastos y al final la utilidad,
 * y un resumen a un lado de cuántos fueron». Aritmética PURA sobre el libro
 * EXTERNOS que el general YA calculó: ingreso = su VENTA, utilidad = su
 * UTILIDAD DESPUÉS DE GASTOS, gastos = lo que hay entre las dos. `null` se
 * propaga; sin libro, el bloque de siempre sin la llave.
 */

const mov = (
  m: Partial<MovimientoParaEmpresa> & { tc: number | null },
): MovimientoParaEmpresa => ({
  concepto_ingreso: null,
  ingreso_mxn: null,
  concepto_egreso: null,
  egreso_mxn: null,
  ...m,
});

type Vuelo = LibroExternosParaEmpresa['vuelos'][number];

const vuelo = (
  v: Partial<Vuelo> & { clave: string; folio: string },
): Vuelo => ({
  fecha: '2026-10-25',
  cliente: 'Oscar Dos',
  operador_externo: 'Simon Herrera',
  estado: 'COMPLETADO',
  ruta: 'CUN → HOL → CUN',
  total_mxn: 0,
  total_usd: 0,
  ganancia_mxn: 0,
  ganancia_usd: 0,
  por_cobrar_mxn: 0,
  status_cobro: 'PAGADO',
  ...v,
});

/**
 * Octubre 2026 de prod: #453 (Simon Herrera, venta 950 USD × 18.4888,
 * pago al operador marcado de $18,182: ganancia −617.64), #413 (Aerocharter
 * Cancun, 2,325 USD × 17.978 sin cobrar) y #234 CANCELADO sin dinero; más
 * una SOMBRA (horas de otro mes) que no cuenta. El libro resta además
 * $1,000 de combustible en su hoja (antes 41,181.21 ⇒ después 40,181.21).
 */
const LIBRO: LibroExternosParaEmpresa = {
  vuelos: [
    vuelo({
      clave: '#453',
      folio: '453',
      total_mxn: 17564.36,
      total_usd: 950,
      ganancia_mxn: -617.64,
      ganancia_usd: -33.41,
    }),
    vuelo({
      clave: '#413',
      folio: '413',
      fecha: '2026-10-23',
      cliente: 'Cliente Trece',
      operador_externo: 'Aerocharter Cancun',
      total_mxn: 41798.85,
      total_usd: 2325,
      ganancia_mxn: 41798.85,
      ganancia_usd: 2325,
      por_cobrar_mxn: 41798.85,
      status_cobro: 'PENDIENTE',
    }),
    vuelo({
      clave: '#234',
      folio: '234',
      estado: 'CANCELADO',
      cancelado: true,
      operador_externo: ' Simon Herrera ',
    }),
    vuelo({
      clave: '#999',
      folio: '999',
      fila_sombra: true,
      total_mxn: 5000,
      ganancia_mxn: 5000,
    }),
  ],
  totales: {
    total_mxn: 59363.21,
    por_cobrar_mxn: 41798.85,
    por_cobrar_usd: 2325,
  },
  balance: {
    utilidad_antes_usd: 2291.59,
    utilidad_despues_usd: 2237.51,
    utilidad_antes_mxn: 41181.21,
    utilidad_despues_mxn: 40181.21,
  },
};

describe('externosParaEmpresa — lo que dejaron los vuelos con aviones externos', () => {
  it('sin libro EXTERNOS ⇒ undefined (el bloque de siempre, sin la llave)', () => {
    expect(externosParaEmpresa(null)).toBeUndefined();
    expect(externosParaEmpresa(undefined)).toBeUndefined();
  });

  it('cuenta los vuelos con dinero (sin sombras), los cancelados y los operadores distintos (recortados)', () => {
    const e = externosParaEmpresa(LIBRO)!;
    expect(e.vuelos).toBe(3);
    expect(e.cancelados).toBe(1);
    expect(e.operadores).toEqual(['Simon Herrera', 'Aerocharter Cancun']);
    expect(e.detalle.map((d) => d.clave)).toEqual(['#453', '#413', '#234']);
  });

  it('EN PESOS: ingreso = VENTA del libro, utilidad = su UTILIDAD DESPUÉS DE GASTOS, gastos = lo de en medio; por cobrar informativo', () => {
    const e = externosParaEmpresa(LIBRO)!;
    expect(e.ingreso_mxn).toBe(59363.21);
    expect(e.utilidad_mxn).toBe(40181.21);
    expect(e.gastos_mxn).toBe(19182);
    // Las hojas del libro (combustible): la parte de los gastos fuera de las filas.
    expect(e.hojas_mxn).toBe(1000);
    expect(e.por_cobrar_mxn).toBe(41798.85);
    expect(e.sin_pesos).toEqual([]);
  });

  it('EN USD (informativo): Σ VENTA USD de las filas y la cascada USD del libro', () => {
    const e = externosParaEmpresa(LIBRO)!;
    expect(e.ingreso_usd).toBe(3275);
    expect(e.utilidad_usd).toBe(2237.51);
    expect(e.gastos_usd).toBe(1037.49);
    expect(e.hojas_usd).toBe(54.08);
    expect(e.por_cobrar_usd).toBe(2325);
  });

  it('detalle por vuelo: las celdas de su fila (gastos = venta − ganancia; el cancelado sin dinero)', () => {
    const e = externosParaEmpresa(LIBRO)!;
    expect(e.detalle[0]).toEqual({
      clave: '#453',
      folio: '453',
      fecha: '2026-10-25',
      cliente: 'Oscar Dos',
      operador: 'Simon Herrera',
      estado: 'COMPLETADO',
      cancelado: false,
      ruta: 'CUN → HOL → CUN',
      ingreso_mxn: 17564.36,
      gastos_mxn: 18182,
      utilidad_mxn: -617.64,
      por_cobrar_mxn: 0,
      status_cobro: 'PAGADO',
      ingreso_usd: 950,
      gastos_usd: 983.41,
      utilidad_usd: -33.41,
    });
    expect(e.detalle[1].gastos_mxn).toBe(0);
    expect(e.detalle[1].por_cobrar_mxn).toBe(41798.85);
    expect(e.detalle[2]).toMatchObject({
      clave: '#234',
      estado: 'CANCELADO',
      cancelado: true,
      operador: 'Simon Herrera',
      ingreso_mxn: 0,
      gastos_mxn: 0,
      utilidad_mxn: 0,
    });
  });

  it('la nota dice cuántos fueron, con quién, la base de cada línea, lo por cobrar y que TUAs/extras no se suman dos veces', () => {
    const e = externosParaEmpresa(LIBRO)!;
    expect(e.nota).toBe(
      'Vuelos con aviones externos (libro EXTERNOS del periodo): 3 vuelos (1 cancelado) con Simon Herrera, Aerocharter Cancun. ' +
        'Ingreso = la VENTA de cada vuelo en ese libro (lo cotizado al T.C. de su vuelo; en un cancelado, lo realmente cobrado); ' +
        'gastos = todo lo que ese libro resta (operaciones con el pago al operador —una sola vez—, combustible, comisiones, permisos y otros); ' +
        'utilidad = su UTILIDAD DESPUÉS DE GASTOS, que suma en el RESULTADO completa aunque esté por cobrar. ' +
        'De esos vuelos, $41,798.85 MXN siguen por cobrar (1 vuelo). ' +
        'Sus TUAs, extras, pernocta y comisión del vendedor ya están en los ingresos y egresos propios (no se suman dos veces).',
    );
  });

  it('un solo vuelo cobrado: singular, sin operador cuando no se capturó y sin la frase de por cobrar', () => {
    const e = externosParaEmpresa({
      vuelos: [
        vuelo({
          clave: '#453',
          folio: '453',
          operador_externo: '  ',
          total_mxn: 17564.36,
          total_usd: 950,
          ganancia_mxn: -617.64,
          ganancia_usd: -33.41,
        }),
      ],
      totales: { total_mxn: 17564.36, por_cobrar_mxn: 0, por_cobrar_usd: 0 },
      balance: {
        utilidad_antes_usd: -33.41,
        utilidad_despues_usd: -33.41,
        utilidad_antes_mxn: -617.64,
        utilidad_despues_mxn: -617.64,
      },
    })!;
    expect(e.vuelos).toBe(1);
    expect(e.operadores).toEqual([]);
    expect(e.detalle[0].operador).toBeNull();
    expect(e.hojas_mxn).toBe(0);
    expect(e.gastos_mxn).toBe(18182);
    expect(
      e.nota.startsWith(
        'Vuelos con aviones externos (libro EXTERNOS del periodo): 1 vuelo. ',
      ),
    ).toBe(true);
    expect(e.nota).not.toContain('por cobrar (');
  });

  it('una fila SIN pesos (sin T.C.) deja ingreso, gastos, utilidad y hojas vacíos y la nota la NOMBRA (los dólares siguen)', () => {
    const e = externosParaEmpresa({
      ...LIBRO,
      vuelos: LIBRO.vuelos.map((v) =>
        v.clave === '#413' ? { ...v, total_mxn: null, ganancia_mxn: null } : v,
      ),
    })!;
    expect(e.sin_pesos).toEqual(['#413']);
    expect(e.ingreso_mxn).toBeNull();
    expect(e.gastos_mxn).toBeNull();
    expect(e.utilidad_mxn).toBeNull();
    expect(e.hojas_mxn).toBeNull();
    expect(e.detalle[1]).toMatchObject({
      ingreso_mxn: null,
      gastos_mxn: null,
      utilidad_mxn: null,
    });
    expect(e.ingreso_usd).toBe(3275);
    expect(e.utilidad_usd).toBe(2237.51);
    expect(e.nota).toContain(
      '#413 sin pesos (sin T.C.): ingreso, gastos, utilidad y RESULTADO quedan vacíos hasta capturarlo.',
    );
  });

  it('una HOJA del libro sin pesos (cascada MXN vacía con filas completas): gastos y utilidad vacíos, ingreso sigue, y la nota lo dice', () => {
    const e = externosParaEmpresa({
      ...LIBRO,
      balance: { ...LIBRO.balance, utilidad_despues_mxn: null },
    })!;
    expect(e.ingreso_mxn).toBe(59363.21);
    expect(e.utilidad_mxn).toBeNull();
    expect(e.gastos_mxn).toBeNull();
    expect(e.hojas_mxn).toBeNull();
    expect(e.sin_pesos).toEqual([]);
    expect(e.nota).toContain('Una hoja del libro EXTERNOS no tiene pesos');
  });
});

describe('armarBalanceEmpresa — los vuelos externos SUMAN en el RESULTADO', () => {
  const base = {
    participaciones: [
      {
        matricula: 'N4142R',
        socio: 'Aero Charter Cancun S.A. de C.V.',
        porcentaje: 29,
        monto_usd: 290,
        monto_mxn: 5220.5,
      },
    ],
    movimientos: [
      mov({
        concepto_ingreso: 'TUAS',
        ingreso_mxn: 2000,
        concepto_egreso: 'tuas pagadas',
        egreso_mxn: 1500,
        tc: 20,
      }),
    ],
    otrosGastos: { total_mxn: 1800, usd: 90, filas: [{ monto_mxn: 1800 }] },
    tcPromedio: 20,
    inventario: { total_utilidad_mxn: 400, total_utilidad_usd: 20 },
  };

  it('sin externos (ausente o null): el bloque de siempre, sin la llave, byte a byte', () => {
    const sin = armarBalanceEmpresa(base);
    expect('externos' in sin).toBe(false);
    expect(armarBalanceEmpresa({ ...base, externos: null })).toEqual(sin);
    expect(armarBalanceEmpresa({ ...base, externos: undefined })).toEqual(sin);
    expect(sin.resultado_mxn).toBe(5220.5 + 2000 - 1500 - 1800 + 400);
    expect(sin.resultado_usd).toBe(290 + 100 - 75 - 90 + 20);
  });

  it('con externos: la utilidad del libro EXTERNOS suma en pesos y en USD; la llave viaja al FINAL; las notas de siempre no cambian', () => {
    const sin = armarBalanceEmpresa(base);
    const ext = externosParaEmpresa(LIBRO)!;
    const con = armarBalanceEmpresa({ ...base, externos: ext });
    expect(con.resultado_mxn).toBe(
      Math.round((sin.resultado_mxn! + 40181.21) * 100) / 100,
    );
    expect(con.resultado_usd).toBe(
      Math.round((sin.resultado_usd! + 2237.51) * 100) / 100,
    );
    expect(con.externos).toEqual(ext);
    expect(Object.keys(con).at(-1)).toBe('externos');
    expect(con.nota).toBe(sin.nota);
    expect(con.nota_pesos).toBe(sin.nota_pesos);
    // Todo lo demás, idéntico.
    const restoCon: Record<string, unknown> = { ...con };
    const restoSin: Record<string, unknown> = { ...sin };
    for (const k of ['externos', 'resultado_mxn', 'resultado_usd']) {
      delete restoCon[k];
      delete restoSin[k];
    }
    expect(restoCon).toEqual(restoSin);
  });

  it('utilidad externa vacía (sin pesos) ⇒ el RESULTADO en pesos queda vacío; el USD sigue si tiene dólares', () => {
    const ext = externosParaEmpresa({
      ...LIBRO,
      vuelos: LIBRO.vuelos.map((v) =>
        v.clave === '#453' ? { ...v, total_mxn: null, ganancia_mxn: null } : v,
      ),
    })!;
    const con = armarBalanceEmpresa({ ...base, externos: ext });
    expect(con.resultado_mxn).toBeNull();
    expect(con.resultado_usd).toBe(290 + 100 - 75 - 90 + 20 + 2237.51);
    expect(con.externos?.sin_pesos).toEqual(['#453']);
  });

  it('utilidad externa vacía también en USD ⇒ los dos resultados vacíos', () => {
    const ext = externosParaEmpresa({
      ...LIBRO,
      balance: {
        ...LIBRO.balance,
        utilidad_despues_usd: null,
        utilidad_despues_mxn: null,
      },
    })!;
    const con = armarBalanceEmpresa({ ...base, externos: ext });
    expect(con.resultado_mxn).toBeNull();
    expect(con.resultado_usd).toBeNull();
  });
});
