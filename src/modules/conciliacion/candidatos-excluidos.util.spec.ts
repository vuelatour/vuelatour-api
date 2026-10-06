import {
  agruparExcluidos,
  bandaMontoExcluidos,
  cargosConciliadosPorGasto,
  conCargosConciliados,
  EXCLUIDOS_DIAS,
  EXCLUIDOS_POR_MOTIVO,
  GASTO_EXCLUIDO_COLS,
  gastoExcluibleDeFila,
  montoReferenciaExcluidos,
  motivoExclusion,
  MOTIVOS_EXCLUSION,
  ventanaExcluidos,
  type ContextoExclusion,
  type GastoExcluible,
  type GrupoExcluidos,
} from './candidatos-excluidos.util';
import { MEDIOS_BANCARIOS } from './gastos-candidatos.util';

/**
 * «Vincular gasto»: por qué un gasto del mismo monto NO es candidato
 * (6-oct-2026, API 0.0.63). Caso REAL de prod: cargo de $212.00 del 07-sep
 * (ASUR CANCUN, GASTOS GNRAL, MXN); la oficina buscó «212» y vio «Ningún
 * gasto pendiente coincide». Los tres gastos de $212.00 (estacionamiento
 * ASUR del 24, 27 y 28-sep, vuelos #338 y #330) estaban en EFECTIVO.
 */
const CTX: ContextoExclusion = {
  monedaCuenta: 'MXN',
  // ±30 días del 07-sep (la ventana default del diálogo).
  ventana: { desde: '2026-08-08', hasta: '2026-10-07' },
  fechaCargo: '2026-09-07',
};

const g = (
  id: string,
  extra: Partial<GastoExcluible> = {},
): GastoExcluible => ({
  id,
  fecha_gasto: '2026-09-10',
  monto: 212,
  moneda: 'MXN',
  medio_pago: 'TARJETA_CORP',
  categoria: 'TAXI',
  conciliado: false,
  vuelo_id: null,
  vuelo_folio: null,
  ...extra,
});

const efectivo = (id: string, fecha: string, folio: number) =>
  g(id, {
    fecha_gasto: fecha,
    medio_pago: 'EFECTIVO',
    vuelo_id: `v-${folio}`,
    vuelo_folio: folio,
  });

// Los tres REALES (ids recortados de prod), en el orden en que NO llegan.
const REALES = [
  efectivo('053fa6f4', '2026-09-28', 330),
  efectivo('4fca531f', '2026-09-24', 338),
  efectivo('e5aa4ec9', '2026-09-27', 330),
];

const resumen = (grupos: GrupoExcluidos[]) =>
  grupos.map((x) => [x.motivo, x.n, x.gastos.map((y) => y.id)]);

describe('agruparExcluidos — caso real (3 × $212.00 en EFECTIVO)', () => {
  it('un solo grupo EFECTIVO_U_OTRO_MEDIO, n 3, en orden cronológico y con su vuelo', () => {
    expect(agruparExcluidos(REALES, CTX)).toEqual([
      {
        motivo: 'EFECTIVO_U_OTRO_MEDIO',
        n: 3,
        gastos: [
          {
            id: '4fca531f',
            fecha_gasto: '2026-09-24',
            monto: 212,
            moneda: 'MXN',
            medio_pago: 'EFECTIVO',
            categoria: 'TAXI',
            vuelo_id: 'v-338',
            vuelo_folio: 338,
          },
          {
            id: 'e5aa4ec9',
            fecha_gasto: '2026-09-27',
            monto: 212,
            moneda: 'MXN',
            medio_pago: 'EFECTIVO',
            categoria: 'TAXI',
            vuelo_id: 'v-330',
            vuelo_folio: 330,
          },
          {
            id: '053fa6f4',
            fecha_gasto: '2026-09-28',
            monto: 212,
            moneda: 'MXN',
            medio_pago: 'EFECTIVO',
            categoria: 'TAXI',
            vuelo_id: 'v-330',
            vuelo_folio: 330,
          },
        ],
      },
    ]);
  });

  it('la ficha NO lleva `conciliado` (el motivo ya lo dice) ni `conciliado_con` fuera de YA_CONCILIADO', () => {
    const [grupo] = agruparExcluidos(REALES, CTX);
    for (const x of grupo.gastos) {
      expect(x).not.toHaveProperty('conciliado');
      expect(x).not.toHaveProperty('conciliado_con');
    }
  });
});

describe('motivoExclusion — precedencia', () => {
  it('orden fijo de los motivos', () => {
    expect([...MOTIVOS_EXCLUSION]).toEqual([
      'EFECTIVO_U_OTRO_MEDIO',
      'YA_CONCILIADO',
      'OTRA_MONEDA',
      'FUERA_DE_VENTANA',
    ]);
  });

  it('medio fuera de MEDIOS_BANCARIOS ⇒ EFECTIVO_U_OTRO_MEDIO, gane a todo lo demás', () => {
    for (const medio of [
      'EFECTIVO',
      'BODEGA',
      'PERSONAL_PABLO',
      'PERSONAL_ALE',
      null,
    ]) {
      expect(motivoExclusion(g('x', { medio_pago: medio }), CTX)).toBe(
        'EFECTIVO_U_OTRO_MEDIO',
      );
    }
    // Efectivo, conciliado, en dólares y fuera de la ventana: lo que hay que
    // corregir primero es el medio.
    expect(
      motivoExclusion(
        g('x', {
          medio_pago: 'EFECTIVO',
          conciliado: true,
          moneda: 'USD',
          fecha_gasto: '2026-06-12',
        }),
        CTX,
      ),
    ).toBe('EFECTIVO_U_OTRO_MEDIO');
  });

  it('bancario y conciliado ⇒ YA_CONCILIADO, aunque esté en otra moneda o fuera de la ventana', () => {
    expect(motivoExclusion(g('x', { conciliado: true }), CTX)).toBe(
      'YA_CONCILIADO',
    );
    expect(
      motivoExclusion(
        g('x', { conciliado: true, moneda: 'USD', fecha_gasto: '2026-06-12' }),
        CTX,
      ),
    ).toBe('YA_CONCILIADO');
  });

  it('bancario sin conciliar en otra moneda ⇒ OTRA_MONEDA (también fuera de la ventana)', () => {
    expect(
      motivoExclusion(
        g('x', { medio_pago: 'TRANSFERENCIA', moneda: 'USD' }),
        CTX,
      ),
    ).toBe('OTRA_MONEDA');
    expect(
      motivoExclusion(
        g('x', { moneda: 'USD', fecha_gasto: '2026-06-12' }),
        CTX,
      ),
    ).toBe('OTRA_MONEDA');
    // Cuenta en dólares: un gasto en pesos tampoco entra.
    expect(motivoExclusion(g('x'), { ...CTX, monedaCuenta: 'USD' })).toBe(
      'OTRA_MONEDA',
    );
  });

  it('fuera de ±dias ⇒ FUERA_DE_VENTANA; los bordes son de la ventana', () => {
    expect(
      motivoExclusion(
        g('x', { medio_pago: 'PAYWISE', fecha_gasto: '2026-06-12' }),
        CTX,
      ),
    ).toBe('FUERA_DE_VENTANA');
    expect(motivoExclusion(g('x', { fecha_gasto: '2026-10-08' }), CTX)).toBe(
      'FUERA_DE_VENTANA',
    );
    expect(motivoExclusion(g('x', { fecha_gasto: '2026-08-07' }), CTX)).toBe(
      'FUERA_DE_VENTANA',
    );
    expect(motivoExclusion(g('x', { fecha_gasto: null }), CTX)).toBe(
      'FUERA_DE_VENTANA',
    );
    expect(
      motivoExclusion(g('x', { fecha_gasto: '2026-08-08' }), CTX),
    ).toBeNull();
    expect(
      motivoExclusion(g('x', { fecha_gasto: '2026-10-07' }), CTX),
    ).toBeNull();
  });

  it('del universo (cualquier medio bancario, sin conciliar, misma moneda, en ventana) ⇒ null', () => {
    for (const medio of MEDIOS_BANCARIOS) {
      expect(motivoExclusion(g('x', { medio_pago: medio }), CTX)).toBeNull();
    }
  });

  it('incluirNoBancarios (6-oct-2026): efectivo / PERSONAL_* ya son del universo; BODEGA y sin medio NO', () => {
    const CON = { ...CTX, incluirNoBancarios: true };
    for (const medio of ['EFECTIVO', 'PERSONAL_PABLO', 'PERSONAL_ALE']) {
      expect(motivoExclusion(g('x', { medio_pago: medio }), CON)).toBeNull();
      // Su motivo pasa a ser el siguiente de la precedencia.
      expect(
        motivoExclusion(g('x', { medio_pago: medio, conciliado: true }), CON),
      ).toBe('YA_CONCILIADO');
      expect(
        motivoExclusion(g('x', { medio_pago: medio, moneda: 'USD' }), CON),
      ).toBe('OTRA_MONEDA');
      expect(
        motivoExclusion(
          g('x', { medio_pago: medio, fecha_gasto: '2026-06-12' }),
          CON,
        ),
      ).toBe('FUERA_DE_VENTANA');
    }
    for (const medio of ['BODEGA', null]) {
      expect(motivoExclusion(g('x', { medio_pago: medio }), CON)).toBe(
        'EFECTIVO_U_OTRO_MEDIO',
      );
    }
    // Sin la bandera (o false), lo de siempre.
    expect(
      motivoExclusion(g('x', { medio_pago: 'EFECTIVO' }), {
        ...CTX,
        incluirNoBancarios: false,
      }),
    ).toBe('EFECTIVO_U_OTRO_MEDIO');
  });
});

describe('agruparExcluidos — mezcla, tope por motivo y limpieza', () => {
  it('mezcla de motivos: grupos en el orden fijo, n por motivo', () => {
    const filas = [
      g('fuera', { fecha_gasto: '2026-06-12' }),
      g('usd', { moneda: 'USD' }),
      g('conc', { conciliado: true }),
      g('bodega', { medio_pago: 'BODEGA', categoria: 'REFACCION' }),
      ...REALES,
      g('universo'),
    ];
    expect(resumen(agruparExcluidos(filas, CTX))).toEqual([
      [
        'EFECTIVO_U_OTRO_MEDIO',
        4,
        ['bodega', '4fca531f', 'e5aa4ec9', '053fa6f4'],
      ],
      ['YA_CONCILIADO', 1, ['conc']],
      ['OTRA_MONEDA', 1, ['usd']],
      ['FUERA_DE_VENTANA', 1, ['fuera']],
    ]);
  });

  it(`más de ${EXCLUIDOS_POR_MOTIVO}: n cuenta TODOS; viajan los más cercanos al cargo, en orden cronológico`, () => {
    const fechas = [
      '2026-05-20', // 110 días antes
      '2026-12-30', // 114 días después
      '2026-08-01', // 37
      '2026-09-30', // 23
      '2026-09-01', // 6
      '2026-09-08', // 1
      '2026-09-06', // 1
    ];
    const filas = fechas.map((f, i) =>
      g(`e${i}`, { medio_pago: 'EFECTIVO', fecha_gasto: f }),
    );
    const [grupo] = agruparExcluidos(filas, CTX);
    expect(grupo.n).toBe(7);
    expect(grupo.gastos.map((x) => x.fecha_gasto)).toEqual([
      '2026-08-01',
      '2026-09-01',
      '2026-09-06',
      '2026-09-08',
      '2026-09-30',
    ]);
  });

  it('empate de distancia en el corte: gana el más viejo (luego el id)', () => {
    const fechas = [
      '2026-09-12', // 5
      '2026-09-02', // 5
      '2026-09-10', // 3
      '2026-09-05', // 2
      '2026-09-08', // 1
      '2026-09-06', // 1
    ];
    const filas = fechas.map((f, i) =>
      g(`e${i}`, { medio_pago: 'EFECTIVO', fecha_gasto: f }),
    );
    const [grupo] = agruparExcluidos(filas, CTX);
    expect(grupo.n).toBe(6);
    expect(grupo.gastos.map((x) => x.fecha_gasto)).toEqual([
      '2026-09-02',
      '2026-09-05',
      '2026-09-06',
      '2026-09-08',
      '2026-09-10',
    ]);
    // Mismo día: por id.
    const mismoDia = agruparExcluidos(
      [efectivo('b', '2026-09-24', 338), efectivo('a', '2026-09-24', 338)],
      CTX,
    );
    expect(mismoDia[0].gastos.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('con incluirNoBancarios el caso real ya no se explica (son candidatos); BODEGA sí', () => {
    const CON = { ...CTX, incluirNoBancarios: true };
    expect(agruparExcluidos(REALES, CON)).toEqual([]);
    expect(
      resumen(
        agruparExcluidos(
          [
            ...REALES,
            g('bodega', { medio_pago: 'BODEGA', categoria: 'REFACCION' }),
            efectivo('efe-conc', '2026-09-20', 330),
          ].map((x) => (x.id === 'efe-conc' ? { ...x, conciliado: true } : x)),
          CON,
        ),
      ),
    ).toEqual([
      ['EFECTIVO_U_OTRO_MEDIO', 1, ['bodega']],
      ['YA_CONCILIADO', 1, ['efe-conc']],
    ]);
  });

  it('un id repetido cuenta una vez; los del universo no se reportan; nada ⇒ []', () => {
    const [grupo] = agruparExcluidos([...REALES, REALES[0]], CTX);
    expect(grupo.n).toBe(3);
    expect(agruparExcluidos([g('universo')], CTX)).toEqual([]);
    expect(agruparExcluidos([], CTX)).toEqual([]);
  });
});

describe('monto, banda y ventana de la consulta extra', () => {
  it('monto: el del cargo sin búsqueda o con texto; el de q si es numérico', () => {
    expect(montoReferenciaExcluidos(undefined, 212)).toBe(212);
    expect(montoReferenciaExcluidos('  ', 212)).toBe(212);
    expect(montoReferenciaExcluidos('asur', 212)).toBe(212);
    expect(montoReferenciaExcluidos('vuelo 338', -212)).toBe(212);
    expect(montoReferenciaExcluidos('212', 212)).toBe(212);
    // Lote: un SPEI de 8,404.20 buscado por el monto de cada gasto.
    expect(montoReferenciaExcluidos('2801.40', 8404.2)).toBe(2801.4);
    expect(montoReferenciaExcluidos('$ 2,801.4', 8404.2)).toBe(2801.4);
    expect(montoReferenciaExcluidos('2801', 8404.2)).toBe(2801);
  });

  it('banda: el MISMO monto ±0.01', () => {
    expect(bandaMontoExcluidos(212)).toEqual({ min: 211.99, max: 212.01 });
    expect(bandaMontoExcluidos(2801.4)).toEqual({ min: 2801.39, max: 2801.41 });
    expect(bandaMontoExcluidos(-212)).toEqual({ min: 211.99, max: 212.01 });
  });

  it(`ventana: ±${EXCLUIDOS_DIAS} días del cargo, o ±dias si se pidió más`, () => {
    expect(ventanaExcluidos('2026-09-07', 30)).toEqual({
      desde: '2026-05-10',
      hasta: '2027-01-05',
    });
    expect(ventanaExcluidos('2026-09-07', 120)).toEqual(
      ventanaExcluidos('2026-09-07', 30),
    );
    expect(ventanaExcluidos('2026-09-07', 180)).toEqual({
      desde: '2026-03-11',
      hasta: '2027-03-06',
    });
  });
});

describe('gastoExcluibleDeFila — fila de PostgREST', () => {
  it('normaliza tipos y el embed del vuelo (objeto, arreglo o null)', () => {
    expect(GASTO_EXCLUIDO_COLS).toContain('vuelo:vuelo!vuelo_id(folio)');
    const base = {
      id: '4fca531f',
      fecha_gasto: '2026-09-24',
      monto: '212.00',
      moneda: 'MXN',
      medio_pago: 'EFECTIVO',
      categoria: 'TAXI',
      conciliado: false,
      vuelo_id: 'v-338',
    };
    expect(gastoExcluibleDeFila({ ...base, vuelo: { folio: 338 } })).toEqual({
      ...base,
      monto: 212,
      vuelo_folio: 338,
    });
    expect(
      gastoExcluibleDeFila({ ...base, vuelo: [{ folio: '330' }] })?.vuelo_folio,
    ).toBe(330);
    expect(
      gastoExcluibleDeFila({ ...base, vuelo_id: null, vuelo: null }),
    ).toMatchObject({ vuelo_id: null, vuelo_folio: null });
    expect(
      gastoExcluibleDeFila({ ...base, conciliado: 'true' })?.conciliado,
    ).toBe(false);
    expect(gastoExcluibleDeFila({ ...base, id: null })).toBeNull();
  });
});

describe('YA_CONCILIADO: con qué cargo', () => {
  const grupos = agruparExcluidos(
    [
      g('conc', { conciliado: true }),
      g('conc2', { conciliado: true }),
      ...REALES,
    ],
    CTX,
  );

  it('cargosConciliadosPorGasto: fecha y cuenta del movimiento, monto de la PARTE, el más viejo primero', () => {
    const mapa = cargosConciliadosPorGasto(
      [
        {
          movimiento_id: 'm-b',
          gasto_id: 'conc',
          monto_parte: 112,
          moneda: 'MXN',
        },
        {
          movimiento_id: 'm-a',
          gasto_id: 'conc',
          monto_parte: 100,
          moneda: 'MXN',
        },
        {
          movimiento_id: 'm-x',
          gasto_id: 'conc2',
          monto_parte: 212,
          moneda: 'MXN',
        },
      ],
      [
        { id: 'm-a', fecha: '2026-09-05', cuenta: { alias: 'GASTOS GNRAL' } },
        { id: 'm-b', fecha: '2026-09-09', cuenta: [{ alias: 'COMBUSTIBLE' }] },
      ],
    );
    expect(mapa.get('conc')).toEqual([
      {
        movimiento_id: 'm-a',
        fecha: '2026-09-05',
        monto: 100,
        moneda: 'MXN',
        cuenta: 'GASTOS GNRAL',
      },
      {
        movimiento_id: 'm-b',
        fecha: '2026-09-09',
        monto: 112,
        moneda: 'MXN',
        cuenta: 'COMBUSTIBLE',
      },
    ]);
    // Movimiento ilegible: la parte viaja sin fecha ni cuenta.
    expect(mapa.get('conc2')).toEqual([
      {
        movimiento_id: 'm-x',
        fecha: null,
        monto: 212,
        moneda: 'MXN',
        cuenta: null,
      },
    ]);
  });

  it('conCargosConciliados: SOLO en YA_CONCILIADO; [] sin cargo; null si la puente no se leyó', () => {
    const cargos = new Map([
      [
        'conc',
        [
          {
            movimiento_id: 'm-a',
            fecha: '2026-09-05',
            monto: 212,
            moneda: 'MXN',
            cuenta: 'GASTOS GNRAL',
          },
        ],
      ],
    ]);
    const con = conCargosConciliados(grupos, cargos);
    const ya = con.find((x) => x.motivo === 'YA_CONCILIADO')!;
    expect(ya.gastos.map((x) => [x.id, x.conciliado_con])).toEqual([
      ['conc', cargos.get('conc')],
      ['conc2', []],
    ]);
    const efe = con.find((x) => x.motivo === 'EFECTIVO_U_OTRO_MEDIO')!;
    expect(efe.gastos[0]).not.toHaveProperty('conciliado_con');
    const sinPuente = conCargosConciliados(grupos, null);
    expect(
      sinPuente
        .find((x) => x.motivo === 'YA_CONCILIADO')!
        .gastos.map((x) => x.conciliado_con),
    ).toEqual([null, null]);
    // No muta la entrada.
    expect(grupos[1].gastos[0]).not.toHaveProperty('conciliado_con');
  });
});
