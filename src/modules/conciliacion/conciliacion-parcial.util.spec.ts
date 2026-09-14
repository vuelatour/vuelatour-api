import {
  cubreGasto,
  faltanteDe,
  fechaCortaEs,
  mensajeGastoYaCubierto,
  mensajeMonedaDistinta,
  montoBonito,
  puedeLigar,
  TOLERANCIA_CONCILIACION,
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
