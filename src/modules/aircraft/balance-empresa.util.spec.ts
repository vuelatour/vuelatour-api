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

  it('pago al vendedor en DOS categorías (API 0.0.74, invariante 61): con la señal la nota dice que la «(VuelaTour)» egresa aquí y la «(avión)» que carga un avión aquí egresa $0.00; sin la señal (o false), la nota corta; ninguna dice «provisión» y el dinero no cambia', () => {
    const siempre = armarBalanceEmpresa(base);
    const conFalse = armarBalanceEmpresa({
      ...base,
      pagoVendedorACargoDelAvion: false,
    });
    const aCargo = armarBalanceEmpresa({
      ...base,
      pagoVendedorACargoDelAvion: true,
    });
    expect(conFalse).toEqual(siempre);
    expect(siempre.nota).toContain(
      'Egresos = pago al vendedor (solo los gastos reales de comisión del vendedor capturados), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.',
    );
    expect(aCargo.nota).toContain(
      'Egresos = pago al vendedor (solo los gastos reales capturados: la «Comisión del vendedor (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en su columna COMISIONES aquí egresa $0.00), TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.',
    );
    // Ya no hay provisión en ningún libro (invariantes 58 y 61).
    for (const b of [siempre, aCargo]) {
      expect(b.nota.toLowerCase()).not.toContain('provisi');
      expect(b.nota).not.toContain('exceda');
    }
    // Solo la nota: los números del bloque son los mismos.
    expect({ ...aCargo, nota: null }).toEqual({ ...siempre, nota: null });
  });

  it('una fila «a cargo del avión» (egreso 0, concepto SIN «sin TC») no baja `pagos_vendedor_usd` ni anula el lado; la misma fila con egreso real sí resta', () => {
    const aCargo = mov({
      concepto_ingreso: 'comisión vendedor (Pablo Canales)',
      ingreso_mxn: 1600,
      concepto_egreso:
        'pago comisión vendedor (Pablo Canales) · gasto real · a cargo del avión XB-PEV ($1,600.00 en su columna COMISIONES)',
      egreso_mxn: 0,
      tc: 20,
    });
    const lado = ladoEnUsd([aCargo], 'egreso');
    expect(lado.sinTc).toBe(0);
    expect(lado.usd).toBe(0);
    const b = armarBalanceEmpresa({
      ...base,
      movimientos: [aCargo],
      pagoVendedorACargoDelAvion: true,
    });
    expect(b.ingresos_propios_usd).toBe(80);
    expect(b.pagos_vendedor_usd).toBe(0);
    expect(b.movimientos_sin_tc).toBe(0);
    expect(b.resultado_usd).not.toBeNull();
    // Control: la misma fila pagada por VuelaTour (egreso real) sí resta.
    const vt = armarBalanceEmpresa({
      ...base,
      movimientos: [
        mov({
          concepto_ingreso: 'comisión vendedor (Pablo Canales)',
          ingreso_mxn: 1600,
          concepto_egreso:
            'pago comisión vendedor (Pablo Canales) · gasto real',
          egreso_mxn: 1600,
          tc: 20,
        }),
      ],
    });
    expect(vt.pagos_vendedor_usd).toBe(80);
    expect(b.resultado_usd! - vt.resultado_usd!).toBeCloseTo(80, 10);
  });

  it('fila MIXTA (dos categorías, 13-oct-2026): egresa SOLO la «(VuelaTour)»; si ésa no tiene T.C., la marca de su tramo SÍ anula el lado', () => {
    const mixta = mov({
      concepto_ingreso: 'comisión vendedor (Pablo Canales)',
      ingreso_mxn: 3000,
      concepto_egreso:
        'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · VuelaTour $2,000.00 · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
      egreso_mxn: 2000,
      tc: 20,
    });
    expect(ladoEnUsd([mixta], 'egreso')).toEqual({ usd: 100, sinTc: 0 });
    const conMixta = armarBalanceEmpresa({
      ...base,
      movimientos: [mixta],
      pagoVendedorACargoDelAvion: true,
    });
    // Solo los 2,000 de VuelaTour: los 1,000 del avión ya restaron allá.
    expect(conMixta.pagos_vendedor_usd).toBe(100);
    const vtSinTc = mov({
      concepto_ingreso: 'comisión vendedor (Pablo Canales)',
      ingreso_mxn: 3000,
      concepto_egreso:
        'pago comisión vendedor (Pablo Canales) · gasto real (2 pagos) · VuelaTour (USD sin TC) · a cargo del avión XB-PEV ($1,000.00 en su columna COMISIONES)',
      egreso_mxn: null,
      tc: 20,
    });
    expect(ladoEnUsd([vtSinTc], 'egreso')).toEqual({ usd: null, sinTc: 1 });
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

/**
 * PERMISOS AFAC COMO FILAS QUE SUMAN (13-oct-2026, API 0.0.74, invariante
 * 62): las filas «AFAC · matrícula» de «otros movimientos» entran a la
 * aritmética como cualquier fila (cada una ÷ su T.C. = `totales.tc_promedio`
 * del libro de su avión); la señal `afacEnFilas` solo cambia la NOTA. Desde
 * la revisión del 13-oct-2026 su egreso es $0.00 informativo (los permisos
 * pagados ya restan en la cascada de su avión: un gasto, una vez).
 */
describe('afacEnFilas (invariante 62)', () => {
  const baseAfac = {
    participaciones: [
      { matricula: 'N4142R', socio: EMPRESA, porcentaje: 29, monto_usd: 290 },
    ],
    movimientos: [
      mov({ ingreso_mxn: 4600, egreso_mxn: 1850, tc: 20 }),
      mov({ egreso_mxn: 80, tc: 25 }),
    ],
    otrosGastos: { total_mxn: 700, usd: 36.84 },
    tcPromedio: 19,
    inventario: { total_utilidad_mxn: 1900, total_utilidad_usd: null },
  };
  /** La frase de «otros movimientos» de la nota SIN filas AFAC (la de hoy). */
  const fraseHoy = (pagoVendedor: string) =>
    "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo y sueltas), " +
    'cada fila a USD con el T.C. de su vuelo; las sueltas con su T.C. o el oficial del día. ' +
    'Ingresos = lo COTIZADO (TUAs, extras, pernocta y comisión del vendedor) de los vuelos del periodo no cancelados, ' +
    'COTIZADO y RESERVA incluidos. ' +
    `Egresos = ${pagoVendedor}, TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.`;
  /** La misma frase CON filas AFAC (texto EXACTO del contrato). */
  const fraseAfac = (pagoVendedor: string) =>
    "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo, AFAC por avión y sueltas), " +
    'cada fila a USD con el T.C. de su vuelo; las filas «AFAC · matrícula» con el T.C. promedio de costos del libro de su avión (sin vuelos, el oficial del cierre); ' +
    'las sueltas con su T.C. o el oficial del día. ' +
    'Ingresos = lo COTIZADO (TUAs, extras, pernocta y comisión del vendedor) de los vuelos del periodo no cancelados, ' +
    'COTIZADO y RESERVA incluidos, más la provisión AFAC del periodo de cada avión (la que ese avión ya carga como costo en su columna PERMISO AFAC). ' +
    `Egresos = ${pagoVendedor}, TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos; ` +
    'los permisos pagados de cada avión van en su fila «AFAC · matrícula» con egreso $0.00: ya restan en el balance de su avión (hoja «permisos»).';
  const PAGO_CORTO =
    'pago al vendedor (solo los gastos reales de comisión del vendedor capturados)';
  const PAGO_A_CARGO =
    'pago al vendedor (solo los gastos reales capturados: la «Comisión del vendedor (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en su columna COMISIONES aquí egresa $0.00)';

  it('con la señal: la nota dice que el ingreso incluye la provisión AFAC, con su T.C., y que los permisos pagados van con egreso $0.00 (ya restan en el avión); el resto de la nota y TODOS los números, idénticos', () => {
    const hoy = armarBalanceEmpresa(baseAfac);
    const afac = armarBalanceEmpresa({ ...baseAfac, afacEnFilas: true });
    expect(afac.nota).toContain('(por vuelo, AFAC por avión y sueltas)');
    expect(afac.nota).toContain(
      'las filas «AFAC · matrícula» con el T.C. promedio de costos del libro de su avión (sin vuelos, el oficial del cierre)',
    );
    expect(afac.nota).toContain(
      'más la provisión AFAC del periodo de cada avión (la que ese avión ya carga como costo en su columna PERMISO AFAC)',
    );
    expect(afac.nota).toContain(
      'comisión bancaria y gastos sueltos; los permisos pagados de cada avión van en su fila «AFAC · matrícula» con egreso $0.00: ya restan en el balance de su avión (hoja «permisos»).',
    );
    expect(afac.nota).not.toContain('permisos AFAC pagados y');
    // La ÚNICA diferencia con la nota de hoy es esa frase, completa.
    expect(afac.nota).toContain(fraseAfac(PAGO_CORTO));
    expect(hoy.nota).toContain(fraseHoy(PAGO_CORTO));
    expect(afac.nota.replace(fraseAfac(PAGO_CORTO), fraseHoy(PAGO_CORTO))).toBe(
      hoy.nota,
    );
    // Solo la nota: la aritmética ya tomó las filas por `movimientos`.
    expect({ ...afac, nota: null }).toEqual({ ...hoy, nota: null });
  });

  it('con el pago al vendedor «a cargo del avión» (invariante 61) el fragmento largo va TAL CUAL dentro del texto nuevo', () => {
    const b = armarBalanceEmpresa({
      ...baseAfac,
      afacEnFilas: true,
      pagoVendedorACargoDelAvion: true,
    });
    expect(b.nota).toContain(fraseAfac(PAGO_A_CARGO));
    expect(b.nota).not.toContain(fraseHoy(PAGO_A_CARGO));
  });

  it('sin la llave o con false: la nota de hoy BYTE A BYTE (bloque idéntico)', () => {
    const hoy = armarBalanceEmpresa(baseAfac);
    expect(armarBalanceEmpresa({ ...baseAfac, afacEnFilas: false })).toEqual(
      hoy,
    );
    expect(hoy.nota).toContain(fraseHoy(PAGO_CORTO));
    expect(hoy.nota).not.toContain('AFAC');
    const aCargo = armarBalanceEmpresa({
      ...baseAfac,
      pagoVendedorACargoDelAvion: true,
      afacEnFilas: false,
    });
    expect(aCargo.nota).toContain(fraseHoy(PAGO_A_CARGO));
    expect(aCargo.nota).not.toContain('AFAC');
  });

  it('ladoEnUsd con una fila AFAC: el ingreso ÷ el T.C. de la fila; el egreso informativo $0.00 suma 0 y NUNCA vacía su lado (ni sin T.C. ni con permisos «USD sin T.C.», que no llevan la marca «sin TC»)', () => {
    const filaAfac = mov({
      concepto_ingreso:
        'provisión AFAC del periodo · 3 vuelos · tarifa 25.00 USD/hr',
      ingreso_mxn: 3465,
      concepto_egreso:
        'permiso AFAC pagado · AFAC anual · a cargo del avión XA-TST ($2,500.00 en su hoja «permisos»)',
      egreso_mxn: 0,
      tc: 18.5,
    });
    expect(ladoEnUsd([filaAfac], 'ingreso')).toEqual({ usd: 187.3, sinTc: 0 });
    expect(ladoEnUsd([filaAfac], 'egreso')).toEqual({ usd: 0, sinTc: 0 });
    // Libro sin T.C. promedio ⇒ el ingreso (con pesos) queda vacío; el
    // egreso $0.00 no le quita nada a su lado.
    const sinTc = { ...filaAfac, tc: null };
    expect(ladoEnUsd([sinTc], 'ingreso')).toEqual({ usd: null, sinTc: 1 });
    expect(ladoEnUsd([sinTc], 'egreso')).toEqual({ usd: 0, sinTc: 0 });
    // Permisos en USD sin T.C.: «sin T.C.» (con puntos) no es la marca.
    for (const cifra of [
      '$2,500.00 en su hoja «permisos»; 1 en USD sin T.C.',
      'en USD sin T.C. en su hoja «permisos»',
    ]) {
      const usd = mov({
        ...filaAfac,
        concepto_egreso: `permisos AFAC pagados · 2 conceptos (ver nota) · a cargo del avión XA-TST (${cifra})`,
      });
      expect(ladoEnUsd([usd], 'egreso')).toEqual({ usd: 0, sinTc: 0 });
      expect(ladoEnUsd([usd], 'ingreso')).toEqual({ usd: 187.3, sinTc: 0 });
    }
  });

  it('movimientosConTc: la fila AFAC sin su T.C. alineado LANZA (jamás se corre el T.C. de otra fila)', () => {
    const filaVuelo = {
      concepto_ingreso: 'TUA CUN',
      ingreso_mxn: 1250.5,
      concepto_egreso: 'TUA pagado',
      egreso_mxn: 1100.25,
    };
    const filaAfac = {
      concepto_ingreso:
        'provisión AFAC del periodo · 3 vuelos · tarifa 25.00 USD/hr',
      ingreso_mxn: 3465,
      concepto_egreso:
        'permiso AFAC pagado · AFAC anual · a cargo del avión XA-TST ($2,500.00 en su hoja «permisos»)',
      egreso_mxn: 0,
    };
    expect(() =>
      movimientosConTc([filaVuelo, filaAfac], [20], 'filas', [0, 0]),
    ).toThrow('trae 2 fila(s) y 1 T.C.');
    expect(() =>
      movimientosConTc([filaVuelo, filaAfac], [20, 18.5], 'filas', [0]),
    ).toThrow('trae 2 fila(s) y 1 monto(s) por cobrar');
    expect(
      movimientosConTc([filaVuelo, filaAfac], [20, 18.5], 'filas', [0, 0]),
    ).toEqual([
      { ...filaVuelo, tc: 20, por_cobrar_usd: 0 },
      { ...filaAfac, tc: 18.5, por_cobrar_usd: 0 },
    ]);
  });
});
