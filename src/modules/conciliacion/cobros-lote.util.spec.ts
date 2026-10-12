import {
  diferenciaLoteCobros,
  etiquetaConciliadoCobros,
  leerErrorCobros,
  ligasDesdePartes,
  LOTE_COBROS_MAX,
  mensajeErrorCobros,
  netoDeCobro,
  puedeLigarCobros,
  unirLigas,
} from './cobros-lote.util';
import {
  cobroEstaConciliado,
  movimientoDeCobro,
} from '../../common/cobro-conciliado.util';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const MOV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('cobros-lote.util — 1 abono ↔ N cobros (caso #379 + #380)', () => {
  it('netoDeCobro = monto − comisión bancaria (solo si es > 0)', () => {
    expect(netoDeCobro(20400, 1020)).toBe(19380);
    expect(netoDeCobro('2500.00', null)).toBe(2500);
    expect(netoDeCobro(100, -5)).toBe(100);
    // Una comisión que se come todo el cobro no deja un neto en 0: el bruto.
    expect(netoDeCobro(100, 100)).toBe(100);
  });

  it('dos cobros que cuadran con el abono ⇒ ok con parte = neto de cada uno', () => {
    const v = puedeLigarCobros({
      montoAbono: 3500,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 1000, moneda: 'MXN', folio: 379 },
        {
          id: B,
          monto: 2600,
          moneda: 'MXN',
          comision_banco_monto: 100,
          folio: 380,
        },
      ],
    });
    expect(v).toEqual({
      ok: true,
      partes: [
        { cobro_id: A, monto_parte: 1000 },
        { cobro_id: B, monto_parte: 2500 },
      ],
      suma: 3500,
      diferencia: 0,
      tolerancia: 0.02,
    });
  });

  it('UN cobro: parte = |abono| y sin cuadre (regla de siempre)', () => {
    const v = puedeLigarCobros({
      montoAbono: '-3500',
      monedaCuenta: 'MXN',
      cobros: [{ id: A, monto: 1000, moneda: 'USD', folio: 379 }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.partes).toEqual([{ cobro_id: A, monto_parte: 3500 }]);
      expect(v.tolerancia).toBe(0);
    }
  });

  it('el lote que no cuadra ⇒ ABONO_NO_CUADRA con el detalle de la BD', () => {
    const v = puedeLigarCobros({
      montoAbono: 3500,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 1000, moneda: 'MXN', folio: 379 },
        { id: B, monto: 2000, moneda: 'MXN', folio: 380 },
      ],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.codigo).toBe('ABONO_NO_CUADRA');
      expect(v.details).toMatchObject({
        monto_abono: 3500,
        suma_cobros: 3000,
        diferencia: 500,
        tolerancia: 0.02,
        moneda: 'MXN',
      });
      expect(v.mensaje).toContain('faltan $500.00 MXN');
      expect(v.mensaje).toContain('$0.02 MXN');
    }
  });

  it('la tolerancia es un centavo por cobro (mínimo 0.02, máximo 1.00)', () => {
    const tres = puedeLigarCobros({
      montoAbono: 3000.03,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 1000, moneda: 'MXN' },
        { id: B, monto: 1000, moneda: 'MXN' },
        { id: C, monto: 1000, moneda: 'MXN' },
      ],
    });
    expect(tres.ok).toBe(true);
    const fuera = puedeLigarCobros({
      montoAbono: 3000.04,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 1000, moneda: 'MXN' },
        { id: B, monto: 1000, moneda: 'MXN' },
        { id: C, monto: 1000, moneda: 'MXN' },
      ],
    });
    expect(fuera.ok).toBe(false);
  });

  it('otra moneda dentro de un lote ⇒ LOTE_MONEDA_DISTINTA; sola, pasa', () => {
    const lote = puedeLigarCobros({
      montoAbono: 3500,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 1000, moneda: 'MXN', folio: 379 },
        { id: B, monto: 2500, moneda: 'USD', folio: 380 },
      ],
    });
    expect(lote.ok).toBe(false);
    if (!lote.ok) {
      expect(lote.codigo).toBe('LOTE_MONEDA_DISTINTA');
      expect(lote.mensaje).toContain('#380');
      expect(lote.details).toMatchObject({
        moneda_cobro: 'USD',
        moneda_cuenta: 'MXN',
      });
    }
  });

  it('parte de sobre, de anticipo o reembolso ⇒ su código, nombrando el vuelo', () => {
    const sobre = puedeLigarCobros({
      montoAbono: 100,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 100, moneda: 'MXN', folio: 12, cobro_grupo_id: C },
      ],
    });
    expect(sobre.ok).toBe(false);
    if (!sobre.ok) expect(sobre.codigo).toBe('COBRO_DE_GRUPO');
    const anticipo = puedeLigarCobros({
      montoAbono: 100,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 100, moneda: 'MXN', folio: 12, ingreso_anticipo_id: C },
      ],
    });
    expect(anticipo.ok).toBe(false);
    if (!anticipo.ok) expect(anticipo.codigo).toBe('COBRO_DE_ANTICIPO');
    const reembolso = puedeLigarCobros({
      montoAbono: 100,
      monedaCuenta: 'MXN',
      cobros: [{ id: A, monto: -100, moneda: 'MXN', folio: 12 }],
    });
    expect(reembolso.ok).toBe(false);
    if (!reembolso.ok) {
      expect(reembolso.codigo).toBe('COBRO_INVALIDO');
      expect(reembolso.mensaje).toContain('#12');
    }
  });

  it('lista vacía o mayor al tope ⇒ LOTE_INVALIDO', () => {
    expect(
      puedeLigarCobros({ montoAbono: 1, monedaCuenta: null, cobros: [] }).ok,
    ).toBe(false);
    const muchos = Array.from({ length: LOTE_COBROS_MAX + 1 }, (_, i) => ({
      id: `${i}`,
      monto: 1,
      moneda: 'MXN',
    }));
    const v = puedeLigarCobros({
      montoAbono: 51,
      monedaCuenta: 'MXN',
      cobros: muchos,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.codigo).toBe('LOTE_INVALIDO');
  });

  it('leerErrorCobros: el código sale del hint o del prefijo y el detail es JSON', () => {
    const porHint = leerErrorCobros({
      code: '23514',
      hint: 'ABONO_NO_CUADRA',
      message: 'ABONO_NO_CUADRA: los 2 cobros suman 3000 y el abono es de 3500',
      details:
        '{"monto_abono":3500,"suma_cobros":3000,"diferencia":500,"tolerancia":0.02,"moneda":"MXN"}',
    });
    expect(porHint.codigo).toBe('ABONO_NO_CUADRA');
    expect(porHint.texto).toBe('los 2 cobros suman 3000 y el abono es de 3500');
    expect(porHint.details).toMatchObject({ suma_cobros: 3000 });
    const porPrefijo = leerErrorCobros({
      message: 'COBRO_YA_CONCILIADO: el cobro x',
    });
    expect(porPrefijo.codigo).toBe('COBRO_YA_CONCILIADO');
    const ajeno = leerErrorCobros({
      message: 'operator does not exist: public.moneda = text',
    });
    expect(ajeno.codigo).toBeNull();
    expect(leerErrorCobros({ details: '{no json' }).details).toBeNull();
  });

  it('mensajeErrorCobros redacta en es-MX sin uuid crudos', () => {
    const noCuadra = mensajeErrorCobros(
      'ABONO_NO_CUADRA',
      {
        monto_abono: 3500,
        suma_cobros: 3000,
        diferencia: 500,
        tolerancia: 0.02,
        moneda: 'MXN',
        cobros: [{}, {}],
      },
      '',
    );
    expect(noCuadra).toContain('Los 2 cobros suman $3,000.00 MXN');
    expect(noCuadra).toContain('faltan $500.00 MXN');
    expect(
      mensajeErrorCobros(
        'COBRO_YA_CONCILIADO',
        { folio: 379, cobro_id: A },
        '',
      ),
    ).toContain('#379');
    expect(
      mensajeErrorCobros(
        'COBRO_YA_CONCILIADO',
        { folio: 379, cobro_id: A },
        '',
      ),
    ).not.toContain(A);
    expect(
      mensajeErrorCobros('LOTE_SOLO_API_NUEVO', { cobros_n: 3 }, ''),
    ).toContain('3 cobros');
    expect(
      mensajeErrorCobros(
        'LOTE_INVALIDO',
        null,
        'la lista trae un cobro repetido',
      ),
    ).toBe('la lista trae un cobro repetido');
    for (const c of [
      'ABONO_LIGADO',
      'COBROS_INCOHERENTES',
      'SOLO_ABONOS',
      'MOVIMIENTO_YA_LIGADO',
      'REVERSO_INVALIDO',
      'COBRO_NO_EXISTE',
    ] as const) {
      expect(mensajeErrorCobros(c, null, '').length).toBeGreaterThan(10);
    }
  });

  it('ligasDesdePartes: cada parte se ve como una liga directa para la fuente única', () => {
    const ligas = ligasDesdePartes([
      {
        movimiento_id: MOV,
        cobro_id: A,
        monto_parte: 1000,
        movimiento: { id: MOV, cobro_id: null, cobro_grupo_id: null },
      },
      {
        movimiento_id: MOV,
        cobro_id: B,
        monto_parte: 2500,
        movimiento: [{ id: MOV, cobro_id: null, cobro_grupo_id: null }],
      },
    ]);
    expect(ligas).toEqual([
      { id: MOV, cobro_id: A, cobro_grupo_id: null },
      { id: MOV, cobro_id: B, cobro_grupo_id: null },
    ]);
    // `cobroEstaConciliado` / `movimientoDeCobro` las leen sin cambiar nada.
    expect(cobroEstaConciliado({ id: A }, ligas)).toBe(true);
    expect(cobroEstaConciliado({ id: B }, ligas)).toBe(true);
    expect(cobroEstaConciliado({ id: C }, ligas)).toBe(false);
    expect(movimientoDeCobro({ id: B }, ligas)?.id).toBe(MOV);
  });

  it('unirLigas no repite la misma liga aunque venga del espejo y de la puente', () => {
    const espejo = [{ id: MOV, cobro_id: A, cobro_grupo_id: null }];
    const puente = ligasDesdePartes([
      { movimiento_id: MOV, cobro_id: A, monto_parte: 10 },
    ]);
    expect(unirLigas(espejo, puente)).toHaveLength(1);
    expect(
      unirLigas(
        espejo,
        ligasDesdePartes([{ movimiento_id: MOV, cobro_id: B, monto_parte: 1 }]),
      ),
    ).toHaveLength(2);
  });

  it('diferenciaLoteCobros y la etiqueta del Excel', () => {
    expect(
      diferenciaLoteCobros(3500, [
        { monto_parte: 1000 },
        { monto_parte: 2499.99 },
      ]),
    ).toBe(0.01);
    expect(diferenciaLoteCobros(3500, [])).toBeNull();
    expect(
      etiquetaConciliadoCobros(
        [
          { folio: 379, cliente: 'Maqar', monto_parte: 1000 },
          { folio: 380, monto_parte: 2499.99 },
        ],
        0.01,
      ),
    ).toBe(
      '2 cobros: vuelo #379 · Maqar ($1,000.00) · vuelo #380 ($2,499.99) · diferencia $0.01',
    );
    expect(
      etiquetaConciliadoCobros(
        [
          { folio: 1, monto_parte: 5 },
          { folio: 2, monto_parte: 5 },
        ],
        0,
      ),
    ).toBe('2 cobros: vuelo #1 ($5.00) · vuelo #2 ($5.00)');
  });
});
