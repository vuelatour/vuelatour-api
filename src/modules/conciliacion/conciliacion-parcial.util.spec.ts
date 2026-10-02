import {
  cubreGasto,
  diferenciaLote,
  etiquetaConciliadoLote,
  faltanteDe,
  faltanteLote,
  fechaCortaEs,
  leerErrorPartes,
  MENSAJE_LOTE_AMBOS,
  MENSAJE_SOLO_CARGOS,
  mensajeCargoNoCuadra,
  mensajeGastoYaCubierto,
  mensajeLoteInvalido,
  mensajeLoteMonedaDistinta,
  mensajeMonedaDistinta,
  mensajeMovimientoConGastos,
  mensajeMovimientoConLote,
  mensajeErrorPartes,
  mensajeLoteInvalidoDeBd,
  MENSAJE_CARGO_CAMBIO,
  MENSAJE_MOVIMIENTO_NO_EXISTE,
  montoBonito,
  motivoGastoCubiertoDeBd,
  afinarMotivoGastoCubierto,
  normalizarUuid,
  parteCruzada,
  puedeLigar,
  puedeRepartirCargo,
  textoSinPrefijo,
  toleranciaLote,
  TOLERANCIA_CONCILIACION,
  type GastoDeLote,
} from './conciliacion-parcial.util';

/**
 * Regla «1 gasto ↔ N cargos del banco» (14-sep-2026). Este util es la FUENTE
 * ÚNICA que comparten `ConciliacionService.link` y el trigger
 * `tg_mov_bancario_gasto_suma`: si algo cambia aquí, cambia en los dos.
 */
describe('faltanteDe', () => {
  it('lo que falta = monto − suma ligada, a centavos', () => {
    expect(faltanteDe(277.79, 152)).toBe(125.79);
    expect(faltanteDe(277.79, 0)).toBe(277.79);
  });

  it('nunca es negativo (un cargo mayor no genera "sobrante")', () => {
    expect(faltanteDe(100, 150)).toBe(0);
    expect(faltanteDe(100, 100)).toBe(0);
  });

  it('centavos: 0.1 + 0.2 no deja residuo flotante', () => {
    expect(faltanteDe(0.3, 0.1 + 0.2)).toBe(0);
  });
});

describe('cubreGasto (definición ÚNICA de gasto.conciliado)', () => {
  it('la suma exacta cubre', () => {
    expect(cubreGasto(277.79, 277.79)).toBe(true);
  });

  it('un pago parcial NO cubre (sigue en gastos-sin-banco)', () => {
    expect(cubreGasto(277.79, 152)).toBe(false);
  });

  it('tolerancia de 1.00 en la moneda del gasto (redondeos del banco)', () => {
    expect(TOLERANCIA_CONCILIACION).toBe(1);
    expect(cubreGasto(277.79, 276.79)).toBe(true);
    expect(cubreGasto(277.79, 276.78)).toBe(false);
  });
});

describe('puedeLigar — misma moneda: suma <= monto + tolerancia', () => {
  const base = { mismaMoneda: true, yaHayLigados: false };

  it('primer cargo parcial: cabe, no cubre y deja el faltante', () => {
    const r = puedeLigar({
      ...base,
      montoGasto: 277.79,
      sumaLigada: 0,
      montoNuevo: 152,
    });
    expect(r).toMatchObject({
      ok: true,
      motivo: null,
      suma_resultante: 152,
      faltante: 125.79,
      cubre: false,
    });
  });

  it('segundo cargo que completa: cabe y CUBRE (conciliado = true)', () => {
    const r = puedeLigar({
      montoGasto: 277.79,
      sumaLigada: 152,
      montoNuevo: 125.79,
      mismaMoneda: true,
      yaHayLigados: true,
    });
    expect(r).toMatchObject({ ok: true, faltante: 0, cubre: true });
    expect(r.suma_resultante).toBe(277.79);
  });

  it('tercer cargo que se pasa: NO cabe (GASTO_YA_CUBIERTO)', () => {
    const r = puedeLigar({
      montoGasto: 277.79,
      sumaLigada: 277.79,
      montoNuevo: 50,
      mismaMoneda: true,
      yaHayLigados: true,
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('GASTO_YA_CUBIERTO');
    // La suma reportada es la que YA estaba (el cargo nuevo no entró).
    expect(r.suma_resultante).toBe(277.79);
  });

  it('el signo del cargo no importa: se compara |monto|', () => {
    const r = puedeLigar({
      montoGasto: 277.79,
      sumaLigada: 152,
      montoNuevo: -125.79,
      mismaMoneda: true,
      yaHayLigados: true,
    });
    expect(r).toMatchObject({ ok: true, cubre: true });
  });

  it('rebasar por 1.00 exacto todavía cabe; por 1.01 ya no', () => {
    expect(
      puedeLigar({
        montoGasto: 100,
        sumaLigada: 0,
        montoNuevo: 101,
        mismaMoneda: true,
        yaHayLigados: false,
      }).ok,
    ).toBe(true);
    expect(
      puedeLigar({
        montoGasto: 100,
        sumaLigada: 0,
        montoNuevo: 101.01,
        mismaMoneda: true,
        yaHayLigados: false,
      }).ok,
    ).toBe(false);
  });
});

describe('puedeLigar — moneda distinta: 1 ↔ 1 (de ese cargo sale el TC)', () => {
  it('gasto USD contra cuenta MXN sin otros ligados: cabe y CUBRE', () => {
    const r = puedeLigar({
      montoGasto: 100,
      sumaLigada: 0,
      montoNuevo: 1850,
      mismaMoneda: false,
      yaHayLigados: false,
    });
    expect(r).toMatchObject({ ok: true, cubre: true, faltante: 0 });
  });

  it('con un cargo ya ligado, el segundo REBOTA (MONEDA_DISTINTA)', () => {
    const r = puedeLigar({
      montoGasto: 100,
      sumaLigada: 0,
      montoNuevo: 1850,
      mismaMoneda: false,
      yaHayLigados: true,
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('MONEDA_DISTINTA');
  });
});

describe('textos del 409 (es-MX, lo que lee el operador)', () => {
  it('GASTO_YA_CUBIERTO dice cuánto, de cuánto y con qué cargo', () => {
    expect(
      mensajeGastoYaCubierto({
        montoGasto: 277.79,
        sumaLigada: 277.79,
        cargos: [{ id: 'm1', fecha: '2026-09-07', monto: 277.79 }],
      }),
    ).toBe(
      'Ese gasto ya está cubierto: $277.79 de $277.79 (cargo del 07 sep). ' +
        'Si este cargo es otro pago de la misma factura, el gasto debe valer la suma de los dos.',
    );
  });

  it('con dos cargos los enlista', () => {
    const msg = mensajeGastoYaCubierto({
      montoGasto: 1234.5,
      sumaLigada: 1234.5,
      cargos: [
        { fecha: '2026-09-07', monto: 1000 },
        { fecha: '2026-09-09', monto: 234.5 },
      ],
    });
    expect(msg).toContain('$1,234.50 de $1,234.50');
    expect(msg).toContain('(cargos del 07 sep, 09 sep)');
  });

  it('moneda distinta: explica el 1 ↔ 1 y qué hacer', () => {
    const msg = mensajeMonedaDistinta({
      monedaGasto: 'USD',
      monedaCuenta: 'MXN',
      cargos: [{ fecha: '2026-09-07', monto: 1850 }],
    });
    expect(msg).toContain('Este gasto está en USD');
    expect(msg).toContain('MXN');
    expect(msg).toContain('Desvincula ese cargo antes de ligar otro.');
  });
});

describe('formatos', () => {
  it('fecha corta sin corrimiento de zona', () => {
    expect(fechaCortaEs('2026-09-07')).toBe('07 sep');
    expect(fechaCortaEs('2026-01-31T05:00:00Z')).toBe('31 ene');
    expect(fechaCortaEs(null)).toBeNull();
    expect(fechaCortaEs('sin fecha')).toBeNull();
  });

  it('monto con separador de miles', () => {
    expect(montoBonito(277.79)).toBe('$277.79');
    expect(montoBonito(1234567.5)).toBe('$1,234,567.50');
    expect(montoBonito(-40)).toBe('$40.00');
  });
});

/**
 * REVISIÓN 14-sep-2026 — el PRIMER cargo que YA rebasa el ticket también se
 * rechaza (la regla mira la SUMA, y un solo cargo ya es la suma). Ahí el
 * texto viejo decía «Ese gasto ya está cubierto: $0.00 de $277.79», que no
 * significa nada para la oficina: ese caso tiene su propio mensaje.
 */
describe('mensajeGastoYaCubierto — sin cargos previos', () => {
  it('habla del CARGO, no de un «ya cubierto» de $0.00', () => {
    const msg = mensajeGastoYaCubierto({
      montoGasto: 277.79,
      sumaLigada: 0,
      cargos: [],
      montoNuevo: 1800,
    });
    expect(msg).toContain('$1,800.00');
    expect(msg).toContain('$277.79');
    expect(msg).toContain('MAYOR que el gasto');
    expect(msg).not.toContain('ya está cubierto');
    expect(msg).not.toContain('$0.00');
  });

  it('sin el monto del cargo sigue siendo legible', () => {
    const msg = mensajeGastoYaCubierto({
      montoGasto: 277.79,
      sumaLigada: 0,
      cargos: [],
    });
    expect(msg).toContain('Ese cargo es MAYOR que el gasto ($277.79)');
  });

  it('CON cargos previos conserva el texto de siempre', () => {
    const msg = mensajeGastoYaCubierto({
      montoGasto: 277.79,
      sumaLigada: 277.79,
      cargos: [{ id: 'm1', fecha: '2026-09-07', monto: 277.79 }],
      montoNuevo: 50,
    });
    expect(msg).toBe(
      'Ese gasto ya está cubierto: $277.79 de $277.79 (cargo del 07 sep). ' +
        'Si este cargo es otro pago de la misma factura, el gasto debe valer ' +
        'la suma de los dos.',
    );
  });
});

// =======================================================================
// 1 CARGO ↔ N GASTOS (2-oct-2026). Montos REALES de SAESA en prod: 29
// «Pago VIP SAESA» (1,118.12 ×5, 2,231.37 ×11, 2,231.38 ×2, 2,801.40 ×8,
// 1,108.38, 384.89, 1,066.97 = 59,569.87) y los SPEI del 24-sep de GASTOS
// GNRAL: 8,404.20 · 4,462.75 ×2 · 2,236.25 · 1,118.12 ×2 · 2,231.38.
// =======================================================================

const MXN = 'MXN';
const g = (
  id: string,
  monto: number,
  otras: GastoDeLote['otras'] = [],
  moneda: string | null = MXN,
): GastoDeLote => ({ id, monto, moneda, otras });

describe('toleranciaLote — least(1.00, greatest(0.02, 0.01 × N))', () => {
  it.each([
    [0, 0.02],
    [1, 0.02],
    [2, 0.02],
    [3, 0.03],
    [7, 0.07],
    [29, 0.29],
    [100, 1],
    [150, 1],
  ])('N=%i ⇒ %d', (n, t) => {
    expect(toleranciaLote(n)).toBe(t);
  });

  it('N no entero o basura no revienta', () => {
    expect(toleranciaLote(3.9)).toBe(0.03);
    expect(toleranciaLote(Number.NaN)).toBe(0.02);
  });
});

describe('puedeRepartirCargo — casos SAESA reales', () => {
  it('SPEI 8,404.20 = 3 × 2,801.40 (#315, #319, #326): cuadra exacto', () => {
    const r = puedeRepartirCargo({
      montoCargo: 8404.2,
      monedaCuenta: MXN,
      gastos: [g('g315', 2801.4), g('g319', 2801.4), g('g326', 2801.4)],
    });
    expect(r).toMatchObject({
      ok: true,
      motivo: null,
      n: 3,
      suma: 8404.2,
      diferencia: 0,
      tolerancia: 0.03,
      moneda: MXN,
    });
    expect(r.partes).toEqual([
      { gasto_id: 'g315', monto_parte: 2801.4 },
      { gasto_id: 'g319', monto_parte: 2801.4 },
      { gasto_id: 'g326', monto_parte: 2801.4 },
    ]);
  });

  it('SPEI 4,462.75 = 2,231.37 + 2,231.38: cuadra exacto', () => {
    const r = puedeRepartirCargo({
      montoCargo: 4462.75,
      monedaCuenta: MXN,
      gastos: [g('g318', 2231.37), g('g321', 2231.38)],
    });
    expect(r).toMatchObject({ ok: true, suma: 4462.75, diferencia: 0 });
  });

  it('SPEI 4,462.75 = 2 × 2,231.37 (SAESA factura 2,231.375): diferencia 0.01 ≤ 0.02', () => {
    const r = puedeRepartirCargo({
      montoCargo: 4462.75,
      monedaCuenta: MXN,
      gastos: [g('g318', 2231.37), g('g322', 2231.37)],
    });
    expect(r).toMatchObject({
      ok: true,
      suma: 4462.74,
      diferencia: 0.01,
      tolerancia: 0.02,
    });
  });

  it('SPEI 2,236.25 = 2 × 1,118.12 + 0.01 (factura 1,118.125): cuadra', () => {
    const r = puedeRepartirCargo({
      montoCargo: 2236.25,
      monedaCuenta: MXN,
      gastos: [g('a', 1118.12), g('b', 1118.12)],
    });
    expect(r).toMatchObject({ ok: true, suma: 2236.24, diferencia: 0.01 });
  });

  it('8,404.20 con SOLO 2 × 2,801.40: CARGO_NO_CUADRA con los números', () => {
    const r = puedeRepartirCargo({
      montoCargo: 8404.2,
      monedaCuenta: MXN,
      gastos: [g('g315', 2801.4), g('g319', 2801.4)],
    });
    expect(r).toMatchObject({
      ok: false,
      motivo: 'CARGO_NO_CUADRA',
      monto_cargo: 8404.2,
      suma: 5602.8,
      diferencia: 2801.4,
      tolerancia: 0.02,
      moneda: MXN,
    });
    expect(r.partes).toEqual([]);
    expect(r.gastos).toEqual([
      { id: 'g315', monto: 2801.4, faltante: 2801.4 },
      { id: 'g319', monto: 2801.4, faltante: 2801.4 },
    ]);
  });

  it('se pasa por 0.03 con 2 gastos (tolerancia 0.02): NO cuadra', () => {
    const r = puedeRepartirCargo({
      montoCargo: 4462.71,
      monedaCuenta: MXN,
      gastos: [g('a', 2231.37), g('b', 2231.37)],
    });
    expect(r).toMatchObject({
      ok: false,
      motivo: 'CARGO_NO_CUADRA',
      diferencia: -0.03,
    });
  });

  it('los 29 gastos SAESA (59,569.87): tolerancia 0.29', () => {
    const montos = [
      ...Array<number>(5).fill(1118.12),
      ...Array<number>(11).fill(2231.37),
      ...Array<number>(2).fill(2231.38),
      ...Array<number>(8).fill(2801.4),
      1108.38,
      384.89,
      1066.97,
    ];
    const gastos = montos.map((m, i) => g(`s${i}`, m));
    const ok = puedeRepartirCargo({
      montoCargo: 59569.87 + 0.29,
      monedaCuenta: MXN,
      gastos,
    });
    expect(ok).toMatchObject({
      ok: true,
      n: 29,
      suma: 59569.87,
      tolerancia: 0.29,
    });
    const no = puedeRepartirCargo({
      montoCargo: 59569.87 + 0.3,
      monedaCuenta: MXN,
      gastos,
    });
    expect(no.motivo).toBe('CARGO_NO_CUADRA');
  });

  it('un gasto en USD en un cargo MXN: LOTE_MONEDA_DISTINTA (se liga 1 a 1)', () => {
    const r = puedeRepartirCargo({
      montoCargo: 4000,
      monedaCuenta: MXN,
      gastos: [g('a', 2000), g('usd', 100, [], 'USD')],
    });
    expect(r).toMatchObject({
      ok: false,
      motivo: 'LOTE_MONEDA_DISTINTA',
      gasto_id: 'usd',
      moneda_gasto: 'USD',
      moneda: MXN,
    });
  });

  it('un gasto YA cubierto por otro cargo: GASTO_YA_CUBIERTO con su id', () => {
    const r = puedeRepartirCargo({
      montoCargo: 5602.8,
      monedaCuenta: MXN,
      gastos: [
        g('g315', 2801.4),
        g('g236', 2801.4, [{ monto_parte: 2801.4, moneda: MXN }]),
      ],
    });
    expect(r).toMatchObject({
      ok: false,
      motivo: 'GASTO_YA_CUBIERTO',
      gasto_id: 'g236',
      motivo_gasto: 'GASTO_YA_CUBIERTO',
    });
  });

  it('un gasto con pago PARCIAL en otro cargo entra por lo que le FALTA', () => {
    const r = puedeRepartirCargo({
      montoCargo: 2801.4 + 1801.4,
      monedaCuenta: MXN,
      gastos: [
        g('g315', 2801.4),
        g('g319', 2801.4, [{ monto_parte: 1000, moneda: MXN }]),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.partes).toEqual([
      { gasto_id: 'g315', monto_parte: 2801.4 },
      { gasto_id: 'g319', monto_parte: 1801.4 },
    ]);
  });

  it('un gasto USD con su cargo cruzado (1 ↔ 1) no admite más: MONEDA_DISTINTA', () => {
    const r = puedeRepartirCargo({
      montoCargo: 200,
      monedaCuenta: 'USD',
      gastos: [
        g('a', 100, [], 'USD'),
        g('b', 100, [{ monto_parte: 1850, moneda: MXN }], 'USD'),
      ],
    });
    expect(r).toMatchObject({
      motivo: 'GASTO_YA_CUBIERTO',
      gasto_id: 'b',
      motivo_gasto: 'MONEDA_DISTINTA',
    });
  });

  it('orden de G: gasto por gasto (un cubierto en la posición 1 gana a un USD en la 2)', () => {
    const cubiertoPrimero = puedeRepartirCargo({
      montoCargo: 2901.4,
      monedaCuenta: MXN,
      gastos: [
        g('g236', 2801.4, [{ monto_parte: 2801.4, moneda: MXN }]),
        g('usd', 100, [], 'USD'),
      ],
    });
    expect(cubiertoPrimero).toMatchObject({
      motivo: 'GASTO_YA_CUBIERTO',
      gasto_id: 'g236',
    });
    // Al revés, el USD va primero: LOTE_MONEDA_DISTINTA (como la BD).
    const usdPrimero = puedeRepartirCargo({
      montoCargo: 2901.4,
      monedaCuenta: MXN,
      gastos: [
        g('usd', 100, [], 'USD'),
        g('g236', 2801.4, [{ monto_parte: 2801.4, moneda: MXN }]),
      ],
    });
    expect(usdPrimero).toMatchObject({
      motivo: 'LOTE_MONEDA_DISTINTA',
      gasto_id: 'usd',
    });
  });

  it('sin la moneda de la cuenta el TS rechaza (el servicio no llega aquí sin ella)', () => {
    const r = puedeRepartirCargo({
      montoCargo: 5602.8,
      monedaCuenta: null,
      gastos: [g('g315', 2801.4), g('g319', 2801.4)],
    });
    expect(r.motivo).toBe('LOTE_MONEDA_DISTINTA');
  });

  it('menos de 2, más de 50 o repetidos: LOTE_INVALIDO', () => {
    const base = { montoCargo: 100, monedaCuenta: MXN };
    expect(puedeRepartirCargo({ ...base, gastos: [g('a', 100)] }).motivo).toBe(
      'LOTE_INVALIDO',
    );
    expect(
      puedeRepartirCargo({ ...base, gastos: [g('a', 50), g('a', 50)] }).motivo,
    ).toBe('LOTE_INVALIDO');
    const muchos = Array.from({ length: 51 }, (_, i) => g(`x${i}`, 1));
    expect(puedeRepartirCargo({ ...base, gastos: muchos }).motivo).toBe(
      'LOTE_INVALIDO',
    );
  });
});

describe('faltanteLote / parteCruzada', () => {
  it('sin otras partes falta todo el gasto', () => {
    expect(faltanteLote(g('a', 2801.4))).toEqual({
      faltante: 2801.4,
      cruzado: false,
    });
  });

  it('otra parte que ya lo cubre (dentro de 1.00) ⇒ 0', () => {
    expect(
      faltanteLote(g('a', 277.79, [{ monto_parte: 276.8, moneda: MXN }]))
        .faltante,
    ).toBe(0);
  });

  it('parte cruzada = moneda de su cuenta ≠ moneda del gasto', () => {
    expect(parteCruzada('MXN', 'USD')).toBe(true);
    expect(parteCruzada('MXN', 'MXN')).toBe(false);
    expect(parteCruzada(null, 'USD')).toBe(false);
  });
});

describe('diferenciaLote (gastos_diferencia del listado y del resumen)', () => {
  it('|cargo| − Σ partes a centavos', () => {
    expect(
      diferenciaLote(-4462.75, [
        { monto_parte: 2231.37 },
        { monto_parte: 2231.37 },
      ]),
    ).toBe(0.01);
    expect(
      diferenciaLote(8404.2, [
        { monto_parte: 2801.4 },
        { monto_parte: 2801.4 },
        { monto_parte: 2801.4 },
      ]),
    ).toBe(0);
  });

  it('sin partes o con parte cruzada ⇒ null', () => {
    expect(diferenciaLote(100, [])).toBeNull();
    expect(
      diferenciaLote(1850, [{ monto_parte: 1850, cruzada: true }]),
    ).toBeNull();
  });
});

describe('textos del lote (es-MX)', () => {
  it('LOTE_INVALIDO', () => {
    expect(MENSAJE_LOTE_AMBOS).toBe(
      'Manda la lista de gastos (gasto_ids) o un solo gasto (gasto_id), no los dos.',
    );
    expect(mensajeLoteInvalido('NO_EXISTE')).toContain('ya no existe');
    expect(mensajeLoteInvalido('REPETIDOS')).toContain('repetidos');
    expect(mensajeLoteInvalido('TAMANO')).toBe(
      'Elige de 2 a 50 gastos para un mismo cargo.',
    );
  });

  it('SOLO_CARGOS', () => {
    expect(MENSAJE_SOLO_CARGOS).toBe(
      'Solo un cargo (salida de dinero) se concilia contra gastos.',
    );
  });

  it('MOVIMIENTO_CON_LOTE dice cuántos y qué hacer SIN nombrar un menú que el panel viejo no tiene', () => {
    expect(mensajeMovimientoConLote(3)).toBe(
      'Este cargo ya paga 3 gastos: desvincúlalos primero desde Conciliación (recarga la página) y vuelve a vincularlo.',
    );
    expect(mensajeMovimientoConLote(3)).not.toContain('«Desvincular');
    expect(mensajeMovimientoConLote(0)).toContain('ya paga 2 gastos');
  });

  it('MOVIMIENTO_YA_LIGADO de linkCobro: el cargo ya paga gasto(s)', () => {
    expect(mensajeMovimientoConGastos(3)).toBe(
      'Este movimiento ya está conciliado con 3 gastos: desvincúlalos antes de conciliarlo con un cobro.',
    );
    expect(mensajeMovimientoConGastos(1)).toBe(
      'Este movimiento ya está conciliado con un gasto: desvincúlalo antes de conciliarlo con un cobro.',
    );
    expect(mensajeMovimientoConGastos(Number.NaN)).toContain('con un gasto');
  });

  it('LOTE_MONEDA_DISTINTA', () => {
    const t = mensajeLoteMonedaDistinta({
      monedaGasto: 'USD',
      monedaCuenta: 'MXN',
    });
    expect(t).toContain('está en USD');
    expect(t).toContain('cuenta del cargo en MXN');
    expect(t).toContain('1 a 1');
  });

  it('CARGO_NO_CUADRA: faltan / se pasan', () => {
    expect(
      mensajeCargoNoCuadra({
        n: 2,
        suma: 5602.8,
        montoCargo: 8404.2,
        tolerancia: 0.02,
      }),
    ).toBe(
      'Los 2 gastos suman $5,602.80 y el cargo es de $8,404.20: faltan $2,801.40 (se acepta hasta $0.02 de diferencia). Revisa qué gastos paga este cargo.',
    );
    expect(
      mensajeCargoNoCuadra({
        n: 2,
        suma: 4462.74,
        montoCargo: 4462.71,
        tolerancia: 0.02,
      }),
    ).toContain('se pasan por $0.03');
  });

  it('textoSinPrefijo quita «CODIGO:» y pone mayúscula', () => {
    expect(
      textoSinPrefijo(
        'LOTE_SOLO_API_NUEVO: este cargo paga 3 gastos; desligarlo exige la conciliación actualizada',
      ),
    ).toBe(
      'Este cargo paga 3 gastos; desligarlo exige la conciliación actualizada',
    );
    expect(textoSinPrefijo(null)).toBe('');
    expect(textoSinPrefijo('sin prefijo')).toBe('Sin prefijo');
  });
});

describe('leerErrorPartes — hint, prefijo y detail JSON', () => {
  it('hint manda; detail JSON se parsea', () => {
    const r = leerErrorPartes({
      code: '23514',
      message:
        'CARGO_NO_CUADRA: los 2 gastos suman 5602.80 y el cargo es de 8404.20',
      hint: 'CARGO_NO_CUADRA',
      details: '{"monto_cargo": 8404.2, "suma_gastos": 5602.8}',
    });
    expect(r.codigo).toBe('CARGO_NO_CUADRA');
    expect(r.details).toEqual({ monto_cargo: 8404.2, suma_gastos: 5602.8 });
    expect(r.texto).toBe('Los 2 gastos suman 5602.80 y el cargo es de 8404.20');
  });

  it('sin hint toma el prefijo; detail que no es JSON ⇒ null', () => {
    const r = leerErrorPartes({
      message: 'GASTO_YA_CUBIERTO: el gasto x ya está cubierto',
      details: 'Failing row contains (…)',
    });
    expect(r.codigo).toBe('GASTO_YA_CUBIERTO');
    expect(r.details).toBeNull();
  });

  it('el código en medio del texto (formato viejo del trigger) también cuenta', () => {
    expect(
      leerErrorPartes({ message: 'ERROR: GASTO_YA_CUBIERTO: otra MONEDA' })
        .codigo,
    ).toBe('GASTO_YA_CUBIERTO');
  });

  it('un error ajeno ⇒ codigo null', () => {
    expect(
      leerErrorPartes({ code: '57014', message: 'canceling statement' }).codigo,
    ).toBeNull();
    expect(leerErrorPartes(null).codigo).toBeNull();
  });

  it('JSON roto en detail no revienta', () => {
    expect(
      leerErrorPartes({ message: 'LOTE_INVALIDO: x', details: '{roto' })
        .details,
    ).toBeNull();
  });
});

describe('etiquetaConciliadoLote («Conciliado con» del Excel)', () => {
  it('3 gastos SAESA con su vuelo y monto', () => {
    expect(
      etiquetaConciliadoLote(
        [315, 319, 326].map((folio) => ({
          categoria: 'Operaciones',
          vuelo_folio: folio,
          monto_parte: 2801.4,
        })),
        0,
      ),
    ).toBe(
      '3 gastos: Operaciones · vuelo #315 ($2,801.40) · Operaciones · vuelo #319 ($2,801.40) · Operaciones · vuelo #326 ($2,801.40)',
    );
  });

  it('con diferencia de un centavo la dice', () => {
    expect(
      etiquetaConciliadoLote(
        [
          {
            categoria: 'Operaciones',
            proveedor: 'SAESA',
            monto_parte: 2231.37,
          },
          { categoria: 'Operaciones', monto_parte: 2231.37 },
        ],
        0.01,
      ),
    ).toBe(
      '2 gastos: Operaciones · SAESA ($2,231.37) · Operaciones ($2,231.37) · diferencia $0.01',
    );
  });
});

describe('textos de los errores de la BD (sin uuid crudos, revisión 2-oct-2026)', () => {
  const UUID = '9a1b2c3d-1111-4222-8333-444455556666';

  it('CARGO_EXCEDIDO con los números de la BD', () => {
    const t = mensajeErrorPartes('CARGO_EXCEDIDO', {
      movimiento_id: UUID,
      monto_cargo: 8404.2,
      suma_partes: 5602.8,
      monto_parte: 2801.41,
    });
    expect(t).toBe(
      'Los gastos de este cargo ya suman $5,602.80 y con este ($2,801.41) rebasarían el cargo ($8,404.20): recarga la página y revisa qué gastos paga.',
    );
    expect(t).not.toContain(UUID);
    expect(mensajeErrorPartes('CARGO_EXCEDIDO', null)).toBe(
      'Los gastos elegidos rebasarían el monto de este cargo: recarga la página y revisa qué gastos paga.',
    );
  });

  it('REVERSO_INVALIDO: devolución vs cargo emparejado, sin el id del abono', () => {
    expect(
      mensajeErrorPartes('REVERSO_INVALIDO', {
        movimiento_id: UUID,
        reverso_de_id: UUID,
      }),
    ).toBe(
      'Este movimiento es la devolución de un cargo: no se concilia contra gastos.',
    );
    const t = mensajeErrorPartes('REVERSO_INVALIDO', {
      movimiento_id: UUID,
      devolucion_id: UUID,
    });
    expect(t).toBe(
      'Este cargo está conciliado con su devolución del banco: quita el emparejamiento («Quitar») antes de vincularle gastos.',
    );
    expect(t).not.toContain(UUID);
  });

  it('PARTES_INCOHERENTES y CARGO_LIGADO: el cargo cambió (recarga)', () => {
    expect(mensajeErrorPartes('PARTES_INCOHERENTES', { motivo: 'x' })).toBe(
      MENSAJE_CARGO_CAMBIO,
    );
    expect(mensajeErrorPartes('CARGO_LIGADO', { gastos_n: 3 })).toBe(
      MENSAJE_CARGO_CAMBIO,
    );
    expect(MENSAJE_CARGO_CAMBIO).toBe(
      'El cargo cambió mientras lo conciliabas: recarga la página y vuelve a intentarlo.',
    );
  });

  it('MOVIMIENTO_YA_LIGADO y LOTE_SOLO_API_NUEVO', () => {
    expect(mensajeErrorPartes('MOVIMIENTO_YA_LIGADO')).toBe(
      'Este movimiento ya está conciliado con un cobro, un sobre de grupo o un ingreso: desvincúlalo antes de vincularle gastos.',
    );
    expect(mensajeErrorPartes('LOTE_SOLO_API_NUEVO', { gastos_n: 3 })).toBe(
      'Este cargo paga 3 gastos y el servidor se está actualizando: vuelve a intentarlo en unos minutos desde Conciliación (recarga la página).',
    );
    expect(mensajeErrorPartes('LOTE_SOLO_API_NUEVO', {})).toContain(
      'paga varios gastos',
    );
  });

  it('LOTE_INVALIDO de la BD ⇒ el texto de siempre, sin uuid', () => {
    expect(
      mensajeLoteInvalidoDeBd(`LOTE_INVALIDO: el gasto ${UUID} no existe`, {
        gasto_id: UUID,
      }),
    ).toBe(mensajeLoteInvalido('NO_EXISTE'));
    expect(
      mensajeLoteInvalidoDeBd(
        'LOTE_INVALIDO: la lista trae el mismo gasto repetido',
        null,
      ),
    ).toBe(mensajeLoteInvalido('REPETIDOS'));
    expect(
      mensajeLoteInvalidoDeBd('LOTE_INVALIDO: manda al menos un gasto', null),
    ).toBe(mensajeLoteInvalido('TAMANO'));
    expect(
      mensajeLoteInvalidoDeBd(
        'LOTE_INVALIDO: la lista trae un gasto vacío',
        null,
      ),
    ).toBe(mensajeLoteInvalido('TAMANO'));
    expect(
      mensajeLoteInvalidoDeBd(
        `LOTE_INVALIDO: el movimiento ${UUID} no existe`,
        {
          movimiento_id: UUID,
        },
      ),
    ).toBe(MENSAJE_MOVIMIENTO_NO_EXISTE);
    expect(
      mensajeLoteInvalidoDeBd('LOTE_INVALIDO: solo un CARGO del banco …', {
        tipo: 'ABONO',
      }),
    ).toBe(MENSAJE_SOLO_CARGOS);
  });
});

describe('motivo del GASTO_YA_CUBIERTO que manda la BD', () => {
  it('details.motivo gana; sin él, el includes(MONEDA) de respaldo', () => {
    expect(
      motivoGastoCubiertoDeBd('GASTO_YA_CUBIERTO: ya está cubierto', {
        motivo: 'MONEDA_DISTINTA',
      }),
    ).toBe('MONEDA_DISTINTA');
    expect(
      motivoGastoCubiertoDeBd('GASTO_YA_CUBIERTO: otra MONEDA', {
        motivo: 'GASTO_YA_CUBIERTO',
      }),
    ).toBe('GASTO_YA_CUBIERTO');
    expect(motivoGastoCubiertoDeBd('… otra MONEDA (1 a 1)', null)).toBe(
      'MONEDA_DISTINTA',
    );
    expect(motivoGastoCubiertoDeBd('… rebasan su monto', { motivo: 'x' })).toBe(
      'GASTO_YA_CUBIERTO',
    );
  });

  it('un cargo en OTRA moneda que ya lo cubre (1 ↔ 1) ⇒ MONEDA_DISTINTA', () => {
    expect(afinarMotivoGastoCubierto('GASTO_YA_CUBIERTO', 'USD', ['MXN'])).toBe(
      'MONEDA_DISTINTA',
    );
    expect(
      afinarMotivoGastoCubierto('GASTO_YA_CUBIERTO', 'MXN', ['MXN', null]),
    ).toBe('GASTO_YA_CUBIERTO');
    expect(afinarMotivoGastoCubierto('MONEDA_DISTINTA', 'MXN', [])).toBe(
      'MONEDA_DISTINTA',
    );
  });
});

describe('normalizarUuid', () => {
  it('un uuid en MAYÚSCULAS pasa a minúsculas (como lo devuelve la BD)', () => {
    expect(normalizarUuid('9A1B2C3D-1111-4222-8333-44445555AAAA')).toBe(
      '9a1b2c3d-1111-4222-8333-44445555aaaa',
    );
  });
  it('lo que no es uuid se deja tal cual', () => {
    expect(normalizarUuid('gA')).toBe('gA');
  });
});
