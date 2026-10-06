import {
  armarBalanceEmpresa,
  ladoEnUsd,
  movimientosConTc,
  participacionesEmpresa,
  type MovimientoParaEmpresa,
} from './balance-empresa.util';

/**
 * Bloque «VUELATOUR (empresa)» al final de la hoja «balance» del Balance
 * general (6-oct-2026, API 0.0.59): aritmética PURA. Participación como
 * socia + ingresos − egresos de «otros movimientos» (cada fila con SU T.C.)
 * − hoja «otros gastos» + tienda. `null` se propaga: jamás un número que
 * omite dinero en silencio.
 */

const EMPRESA = 'Aero Charter Cancun S.A. de C.V.';

const libro = (
  matricula: string,
  socios: Array<{
    nombre: string;
    porcentaje: number;
    monto_usd: number | null;
    es_empresa?: boolean;
  }>,
) => ({ matricula, balance: { socios } });

const mov = (
  m: Partial<MovimientoParaEmpresa> & { tc: number | null },
): MovimientoParaEmpresa => ({
  concepto_ingreso: null,
  ingreso_mxn: null,
  concepto_egreso: null,
  egreso_mxn: null,
  ...m,
});

describe('participacionesEmpresa — los socios es_empresa de cada bloque de avión', () => {
  it('toma SOLO los es_empresa, en el orden de los libros, con su monto tal cual', () => {
    const p = participacionesEmpresa([
      libro('N4142R', [
        { nombre: 'Mauricio Roque', porcentaje: 69, monto_usd: 690 },
        { nombre: EMPRESA, porcentaje: 29, monto_usd: 290, es_empresa: true },
        { nombre: 'Alexander E. Saab', porcentaje: 2, monto_usd: 20 },
      ]),
      libro('XA-VGV', [
        { nombre: 'Hernan Garza', porcentaje: 100, monto_usd: 5000 },
      ]),
      libro('XB-PEV', [
        {
          nombre: EMPRESA,
          porcentaje: 100,
          monto_usd: -120.5,
          es_empresa: true,
        },
      ]),
    ]);
    expect(p).toEqual([
      { matricula: 'N4142R', socio: EMPRESA, porcentaje: 29, monto_usd: 290 },
      {
        matricula: 'XB-PEV',
        socio: EMPRESA,
        porcentaje: 100,
        monto_usd: -120.5,
      },
    ]);
  });

  it('es_empresa ausente (API viejo) o false NO cuenta', () => {
    expect(
      participacionesEmpresa([
        libro('N990GG', [
          { nombre: EMPRESA, porcentaje: 49, monto_usd: 10 },
          { nombre: 'Angel', porcentaje: 51, monto_usd: 11, es_empresa: false },
        ]),
      ]),
    ).toEqual([]);
  });
});

describe('ladoEnUsd — cada fila de «otros movimientos» con SU T.C.', () => {
  it('Σ (MXN ÷ T.C. de la fila), redondeado AL FINAL (no por fila)', () => {
    // Tres filas de $1.00 MXN a T.C. 3: por fila serían 0.33 × 3 = 0.99.
    const filas = [1, 1, 1].map((x) => mov({ ingreso_mxn: x, tc: 3 }));
    expect(ladoEnUsd(filas, 'ingreso')).toEqual({ usd: 1, sinTc: 0 });
  });

  it('cada fila usa su propio T.C.', () => {
    const filas = [
      mov({ ingreso_mxn: 4600, egreso_mxn: 3450, tc: 20 }),
      mov({ ingreso_mxn: 1850, tc: 18.5 }),
      mov({ egreso_mxn: 80, tc: 25 }),
    ];
    expect(ladoEnUsd(filas, 'ingreso')).toEqual({ usd: 330, sinTc: 0 });
    expect(ladoEnUsd(filas, 'egreso')).toEqual({ usd: 175.7, sinTc: 0 });
  });

  it('sin filas ⇒ 0; la referencia del hotel (egreso null) no suma', () => {
    expect(ladoEnUsd([], 'egreso')).toEqual({ usd: 0, sinTc: 0 });
    const hotel = mov({
      concepto_egreso:
        'hotel pagado $1,200.00 — ya resta en PILOTO del avión (referencia, no suma)',
      egreso_mxn: null,
      tc: 20,
    });
    expect(ladoEnUsd([hotel], 'egreso')).toEqual({ usd: 0, sinTc: 0 });
  });

  it('una fila marcada «sin TC» (ni completa ni parcial) deja el lado en null', () => {
    for (const concepto of [
      'TUA CUN (USD sin TC de venta)',
      'tuas pagadas (parcial: USD sin TC)',
      'Gasavión / Turbosina (USD sin TC)',
      'comisión del banco (parcial: cobro USD sin TC)',
      'Ingresos en cuentas de banco · Intereses (USD sin TC — no suma)',
    ]) {
      const filas = [
        mov({ egreso_mxn: 100, tc: 20 }),
        mov({ concepto_egreso: concepto, egreso_mxn: 50, tc: 20 }),
      ];
      expect(ladoEnUsd(filas, 'egreso')).toEqual({ usd: null, sinTc: 1 });
      // El OTRO lado no se contamina.
      expect(ladoEnUsd(filas, 'ingreso')).toEqual({ usd: 0, sinTc: 0 });
    }
  });

  it('texto libre que NO es la marca (proveedor, descripción) no cuenta como «sin TC»', () => {
    const filas = [
      mov({ concepto_egreso: 'TUAS · Basin Tcorp', egreso_mxn: 40, tc: 20 }),
      mov({
        concepto_egreso: 'Gasavión · sin tcomprobante',
        egreso_mxn: 60,
        tc: 20,
      }),
    ];
    expect(ladoEnUsd(filas, 'egreso')).toEqual({ usd: 5, sinTc: 0 });
  });

  it('pesos sin T.C. para regresar a USD ⇒ null (jamás sumados crudos)', () => {
    const filas = [mov({ ingreso_mxn: 500, tc: null })];
    expect(ladoEnUsd(filas, 'ingreso')).toEqual({ usd: null, sinTc: 1 });
    expect(ladoEnUsd([mov({ ingreso_mxn: 500, tc: 0 })], 'ingreso').usd).toBe(
      null,
    );
  });
});

describe('movimientosConTc — empareja filas y T.C. por índice', () => {
  it('pega el T.C. de cada fila', () => {
    expect(
      movimientosConTc(
        [
          {
            concepto_ingreso: 'TUA CUN',
            ingreso_mxn: 2000,
            concepto_egreso: null,
            egreso_mxn: null,
          },
        ],
        [20],
        'filas',
      ),
    ).toEqual([
      {
        concepto_ingreso: 'TUA CUN',
        ingreso_mxn: 2000,
        concepto_egreso: null,
        egreso_mxn: null,
        tc: 20,
      },
    ]);
  });

  it('pega también la parte por cobrar de cada fila; desalineada ⇒ lanza', () => {
    const fila = {
      concepto_ingreso: 'TUA CUN',
      ingreso_mxn: 2000,
      concepto_egreso: null,
      egreso_mxn: null,
    };
    expect(movimientosConTc([fila], [20], 'filas', [12.5])).toEqual([
      { ...fila, tc: 20, por_cobrar_usd: 12.5 },
    ]);
    expect(() => movimientosConTc([fila], [20], 'filas', [])).toThrow(
      'Bloque VUELATOUR: «otros movimientos» (filas) trae 1 fila(s) y 0 monto(s) por cobrar',
    );
  });

  it('desalineadas ⇒ lanza (jamás se adivina el emparejado)', () => {
    expect(() =>
      movimientosConTc(
        [
          {
            concepto_ingreso: null,
            ingreso_mxn: 1,
            concepto_egreso: null,
            egreso_mxn: null,
          },
        ],
        [],
        'sueltas',
      ),
    ).toThrow('Bloque VUELATOUR: «otros movimientos» (sueltas) trae 1 fila(s)');
  });
});

describe('armarBalanceEmpresa — el bloque completo', () => {
  const base = {
    participaciones: [
      { matricula: 'N4142R', socio: EMPRESA, porcentaje: 29, monto_usd: 290 },
      {
        matricula: 'XB-PEV',
        socio: EMPRESA,
        porcentaje: 100,
        monto_usd: 1500.25,
      },
    ],
    movimientos: [
      mov({ ingreso_mxn: 4600, egreso_mxn: 3450, tc: 20 }),
      mov({ egreso_mxn: 80, tc: 25 }),
    ],
    otrosGastos: { total_mxn: 700, usd: 36.84 },
    tcPromedio: 19,
    inventario: { total_utilidad_mxn: 1900, total_utilidad_usd: null },
  };

  it('participación + ingresos − egresos − otros gastos + tienda', () => {
    const b = armarBalanceEmpresa(base);
    expect(b).toMatchObject({
      participacion_usd: 1790.25,
      ingresos_propios_usd: 230,
      pagos_vendedor_usd: 175.7,
      otros_gastos_empresa_usd: 36.84,
      tc_usado: 19,
      tienda_utilidad_usd: 100,
      // 1790.25 + 230 − 175.7 − 36.84 + 100
      resultado_usd: 1907.71,
      tc_promedio: 19,
      movimientos_sin_tc: 0,
    });
    expect(b.participaciones).toEqual(base.participaciones);
    expect(b.nota).toContain('N4142R, XB-PEV');
    expect(b.nota).toContain("hoja 'otros gastos' ($700.00 MXN");
    expect(b.nota).toContain('Los gastos personales del dueño no entran.');
  });

  it('otros gastos = EXACTAMENTE el TOTAL USD de su hoja (no se recalcula)', () => {
    // 700 ÷ 19 = 36.842…; la hoja trae 36.84 y eso viaja tal cual.
    const b = armarBalanceEmpresa({
      ...base,
      otrosGastos: { total_mxn: 700, usd: 12.34 },
    });
    expect(b.otros_gastos_empresa_usd).toBe(12.34);
  });

  it('sin socio empresa ⇒ participación 0 y lista vacía (el resultado sigue)', () => {
    const b = armarBalanceEmpresa({ ...base, participaciones: [] });
    expect(b.participaciones).toEqual([]);
    expect(b.participacion_usd).toBe(0);
    expect(b.resultado_usd).toBe(117.46); // 230 − 175.7 − 36.84 + 100
    expect(b.nota).toContain('no es socia de ningún avión');
  });

  it('sin inventario ⇒ tienda null y no suma; utilidad 0 ⇒ 0', () => {
    const sin = armarBalanceEmpresa({ ...base, inventario: undefined });
    expect(sin.tienda_utilidad_usd).toBeNull();
    expect(sin.resultado_usd).toBe(1807.71);
    expect(sin.nota).toContain('Tienda: sin inventario en el periodo.');
    const vacio = armarBalanceEmpresa({
      ...base,
      inventario: { total_utilidad_mxn: null },
    });
    expect(vacio.tienda_utilidad_usd).toBeNull();
    const cero = armarBalanceEmpresa({
      ...base,
      inventario: { total_utilidad_mxn: 0 },
    });
    expect(cero.tienda_utilidad_usd).toBe(0);
    expect(cero.resultado_usd).toBe(1807.71);
  });

  it('null se PROPAGA al resultado: participación, otros gastos, movimiento o tienda sin T.C.', () => {
    const sinUtilidad = armarBalanceEmpresa({
      ...base,
      participaciones: [
        ...base.participaciones,
        {
          matricula: 'XB-ANU',
          socio: EMPRESA,
          porcentaje: 30,
          monto_usd: null,
        },
      ],
    });
    expect(sinUtilidad.participacion_usd).toBeNull();
    expect(sinUtilidad.resultado_usd).toBeNull();
    expect(sinUtilidad.nota).toContain('sin utilidad cobrada');

    const otrosSinUsd = armarBalanceEmpresa({
      ...base,
      otrosGastos: { total_mxn: 700, usd: null },
    });
    expect(otrosSinUsd.otros_gastos_empresa_usd).toBeNull();
    expect(otrosSinUsd.resultado_usd).toBeNull();

    const movSinTc = armarBalanceEmpresa({
      ...base,
      movimientos: [
        ...base.movimientos,
        mov({ concepto_ingreso: 'TUA CUN (USD sin TC de venta)', tc: null }),
      ],
    });
    expect(movSinTc.ingresos_propios_usd).toBeNull();
    expect(movSinTc.pagos_vendedor_usd).toBe(175.7);
    expect(movSinTc.movimientos_sin_tc).toBe(1);
    expect(movSinTc.resultado_usd).toBeNull();
    expect(movSinTc.nota).toContain(
      "1 fila(s) de 'otros movimientos' sin T.C.",
    );

    const tiendaSinTc = armarBalanceEmpresa({ ...base, tcPromedio: null });
    expect(tiendaSinTc.tienda_utilidad_usd).toBeNull();
    expect(tiendaSinTc.tc_usado).toBeNull();
    expect(tiendaSinTc.resultado_usd).toBeNull();
  });

  it('la nota NOMBRA el avión sin utilidad cobrada que vacía la participación', () => {
    const b = armarBalanceEmpresa({
      ...base,
      participaciones: [
        ...base.participaciones,
        {
          matricula: 'XB-ANU',
          socio: EMPRESA,
          porcentaje: 30,
          monto_usd: null,
        },
      ],
    });
    expect(b.participacion_usd).toBeNull();
    expect(b.nota).toContain('XB-ANU sin utilidad cobrada');
    expect(b.nota).not.toContain('N4142R sin utilidad');
  });

  it('por cobrar de VuelaTour: INFORMATIVO (Σ de las filas, en la nota) y NO se resta', () => {
    const b = armarBalanceEmpresa({
      ...base,
      movimientos: [
        mov({
          ingreso_mxn: 4600,
          egreso_mxn: 3450,
          tc: 20,
          por_cobrar_usd: 23.72,
        }),
        mov({ ingreso_mxn: 900, tc: 18, por_cobrar_usd: 50 }),
        mov({ egreso_mxn: 80, tc: 25, por_cobrar_usd: 0 }),
      ],
    });
    expect(b.ingresos_propios_usd).toBe(280); // 230 + 50: lo cotizado
    expect(b.ingresos_por_cobrar_usd).toBe(73.72);
    expect(b.vuelos_por_cobrar).toBe(2);
    // 1790.25 + 280 − 175.7 − 36.84 + 100: el por cobrar no resta.
    expect(b.resultado_usd).toBe(1957.71);
    expect(b.nota).toContain(
      'De esos ingresos, $73.72 USD de 2 vuelo(s) aún están por cobrar.',
    );
    expect(b.nota).toContain('Ingresos = lo COTIZADO');
    // Sin por cobrar, ni el número ni la frase.
    const sin = armarBalanceEmpresa(base);
    expect(sin.ingresos_por_cobrar_usd).toBe(0);
    expect(sin.vuelos_por_cobrar).toBe(0);
    expect(sin.nota).not.toContain('por cobrar');
  });

  it('la nota de la tienda no lleva doble punto', () => {
    const b = armarBalanceEmpresa(base);
    expect(b.nota).toContain('÷ el mismo T.C. promedio.');
    expect(b.nota).not.toContain('T.C..');
  });

  it('avisa la utilidad USD legado de la tienda que no entra', () => {
    const b = armarBalanceEmpresa({
      ...base,
      inventario: { total_utilidad_mxn: 1900, total_utilidad_usd: 191.25 },
    });
    expect(b.tienda_utilidad_usd).toBe(100);
    expect(b.nota).toContain('No incluye $191.25 USD');
  });
});
