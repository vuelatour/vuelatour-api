import {
  CLAVE_PRECIERRE_SOCIOS_ADELANTADOS,
  CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR,
  CUENTA_DESDE_DEFAULT,
  ETIQUETAS_ESTADO_CUENTA,
  MESES_CUENTA_MAX,
  PRECIERRE_SOCIOS_MAX,
  TEXTO_CUENTA_NO_CONFIGURADA,
  aCuentaSocio,
  armarEstadoCuenta,
  armarSociosBase,
  avisosPorcentajesDeReparto,
  conceptoEntrega,
  cuentaDefault,
  estadoCuenta,
  excedeSaldo,
  excedeSaldoEnOrdenDeCaptura,
  filaCuentaSocio,
  fmtPorcentaje,
  mensajeExcedeSaldo,
  mesActualCancun,
  mesAnterior,
  mesHastaAdelantosPrecierre,
  mesSiguiente,
  mesesEntre,
  movimientosDeCuenta,
  partesDeSociosEnAvion,
  resumenPrecierreCuentas,
  saldoInicialValido,
  totalesCuentas,
  totalesDeMovimientos,
  utilidadMesDesdeAviones,
  validarCuentaDesde,
  type CuentaSocio,
  type RepartoAvionInput,
  type SocioBase,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import {
  aPagoSocio,
  validarDineroPago,
  type PagoSocio,
  type RepartoPagoRow,
} from './reparto-pago.util';

/**
 * CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026) — fuente única PURA. Números
 * REALES de prod: N4142R, septiembre 2026, saldo $2,023.10 repartido 69 /
 * 29 / 2 ⇒ Mauricio Roque $1,395.94 · Aero Charter $586.70 · Saab $40.46.
 * Caso del audio del cliente: «adelántenme 70,000 pesos de mis utilidades»
 * a T.C. 18.5 = $3,783.78 USD ⇒ la cuenta queda ADELANTADA.
 */
const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const N990GG = 'aaaaaaaa-0000-4000-8000-000000000990';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const AERO = 'bbbbbbbb-0000-4000-8000-000000000029';
const SAAB = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';

const AVION_SEP: RepartoAvionInput = {
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

const SEP = utilidadMesDesdeAviones('2026-09', [AVION_SEP], false);
const OCT_CERO = utilidadMesDesdeAviones(
  '2026-10',
  [
    {
      ...AVION_SEP,
      reparto: AVION_SEP.reparto.map((r) => ({ ...r, monto_usd: 0 })),
    },
  ],
  true,
);

let seq = 0;
function entrega(p: Partial<RepartoPagoRow> = {}): PagoSocio {
  seq += 1;
  const row: RepartoPagoRow = {
    id: `dddddddd-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    aeronave_id: null,
    socio_id: MAURICIO,
    periodo: null,
    monto: 1000,
    moneda: 'USD',
    tc_usd_mxn: null,
    monto_usd: 1000,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
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
    created_at: `2026-10-01T15:00:${String(seq % 60).padStart(2, '0')}.000000+00:00`,
    updated_at: '2026-10-01T15:00:00+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...p,
  };
  return aPagoSocio(row, new Map(), new Map(), new Map([[N4142R, 'N4142R']]));
}

/** El adelanto del audio: $70,000 MXN a 18.5 en efectivo, sin mes. */
function adelanto70k(p: Partial<RepartoPagoRow> = {}): PagoSocio {
  const d = validarDineroPago({
    monto: 70000,
    moneda: 'MXN',
    tc_usd_mxn: 18.5,
  });
  if (!d.ok) throw new Error('dinero inválido');
  return entrega({
    monto: d.monto,
    moneda: 'MXN',
    tc_usd_mxn: d.tc_usd_mxn,
    monto_usd: d.monto_usd,
    metodo: 'EFECTIVO',
    ...p,
  });
}

function base(
  cuenta: CuentaSocio = cuentaDefault(),
  socio = MAURICIO,
): SocioBase {
  return {
    socio: {
      id: socio,
      nombre: 'Mauricio Roque',
      rol: 'SOCIO',
      estado: 'ACTIVO',
      es_empresa: false,
    },
    cuenta,
    aviones: [
      {
        id: N4142R,
        matricula: 'N4142R',
        porcentaje: 69,
        vigente: true,
        activa: true,
      },
    ],
    en_aeronave_socio: true,
  };
}

describe('reparto-cuenta.util — meses', () => {
  it('mesesEntre: inclusive, cruza de año y [] si desde > hasta o basura', () => {
    expect(mesesEntre('2026-09', '2026-10')).toEqual(['2026-09', '2026-10']);
    expect(mesesEntre('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(mesesEntre('2026-10', '2026-10')).toEqual(['2026-10']);
    expect(mesesEntre('2026-10', '2026-09')).toEqual([]);
    expect(mesesEntre('2026-9', '2026-10')).toEqual([]);
    expect(mesSiguiente('2026-12')).toBe('2027-01');
    expect(mesAnterior('2027-01')).toBe('2026-12');
  });

  it('mes en curso en hora CANCÚN (las 21:00 del 30-sep Cancún ya son 1-oct UTC)', () => {
    expect(mesActualCancun(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09');
    expect(mesActualCancun(new Date('2026-10-01T05:00:00Z'))).toBe('2026-10');
  });

  it('cuenta_desde: no futuro y como máximo 36 meses atrás', () => {
    expect(validarCuentaDesde('2026-09', '2026-10')).toEqual({
      ok: true,
      mes: '2026-09',
    });
    expect(validarCuentaDesde('2026-10', '2026-10').ok).toBe(true);
    const futura = validarCuentaDesde('2026-11', '2026-10');
    expect(futura.ok ? '' : futura.codigo).toBe('CUENTA_DESDE_FUTURA');
    expect(mesesEntre('2023-11', '2026-10')).toHaveLength(MESES_CUENTA_MAX);
    expect(validarCuentaDesde('2023-11', '2026-10').ok).toBe(true);
    const vieja = validarCuentaDesde('2023-10', '2026-10');
    expect(vieja.ok ? '' : vieja.codigo).toBe('CUENTA_DESDE_FUERA_DE_RANGO');
    const basura = validarCuentaDesde('2026-9', '2026-10');
    expect(basura.ok ? '' : basura.codigo).toBe('MES_INVALIDO');
  });
});

describe('reparto-cuenta.util — estado, exceso y saldo inicial', () => {
  it('estadoCuenta: |saldo| ≤ $1.00 al corriente; > $1 por entregar; < −$1 adelantado', () => {
    expect(estadoCuenta(0)).toBe('AL_CORRIENTE');
    expect(estadoCuenta(1)).toBe('AL_CORRIENTE');
    expect(estadoCuenta(-1)).toBe('AL_CORRIENTE');
    expect(estadoCuenta(1.01)).toBe('POR_ENTREGAR');
    expect(estadoCuenta(-1.01)).toBe('ADELANTADO');
    expect(estadoCuenta(1395.94)).toBe('POR_ENTREGAR');
    expect(estadoCuenta(-2387.84)).toBe('ADELANTADO');
    expect(ETIQUETAS_ESTADO_CUENTA).toEqual({
      AL_CORRIENTE: 'Al corriente',
      POR_ENTREGAR: 'Por entregar',
      ADELANTADO: 'Adelantado',
    });
  });

  it('excedeSaldo: el adelanto de 70,000 MXN a 18.5 (= $3,783.78) sobre $1,395.94 por entregar', () => {
    expect(adelanto70k().monto_usd).toBe(3783.78);
    expect(
      excedeSaldo({ por_entregar_usd: 1395.94, monto_usd: 3783.78 }),
    ).toEqual({
      excede: true,
      exceso_usd: 2387.84,
      saldo_despues_usd: -2387.84,
    });
    // Dentro de la tolerancia de $1 no es adelanto.
    expect(
      excedeSaldo({ por_entregar_usd: 1395.94, monto_usd: 1396.94 }).excede,
    ).toBe(false);
    expect(
      excedeSaldo({ por_entregar_usd: 1395.94, monto_usd: 1396.95 }).excede,
    ).toBe(true);
    // Ya adelantado: cualquier entrega es adelanto.
    expect(excedeSaldo({ por_entregar_usd: -100, monto_usd: 50 })).toEqual({
      excede: true,
      exceso_usd: 150,
      saldo_despues_usd: -150,
    });
    expect(
      mensajeExcedeSaldo({
        monto_usd: 3783.78,
        por_entregar_usd: 1395.94,
        exceso_usd: 2387.84,
      }),
    ).toBe(
      'Esta entrega de $3,783.78 USD supera lo que hay por entregar ($1,395.94 USD). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $2,387.84 USD. ¿Registrar?',
    );
  });

  it('el candado mide lo por entregar de MESES CERRADOS: el mes en curso (negativo a principios de mes o positivo a medias) no cuenta', () => {
    const octubre = (m: number) =>
      utilidadMesDesdeAviones(
        '2026-10',
        [
          {
            ...AVION_SEP,
            reparto: AVION_SEP.reparto.map((r) => ({
              ...r,
              monto_usd: r.socio_id === MAURICIO ? m : 0,
            })),
          },
        ],
        true,
      );
    // Octubre en −$345 (gastos ya capturados, ningún vuelo cobrado).
    const t = totalesDeMovimientos(
      movimientosDeCuenta({
        socioId: MAURICIO,
        cuenta: cuentaDefault(),
        utilidades: [SEP, octubre(-345)],
        pagos: [],
      }),
    );
    expect(t).toMatchObject({
      por_entregar_usd: 1050.94,
      mes_en_curso_usd: -345,
      por_entregar_cerrado_usd: 1395.94,
    });
    // Entregar EXACTAMENTE lo de septiembre (lo que dice el pre-cierre) no
    // es adelanto.
    expect(
      excedeSaldo({
        por_entregar_usd: t.por_entregar_cerrado_usd,
        monto_usd: 1395.94,
      }).excede,
    ).toBe(false);
    // Octubre en +$500 a medias: entregar 1,895.94 SÍ es adelanto (utilidad
    // no realizada) y el texto dice cuánto lleva el mes en curso.
    const t2 = totalesDeMovimientos(
      movimientosDeCuenta({
        socioId: MAURICIO,
        cuenta: cuentaDefault(),
        utilidades: [SEP, octubre(500)],
        pagos: [],
      }),
    );
    expect(t2.por_entregar_cerrado_usd).toBe(1395.94);
    const ex = excedeSaldo({
      por_entregar_usd: t2.por_entregar_cerrado_usd,
      monto_usd: 1895.94,
    });
    expect(ex).toEqual({
      excede: true,
      exceso_usd: 500,
      saldo_despues_usd: -500,
    });
    expect(
      mensajeExcedeSaldo({
        monto_usd: 1895.94,
        por_entregar_usd: 1395.94,
        exceso_usd: 500,
        mes_en_curso_usd: 500,
      }),
    ).toBe(
      'Esta entrega de $1,895.94 USD supera lo que hay por entregar ($1,395.94 USD, sin contar el mes en curso: $500 USD). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $500 USD. ¿Registrar?',
    );
    // Mes en curso en $0 (o sin dato): el texto de siempre.
    expect(
      mensajeExcedeSaldo({
        monto_usd: 1895.94,
        por_entregar_usd: 1395.94,
        exceso_usd: 500,
        mes_en_curso_usd: 0,
      }),
    ).not.toContain('mes en curso');
  });

  it('pre-cierre: los adelantados se miden HASTA el último mes cerrado (o el mes revisado si es el en curso)', () => {
    expect(mesHastaAdelantosPrecierre('2026-09', '2026-10')).toBe('2026-09');
    expect(mesHastaAdelantosPrecierre('2026-08', '2026-10')).toBe('2026-09');
    expect(mesHastaAdelantosPrecierre('2026-10', '2026-10')).toBe('2026-10');
    expect(mesHastaAdelantosPrecierre('2026-12', '2027-01')).toBe('2026-12');
  });

  it('carrera de altas: sobra SOLO la capturada después (las dos peticiones concluyen lo mismo)', () => {
    const primera = {
      id: 'p-2',
      created_at: '2026-10-01T16:00:01.000001+00:00',
      monto_usd: '1000.00',
    };
    const segunda = {
      id: 'p-1',
      created_at: '2026-10-01T16:00:01.000002+00:00',
      monto_usd: '1000.00',
    };
    const vivos = [segunda, primera];
    expect(
      excedeSaldoEnOrdenDeCaptura({
        disponible_usd: 1395.94,
        vivos,
        nuevo: primera,
      }),
    ).toEqual({
      excede: false,
      por_entregar_antes_usd: 1395.94,
      exceso_usd: -395.94,
    });
    expect(
      excedeSaldoEnOrdenDeCaptura({
        disponible_usd: 1395.94,
        vivos,
        nuevo: segunda,
      }),
    ).toEqual({
      excede: true,
      por_entregar_antes_usd: 395.94,
      exceso_usd: 604.06,
    });
  });

  it('saldo inicial: ≤ 2 decimales, puede ser negativo, con tope', () => {
    expect(saldoInicialValido(0)).toBe(true);
    expect(saldoInicialValido(-1500.25)).toBe(true);
    expect(saldoInicialValido(1395.94)).toBe(true);
    expect(saldoInicialValido(10.005)).toBe(false);
    expect(saldoInicialValido(Number.NaN)).toBe(false);
    expect(saldoInicialValido(1e9)).toBe(false);
    expect(saldoInicialValido('10')).toBe(false);
  });
});

describe('reparto-cuenta.util — utilidades del reparto', () => {
  it('lee el reparto REAL de N4142R ($2,023.10 ⇒ 1,395.94 / 586.70 / 40.46)', () => {
    const p = partesDeSociosEnAvion(AVION_SEP);
    expect([...p.values()].map((x) => x.utilidad_usd)).toEqual([
      1395.94, 586.7, 40.46,
    ]);
    expect(SEP.aviones[0].socios).toEqual([
      { socio_id: MAURICIO, porcentaje: 69, monto_usd: 1395.94 },
      { socio_id: AERO, porcentaje: 29, monto_usd: 586.7 },
      { socio_id: SAAB, porcentaje: 2, monto_usd: 40.46 },
    ]);
    expect(SEP.aviones[0].aeronave).toEqual({
      id: N4142R,
      matricula: 'N4142R',
    });
  });

  it('un socio con DOS vigencias en el mes: se suman % y utilidad', () => {
    const dos: RepartoAvionInput = {
      ...AVION_SEP,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'M',
          porcentaje: 40,
          monto_usd: 809.24,
        },
        {
          socio_id: MAURICIO,
          socio_nombre: 'M',
          porcentaje: 29,
          monto_usd: 586.7,
        },
      ],
    };
    const u = utilidadMesDesdeAviones('2026-09', [dos], false);
    expect(u.aviones[0].socios).toEqual([
      { socio_id: MAURICIO, porcentaje: 69, monto_usd: 1395.94 },
    ]);
  });

  it('el % total del avión viaja LEÍDO de compute; ≠ 100 ⇒ aviso por avión-mes (69 % + 70 % = 139 % al cerrar y abrir vigencia en el mismo mes)', () => {
    // Sin el dato (input viejo) ⇒ null, sin aviso.
    expect(SEP.aviones[0].reparto_porcentaje_total).toBeNull();
    const sepCien = utilidadMesDesdeAviones(
      '2026-09',
      [{ ...AVION_SEP, reparto_porcentaje_total: 100 }],
      false,
    );
    expect(sepCien.aviones[0].reparto_porcentaje_total).toBe(100);
    const traslape: RepartoAvionInput = {
      ...AVION_SEP,
      reparto_porcentaje_total: 139,
      reparto: [
        {
          socio_id: MAURICIO,
          socio_nombre: 'M',
          porcentaje: 69,
          monto_usd: 1395.94,
        },
        {
          socio_id: MAURICIO,
          socio_nombre: 'M',
          porcentaje: 70,
          monto_usd: 1416.17,
        },
      ],
    };
    const oct = utilidadMesDesdeAviones('2026-10', [traslape], true);
    const aviso =
      'En octubre 2026 (mes en curso) los socios del N4142R suman 139 %, no 100 %: la cuenta suma lo que dice el reparto. Revisa las vigencias y los porcentajes de los socios en la ficha del avión.';
    // Uno por avión-mes (aunque el mes llegue repetido).
    expect(
      avisosPorcentajesDeReparto({
        socioId: MAURICIO,
        cuenta: cuentaDefault(),
        utilidades: [sepCien, oct, oct],
      }),
    ).toEqual([aviso]);
    // Socio que no está en ese avión-mes, o mes antes del arranque: nada.
    expect(
      avisosPorcentajesDeReparto({
        socioId: SAAB,
        cuenta: cuentaDefault(),
        utilidades: [oct],
      }),
    ).toEqual([]);
    expect(
      avisosPorcentajesDeReparto({
        socioId: MAURICIO,
        cuenta: { ...cuentaDefault(), cuenta_desde: '2026-11' },
        utilidades: [oct],
      }),
    ).toEqual([]);
    // El renglón del resumen y el estado de cuenta lo traen.
    const f = filaCuentaSocio({
      base: base(),
      utilidades: [sepCien, oct],
      pagos: [],
    });
    expect(f.avisos).toEqual([aviso]);
    expect(f.mes_en_curso_usd).toBe(2812.11);
    expect(
      armarEstadoCuenta({
        base: base(),
        utilidades: [sepCien, oct],
        pagos: [],
        desde: '2026-09',
        hasta: '2026-10',
      }).avisos,
    ).toEqual([aviso]);
  });
});

describe('reparto-cuenta.util — movimientos y saldo corrido', () => {
  it('cuenta default (sep-2026, saldo 0) + utilidad de septiembre ⇒ $1,395.94 POR ENTREGAR', () => {
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: cuentaDefault(),
      utilidades: [SEP, OCT_CERO],
      pagos: [],
    });
    expect(
      movs.map((m) => [
        m.fecha,
        m.tipo,
        m.concepto,
        m.cargo_usd,
        m.abono_usd,
        m.saldo_usd,
      ]),
    ).toEqual([
      [
        '2026-09-01',
        'SALDO_INICIAL',
        'Arranque de la cuenta (saldo inicial $0)',
        0,
        0,
        0,
      ],
      [
        '2026-09-30',
        'UTILIDAD',
        'Utilidad sep 2026 · N4142R 69 %',
        1395.94,
        0,
        1395.94,
      ],
    ]);
    expect(totalesDeMovimientos(movs)).toEqual({
      generado_usd: 1395.94,
      mes_en_curso_usd: 0,
      por_entregar_cerrado_usd: 1395.94,
      entregado_usd: 0,
      por_entregar_usd: 1395.94,
      estado: 'POR_ENTREGAR',
    });
  });

  it('el ADELANTO de 70,000 MXN (= $3,783.78) deja la cuenta ADELANTADA por $2,387.84', () => {
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: cuentaDefault(),
      utilidades: [SEP, OCT_CERO],
      pagos: [adelanto70k()],
    });
    const ult = movs[movs.length - 1];
    expect(ult).toMatchObject({
      fecha: '2026-10-01',
      tipo: 'ENTREGA',
      concepto: 'Adelanto a cuenta · Efectivo · $70,000 MXN a T.C. 18.5',
      mes: null,
      cargo_usd: 0,
      abono_usd: 3783.78,
      saldo_usd: -2387.84,
    });
    expect(totalesDeMovimientos(movs)).toMatchObject({
      entregado_usd: 3783.78,
      por_entregar_usd: -2387.84,
      estado: 'ADELANTADO',
    });
  });

  it('mismo día: saldo inicial, utilidades por matrícula y entregas por captura; una entrega borrada o de otro socio no cuenta', () => {
    const otra = utilidadMesDesdeAviones(
      '2026-09',
      [
        AVION_SEP,
        {
          aeronave: { id: N990GG, matricula: 'N990GG', modelo: 'C182' },
          reparto: [
            {
              socio_id: MAURICIO,
              socio_nombre: 'M',
              porcentaje: 50,
              monto_usd: -300,
            },
          ],
        },
      ],
      false,
    );
    const e1 = entrega({
      fecha_pago: '2026-09-30',
      monto: 100,
      monto_usd: 100,
    });
    const e2 = entrega({ fecha_pago: '2026-09-30', monto: 50, monto_usd: 50 });
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: { ...cuentaDefault(), saldo_inicial_usd: 500, configurada: true },
      utilidades: [otra],
      pagos: [
        e2,
        e1,
        entrega({ deleted_at: '2026-10-01T00:00:00Z', monto_usd: 999 }),
        entrega({ socio_id: SAAB, monto_usd: 999 }),
      ],
    });
    expect(
      movs.map((m) => [
        m.tipo,
        m.aeronave?.matricula ?? null,
        m.cargo_usd,
        m.abono_usd,
        m.saldo_usd,
      ]),
    ).toEqual([
      ['SALDO_INICIAL', null, 500, 0, 500],
      // Un mes con PÉRDIDA resta (cargo negativo): la cuenta suma lo que
      // dice el reparto, tal cual.
      ['UTILIDAD', 'N4142R', 1395.94, 0, 1895.94],
      ['UTILIDAD', 'N990GG', -300, 0, 1595.94],
      ['ENTREGA', null, 0, 100, 1495.94],
      ['ENTREGA', null, 0, 50, 1445.94],
    ]);
  });

  it('saldo inicial negativo (ya adelantado) = abono; utilidades antes del arranque se ignoran; una utilidad de $0 no hace renglón', () => {
    const cuenta: CuentaSocio = {
      cuenta_desde: '2026-10',
      saldo_inicial_usd: -200,
      notas: null,
      configurada: true,
      updated_at: null,
    };
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta,
      utilidades: [SEP, OCT_CERO],
      pagos: [],
    });
    expect(movs).toEqual([
      expect.objectContaining({
        tipo: 'SALDO_INICIAL',
        fecha: '2026-10-01',
        concepto: 'Arranque de la cuenta · saldo inicial ya adelantado',
        cargo_usd: 0,
        abono_usd: 200,
        saldo_usd: -200,
      }),
    ]);
  });

  it('el mes EN CURSO viaja marcado y suma aparte en mes_en_curso_usd', () => {
    const oct = utilidadMesDesdeAviones(
      '2026-10',
      [
        {
          ...AVION_SEP,
          reparto: [{ ...AVION_SEP.reparto[0], monto_usd: 207 }],
        },
      ],
      true,
    );
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: cuentaDefault(),
      utilidades: [SEP, oct],
      pagos: [],
    });
    expect(movs[2]).toMatchObject({
      fecha: '2026-10-31',
      tipo: 'UTILIDAD',
      en_curso: true,
      cargo_usd: 207,
    });
    expect(totalesDeMovimientos(movs)).toMatchObject({
      generado_usd: 1602.94,
      mes_en_curso_usd: 207,
      por_entregar_usd: 1602.94,
    });
  });

  it('pre-cierre: `utilidadesHasta` corta las utilidades pero cuenta TODAS las entregas', () => {
    const oct = utilidadMesDesdeAviones(
      '2026-10',
      [
        {
          ...AVION_SEP,
          reparto: [{ ...AVION_SEP.reparto[0], monto_usd: 207 }],
        },
      ],
      true,
    );
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: cuentaDefault(),
      utilidades: [SEP, oct],
      pagos: [entrega({ monto_usd: 1395.94, monto: 1395.94 })],
      utilidadesHasta: '2026-09',
    });
    expect(movs[movs.length - 1].saldo_usd).toBe(0);
  });

  it('conceptos de entrega: con mes y avión, con referencia, otro método', () => {
    expect(
      conceptoEntrega(
        entrega({
          periodo: '2026-09-01',
          aeronave_id: N4142R,
          referencia: 'SPEI 0012345',
        }),
      ),
    ).toBe(
      'Entrega · Transferencia · ref SPEI 0012345 · corresponde a sep 2026 · N4142R',
    );
    expect(conceptoEntrega(entrega({ metodo: 'CHEQUE' }))).toBe(
      'Adelanto a cuenta · Cheque',
    );
    expect(fmtPorcentaje(33.3333)).toBe('33.333 %');
    expect(fmtPorcentaje(12.5)).toBe('12.5 %');
  });
});

describe('reparto-cuenta.util — estado de cuenta con rango', () => {
  it('desde posterior al arranque ⇒ SALDO_ANTERIOR (incluye saldo inicial y entregas previas); totales de la cuenta completa', () => {
    const e1 = entrega({
      fecha_pago: '2026-09-15',
      monto: 300,
      monto_usd: 300,
    });
    const e2 = entrega({
      fecha_pago: '2026-10-01',
      monto: 500,
      monto_usd: 500,
    });
    const r = armarEstadoCuenta({
      base: base({
        ...cuentaDefault(),
        saldo_inicial_usd: 100,
        configurada: true,
      }),
      utilidades: [SEP, OCT_CERO],
      pagos: [e1, e2],
      desde: '2026-10',
      hasta: '2026-10',
    });
    // 100 + 1,395.94 − 300 = 1,195.94 al cierre de septiembre.
    expect(r.saldo_anterior_usd).toBe(1195.94);
    expect(r.movimientos.map((m) => [m.tipo, m.concepto, m.saldo_usd])).toEqual(
      [
        ['SALDO_ANTERIOR', 'Saldo al cierre de sep 2026', 1195.94],
        ['ENTREGA', 'Adelanto a cuenta · Transferencia', 695.94],
      ],
    );
    expect(r.rango).toEqual({
      generado_usd: 0,
      entregado_usd: 500,
      saldo_final_usd: 695.94,
    });
    expect(r.totales).toEqual({
      generado_usd: 1395.94,
      mes_en_curso_usd: 0,
      por_entregar_cerrado_usd: 695.94,
      entregado_usd: 800,
      por_entregar_usd: 695.94,
      estado: 'POR_ENTREGAR',
    });
    expect(r.por_mes).toEqual([
      {
        mes: '2026-10',
        utilidad_usd: 0,
        en_curso: true,
        por_avion: [
          {
            aeronave: { id: N4142R, matricula: 'N4142R' },
            porcentaje: 69,
            monto_usd: 0,
          },
        ],
        entregado_usd: 500,
      },
    ]);
  });

  it('desde = arranque: sin SALDO_ANTERIOR (saldo_anterior 0); hasta corta las entregas posteriores (pero cuentan en totales)', () => {
    const r = armarEstadoCuenta({
      base: base(),
      utilidades: [SEP, OCT_CERO],
      pagos: [
        entrega({ fecha_pago: '2026-10-01', monto_usd: 400, monto: 400 }),
      ],
      desde: '2026-09',
      hasta: '2026-09',
    });
    expect(r.saldo_anterior_usd).toBe(0);
    expect(r.movimientos.map((m) => m.tipo)).toEqual([
      'SALDO_INICIAL',
      'UTILIDAD',
    ]);
    expect(r.rango.saldo_final_usd).toBe(1395.94);
    expect(r.totales.por_entregar_usd).toBe(995.94);
    expect(r.por_mes[0]).toMatchObject({
      mes: '2026-09',
      utilidad_usd: 1395.94,
      entregado_usd: 0,
    });
  });

  it('avisos: entregas fechadas ANTES del arranque y aviones dados de baja', () => {
    const b = base();
    b.aviones.push({
      id: 'x',
      matricula: 'XA-OLD',
      porcentaje: 10,
      vigente: false,
      activa: false,
    });
    const r = armarEstadoCuenta({
      base: b,
      utilidades: [SEP, OCT_CERO],
      pagos: [entrega({ fecha_pago: '2026-08-20', monto_usd: 50, monto: 50 })],
      desde: '2026-09',
      hasta: '2026-10',
    });
    expect(r.avisos).toEqual([
      'Hay 1 entrega(s) con fecha anterior al arranque de la cuenta (septiembre 2026): sí descuentan del saldo. Revisa que el saldo inicial no las incluya ya.',
      'El avión XA-OLD está dado de baja: el reparto ya no calcula su utilidad, así que no suma a esta cuenta.',
    ]);
    // La entrega previa al arranque cae en el saldo anterior.
    expect(r.saldo_anterior_usd).toBe(-50);
    expect(r.movimientos[0]).toMatchObject({
      tipo: 'SALDO_ANTERIOR',
      saldo_usd: -50,
    });
  });
});

describe('reparto-cuenta.util — socios, resumen y totales', () => {
  it('universo: aeronave_socio (cualquier vigencia) ∪ cuentas ∪ entregas; % vigente hoy; avión dado de baja', () => {
    const socios = armarSociosBase({
      sociosAeronave: [
        {
          aeronave_id: N4142R,
          socio_id: MAURICIO,
          porcentaje: '69.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
        {
          aeronave_id: N990GG,
          socio_id: MAURICIO,
          porcentaje: '50.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: '2026-07-31',
        },
        {
          aeronave_id: N4142R,
          socio_id: SAAB,
          porcentaje: '2.000',
          vigente_desde: '2026-01-01',
          vigente_hasta: null,
        },
      ],
      cuentas: [
        {
          socio_id: AERO,
          cuenta_desde: '2026-08-01',
          saldo_inicial_usd: '-1500.25',
          notas: 'Ya adelantado',
          created_by: ALE,
          created_at: 'x',
          updated_by: ALE,
          updated_at: '2026-10-01T15:00:00Z',
        },
      ],
      sociosConEntregas: [MAURICIO],
      usuarios: new Map([
        [
          MAURICIO,
          {
            id: MAURICIO,
            nombre: 'Mauricio Roque',
            rol: 'SOCIO',
            estado: 'ACTIVO',
          },
        ],
        [
          SAAB,
          {
            id: SAAB,
            nombre: 'Alexander E. Saab',
            rol: 'PILOTO',
            estado: 'ACTIVO',
          },
        ],
      ]),
      aeronaves: new Map([
        [N4142R, { id: N4142R, matricula: 'N4142R', activa: true }],
        [N990GG, { id: N990GG, matricula: 'N990GG', activa: false }],
      ]),
      hoy: '2026-10-01',
    });
    expect(socios.map((s) => s.socio.nombre)).toEqual([
      'Alexander E. Saab',
      'Mauricio Roque',
      // Sin fila de usuario: el mismo respaldo que compute.
      'Socio',
    ]);
    const mauricio = socios[1];
    expect(mauricio.aviones).toEqual([
      {
        id: N4142R,
        matricula: 'N4142R',
        porcentaje: 69,
        vigente: true,
        activa: true,
      },
      {
        id: N990GG,
        matricula: 'N990GG',
        porcentaje: 50,
        vigente: false,
        activa: false,
      },
    ]);
    expect(mauricio.cuenta).toEqual(cuentaDefault());
    expect(mauricio.en_aeronave_socio).toBe(true);
    expect(socios[2]).toMatchObject({
      en_aeronave_socio: false,
      cuenta: {
        cuenta_desde: '2026-08',
        saldo_inicial_usd: -1500.25,
        configurada: true,
      },
    });
  });

  it('la propia empresa como socio viaja MARCADA (usuario.es_empresa)', () => {
    const socios = armarSociosBase({
      sociosAeronave: [AERO, SAAB].map((socio_id) => ({
        aeronave_id: N4142R,
        socio_id,
        porcentaje: '10.000',
        vigente_desde: '2026-01-01',
        vigente_hasta: null,
      })),
      cuentas: [],
      sociosConEntregas: [],
      usuarios: new Map([
        [
          AERO,
          {
            id: AERO,
            nombre: 'Aero Charter Cancun S.A. de C.V.',
            rol: 'SOCIO',
            estado: 'INACTIVO',
            es_empresa: true,
          },
        ],
        [
          SAAB,
          {
            id: SAAB,
            nombre: 'Alexander E. Saab',
            rol: 'PILOTO',
            estado: 'ACTIVO',
          },
        ],
      ]),
      aeronaves: new Map([
        [N4142R, { id: N4142R, matricula: 'N4142R', activa: true }],
      ]),
      hoy: '2026-10-01',
    });
    expect(socios.map((s) => [s.socio.nombre, s.socio.es_empresa])).toEqual([
      ['Aero Charter Cancun S.A. de C.V.', true],
      ['Alexander E. Saab', false],
    ]);
  });

  it('cuenta default: septiembre 2026 con saldo 0 y configurada:false (banner del panel)', () => {
    expect(cuentaDefault()).toEqual({
      cuenta_desde: CUENTA_DESDE_DEFAULT,
      saldo_inicial_usd: 0,
      notas: null,
      configurada: false,
      updated_at: null,
    });
    expect(CUENTA_DESDE_DEFAULT).toBe('2026-09');
    expect(aCuentaSocio(null)).toEqual(cuentaDefault());
    expect(TEXTO_CUENTA_NO_CONFIGURADA).toBe(
      'La cuenta de este socio arranca en septiembre 2026 con saldo 0. Si hubo repartos anteriores, configura el mes de arranque y el saldo inicial.',
    );
  });

  it('renglón del resumen y totales: un adelanto NO compensa lo que se le debe a otro', () => {
    const fm = filaCuentaSocio({
      base: base(),
      utilidades: [SEP, OCT_CERO],
      pagos: [adelanto70k()],
    });
    expect(fm).toMatchObject({
      generado_usd: 1395.94,
      mes_en_curso_usd: 0,
      entregado_usd: 3783.78,
      por_entregar_usd: -2387.84,
      estado: 'ADELANTADO',
      ultimo_pago: {
        moneda: 'MXN',
        monto: 70000,
        monto_usd: 3783.78,
        metodo: 'EFECTIVO',
      },
    });
    const fa = filaCuentaSocio({
      base: {
        ...base(),
        socio: {
          id: AERO,
          nombre: 'Aero',
          rol: null,
          estado: null,
          es_empresa: true,
        },
      },
      utilidades: [SEP, OCT_CERO],
      pagos: [],
    });
    expect(fa).toMatchObject({
      por_entregar_usd: 586.7,
      estado: 'POR_ENTREGAR',
      ultimo_pago: null,
    });
    expect(totalesCuentas([fm, fa])).toEqual({
      generado_usd: 1982.64,
      entregado_usd: 3783.78,
      por_entregar_usd: 586.7,
      adelantado_usd: 2387.84,
      socios_por_entregar: 1,
      socios_adelantados: 1,
    });
  });
});

describe('reparto-cuenta.util — pre-cierre', () => {
  it('por entregar (mayor primero) y adelantados; textos', () => {
    const r = resumenPrecierreCuentas({
      mes: '2026-09',
      filas: [
        {
          socio: { id: SAAB, nombre: 'Alexander E. Saab' },
          por_entregar_hasta_mes_usd: 40.46,
          por_entregar_cerrado_usd: 40.46,
        },
        {
          socio: {
            id: AERO,
            nombre: 'Aero Charter Cancun S.A. de C.V.',
            es_empresa: true,
          },
          por_entregar_hasta_mes_usd: 586.7,
          por_entregar_cerrado_usd: 586.7,
        },
        {
          socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
          por_entregar_hasta_mes_usd: -2387.84,
          por_entregar_cerrado_usd: -2387.84,
        },
      ],
      sin_cuenta_en_mes: 0,
    });
    expect(r.por_entregar).toEqual({
      count: 2,
      monto_usd: 627.16,
      socios: [
        {
          // La propia empresa como socio: viaja MARCADA (decisión pendiente
          // de la oficina: excluirla o registrar el movimiento).
          socio: {
            id: AERO,
            nombre: 'Aero Charter Cancun S.A. de C.V.',
            es_empresa: true,
          },
          por_entregar_usd: 586.7,
        },
        {
          socio: {
            id: SAAB,
            nombre: 'Alexander E. Saab',
            es_empresa: false,
          },
          por_entregar_usd: 40.46,
        },
      ],
      detalle:
        '2 socio(s) con utilidad por entregar hasta septiembre 2026 por $627.16 USD: Aero Charter Cancun S.A. de C.V. $586.70 USD, Alexander E. Saab $40.46 USD. Regístralo en Tesorería → «Pagos a socios».',
    });
    expect(r.adelantados).toMatchObject({
      count: 1,
      monto_usd: 2387.84,
      socios: [
        {
          socio: { id: MAURICIO, nombre: 'Mauricio Roque' },
          por_entregar_usd: -2387.84,
          adelantado_usd: 2387.84,
        },
      ],
    });
    expect(r.adelantados.detalle).toContain('Mauricio Roque $2,387.84 USD');
    expect([
      CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR,
      CLAVE_PRECIERRE_SOCIOS_ADELANTADOS,
    ]).toEqual(['socios_por_entregar', 'socios_adelantados']);
  });

  it('nada pendiente; cuentas que arrancan después; tope de la lista', () => {
    expect(
      resumenPrecierreCuentas({
        mes: '2026-09',
        filas: [],
        sin_cuenta_en_mes: 0,
      }).por_entregar.detalle,
    ).toBe(
      'Todos los socios están al corriente con la utilidad generada hasta septiembre 2026.',
    );
    expect(
      resumenPrecierreCuentas({
        mes: '2026-08',
        filas: [],
        sin_cuenta_en_mes: 3,
      }).por_entregar.detalle,
    ).toBe(
      'Las cuentas de los socios arrancan después de agosto 2026: no hay nada que revisar en este mes.',
    );
    const muchos = Array.from({ length: PRECIERRE_SOCIOS_MAX + 5 }, (_, i) => ({
      socio: { id: `s-${String(i).padStart(3, '0')}`, nombre: `Socio ${i}` },
      por_entregar_hasta_mes_usd: 10 + i,
      por_entregar_cerrado_usd: 10 + i,
    }));
    const r = resumenPrecierreCuentas({
      mes: '2026-09',
      filas: muchos,
      sin_cuenta_en_mes: 0,
    });
    expect(r.por_entregar.count).toBe(PRECIERRE_SOCIOS_MAX + 5);
    expect(r.por_entregar.socios).toHaveLength(PRECIERRE_SOCIOS_MAX);
    expect(r.por_entregar.detalle).toContain(`y ${PRECIERRE_SOCIOS_MAX} más`);
  });
});

describe('reparto-cuenta.util — utilidades de varios meses (paridad con UtilidadMesSocios)', () => {
  it('el renglón de un mes sin el socio no suma nada', () => {
    const vacio: UtilidadMesSocios = {
      mes: '2026-09',
      en_curso: false,
      aviones: [],
    };
    const movs = movimientosDeCuenta({
      socioId: MAURICIO,
      cuenta: cuentaDefault(),
      utilidades: [vacio],
      pagos: [],
    });
    expect(totalesDeMovimientos(movs).por_entregar_usd).toBe(0);
  });
});
