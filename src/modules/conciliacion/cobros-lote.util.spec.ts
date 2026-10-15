import {
  CODIGOS_ERROR_COBROS,
  diferenciaLoteCobros,
  etiquetaConciliadoCobroUnico,
  etiquetaConciliadoCobros,
  leerErrorCobros,
  ligasDesdePartes,
  LOTE_COBROS_MAX,
  mensajeAbonoExcedeCobro,
  mensajeCobroMonedaDistinta,
  mensajeCobroYaCubierto,
  mensajeComisionNoCuadra,
  mensajeErrorCobros,
  netoDeCobro,
  puedeLigarCobros,
  TOKEN_ABONO_NO_CUADRA,
  unirLigas,
  type CodigoErrorCobros,
} from './cobros-lote.util';
import { netoDeCobro as netoDeCobroComun } from '../../common/cobro-banco.util';
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
