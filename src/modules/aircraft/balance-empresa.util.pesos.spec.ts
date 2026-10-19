import {
  NOTA_PESOS_BALANCE_EMPRESA,
  armarBalanceEmpresa,
  ladoEnMxn,
  participacionesEmpresa,
  type MovimientoParaEmpresa,
} from './balance-empresa.util';

/**
 * Bloque «VUELATOUR (empresa)» EN PESOS (18/19-oct-2026, API 0.0.94,
 * invariante 92): las MISMAS fuentes en su columna MXN, sin ningún T.C. de
 * por medio. Participación = Σ `monto_mxn` de la empresa como socia;
 * ingresos y egresos propios = la columna MXN de «otros movimientos» tal
 * cual; otros gastos = TOTAL MXN de «otros gastos»; tienda = utilidad MXN
 * del inventario. `null` se propaga (una celda que no llegó a pesos deja el
 * resultado vacío); la tienda ausente es una celda vacía y no anula nada.
 */

const EMPRESA = 'Aero Charter Cancun S.A. de C.V.';

const mov = (
  m: Partial<MovimientoParaEmpresa> & { tc: number | null },
): MovimientoParaEmpresa => ({
  concepto_ingreso: null,
  ingreso_mxn: null,
  concepto_egreso: null,
  egreso_mxn: null,
  ...m,
});

const PART = [
  {
    matricula: 'N4142R',
    socio: EMPRESA,
    porcentaje: 29,
    monto_usd: 290,
    monto_mxn: 5220.5,
  },
  {
    matricula: 'XB-PEV',
    socio: EMPRESA,
    porcentaje: 100,
    monto_usd: -120.5,
    monto_mxn: -2169,
  },
];

const MOVS: MovimientoParaEmpresa[] = [
  mov({
    concepto_ingreso: 'TUAS',
    ingreso_mxn: 2000,
    concepto_egreso: 'tuas pagadas',
    egreso_mxn: 1500,
    tc: 20,
  }),
  mov({ concepto_ingreso: 'extra', ingreso_mxn: 1000.25, tc: 20 }),
  mov({ concepto_egreso: 'gasto suelto', egreso_mxn: 80, tc: 18 }),
];

function bloque(extra: Partial<Parameters<typeof armarBalanceEmpresa>[0]>) {
  return armarBalanceEmpresa({
    participaciones: PART,
    movimientos: MOVS,
    otrosGastos: {
      total_mxn: 700,
      usd: 35,
      filas: [{ monto_mxn: 300 }, { monto_mxn: 400 }],
    },
    tcPromedio: 20,
    inventario: null,
    ...extra,
  });
}

describe('participacionesEmpresa EN PESOS', () => {
  it('la celda MONTO MXN del socio-empresa viaja TAL CUAL (también null); un libro sin pesos no agrega la llave', () => {
    const p = participacionesEmpresa([
      {
        matricula: 'N4142R',
        balance: {
          socios: [
            {
              nombre: EMPRESA,
              porcentaje: 29,
              monto_usd: 290,
              monto_mxn: 5220.5,
              es_empresa: true,
            },
          ],
        },
      },
      {
        matricula: 'XA-VGV',
        balance: {
          socios: [
            {
              nombre: EMPRESA,
              porcentaje: 10,
              monto_usd: null,
              monto_mxn: null,
              es_empresa: true,
            },
          ],
        },
      },
      {
        matricula: 'XB-PEV',
        balance: {
          socios: [
            {
              nombre: EMPRESA,
              porcentaje: 100,
              monto_usd: 1,
              es_empresa: true,
            },
          ],
        },
      },
    ]);
    expect(p.map((x) => x.monto_mxn)).toEqual([5220.5, null, undefined]);
    expect('monto_mxn' in p[2]).toBe(false);
  });
});

describe('ladoEnMxn — un lado de «otros movimientos» en pesos', () => {
  it('Σ de la columna MXN tal cual (sin T.C.), redondeada al final; los vacíos y ceros no cuentan', () => {
    expect(ladoEnMxn(MOVS, 'ingreso')).toBe(3000.25);
    expect(ladoEnMxn(MOVS, 'egreso')).toBe(1580);
    // Una fila sin T.C. para regresar a USD SÍ cuenta en pesos.
    expect(ladoEnMxn([mov({ ingreso_mxn: 50, tc: null })], 'ingreso')).toBe(50);
  });

  it('una fila rotulada «sin TC» (no llegó o llegó a medias a pesos) deja SU lado en null', () => {
    const conSinTc = [
      ...MOVS,
      mov({ concepto_egreso: 'comisión bancaria (USD sin TC)', tc: null }),
    ];
    expect(ladoEnMxn(conSinTc, 'egreso')).toBeNull();
    expect(ladoEnMxn(conSinTc, 'ingreso')).toBe(3000.25);
  });
});

describe('armarBalanceEmpresa EN PESOS', () => {
  it('participación + ingresos − egresos − otros gastos (+ tienda) en pesos, con su nota', () => {
    const e = bloque({});
    expect(e.participacion_mxn).toBe(3051.5);
    expect(e.ingresos_propios_mxn).toBe(3000.25);
    expect(e.pagos_vendedor_mxn).toBe(1580);
    expect(e.otros_gastos_empresa_mxn).toBe(700);
    // Sin inventario: celda vacía (null) y NO anula el resultado.
    expect(e.tienda_utilidad_mxn).toBeNull();
    expect(e.resultado_mxn).toBe(3771.75);
    expect(e.nota_pesos).toBe(NOTA_PESOS_BALANCE_EMPRESA);
    // Con tienda, suma tal cual.
    expect(
      bloque({ inventario: { total_utilidad_mxn: 228.25 } }).resultado_mxn,
    ).toBe(4000);
  });

  it('null se PROPAGA: participación sin pesos, un lado «sin TC» u «otros gastos» con una fila sin pesos dejan el resultado vacío', () => {
    const sinPart = bloque({
      participaciones: [{ ...PART[0], monto_mxn: null }, PART[1]],
    });
    expect(sinPart.participacion_mxn).toBeNull();
    expect(sinPart.resultado_mxn).toBeNull();
    // Un libro sin la llave (API previo) también es «sin pesos».
    const sinLlave = bloque({
      participaciones: [{ ...PART[0], monto_mxn: undefined }],
    });
    expect(sinLlave.participacion_mxn).toBeNull();
    const sinTc = bloque({
      movimientos: [
        ...MOVS,
        mov({ concepto_ingreso: 'TUAS (USD sin TC)', tc: null }),
      ],
    });
    expect(sinTc.ingresos_propios_mxn).toBeNull();
    expect(sinTc.resultado_mxn).toBeNull();
    const otros = bloque({
      otrosGastos: {
        total_mxn: 300,
        usd: null,
        filas: [{ monto_mxn: 300 }, { monto_mxn: null }],
      },
    });
    expect(otros.otros_gastos_empresa_mxn).toBeNull();
    expect(otros.resultado_mxn).toBeNull();
  });

  it('los dólares del bloque NO cambian con los pesos (mismo resultado USD con o sin `monto_mxn`)', () => {
    const con = bloque({});
    const sin = bloque({
      participaciones: PART.map((p) => ({ ...p, monto_mxn: undefined })),
    });
    for (const k of [
      'participacion_usd',
      'ingresos_propios_usd',
      'pagos_vendedor_usd',
      'otros_gastos_empresa_usd',
      'tienda_utilidad_usd',
      'resultado_usd',
      'nota',
    ] as const) {
      expect(con[k]).toEqual(sin[k]);
    }
  });
});
