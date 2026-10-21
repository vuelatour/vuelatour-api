import {
  COSTO_EXTERNO_TC_MAX,
  COSTO_EXTERNO_TC_MIN,
} from '../../common/costo-externo.util';
import {
  TC_PAGO_SOCIO_MAX,
  TC_PAGO_SOCIO_MIN,
} from '../profit-sharing/reparto-pago.util';
import { CategoriaGasto, MedioPago, Moneda } from './dto/expenses.dto';
import type { RegistrarGastoCompraDto } from './dto/compra-gasto.dto';
import {
  CODIGO_COMPRA_GASTO,
  MENSAJE_COMPRA_GASTO,
  TC_COMPRA_MAX,
  TC_COMPRA_MIN,
  cuerpoGastoDeCompra,
  mensajeTcFueraDeRango,
  notasGastoDeCompra,
  resumenGastoRegistrado,
  validarRegistrarGastoCompra,
} from './compra-gasto.util';

/**
 * «Registrar gasto» de una compra (21-oct-2026, invariante 101), la regla
 * PURA: el T.C. es obligatorio y en banda, el 409 de idempotencia va antes
 * que todo, y el gasto que se arma es UNO por el total de la FACTURA
 * (líneas + cargos impresos) en la moneda de la compra, sin avión.
 */
const COMPRA = {
  folio: 12,
  referencia: 'AS-1234567',
  moneda: 'USD' as const,
  proveedor_id: 'prov-as',
  proveedor: { nombre: 'Aircraft Spruce' },
};
const RESUMEN = { total_factura: 722.9 };
const dto = (
  extra: Partial<RegistrarGastoCompraDto> = {},
): RegistrarGastoCompraDto => ({
  tc_usd_mxn: 18.25,
  fecha_gasto: '2026-10-21',
  medio_pago: MedioPago.TRANSFERENCIA,
  ...extra,
});

describe('la banda del T.C. es la MISMA que la de pagos a socios y costo externo', () => {
  it('15–25 pesos por dólar', () => {
    expect([TC_COMPRA_MIN, TC_COMPRA_MAX]).toEqual([15, 25]);
    expect([TC_PAGO_SOCIO_MIN, TC_PAGO_SOCIO_MAX]).toEqual([
      TC_COMPRA_MIN,
      TC_COMPRA_MAX,
    ]);
    expect([COSTO_EXTERNO_TC_MIN, COSTO_EXTERNO_TC_MAX]).toEqual([
      TC_COMPRA_MIN,
      TC_COMPRA_MAX,
    ]);
  });
});

describe('validarRegistrarGastoCompra', () => {
  const ok = { tc: 18.25, nLineas: 2, resumen: RESUMEN, pagos: [] };

  it('todo en orden ⇒ null (se puede registrar)', () => {
    expect(validarRegistrarGastoCompra(ok)).toBeNull();
    expect(validarRegistrarGastoCompra({ ...ok, tc: '15' })).toBeNull();
    expect(validarRegistrarGastoCompra({ ...ok, tc: 25 })).toBeNull();
  });

  it('T.C. ausente, vacío, basura o ≤ 0 ⇒ 400 TC_REQUERIDO', () => {
    for (const tc of [null, undefined, '', 'abc', 0, -1]) {
      expect(validarRegistrarGastoCompra({ ...ok, tc })).toMatchObject({
        status: 400,
        code: CODIGO_COMPRA_GASTO.TC_REQUERIDO,
        message: MENSAJE_COMPRA_GASTO.TC_REQUERIDO,
      });
    }
  });

  it('T.C. fuera de 15–25 ⇒ 400 TC_FUERA_DE_RANGO con el número a la vista', () => {
    for (const tc of [14.99, 25.01, 182.5, 1.8]) {
      expect(validarRegistrarGastoCompra({ ...ok, tc })).toEqual({
        status: 400,
        code: CODIGO_COMPRA_GASTO.TC_FUERA_DE_RANGO,
        message: mensajeTcFueraDeRango(tc),
      });
    }
    expect(mensajeTcFueraDeRango(182.5)).toBe(
      'El tipo de cambio 182.5 está fuera del rango razonable (15 a 25 pesos por dólar): revisa la captura.',
    );
  });

  it('ya tiene su gasto de mercancía ⇒ 409 COMPRA_GASTO_YA_REGISTRADO con el gasto en details, ANTES que cualquier otra cosa', () => {
    const pagos = [
      { id: 'g-envio', monto: '350.00', moneda: 'MXN', compra_rol: 'ENVIO' },
      { id: 'g-merc', monto: '722.90', moneda: 'USD', compra_rol: 'MERCANCIA' },
    ];
    expect(validarRegistrarGastoCompra({ ...ok, pagos })).toEqual({
      status: 409,
      code: CODIGO_COMPRA_GASTO.YA_REGISTRADO,
      message: MENSAJE_COMPRA_GASTO.YA_REGISTRADO,
      details: { gasto_id: 'g-merc', monto: 722.9, moneda: 'USD' },
    });
    // Aunque el T.C. venga mal o no haya líneas: el 409 manda (idempotencia del botón).
    expect(
      validarRegistrarGastoCompra({ ...ok, pagos, tc: 99, nLineas: 0 }),
    ).toMatchObject({
      status: 409,
    });
  });

  it('solo cargos ligados (envío/impuestos) NO cuentan como gasto de mercancía', () => {
    const pagos = [
      { id: 'g-envio', monto: '350.00', moneda: 'MXN', compra_rol: 'ENVIO' },
    ];
    expect(validarRegistrarGastoCompra({ ...ok, pagos })).toBeNull();
  });

  it('sin líneas ⇒ 400 COMPRA_SIN_LINEAS; factura en $0 ⇒ 400 COMPRA_SIN_MONTO (antes del T.C.)', () => {
    expect(
      validarRegistrarGastoCompra({ ...ok, nLineas: 0, tc: 99 }),
    ).toMatchObject({
      status: 400,
      code: CODIGO_COMPRA_GASTO.SIN_LINEAS,
      message: MENSAJE_COMPRA_GASTO.SIN_LINEAS,
    });
    expect(
      validarRegistrarGastoCompra({
        ...ok,
        resumen: { total_factura: 0 },
        tc: 99,
      }),
    ).toMatchObject({ status: 400, code: CODIGO_COMPRA_GASTO.SIN_MONTO });
  });
});

describe('cuerpoGastoDeCompra: UN gasto REFACCION por el total de la factura, sin avión', () => {
  it('monto = total_factura en la moneda de la compra, T.C. capturado, fecha y medio del pago, proveedor de la compra, notas con la compra', () => {
    const c = cuerpoGastoDeCompra({
      compra: COMPRA,
      resumen: RESUMEN,
      dto: dto(),
    });
    expect(c).toEqual({
      categoria: CategoriaGasto.REFACCION,
      monto: 722.9,
      moneda: Moneda.USD,
      tc_gasto: 18.25,
      fecha_gasto: '2026-10-21',
      medio_pago: MedioPago.TRANSFERENCIA,
      proveedor_id: 'prov-as',
      notas: 'Compra #12 · Ref. AS-1234567 · Aircraft Spruce',
    });
    // Jamás avión, vuelo ni escala: el avión paga por la SALIDA de bodega.
    expect(c).not.toHaveProperty('aeronave_id');
    expect(c).not.toHaveProperty('vuelo_id');
    expect(c).not.toHaveProperty('inventario');
  });

  it('en pesos el T.C. también viaja (equivalente en dólares del balance) y el monto va a centavos', () => {
    const c = cuerpoGastoDeCompra({
      compra: { ...COMPRA, moneda: 'MXN' },
      resumen: { total_factura: 13194.5049 },
      dto: dto({ tc_usd_mxn: 17.2244 }),
    });
    expect(c.moneda).toBe(Moneda.MXN);
    expect(c.monto).toBe(13194.5);
    expect(c.tc_gasto).toBe(17.2244);
  });

  it('la cuenta SOLO viaja con un medio que la lleva (invariante 98); la tarjeta solo con TARJETA_CORP', () => {
    const cuenta = 'c0000000-0000-4000-8000-000000000001';
    expect(
      cuerpoGastoDeCompra({
        compra: COMPRA,
        resumen: RESUMEN,
        dto: dto({ cuenta_bancaria_id: cuenta }),
      }),
    ).toMatchObject({ cuenta_bancaria_id: cuenta });
    const efectivo = cuerpoGastoDeCompra({
      compra: COMPRA,
      resumen: RESUMEN,
      dto: dto({
        medio_pago: MedioPago.EFECTIVO,
        cuenta_bancaria_id: cuenta,
        tarjeta_terminacion: '2006',
      }),
    });
    expect(efectivo).not.toHaveProperty('cuenta_bancaria_id');
    expect(efectivo).not.toHaveProperty('tarjeta_terminacion');
    expect(
      cuerpoGastoDeCompra({
        compra: COMPRA,
        resumen: RESUMEN,
        dto: dto({
          medio_pago: MedioPago.TARJETA_CORP,
          tarjeta_terminacion: '2006',
        }),
      }),
    ).toMatchObject({
      medio_pago: MedioPago.TARJETA_CORP,
      tarjeta_terminacion: '2006',
    });
  });

  it('proveedor, folio, notas y llave de idempotencia capturados mandan; sin proveedor en ninguno, no viaja', () => {
    const c = cuerpoGastoDeCompra({
      compra: {
        ...COMPRA,
        proveedor_id: null,
        proveedor: null,
        referencia: null,
      },
      resumen: RESUMEN,
      dto: dto({
        proveedor_id: 'prov-otro',
        folio_ticket: '  F-77 ',
        notas: ' pagado con la tarjeta de Ale ',
        client_request_id: '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b',
      }),
    });
    expect(c).toMatchObject({
      proveedor_id: 'prov-otro',
      folio_ticket: 'F-77',
      client_request_id: '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b',
      notas: 'Compra #12\npagado con la tarjeta de Ale',
    });
    const sin = cuerpoGastoDeCompra({
      compra: { ...COMPRA, proveedor_id: null, proveedor: null },
      resumen: RESUMEN,
      dto: dto({ folio_ticket: '   ' }),
    });
    expect(sin).not.toHaveProperty('proveedor_id');
    expect(sin).not.toHaveProperty('folio_ticket');
  });

  it('notasGastoDeCompra: cabecera con lo que haya y las notas debajo', () => {
    expect(
      notasGastoDeCompra({ folio: 3, referencia: null, proveedor: null }, ''),
    ).toBe('Compra #3');
    expect(
      notasGastoDeCompra(
        { folio: 3, referencia: 'X', proveedor: { nombre: 'UPS' } },
        'hola',
      ),
    ).toBe('Compra #3 · Ref. X · UPS\nhola');
  });
});

describe('resumenGastoRegistrado', () => {
  it('toma lo estable de la fila creada (numéricos de PostgREST como string)', () => {
    expect(
      resumenGastoRegistrado({
        id: 'g-1',
        monto: '722.90',
        moneda: 'USD',
        tc_gasto: '18.250000',
        fecha_gasto: '2026-10-21T05:00:00+00:00',
        medio_pago: 'TRANSFERENCIA',
        estado_pago: 'PAGADO',
      }),
    ).toEqual({
      id: 'g-1',
      monto: 722.9,
      moneda: 'USD',
      tc_gasto: 18.25,
      fecha_gasto: '2026-10-21T05:00:00+00:00',
      medio_pago: 'TRANSFERENCIA',
      estado_pago: 'PAGADO',
    });
    expect(
      resumenGastoRegistrado({ id: 'g-2', monto: 1, moneda: 'MXN' }),
    ).toMatchObject({
      tc_gasto: null,
      fecha_gasto: null,
      estado_pago: null,
    });
  });
});
