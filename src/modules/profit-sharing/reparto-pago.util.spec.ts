import {
  COSTO_EXTERNO_TC_MAX,
  COSTO_EXTERNO_TC_MIN,
} from '../../common/costo-externo.util';
import { Rol } from '../../common/types/auth.types';
import {
  AVISO_SOCIO_NO_VIGENTE,
  BUCKET_REPARTO_COMPROBANTES,
  CLAVE_PRECIERRE_PAGOS_SOCIOS,
  CLAVE_PRECIERRE_SOBREPAGOS_SOCIOS,
  MOTIVO_BAJA_CARRERA_ALTA,
  MOTIVO_BAJA_PAGO_MAX,
  PRECIERRE_PAGOS_SOCIOS_MAX,
  ROLES_PAGOS_SOCIOS_ESCRITURA,
  ROLES_PAGOS_SOCIOS_LECTURA,
  TC_PAGO_SOCIO_MAX,
  TC_PAGO_SOCIO_MIN,
  TEXTO_SOLO_MES_COMPLETO,
  aPagoSocio,
  armarFilasPagos,
  avisoAvionDadoDeBaja,
  avisoUtilidadCambio,
  compararCaptura,
  excedeEnOrdenDeCaptura,
  fotoMasReciente,
  microsDeInstante,
  partesDeSociosEnAvion,
  sumaMontoUsd,
  esFechaDia,
  esMes,
  estadoPagoSocio,
  etiquetaMes,
  excedeUtilidad,
  mensajeExcedeUtilidad,
  mensajeSinUtilidad,
  mesDeFechaPeriodo,
  mesDePeriodo,
  montoUsdDePago,
  pathComprobantePago,
  periodoDeMes,
  rangoDeMes,
  resumenPorSocio,
  resumenPrecierrePagos,
  textoOpcional,
  totalesPagos,
  utilidadDeSocioEnAvion,
  utilidadDifiere,
  validarDineroPago,
  validarFechaPago,
  type PagoSocio,
  type RepartoAvionInput,
  type RepartoPagoRow,
} from './reparto-pago.util';

/**
 * PAGOS DE UTILIDADES A SOCIOS (1-oct-2026) — fuente única PURA. Números
 * REALES de prod: N4142R, saldo de septiembre $2,023.10 repartido 69 / 29 /
 * 2 por residuo mayor ⇒ Mauricio Roque $1,395.94 · Aero Charter Cancun
 * $586.70 · Alexander E. Saab $40.46 (Σ = $2,023.10 exacto).
 */
const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const N990GG = 'aaaaaaaa-0000-4000-8000-000000000990';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';

const AVION_N4142R: RepartoAvionInput = {
  aeronave: { id: N4142R, matricula: 'N4142R', modelo: 'Cessna 206' },
  reparto: [
    {
      socio_id: MAURICIO,
      socio_nombre: 'Mauricio Roque',
      porcentaje: 69,
      monto_usd: 1395.94,
    },
    {
      socio_id: AERO,
      socio_nombre: 'Aero Charter Cancun S.A. de C.V.',
      porcentaje: 29,
      monto_usd: 586.7,
    },
    {
      socio_id: SAAB,
      socio_nombre: 'Alexander E. Saab',
      porcentaje: 2,
      monto_usd: 40.46,
    },
  ],
};

let seq = 0;
function pago(p: Partial<PagoSocio> & Pick<PagoSocio, 'monto_usd'>): PagoSocio {
  seq += 1;
  const row: RepartoPagoRow = {
    id: `dddddddd-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    aeronave_id: N4142R,
    socio_id: MAURICIO,
    periodo: '2026-09-01',
    monto: p.monto_usd,
    moneda: 'USD',
    tc_usd_mxn: null,
    monto_usd: p.monto_usd,
    utilidad_snapshot_usd: 1395.94,
    fecha_pago: '2026-10-01',
    metodo: 'TRANSFERENCIA',
    referencia: null,
    entregado_por: ALE,
    recibido_por: null,
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ALE,
    created_at: `2026-10-01T15:00:${String(seq % 60).padStart(2, '0')}+00:00`,
    updated_at: '2026-10-01T15:00:00+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
  };
  return { ...aPagoSocio(row), ...p };
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
    expect(TEXTO_SOLO_MES_COMPLETO).toBe(
      'Los pagos a socios se registran por mes completo: elige un mes en el selector.',
    );
  });
});

describe('reparto-pago.util — dinero', () => {
  it('montoUsdDePago: USD = monto; MXN = round(monto / tc, 2) con TC de 6 decimales', () => {
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

  it('validarDineroPago: MXN exige T.C., USD no lo lleva, ≤ 2 decimales, nunca $0 USD', () => {
    expect(
      validarDineroPago({ monto: 1395.94, moneda: 'USD', tc_usd_mxn: null }),
    ).toEqual({
      ok: true,
      monto: 1395.94,
      moneda: 'USD',
      tc_usd_mxn: null,
      monto_usd: 1395.94,
    });
    expect(
      validarDineroPago({ monto: 10000, moneda: 'MXN', tc_usd_mxn: 18.234567 }),
    ).toEqual({
      ok: true,
      monto: 10000,
      moneda: 'MXN',
      tc_usd_mxn: 18.234567,
      monto_usd: 548.41,
    });
    const codigo = (d: Parameters<typeof validarDineroPago>[0]) => {
      const r = validarDineroPago(d);
      return r.ok ? 'OK' : r.codigo;
    };
    expect(codigo({ monto: 100, moneda: 'MXN', tc_usd_mxn: null })).toBe(
      'TC_REQUERIDO',
    );
    expect(codigo({ monto: 100, moneda: 'MXN' })).toBe('TC_REQUERIDO');
    expect(codigo({ monto: 100, moneda: 'USD', tc_usd_mxn: 18.2 })).toBe(
      'TC_NO_APLICA',
    );
    // T.C. 0 en USD = «sin T.C.» (no es un T.C. válido).
    expect(codigo({ monto: 100, moneda: 'USD', tc_usd_mxn: 0 })).toBe('OK');
    expect(codigo({ monto: 0, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(codigo({ monto: -5, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(codigo({ monto: 10.005, moneda: 'USD' })).toBe('MONTO_INVALIDO');
    expect(codigo({ monto: 100, moneda: 'EUR' })).toBe('MONEDA_INVALIDA');
    // 5 centavos MXN a 18.2 = 0.00 USD: el CHECK monto_usd > 0 reventaría.
    expect(codigo({ monto: 0.05, moneda: 'MXN', tc_usd_mxn: 18.2 })).toBe(
      'MONTO_INVALIDO',
    );
  });

  it('T.C. fuera de la banda razonable (15–25, la del costo externo) ⇒ TC_FUERA_DE_RANGO; los bordes pasan', () => {
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

describe('reparto-pago.util — estado del pago (N4142R, septiembre 2026)', () => {
  it('Mauricio $1,395.94: sin pagos PENDIENTE; parcial; pagado (±$1); exceso', () => {
    expect(estadoPagoSocio(1395.94, 0)).toEqual({
      estado: 'PENDIENTE',
      pendiente_usd: 1395.94,
      exceso_usd: 0,
    });
    expect(estadoPagoSocio(1395.94, 1000)).toEqual({
      estado: 'PARCIAL',
      pendiente_usd: 395.94,
      exceso_usd: 0,
    });
    // $1,395.00 entregados: la tolerancia de $1 (la de los cobros) lo cierra.
    expect(estadoPagoSocio(1395.94, 1395)).toEqual({
      estado: 'PAGADO',
      pendiente_usd: 0,
      exceso_usd: 0,
    });
    // $0.95 de diferencia sí; $1.01 ya no.
    expect(estadoPagoSocio(1395.94, 1394.94).estado).toBe('PAGADO');
    expect(estadoPagoSocio(1395.94, 1394.93).estado).toBe('PARCIAL');
    expect(estadoPagoSocio(1395.94, 1396.94)).toEqual({
      estado: 'PAGADO',
      pendiente_usd: 0,
      exceso_usd: 0,
    });
    expect(estadoPagoSocio(1395.94, 1500)).toEqual({
      estado: 'PAGADO',
      pendiente_usd: 0,
      exceso_usd: 104.06,
    });
  });

  it('utilidad ≤ 0 ⇒ SIN_UTILIDAD (lo pagado ahí es exceso completo)', () => {
    expect(estadoPagoSocio(0, 0)).toEqual({
      estado: 'SIN_UTILIDAD',
      pendiente_usd: 0,
      exceso_usd: 0,
    });
    expect(estadoPagoSocio(-120.5, 0).estado).toBe('SIN_UTILIDAD');
    expect(estadoPagoSocio(-120.5, 300)).toEqual({
      estado: 'SIN_UTILIDAD',
      pendiente_usd: 0,
      exceso_usd: 300,
    });
    // DESVIACIÓN CONSCIENTE del contrato («pagado − utilidad»): con pérdida,
    // el exceso es lo pagado, nunca más (−500 y 100 ⇒ 100, no 600).
    expect(estadoPagoSocio(-500, 100).exceso_usd).toBe(100);
  });

  it('excedeUtilidad: pagado + monto > utilidad + $1', () => {
    expect(
      excedeUtilidad({
        utilidad_usd: 1395.94,
        pagado_usd: 0,
        monto_usd: 1395.94,
      }),
    ).toEqual({
      excede: false,
      exceso_usd: 0,
    });
    expect(
      excedeUtilidad({
        utilidad_usd: 1395.94,
        pagado_usd: 1000,
        monto_usd: 396.94,
      }).excede,
    ).toBe(false);
    expect(
      excedeUtilidad({
        utilidad_usd: 1395.94,
        pagado_usd: 1000,
        monto_usd: 396.95,
      }),
    ).toEqual({
      excede: true,
      exceso_usd: 1.01,
    });
    expect(
      mensajeExcedeUtilidad({
        utilidad_usd: 1395.94,
        pagado_usd: 1000,
        monto_usd: 500,
        exceso_usd: 104.06,
      }),
    ).toBe(
      'Con este pago el socio recibiría $1,500 USD de una utilidad del mes de $1,395.94 USD: $104.06 USD de más. ¿Registrar de todas formas?',
    );
  });

  it('utilidadDifiere: más de $1 entre la foto y hoy', () => {
    expect(utilidadDifiere(null, 1395.94)).toBe(false);
    expect(utilidadDifiere(1395.94, 1395.94)).toBe(false);
    expect(utilidadDifiere(1395.94, 1394.94)).toBe(false);
    expect(utilidadDifiere(1395.94, 1394.93)).toBe(true);
    expect(utilidadDifiere(1200, 1395.94)).toBe(true);
    expect(avisoUtilidadCambio(1200, 1395.94)).toBe(
      'La utilidad del mes cambió desde el último pago: era $1,200 USD y hoy es $1,395.94 USD. Revisa si hay que ajustar el pago.',
    );
  });

  it('mensajes de SIN_UTILIDAD (avión activo o dado de baja)', () => {
    expect(mensajeSinUtilidad('2026-09', true)).toContain('septiembre 2026');
    expect(mensajeSinUtilidad('2026-09', true)).toContain('$0 o negativa');
    expect(mensajeSinUtilidad('2026-09', false)).toContain('dado de baja');
  });
});

describe('reparto-pago.util — renglones, consolidado y totales', () => {
  it('utilidadDeSocioEnAvion lee el reparto (Σ partes = $2,023.10)', () => {
    const suma = AVION_N4142R.reparto.reduce(
      (a, r) => a + Math.round(r.monto_usd * 100),
      0,
    );
    expect(suma / 100).toBe(2023.1);
    expect(utilidadDeSocioEnAvion([AVION_N4142R], N4142R, MAURICIO)).toEqual({
      avion_activo: true,
      utilidad_usd: 1395.94,
      porcentaje: 69,
      vigente: true,
    });
    expect(utilidadDeSocioEnAvion([AVION_N4142R], N4142R, ALE)).toEqual({
      avion_activo: true,
      utilidad_usd: 0,
      porcentaje: 0,
      vigente: false,
    });
    expect(
      utilidadDeSocioEnAvion([AVION_N4142R], N990GG, MAURICIO).avion_activo,
    ).toBe(false);
  });

  it('un socio con DOS vigencias en el mes: se suman % y utilidad', () => {
    const avion: RepartoAvionInput = {
      aeronave: AVION_N4142R.aeronave,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 50,
          monto_usd: 1011.55,
        },
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 19,
          monto_usd: 384.39,
        },
      ],
    };
    expect(utilidadDeSocioEnAvion([avion], N4142R, MAURICIO).utilidad_usd).toBe(
      1395.94,
    );
    const filas = armarFilasPagos({ aviones: [avion], pagos: [] });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ porcentaje: 69, utilidad_usd: 1395.94 });
  });

  it('armarFilasPagos: cada socio vigente + pagos, estado y foto del último pago CAPTURADO', () => {
    const p1 = pago({
      monto_usd: 1000,
      fecha_pago: '2026-10-01',
      utilidad_snapshot_usd: 1395.94,
    });
    const p2 = pago({
      monto_usd: 395.94,
      fecha_pago: '2026-10-05',
      utilidad_snapshot_usd: 1200,
      moneda: 'MXN',
      monto: 7220.1,
      tc_usd_mxn: 18.235,
    });
    const filas = armarFilasPagos({ aviones: [AVION_N4142R], pagos: [p2, p1] });
    expect(
      filas.map((f) => [
        f.socio.nombre,
        f.porcentaje,
        f.utilidad_usd,
        f.estado,
      ]),
    ).toEqual([
      ['Mauricio Roque', 69, 1395.94, 'PAGADO'],
      ['Aero Charter Cancun S.A. de C.V.', 29, 586.7, 'PENDIENTE'],
      ['Alexander E. Saab', 2, 40.46, 'PENDIENTE'],
    ]);
    const mau = filas[0];
    expect(mau.pagos.map((p) => p.monto_usd)).toEqual([1000, 395.94]);
    expect(mau.pagado_usd).toBe(1395.94);
    expect(mau.pendiente_usd).toBe(0);
    // La foto del ÚLTIMO pago (5-oct) era 1,200 y hoy es 1,395.94 ⇒ difiere.
    expect(mau.utilidad_al_pagar_usd).toBe(1200);
    expect(mau.utilidad_difiere).toBe(true);
    expect(mau.vigente).toBe(true);
    expect(mau.aviso).toBeNull();
    expect(filas[1]).toMatchObject({
      pagado_usd: 0,
      pendiente_usd: 586.7,
      utilidad_al_pagar_usd: null,
      utilidad_difiere: false,
      pagos: [],
    });
  });

  it('socio con pagos que YA no está en el reparto: renglón con utilidad 0 y aviso', () => {
    const p = pago({ socio_id: ALE, monto_usd: 50 });
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R],
      pagos: [p],
      nombresSocios: new Map([[ALE, 'Alejandro Canales']]),
    });
    const ale = filas.find((f) => f.socio.id === ALE)!;
    expect(ale).toMatchObject({
      socio: { id: ALE, nombre: 'Alejandro Canales' },
      porcentaje: 0,
      utilidad_usd: 0,
      pagado_usd: 50,
      estado: 'SIN_UTILIDAD',
      exceso_usd: 50,
      vigente: false,
      aviso: AVISO_SOCIO_NO_VIGENTE,
    });
    // Va al final de su avión (vigentes primero).
    expect(filas[filas.length - 1].socio.id).toBe(ALE);
  });

  it('avión dado de baja (no viene en el cálculo): usa la ficha leída aparte', () => {
    const p = pago({ aeronave_id: N990GG, monto_usd: 10 });
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R],
      pagos: [p],
      aeronavesExtra: new Map([
        [N990GG, { id: N990GG, matricula: 'N990GG', modelo: 'C182' }],
      ]),
    });
    const f = filas.find((x) => x.aeronave.id === N990GG)!;
    expect(f.aeronave.matricula).toBe('N990GG');
    expect(f.vigente).toBe(false);
    // El aviso dice la causa REAL (avión dado de baja), no «revisa la
    // captura» (revisión adversaria 1-oct-2026).
    expect(f.aviso).toBe(avisoAvionDadoDeBaja('2026-09'));
    expect(f.aviso).toContain('El avión está dado de baja');
    expect(f.aviso).not.toBe(AVISO_SOCIO_NO_VIGENTE);
  });

  it('foto de la utilidad = la del último pago CAPTURADO, no la del último por fecha de pago', () => {
    const avion1500: RepartoAvionInput = {
      aeronave: AVION_N4142R.aeronave,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 69,
          monto_usd: 1500,
        },
      ],
    };
    // A: entregado y capturado el 5-oct con la utilidad de entonces.
    const a = pago({
      monto_usd: 500,
      fecha_pago: '2026-10-05',
      created_at: '2026-10-05T15:00:00.000000+00:00',
      utilidad_snapshot_usd: 1395.94,
    });
    // B: efectivo entregado ANTES (3-oct) pero capturado DESPUÉS (10-oct):
    // ya trae la utilidad nueva.
    const b = pago({
      monto_usd: 500,
      fecha_pago: '2026-10-03',
      created_at: '2026-10-10T15:00:00.000000+00:00',
      utilidad_snapshot_usd: 1500,
    });
    const [f] = armarFilasPagos({ aviones: [avion1500], pagos: [a, b] });
    // La lista sigue en orden de FECHA DE PAGO…
    expect(f.pagos.map((p) => p.fecha_pago)).toEqual([
      '2026-10-03',
      '2026-10-05',
    ]);
    // …pero la foto es la más reciente: no hay aviso falso.
    expect(f).toMatchObject({
      estado: 'PARCIAL',
      utilidad_al_pagar_usd: 1500,
      utilidad_difiere: false,
    });
    expect(fotoMasReciente([])).toBeNull();
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

  it('carrera de altas: sobra SOLO la capturada después (las dos peticiones concluyen lo mismo)', () => {
    const primera = {
      id: 'p-2',
      created_at: '2026-10-01T16:00:01.000001+00:00',
      monto_usd: '1395.94',
    };
    const segunda = {
      id: 'p-1',
      created_at: '2026-10-01T16:00:01.000002+00:00',
      monto_usd: '1395.94',
    };
    const vivos = [segunda, primera];
    expect(
      excedeEnOrdenDeCaptura({ utilidad_usd: 1395.94, vivos, nuevo: primera }),
    ).toEqual({ excede: false, pagado_antes_usd: 0, exceso_usd: 0 });
    expect(
      excedeEnOrdenDeCaptura({ utilidad_usd: 1395.94, vivos, nuevo: segunda }),
    ).toEqual({ excede: true, pagado_antes_usd: 1395.94, exceso_usd: 1395.94 });
    // Juntas no rebasan ⇒ ninguna sobra.
    const chica = { ...segunda, monto_usd: 0.5 };
    expect(
      excedeEnOrdenDeCaptura({
        utilidad_usd: 1395.94,
        vivos: [chica, primera],
        nuevo: chica,
      }).excede,
    ).toBe(false);
  });

  it('PARIDAD: el 409 (utilidadDeSocioEnAvion + sumaMontoUsd) y el renglón dicen el MISMO número con dos vigencias y numeric en texto', () => {
    const avion: RepartoAvionInput = {
      aeronave: AVION_N4142R.aeronave,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 50,
          monto_usd: 1011.55,
        },
        {
          socio_id: SAAB,
          socio_nombre: 'Alexander E. Saab',
          porcentaje: 2,
          monto_usd: 40.46,
        },
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 19.005,
          monto_usd: 384.39,
        },
      ],
    };
    const crudos = [
      { monto_usd: '600.10' },
      { monto_usd: '0.07' },
      { monto_usd: 0.1 },
    ];
    const pagos = crudos.map((c) => pago({ monto_usd: Number(c.monto_usd) }));
    const u = utilidadDeSocioEnAvion([avion], N4142R, MAURICIO);
    const [fila] = armarFilasPagos({ aviones: [avion], pagos });
    expect(u.utilidad_usd).toBe(fila.utilidad_usd);
    expect(u.porcentaje).toBe(fila.porcentaje);
    expect(sumaMontoUsd(crudos)).toBe(fila.pagado_usd);
    expect([fila.utilidad_usd, fila.porcentaje, fila.pagado_usd]).toEqual([
      1395.94, 69.005, 600.27,
    ]);
    // La fuente única conserva el orden del reparto y suma las vigencias.
    expect([...partesDeSociosEnAvion(avion).entries()]).toEqual([
      [
        MAURICIO,
        { nombre: 'Mauricio Roque', porcentaje: 69.005, utilidad_usd: 1395.94 },
      ],
      [
        SAAB,
        { nombre: 'Alexander E. Saab', porcentaje: 2, utilidad_usd: 40.46 },
      ],
    ]);
  });

  it('resumenPorSocio: las pérdidas de un avión NO se compensan con otro', () => {
    const otro: RepartoAvionInput = {
      aeronave: { id: N990GG, matricula: 'N990GG', modelo: 'C182' },
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 50,
          monto_usd: -200,
        },
      ],
    };
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R, otro],
      pagos: [pago({ monto_usd: 1000 })],
    });
    const porSocio = resumenPorSocio(filas);
    const mau = porSocio.find((s) => s.socio.id === MAURICIO)!;
    expect(mau).toEqual({
      socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
      utilidad_usd: 1395.94,
      pagado_usd: 1000,
      pendiente_usd: 395.94,
      estado: 'PARCIAL',
      aviones: 2,
    });
    expect(porSocio.map((s) => s.socio.nombre)).toEqual([
      'Aero Charter Cancun S.A. de C.V.',
      'Alexander E. Saab',
      'Mauricio Roque',
    ]);
    expect(totalesPagos(porSocio)).toEqual({
      utilidad_usd: 2023.1,
      pagado_usd: 1000,
      pendiente_usd: 1023.1,
      socios_pendientes: 3,
    });
  });

  it('consolidado: todo pagado ⇒ PAGADO; sin utilidad en ningún avión ⇒ SIN_UTILIDAD', () => {
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R],
      pagos: [
        pago({ monto_usd: 1395.94 }),
        pago({ socio_id: AERO, monto_usd: 586.7 }),
        pago({ socio_id: SAAB, monto_usd: 40.46 }),
      ],
    });
    const porSocio = resumenPorSocio(filas);
    expect(porSocio.every((s) => s.estado === 'PAGADO')).toBe(true);
    expect(totalesPagos(porSocio)).toEqual({
      utilidad_usd: 2023.1,
      pagado_usd: 2023.1,
      pendiente_usd: 0,
      socios_pendientes: 0,
    });
    const perdida = armarFilasPagos({
      aviones: [
        {
          ...AVION_N4142R,
          reparto: AVION_N4142R.reparto.map((r) => ({
            ...r,
            monto_usd: -r.monto_usd,
          })),
        },
      ],
      pagos: [],
    });
    expect(resumenPorSocio(perdida).map((s) => s.estado)).toEqual([
      'SIN_UTILIDAD',
      'SIN_UTILIDAD',
      'SIN_UTILIDAD',
    ]);
  });
});

describe('reparto-pago.util — pre-cierre', () => {
  it('lista PENDIENTE y PARCIAL (pendiente mayor primero) y no cuenta PAGADO ni SIN_UTILIDAD', () => {
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R],
      pagos: [
        pago({ monto_usd: 1000 }),
        pago({ socio_id: SAAB, monto_usd: 40.46 }),
      ],
    });
    const r = resumenPrecierrePagos(filas, '2026-09');
    expect(r.count).toBe(2);
    expect(r.monto_usd).toBe(982.64);
    expect(
      r.socios.map((s) => [
        s.socio.nombre,
        s.aeronave.matricula,
        s.pendiente_usd,
        s.estado,
      ]),
    ).toEqual([
      ['Aero Charter Cancun S.A. de C.V.', 'N4142R', 586.7, 'PENDIENTE'],
      ['Mauricio Roque', 'N4142R', 395.94, 'PARCIAL'],
    ]);
    expect(r.detalle).toBe(
      '2 pago(s) a socios pendientes de septiembre 2026 por $982.64 USD: Aero Charter Cancun S.A. de C.V. (N4142R) $586.70 USD, Mauricio Roque (N4142R) $395.94 USD. Regístralos en Reparto de utilidades → «Pagos a socios».',
    );
  });

  it('sin pendientes: count 0 y un texto que lo dice', () => {
    const r = resumenPrecierrePagos([], '2026-09');
    expect(r).toEqual({
      count: 0,
      monto_usd: 0,
      socios: [],
      detalle:
        'Todos los socios con utilidad de septiembre 2026 tienen su pago registrado.',
      sobrepagos: 0,
      sobrepagos_usd: 0,
      sobrepagados: [],
      detalle_sobrepagos:
        'Ningún pago a socios de septiembre 2026 quedó por encima de la utilidad.',
    });
  });

  it('SOBREPAGOS: un PAGADO con exceso o pagos sin utilidad ya no pasan como «todo registrado»', () => {
    const otro: RepartoAvionInput = {
      aeronave: { id: N990GG, matricula: 'N990GG', modelo: 'C182' },
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 50,
          monto_usd: -200,
        },
      ],
    };
    const filas = armarFilasPagos({
      aviones: [AVION_N4142R, otro],
      pagos: [
        // La utilidad bajó después de pagar: 500 de más.
        pago({ monto_usd: 1895.94 }),
        pago({ socio_id: AERO, monto_usd: 586.7 }),
        pago({ socio_id: SAAB, monto_usd: 40.46 }),
        // Pago en un avión con pérdida (SIN_UTILIDAD): todo es de más.
        pago({ aeronave_id: N990GG, monto_usd: 300 }),
      ],
    });
    const r = resumenPrecierrePagos(filas, '2026-09');
    expect(r.count).toBe(0);
    expect(r.sobrepagos).toBe(2);
    expect(r.sobrepagos_usd).toBe(800);
    expect(
      r.sobrepagados.map((s) => [
        s.socio.nombre,
        s.aeronave.matricula,
        s.exceso_usd,
        s.estado,
      ]),
    ).toEqual([
      ['Mauricio Roque', 'N4142R', 500, 'PAGADO'],
      ['Mauricio Roque', 'N990GG', 300, 'SIN_UTILIDAD'],
    ]);
    expect(r.detalle).toBe(
      'Todos los socios con utilidad de septiembre 2026 tienen su pago registrado, pero 2 pago(s) quedaron por encima de la utilidad: revisa «Pagos a socios por encima de la utilidad del mes».',
    );
    expect(r.detalle_sobrepagos).toBe(
      '2 pago(s) a socios de septiembre 2026 quedaron por encima de la utilidad por $800 USD: Mauricio Roque (N4142R) $500 USD de más, Mauricio Roque (N990GG) $300 USD de más. La utilidad bajó después de pagar (cobro reembolsado, gasto tardío), se registraron dos pagos a la vez o el socio/avión ya no está en el reparto: revisa el renglón en Reparto de utilidades → «Pagos a socios» y corrige o elimina el pago de más.',
    );
    // Con pendientes, el texto principal lo menciona al final.
    const conPendiente = resumenPrecierrePagos(
      armarFilasPagos({
        aviones: [AVION_N4142R, otro],
        pagos: [pago({ aeronave_id: N990GG, monto_usd: 300 })],
      }),
      '2026-09',
    );
    expect(conPendiente.count).toBe(3);
    expect(conPendiente.detalle).toMatch(
      /Regístralos en Reparto de utilidades → «Pagos a socios»\. Además, 1 pago\(s\) quedaron por encima de la utilidad\.$/,
    );
    expect(CLAVE_PRECIERRE_SOBREPAGOS_SOCIOS).toBe('pagos_socios_sobrepagados');
  });

  it(`tope de ${PRECIERRE_PAGOS_SOCIOS_MAX} renglones en la lista; count es el total`, () => {
    const aviones: RepartoAvionInput[] = Array.from({ length: 60 }, (_, i) => ({
      aeronave: {
        id: `av-${i}`,
        matricula: `XA-${String(i).padStart(3, '0')}`,
        modelo: 'C206',
      },
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'Mauricio Roque',
          porcentaje: 100,
          monto_usd: 10 + i,
        },
      ],
    }));
    const r = resumenPrecierrePagos(
      armarFilasPagos({ aviones, pagos: [] }),
      '2026-09',
    );
    expect(r.count).toBe(60);
    expect(r.socios).toHaveLength(PRECIERRE_PAGOS_SOCIOS_MAX);
    expect(r.socios[0].pendiente_usd).toBe(69);
    expect(r.detalle).toContain('y 55 más');
    expect(CLAVE_PRECIERRE_PAGOS_SOCIOS).toBe('pagos_socios_pendientes');
  });
});

describe('reparto-pago.util — forma y constantes', () => {
  it('aPagoSocio: numeric como número, nombres y URL resueltos, nunca un uuid como nombre', () => {
    const row = {
      ...pago({ monto_usd: 548.41 }),
      monto: '10000.00',
      moneda: 'MXN',
      tc_usd_mxn: '18.234567',
      monto_usd: '548.41',
      utilidad_snapshot_usd: '1395.94',
      comprobante_path: `${N4142R}/2026-09/p/x.pdf`,
    } as unknown as RepartoPagoRow;
    const p = aPagoSocio(
      row,
      new Map([[ALE, 'Ale Canales']]),
      new Map([[`${N4142R}/2026-09/p/x.pdf`, 'https://firmada']]),
    );
    expect(p).toMatchObject({
      mes: '2026-09',
      monto: 10000,
      moneda: 'MXN',
      tc_usd_mxn: 18.234567,
      monto_usd: 548.41,
      utilidad_snapshot_usd: 1395.94,
      entregado_por_nombre: 'Ale Canales',
      created_by_nombre: 'Ale Canales',
      comprobante_url: 'https://firmada',
    });
    const sinNombres = aPagoSocio(row);
    expect(sinNombres.entregado_por_nombre).toBeNull();
    expect(sinNombres.comprobante_url).toBeNull();
  });

  it('path del comprobante: avión/mes/pago/uuid.ext (el anterior no se pisa)', () => {
    expect(pathComprobantePago(N4142R, '2026-09', 'pago-1', 'u-1', 'pdf')).toBe(
      `${N4142R}/2026-09/pago-1/u-1.pdf`,
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
