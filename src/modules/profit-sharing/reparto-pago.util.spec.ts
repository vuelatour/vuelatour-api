import {
  COSTO_EXTERNO_TC_MAX,
  COSTO_EXTERNO_TC_MIN,
} from '../../common/costo-externo.util';
import { Rol } from '../../common/types/auth.types';
import {
  BUCKET_REPARTO_COMPROBANTES,
  MOTIVO_BAJA_CARRERA_ALTA,
  MOTIVO_BAJA_PAGO_MAX,
  ROLES_PAGOS_SOCIOS_ESCRITURA,
  ROLES_PAGOS_SOCIOS_LECTURA,
  TC_PAGO_SOCIO_MAX,
  TC_PAGO_SOCIO_MIN,
  aPagoSocio,
  compararCaptura,
  esFechaDia,
  esMes,
  etiquetaMes,
  etiquetaMesCorta,
  mesDeFechaPeriodo,
  mesDePeriodo,
  microsDeInstante,
  montoMxnDePago,
  montoUsdDePago,
  pathComprobantePago,
  periodoDeMes,
  rangoDeMes,
  textoOpcional,
  validarDineroPago,
  validarFechaPago,
  type RepartoPagoRow,
} from './reparto-pago.util';

/**
 * ENTREGAS A LA CUENTA DEL SOCIO — nivel ENTREGA (v2, 2-oct-2026): dinero
 * (USD/MXN con T.C. de 6 decimales en la banda 15–25), fecha, forma de la
 * fila, orden de captura y path del comprobante. El caso del audio del
 * cliente: $70,000 MXN a 18.5 = $3,783.78 USD informativos; LA CUENTA ES EN
 * PESOS desde el 0.0.101 (20-oct-2026, invariante 99): lo que descuenta es
 * `monto_mxn` = 70,000, y toda entrega lleva T.C. (en USD, para sus pesos;
 * en MXN, para su dólar informativo).
 */
const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';

function fila(p: Partial<RepartoPagoRow> = {}): RepartoPagoRow {
  return {
    id: 'dddddddd-0000-4000-8000-000000000001',
    aeronave_id: null,
    socio_id: MAURICIO,
    periodo: null,
    monto: '70000.00',
    moneda: 'MXN',
    tc_usd_mxn: '18.500000',
    monto_usd: '3783.78',
    monto_mxn: '70000.00',
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
    saldo_snapshot_mxn: '1395.94',
    fecha_pago: '2026-10-01',
    metodo: 'EFECTIVO',
    referencia: null,
    entregado_por: ALE,
    recibido_por: 'El socio en persona',
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ALE,
    created_at: '2026-10-01T15:00:00.000000+00:00',
    updated_at: '2026-10-01T15:00:00.000000+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...p,
  };
}

describe('reparto-pago.util — meses', () => {
  it('rangoDeMes: día 1 al último día (bisiesto incluido)', () => {
    expect(rangoDeMes('2026-09')).toEqual({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(rangoDeMes('2026-02')).toEqual({
      desde: '2026-02-01',
      hasta: '2026-02-28',
    });
    expect(rangoDeMes('2028-02')).toEqual({
      desde: '2028-02-01',
      hasta: '2028-02-29',
    });
    expect(rangoDeMes('2026-12')).toEqual({
      desde: '2026-12-01',
      hasta: '2026-12-31',
    });
    expect(() => rangoDeMes('2026-13')).toThrow();
  });

  it('mesDePeriodo: SOLO un mes calendario exacto', () => {
    expect(mesDePeriodo('2026-09-01', '2026-09-30')).toBe('2026-09');
    expect(mesDePeriodo('2028-02-01', '2028-02-29')).toBe('2028-02');
    // Mes corriente «hasta hoy», rango parcial, dos meses, día 1 de otro mes.
    expect(mesDePeriodo('2026-10-01', '2026-10-01')).toBeNull();
    expect(mesDePeriodo('2026-09-02', '2026-09-30')).toBeNull();
    expect(mesDePeriodo('2026-08-01', '2026-09-30')).toBeNull();
    expect(mesDePeriodo('2026-09-01', '2026-10-01')).toBeNull();
    expect(mesDePeriodo('2026-09-01', '2026-09-31')).toBeNull();
    expect(mesDePeriodo('basura', '2026-09-30')).toBeNull();
  });

  it('periodo ↔ mes, etiqueta y validaciones de forma', () => {
    expect(periodoDeMes('2026-09')).toBe('2026-09-01');
    expect(mesDeFechaPeriodo('2026-09-01')).toBe('2026-09');
    expect(etiquetaMes('2026-09')).toBe('septiembre 2026');
    expect(etiquetaMes('2027-01')).toBe('enero 2027');
    expect(esMes('2026-09')).toBe(true);
    expect(esMes('2026-9')).toBe(false);
    expect(esMes('2026-00')).toBe(false);
    expect(esFechaDia('2026-02-29')).toBe(false);
    expect(esFechaDia('2028-02-29')).toBe(true);
    expect(etiquetaMesCorta('2026-09')).toBe('sep 2026');
    expect(etiquetaMesCorta('2027-01')).toBe('ene 2027');
    expect(mesDeFechaPeriodo(null)).toBeNull();
  });
});

describe('reparto-pago.util — dinero', () => {
  it('montoUsdDePago: USD = monto; MXN = round(monto / tc, 2) con TC de 6 decimales', () => {
    // El audio del cliente: «adelántenme 70,000 pesos» a 18.5.
    expect(montoUsdDePago(70000, 'MXN', 18.5)).toBe(3783.78);
    expect(montoUsdDePago(1395.94, 'USD', null)).toBe(1395.94);
    expect(montoUsdDePago(10000, 'MXN', 18.234567)).toBe(548.41);
    // TC con decimales de más se normaliza a 6 antes de dividir.
    expect(montoUsdDePago(10000, 'MXN', 18.2345674)).toBe(548.41);
    expect(montoUsdDePago(25458.7, 'MXN', '18.2375')).toBe(1395.95);
    expect(montoUsdDePago(100, 'MXN', null)).toBeNull();
    expect(montoUsdDePago(100, 'MXN', 0)).toBeNull();
    expect(montoUsdDePago(0, 'USD', null)).toBeNull();
    expect(montoUsdDePago(100, 'EUR', null)).toBeNull();
  });

  it('montoMxnDePago (lo que DESCUENTA de la cuenta, invariante 99): MXN = monto; USD = round(monto × tc, 2) con TC de 6 decimales', () => {
    // El audio del cliente: «adelántenme 70,000 pesos» descuenta 70,000.
    expect(montoMxnDePago(70000, 'MXN', 18.5)).toBe(70000);
    // El T.C. de un MXN no cambia sus pesos.
    expect(montoMxnDePago(70000, 'MXN', null)).toBe(70000);
    expect(montoMxnDePago(1000, 'USD', 18.5)).toBe(18500);
    expect(montoMxnDePago(1395.94, 'USD', 18.5)).toBe(25824.89);
    expect(montoMxnDePago(100, 'USD', 18.234567)).toBe(1823.46);
    // TC con decimales de más se normaliza a 6 antes de multiplicar.
    expect(montoMxnDePago(100, 'USD', 18.2345674)).toBe(1823.46);
    expect(montoMxnDePago(100, 'USD', '18.2375')).toBe(1823.75);
    // Un USD SIN T.C. no sabe cuántos pesos descuenta.
    expect(montoMxnDePago(100, 'USD', null)).toBeNull();
    expect(montoMxnDePago(100, 'USD', 0)).toBeNull();
    expect(montoMxnDePago(0, 'MXN', 18.5)).toBeNull();
    expect(montoMxnDePago(100, 'EUR', 18.5)).toBeNull();
  });

  it('validarDineroPago: las DOS monedas exigen T.C. (USD para sus pesos, MXN para su dólar informativo), ≤ 2 decimales, nunca $0', () => {
    // USD con T.C.: válido; `tc_usd_mxn` persistido null (el CHECK de la
    // tabla lo reserva a MXN), `tc_aplicado` = el T.C., `monto_mxn` = lo
    // que descuenta de la cuenta (monto × T.C.).
    expect(
      validarDineroPago({ monto: 1395.94, moneda: 'USD', tc_usd_mxn: 18.5 }),
    ).toEqual({
      ok: true,
      monto: 1395.94,
      moneda: 'USD',
      tc_usd_mxn: null,
      tc_aplicado: 18.5,
      monto_usd: 1395.94,
      monto_mxn: 25824.89,
    });
    // MXN: descuenta su monto; el T.C. se persiste y da el dólar informativo.
    expect(
      validarDineroPago({ monto: 10000, moneda: 'MXN', tc_usd_mxn: 18.234567 }),
    ).toEqual({
      ok: true,
      monto: 10000,
      moneda: 'MXN',
      tc_usd_mxn: 18.234567,
      tc_aplicado: 18.234567,
      monto_usd: 548.41,
      monto_mxn: 10000,
    });
    const resultado = (d: Parameters<typeof validarDineroPago>[0]) => {
      const r = validarDineroPago(d);
      return r.ok ? 'OK' : r.codigo;
    };
    expect(resultado({ monto: 100, moneda: 'MXN', tc_usd_mxn: null })).toBe(
      'TC_REQUERIDO',
    );
    expect(resultado({ monto: 100, moneda: 'MXN' })).toBe('TC_REQUERIDO');
    // Hasta el 0.0.100 un USD con T.C. era `TC_NO_APLICA` y sin T.C. era
    // válido: desde el 0.0.101 (cuenta en pesos) es AL REVÉS — con T.C. es
    // válido (arriba) y sin él `TC_REQUERIDO`. `TC_NO_APLICA` ya no se emite.
    expect(resultado({ monto: 100, moneda: 'USD' })).toBe('TC_REQUERIDO');
    expect(resultado({ monto: 100, moneda: 'USD', tc_usd_mxn: null })).toBe(
      'TC_REQUERIDO',
    );
    // T.C. 0 = «sin T.C.» (no es un T.C. válido): también en USD.
    expect(resultado({ monto: 100, moneda: 'USD', tc_usd_mxn: 0 })).toBe(
      'TC_REQUERIDO',
    );
    const mensaje = (d: Parameters<typeof validarDineroPago>[0]) => {
      const r = validarDineroPago(d);
      return r.ok ? '' : r.mensaje;
    };
    expect(mensaje({ monto: 100, moneda: 'USD' })).toBe(
      'Una entrega en dólares necesita el tipo de cambio para saber cuántos pesos descuenta de la cuenta del socio.',
    );
    expect(mensaje({ monto: 100, moneda: 'MXN' })).toBe(
      'Una entrega en pesos necesita el tipo de cambio del día (para su equivalente informativo en dólares).',
    );
    // El monto y la moneda se revisan ANTES que el T.C.
    expect(resultado({ monto: 0, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(resultado({ monto: -5, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(resultado({ monto: 10.005, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(resultado({ monto: 100, moneda: 'EUR' })).toBe('MONEDA_INVALIDA');
    // 5 centavos MXN a 18.2 = 0.00 USD: el CHECK monto_usd > 0 reventaría.
    expect(resultado({ monto: 0.05, moneda: 'MXN', tc_usd_mxn: 18.2 })).toBe(
      'MONTO_INVALIDO',
    );
    // Un centavo de dólar a 15 = $0.15 MXN: cabe (nunca $0 en pesos).
    expect(
      validarDineroPago({ monto: 0.01, moneda: 'USD', tc_usd_mxn: 15 }),
    ).toMatchObject({ ok: true, monto_usd: 0.01, monto_mxn: 0.15 });
  });

  it('T.C. fuera de la banda razonable (15–25, la del costo externo) ⇒ TC_FUERA_DE_RANGO en las DOS monedas; los bordes pasan', () => {
    expect([TC_PAGO_SOCIO_MIN, TC_PAGO_SOCIO_MAX]).toEqual([
      COSTO_EXTERNO_TC_MIN,
      COSTO_EXTERNO_TC_MAX,
    ]);
    const codigo = (tc: number) => {
      const r = validarDineroPago({
        monto: 10000,
        moneda: 'MXN',
        tc_usd_mxn: tc,
      });
      return r.ok ? 'OK' : r.codigo;
    };
    // 1,000,000 desbordaba numeric(12,6) ⇒ 500; 999,999.9999999 se
    // normalizaba a 1,000,000; 0.000001 desbordaba monto_usd numeric(12,2).
    for (const tc of [
      1_000_000, 999_999.9999999, 0.000001, 1.8, 180, 14.99, 25.01,
    ]) {
      expect([tc, codigo(tc)]).toEqual([tc, 'TC_FUERA_DE_RANGO']);
    }
    for (const tc of [15, 18.234567, 25]) {
      expect([tc, codigo(tc)]).toEqual([tc, 'OK']);
    }
    const r = validarDineroPago({
      monto: 10000,
      moneda: 'MXN',
      tc_usd_mxn: 1.8,
    });
    expect(r.ok ? '' : r.mensaje).toBe(
      'El tipo de cambio 1.8 está fuera del rango razonable (15 a 25 pesos por dólar): revisa la captura.',
    );
    // En USD el T.C. ahora decide los pesos que descuenta (invariante 99):
    // 1.8 por 18 dividiría entre 10 lo descontado.
    const usd = validarDineroPago({
      monto: 100,
      moneda: 'USD',
      tc_usd_mxn: 1.8,
    });
    expect(usd.ok ? 'OK' : usd.codigo).toBe('TC_FUERA_DE_RANGO');
    expect(
      validarDineroPago({ monto: 100, moneda: 'USD', tc_usd_mxn: 25 }),
    ).toMatchObject({ ok: true, monto_mxn: 2500 });
  });

  it('validarFechaPago: día real y nunca después de hoy (Cancún)', () => {
    expect(validarFechaPago('2026-10-01', '2026-10-01')).toEqual({
      ok: true,
      fecha: '2026-10-01',
    });
    expect(validarFechaPago('2026-09-15', '2026-10-01')).toEqual({
      ok: true,
      fecha: '2026-09-15',
    });
    const r = validarFechaPago('2026-10-02', '2026-10-01');
    expect(r.ok ? 'OK' : r.codigo).toBe('FECHA_PAGO_FUTURA');
    const r2 = validarFechaPago('2026-02-30', '2026-10-01');
    expect(r2.ok ? 'OK' : r2.codigo).toBe('FECHA_PAGO_INVALIDA');
  });

  it('textoOpcional recorta y vacío ⇒ null', () => {
    expect(textoOpcional('  SPEI 123  ')).toBe('SPEI 123');
    expect(textoOpcional('   ')).toBeNull();
    expect(textoOpcional(null)).toBeNull();
    expect(textoOpcional(undefined)).toBeNull();
  });
});

describe('reparto-pago.util — forma, orden y constantes', () => {
  it('aPagoSocio: numeric como número, «corresponde a» opcional, nombres/matrícula/URL resueltos, nunca un uuid como nombre', () => {
    const adelanto = aPagoSocio(
      fila({ comprobante_path: `${MAURICIO}/p/x.pdf` }),
      new Map([[ALE, 'Ale Canales']]),
      new Map([[`${MAURICIO}/p/x.pdf`, 'https://firmada']]),
    );
    expect(adelanto).toMatchObject({
      aeronave_id: null,
      aeronave: null,
      periodo: null,
      mes: null,
      monto: 70000,
      moneda: 'MXN',
      tc_usd_mxn: 18.5,
      monto_usd: 3783.78,
      // Lo que descuenta de la cuenta, EN PESOS (invariante 99).
      monto_mxn: 70000,
      utilidad_snapshot_usd: null,
      saldo_snapshot_usd: null,
      saldo_snapshot_mxn: 1395.94,
      entregado_por_nombre: 'Ale Canales',
      created_by_nombre: 'Ale Canales',
      comprobante_url: 'https://firmada',
    });
    // Una entrega en DÓLARES: el T.C. no se persiste (CHECK) y sus pesos
    // viajan en la columna `monto_mxn`.
    expect(
      aPagoSocio(
        fila({
          moneda: 'USD',
          monto: '1000.00',
          tc_usd_mxn: null,
          monto_usd: '1000.00',
          monto_mxn: '18500.00',
        }),
      ),
    ).toMatchObject({
      moneda: 'USD',
      monto: 1000,
      tc_usd_mxn: null,
      monto_usd: 1000,
      monto_mxn: 18500,
    });
    // Fila VIEJA sin la columna `monto_mxn` (specs / lectura previa a la
    // migración 20261020000006): un MXN descuenta su monto; un USD × su T.C.
    // si lo trae; sin ninguno, 0 (jamás se inventa un T.C.).
    expect(aPagoSocio(fila({ monto_mxn: undefined })).monto_mxn).toBe(70000);
    expect(aPagoSocio(fila({ monto_mxn: null })).monto_mxn).toBe(70000);
    expect(
      aPagoSocio(
        fila({
          moneda: 'USD',
          monto: '100.00',
          tc_usd_mxn: '18.5',
          monto_usd: '100.00',
          monto_mxn: undefined,
        }),
      ).monto_mxn,
    ).toBe(1850);
    expect(
      aPagoSocio(
        fila({
          moneda: 'USD',
          monto: '100.00',
          tc_usd_mxn: null,
          monto_usd: '100.00',
          monto_mxn: undefined,
        }),
      ).monto_mxn,
    ).toBe(0);
    // Sin la columna `saldo_snapshot_mxn` (fila previa) ⇒ null.
    expect(
      aPagoSocio(fila({ saldo_snapshot_mxn: undefined })).saldo_snapshot_mxn,
    ).toBeNull();
    const conMes = aPagoSocio(
      fila({ aeronave_id: N4142R, periodo: '2026-09-01' }),
      new Map(),
      new Map(),
      new Map([[N4142R, 'N4142R']]),
    );
    expect(conMes).toMatchObject({
      aeronave: { id: N4142R, matricula: 'N4142R' },
      mes: '2026-09',
      entregado_por_nombre: null,
      comprobante_url: null,
    });
    // Legado v1: snapshot de utilidad como texto.
    expect(
      aPagoSocio(fila({ utilidad_snapshot_usd: '1395.94' }))
        .utilidad_snapshot_usd,
    ).toBe(1395.94);
  });

  it('orden de captura en MICROsegundos (Date solo llega a ms) y empate por id', () => {
    expect(
      microsDeInstante('2026-10-01T16:00:01.123456+00:00') -
        microsDeInstante('2026-10-01T16:00:01.123455+00:00'),
    ).toBe(1);
    expect(microsDeInstante('2026-10-01T16:00:01.5+00:00')).toBe(
      microsDeInstante('2026-10-01T16:00:01.500000Z'),
    );
    expect(microsDeInstante('2026-10-01T11:00:01-05:00')).toBe(
      microsDeInstante('2026-10-01T16:00:01+00:00'),
    );
    expect(Number.isNaN(microsDeInstante('no es fecha'))).toBe(true);
    const x = { id: 'b', created_at: '2026-10-01T16:00:01.123456+00:00' };
    const y = { id: 'a', created_at: '2026-10-01T16:00:01.123457+00:00' };
    expect(compararCaptura(x, y)).toBeLessThan(0);
    expect(compararCaptura(y, x)).toBeGreaterThan(0);
    expect(compararCaptura({ ...x, id: 'a' }, x)).toBeLessThan(0);
    expect(compararCaptura(x, x)).toBe(0);
  });

  it('path del comprobante: socio/entrega/uuid.ext (el anterior no se pisa)', () => {
    expect(pathComprobantePago(MAURICIO, 'pago-1', 'u-1', 'pdf')).toBe(
      `${MAURICIO}/pago-1/u-1.pdf`,
    );
    expect(BUCKET_REPARTO_COMPROBANTES).toBe('reparto-comprobantes');
  });

  it('motivo de la baja por carrera de altas cabe en el CHECK (≤ 300)', () => {
    expect(MOTIVO_BAJA_CARRERA_ALTA.length).toBeLessThanOrEqual(
      MOTIVO_BAJA_PAGO_MAX,
    );
  });

  it('roles: leen oficina + SOCIO; escriben ADMIN y FACTURACION', () => {
    expect([...ROLES_PAGOS_SOCIOS_LECTURA].sort()).toEqual(
      [Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO].sort(),
    );
    expect([...ROLES_PAGOS_SOCIOS_ESCRITURA].sort()).toEqual(
      [Rol.ADMIN, Rol.FACTURACION].sort(),
    );
  });
});
