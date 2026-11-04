import {
  COSTO_EXTERNO_TC_MAX,
  COSTO_EXTERNO_TC_MIN,
} from '../../common/costo-externo.util';
import {
  TC_PAGO_SOCIO_MAX,
  TC_PAGO_SOCIO_MIN,
} from '../profit-sharing/reparto-pago.util';
import {
  CategoriaGasto,
  EstatusComprobante,
  MedioPago,
  Moneda,
} from './dto/expenses.dto';
import type {
  AgregarGastoCompraDto,
  RegistrarGastoCompraDto,
} from './dto/compra-gasto.dto';
import {
  CATEGORIA_POR_ROL_OTRO_GASTO,
  CODIGO_COMPRA_GASTO,
  MENSAJE_COMPRA_GASTO,
  TC_COMPRA_MAX,
  TC_COMPRA_MIN,
  comprobanteDeFoto,
  cuerpoGastoDeCompra,
  cuerpoOtroGastoDeCompra,
  mensajeCategoriaNoLigable,
  mensajeTcFueraDeRango,
  notasGastoDeCompra,
  notasOtroGastoDeCompra,
  resumenGastoRegistrado,
  validarAgregarGastoCompra,
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

// ===== «Agregar gasto a la compra» (4-nov-2026, invariante 116) =====

const otro = (
  extra: Partial<AgregarGastoCompraDto> = {},
): AgregarGastoCompraDto => ({
  rol: 'ENVIO',
  monto: 1850.5,
  moneda: Moneda.MXN,
  tc_usd_mxn: 18.8052,
  fecha_gasto: '2026-11-04',
  medio_pago: MedioPago.TARJETA_CORP,
  ...extra,
});

describe('validarAgregarGastoCompra: el rol, el monto, la categoría y el T.C., en ese orden', () => {
  it('todo en orden ⇒ null; ENVIO, IMPUESTOS y OTRO pasan', () => {
    for (const rol of ['ENVIO', 'IMPUESTOS', 'OTRO']) {
      expect(validarAgregarGastoCompra({ rol, monto: 10, tc: 18 })).toBeNull();
    }
  });

  it('rol MERCANCIA (o basura, o ausente) ⇒ 400 COMPRA_GASTO_ROL_MERCANCIA antes que cualquier otra cosa', () => {
    for (const rol of ['MERCANCIA', 'mercancia', '', null, undefined, 'X']) {
      const r = validarAgregarGastoCompra({ rol, monto: NaN, tc: 'x' });
      expect(r).toMatchObject({
        status: 400,
        code: CODIGO_COMPRA_GASTO.ROL_MERCANCIA,
        message: MENSAJE_COMPRA_GASTO.ROL_MERCANCIA,
      });
    }
  });

  it('monto ausente, vacío, texto, 0 o negativo ⇒ 400 COMPRA_GASTO_MONTO_REQUERIDO (antes del T.C.)', () => {
    for (const monto of [undefined, null, '', 'mil', 0, -5]) {
      expect(
        validarAgregarGastoCompra({ rol: 'ENVIO', monto, tc: 'x' }),
      ).toMatchObject({
        status: 400,
        code: CODIGO_COMPRA_GASTO.MONTO_REQUERIDO,
      });
    }
  });

  it('una categoría que no se liga a compras ⇒ 400 COMPRA_GASTO_CATEGORIA_NO_LIGABLE con la categoría en details; sin categoría manda la del rol (siempre ligable)', () => {
    for (const categoria of [
      'GAS',
      'NOMINA',
      'OTROS_MOVIMIENTOS',
      'COMISARIATO',
    ]) {
      expect(
        validarAgregarGastoCompra({
          rol: 'OTRO',
          monto: 10,
          tc: 18,
          categoria,
        }),
      ).toMatchObject({
        status: 400,
        code: CODIGO_COMPRA_GASTO.CATEGORIA_NO_LIGABLE,
        message: mensajeCategoriaNoLigable(categoria),
        details: { categoria },
      });
    }
    expect(
      validarAgregarGastoCompra({
        rol: 'ENVIO',
        monto: 10,
        tc: 18,
        categoria: 'REFACCION',
      }),
    ).toBeNull();
    expect(
      validarAgregarGastoCompra({
        rol: 'ENVIO',
        monto: 10,
        tc: 18,
        categoria: '  ',
      }),
    ).toBeNull();
    expect(CATEGORIA_POR_ROL_OTRO_GASTO).toEqual({
      ENVIO: CategoriaGasto.PAQUETERIA,
      IMPUESTOS: CategoriaGasto.OTRO,
      OTRO: CategoriaGasto.OTRO,
    });
  });

  it('el T.C. es obligatorio y en banda, con los MISMOS códigos que «Registrar gasto»', () => {
    for (const tc of [undefined, null, '', 'x', 0, -1]) {
      expect(
        validarAgregarGastoCompra({ rol: 'ENVIO', monto: 10, tc }),
      ).toMatchObject({
        code: CODIGO_COMPRA_GASTO.TC_REQUERIDO,
      });
    }
    expect(
      validarAgregarGastoCompra({ rol: 'ENVIO', monto: 10, tc: 188 }),
    ).toMatchObject({
      code: CODIGO_COMPRA_GASTO.TC_FUERA_DE_RANGO,
      message: mensajeTcFueraDeRango(188),
    });
    expect(
      validarAgregarGastoCompra({ rol: 'ENVIO', monto: 10, tc: TC_COMPRA_MIN }),
    ).toBeNull();
    expect(
      validarAgregarGastoCompra({ rol: 'ENVIO', monto: 10, tc: TC_COMPRA_MAX }),
    ).toBeNull();
  });
});

describe('cuerpoOtroGastoDeCompra: el gasto nace con SU monto y SU moneda, sin avión, ligado por las notas', () => {
  it('el envío de UPS en PESOS dentro de una compra en dólares: PAQUETERIA, MXN, el T.C. capturado, el proveedor de ESTE pago (jamás el de la compra) y el comprobante ⇒ FACTURA', () => {
    const c = cuerpoOtroGastoDeCompra({
      compra: COMPRA,
      dto: otro({
        proveedor_id: 'prov-ups',
        tarjeta_terminacion: '6256',
        folio_ticket: ' 1Z999 ',
        foto_url: 'oficina/1762-abc-guia-ups.pdf',
        notas: 'Guía 1Z999AA10123456784',
      }),
    });
    expect(c).toEqual({
      categoria: CategoriaGasto.PAQUETERIA,
      monto: 1850.5,
      moneda: Moneda.MXN,
      tc_gasto: 18.8052,
      fecha_gasto: '2026-11-04',
      medio_pago: MedioPago.TARJETA_CORP,
      tarjeta_terminacion: '6256',
      proveedor_id: 'prov-ups',
      folio_ticket: '1Z999',
      foto_url: 'oficina/1762-abc-guia-ups.pdf',
      estatus_comprobante: EstatusComprobante.FACTURA,
      notas:
        'Envío de la compra #12 · Ref. AS-1234567 · Aircraft Spruce\nGuía 1Z999AA10123456784',
    });
    // Ni avión ni vuelo: el avión paga por la SALIDA de bodega.
    expect(c).not.toHaveProperty('aeronave_id');
    expect(c).not.toHaveProperty('vuelo_id');
  });

  it('impuestos/aduana y otro cargo nacen OTRO; la categoría capturada manda; sin proveedor ni foto no se nombran; el monto va a centavos', () => {
    const imp = cuerpoOtroGastoDeCompra({
      compra: COMPRA,
      dto: otro({ rol: 'IMPUESTOS', monto: 4525.834, moneda: Moneda.MXN }),
    });
    expect(imp.categoria).toBe(CategoriaGasto.OTRO);
    expect(imp.monto).toBe(4525.83);
    expect(imp).not.toHaveProperty('proveedor_id');
    expect(imp).not.toHaveProperty('foto_url');
    expect(imp).not.toHaveProperty('estatus_comprobante');
    expect(imp.notas).toBe(
      'Impuestos / aduana de la compra #12 · Ref. AS-1234567 · Aircraft Spruce',
    );
    const capturada = cuerpoOtroGastoDeCompra({
      compra: COMPRA,
      dto: otro({
        rol: 'OTRO',
        categoria: CategoriaGasto.OPERACIONES,
        moneda: Moneda.USD,
      }),
    });
    expect(capturada.categoria).toBe(CategoriaGasto.OPERACIONES);
    expect(capturada.moneda).toBe(Moneda.USD);
    expect(capturada.notas).toBe(
      'Otro cargo de la compra #12 · Ref. AS-1234567 · Aircraft Spruce',
    );
  });

  it('la cuenta SOLO viaja con un medio que la lleva (invariante 98); la tarjeta solo con TARJETA_CORP; la llave de idempotencia viaja', () => {
    const transf = cuerpoOtroGastoDeCompra({
      compra: COMPRA,
      dto: otro({
        medio_pago: MedioPago.TRANSFERENCIA,
        cuenta_bancaria_id: 'cta-1',
        tarjeta_terminacion: '6256',
        client_request_id: '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b',
      }),
    });
    expect(transf.cuenta_bancaria_id).toBe('cta-1');
    expect(transf).not.toHaveProperty('tarjeta_terminacion');
    expect(transf.client_request_id).toBe(
      '9b2c7a10-1d2e-4f30-8a4b-5c6d7e8f9a0b',
    );
    const efectivo = cuerpoOtroGastoDeCompra({
      compra: COMPRA,
      dto: otro({
        medio_pago: MedioPago.EFECTIVO,
        cuenta_bancaria_id: 'cta-1',
      }),
    });
    expect(efectivo).not.toHaveProperty('cuenta_bancaria_id');
  });

  it('notasOtroGastoDeCompra: cabecera con lo que haya (sin referencia ni proveedor también) y las notas debajo', () => {
    expect(
      notasOtroGastoDeCompra(
        { folio: 3, referencia: null, proveedor: null },
        'ENVIO',
        '  ',
      ),
    ).toBe('Envío de la compra #3');
    expect(
      notasOtroGastoDeCompra(
        { folio: 3, referencia: 'R-1', proveedor: null },
        'OTRO',
        'x',
      ),
    ).toBe('Otro cargo de la compra #3 · Ref. R-1\nx');
  });
});

describe('comprobante (foto_url) en «Registrar gasto» y en «Agregar gasto» (4-nov-2026)', () => {
  it('con path el gasto nace «Con comprobante» (FACTURA); vacío, espacios o ausente no nombran ninguna llave', () => {
    expect(comprobanteDeFoto('oficina/1-a-factura.pdf')).toEqual({
      foto_url: 'oficina/1-a-factura.pdf',
      estatus_comprobante: EstatusComprobante.FACTURA,
    });
    expect(comprobanteDeFoto('  ')).toEqual({});
    expect(comprobanteDeFoto(undefined)).toEqual({});
    expect(comprobanteDeFoto(null)).toEqual({});
    const con = cuerpoGastoDeCompra({
      compra: COMPRA,
      resumen: RESUMEN,
      dto: dto({ foto_url: 'oficina/1-a-factura.pdf' }),
    });
    expect(con.foto_url).toBe('oficina/1-a-factura.pdf');
    expect(con.estatus_comprobante).toBe(EstatusComprobante.FACTURA);
    const sin = cuerpoGastoDeCompra({
      compra: COMPRA,
      resumen: RESUMEN,
      dto: dto(),
    });
    expect(sin).not.toHaveProperty('foto_url');
    expect(sin).not.toHaveProperty('estatus_comprobante');
  });
});
