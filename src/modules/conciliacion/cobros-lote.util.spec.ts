import {
  alVincularSobre,
  cobroOcupadoParaAbono,
  cobroParaCruce,
  comisionRealParaCorregir,
  CODIGOS_ERROR_COBROS,
  diferenciaLoteCobros,
  etiquetaConciliadoCobroUnico,
  etiquetaConciliadoCobros,
  leerErrorCobros,
  ligasDesdePartes,
  LOTE_COBROS_MAX,
  mensajeAbonoDeCobroParcial,
  mensajeAbonoExcedeCobro,
  mensajeAbonoNoCuadra,
  mensajeCobroConciliado,
  mensajeCobroMonedaDistinta,
  mensajeCobroYaCubierto,
  mensajeComisionAlRegistrarCobro,
  mensajeComisionNoCuadra,
  mensajeCorregirComisionNoAplica,
  mensajeErrorCobros,
  mensajeSobreNoCuadra,
  netoDeCobro,
  puedeLigarCobros,
  sugeridosParaExcedente,
  type CobroParaLote,
  type SugeridoCobro,
  TOKEN_ABONO_NO_CUADRA,
  unirLigas,
  type CodigoErrorCobros,
} from './cobros-lote.util';
import {
  netoDeCobro as netoDeCobroComun,
  type ParteCobroBanco,
} from '../../common/cobro-banco.util';
import {
  cobroEstaConciliado,
  movimientoDeCobro,
  type MovimientoLiga,
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
        { cobro_id: A, monto_parte: 1000, faltante: 1000 },
        { cobro_id: B, monto_parte: 2500, faltante: 2500 },
      ],
      suma: 3500,
      diferencia: 0,
      tolerancia: 0.02,
    });
  });

  it('UN cobro: parte = |abono| (0.0.78: con la regla del trigger A, ya no «sin cuadre»)', () => {
    const v = puedeLigarCobros({
      montoAbono: '-3500',
      monedaCuenta: 'MXN',
      cobros: [{ id: A, monto: 3500, moneda: 'MXN', folio: 379 }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.partes).toEqual([
        { cobro_id: A, monto_parte: 3500, faltante: 3500 },
      ]);
      expect(v.tolerancia).toBe(0);
      expect(v.al_vincular?.estado).toBe('CONCILIADO');
    }
    // Lo de antes («otra moneda sola, pasa») hoy es COBRO_MONEDA_DISTINTA:
    // $3,500 MXN contra un cobro de 1,000 USD da un T.C. de 3.5.
    const cruzado = puedeLigarCobros({
      montoAbono: '-3500',
      monedaCuenta: 'MXN',
      cobros: [{ id: A, monto: 1000, moneda: 'USD', folio: 379 }],
    });
    expect(cruzado.ok).toBe(false);
    if (!cruzado.ok) {
      expect(cruzado.codigo).toBe('COBRO_MONEDA_DISTINTA');
      expect(cruzado.details).toMatchObject({
        motivo: 'TC_FUERA_DE_BANDA',
        tc_implicito: 3.5,
      });
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

  it('otra moneda dentro de un lote ⇒ LOTE_MONEDA_DISTINTA (sola, la decide el T.C.)', () => {
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
    // 0.0.78 (invariante 77): la liga conserva lo que ESE abono aporta.
    expect(ligas).toEqual([
      { id: MOV, cobro_id: A, cobro_grupo_id: null, monto_parte: 1000 },
      { id: MOV, cobro_id: B, cobro_grupo_id: null, monto_parte: 2500 },
    ]);
    // `cobroEstaConciliado` / `movimientoDeCobro` las leen sin cambiar nada.
    expect(cobroEstaConciliado({ id: A }, ligas)).toBe(true);
    expect(cobroEstaConciliado({ id: B }, ligas)).toBe(true);
    expect(cobroEstaConciliado({ id: C }, ligas)).toBe(false);
    expect(movimientoDeCobro({ id: B }, ligas)?.id).toBe(MOV);
  });

  it('unirLigas no repite la misma liga aunque venga del espejo y de la puente', () => {
    const espejo: MovimientoLiga[] = [
      { id: MOV, cobro_id: A, cobro_grupo_id: null },
    ];
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

  it('unirLigas con la PUENTE primero conserva la liga que trae monto_parte (invariante 77)', () => {
    const espejo: MovimientoLiga[] = [
      { id: MOV, cobro_id: A, cobro_grupo_id: null },
    ];
    const puente = ligasDesdePartes([
      { movimiento_id: MOV, cobro_id: A, monto_parte: 1700 },
    ]);
    expect(unirLigas(puente, espejo)).toEqual([
      { id: MOV, cobro_id: A, cobro_grupo_id: null, monto_parte: 1700 },
    ]);
  });
});

/** Los códigos que conocía el API 0.0.77 (antes de 20261014000003). */
const CODIGOS_0_0_77 = CODIGOS_ERROR_COBROS.filter(
  (c) =>
    ![
      'ABONO_EXCEDE_COBRO',
      'COMISION_NO_CUADRA',
      'COBRO_MONEDA_DISTINTA',
      'COBRO_CONCILIADO',
    ].includes(c),
);

/** El error REAL del trigger A (formato de 20261014000003: hint = código, detail jsonb). */
const ERROR_EXCEDE_BD = {
  code: '23514',
  hint: 'ABONO_EXCEDE_COBRO',
  message:
    'ABONO_EXCEDE_COBRO: con este abono el cobro del vuelo #1 quedaría pagado de más por 200.00 [ABONO_NO_CUADRA]',
  details: JSON.stringify({
    movimiento_id: MOV,
    cobro_id: A,
    folio: 1,
    moneda: 'MXN',
    monto_cobro: 1000,
    neto: 1000,
    suma_otras: 0,
    abonos_otros: 0,
    parte: 1200,
    faltante: 1000,
    excedente: 200,
    un_solo: false,
  }),
};

describe('cobros-lote.util — un cobro, varios abonos (0.0.78, invariante 77)', () => {
  it('netoDeCobro se mudó a common/cobro-banco.util y se re-exporta (la MISMA función)', () => {
    expect(netoDeCobro).toBe(netoDeCobroComun);
  });

  it('los 4 códigos nuevos van AL FINAL de la lista, después de MOVIMIENTO_OMITIDO', () => {
    expect(CODIGOS_ERROR_COBROS.slice(-5)).toEqual([
      'MOVIMIENTO_OMITIDO',
      'ABONO_EXCEDE_COBRO',
      'COMISION_NO_CUADRA',
      'COBRO_MONEDA_DISTINTA',
      'COBRO_CONCILIADO',
    ]);
    expect(TOKEN_ABONO_NO_CUADRA).toBe(' [ABONO_NO_CUADRA]');
  });

  it('leerErrorCobros del error REAL de la BD: código del hint, texto SIN la marca, detail parseado', () => {
    const r = leerErrorCobros(ERROR_EXCEDE_BD);
    expect(r.codigo).toBe('ABONO_EXCEDE_COBRO');
    expect(r.texto).toBe(
      'con este abono el cobro del vuelo #1 quedaría pagado de más por 200.00',
    );
    expect(r.texto).not.toContain('[ABONO_NO_CUADRA]');
    expect(r.details).toMatchObject({ excedente: 200, un_solo: false });
    // Sin hint: el prefijo «CODIGO:» también lo da.
    expect(leerErrorCobros({ message: ERROR_EXCEDE_BD.message }).codigo).toBe(
      'ABONO_EXCEDE_COBRO',
    );
  });

  it('compatibilidad (D17): el MISMO error leído con la lista del 0.0.77 sale ABONO_NO_CUADRA (409, no 500)', () => {
    expect(leerErrorCobros(ERROR_EXCEDE_BD, CODIGOS_0_0_77).codigo).toBe(
      'ABONO_NO_CUADRA',
    );
    for (const [hint, message] of [
      [
        'COMISION_NO_CUADRA',
        'COMISION_NO_CUADRA: el cobro del vuelo #293 espera 11870.24 después de la comisión y el abono es de 11800.00 [ABONO_NO_CUADRA]',
      ],
      [
        'COBRO_MONEDA_DISTINTA',
        'COBRO_MONEDA_DISTINTA: el cobro del vuelo #315 está en USD y el abono en MXN; el tipo de cambio que resulta (0.500000) no está entre 15 y 25 [ABONO_NO_CUADRA]',
      ],
    ] as const) {
      expect(leerErrorCobros({ hint, message }, CODIGOS_0_0_77).codigo).toBe(
        'ABONO_NO_CUADRA',
      );
      expect(leerErrorCobros({ hint, message }).codigo).toBe(hint);
    }
  });

  it('mensajeErrorCobros de los códigos nuevos: es-MX, montos con 2 decimales y moneda, sin uuid ni la marca', () => {
    const excede = mensajeErrorCobros(
      'ABONO_EXCEDE_COBRO',
      {
        movimiento_id: MOV,
        cobro_id: A,
        folio: 315,
        moneda: 'MXN',
        monto_cobro: 68205.55,
        neto: 68205.55,
        suma_otras: 0,
        abonos_otros: 0,
        parte: 69183,
        faltante: 68205.55,
        excedente: 977.45,
        un_solo: false,
      },
      'con este abono el cobro del vuelo #315 quedaría pagado de más por 977.45',
    );
    expect(excede).toBe(
      'Este abono ($69,183.00 MXN) es mayor que lo que falta del cobro del vuelo #315 ($68,205.55 MXN): sobran $977.45 MXN. Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.',
    );
    const textos: Array<[CodigoErrorCobros, Record<string, unknown>]> = [
      [
        'COMISION_NO_CUADRA',
        {
          movimiento_id: MOV,
          cobro_id: A,
          folio: 293,
          moneda: 'MXN',
          monto_cobro: 13000,
          comision_capturada: 1129.76,
          neto: 11870.24,
          parte: 11800,
          comision_real: 1200,
          por: 'PASARELA',
        },
      ],
      [
        'COBRO_MONEDA_DISTINTA',
        {
          movimiento_id: MOV,
          cobro_id: A,
          folio: 315,
          motivo: 'TC_FUERA_DE_BANDA',
          moneda_cobro: 'USD',
          moneda_cuenta: 'MXN',
          neto: 1000,
          parte: 500,
          tc_implicito: 0.5,
          tc_min: 15,
          tc_max: 25,
        },
      ],
      [
        'COBRO_CONCILIADO',
        {
          cobro_id: A,
          abonos: 2,
          campos: ['monto'],
          movimiento_ids: [MOV],
        },
      ],
      [
        'COBRO_YA_CONCILIADO',
        {
          cobro_id: A,
          folio: 315,
          motivo: 'CUBIERTO',
          neto: 3400,
          suma_ligada: 3400,
          abonos_otros: 2,
          movimiento_ids: [MOV, MOV],
          movimiento_id: MOV,
        },
      ],
      [
        'COBRO_YA_CONCILIADO',
        {
          cobro_id: A,
          folio: 293,
          motivo: 'UN_SOLO_ABONO',
          por: 'COMISION',
          movimiento_id: MOV,
        },
      ],
      ['ABONO_LIGADO', { movimiento_id: MOV, cobros_n: 1 }],
    ];
    for (const [codigo, details] of textos) {
      const t = mensajeErrorCobros(
        codigo,
        details,
        `${codigo}: x [ABONO_NO_CUADRA]`,
      );
      expect(t.length).toBeGreaterThan(30);
      expect(t).not.toContain(A);
      expect(t).not.toContain(MOV);
      expect(t).not.toContain('[ABONO_NO_CUADRA]');
      expect(t).not.toMatch(/\$\d+(?![\d,.])/); // jamás un monto sin centavos
    }
    expect(mensajeErrorCobros(textos[0][0], textos[0][1], '')).toBe(
      'El cobro del vuelo #293 ($13,000.00 MXN) espera un depósito de $11,870.24 MXN después de la comisión registrada ($1,129.76) y el banco depositó $11,800.00 MXN: la comisión real fue $1,200.00 MXN (9.23 %). Corrige la comisión del cobro o usa «Corregir la comisión a $1,200.00 y vincular».',
    );
    expect(mensajeErrorCobros(textos[1][0], textos[1][1], '')).toBe(
      'El cobro del vuelo #315 está en USD y el abono en MXN: el tipo de cambio que resulta (0.50) no tiene sentido (se espera entre 15 y 25). Revisa que sea el abono correcto.',
    );
    expect(mensajeErrorCobros(textos[2][0], textos[2][1], '')).toBe(
      'El cobro tiene abonos del banco vinculados: su monto, moneda, comisión, sobre o anticipo no cambian mientras esté conciliado; desvincúlalo en Conciliación primero.',
    );
    expect(mensajeErrorCobros(textos[3][0], textos[3][1], '')).toBe(
      'El cobro del vuelo #315 ya está conciliado completo: $3,400.00 con 2 abonos del banco. Si este abono es otro pago del mismo vuelo, regístralo como un cobro nuevo; si uno de los abonos se ligó por error, desvincúlalo en Conciliación.',
    );
    expect(mensajeErrorCobros(textos[4][0], textos[4][1], '')).toBe(
      'El cobro del vuelo #293 tiene comisión bancaria y ya tiene un abono: un cobro con comisión (link de pago) se concilia con UN solo depósito. Si el cliente pagó en dos cargos, registra un cobro por cada cargo.',
    );
    expect(mensajeErrorCobros(textos[5][0], textos[5][1], '')).toBe(
      'Este abono está conciliado con cobro(s) de vuelo: no cambia de monto ni de cuenta mientras los tenga ligados (desvincúlalos primero).',
    );
    // Un LOTE además no se deja pendiente a mano (texto de siempre, con el N).
    expect(mensajeErrorCobros('ABONO_LIGADO', { cobros_n: 3 }, '')).toContain(
      '3 cobros de vuelo: no cambia de monto ni de cuenta ni se deja pendiente',
    );
    // Sin `motivo` (BD previa / pre-validación del 0.0.77): el texto de siempre.
    expect(
      mensajeErrorCobros(
        'COBRO_YA_CONCILIADO',
        { folio: 379, cobro_id: A },
        '',
      ),
    ).toBe(
      'El cobro del vuelo #379 ya está conciliado con otro movimiento bancario: desvincúlalo ahí si fue un error, o elige otro.',
    );
  });

  it('textos de cada redacción (spec api.contratos[0].errores)', () => {
    expect(
      mensajeAbonoExcedeCobro({
        folio: 315,
        moneda: 'MXN',
        monto_cobro: 3400,
        neto: 3400,
        suma_otras: 1700,
        abonos_otros: 1,
        parte: 2000,
        faltante: 1700,
        excedente: 300,
        un_solo: false,
      }),
    ).toBe(
      'Al cobro del vuelo #315 ($3,400.00 MXN) ya le vincularon $1,700.00 MXN y le faltan $1,700.00 MXN; este abono es de $2,000.00 MXN: sobran $300.00 MXN. Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.',
    );
    expect(
      mensajeAbonoExcedeCobro({
        folio: 293,
        moneda: 'MXN',
        monto_cobro: 5000,
        neto: 4750,
        parte: 5500,
        faltante: 4750,
        excedente: 750,
        un_solo: true,
      }),
    ).toBe(
      'Este abono ($5,500.00 MXN) es mayor que el cobro del vuelo #293 ($5,000.00 MXN), que se concilia con un solo depósito: sobran $750.00 MXN sobre lo esperado. Revisa si el depósito pagó también otro vuelo o si el cobro está mal capturado.',
    );
    // Paywise sin comisión capturada: sin «después de la comisión registrada».
    expect(
      mensajeComisionNoCuadra({
        folio: 400,
        moneda: 'MXN',
        monto_cobro: 7000,
        comision_capturada: 0,
        neto: 7000,
        parte: 6305,
        comision_real: 695,
      }),
    ).toBe(
      'El cobro del vuelo #400 ($7,000.00 MXN) espera un depósito de $7,000.00 MXN y el banco depositó $6,305.00 MXN: la comisión real fue $695.00 MXN (9.93 %). Corrige la comisión del cobro o usa «Corregir la comisión a $695.00 y vincular».',
    );
    expect(
      mensajeCobroYaCubierto({
        folio: 315,
        neto: 3400,
        suma_ligada: 3400,
        abonos_otros: 2,
        moneda: 'MXN',
        abonos_detalle: [
          { fecha: '2026-09-15', monto_parte: 1700 },
          { fecha: '2026-09-15', monto_parte: 1700 },
        ],
      }),
    ).toBe(
      'El cobro del vuelo #315 ya está conciliado completo: $3,400.00 MXN con 2 abonos del banco (15 sep · $1,700.00 y 15 sep · $1,700.00). Si este abono es otro pago del mismo vuelo, regístralo como un cobro nuevo; si uno de los abonos se ligó por error, desvincúlalo en Conciliación.',
    );
    expect(
      mensajeCobroMonedaDistinta({
        folio: 315,
        motivo: 'TC_LEJOS',
        moneda_cobro: 'USD',
        moneda_cuenta: 'MXN',
        neto: 1000,
        parte: 20400,
        tc_implicito: 20.4,
        tc_referencia: 17,
        desvio_pct: 20,
      }),
    ).toBe(
      'El abono de $20,400.00 MXN contra el cobro de $1,000.00 USD del vuelo #315 da un tipo de cambio de 20.40, lejos del T.C. del cobro (17.00, +20.0 %): ¿el depósito pagó también otro cobro? Un abono en otra moneda solo concilia UN cobro completo; si así llegó el dinero, registra el cobro en la moneda del depósito.',
    );
  });

  it('Excel: lote por FALTANTE «($18,001.00 de $28,001.00 · completa el cobro)»; sin neto, como hoy', () => {
    expect(
      etiquetaConciliadoCobros(
        [
          { folio: 277, monto_parte: 50999, neto: 50999, completa: true },
          { folio: 278, monto_parte: 18001, neto: 28001, completa: true },
        ],
        0,
      ),
    ).toBe(
      '2 cobros: vuelo #277 ($50,999.00) · vuelo #278 ($18,001.00 de $28,001.00 · completa el cobro)',
    );
    expect(
      etiquetaConciliadoCobros(
        [
          { folio: 1, monto_parte: 5, neto: 9, completa: false },
          { folio: 2, monto_parte: 5 },
        ],
        0,
      ),
    ).toBe('2 cobros: vuelo #1 ($5.00 de $9.00) · vuelo #2 ($5.00)');
  });

  it('Excel: abono con UN cobro — parcial, N de N, de más y el de siempre', () => {
    const base = {
      folio: 315,
      metodo_cobro: 'TRANSFERENCIA',
      neto: 3400,
      sobrante: 0,
    };
    expect(
      etiquetaConciliadoCobroUnico({
        ...base,
        monto_parte: 1700,
        faltante: 1700,
        cubierto: false,
        abonos_n: 1,
        posicion: 1,
      }),
    ).toBe(
      'Cobro · vuelo #315 · Transferencia · pago parcial: este abono $1,700.00 de $3,400.00 (faltan $1,700.00)',
    );
    expect(
      etiquetaConciliadoCobroUnico({
        ...base,
        monto_parte: 1700,
        faltante: 0,
        cubierto: true,
        abonos_n: 2,
        posicion: 2,
      }),
    ).toBe(
      'Cobro · vuelo #315 · Transferencia · 2 de 2 abonos ($3,400.00 cubierto)',
    );
    expect(
      etiquetaConciliadoCobroUnico({
        ...base,
        neto: 68205.55,
        monto_parte: 69183,
        faltante: 0,
        sobrante: 977.45,
        cubierto: true,
        abonos_n: 1,
        posicion: 1,
      }),
    ).toBe('Cobro · vuelo #315 · Transferencia · el abono trae $977.45 de más');
    expect(
      etiquetaConciliadoCobroUnico({
        ...base,
        monto_parte: 3400,
        faltante: 0,
        cubierto: true,
        abonos_n: 1,
        posicion: 1,
      }),
    ).toBe('Cobro · vuelo #315 · Transferencia');
  });
});

/** Una parte de OTRO abono (cuenta MXN de banco salvo que se diga). */
const parteDe = (
  movimientoId: string,
  monto: number,
  extra: Partial<ParteCobroBanco> = {},
): ParteCobroBanco => ({
  movimiento_id: movimientoId,
  cobro_id: A,
  monto_parte: monto,
  moneda_cuenta: 'MXN',
  pasarela: false,
  fecha: '2026-09-15',
  created_at: '2026-09-15T12:00:00Z',
  monto_abono: monto,
  cobros_n: 1,
  cuenta_bancaria_id: 'cta',
  cuenta_alias: 'EJE SCOTIA',
  ...extra,
});

const unCobro = (
  montoAbono: number,
  c: Partial<CobroParaLote>,
  cuenta: { moneda?: string | null; tipo?: string | null } = {},
) =>
  puedeLigarCobros({
    montoAbono,
    monedaCuenta: cuenta.moneda === undefined ? 'MXN' : cuenta.moneda,
    tipoCuenta: cuenta.tipo ?? 'BANCO',
    toleranciaTcPct: 2,
    cobros: [{ id: A, monto: 0, moneda: 'MXN', folio: 315, ...c }],
  });

describe('cobros-lote.util — VINCULAR: espejo del trigger A y de la G (0.0.78, invariante 77)', () => {
  it('camionetas (UN cobro): 1,700 de 3,400 ⇒ ok PARCIAL (parte = |abono|); 2.º 1,700 ⇒ ok CONCILIADO; 3.º 100 ⇒ COBRO_YA_CONCILIADO CUBIERTO con los details de la BD', () => {
    const p1 = unCobro(1700, { monto: 3400 });
    expect(p1).toMatchObject({
      ok: true,
      partes: [{ cobro_id: A, monto_parte: 1700, faltante: 3400 }],
      tolerancia: 0,
      al_vincular: { estado: 'PARCIAL', faltante_despues: 1700 },
    });
    const p2 = unCobro(1700, { monto: 3400, otras: [parteDe('m1', 1700)] });
    expect(p2).toMatchObject({
      ok: true,
      partes: [{ cobro_id: A, monto_parte: 1700, faltante: 1700 }],
      al_vincular: { estado: 'CONCILIADO', faltante_despues: 0 },
    });
    const p3 = unCobro(100, {
      monto: 3400,
      otras: [
        parteDe('m2', 1700, { fecha: '2026-09-16' }),
        parteDe('m1', 1700),
      ],
    });
    expect(p3.ok).toBe(false);
    if (!p3.ok) {
      expect(p3.codigo).toBe('COBRO_YA_CONCILIADO');
      expect(p3.details).toMatchObject({
        cobro_id: A,
        folio: 315,
        motivo: 'CUBIERTO',
        neto: 3400,
        suma_ligada: 3400,
        abonos_otros: 2,
        movimiento_ids: ['m1', 'm2'],
        movimiento_id: 'm1',
      });
      expect(p3.details).not.toHaveProperty('por');
      expect(p3.mensaje).toBe(
        'El cobro del vuelo #315 ya está conciliado completo: $3,400.00 MXN con 2 abonos del banco (15 sep · $1,700.00 y 16 sep · $1,700.00). Si este abono es otro pago del mismo vuelo, regístralo como un cobro nuevo; si uno de los abonos se ligó por error, desvincúlalo en Conciliación.',
      );
    }
  });

  it('abono de MÁS: 69,183 contra #315 (68,205.55) ⇒ ABONO_EXCEDE_COBRO (también el primero); con abonos previos, el texto «ya le vincularon»', () => {
    const v = unCobro(69183, { monto: 68205.55 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.codigo).toBe('ABONO_EXCEDE_COBRO');
      expect(v.details).toEqual({
        cobro_id: A,
        folio: 315,
        moneda: 'MXN',
        monto_cobro: 68205.55,
        neto: 68205.55,
        suma_otras: 0,
        abonos_otros: 0,
        parte: 69183,
        faltante: 68205.55,
        excedente: 977.45,
        un_solo: false,
      });
    }
    const otra = unCobro(2000, { monto: 3400, otras: [parteDe('m1', 1700)] });
    expect(otra.ok).toBe(false);
    if (!otra.ok) {
      expect(otra.details).toMatchObject({
        suma_otras: 1700,
        abonos_otros: 1,
        faltante: 1700,
        excedente: 300,
      });
      expect(otra.mensaje).toBe(
        'Al cobro del vuelo #315 ($3,400.00 MXN) ya le vincularon $1,700.00 MXN y le faltan $1,700.00 MXN; este abono es de $2,000.00 MXN: sobran $300.00 MXN. Si el depósito también pagó otro vuelo, márcalo junto con este para que la suma cuadre con el abono; si el cobro está mal capturado, corrígelo antes de vincular.',
      );
    }
    // Dentro de la tolerancia de $1.00 sí liga.
    expect(unCobro(3401, { monto: 3400 }).ok).toBe(true);
    expect(unCobro(3401.01, { monto: 3400 }).ok).toBe(false);
  });

  it('comisión (HSBC) y pasarela (Paywise): UN abono = neto ± 1.00; COMISION_NO_CUADRA con comisión real, % y corregible; un 2.º abono ⇒ UN_SOLO_ABONO', () => {
    const hsbc = { monto: 5000, comision_banco_monto: 250 };
    expect(unCobro(4750, hsbc).ok).toBe(true);
    const no = unCobro(4000, hsbc);
    expect(no.ok).toBe(false);
    if (!no.ok) {
      expect(no.codigo).toBe('COMISION_NO_CUADRA');
      expect(no.details).toEqual({
        cobro_id: A,
        folio: 315,
        moneda: 'MXN',
        monto_cobro: 5000,
        comision_capturada: 250,
        neto: 4750,
        parte: 4000,
        comision_real: 1000,
        comision_real_pct: 20,
        por: 'COMISION',
        corregible: true,
      });
    }
    const excede = unCobro(5500, hsbc);
    expect(!excede.ok && excede.details).toMatchObject({
      un_solo: true,
      excedente: 750,
      faltante: 4750,
    });
    const segundo = unCobro(100, { ...hsbc, otras: [parteDe('m1', 4000)] });
    expect(!segundo.ok && segundo.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      por: 'COMISION',
    });
    const pw = { monto: 13000, comision_banco_monto: 1129.76, folio: 293 };
    expect(unCobro(11870.24, pw, { tipo: 'PASARELA' }).ok).toBe(true);
    const pwNo = unCobro(11800, pw, { tipo: 'PASARELA' });
    expect(!pwNo.ok && pwNo.details).toMatchObject({
      por: 'PASARELA',
      comision_real: 1200,
      comision_real_pct: 9.23,
      corregible: true,
    });
    expect(
      !pwNo.ok &&
        pwNo.mensaje.endsWith(
          'Corrige la comisión del cobro o usa «Corregir la comisión a $1,200.00 y vincular».',
        ),
    ).toBe(true);
    // Sin comisión capturada pero abono de la PASARELA: también «de un solo abono».
    const sinCom = unCobro(6305, { monto: 7000 }, { tipo: 'PASARELA' });
    expect(!sinCom.ok && sinCom.codigo).toBe('COMISION_NO_CUADRA');
    expect(!sinCom.ok && sinCom.details).toMatchObject({
      comision_real: 695,
      por: 'PASARELA',
    });
    // Un parcial de banco no admite un abono de la pasarela.
    const mixto = unCobro(
      1700,
      { monto: 3400, otras: [parteDe('m1', 1700)] },
      { tipo: 'PASARELA' },
    );
    expect(!mixto.ok && mixto.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      por: 'PASARELA',
    });
  });

  it('otra moneda (1↔1): banda 15–25 y ±2 % del T.C. del cobro (o del vuelo); sin tolerancia, solo la banda', () => {
    const usd = { monto: 1000, moneda: 'USD', tc_usd_mxn: 17 };
    expect(unCobro(17000, usd).ok).toBe(true);
    expect(unCobro(17340, usd).ok).toBe(true); // +2.0 % es CERCA
    const lejos = unCobro(17360, usd);
    expect(!lejos.ok && lejos.details).toMatchObject({
      motivo: 'TC_LEJOS',
      tc_implicito: 17.36,
      tc_referencia: 17,
      desvio_pct: 2.1,
      tc_referencia_origen: 'COBRO',
    });
    const delVuelo = unCobro(20400, {
      monto: 1000,
      moneda: 'USD',
      tc_vuelo: 17,
    });
    expect(!delVuelo.ok && delVuelo.details).toMatchObject({
      motivo: 'TC_LEJOS',
      tc_referencia_origen: 'VUELO',
      desvio_pct: 20,
    });
    const banda = unCobro(500, usd);
    expect(!banda.ok && banda.details).toMatchObject({
      motivo: 'TC_FUERA_DE_BANDA',
      tc_implicito: 0.5,
      tc_min: 15,
      tc_max: 25,
    });
    // Sin referencia: solo la banda.
    expect(unCobro(20400, { monto: 1000, moneda: 'USD' }).ok).toBe(true);
    // Sin `toleranciaTcPct` (como la BD): solo la banda aunque haya T.C.
    expect(
      puedeLigarCobros({
        montoAbono: 20400,
        monedaCuenta: 'MXN',
        cobros: [{ id: A, monto: 1000, moneda: 'USD', tc_usd_mxn: 17 }],
      }).ok,
    ).toBe(true);
    // Un abono en otra moneda a un cobro con otro abono ⇒ UN_SOLO_ABONO.
    const segundo = unCobro(17000, {
      ...usd,
      otras: [parteDe('m1', 100, { moneda_cuenta: 'USD' })],
    });
    expect(!segundo.ok && segundo.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      por: 'MONEDA_DISTINTA',
    });
  });

  it('LOTE por FALTANTE: #315 + #332; Villanueva; un cobro con abono previo entra por lo que le falta y el texto lo dice', () => {
    const lote = puedeLigarCobros({
      montoAbono: 69183,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 68205.55, moneda: 'MXN', folio: 315 },
        { id: B, monto: 977.45, moneda: 'MXN', folio: 332 },
      ],
    });
    expect(lote).toMatchObject({
      ok: true,
      suma: 69183,
      diferencia: 0,
      partes: [
        { cobro_id: A, monto_parte: 68205.55, faltante: 68205.55 },
        { cobro_id: B, monto_parte: 977.45, faltante: 977.45 },
      ],
    });
    const d5 = puedeLigarCobros({
      montoAbono: 69000,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 50999, moneda: 'MXN', folio: 277 },
        {
          id: B,
          monto: 30000,
          moneda: 'MXN',
          folio: 278,
          otras: [parteDe('mP', 11999, { cobro_id: B })],
        },
      ],
    });
    expect(d5).toMatchObject({
      ok: true,
      partes: [
        { cobro_id: A, monto_parte: 50999 },
        { cobro_id: B, monto_parte: 18001, faltante: 18001 },
      ],
    });
    const noCuadra = puedeLigarCobros({
      montoAbono: 69000,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 40999, moneda: 'MXN', folio: 277 },
        {
          id: B,
          monto: 28001,
          moneda: 'MXN',
          folio: 278,
          otras: [parteDe('mP', 10000, { cobro_id: B })],
        },
      ],
    });
    expect(noCuadra.ok).toBe(false);
    if (!noCuadra.ok) {
      expect(noCuadra.codigo).toBe('ABONO_NO_CUADRA');
      expect(noCuadra.details).toMatchObject({
        monto_abono: 69000,
        suma_cobros: 59000,
        diferencia: 10000,
      });
      expect((noCuadra.details.cobros as unknown[])[1]).toEqual({
        id: B,
        folio: 278,
        monto: 28001,
        neto: 28001,
        suma_otras: 10000,
        abonos_otros: 1,
        faltante: 18001,
        parte: 18001,
      });
      expect(noCuadra.mensaje).toContain(
        'A los 2 cobros les faltan $59,000.00 MXN (lo que le falta a cada uno)',
      );
    }
    const cubierto = puedeLigarCobros({
      montoAbono: 69000,
      monedaCuenta: 'MXN',
      cobros: [
        { id: A, monto: 40999, moneda: 'MXN' },
        {
          id: B,
          monto: 28001,
          moneda: 'MXN',
          otras: [parteDe('mP', 28001, { cobro_id: B })],
        },
      ],
    });
    expect(!cubierto.ok && cubierto.details).toMatchObject({
      cobro_id: B,
      motivo: 'CUBIERTO',
      movimiento_id: 'mP',
    });
    const unSolo = puedeLigarCobros({
      montoAbono: 69000,
      monedaCuenta: 'MXN',
      tipoCuenta: 'PASARELA',
      cobros: [
        { id: A, monto: 40999, moneda: 'MXN' },
        {
          id: B,
          monto: 38001,
          moneda: 'MXN',
          otras: [parteDe('mP', 10000, { cobro_id: B })],
        },
      ],
    });
    expect(!unSolo.ok && unSolo.details).toMatchObject({
      motivo: 'UN_SOLO_ABONO',
      por: 'PASARELA',
    });
  });

  it('mensajeAbonoNoCuadra: con un cobro que ya tenía abonos, el texto por faltante (spec); sin eso, el de siempre byte a byte; leído de la BD igual', () => {
    expect(
      mensajeAbonoNoCuadra({
        n: 2,
        suma: 2677.45,
        monto_abono: 2700,
        diferencia: 22.55,
        tolerancia: 0.02,
        moneda: 'MXN',
        porFaltante: true,
      }),
    ).toBe(
      'A los 2 cobros les faltan $2,677.45 MXN (lo que le falta a cada uno) y el abono es de $2,700.00 MXN: sobran $22.55 MXN (se admite hasta $0.02 de diferencia por redondeos). Revisa qué cobros paga este abono o corrige el monto o la comisión de alguno.',
    );
    const hoy = mensajeAbonoNoCuadra({
      n: 2,
      suma: 1500,
      monto_abono: 3500,
      diferencia: 2000,
      tolerancia: 0.02,
      moneda: 'MXN',
    });
    expect(hoy).toBe(
      'Los 2 cobros suman $1,500.00 MXN y el abono es de $3,500.00 MXN: faltan $2,000.00 MXN (se admite hasta $0.02 MXN de diferencia por redondeos). Revisa qué cobros paga este abono o corrige el monto o la comisión de alguno.',
    );
    const deBd = {
      monto_abono: 2700,
      suma_cobros: 2677.45,
      diferencia: 22.55,
      tolerancia: 0.02,
      moneda: 'MXN',
      cobros: [{ abonos_otros: 0 }, { abonos_otros: 1 }],
    };
    expect(mensajeErrorCobros('ABONO_NO_CUADRA', deBd, '')).toContain(
      '(lo que le falta a cada uno)',
    );
    expect(
      mensajeErrorCobros(
        'ABONO_NO_CUADRA',
        { ...deBd, cobros: [{ abonos_otros: 0 }, { abonos_otros: 0 }] },
        '',
      ),
    ).toContain('Los 2 cobros suman $2,677.45 MXN');
  });

  it('comisionRealParaCorregir: monto − depósito (un centavo de ruido ⇒ 0); depósito mayor ⇒ DEPOSITO_MAYOR; sin depósito ⇒ DEPOSITO_INVALIDO', () => {
    expect(comisionRealParaCorregir(13000, 11800)).toEqual({
      valida: true,
      comision: 1200,
      motivo: null,
    });
    expect(comisionRealParaCorregir(5000, 5000.01)).toEqual({
      valida: true,
      comision: 0,
      motivo: null,
    });
    expect(comisionRealParaCorregir(5000, 5000.5)).toMatchObject({
      valida: false,
      motivo: 'DEPOSITO_MAYOR',
    });
    expect(comisionRealParaCorregir(100, 0)).toMatchObject({
      valida: false,
      motivo: 'DEPOSITO_INVALIDO',
    });
    expect(mensajeCorregirComisionNoAplica('CON_ABONOS')).toBe(
      'La comisión solo se corrige al vincular UN cobro de vuelo que todavía no tiene abonos, cuando el depósito es menor o igual que el cobro.',
    );
    expect(mensajeCorregirComisionNoAplica('MONEDA_DISTINTA')).toContain(
      'otra moneda',
    );
  });

  it('sugeridosParaExcedente: faltante ≈ excedente (±0.02), por cercanía de fecha, sin excluidos ni repetidos, ≤ 3', () => {
    const s = (id: string, faltante: number, fecha: string): SugeridoCobro => ({
      cobro_id: id,
      vuelo_id: `v-${id}`,
      folio: null,
      cliente: null,
      fecha_cobro: fecha,
      monto: faltante,
      moneda: 'MXN',
      faltante,
    });
    const universo = [
      s('lejos', 977.45, '2026-08-01T17:00:00Z'),
      s('c332', 977.45, '2026-09-14T17:00:00Z'),
      s('casi', 977.47, '2026-09-20T17:00:00Z'),
      s('fuera', 977.48, '2026-09-15T17:00:00Z'),
      s('c315', 977.45, '2026-09-15T17:00:00Z'),
      s('otro', 977.44, '2026-09-10T17:00:00Z'),
      s('c332', 977.45, '2026-09-14T17:00:00Z'),
    ];
    expect(
      sugeridosParaExcedente(universo, 977.45, '2026-09-15', ['c315']).map(
        (x) => x.cobro_id,
      ),
    ).toEqual(['c332', 'otro', 'casi']);
    expect(sugeridosParaExcedente(universo, 0, '2026-09-15')).toEqual([]);
  });

  it('cobroOcupadoParaAbono: sin la sonda, cualquier otra liga ocupa; con ella, solo cubierto, cruzado o un abono de la pasarela', () => {
    const c = { monto: 3400, moneda: 'MXN' };
    const sin = { conParciales: false, pasarela: false };
    const con = { conParciales: true, pasarela: false };
    expect(cobroOcupadoParaAbono(c, [], 'm2', sin)).toBe(false);
    expect(cobroOcupadoParaAbono(c, [parteDe('m2', 1700)], 'm2', sin)).toBe(
      false,
    );
    expect(cobroOcupadoParaAbono(c, [parteDe('m1', 1700)], 'm2', sin)).toBe(
      true,
    );
    expect(cobroOcupadoParaAbono(c, [parteDe('m1', 1700)], 'm2', con)).toBe(
      false,
    );
    expect(cobroOcupadoParaAbono(c, [parteDe('m1', 3400)], 'm2', con)).toBe(
      true,
    );
    expect(
      cobroOcupadoParaAbono(
        c,
        [parteDe('m1', 100, { moneda_cuenta: 'USD' })],
        'm2',
        con,
      ),
    ).toBe(true);
    expect(
      cobroOcupadoParaAbono(c, [parteDe('m1', 1700)], 'm2', {
        conParciales: true,
        pasarela: true,
      }),
    ).toBe(true);
  });

  it('cobroParaCruce (D11/D12): sin abonos ⇒ libre por neto/bruto; parcial de BANCO ⇒ libre por su faltante; cubierto, cruzado, pasarela o «de un solo abono» ⇒ ocupado', () => {
    const c = { monto: 3400, moneda: 'MXN', metodo_cobro: 'TRANSFERENCIA' };
    const con = { conParciales: true, pasarela: false };
    expect(cobroParaCruce(c, [], null, con)).toEqual({
      libre: true,
      faltante: null,
    });
    // Beh Kay: un SPEI de 1,700 ⇒ le faltan 1,700.
    expect(cobroParaCruce(c, [parteDe('m1', 1700)], null, con)).toEqual({
      libre: true,
      faltante: 1700,
    });
    // Su PROPIA parte no cuenta (re-liga idéntica).
    expect(cobroParaCruce(c, [parteDe('m2', 1700)], 'm2', con)).toEqual({
      libre: true,
      faltante: null,
    });
    // Cubierto (dentro de $1.00) o con un abono en otra moneda ⇒ ocupado.
    expect(cobroParaCruce(c, [parteDe('m1', 3399)], null, con).libre).toBe(
      false,
    );
    expect(
      cobroParaCruce(
        c,
        [parteDe('m1', 100, { moneda_cuenta: 'USD' })],
        null,
        con,
      ).libre,
    ).toBe(false);
    // Un abono de la PASARELA no completa parciales.
    expect(
      cobroParaCruce(c, [parteDe('m1', 1700)], null, {
        conParciales: true,
        pasarela: true,
      }).libre,
    ).toBe(false);
    // «De un solo abono»: comisión capturada, método Paywise o un abono
    // previo de la pasarela.
    expect(
      cobroParaCruce(
        { ...c, comision_banco_monto: 250 },
        [parteDe('m1', 1700)],
        null,
        con,
      ).libre,
    ).toBe(false);
    expect(
      cobroParaCruce(
        { ...c, metodo_cobro: 'PAYWISE' },
        [parteDe('m1', 1700)],
        null,
        con,
      ).libre,
    ).toBe(false);
    expect(
      cobroParaCruce(c, [parteDe('m1', 1700, { pasarela: true })], null, con)
        .libre,
    ).toBe(false);
    // Sin la sonda de 20261014000003: cualquier otro abono ocupa (0.0.77).
    expect(
      cobroParaCruce(c, [parteDe('m1', 1700)], null, {
        conParciales: false,
        pasarela: false,
      }),
    ).toEqual({ libre: false, faltante: null });
    // El lote de $69,000: $30,000 con $11,999 previos ⇒ le faltan $18,001.
    expect(
      cobroParaCruce(
        { monto: 30000, moneda: 'MXN', metodo_cobro: 'TRANSFERENCIA' },
        [parteDe('m-previo', 11999)],
        null,
        con,
      ),
    ).toEqual({ libre: true, faltante: 18001 });
  });

  it('mensajeAbonoDeCobroParcial: el 409 de Ingresos dice cuánto le falta al cobro (otro ingreso / otro cobro)', () => {
    const d = {
      folio: 315,
      moneda: 'MXN',
      monto: 3400,
      monto_vinculado: 1700,
      abonos_n: 1,
      faltante: 1700,
    };
    expect(mensajeAbonoDeCobroParcial(d, 'INGRESO')).toBe(
      'El cobro del vuelo #315 ($3,400.00 MXN) ya tiene un abono de $1,700.00 y le faltan $1,700.00: vincula este abono a ese cobro en vez de registrarlo como ingreso.',
    );
    expect(mensajeAbonoDeCobroParcial(d, 'COBRO')).toBe(
      'El cobro del vuelo #315 ($3,400.00 MXN) ya tiene un abono de $1,700.00 y le faltan $1,700.00: vincula este abono a ese cobro en vez de registrar otro cobro.',
    );
    expect(
      mensajeAbonoDeCobroParcial(
        {
          ...d,
          folio: null,
          monto: 30000,
          monto_vinculado: 11999,
          abonos_n: 2,
          faltante: 18001,
        },
        'INGRESO',
      ),
    ).toBe(
      'El cobro del vuelo #? ($30,000.00 MXN) ya tiene 2 abonos por $11,999.00 y le faltan $18,001.00: vincula este abono a ese cobro en vez de registrarlo como ingreso.',
    );
  });

  it('mensajeComisionAlRegistrarCobro: «Es el pago de un vuelo» con una comisión que el banco no descontó (o sin la real de la pasarela)', () => {
    expect(
      mensajeComisionAlRegistrarCobro({
        moneda: 'MXN',
        comision_capturada: 250,
        neto: 4750,
        parte: 5000,
        comision_real: 0,
      }),
    ).toBe(
      'Con la comisión de $250.00 el banco tendría que haber depositado $4,750.00 MXN, pero depositó $5,000.00 MXN: el banco no descontó comisión. Déjala en 0 y vuelve a registrar el pago (un cobro con comisión se concilia con un depósito igual a su neto).',
    );
    expect(
      mensajeComisionAlRegistrarCobro({
        moneda: 'MXN',
        comision_capturada: 0,
        neto: 10000,
        parte: 9000,
        comision_real: 1000,
      }),
    ).toBe(
      'Sin comisión el depósito tendría que ser de $10,000.00 MXN, pero depositó $9,000.00 MXN: la comisión real es $1,000.00. Captura esa comisión y vuelve a registrar el pago (un cobro con comisión se concilia con un depósito igual a su neto).',
    );
  });

  it('alVincularSobre + mensajeSobreNoCuadra: banco en la moneda del sobre ⇒ neto ± 1.00; pasarela u otra moneda, como hoy', () => {
    const sobre = { monto: 11500, moneda: 'MXN', comision_banco_monto: 699.24 };
    expect(
      alVincularSobre({
        montoAbono: 10000,
        monedaCuenta: 'MXN',
        tipoCuenta: 'BANCO',
        sobre,
      }),
    ).toEqual({
      estado: 'SOBRE_NO_CUADRA',
      diferencia: -800.76,
      neto: 10800.76,
    });
    expect(
      alVincularSobre({
        montoAbono: 10801.76,
        monedaCuenta: 'MXN',
        tipoCuenta: 'BANCO',
        sobre,
      }).estado,
    ).toBe('CONCILIADO');
    expect(
      alVincularSobre({
        montoAbono: 10801.77,
        monedaCuenta: 'MXN',
        tipoCuenta: 'BANCO',
        sobre,
      }).estado,
    ).toBe('SOBRE_NO_CUADRA');
    expect(
      alVincularSobre({
        montoAbono: 10000,
        monedaCuenta: 'MXN',
        tipoCuenta: 'PASARELA',
        sobre,
      }).estado,
    ).toBe('CONCILIADO');
    expect(
      alVincularSobre({
        montoAbono: 600,
        monedaCuenta: 'USD',
        tipoCuenta: 'BANCO',
        sobre,
      }).estado,
    ).toBe('CONCILIADO');
    expect(
      mensajeSobreNoCuadra({
        grupo_folio: 12,
        monto_abono: 10000,
        neto_sobre: 10800.76,
        diferencia: -800.76,
        moneda: 'MXN',
        con_comision: true,
      }),
    ).toBe(
      'El abono ($10,000.00 MXN) no cuadra con el sobre del grupo G-12 ($10,800.76 MXN después de la comisión): faltan $800.76 MXN. Revisa que sea el depósito del grupo o corrige el sobre antes de vincular.',
    );
    expect(
      mensajeSobreNoCuadra({
        grupo_folio: 12,
        monto_abono: 11000,
        neto_sobre: 10800.76,
        diferencia: 199.24,
        moneda: 'MXN',
      }),
    ).toContain('($10,800.76 MXN): sobran $199.24 MXN.');
  });

  it('mensajeCobroConciliado (candado del API): parcial, 2 abonos, 1 abono, sobre; sin datos = el de la carrera con el trigger E', () => {
    expect(
      mensajeCobroConciliado({
        via: 'DIRECTO',
        parcial: true,
        abonos: [{ fecha: '2026-09-15', monto_parte: 1700 }],
        monto_vinculado: 1700,
        neto: 3400,
        moneda: 'MXN',
      }),
    ).toBe(
      'Este cobro está conciliado PARCIAL con el banco ($1,700.00 MXN de $3,400.00 MXN, abono del 15 sep). Para cambiar su monto, moneda, tipo de cambio o comisión, o para eliminarlo, primero desvincula ese abono en Conciliación.',
    );
    expect(
      mensajeCobroConciliado({
        via: 'DIRECTO',
        parcial: false,
        abonos: [
          { fecha: '2026-09-15', monto_parte: 1700 },
          { fecha: '2026-09-15', monto_parte: 1700 },
        ],
        monto_vinculado: 3400,
        neto: 3400,
        moneda: 'MXN',
      }),
    ).toBe(
      'Este cobro está conciliado con 2 abonos del banco (15 sep · $1,700.00 y 15 sep · $1,700.00). Para cambiar su dinero o eliminarlo, primero desvincula esos abonos en Conciliación.',
    );
    expect(
      mensajeCobroConciliado({
        via: 'DIRECTO',
        abonos: [{ fecha: '2026-09-15', monto_parte: 3400 }],
      }),
    ).toBe(
      'Este cobro está conciliado con un movimiento bancario. Desvincúlalo primero en Conciliación.',
    );
    expect(mensajeCobroConciliado({ via: 'SOBRE' })).toBe(
      'Este cobro es parte de un sobre de grupo conciliado con un movimiento bancario. Desvincula el sobre primero en Conciliación.',
    );
    expect(mensajeCobroConciliado()).toBe(
      mensajeErrorCobros('COBRO_CONCILIADO', null, ''),
    );
  });

  it('mensajeComisionNoCuadra: no corregible ⇒ no ofrece el botón; depósito mayor que el cobro ⇒ revisar la comisión', () => {
    const base = {
      folio: 293,
      moneda: 'MXN',
      monto_cobro: 13000,
      comision_capturada: 1129.76,
      neto: 11870.24,
      parte: 11800,
      comision_real: 1200,
    };
    expect(
      mensajeComisionNoCuadra({ ...base, corregible: false }),
    ).not.toContain('Corregir la comisión a');
    expect(mensajeComisionNoCuadra({ ...base, corregible: true })).toContain(
      '«Corregir la comisión a $1,200.00 y vincular»',
    );
    expect(
      mensajeComisionNoCuadra({ ...base, parte: 13000.5, comision_real: 0 }),
    ).toContain('más que el cobro');
  });

  it('ningún texto nuevo lleva uuid ni la marca « [ABONO_NO_CUADRA]»', () => {
    const textos = [
      unCobro(69183, { monto: 68205.55 }),
      unCobro(4000, { monto: 5000, comision_banco_monto: 250 }),
      unCobro(100, { monto: 3400, otras: [parteDe('m1', 3400)] }),
      unCobro(500, { monto: 1000, moneda: 'USD' }),
    ].map((v) => (v.ok ? '' : v.mensaje));
    for (const t of textos) {
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toContain(A);
      expect(t).not.toContain('[ABONO_NO_CUADRA]');
    }
  });
});
