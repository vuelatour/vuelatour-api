import {
  candidatoOtroVueloDelCliente,
  cobradoDeMas,
  cobrosParaCobradoDeMas,
  comisionesCobrosUsd,
  entradaCobradoDeMas,
  ETIQUETA_CAUSA_COBRADO_DE_MAS,
  esCobroSinBancoDeOtroVuelo,
  necesitaOtrosCobrosCliente,
  QUE_HACER_COBRADO_DE_MAS,
  tcPrincipalDeCobros,
  ventanaOtrosCobrosCliente,
  type CobradoDeMas,
  type EntradaCobradoDeMas,
  type OtroCobroDelCliente,
} from './cobrado-de-mas.util';
import { cobrosEnUsd } from './cobros-usd.util';
import { particionIngresoVuelo, sobrecobroUsd } from './ingreso-vuelo.util';
import {
  COBRO_332_977,
  COBROS_315_ANTES,
  cobrosDe,
  ESPERADO_REAL,
  VUELOS_REALES,
  type FilaReal,
} from './cobrado-de-mas.fixture-spec';

/**
 * «COBRADO DE MÁS» CON CAUSA (14-oct-2026, API 0.0.78, invariante 77, D13).
 * Se congela con los 7 vuelos REALES del pedido (prod, 15-oct-2026): solo
 * #217 y #193 (IVA que la cotización no lleva) piden revisión; #81/#84
 * (comisión del link pagada por el cliente) y #259/#111/#285 (redondeo del
 * T.C.) quedan «explicados». El monto es la MISMA cifra que el balance manda
 * a «otros movimientos» (`sobrecobroUsd`), los textos dicen «Posible causa»
 * y la causa sigue el orden de D13.
 */

/** La entrada de un vuelo REAL con su propio T.C. de respaldo (la cadena del snapshot). */
function entradaReal(
  folio: number,
  cobros: FilaReal[] = cobrosDe(folio),
  extra: Partial<Parameters<typeof entradaCobradoDeMas>[0]> = {},
): EntradaCobradoDeMas {
  const v = VUELOS_REALES[folio];
  return entradaCobradoDeMas({
    vuelo: v,
    cobros,
    tcFallback: Number(v.tc_usd_mxn) || null,
    ...extra,
  });
}

/** Entrada mínima a mano (bordes y casos sintéticos). */
function entrada(e: Partial<EntradaCobradoDeMas>): EntradaCobradoDeMas {
  return {
    total_usd: 1000,
    cobrado_usd: 1000,
    sin_tc_count: 0,
    sin_tc_mxn: 0,
    estado_vuelo: 'COMPLETADO',
    cotizacion_abierta: false,
    iva_total_usd: 0,
    comisiones_usd: 0,
    cobros: [
      {
        id: 'c1',
        monto: 1000,
        moneda: 'USD',
        usd: 1000,
        metodo: 'TRANSFERENCIA',
        fecha_cobro: '2026-09-15T17:00:00Z',
        parte_de_sobre: false,
        tc_usd_mxn: null,
      },
    ],
    tc_vuelo: null,
    ...e,
  };
}

describe('cobradoDeMas — los 7 vuelos REALES del pedido (prod 15-oct-2026)', () => {
  it.each(ESPERADO_REAL)(
    '#$folio ⇒ $causa ($excedente)',
    ({ folio, causa, excedente, requiere_revision }) => {
      const r = cobradoDeMas(entradaReal(folio));
      if (causa === null) {
        expect(r).toBeNull();
        return;
      }
      expect(r).toMatchObject({
        causa,
        excedente_usd: excedente,
        requiere_revision,
        tono: requiere_revision ? 'AVISO' : 'INFO',
        causa_etiqueta:
          ETIQUETA_CAUSA_COBRADO_DE_MAS[
            causa as keyof typeof ETIQUETA_CAUSA_COBRADO_DE_MAS
          ],
      });
    },
  );

  it('solo #217 y #193 requieren revisión (los demás quedan explicados)', () => {
    const revisar = ESPERADO_REAL.filter(
      ({ folio }) => cobradoDeMas(entradaReal(folio))?.requiere_revision,
    ).map((x) => x.folio);
    expect(revisar).toEqual([193, 217]);
  });

  it('paridad del MONTO con el balance: excedente === sobrecobroUsd(cobrosEnUsd, particionIngresoVuelo) en los 7', () => {
    for (const { folio, causa } of ESPERADO_REAL) {
      if (causa === null) continue;
      const v = VUELOS_REALES[folio];
      const cobrado = cobrosEnUsd(
        cobrosDe(folio),
        Number(v.tc_usd_mxn),
      ).total_usd;
      const balance = sobrecobroUsd(cobrado, particionIngresoVuelo(v));
      const r = cobradoDeMas(entradaReal(folio))!;
      expect([folio, r.excedente_usd]).toEqual([folio, balance]);
      expect([folio, r.cobrado_usd]).toEqual([folio, cobrado]);
    }
  });

  it('#217 — IVA que la cotización no lleva: textos exactos (es-MX, «Posible causa»)', () => {
    const r = cobradoDeMas(entradaReal(217))!;
    expect(r).toEqual<CobradoDeMas>({
      excedente_usd: 495.99,
      cobrado_usd: 3595.99,
      total_usd: 3100,
      causa: 'IVA_NO_COTIZADO',
      causa_etiqueta: 'IVA que la cotización no lleva',
      requiere_revision: true,
      tono: 'AVISO',
      titulo: 'Cobrado de más: $495.99 USD',
      explicacion:
        'Lo cobrado ($3,595.99 USD) rebasa el monto total ($3,100 USD). Posible causa: el cliente pagó el total más 16 % de IVA ($3,100 × 1.16 = $3,596 USD) y esta cotización no lleva IVA.',
      que_hacer:
        'Si se le facturó con IVA, corrige la cotización para que lleve IVA (así el IVA no cuenta como venta). Si no se le facturó, el cliente tiene un saldo a favor: regístralo como reembolso o aplícalo a su siguiente vuelo.',
      referencia: null,
      sin_tc: null,
    });
  });

  it('#193 — IVA no cotizado por $52 (el 16 % exacto de $325)', () => {
    const r = cobradoDeMas(entradaReal(193))!;
    expect(r.titulo).toBe('Cobrado de más: $52 USD');
    expect(r.explicacion).toBe(
      'Lo cobrado ($377 USD) rebasa el monto total ($325 USD). Posible causa: el cliente pagó el total más 16 % de IVA ($325 × 1.16 = $377 USD) y esta cotización no lleva IVA.',
    );
  });

  it('#81 — comisión del link pagada por el cliente (Σ comisiones $214.27 contra $214.26): INFO sin nada que corregir', () => {
    const e = entradaReal(81);
    expect(e.comisiones_usd).toBe(214.27);
    const r = cobradoDeMas(e)!;
    expect(r).toMatchObject({
      causa: 'COMISION_PAGADA_POR_CLIENTE',
      tono: 'INFO',
      titulo: 'Cobrado de más: $214.26 USD',
      explicacion:
        'Es la comisión del link de pago, que pagó el cliente: sin la comisión, lo cobrado cuadra con el total.',
      que_hacer: 'No hay nada que corregir.',
      referencia: null,
    });
  });

  it('#84 — también cuadra con el 16 % del total ($202.72), pero el ORDEN dice comisión', () => {
    const e = entradaReal(84);
    expect(e.iva_total_usd).toBe(0);
    expect(Math.round(1267.01 * 0.16 * 100) / 100).toBe(202.72);
    expect(cobradoDeMas(e)?.causa).toBe('COMISION_PAGADA_POR_CLIENTE');
    // Sin la comisión capturada, la MISMA cifra sería IVA no cotizado.
    expect(cobradoDeMas({ ...e, comisiones_usd: 0 })?.causa).toBe(
      'IVA_NO_COTIZADO',
    );
  });

  it('#111 — lleva IVA (120) y comisión $32.19 que no explica $1.71 ⇒ redondeo del T.C. (texto exacto)', () => {
    const e = entradaReal(111);
    expect(e.iva_total_usd).toBe(120);
    expect(e.comisiones_usd).toBe(32.19);
    const r = cobradoDeMas(e)!;
    expect(r).toMatchObject({
      causa: 'REDONDEO_TC',
      excedente_usd: 1.71,
      explicacion:
        'Diferencia por tipo de cambio o redondeo del pago en pesos (menos de $10 USD).',
      que_hacer: 'No hay nada que corregir.',
    });
  });

  it('#259 — $8.47 con dos cobros en pesos de montos distintos (no es duplicado) ⇒ redondeo', () => {
    expect(cobradoDeMas(entradaReal(259))?.causa).toBe('REDONDEO_TC');
  });

  it('#92 (mismo cliente que #81/#84) cobró de MENOS ⇒ sin aviso', () => {
    expect(cobradoDeMas(entradaReal(92))).toBeNull();
  });
});

describe('cobradoDeMas — #315 de Beh Kay antes y después de la corrección del 14-oct-2026', () => {
  const OTRO_332: OtroCobroDelCliente = {
    vuelo_id: VUELOS_REALES[332].id as string,
    folio: 332,
    cobro_id: COBRO_332_977,
    monto: 977.45,
    moneda: 'MXN',
    fecha_cobro: '2026-09-15T17:00:00+00:00',
  };

  it('ANTES sin la lectura de otros vuelos ⇒ SIN_CAUSA_CLARA $56.99 (AVISO) y pide la lectura', () => {
    const r = cobradoDeMas(entradaReal(315, COBROS_315_ANTES))!;
    expect(r).toMatchObject({
      causa: 'SIN_CAUSA_CLARA',
      excedente_usd: 56.99,
      cobrado_usd: 4232.24,
      total_usd: 4175.25,
      tono: 'AVISO',
      requiere_revision: true,
      explicacion:
        'Lo cobrado ($4,232.24 USD) rebasa el monto total ($4,175.25 USD) y no se ve una causa clara.',
      que_hacer: QUE_HACER_COBRADO_DE_MAS.SIN_CAUSA_CLARA,
    });
    expect(necesitaOtrosCobrosCliente(r)).toBe(true);
  });

  it('ANTES con el cobro sin banco de $977.45 del #332 ⇒ OTRO_VUELO_DEL_CLIENTE con la referencia (56.99 × 17.15 = 977.38 ±1)', () => {
    const r = cobradoDeMas(
      entradaReal(315, COBROS_315_ANTES, { otrosCobrosCliente: [OTRO_332] }),
    )!;
    expect(r).toMatchObject({
      causa: 'OTRO_VUELO_DEL_CLIENTE',
      causa_etiqueta: 'pago de otro vuelo del cliente',
      excedente_usd: 56.99,
      requiere_revision: true,
      tono: 'AVISO',
      explicacion:
        'Lo cobrado ($4,232.24 USD) rebasa el monto total ($4,175.25 USD). Posible causa: el cobro de $977.45 MXN del vuelo #332 del mismo cliente sigue sin banco y equivale a lo cobrado de más: puede que un cobro de este vuelo incluya el pago de ese vuelo.',
      que_hacer:
        'En Conciliación desvincula el depósito, corrige el cobro de este vuelo para que solo lleve lo suyo y vuelve a vincular el depósito marcando los cobros de los dos vuelos.',
      referencia: {
        vuelo_id: VUELOS_REALES[332].id,
        folio: 332,
        cobro_id: COBRO_332_977,
        monto: 977.45,
        moneda: 'MXN',
      },
    });
  });

  it('ANTES con DOS candidatos iguales o fuera de ±30 días ⇒ sigue sin causa clara', () => {
    const dos = cobradoDeMas(
      entradaReal(315, COBROS_315_ANTES, {
        otrosCobrosCliente: [
          OTRO_332,
          { ...OTRO_332, cobro_id: 'otro-977', vuelo_id: 'v-x', folio: 400 },
        ],
      }),
    );
    expect(dos?.causa).toBe('SIN_CAUSA_CLARA');
    const lejos = cobradoDeMas(
      entradaReal(315, COBROS_315_ANTES, {
        otrosCobrosCliente: [
          { ...OTRO_332, fecha_cobro: '2026-11-20T17:00:00+00:00' },
        ],
      }),
    );
    expect(lejos?.causa).toBe('SIN_CAUSA_CLARA');
  });

  it('DESPUÉS (4,175.25 / 4,175.25) ⇒ null; #332 de hoy (faltan $0.04) ⇒ null', () => {
    expect(cobradoDeMas(entradaReal(315))).toBeNull();
    expect(cobradoDeMas(entradaReal(332))).toBeNull();
  });
});

describe('cobradoDeMas — duplicado, sobre y el orden de las causas', () => {
  it('COBRO_DUPLICADO: un 3.er cobro de $1,700 MXN TRANSFERENCIA el mismo día en el #315 ⇒ los dos ids y el texto', () => {
    const cobros = [
      ...cobrosDe(315),
      {
        ...cobrosDe(315)[0],
        id: 'f0000000-0000-4000-8000-00000000d001',
      },
    ];
    const r = cobradoDeMas(entradaReal(315, cobros))!;
    expect(r).toMatchObject({
      causa: 'COBRO_DUPLICADO',
      causa_etiqueta: 'cobro capturado dos veces',
      excedente_usd: 99.13,
      requiere_revision: true,
      explicacion:
        'Lo cobrado ($4,274.38 USD) rebasa el monto total ($4,175.25 USD). Posible causa: hay dos cobros iguales ($1,700 MXN · Transferencia · 15 sep).',
      que_hacer:
        'Si es el mismo pago capturado dos veces, elimina uno (si está conciliado, desvincúlalo primero en Conciliación). Si de verdad fueron dos pagos, el cliente tiene un saldo a favor.',
      referencia: {
        cobro_ids: [
          '3643f03c-a3f7-45ec-bf29-03a1afc18774',
          'abca82f3-ef73-4a19-b0df-1920d07eca05',
        ],
      },
    });
  });

  it('duplicado en días distintos (≤ 3) lo dice con las dos fechas; a 4 días ya no es duplicado', () => {
    const c = (id: string, fecha: string) => ({
      id,
      monto: 1000,
      moneda: 'USD',
      usd: 1000,
      metodo: 'TRANSFERENCIA',
      fecha_cobro: fecha,
      parte_de_sobre: false,
      tc_usd_mxn: null,
    });
    const tres = cobradoDeMas(
      entrada({
        cobrado_usd: 2000,
        cobros: [
          c('a', '2026-09-15T17:00:00Z'),
          c('b', '2026-09-18T17:00:00Z'),
        ],
      }),
    );
    expect(tres?.causa).toBe('COBRO_DUPLICADO');
    expect(tres?.explicacion).toContain(
      '($1,000 USD · Transferencia · 15 sep y 18 sep)',
    );
    const cuatro = cobradoDeMas(
      entrada({
        cobrado_usd: 2000,
        cobros: [
          c('a', '2026-09-15T17:00:00Z'),
          c('b', '2026-09-19T17:00:00Z'),
        ],
      }),
    );
    expect(cuatro?.causa).toBe('SIN_CAUSA_CLARA');
    // Otro método ⇒ no es «el mismo pago».
    const otroMetodo = cobradoDeMas(
      entrada({
        cobrado_usd: 2000,
        cobros: [
          c('a', '2026-09-15T17:00:00Z'),
          { ...c('b', '2026-09-15T17:00:00Z'), metodo: 'EFECTIVO' },
        ],
      }),
    );
    expect(otroMetodo?.causa).toBe('SIN_CAUSA_CLARA');
  });

  it('SOBRE_DE_GRUPO: todos los cobros son partes de un sobre ⇒ AVISO con el folio del grupo', () => {
    const parte = (id: string, monto: number) => ({
      id,
      monto,
      moneda: 'USD',
      usd: monto,
      metodo: 'TRANSFERENCIA',
      fecha_cobro: '2026-09-15T17:00:00Z',
      parte_de_sobre: true,
      tc_usd_mxn: null,
    });
    const r = cobradoDeMas(
      entrada({
        total_usd: 2000,
        cobrado_usd: 2320,
        // También cuadraría con el IVA (16 % de 2,000): el sobre va PRIMERO.
        cobros: [parte('p1', 1000), parte('p2', 1320)],
        grupo_folio: 12,
      }),
    )!;
    expect(r).toMatchObject({
      causa: 'SOBRE_DE_GRUPO',
      tono: 'AVISO',
      explicacion:
        'Lo cobrado ($2,320 USD) rebasa el monto total ($2,000 USD). Posible causa: el sobre del grupo G-12 se repartió con más de lo que vale este vuelo.',
      que_hacer:
        'Revisa la partición del sobre en «Cobros del grupo»: lo de más pertenece a otro avión del grupo.',
    });
    // Sin folio del grupo, la frase sin «G-…»; con UN cobro propio, ya no es del sobre.
    expect(
      cobradoDeMas(
        entrada({
          total_usd: 2000,
          cobrado_usd: 2320,
          cobros: [parte('p1', 1000), parte('p2', 1320)],
        }),
      )?.explicacion,
    ).toContain('el sobre del grupo se repartió');
    expect(
      cobradoDeMas(
        entrada({
          total_usd: 2000,
          cobrado_usd: 2320,
          cobros: [
            parte('p1', 1000),
            { ...parte('p2', 1320), parte_de_sobre: false },
          ],
        }),
      )?.causa,
    ).toBe('IVA_NO_COTIZADO');
  });

  it('REDONDEO_TC necesita un cobro en pesos que SÍ convirtió y respeta min($10, max($1, 1 %))', () => {
    const mxn = {
      id: 'm',
      monto: 17500,
      moneda: 'MXN',
      usd: 1005,
      metodo: 'TRANSFERENCIA',
      fecha_cobro: '2026-09-15T17:00:00Z',
      parte_de_sobre: false,
      tc_usd_mxn: 17.4129,
    };
    // 1 % de 1000 = 10 ⇒ tope 10: $5 sí.
    expect(
      cobradoDeMas(entrada({ cobrado_usd: 1005, cobros: [mxn] }))?.causa,
    ).toBe('REDONDEO_TC');
    // $10.01 rebasa el tope.
    expect(
      cobradoDeMas(entrada({ cobrado_usd: 1010.01, cobros: [mxn] }))?.causa,
    ).toBe('SIN_CAUSA_CLARA');
    // Con un total de $300 el tope es max(1, 3) = 3: $3.50 ya no es redondeo.
    expect(
      cobradoDeMas(
        entrada({ total_usd: 300, cobrado_usd: 303.5, cobros: [mxn] }),
      )?.causa,
    ).toBe('SIN_CAUSA_CLARA');
    // Solo dólares ⇒ nunca es redondeo del T.C.
    expect(cobradoDeMas(entrada({ cobrado_usd: 1005 }))?.causa).toBe(
      'SIN_CAUSA_CLARA',
    );
    // El cobro en pesos SIN T.C. (no entró a la cuenta) no explica nada.
    expect(
      cobradoDeMas(
        entrada({
          cobrado_usd: 1005,
          cobros: [{ ...mxn, usd: null, tc_usd_mxn: null }],
        }),
      )?.causa,
    ).toBe('SIN_CAUSA_CLARA');
  });

  it('IVA_NO_COTIZADO tolera max($1, 0.5 % del total) y nunca con IVA en la partición', () => {
    // 16 % de 1000 = 160; 0.5 % = 5 ⇒ 155..165 cuadra.
    expect(cobradoDeMas(entrada({ cobrado_usd: 1165 }))?.causa).toBe(
      'IVA_NO_COTIZADO',
    );
    expect(cobradoDeMas(entrada({ cobrado_usd: 1165.01 }))?.causa).toBe(
      'SIN_CAUSA_CLARA',
    );
    expect(
      cobradoDeMas(entrada({ cobrado_usd: 1160, iva_total_usd: 160 }))?.causa,
    ).toBe('SIN_CAUSA_CLARA');
  });
});

describe('cobradoDeMas — bordes', () => {
  it('excedente $1.00 ⇒ null (redondeo, la tolerancia de la bandera cobrado); $1.01 ⇒ aviso', () => {
    expect(cobradoDeMas(entrada({ cobrado_usd: 1001 }))).toBeNull();
    const r = cobradoDeMas(entrada({ cobrado_usd: 1001.01 }))!;
    expect(r.excedente_usd).toBe(1.01);
    expect(r.titulo).toBe('Cobrado de más: $1.01 USD');
  });

  it('CANCELADO, cotización abierta y total 0 (cliente interno) ⇒ null', () => {
    expect(
      cobradoDeMas(entrada({ cobrado_usd: 2000, estado_vuelo: 'CANCELADO' })),
    ).toBeNull();
    expect(
      cobradoDeMas(entrada({ cobrado_usd: 2000, cotizacion_abierta: true })),
    ).toBeNull();
    expect(
      cobradoDeMas(entrada({ total_usd: 0, cobrado_usd: 2000 })),
    ).toBeNull();
  });

  it('cobros en pesos SIN T.C. ⇒ el bloque los dice en sin_tc {n, mxn} (el monto sale de cobrosEnUsd)', () => {
    const v: FilaReal = { ...VUELOS_REALES[217], tc_usd_mxn: null };
    const cobros: FilaReal[] = [
      { ...cobrosDe(217)[0] },
      {
        ...cobrosDe(217)[0],
        id: 'sin-tc',
        monto: '5000.00',
        tc_usd_mxn: null,
      },
    ];
    const e = entradaCobradoDeMas({ vuelo: v, cobros, tcFallback: null });
    expect(e.sin_tc_count).toBe(1);
    const r = cobradoDeMas(e)!;
    expect(r.excedente_usd).toBe(495.99);
    expect(r.sin_tc).toEqual({ n: 1, mxn: 5000 });
    expect(r.causa).toBe('IVA_NO_COTIZADO');
  });
});

describe('helpers puros de «Cobrado de más»', () => {
  it('comisionesCobrosUsd: comisiones > 0 en USD con la cadena de T.C.; ≤ 0 o null no cuentan', () => {
    expect(comisionesCobrosUsd(cobrosDe(81), 17.5)).toBe(214.27);
    expect(
      comisionesCobrosUsd(
        [
          { monto: 100, moneda: 'USD', comision_banco_monto: '5' },
          { monto: 1000, moneda: 'MXN', comision_banco_monto: '17.5' },
          { monto: 100, moneda: 'USD', comision_banco_monto: '-3' },
          { monto: 100, moneda: 'USD', comision_banco_monto: null },
        ],
        17.5,
      ),
    ).toBe(6);
  });

  it('cobrosParaCobradoDeMas: usd por cobro con cobroEnUsd, sobre, método y T.C. normalizado', () => {
    const [c] = cobrosParaCobradoDeMas(
      [
        {
          id: 'x',
          monto: '1700.00',
          moneda: 'MXN',
          tc_usd_mxn: '17.150000',
          metodo_cobro: 'TRANSFERENCIA',
          fecha_cobro: '2026-09-15T17:00:00Z',
          cobro_grupo_id: 'sobre-1',
        },
      ],
      null,
    );
    expect(c).toEqual({
      id: 'x',
      monto: 1700,
      moneda: 'MXN',
      usd: 99.13,
      metodo: 'TRANSFERENCIA',
      fecha_cobro: '2026-09-15T17:00:00Z',
      parte_de_sobre: true,
      tc_usd_mxn: 17.15,
    });
  });

  it('tcPrincipalDeCobros: el del cobro MXN de MAYOR monto con T.C.; si no, el del vuelo', () => {
    const base = cobrosParaCobradoDeMas(COBROS_315_ANTES, 17.15);
    expect(tcPrincipalDeCobros(base, 99)).toBe(17.15);
    const sinTc = base.map((c) => ({ ...c, tc_usd_mxn: null }));
    expect(tcPrincipalDeCobros(sinTc, 17.4)).toBe(17.4);
    expect(tcPrincipalDeCobros(sinTc, null)).toBeNull();
    expect(
      tcPrincipalDeCobros(
        [
          { monto: 500, moneda: 'MXN', tc_usd_mxn: 18 },
          { monto: 900, moneda: 'MXN', tc_usd_mxn: 17 },
          { monto: 5000, moneda: 'USD', tc_usd_mxn: 20 },
        ],
        null,
      ),
    ).toBe(17);
  });

  it('candidatoOtroVueloDelCliente: EXACTAMENTE uno (USD directo; MXN con el T.C. principal); 0 o 2+ ⇒ null', () => {
    const o = (id: string, monto: number, moneda: string) => ({
      vuelo_id: `v-${id}`,
      folio: 1,
      cobro_id: id,
      monto,
      moneda,
      fecha_cobro: null,
    });
    expect(
      candidatoOtroVueloDelCliente(56.99, null, [o('u', 57.5, 'USD')]),
    ).toMatchObject({ cobro_id: 'u', monto: 57.5 });
    expect(
      candidatoOtroVueloDelCliente(56.99, null, [o('m', 977.45, 'MXN')]),
    ).toBeNull();
    expect(
      candidatoOtroVueloDelCliente(56.99, 17.15, [
        o('m', 977.45, 'MXN'),
        o('m2', 978.0, 'MXN'),
      ]),
    ).toBeNull();
    // El mismo cobro repetido cuenta UNA vez.
    expect(
      candidatoOtroVueloDelCliente(56.99, 17.15, [
        o('m', 977.45, 'MXN'),
        o('m', 977.45, 'MXN'),
      ]),
    ).toMatchObject({ cobro_id: 'm' });
    expect(
      candidatoOtroVueloDelCliente(56.99, 17.15, [o('m', 979.0, 'MXN')]),
    ).toBeNull();
  });

  it('ventanaOtrosCobrosCliente: ±30 días Cancún de los cobros POSITIVOS (cruza mes y año); sin fecha ⇒ null', () => {
    expect(ventanaOtrosCobrosCliente(COBROS_315_ANTES)).toEqual({
      desde: '2026-08-16',
      hasta: '2026-10-15',
    });
    // 03:00 UTC del 1-ene es todavía 31-dic en Cancún.
    expect(
      ventanaOtrosCobrosCliente([
        { monto: 1, fecha_cobro: '2027-01-01T03:00:00Z' },
        { monto: -500, fecha_cobro: '2027-06-01T17:00:00Z' },
      ]),
    ).toEqual({ desde: '2026-12-01', hasta: '2027-01-30' });
    expect(
      ventanaOtrosCobrosCliente([{ monto: 5, fecha_cobro: null }]),
    ).toBeNull();
  });

  it('esCobroSinBancoDeOtroVuelo: positivo, método que llega al banco, sin abonos, sin sobre ni anticipo', () => {
    const ok = {
      monto: '977.45',
      metodo_cobro: 'TRANSFERENCIA',
      cobro_grupo_id: null,
      ingreso_anticipo_id: null,
      ligado: false,
    };
    expect(esCobroSinBancoDeOtroVuelo(ok)).toBe(true);
    expect(esCobroSinBancoDeOtroVuelo({ ...ok, ligado: true })).toBe(false);
    expect(
      esCobroSinBancoDeOtroVuelo({ ...ok, metodo_cobro: 'EFECTIVO' }),
    ).toBe(false);
    expect(esCobroSinBancoDeOtroVuelo({ ...ok, cobro_grupo_id: 's' })).toBe(
      false,
    );
    expect(
      esCobroSinBancoDeOtroVuelo({ ...ok, ingreso_anticipo_id: 'a' }),
    ).toBe(false);
    expect(esCobroSinBancoDeOtroVuelo({ ...ok, monto: '-977.45' })).toBe(false);
    for (const m of ['HSBC_LINK', 'CHEQUE', 'PAYWISE']) {
      expect(esCobroSinBancoDeOtroVuelo({ ...ok, metodo_cobro: m })).toBe(true);
    }
  });

  it('necesitaOtrosCobrosCliente solo con SIN_CAUSA_CLARA', () => {
    expect(necesitaOtrosCobrosCliente(null)).toBe(false);
    expect(necesitaOtrosCobrosCliente(cobradoDeMas(entradaReal(217)))).toBe(
      false,
    );
    expect(
      necesitaOtrosCobrosCliente(
        cobradoDeMas(entradaReal(315, COBROS_315_ANTES)),
      ),
    ).toBe(true);
  });

  it('etiquetas de las 7 causas (las pinta el panel y el pre-cierre)', () => {
    expect(ETIQUETA_CAUSA_COBRADO_DE_MAS).toEqual({
      SOBRE_DE_GRUPO: 'sobre del grupo',
      COMISION_PAGADA_POR_CLIENTE: 'comisión del link pagada por el cliente',
      IVA_NO_COTIZADO: 'IVA que la cotización no lleva',
      COBRO_DUPLICADO: 'cobro capturado dos veces',
      REDONDEO_TC: 'redondeo del tipo de cambio',
      OTRO_VUELO_DEL_CLIENTE: 'pago de otro vuelo del cliente',
      SIN_CAUSA_CLARA: 'sin causa clara',
    });
  });
});
