import {
  alVincularAbono,
  cambiaDineroDelCobro,
  coberturaCobro,
  cobroCubiertoEnBanco,
  cobroDeUnSoloAbono,
  cubreCobro,
  estadoBancoCobro,
  faltanteFueraDe,
  netoDeCobro,
  ordenarPartesPorAntiguedad,
  tcImplicitoCobro,
  TOLERANCIA_COBRO_BANCO,
  type ParteCobroBanco,
} from './cobro-banco.util';

/**
 * UN COBRO, VARIOS ABONOS (14-oct-2026, API 0.0.78, invariante 77): el
 * espejo TS de `neto_de_cobro`, `regla_cobro_cubierto`, `v_cobro_conciliacion`
 * y del trigger A, con los casos REALES del pedido: las camionetas de Beh Kay
 * (#315: un cobro de $3,400 pagado con dos SPEI de $1,700 y el SPEI de
 * $69,183.00 = #315 $68,205.55 + #332 $977.45), el lote de Villanueva
 * ($69,000 = 18,001 que faltaba + 50,999), el link HSBC con comisión, Paywise
 * (#293 neto 11,870.24) y el cobro en dólares contra una cuenta en pesos.
 */

const TOL_TC = 2; // = TOLERANCIA_TC_OFICIAL_PCT de conciliacion/auto-cruce.util

let seq = 0;
/** Una parte de abono (MXN, banco) con lo que haga falta cambiar. */
function parte(
  monto: number,
  extra: Partial<ParteCobroBanco> = {},
): ParteCobroBanco {
  seq += 1;
  return {
    movimiento_id: `m-${String(seq).padStart(4, '0')}`,
    cobro_id: 'c-1',
    monto_parte: monto,
    moneda_cuenta: 'MXN',
    pasarela: false,
    fecha: '2026-09-15',
    created_at: '2026-09-15T17:00:00.000000+00:00',
    monto_abono: monto,
    cobros_n: 1,
    cuenta_bancaria_id: 'cta-eje',
    cuenta_alias: 'EJE SCOTIA',
    ...extra,
  };
}

const cobroMxn = (monto: number, extra: Record<string, unknown> = {}) => ({
  monto,
  moneda: 'MXN',
  comision_banco_monto: null,
  ...extra,
});

const abonoBanco = (monto: number) => ({
  monto,
  moneda_cuenta: 'MXN',
  pasarela: false,
});
const abonoPasarela = (monto: number) => ({
  monto,
  moneda_cuenta: 'MXN',
  pasarela: true,
});

describe('cobro-banco.util — neto y regla de «cubierto» (espejo de la BD)', () => {
  it('netoDeCobro = neto_de_cobro: monto − comisión > 0; si no da positivo, el monto', () => {
    expect(netoDeCobro(5000, 250)).toBe(4750);
    expect(netoDeCobro(5000, null)).toBe(5000);
    expect(netoDeCobro(100, 150)).toBe(100);
    expect(netoDeCobro(11870.24, 0)).toBe(11870.24);
    expect(netoDeCobro(1000.004, 0)).toBe(1000);
    // #293 (Paywise): $12,495.00 con comisión $624.76.
    expect(netoDeCobro('12495.00', '624.76')).toBe(11870.24);
  });

  it('cubreCobro = regla_cobro_cubierto (CASE ordenado, tolerancia $1.00)', () => {
    expect(TOLERANCIA_COBRO_BANCO).toBe(1);
    expect(cubreCobro(3400, 1, false, 1700)).toBe(false);
    expect(cubreCobro(3400, 2, false, 3399)).toBe(true);
    expect(cubreCobro(3400, 2, false, 3398.99)).toBe(false);
    expect(cubreCobro(1000, 1, true, 0)).toBe(true);
    expect(cubreCobro(1000, 0, false, 0)).toBe(false);
    expect(cubreCobro(0, 1, false, 0)).toBe(true);
    // #358 (Paywise): neto 38,950.01 con un abono de 38,950.00.
    expect(cubreCobro(38950.01, 1, false, 38950)).toBe(true);
  });
});

describe('coberturaCobro — una fila de v_cobro_conciliacion', () => {
  it('cobro de $3,400 con UN SPEI de $1,700: parcial, faltan $1,700', () => {
    const c = coberturaCobro(cobroMxn(3400), [parte(1700)]);
    expect(c).toMatchObject({
      neto: 3400,
      n_partes: 1,
      cruzado: false,
      pasarela: false,
      suma: 1700,
      monto_vinculado: 1700,
      faltante: 1700,
      sobrante: 0,
      cubierto: false,
    });
  });

  it('con los DOS SPEI de $1,700: cubierto y los abonos por antigüedad (fecha, alta, id)', () => {
    const tarde = parte(1700, {
      movimiento_id: 'm-b',
      fecha: '2026-09-16',
    });
    const temprano = parte(1700, {
      movimiento_id: 'm-c',
      fecha: '2026-09-15',
      created_at: '2026-10-06T15:22:46.58996+00:00',
    });
    const mismoDiaAntes = parte(0.01, {
      movimiento_id: 'm-z',
      fecha: '2026-09-15',
      created_at: '2026-10-06T15:22:46.589+00:00',
    });
    const c = coberturaCobro(cobroMxn(3400), [tarde, temprano]);
    expect(c).toMatchObject({ cubierto: true, faltante: 0, suma: 3400 });
    expect(c.movimiento_ids).toEqual(['m-c', 'm-b']);
    // Mismo día: manda el alta (con microsegundos), luego el id.
    expect(
      ordenarPartesPorAntiguedad([temprano, mismoDiaAntes]).map(
        (p) => p.movimiento_id,
      ),
    ).toEqual(['m-z', 'm-c']);
  });

  it('#315: su parte de $68,205.55 dentro del lote de $69,183.00 lo cubre', () => {
    const c = coberturaCobro(cobroMxn(68205.55), [
      parte(68205.55, { monto_abono: 69183, cobros_n: 2 }),
    ]);
    expect(c).toMatchObject({ cubierto: true, faltante: 0, sobrante: 0 });
  });

  it('cobro MXN con un abono de cuenta USD: cruzado ⇒ cubierto, vinculado = neto, sin faltante ni sobrante', () => {
    const c = coberturaCobro(cobroMxn(17500), [
      parte(1000, { moneda_cuenta: 'USD' }),
    ]);
    expect(c).toMatchObject({
      cruzado: true,
      cubierto: true,
      suma: 0,
      monto_vinculado: 17500,
      faltante: 0,
      sobrante: 0,
    });
    // Cuenta sin moneda legible = OTRA moneda (el `is distinct from` de la vista).
    expect(
      coberturaCobro(cobroMxn(500), [parte(500, { moneda_cuenta: null })]),
    ).toMatchObject({ cruzado: true, cubierto: true });
  });

  it('liga vieja con sobrante (abono de $55,053 contra un cobro de $27,526.50) ⇒ sobrante $27,526.50', () => {
    const c = coberturaCobro(cobroMxn(27526.5), [parte(55053)]);
    expect(c).toMatchObject({
      cubierto: true,
      faltante: 0,
      sobrante: 27526.5,
    });
  });

  it('sin abonos: no cubierto, faltante = neto; reembolso (neto ≤ 0) sin faltante', () => {
    expect(coberturaCobro(cobroMxn(3400), [])).toMatchObject({
      n_partes: 0,
      cubierto: false,
      faltante: 3400,
      sobrante: 0,
      movimiento_ids: [],
    });
    expect(coberturaCobro(cobroMxn(-500), [])).toMatchObject({
      neto: -500,
      faltante: 0,
    });
  });

  it('Paywise: una parte de la PASARELA marca `pasarela`', () => {
    expect(
      coberturaCobro(
        { monto: 12495, moneda: 'MXN', comision_banco_monto: 624.76 },
        [parte(11870.24, { pasarela: true })],
      ),
    ).toMatchObject({ pasarela: true, cubierto: true, faltante: 0 });
  });
});

describe('faltanteFueraDe — lo que le falta FUERA de un abono (la v_faltante de G)', () => {
  it('Villanueva: cobro de $30,000 con un abono previo de $11,999 ⇒ faltan $18,001 para el lote de $69,000', () => {
    const previo = parte(11999, { movimiento_id: 'm-previo' });
    const f = faltanteFueraDe(cobroMxn(30000), [previo], 'm-nuevo');
    expect(f).toMatchObject({
      faltante: 18001,
      n_otras: 1,
      suma_otras: 11999,
      cubierto_por_otras: false,
      cruzado_otras: false,
      pasarela_otras: false,
    });
  });

  it('excluye la parte del PROPIO movimiento (re-ligar el mismo abono es idéntico)', () => {
    const propia = parte(18001, { movimiento_id: 'm-lote' });
    const previo = parte(11999, { movimiento_id: 'm-previo' });
    const f = faltanteFueraDe(cobroMxn(30000), [previo, propia], 'm-lote');
    expect(f.faltante).toBe(18001);
    expect(f.otras.map((p) => p.movimiento_id)).toEqual(['m-previo']);
    // Sin otros abonos: el neto.
    expect(faltanteFueraDe(cobroMxn(30000), [propia], 'm-lote')).toMatchObject({
      faltante: 30000,
      n_otras: 0,
    });
  });
});

describe('alVincularAbono — espejo del trigger A para UN cobro', () => {
  const vincular = (
    cobro: Record<string, unknown>,
    otras: ParteCobroBanco[],
    abono: { monto: number; moneda_cuenta: string | null; pasarela: boolean },
    tcVuelo: number | null = null,
  ) =>
    alVincularAbono({ cobro, tcVuelo, otras, abono, toleranciaTcPct: TOL_TC });

  it('camionetas (#315, $3,400): 1.º $1,700 ⇒ PARCIAL; 2.º $1,700 ⇒ CONCILIADO; un 3.º ⇒ YA_CUBIERTO; $2,000 ⇒ EXCEDE', () => {
    expect(vincular(cobroMxn(3400), [], abonoBanco(1700))).toMatchObject({
      estado: 'PARCIAL',
      faltante_antes: 3400,
      faltante_despues: 1700,
      un_solo: false,
    });
    expect(
      vincular(cobroMxn(3400), [parte(1700)], abonoBanco(1700)),
    ).toMatchObject({ estado: 'CONCILIADO', faltante_despues: 0 });
    expect(
      vincular(cobroMxn(3400), [parte(1700), parte(1700)], abonoBanco(100)),
    ).toMatchObject({ estado: 'YA_CUBIERTO', motivo: 'CUBIERTO' });
    expect(
      vincular(cobroMxn(3400), [parte(1700)], abonoBanco(2000)),
    ).toMatchObject({ estado: 'EXCEDE', sobrante: 300, un_solo: false });
  });

  it('#315: el SPEI de $69,183.00 contra el cobro de $68,205.55 solo ⇒ EXCEDE por $977.45', () => {
    expect(vincular(cobroMxn(68205.55), [], abonoBanco(69183))).toMatchObject({
      estado: 'EXCEDE',
      sobrante: 977.45,
      un_solo: false,
    });
  });

  it('link HSBC con comisión ($5,000 − $250): $4,750 ⇒ CONCILIADO; $4,000 ⇒ COMISION_NO_CUADRA; $5,500 ⇒ EXCEDE; 2.º abono ⇒ YA_CUBIERTO', () => {
    const c = cobroMxn(5000, { comision_banco_monto: 250 });
    expect(vincular(c, [], abonoBanco(4750))).toMatchObject({
      estado: 'CONCILIADO',
      un_solo: true,
    });
    expect(vincular(c, [], abonoBanco(4000))).toMatchObject({
      estado: 'COMISION_NO_CUADRA',
      comision_real: 1000,
      motivo: 'COMISION',
    });
    expect(vincular(c, [], abonoBanco(5500))).toMatchObject({
      estado: 'EXCEDE',
      sobrante: 750,
      un_solo: true,
    });
    expect(vincular(c, [parte(4750)], abonoBanco(100))).toMatchObject({
      estado: 'YA_CUBIERTO',
      motivo: 'CUBIERTO',
    });
    // Con un abono que NO lo cubre: «de un solo abono».
    expect(vincular(c, [parte(1000)], abonoBanco(3750))).toMatchObject({
      estado: 'UN_SOLO_ABONO',
      motivo: 'COMISION',
    });
  });

  it('Paywise (abono de la PASARELA): comisión no provisionada ⇒ COMISION_NO_CUADRA por PASARELA; con la comisión real ⇒ CONCILIADO', () => {
    expect(vincular(cobroMxn(7000), [], abonoPasarela(6305))).toMatchObject({
      estado: 'COMISION_NO_CUADRA',
      comision_real: 695,
      motivo: 'PASARELA',
      un_solo: true,
    });
    expect(
      vincular(
        cobroMxn(7000, { comision_banco_monto: 695 }),
        [],
        abonoPasarela(6305),
      ),
    ).toMatchObject({ estado: 'CONCILIADO' });
    // #293: neto 11,870.24 (12,495.00 − 624.76) y el abono de 11,870.24.
    expect(
      vincular(
        cobroMxn(12495, { comision_banco_monto: 624.76 }),
        [],
        abonoPasarela(11870.24),
      ),
    ).toMatchObject({ estado: 'CONCILIADO', faltante_despues: 0 });
    // Un PARCIAL de banco + un abono de la pasarela ⇒ UN_SOLO_ABONO (PASARELA).
    expect(
      vincular(cobroMxn(3400), [parte(1700)], abonoPasarela(1700)),
    ).toMatchObject({ estado: 'UN_SOLO_ABONO', motivo: 'PASARELA' });
    // #358: neto 38,950.01 y el abono de 38,950.00 (dentro de la tolerancia).
    expect(
      vincular(
        cobroMxn(41000.01, { comision_banco_monto: 2050 }),
        [],
        abonoPasarela(38950),
      ),
    ).toMatchObject({ estado: 'CONCILIADO', faltante_despues: 0.01 });
  });

  it('otra moneda: banda 15–25 en BD y ±2 % del T.C. del cobro (o del vuelo) en el API', () => {
    const usd = (extra: Record<string, unknown> = {}) => ({
      monto: 1000,
      moneda: 'USD',
      comision_banco_monto: null,
      ...extra,
    });
    expect(vincular(usd({ tc_usd_mxn: 17 }), [], abonoBanco(17000))).toEqual({
      estado: 'CONCILIADO',
      faltante_antes: 1000,
      faltante_despues: 0,
      sobrante: 0,
      comision_real: null,
      tc_implicito: 17,
      tc_referencia: 17,
      desvio_pct: 0,
      motivo: null,
      un_solo: true,
    });
    // +2.0 % es CERCA (el valor de 1 decimal que se MUESTRA).
    expect(
      vincular(usd({ tc_usd_mxn: 17 }), [], abonoBanco(17340)),
    ).toMatchObject({ estado: 'CONCILIADO', desvio_pct: 2 });
    expect(
      vincular(usd({ tc_usd_mxn: 17 }), [], abonoBanco(17360)),
    ).toMatchObject({
      estado: 'MONEDA_DISTINTA',
      motivo: 'TC_LEJOS',
      tc_implicito: 17.36,
      desvio_pct: 2.1,
    });
    expect(
      vincular(usd({ tc_usd_mxn: 17 }), [], abonoBanco(20400)),
    ).toMatchObject({
      estado: 'MONEDA_DISTINTA',
      motivo: 'TC_LEJOS',
      tc_implicito: 20.4,
      tc_referencia: 17,
      desvio_pct: 20,
    });
    expect(vincular(usd(), [], abonoBanco(500))).toMatchObject({
      estado: 'MONEDA_DISTINTA',
      motivo: 'TC_FUERA_DE_BANDA',
      tc_implicito: 0.5,
    });
    // Sin T.C. del cobro: el del VUELO; sin ninguno, solo la banda.
    expect(vincular(usd(), [], abonoBanco(20400), 17)).toMatchObject({
      estado: 'MONEDA_DISTINTA',
      motivo: 'TC_LEJOS',
      tc_referencia: 17,
    });
    expect(vincular(usd(), [], abonoBanco(20400))).toMatchObject({
      estado: 'CONCILIADO',
      tc_implicito: 20.4,
      tc_referencia: null,
    });
    // Cobro MXN de $17,500 contra 1,000 USD: 17.5, sin referencia.
    expect(
      vincular(cobroMxn(17500), [], {
        monto: 1000,
        moneda_cuenta: 'USD',
        pasarela: false,
      }),
    ).toMatchObject({ estado: 'CONCILIADO', tc_implicito: 17.5 });
    // Un abono en otra moneda sobre un cobro que ya tiene otro ⇒ UN_SOLO_ABONO.
    expect(
      vincular(
        usd(),
        [parte(300, { moneda_cuenta: 'USD' })],
        abonoBanco(11900),
      ),
    ).toMatchObject({
      estado: 'UN_SOLO_ABONO',
      motivo: 'MONEDA_DISTINTA',
    });
    // Un abono CRUZADO ya ligado cubre por definición.
    expect(
      vincular(
        cobroMxn(17500),
        [parte(1000, { moneda_cuenta: 'USD' })],
        abonoBanco(100),
      ),
    ).toMatchObject({ estado: 'YA_CUBIERTO', motivo: 'CUBIERTO' });
  });

  it('el borde de $1.00: $3,401.00 sobre $3,400 todavía cabe; $3,401.01 ya excede', () => {
    expect(vincular(cobroMxn(3400), [], abonoBanco(3401))).toMatchObject({
      estado: 'CONCILIADO',
      faltante_despues: 0,
    });
    expect(vincular(cobroMxn(3400), [], abonoBanco(3401.01))).toMatchObject({
      estado: 'EXCEDE',
      sobrante: 1.01,
    });
    // Un abono NEGATIVO llega en valor absoluto (como la parte de la BD).
    expect(vincular(cobroMxn(3400), [], abonoBanco(-1700))).toMatchObject({
      estado: 'PARCIAL',
      faltante_despues: 1700,
    });
  });
});

describe('estadoBancoCobro y el `conciliado` de siempre', () => {
  const cubierta = coberturaCobro(cobroMxn(3400), [parte(1700), parte(1700)]);
  const parcial = coberturaCobro(cobroMxn(3400), [parte(1700)]);

  it('los 5 estados por vía y cobertura', () => {
    const e = (
      via: 'DIRECTO' | 'SOBRE' | 'ANTICIPO' | null,
      cobertura: typeof cubierta | null,
      metodo = 'TRANSFERENCIA',
      monto = 3400,
    ) => estadoBancoCobro({ monto, metodo, via, cobertura });
    expect(e('ANTICIPO', null)).toBe('VIA_ANTICIPO');
    expect(e('SOBRE', null)).toBe('CONCILIADO');
    expect(e('DIRECTO', cubierta)).toBe('CONCILIADO');
    expect(e('DIRECTO', parcial)).toBe('PARCIAL');
    // Sin cobertura (respaldo del 0.0.77): la liga basta.
    expect(e('DIRECTO', null)).toBe('CONCILIADO');
    expect(e(null, null)).toBe('SIN_CONCILIAR');
    for (const metodo of ['HSBC_LINK', 'CHEQUE', 'PAYWISE']) {
      expect(e(null, null, metodo)).toBe('SIN_CONCILIAR');
    }
    for (const metodo of ['EFECTIVO', 'DOLARES', 'BILLPOCKET', 'OTRO']) {
      expect(e(null, null, metodo)).toBe('NO_BANCARIO');
    }
    expect(e(null, null, 'TRANSFERENCIA', -500)).toBe('NO_BANCARIO');
  });

  it('cobroCubiertoEnBanco: CONCILIADO o VIA_ANTICIPO (un PARCIAL ya no dice «Conciliado»)', () => {
    expect(cobroCubiertoEnBanco('CONCILIADO')).toBe(true);
    expect(cobroCubiertoEnBanco('VIA_ANTICIPO')).toBe(true);
    for (const x of ['PARCIAL', 'SIN_CONCILIAR', 'NO_BANCARIO'] as const) {
      expect(cobroCubiertoEnBanco(x)).toBe(false);
    }
  });
});

describe('tcImplicitoCobro — T.C. de un abono en otra moneda contra el NETO', () => {
  it('USD cobro + cuenta MXN ⇒ pesos ÷ dólares; al revés, neto ÷ parte; round6', () => {
    expect(tcImplicitoCobro('USD', 'MXN', 1000, 17000)).toBe(17);
    expect(tcImplicitoCobro('MXN', 'USD', 17500, 1000)).toBe(17.5);
    expect(tcImplicitoCobro('USD', 'MXN', 3, 52)).toBe(17.333333);
    expect(tcImplicitoCobro('MXN', 'MXN', 1000, 1000)).toBeNull();
    expect(tcImplicitoCobro('USD', null, 1000, 17000)).toBeNull();
    expect(tcImplicitoCobro('USD', 'MXN', 0, 17000)).toBeNull();
    expect(tcImplicitoCobro('MXN', 'USD', 17500, 0)).toBeNull();
  });
});

describe('cambiaDineroDelCobro — valor NUEVO contra el VIGENTE', () => {
  const vigente = {
    monto: '68205.55',
    moneda: 'MXN',
    tc_usd_mxn: '17.150000',
    comision_banco_monto: null,
    comision_banco_pct: '8.8570',
  };

  it('el formulario completo reenviado SIN cambio de dinero ⇒ false', () => {
    expect(
      cambiaDineroDelCobro(
        {
          monto: 68205.55,
          moneda: 'MXN',
          tc_usd_mxn: 17.15,
          comision_banco_monto: 0,
          comision_banco_pct: 8.857,
        },
        vigente,
      ),
    ).toBe(false);
    expect(cambiaDineroDelCobro({}, vigente)).toBe(false);
  });

  it('cualquier campo de dinero distinto ⇒ true; sin la fila vigente ⇒ true (fail-closed)', () => {
    expect(cambiaDineroDelCobro({ monto: 69183 }, vigente)).toBe(true);
    expect(cambiaDineroDelCobro({ moneda: 'USD' }, vigente)).toBe(true);
    expect(cambiaDineroDelCobro({ tc_usd_mxn: 17.2 }, vigente)).toBe(true);
    expect(cambiaDineroDelCobro({ tc_usd_mxn: null }, vigente)).toBe(true);
    expect(cambiaDineroDelCobro({ comision_banco_monto: 10 }, vigente)).toBe(
      true,
    );
    expect(cambiaDineroDelCobro({ comision_banco_pct: 8.86 }, vigente)).toBe(
      true,
    );
    expect(cambiaDineroDelCobro({ monto: 1 }, null)).toBe(true);
  });
});

describe('cobroDeUnSoloAbono (invariante 78, R9) y su paridad con alVincularAbono', () => {
  it('comisión, método PAYWISE, parte de la pasarela o cruzada ⇒ true; banco sin comisión ⇒ false', () => {
    const transf = {
      monto: 3400,
      moneda: 'MXN',
      metodo_cobro: 'TRANSFERENCIA',
    };
    expect(cobroDeUnSoloAbono(transf, [])).toBe(false);
    expect(cobroDeUnSoloAbono(transf, [parte(1700)])).toBe(false);
    expect(
      cobroDeUnSoloAbono({ ...transf, comision_banco_monto: 250 }, []),
    ).toBe(true);
    expect(cobroDeUnSoloAbono({ ...transf, metodo_cobro: 'PAYWISE' }, [])).toBe(
      true,
    );
    expect(cobroDeUnSoloAbono(transf, [parte(1700, { pasarela: true })])).toBe(
      true,
    );
    expect(
      cobroDeUnSoloAbono(transf, [parte(100, { moneda_cuenta: 'USD' })]),
    ).toBe(true);
    // #375 (HSBC_LINK con comisión) ⇒ true; #223 (Transferencia USD sin abonos) ⇒ false.
    expect(
      cobroDeUnSoloAbono(
        {
          monto: 16000,
          moneda: 'MXN',
          comision_banco_monto: 400,
          metodo_cobro: 'HSBC_LINK',
        },
        [],
      ),
    ).toBe(true);
    expect(
      cobroDeUnSoloAbono(
        { monto: 812, moneda: 'USD', metodo_cobro: 'TRANSFERENCIA' },
        [],
      ),
    ).toBe(false);
  });

  it('PARIDAD: con UNA parte ya ligada, un 2.º abono de BANCO en su moneda da UN_SOLO_ABONO ⇔ cobroDeUnSoloAbono (salvo YA_CUBIERTO, que va antes)', () => {
    // La tabla de casos del 0.0.78 (camionetas, #315, comisión HSBC,
    // Paywise, otra moneda) + variaciones de la parte ligada.
    const cobros = [
      { monto: 3400, moneda: 'MXN', metodo_cobro: 'TRANSFERENCIA' },
      { monto: 68205.55, moneda: 'MXN', metodo_cobro: 'TRANSFERENCIA' },
      {
        monto: 5000,
        moneda: 'MXN',
        comision_banco_monto: 250,
        metodo_cobro: 'HSBC_LINK',
      },
      {
        monto: 12495,
        moneda: 'MXN',
        comision_banco_monto: 624.76,
        metodo_cobro: 'HSBC_LINK',
      },
      { monto: 7000, moneda: 'MXN', metodo_cobro: 'CHEQUE' },
      { monto: 1000, moneda: 'USD', metodo_cobro: 'TRANSFERENCIA' },
    ];
    const ligadas = (c: (typeof cobros)[number]): ParteCobroBanco[] => [
      parte(100, { moneda_cuenta: c.moneda }),
      parte(100, { moneda_cuenta: c.moneda, pasarela: true }),
      parte(10, { moneda_cuenta: c.moneda === 'MXN' ? 'USD' : 'MXN' }),
      parte(Number(c.monto), { moneda_cuenta: c.moneda }),
    ];
    let comparados = 0;
    for (const c of cobros) {
      for (const ligada of ligadas(c)) {
        const v = alVincularAbono({
          cobro: c,
          tcVuelo: null,
          otras: [ligada],
          abono: { monto: 50, moneda_cuenta: c.moneda, pasarela: false },
          toleranciaTcPct: TOL_TC,
        });
        if (v.estado === 'YA_CUBIERTO') continue;
        comparados += 1;
        expect(v.estado === 'UN_SOLO_ABONO').toBe(
          cobroDeUnSoloAbono(c, [ligada]),
        );
      }
    }
    expect(comparados).toBeGreaterThanOrEqual(12);
  });
});
