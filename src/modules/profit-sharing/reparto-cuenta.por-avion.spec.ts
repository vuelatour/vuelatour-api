import {
  ambitoDeEntrega,
  armarEstadoCuenta,
  cuentaDefault,
  cuentaSeLlevaPorAvion,
  filaCuentaSocio,
  mensajeExcedeSaldo,
  movimientosDeCuenta,
  saldosPorAvion,
  seccionesPorAvion,
  totalesDeMovimientos,
  utilidadMesDesdeAviones,
  type AvionDeSocio,
  type CuentaSocio,
  type RepartoAvionInput,
  type SocioBase,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import {
  aPagoSocio,
  type PagoSocio,
  type RepartoPagoRow,
} from './reparto-pago.util';

/**
 * SALDO POR AVIÓN DENTRO DE LA CUENTA DEL SOCIO (10-nov-2026, API 0.0.134,
 * invariante 129). Reclamo del cliente con la captura de la cuenta de
 * Mauricio Roque (N4142R 69 % y XB-ANU 70 %): «está mezclado todos los
 * aviones que tenga un socio en su cuenta; debería ser un balance para cada
 * avión, porque las entregas son por avión… lo mete todo en la misma
 * licuadora». Los números de este spec son los de ESA captura.
 */
const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const XBANU = 'aaaaaaaa-0000-4000-8000-0000000000a0';
const N990GG = 'aaaaaaaa-0000-4000-8000-000000000990';
const MAURICIO = 'bbbbbbbb-0000-4000-8000-000000000069';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';

const MATRICULAS = new Map([
  [N4142R, 'N4142R'],
  [XBANU, 'XB-ANU'],
  [N990GG, 'N990GG'],
]);

function avion(
  id: string,
  matricula: string,
  porcentaje: number,
  montoMxn: number,
): RepartoAvionInput {
  return {
    aeronave: { id, matricula, modelo: '' },
    reparto: [
      {
        socio_id: MAURICIO,
        socio_nombre: 'Mauricio Roque',
        porcentaje,
        monto_mxn: montoMxn,
      },
    ],
  };
}

/** Las utilidades de la captura (hoy = 10-nov-2026: noviembre en curso). */
const UTILIDADES: UtilidadMesSocios[] = [
  utilidadMesDesdeAviones(
    '2026-09',
    [avion(N4142R, 'N4142R', 69, 232547.75)],
    false,
  ),
  utilidadMesDesdeAviones(
    '2026-10',
    [
      avion(N4142R, 'N4142R', 69, 109127.8),
      avion(XBANU, 'XB-ANU', 70, -3862.6),
    ],
    false,
  ),
  utilidadMesDesdeAviones(
    '2026-11',
    [avion(N4142R, 'N4142R', 69, 19002.73)],
    true,
  ),
];

let seq = 0;
function entrega(p: Partial<RepartoPagoRow>): PagoSocio {
  seq += 1;
  const monto = Number(p.monto ?? 1000);
  const row: RepartoPagoRow = {
    id: `dddddddd-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    aeronave_id: null,
    socio_id: MAURICIO,
    periodo: null,
    monto,
    moneda: 'MXN',
    tc_usd_mxn: 18.5,
    monto_usd: Math.round((monto / 18.5) * 100) / 100,
    monto_mxn: monto,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
    saldo_snapshot_mxn: null,
    fecha_pago: '2026-10-20',
    metodo: 'TRANSFERENCIA',
    referencia: null,
    entregado_por: ALE,
    recibido_por: null,
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ALE,
    created_at: `2026-10-20T15:00:${String(seq % 60).padStart(2, '0')}.000000+00:00`,
    updated_at: '2026-10-20T15:00:00+00:00',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...p,
  };
  return aPagoSocio(row, new Map(), new Map(), MATRICULAS);
}

/** Las dos entregas de la captura, las dos «corresponde a» N4142R. */
const ENTREGA_SEP = entrega({
  monto: 238265.53,
  fecha_pago: '2026-10-20',
  aeronave_id: N4142R,
  periodo: '2026-09-01',
});
const ENTREGA_OCT = entrega({
  monto: 103614.04,
  fecha_pago: '2026-11-10',
  aeronave_id: N4142R,
  periodo: '2026-10-01',
});

const AVIONES: AvionDeSocio[] = [
  {
    id: N4142R,
    matricula: 'N4142R',
    porcentaje: 69,
    vigente: true,
    activa: true,
  },
  {
    id: XBANU,
    matricula: 'XB-ANU',
    porcentaje: 70,
    vigente: true,
    activa: true,
  },
];

function base(
  cuenta: CuentaSocio = cuentaDefault(),
  aviones: AvionDeSocio[] = AVIONES,
): SocioBase {
  return {
    socio: {
      id: MAURICIO,
      nombre: 'Mauricio Roque',
      rol: 'SOCIO',
      estado: 'ACTIVO',
      es_empresa: false,
    },
    cuenta,
    aviones,
    en_aeronave_socio: true,
  };
}

function movimientos(
  pagos: PagoSocio[],
  cuenta: CuentaSocio = cuentaDefault(),
  utilidades: UtilidadMesSocios[] = UTILIDADES,
) {
  return movimientosDeCuenta({ socioId: MAURICIO, cuenta, utilidades, pagos });
}

describe('seccionesPorAvion — el caso de la captura (Mauricio Roque, 10-nov-2026)', () => {
  const pagos = [ENTREGA_SEP, ENTREGA_OCT];
  const todos = movimientos(pagos);
  const secciones = seccionesPorAvion({ movimientos: todos, aviones: AVIONES });

  it('la cuenta mezclada da exactamente lo que se veía en pantalla: saldo corrido −$4,066.62 tras la entrega del 10-nov y $14,936.11 al final', () => {
    expect(todos.map((m) => m.saldo_mxn)).toEqual([
      0, // arranque
      232547.75, // utilidad sep N4142R
      -5717.78, // entrega 20-oct
      103410.02, // utilidad oct N4142R
      99547.42, // utilidad oct XB-ANU (pérdida)
      -4066.62, // entrega 10-nov: «piensa que la entrega corresponde al ANU»
      14936.11, // noviembre en curso
    ]);
  });

  it('una sección por avión, cada una con SU saldo corrido; sin sección general (saldo inicial $0 y ninguna entrega sin avión)', () => {
    expect(secciones.map((s) => s.aeronave?.matricula ?? null)).toEqual([
      'N4142R',
      'XB-ANU',
    ]);
    const n = secciones[0];
    expect(n.movimientos.map((m) => [m.tipo, m.saldo_mxn])).toEqual([
      ['UTILIDAD', 232547.75],
      ['ENTREGA', -5717.78],
      ['UTILIDAD', 103410.02],
      // La pérdida del XB-ANU ya NO entra aquí: −$204.02, no −$4,066.62.
      ['ENTREGA', -204.02],
      ['UTILIDAD', 18798.71],
    ]);
    expect(n).toMatchObject({
      porcentaje: 69,
      generado_mxn: 360678.28,
      mes_en_curso_mxn: 19002.73,
      entregado_mxn: 341879.57,
      por_entregar_mxn: 18798.71,
      por_entregar_cerrado_mxn: -204.02,
      estado: 'POR_ENTREGAR',
    });
    const anu = secciones[1];
    expect(anu.movimientos.map((m) => [m.tipo, m.saldo_mxn])).toEqual([
      ['UTILIDAD', -3862.6],
    ]);
    expect(anu).toMatchObject({
      porcentaje: 70,
      generado_mxn: -3862.6,
      mes_en_curso_mxn: 0,
      entregado_mxn: 0,
      por_entregar_mxn: -3862.6,
      por_entregar_cerrado_mxn: -3862.6,
    });
  });

  it('Σ de las secciones == la cuenta completa, al centavo (los totales del socio no cambian)', () => {
    const t = totalesDeMovimientos(todos);
    const suma = (
      k:
        | 'generado_mxn'
        | 'mes_en_curso_mxn'
        | 'entregado_mxn'
        | 'por_entregar_mxn'
        | 'por_entregar_cerrado_mxn',
    ) => secciones.reduce((acc, s) => acc + Math.round(s[k] * 100), 0) / 100;
    expect(suma('generado_mxn')).toBe(t.generado_mxn);
    expect(suma('mes_en_curso_mxn')).toBe(t.mes_en_curso_mxn);
    expect(suma('entregado_mxn')).toBe(t.entregado_mxn);
    expect(suma('por_entregar_mxn')).toBe(t.por_entregar_mxn);
    expect(suma('por_entregar_cerrado_mxn')).toBe(t.por_entregar_cerrado_mxn);
    expect(t).toMatchObject({
      generado_mxn: 356815.68,
      entregado_mxn: 341879.57,
      por_entregar_mxn: 14936.11,
    });
  });

  it('el resumen (`filaCuentaSocio`) trae `por_avion` sin movimientos y `cuenta_por_avion`', () => {
    const f = filaCuentaSocio({ base: base(), utilidades: UTILIDADES, pagos });
    expect(f.cuenta_por_avion).toBe(true);
    expect(f.por_avion).toEqual(saldosPorAvion(secciones));
    expect(f.por_avion[0]).not.toHaveProperty('movimientos');
    // Lo de siempre no se movió.
    expect(f).toMatchObject({
      generado_mxn: 356815.68,
      entregado_mxn: 341879.57,
      por_entregar_mxn: 14936.11,
    });
  });

  it('el estado de cuenta con filtro de meses: cada avión colapsa lo anterior en SU saldo anterior', () => {
    const r = armarEstadoCuenta({
      base: base(),
      utilidades: UTILIDADES,
      pagos,
      desde: '2026-11',
      hasta: '2026-11',
    });
    expect(r.cuenta_por_avion).toBe(true);
    const [n, anu] = r.por_avion;
    expect(n.saldo_anterior_mxn).toBe(103410.02);
    expect(n.movimientos.map((m) => [m.tipo, m.saldo_mxn])).toEqual([
      ['SALDO_ANTERIOR', 103410.02],
      ['ENTREGA', -204.02],
      ['UTILIDAD', 18798.71],
    ]);
    expect(n.movimientos[0]).toMatchObject({
      concepto: 'Saldo al cierre de oct 2026',
      aeronave: { id: N4142R, matricula: 'N4142R' },
    });
    expect(n.rango).toEqual({
      generado_mxn: 19002.73,
      entregado_mxn: 103614.04,
      saldo_final_mxn: 18798.71,
    });
    // Los totales de la sección son los de TODA la cuenta, no los del rango.
    expect(n.por_entregar_mxn).toBe(18798.71);
    expect(anu.saldo_anterior_mxn).toBe(-3862.6);
    expect(anu.movimientos.map((m) => m.tipo)).toEqual(['SALDO_ANTERIOR']);
    expect(anu.rango.saldo_final_mxn).toBe(-3862.6);
    // La lista mezclada de siempre sigue viajando igual.
    expect(r.movimientos[0]).toMatchObject({
      tipo: 'SALDO_ANTERIOR',
      saldo_mxn: 99547.42,
    });
  });
});

describe('seccionesPorAvion — «a cuenta general» y cuentas de un solo avión', () => {
  it('el saldo inicial y las entregas SIN avión viven en la sección general (al final); Σ sigue cuadrando', () => {
    const cuenta: CuentaSocio = {
      ...cuentaDefault(),
      saldo_inicial_mxn: -10000,
      configurada: true,
    };
    const pagos = [
      ENTREGA_SEP,
      entrega({ monto: 5000, fecha_pago: '2026-10-25' }), // sin avión
    ];
    const todos = movimientos(pagos, cuenta);
    const s = seccionesPorAvion({ movimientos: todos, aviones: AVIONES });
    expect(s.map((x) => x.aeronave?.matricula ?? null)).toEqual([
      'N4142R',
      'XB-ANU',
      null,
    ]);
    const general = s[2];
    expect(general.movimientos.map((m) => [m.tipo, m.saldo_mxn])).toEqual([
      ['SALDO_INICIAL', -10000],
      ['ENTREGA', -15000],
    ]);
    expect(general).toMatchObject({
      porcentaje: null,
      generado_mxn: 0,
      entregado_mxn: 5000,
      por_entregar_mxn: -15000,
      por_entregar_cerrado_mxn: -15000,
      estado: 'ADELANTADO',
    });
    const total =
      s.reduce((acc, x) => acc + Math.round(x.por_entregar_mxn * 100), 0) / 100;
    expect(total).toBe(totalesDeMovimientos(todos).por_entregar_mxn);
  });

  it('cuenta de UN avión: una sola sección con el saldo de siempre y `cuenta_por_avion` false', () => {
    const unAvion = [AVIONES[0]];
    const utilidades = [UTILIDADES[0]];
    const todos = movimientos([ENTREGA_SEP], cuentaDefault(), utilidades);
    const s = seccionesPorAvion({ movimientos: todos, aviones: unAvion });
    expect(s).toHaveLength(1);
    expect(s[0].por_entregar_mxn).toBe(
      totalesDeMovimientos(todos).por_entregar_mxn,
    );
    expect(cuentaSeLlevaPorAvion(s)).toBe(false);
  });

  it('un avión en el que el socio YA NO está y sin movimientos no hace sección; con movimientos sí', () => {
    const aviones: AvionDeSocio[] = [
      AVIONES[0],
      {
        id: N990GG,
        matricula: 'N990GG',
        porcentaje: 50,
        vigente: false,
        activa: true,
      },
    ];
    const utilidades = [UTILIDADES[0]];
    const sin = seccionesPorAvion({
      movimientos: movimientos([ENTREGA_SEP], cuentaDefault(), utilidades),
      aviones,
    });
    expect(sin.map((x) => x.aeronave?.matricula)).toEqual(['N4142R']);
    expect(cuentaSeLlevaPorAvion(sin)).toBe(false);
    const con = seccionesPorAvion({
      movimientos: movimientos(
        [ENTREGA_SEP, entrega({ monto: 10, aeronave_id: N990GG })],
        cuentaDefault(),
        utilidades,
      ),
      aviones,
    });
    expect(con.map((x) => x.aeronave?.matricula)).toEqual(['N4142R', 'N990GG']);
    expect(cuentaSeLlevaPorAvion(con)).toBe(true);
  });

  it('un avión vigente sin movimientos aparece en ceros (el socio lo ve en su cuenta)', () => {
    const s = seccionesPorAvion({
      movimientos: movimientos([], cuentaDefault(), [UTILIDADES[0]]),
      aviones: AVIONES,
    });
    expect(s.map((x) => [x.aeronave?.matricula, x.por_entregar_mxn])).toEqual([
      ['N4142R', 232547.75],
      ['XB-ANU', 0],
    ]);
    expect(s[1]).toMatchObject({ movimientos: [], estado: 'AL_CORRIENTE' });
  });
});

describe('ambitoDeEntrega — contra qué se mide una entrega', () => {
  /** La cuenta ANTES de la entrega del 10-nov (solo la de septiembre). */
  const fila = filaCuentaSocio({
    base: base(),
    utilidades: UTILIDADES,
    pagos: [ENTREGA_SEP],
  });

  it('cuenta con dos aviones: la entrega del N4142R se mide contra el saldo del N4142R ($103,410.02), sin la pérdida del XB-ANU', () => {
    // Toda la cuenta (meses cerrados): 99,547.42 — lo que medía antes.
    expect(fila.por_entregar_cerrado_mxn).toBe(99547.42);
    expect(ambitoDeEntrega({ fila, aeronaveId: N4142R })).toEqual({
      aeronave: { id: N4142R, matricula: 'N4142R' },
      por_entregar_cerrado_mxn: 103410.02,
      mes_en_curso_mxn: 19002.73,
      entregado_mxn: 238265.53,
      adelantado_general_mxn: 0,
    });
    expect(ambitoDeEntrega({ fila, aeronaveId: XBANU })).toMatchObject({
      aeronave: { id: XBANU, matricula: 'XB-ANU' },
      por_entregar_cerrado_mxn: -3862.6,
      entregado_mxn: 0,
    });
  });

  it('sin avión: toda la cuenta, como siempre', () => {
    expect(ambitoDeEntrega({ fila, aeronaveId: null })).toEqual({
      aeronave: null,
      por_entregar_cerrado_mxn: 99547.42,
      mes_en_curso_mxn: 19002.73,
      entregado_mxn: 238265.53,
      adelantado_general_mxn: 0,
    });
  });

  it('cuenta de UN avión: toda la cuenta aunque la entrega traiga el avión (el saldo inicial a favor sigue contando)', () => {
    const una = filaCuentaSocio({
      base: base(
        { ...cuentaDefault(), saldo_inicial_mxn: 5000, configurada: true },
        [AVIONES[0]],
      ),
      utilidades: [UTILIDADES[0]],
      pagos: [],
    });
    expect(una.cuenta_por_avion).toBe(false);
    expect(ambitoDeEntrega({ fila: una, aeronaveId: N4142R })).toMatchObject({
      aeronave: null,
      por_entregar_cerrado_mxn: 237547.75,
    });
  });

  it('lo ya adelantado «a cuenta general» SÍ se descuenta del avión; un saldo general a favor NO se le suma', () => {
    const adelantada = filaCuentaSocio({
      base: base(),
      utilidades: UTILIDADES,
      pagos: [ENTREGA_SEP, entrega({ monto: 3000, fecha_pago: '2026-10-25' })],
    });
    expect(
      ambitoDeEntrega({ fila: adelantada, aeronaveId: N4142R }),
    ).toMatchObject({
      por_entregar_cerrado_mxn: 100410.02,
      adelantado_general_mxn: 3000,
    });
    const aFavor = filaCuentaSocio({
      base: base({
        ...cuentaDefault(),
        saldo_inicial_mxn: 8000,
        configurada: true,
      }),
      utilidades: UTILIDADES,
      pagos: [ENTREGA_SEP],
    });
    expect(ambitoDeEntrega({ fila: aFavor, aeronaveId: N4142R })).toMatchObject(
      {
        por_entregar_cerrado_mxn: 103410.02,
        adelantado_general_mxn: 0,
      },
    );
  });

  it('corrección (`sinEntrega`): el ámbito como si la entrega no existiera, viva en ese avión, en otro o en la general', () => {
    const conOct = filaCuentaSocio({
      base: base(),
      utilidades: UTILIDADES,
      pagos: [ENTREGA_SEP, ENTREGA_OCT],
    });
    // Vive en el N4142R y se queda ahí: su saldo sin ella.
    expect(
      ambitoDeEntrega({
        fila: conOct,
        aeronaveId: N4142R,
        sinEntrega: { aeronave_id: N4142R, monto_mxn: 103614.04 },
      }),
    ).toMatchObject({
      por_entregar_cerrado_mxn: 103410.02,
      entregado_mxn: 238265.53,
    });
    // Vive en el N4142R y se pasa al XB-ANU: el saldo del ANU no la traía.
    expect(
      ambitoDeEntrega({
        fila: conOct,
        aeronaveId: XBANU,
        sinEntrega: { aeronave_id: N4142R, monto_mxn: 103614.04 },
      }),
    ).toMatchObject({ por_entregar_cerrado_mxn: -3862.6 });
    // Vive en la general (sin avión) y se le asigna el N4142R: deja de
    // contar como adelanto general.
    const general = filaCuentaSocio({
      base: base(),
      utilidades: UTILIDADES,
      pagos: [ENTREGA_SEP, entrega({ monto: 3000, fecha_pago: '2026-10-25' })],
    });
    expect(
      ambitoDeEntrega({
        fila: general,
        aeronaveId: N4142R,
        sinEntrega: { aeronave_id: null, monto_mxn: 3000 },
      }),
    ).toMatchObject({
      por_entregar_cerrado_mxn: 103410.02,
      adelantado_general_mxn: 0,
    });
    // Sin avión: toda la cuenta sin la entrega (lo de siempre).
    expect(
      ambitoDeEntrega({
        fila: conOct,
        aeronaveId: null,
        sinEntrega: { aeronave_id: N4142R, monto_mxn: 103614.04 },
      }),
    ).toMatchObject({ aeronave: null, por_entregar_cerrado_mxn: 99547.42 });
  });
});

describe('mensajeExcedeSaldo — con el avión', () => {
  it('nombra el avión contra el que se midió; sin avión, el texto de siempre', () => {
    expect(
      mensajeExcedeSaldo({
        monto_mxn: 103614.04,
        por_entregar_mxn: 103410.02,
        exceso_mxn: 204.02,
        mes_en_curso_mxn: 19002.73,
        matricula: 'N4142R',
      }),
    ).toBe(
      'Esta entrega de $103,614.04 MXN supera lo que hay por entregar de N4142R ($103,410.02 MXN, sin contar el mes en curso: $19,002.73 MXN). Se registrará como ADELANTO y el saldo de N4142R quedará a favor de VuelaTour por $204.02 MXN. ¿Registrar?',
    );
    expect(
      mensajeExcedeSaldo({
        monto_mxn: 70000,
        por_entregar_mxn: 1395.94,
        exceso_mxn: 68604.06,
      }),
    ).toBe(
      'Esta entrega de $70,000 MXN supera lo que hay por entregar ($1,395.94 MXN). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por $68,604.06 MXN. ¿Registrar?',
    );
  });
});
