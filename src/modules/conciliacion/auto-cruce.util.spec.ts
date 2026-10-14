import {
  CLASIFICACION_TRASPASO,
  claveBucket,
  competidoresCruceUsd,
  contrasteDescripcionUsd,
  decidirCruceUsd,
  evaluarTcCruce,
  ligaUsdFueraDeLugar,
  piezaTcCruce,
  TC_IMPLICITO_MAX,
  TC_IMPLICITO_MIN,
  tcCruceUsdPublico,
  TEXTO_CRUCE_USD_RECIPROCO_ERROR,
  TEXTO_CRUCE_USD_RECIPROCO_TRUNCADO,
  TEXTO_CRUCE_USD_SIN_LECTURA_TC,
  TEXTO_CRUCE_USD_TRUNCADO,
  textoReciprocoCruceUsd,
  textoSePuedeCruzarUsd,
  textoTcCruce,
  tituloTcCruce,
  TOLERANCIA_TC_OFICIAL_PCT,
  descDedupe,
  descripcionesSeContradicen,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados as emparejarDuplicadosReal,
  leyendasNombranDistinto,
  nivelEmpateDedupe,
  ordenarPreviosParaDedupe,
  type LineaDedupe,
  mismaDescripcionDedupe,
  montoCasa,
  nivelDescripcionDedupe,
  normalizarTextoBanco,
  patronTraspaso,
  primeraLinea,
  puntuarDescripcion,
  separarPorDesfase,
  terminacionDeMovimiento,
  textoSoloCentavo,
  tokensTexto,
  ventanaDias,
  type GastoCandidatoCruce,
} from './auto-cruce.util';

/**
 * CONCEPTO DEL SPEI (0.0.75): `emparejarDuplicados` devuelve además
 * `parejas`. Cada llamada de ESTE spec pasa por aquí y comprueba, en TODOS
 * los fixtures de siempre (Cozumel, ZOMAY, ASA CANCUN, CARGO INDEBIDO,
 * DIDI…), que las parejas cuentan EXACTAMENTE los duplicados, con índices
 * válidos, cada fila previa y cada línea una sola vez, del mismo bucket, con
 * su nivel real y ordenadas por línea; y que `aInsertar` son justo las
 * líneas sin pareja (el golden de siempre no se mueve).
 */
function emparejarDuplicados<T extends LineaDedupe>(
  nuevos: readonly T[],
  previos: readonly LineaDedupe[],
) {
  const r = emparejarDuplicadosReal(nuevos, previos);
  expect(r.parejas).toHaveLength(r.duplicados);
  const lineas = new Set<number>();
  const filas = new Set<number>();
  let anterior = -1;
  for (const p of r.parejas) {
    expect(Number.isInteger(p.nuevo) && p.nuevo >= 0).toBe(true);
    expect(p.nuevo).toBeLessThan(nuevos.length);
    expect(Number.isInteger(p.previo) && p.previo >= 0).toBe(true);
    expect(p.previo).toBeLessThan(previos.length);
    expect(lineas.has(p.nuevo)).toBe(false);
    expect(filas.has(p.previo)).toBe(false);
    lineas.add(p.nuevo);
    filas.add(p.previo);
    expect(p.nuevo).toBeGreaterThan(anterior);
    anterior = p.nuevo;
    expect(claveBucket(nuevos[p.nuevo])).toBe(claveBucket(previos[p.previo]));
    expect(nivelEmpateDedupe(nuevos[p.nuevo], previos[p.previo])).toBe(p.nivel);
  }
  const sinPareja = nuevos.filter((_, i) => !lineas.has(i));
  expect(r.aInsertar).toHaveLength(sinPareja.length);
  r.aInsertar.forEach((x, i) => expect(x).toBe(sinPareja[i]));
  return r;
}

/**
 * Casos REALES del Scotiabank MXN «GASTOS GNRAL» (semana 7-13 sep 2026),
 * que es donde 44 de 67 movimientos quedaron pendientes. Aquí se congela la
 * regla: el auto-cruce liga solo lo INEQUÍVOCO; lo demás queda pendiente
 * con motivo, nunca ligado a la brava.
 */

// Catálogo real de tarjeta_corporativa (terminaciones activas).
const TARJETAS = ['0577', '0585', '6256', '0572', '0505', '6231', '2865'];

describe('terminacionDeMovimiento — la tarjeta solo cuenta si existe', () => {
  it('toma los últimos 4 dígitos de una referencia numérica del banco', () => {
    expect(terminacionDeMovimiento('0025830577', null, TARJETAS)).toBe('0577');
    expect(terminacionDeMovimiento('9155656256', null, TARJETAS)).toBe('6256');
  });

  it('NO inventa tarjeta con la referencia de 6 dígitos del 15-sep', () => {
    expect(terminacionDeMovimiento('174465', null, TARJETAS)).toBeNull();
    // Corta pero terminada como una tarjeta real: sigue sin contar (azar).
    expect(terminacionDeMovimiento('830577', null, TARJETAS)).toBeNull();
    // Ocho dígitos ya es una referencia de tarjeta.
    expect(terminacionDeMovimiento('12340577', null, TARJETAS)).toBe('0577');
  });

  it('ignora referencias que no son puramente numéricas o muy cortas', () => {
    expect(terminacionDeMovimiento('ABC0577', null, TARJETAS)).toBeNull();
    expect(terminacionDeMovimiento('577', null, TARJETAS)).toBeNull();
    expect(terminacionDeMovimiento(null, null, TARJETAS)).toBeNull();
  });

  it('lee la tarjeta marcada en la descripción (*0585 / TDC 0585)', () => {
    expect(terminacionDeMovimiento(null, 'COMPRA *0585', TARJETAS)).toBe(
      '0585',
    );
    expect(terminacionDeMovimiento(null, 'TDC 0585 ASUR', TARJETAS)).toBe(
      '0585',
    );
  });

  it('un número suelto en la leyenda NO es una tarjeta', () => {
    expect(terminacionDeMovimiento(null, 'ASUR CANCUN 0585', TARJETAS)).toBe(
      null,
    );
  });

  it('dos terminaciones distintas en el mismo movimiento = ambiguo', () => {
    expect(terminacionDeMovimiento('0025830577', '*6256', TARJETAS)).toBeNull();
  });

  it('sin catálogo de tarjetas no hay desempate posible', () => {
    expect(terminacionDeMovimiento('0025830577', null, [])).toBeNull();
  });
});

describe('normalización de la leyenda del banco', () => {
  it('quita acentos, mayúsculas y prefijos de agregador', () => {
    expect(normalizarTextoBanco('MERPAGO*AGREGADOR')).toBe('AGREGADOR');
    expect(normalizarTextoBanco('PINPE*MONOLOTIK TPV')).toBe('MONOLOTIK TPV');
    expect(normalizarTextoBanco('EC DE CHETUMAL')).toBe('DE CHETUMAL');
    expect(normalizarTextoBanco('Aeropuerto de Cozumel')).toBe(
      'AEROPUERTO DE COZUMEL',
    );
  });

  it('los tokens tiran muletillas y números sueltos', () => {
    expect(tokensTexto('A I DE CHETUMAL 1234')).toEqual(['CHETUMAL']);
    expect(tokensTexto('GOB EDO DE QROO')).toEqual(['GOB', 'EDO', 'QROO']);
  });

  it('primeraLinea toma solo el renglón que describe el gasto', () => {
    expect(primeraLinea('Aeropuerto de Cozumel\nOperación: 125.82')).toBe(
      'Aeropuerto de Cozumel',
    );
  });
});

describe('puntuarDescripcion — sinónimos del giro', () => {
  it('ASUR CANCUN empata con «Aeropuerto de Cancún»', () => {
    expect(
      puntuarDescripcion('ASUR CANCUN', { lugar: 'Aeropuerto de Cancún' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('ASUR MERIDA NO empata con «Aeropuerto de Cancún» (veto por ciudad)', () => {
    expect(
      puntuarDescripcion('ASUR MERIDA', { lugar: 'Aeropuerto de Cancún' }),
    ).toBe(0);
    expect(
      puntuarDescripcion('ASUR MERIDA', { lugar: 'Aeropuerto de Mérida' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('AEROPUERTO DE COZUMEL empata con la primera línea de las notas', () => {
    expect(
      puntuarDescripcion('AEROPUERTO DE COZUMEL', {
        notas: 'Aeropuerto de Cozumel\nTUA y operación',
      }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('un solo token en común (PISTA) nunca alcanza el umbral', () => {
    expect(
      puntuarDescripcion('PISTA MONTERREY', { notas: 'Pista' }),
    ).toBeLessThan(0.6);
  });

  it('VETO por ciudad: ASA MERIDA no es la carga de ASA Cancún', () => {
    expect(puntuarDescripcion('ASA MERIDA', { lugar: 'ASA Cancún' })).toBe(0);
    expect(
      puntuarDescripcion('ASA MERIDA', { lugar: 'ASA Mérida' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('textos que no se parecen valen 0', () => {
    expect(
      puntuarDescripcion('GOB EDO DE QROO', { lugar: 'Aeropuerto de Cozumel' }),
    ).toBe(0);
  });
});

describe('elegirCandidato — liga solo lo inequívoco', () => {
  const cozumelA: GastoCandidatoCruce = {
    id: 'g-cozumel-a',
    monto: 125.82,
    tarjeta_terminacion: '0577',
    lugar: 'Aeropuerto de Cozumel',
  };
  const cozumelB: GastoCandidatoCruce = {
    id: 'g-cozumel-b',
    monto: 125.82,
    tarjeta_terminacion: '6256',
    lugar: 'Aeropuerto de Cozumel',
  };

  it('candidato único = se liga por monto', () => {
    const r = elegirCandidato({ monto: 125.82 }, [cozumelA], TARJETAS);
    expect(r.gasto_id).toBe('g-cozumel-a');
    expect(r.criterio).toBe('MONTO_EXACTO');
    expect(r.motivo).toBeNull();
  });

  it('sin candidatos = SIN_CANDIDATOS', () => {
    const r = elegirCandidato({ monto: 125.82 }, [], TARJETAS);
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('SIN_CANDIDATOS');
  });

  it('los DOS cargos de $125.82 del 4-sep los desempata la tarjeta', () => {
    const r = elegirCandidato(
      {
        monto: 125.82,
        descripcion: 'AEROPUERTO DE COZUMEL',
        referencia: '9155656256',
      },
      [cozumelA, cozumelB],
      TARJETAS,
    );
    expect(r.gasto_id).toBe('g-cozumel-b');
    expect(r.criterio).toBe('TARJETA');
    expect(r.terminacion).toBe('6256');
  });

  it('sin tarjeta y con la MISMA descripción queda AMBIGUO (no se liga)', () => {
    const r = elegirCandidato(
      {
        monto: 125.82,
        descripcion: 'AEROPUERTO DE COZUMEL',
        referencia: '174465',
      },
      [cozumelA, cozumelB],
      TARJETAS,
    );
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
    expect(r.candidatos_n).toBe(2);
  });

  it('la descripción desempata cuando solo uno se parece de verdad', () => {
    const r = elegirCandidato(
      { monto: 480, descripcion: 'ASUR CANCUN' },
      [
        { id: 'g-cun', monto: 480, lugar: 'Aeropuerto de Cancún' },
        { id: 'g-taco', monto: 480, lugar: 'Restaurante El Taco Loco' },
      ],
      TARJETAS,
    );
    expect(r.gasto_id).toBe('g-cun');
    expect(r.criterio).toBe('DESCRIPCION');
  });

  it('dos gastos igual de parecidos NO se desempatan por descripción', () => {
    const r = elegirCandidato(
      { monto: 480, descripcion: 'ASUR CANCUN' },
      [
        { id: 'g-1', monto: 480, lugar: 'Aeropuerto de Cancún' },
        { id: 'g-2', monto: 480, lugar: 'Aeropuerto de Cancún' },
      ],
      TARJETAS,
    );
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
  });

  it('conserva el criterio base cuando el cruce viene del FALTANTE', () => {
    const r = elegirCandidato({ monto: 100 }, [{ id: 'g', monto: 300 }], [], {
      criterioBase: 'FALTANTE',
    });
    expect(r.criterio).toBe('FALTANTE');
  });
});

describe('elegirMovimiento — camino inverso (gasto capturado después)', () => {
  const gasto: GastoCandidatoCruce = {
    id: 'g-1',
    monto: 125.82,
    tarjeta_terminacion: '0577',
    lugar: 'Aeropuerto de Cozumel',
  };

  it('un solo cargo pendiente = se liga', () => {
    const r = elegirMovimiento(gasto, [{ id: 'm-1', monto: 125.82 }], TARJETAS);
    expect(r.movimiento_id).toBe('m-1');
  });

  it('dos cargos iguales: gana el de la tarjeta del gasto', () => {
    const r = elegirMovimiento(
      gasto,
      [
        { id: 'm-1', monto: 125.82, referencia: '0025830577' },
        { id: 'm-2', monto: 125.82, referencia: '9155656256' },
      ],
      TARJETAS,
    );
    expect(r.movimiento_id).toBe('m-1');
    expect(r.criterio).toBe('TARJETA');
  });

  it('dos cargos sin nada que los distinga = ninguno', () => {
    const r = elegirMovimiento(
      gasto,
      [
        { id: 'm-1', monto: 125.82 },
        { id: 'm-2', monto: 125.82 },
      ],
      TARJETAS,
    );
    expect(r.movimiento_id).toBeNull();
  });
});

/**
 * DESFASE 0.00 GANA AL ±0.01 (2-oct-2026). Caso REAL de prod: el SPEI de
 * SAESA de $2,231.38 (24-sep, GASTOS GNRAL) se ligó solo al gasto #318 de
 * $2,231.37 y el gasto EXACTO #321 de $2,231.38 se capturó 15 min después.
 */
describe('desfase 0.00 vs ±0.01 — el exacto gana, el centavo solo NO liga', () => {
  const g318: GastoCandidatoCruce = {
    id: 'g318',
    monto: 2231.37,
    notas: 'Pago VIP SAESA',
  };
  const g321: GastoCandidatoCruce = {
    id: 'g321',
    monto: 2231.38,
    notas: 'Pago VIP SAESA',
  };

  it('con el exacto (#321) presente, el de un centavo (#318) se descarta', () => {
    const r = elegirCandidato({ monto: 2231.38 }, [g318, g321], TARJETAS);
    expect(r.gasto_id).toBe('g321');
    expect(r.criterio).toBe('MONTO_EXACTO');
    expect(r.candidatos_n).toBe(1);
  });

  it('SOLO el de un centavo (#318, antes de capturar #321): AMBIGUO, no liga', () => {
    const r = elegirCandidato({ monto: 2231.38 }, [g318], TARJETAS);
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
    expect(r.candidatos_n).toBe(1);
    expect(r.detalle).toBe(textoSoloCentavo(1, 'gasto'));
  });

  it('dos exactos siguen el desempate de siempre (los del centavo no cuentan)', () => {
    const r = elegirCandidato(
      { monto: 2231.38 },
      [g318, g321, { ...g321, id: 'g321b' }],
      TARJETAS,
    );
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
    expect(r.candidatos_n).toBe(2);
  });

  it('FALTANTE: compara contra monto_cruce (lo que le falta), no el monto total', () => {
    const exacto = elegirCandidato(
      { monto: 1000 },
      [{ id: 'g', monto: 3000, monto_cruce: 1000 }],
      [],
      { criterioBase: 'FALTANTE' },
    );
    expect(exacto.gasto_id).toBe('g');
    const centavo = elegirCandidato(
      { monto: 1000 },
      [{ id: 'g', monto: 3000, monto_cruce: 1000.01 }],
      [],
      { criterioBase: 'FALTANTE' },
    );
    expect(centavo.gasto_id).toBeNull();
    expect(centavo.motivo).toBe('AMBIGUO');
  });

  it('camino inverso: el gasto #321 elige el cargo exacto y no el de un centavo', () => {
    const r = elegirMovimiento(
      g321,
      [
        { id: 'm-237', monto: 2231.37 },
        { id: 'm-238', monto: 2231.38 },
      ],
      TARJETAS,
    );
    expect(r.movimiento_id).toBe('m-238');
    expect(r.criterio).toBe('MONTO_EXACTO');
  });

  it('camino inverso con SOLO un cargo a un centavo: nadie, con el porqué', () => {
    const r = elegirMovimiento(
      g318,
      [{ id: 'm-238', monto: 2231.38 }],
      TARJETAS,
    );
    expect(r.movimiento_id).toBeNull();
    expect(r.detalle).toBe(textoSoloCentavo(1, 'cargo'));
  });

  it('camino inverso: monto_cruce (faltante) manda sobre el monto', () => {
    const r = elegirMovimiento(
      { id: 'g', monto: 3000, monto_cruce: 1000 },
      [{ id: 'm', monto: 1000 }],
      TARJETAS,
    );
    expect(r.movimiento_id).toBe('m');
  });

  it('separarPorDesfase en centavos enteros (sin ruido de flotantes)', () => {
    const r = separarPorDesfase(0.3, [0.1 + 0.2, 0.31, 0.29, 0.5], (x) => x);
    expect(r.exactos).toHaveLength(1);
    expect(r.centavo).toEqual([0.31, 0.29]);
    expect(r.otros).toEqual([0.5]);
  });

  it('textos del centavo', () => {
    expect(textoSoloCentavo(2, 'gasto')).toBe(
      '2 gastos difieren por un centavo y ninguno cuadra exacto: vincúlalo a mano.',
    );
    expect(textoSoloCentavo(1, 'cargo')).toContain('Solo un cargo del banco');
  });
});

describe('patronTraspaso — los traspasos internos ya no son pendientes eternos', () => {
  it('reconoce la leyenda real del Scotiabank', () => {
    expect(patronTraspaso('SEL TRASPASO ENTRE CUENTAS')).toBe(
      'TRASPASO ENTRE CUENTAS',
    );
    expect(patronTraspaso('Traspaso entre cuentas propias')).toBe(
      'TRASPASO ENTRE CUENTAS',
    );
  });

  it('no clasifica de más', () => {
    expect(patronTraspaso('ASUR CANCUN')).toBeNull();
    expect(patronTraspaso(null)).toBeNull();
    expect(CLASIFICACION_TRASPASO).toBe('Traspaso entre cuentas');
  });
});

describe('montoCasa — tolerancia de centavos', () => {
  it('acepta un centavo de diferencia y rechaza más', () => {
    expect(montoCasa(125.82, 125.81)).toBe(true);
    expect(montoCasa(125.82, 125.83)).toBe(true);
    expect(montoCasa(125.82, 125.72)).toBe(false);
  });
});

describe('emparejarDuplicados — re-subir el mismo estado de cuenta', () => {
  const prev = [
    {
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion: 'AEROPUERTO DE COZUMEL',
      referencia: '9155656256',
    },
  ];

  it('el MISMO PDF con la descripción redactada distinta ya no se duplica', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'Aeropuerto Cozumel (TUA)',
          referencia: '9155656256',
        },
      ],
      prev,
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('misma descripción con referencias DISTINTAS es el MISMO movimiento (la referencia de la IA no es estable)', () => {
    // Antes (≤ 0.0.41) la referencia distinta lo volvía «otro cargo» y cada
    // re-importación lo insertaba otra vez.
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'AEROPUERTO DE COZUMEL',
          referencia: '0025830577',
        },
      ],
      prev,
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('dos cargos reales iguales: entra el segundo SOLO si el archivo trae dos y la base uno', () => {
    const linea = {
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion: 'AEROPUERTO DE COZUMEL',
    };
    const r = emparejarDuplicados(
      [
        { ...linea, referencia: '00000000000000000001' },
        { ...linea, referencia: '00000000000000000091' },
      ],
      prev,
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('sin referencia sigue valiendo la descripción (comportamiento viejo)', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
      ],
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
      ],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('el multiconjunto cuenta repeticiones, no presencia', () => {
    const dos = [
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
    ];
    const r = emparejarDuplicados(dos, [dos[0]]);
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('las líneas del MISMO archivo nunca se deduplican entre sí', () => {
    const dos = [
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
    ];
    const r = emparejarDuplicados(dos, []);
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(2);
  });

  it('claveBucket separa por día, tipo y monto', () => {
    expect(
      claveBucket({ fecha: '2026-09-08', tipo: 'CARGO', monto: '125.8' }),
    ).toBe('2026-09-08|CARGO|125.80');
  });
});

/**
 * INCIDENTE 29-sep-2026 («se me están duplicando los gastos»): las lecturas
 * REALES de prod del Scotiabank GASTOS GNRAL / COMBUSTIBLE, en el orden en
 * que se importaron (8, 15, 22 y 29 de septiembre). Cada `importar` simula
 * una subida: dedupe contra lo que ya hay y se inserta el resto.
 */
describe('emparejarDuplicados — re-lecturas REALES de la IA (29-sep-2026)', () => {
  type Linea = {
    fecha: string;
    tipo: string;
    monto: number;
    descripcion: string | null;
    referencia: string | null;
  };
  function importar(base: Linea[], archivo: Linea[]): Linea[] {
    return [...base, ...emparejarDuplicados(archivo, base).aInsertar];
  }
  const cozumel = (referencia: string): Linea => ({
    fecha: '2026-09-07',
    tipo: 'CARGO',
    monto: 125.82,
    descripcion: 'AEROPUERTO DE COZUMEL',
    referencia,
  });

  it('AEROPUERTO DE COZUMEL $125.82: 5 filas en prod ⇒ 2 (los 2 cargos reales)', () => {
    // 8-sep: los DOS cargos reales del día, con la tarjeta de cada uno.
    let base = importar([], [cozumel('0025830585'), cozumel('0025830577')]);
    expect(base).toHaveLength(2);
    // 22-sep: la IA trae un consecutivo por línea.
    base = importar(base, [
      cozumel('00000000000000000001'),
      cozumel('00000000000000000091'),
    ]);
    expect(base).toHaveLength(2);
    // 29-sep: consecutivo + « AUT. 456529» pegado a la referencia.
    base = importar(base, [cozumel('00000000000000000001 AUT. 456529')]);
    expect(base).toHaveLength(2);
  });

  it('REST HOTEL ZOMAY HOLBOX / «HOLBO» truncado: 3 filas en prod ⇒ 1', () => {
    const zomay = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-01',
      tipo: 'CARGO',
      monto: 455,
      descripcion,
      referencia,
    });
    let base = importar([], [zomay('REST HOTEL ZOMAY HOLBOX', '0025830585')]);
    base = importar(base, [zomay('REST HOTEL ZOMAY HOLBO', '955628')]);
    base = importar(base, [
      zomay('REST HOTEL ZOMAY HOLBO', '00000000732130325373'),
    ]);
    expect(base).toHaveLength(1);
  });

  it('SEL TRASPASO ENTRE CUENTAS $14,573.23: 3 filas en prod ⇒ 1', () => {
    const traspaso = (referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'ABONO',
      monto: 14573.23,
      descripcion: 'SEL TRASPASO ENTRE CUENTAS',
      referencia,
    });
    let base = importar([], [traspaso('000136717217')]);
    base = importar(base, [traspaso('00000000006251021753')]);
    base = importar(base, [traspaso('00000000062510217531 000136717217')]);
    expect(base).toHaveLength(1);
  });

  it('COMBUSTIBLE: «ASA CANCUN» vs «ASA CANCUN\\CARR CANCUN» con « REF. … AUT. …» es la misma carga', () => {
    const base: Linea[] = [
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 4920.55,
        descripcion: 'ASA CANCUN',
        referencia: '00000000011305556780',
      },
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 3572.85,
        descripcion: 'ASA CANCUN I',
        referencia: '00000000732144020298',
      },
    ];
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 4920.55,
          descripcion: 'ASA CANCUN\\CARR CANCUN',
          referencia: '00000000011305556780 REF. 9156174929 AUT. 404528',
        },
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 3572.85,
          descripcion: 'ASA CANCUN I\\CARR CANC',
          referencia: '00000000732144020298 REF. 9156174929 AUT. 583248',
        },
      ],
      base,
    );
    expect(r.duplicados).toBe(2);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('tarjeta repetida «0025830577»: la MISMA referencia no junta comercios distintos', () => {
    const base: Linea[] = [
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 150,
        descripcion: 'UBER TRIP',
        referencia: '0025830577',
      },
    ];
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'OXXO CISNE',
          referencia: '0025830577',
        },
      ],
      base,
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('UBER vs OXXO por $150 el mismo día (referencias distintas) son dos movimientos', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'OXXO CISNE',
          referencia: '00000000000000000002',
        },
      ],
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'MERPAGO*UBER',
          referencia: '00000000000000000001',
        },
      ],
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('los 7 abonos «CARGO INDEBIDO 21 SEP 355xx» con la MISMA referencia: re-subirlos no duplica y el 8.º real sí entra', () => {
    const indebido = (n: number): Linea => ({
      fecha: '2026-09-23',
      tipo: 'ABONO',
      monto: 825.13,
      descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
      referencia: '00000000001303268115',
    });
    const siete = [35555, 35564, 35552, 35578, 35579, 35572, 35554];
    const base = importar([], siete.map(indebido));
    expect(base).toHaveLength(7);
    expect(importar(base, siete.map(indebido))).toHaveLength(7);
    expect(importar(base, [...siete, 35580].map(indebido))).toHaveLength(8);
  });

  it('DIDI: dos viajes de $101 el mismo día en el MISMO archivo entran los dos; re-subirlos no duplica', () => {
    const didi = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 101,
      descripcion,
      referencia,
    });
    const archivo = [
      didi(
        'DLO*DIDI RIDES\\GENERAL',
        '00000000287142887037 REF. 9156174929 AUT. 198976',
      ),
      didi(
        'DLO DIDI RIDES MX\\\\CIU',
        '00000000625115012031 REF. 9156174929 AUT. 085488',
      ),
    ];
    const base = importar([], archivo);
    expect(base).toHaveLength(2);
    expect(importar(base, archivo)).toHaveLength(2);
  });

  it('la pareja EXACTA gana a la tolerante: entra la línea nueva, no la repetida', () => {
    const spei = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-10',
      tipo: 'CARGO',
      monto: 1500,
      descripcion,
      referencia,
    });
    const r = emparejarDuplicados(
      [
        // «TRANSFERENCI…» comparte 12 caracteres con la de Juan, pero la de
        // Juan tiene su pareja EXACTA: la de Pedro es la nueva.
        spei('TRANSFERENCIA A PEDRO LOPEZ', '00000000000000000001'),
        spei('TRANSFERENCIA A JUAN PEREZ', '00000000000000000002'),
      ],
      [spei('TRANSFERENCIA A JUAN PEREZ', '000125473315')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar.map((l) => l.descripcion)).toEqual([
      'TRANSFERENCIA A PEDRO LOPEZ',
    ]);
  });

  it('COMBUSTIBLE: «ASA CANCUN» y «ASA CANCUN I» con el MISMO monto el mismo día — el orden del archivo no deja una carga duplicada', () => {
    // «ASA CANCUN I\CARR CANC» empata por prefijo con las DOS filas previas
    // («ASA CANCUN» ⊂ …) y «ASA CANCUN\CARR CANCUN» solo con «ASA CANCUN».
    // Tomar «el primero que encuentre» le robaba la fila y la segunda carga
    // se insertaba otra vez; el emparejamiento máximo las acomoda a las dos.
    const carga = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 2995.26,
      descripcion,
      referencia,
    });
    const base = [
      carga('ASA CANCUN', '00000000011300318335'),
      carga('ASA CANCUN I', '00000000732139436897'),
    ];
    const archivo = [
      carga(
        'ASA CANCUN I\\CARR CANC',
        '00000000732139436897 REF. 9156174929 AUT. 543086',
      ),
      carga(
        'ASA CANCUN\\CARR CANCUN',
        '00000000011300318335 REF. 9156174929 AUT. 618872',
      ),
    ];
    expect(emparejarDuplicados(archivo, base).duplicados).toBe(2);
    expect(emparejarDuplicados([...archivo].reverse(), base).duplicados).toBe(
      2,
    );
  });

  it('la pareja por PREFIJO gana a la de «mismo inicio»: entra la línea nueva, no la truncada', () => {
    const hotel = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-01',
      tipo: 'CARGO',
      monto: 455,
      descripcion,
      referencia,
    });
    const r = emparejarDuplicados(
      [
        // Comparte «REST HOTEL Z» con ZOMAY, pero ZOMAY tiene su pareja
        // truncada («HOLBO» ⊂ «HOLBOX»): ZAZIL es el cargo nuevo.
        hotel('REST HOTEL ZAZIL HA', '00000000000000000001'),
        hotel('REST HOTEL ZOMAY HOLBO', '00000000000000000002'),
      ],
      [hotel('REST HOTEL ZOMAY HOLBOX', '0025830585')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar.map((l) => l.descripcion)).toEqual([
      'REST HOTEL ZAZIL HA',
    ]);
  });

  it('plazas distintas por el mismo monto NO se confunden (ni por 12 caracteres ni por la MISMA tarjeta)', () => {
    const tua = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [tua('AEROPUERTO DE CANCUN', '00000000000000000002')],
        [tua('AEROPUERTO DE COZUMEL', '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    expect(
      emparejarDuplicados(
        [tua('ASUR MERIDA', '0025830577')],
        [tua('ASUR CANCUN', '0025830577')],
      ).duplicados,
    ).toBe(0);
  });

  it('«CARGO INDEBIDO 21 SEP 35552» no se absorbe en el 35554 (números distintos)', () => {
    const indebido = (n: number, referencia: string): Linea => ({
      fecha: '2026-09-23',
      tipo: 'ABONO',
      monto: 825.13,
      descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [indebido(35552, '00000000000000000002')],
        [indebido(35554, '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    // Con la MISMA referencia tampoco: el número manda sobre la referencia.
    expect(
      emparejarDuplicados(
        [indebido(35552, '00000000001303268115')],
        [indebido(35554, '00000000001303268115')],
      ).duplicados,
    ).toBe(0);
  });

  it('«ASUR» (marca sola) no es prefijo de «ASUR CANCUN»; solo la MISMA referencia los junta', () => {
    const asur = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 212,
      descripcion,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [asur('ASUR CANCUN', '00000000000000000002')],
        [asur('ASUR', '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    expect(
      emparejarDuplicados(
        [asur('ASUR CANCUN', '0025830577')],
        [asur('ASUR', '0025830577')],
      ).duplicados,
    ).toBe(1);
  });

  it('una fila previa se usa UNA sola vez: tres líneas iguales contra una previa ⇒ entran dos', () => {
    const r = emparejarDuplicados(
      [
        cozumel('00000000000000000001'),
        cozumel('00000000000000000002'),
        cozumel('00000000000000000003'),
      ],
      [cozumel('0025830577')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(2);
  });

  it('otro día, otro tipo u otro monto nunca es duplicado', () => {
    const base = [cozumel('0025830577')];
    const r = emparejarDuplicados(
      [
        { ...cozumel('0025830577'), fecha: '2026-09-08' },
        { ...cozumel('0025830577'), tipo: 'ABONO' },
        { ...cozumel('0025830577'), monto: 125.83 },
      ],
      base,
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(3);
  });
});

describe('CONCEPTO DEL SPEI (0.0.75): parejas y previos en orden determinista', () => {
  const SPEI = 'SEL TRANSF. INTERBANCARIA SPEI';
  const linea = (descripcion: string, referencia: string) => ({
    fecha: '2026-09-12',
    tipo: 'CARGO',
    monto: 2231.38,
    descripcion,
    referencia,
  });

  it('re-subir con concepto NO duplica: «SEL TRANSF. INTERBANCARIA SPEI» vs «… BANORTE fact vip 7360», con la misma referencia y con otra', () => {
    const R = '00000000000000000001';
    const misma = emparejarDuplicados(
      [linea(`${SPEI} BANORTE fact vip 7360`, R)],
      [linea(SPEI, R)],
    );
    expect(misma.duplicados).toBe(1);
    expect(misma.parejas).toEqual([{ nuevo: 0, previo: 0, nivel: 0 }]);
    const otra = emparejarDuplicados(
      [linea(`${SPEI} BANORTE fact vip 7360`, '999')],
      [linea(SPEI, R)],
    );
    expect(otra.duplicados).toBe(1);
    expect(otra.parejas).toEqual([{ nuevo: 0, previo: 0, nivel: 2 }]);
  });

  it('gemelos 2×2: cada fila previa una sola vez y los índices son los de los arreglos recibidos', () => {
    const R = '00000000000000000001';
    const otroDia = { ...linea(SPEI, R), fecha: '2026-09-01' };
    const r = emparejarDuplicados(
      [
        linea(`${SPEI} BANORTE fact vip 7350`, R),
        linea(`${SPEI} BANORTE fact vip 7351`, R),
      ],
      [otroDia, linea(SPEI, R), linea(SPEI, R)],
    );
    expect(r.duplicados).toBe(2);
    expect(r.parejas.map((p) => p.previo).sort()).toEqual([1, 2]);
  });

  it('ordenarPreviosParaDedupe: fecha, tipo, monto, orden_archivo (null al final), created_at e id; copia sin mutar', () => {
    const previos = [
      {
        id: 'd',
        fecha: '2026-09-02',
        tipo: 'CARGO',
        monto: 5,
        orden_archivo: null,
      },
      {
        id: 'c',
        fecha: '2026-09-01',
        tipo: 'CARGO',
        monto: 5,
        orden_archivo: null,
        created_at: '2026-09-03T00:00:00Z',
      },
      {
        id: 'b',
        fecha: '2026-09-01',
        tipo: 'CARGO',
        monto: 5,
        orden_archivo: null,
        created_at: '2026-09-02T00:00:00Z',
      },
      {
        id: 'a',
        fecha: '2026-09-01',
        tipo: 'CARGO',
        monto: 5,
        orden_archivo: 7,
      },
      { id: 'e', fecha: '2026-09-01', tipo: 'ABONO', monto: 5 },
      { id: 'f', fecha: '2026-09-01', tipo: 'CARGO', monto: '4.99' },
    ];
    const copia = JSON.parse(JSON.stringify(previos)) as typeof previos;
    const orden = ordenarPreviosParaDedupe(previos).map((p) => p.id);
    expect(orden).toEqual(['e', 'f', 'a', 'b', 'c', 'd']);
    expect(previos).toEqual(copia);
    // Determinista: cualquier permutación de la entrada da lo mismo.
    expect(
      ordenarPreviosParaDedupe([...previos].reverse()).map((p) => p.id),
    ).toEqual(orden);
  });

  it('el conteo no cambia con el orden de las previas (multiconjunto intacto)', () => {
    const R = '00000000000000000001';
    const nuevos = [
      linea(`${SPEI} BANORTE fact vip 7350`, R),
      linea(`${SPEI} BANORTE fact vip 7351`, R),
      linea('ASA CANCUN', R),
    ];
    const previos = [linea(SPEI, R), linea('ASA CANCUN', R), linea(SPEI, R)];
    const a = emparejarDuplicados(nuevos, previos);
    const b = emparejarDuplicados(nuevos, ordenarPreviosParaDedupe(previos));
    expect(b.duplicados).toBe(a.duplicados);
    expect(b.aInsertar).toEqual(a.aInsertar);
  });
});

describe('mismaDescripcionDedupe / descripcionesSeContradicen', () => {
  it('normaliza acentos, mayúsculas, signos, espacios y prefijos de agregador', () => {
    expect(descDedupe('  Café  del   Aeropuerto. ')).toBe(
      'CAFE DEL AEROPUERTO',
    );
    expect(mismaDescripcionDedupe('MERPAGO*UBER', 'UBER')).toBe(true);
    expect(
      mismaDescripcionDedupe('Aeropuerto de Cozumel', 'AEROPUERTO DE COZUMEL'),
    ).toBe(true);
    expect(mismaDescripcionDedupe(null, '')).toBe(true);
  });

  it('prefijo: el lado corto debe tener ≥ 8 caracteres', () => {
    expect(
      mismaDescripcionDedupe(
        'REST HOTEL ZOMAY HOLBO',
        'REST HOTEL ZOMAY HOLBOX',
      ),
    ).toBe(true);
    expect(mismaDescripcionDedupe('OXXO Cisne', 'OXXO CISNE TLAQUEPAQUE')).toBe(
      true,
    );
    // «UBER» (4) no alcanza: una palabra corta no hace la misma línea.
    expect(mismaDescripcionDedupe('UBER', 'UBER EATS')).toBe(false);
    expect(mismaDescripcionDedupe('', 'ASA CANCUN')).toBe(false);
  });

  it('nivelDescripcionDedupe: 0 iguales, 1 prefijo, 2 mismo inicio, null distintas', () => {
    expect(nivelDescripcionDedupe('ASUR Cancún', 'ASUR CANCUN')).toBe(0);
    expect(
      nivelDescripcionDedupe('ASA CANCUN', 'ASA CANCUN\\CARR CANCUN'),
    ).toBe(1);
    expect(
      nivelDescripcionDedupe(
        'ASUR CANCUN\\\\CANCUN QR',
        'ASUR CANCUN CANCUN Q.ROO',
      ),
    ).toBe(2);
    expect(nivelDescripcionDedupe('UBER TRIP', 'OXXO CISNE')).toBeNull();
  });

  it('leyendasNombranDistinto: plazas o números distintos; truncado y «sin plaza» no cuentan', () => {
    expect(
      leyendasNombranDistinto('AEROPUERTO DE CANCUN', 'AEROPUERTO DE COZUMEL'),
    ).toBe(true);
    expect(leyendasNombranDistinto('ASUR CUN', 'ASUR CANCUN')).toBe(false);
    expect(
      leyendasNombranDistinto(
        'CARGO INDEBIDO 21 SEP 35554',
        'CARGO INDEBIDO 21 SEP 35552',
      ),
    ).toBe(true);
    expect(
      leyendasNombranDistinto(
        'CARGO INDEBIDO 21 SEP 355',
        'CARGO INDEBIDO 21 SEP 35554',
      ),
    ).toBe(false);
    expect(leyendasNombranDistinto('ASA CANCUN', 'ASA COMBUSTIBLE')).toBe(
      false,
    );
    expect(leyendasNombranDistinto(null, 'ASUR MERIDA')).toBe(false);
  });

  it('comparten los primeros 12 caracteres', () => {
    expect(
      mismaDescripcionDedupe(
        'DLO DIDI RIDES MX\\\\CIU',
        'DLO*DIDI RIDES\\GENERAL',
      ),
    ).toBe(true);
    expect(mismaDescripcionDedupe('ASA CANCUN', 'ASA MERIDA')).toBe(false);
    // 12 caracteres en común pero plazas distintas.
    expect(
      mismaDescripcionDedupe('AEROPUERTO DE CANCUN', 'AEROPUERTO DE COZUMEL'),
    ).toBe(false);
    expect(mismaDescripcionDedupe('AUTOZONE 7226', 'AUTOZONE 7227')).toBe(
      false,
    );
    expect(mismaDescripcionDedupe('UBER TRIP', 'OXXO CISNE')).toBe(false);
  });

  it('se contradicen solo si las dos traen texto y no comparten ningún token', () => {
    expect(descripcionesSeContradicen('UBER TRIP', 'OXXO CISNE')).toBe(true);
    // Comparten «ASUR» pero son plazas distintas (la tarjeta no las junta).
    expect(descripcionesSeContradicen('ASUR CANCUN', 'ASUR MERIDA')).toBe(true);
    expect(
      descripcionesSeContradicen(
        'AEROPUERTO DE COZUMEL',
        'Aeropuerto Cozumel (TUA)',
      ),
    ).toBe(false);
    expect(descripcionesSeContradicen(null, 'OXXO')).toBe(false);
    expect(descripcionesSeContradicen('REST HOTEL ZOMAY HOLBO', 'X')).toBe(
      false,
    );
  });
});

describe('ventanaDias', () => {
  it('±3 días alrededor de un DATE del banco', () => {
    expect(ventanaDias('2026-09-08', 3)).toEqual({
      desde: '2026-09-05',
      hasta: '2026-09-11',
    });
  });
});

/**
 * GASTO EN DÓLARES ↔ CARGO EN PESOS (13-oct-2026, lote 2, API 0.0.75,
 * invariante 70). Datos REALES de prod (SELECT del 13-oct-2026, 22:00
 * Cancún): las 6 ligas cruzadas correctas, las 2 equivocadas que se
 * corrigieron a las 21:40 y el señuelo.
 */
describe('T.C. oficial del día (invariante 70)', () => {
  const of = (
    tc: number,
    fecha_dato = '2026-09-01',
    fuente = 'open.er-api',
  ) => ({
    tc,
    fecha_dato,
    fuente,
  });
  const ev = (
    mxn: number,
    usd: number,
    oficial: ReturnType<typeof of> | null,
  ) => evaluarTcCruce(mxn, usd, oficial)!;

  it('(a) las 6 ligas correctas de prod: CERCA y en banda', () => {
    const casos: Array<[number, number, number, number, number]> = [
      [12451.49, 722.9, 17.2881, 17.22436, -0.4],
      [9062.34, 516.35, 17.4803, 17.55077, 0.4],
      [7214.14, 422.86, 17.0077, 17.060351, 0.3],
      [14431.18, 794.61, 17.8992, 18.161337, 1.5],
      [6015.21, 325.0, 18.4067, 18.508338, 0.6],
      [3740.63, 203.9, 18.4067, 18.345414, -0.3],
    ];
    for (const [mxn, usd, oficial, tc, desvio] of casos) {
      const e = ev(mxn, usd, of(oficial));
      expect(e).toMatchObject({
        tc_implicito: tc,
        desvio_pct: desvio,
        nivel: 'CERCA',
        en_banda: true,
      });
      expect(ligaUsdFueraDeLugar(e)).toBe(false);
    }
  });

  it('(a) LEJOS: las 2 equivocadas, el señuelo y las bujías contra el oficial del 24-sep (manda el día del CARGO)', () => {
    expect(ev(8939.38, 422.86, of(17.0077))).toMatchObject({
      tc_implicito: 21.140283,
      desvio_pct: 24.3,
      nivel: 'LEJOS',
    });
    expect(ev(14197.17, 794.61, of(17.4691))).toMatchObject({
      tc_implicito: 17.86684,
      desvio_pct: 2.3,
      nivel: 'LEJOS',
    });
    expect(ev(7380.8, 422.86, of(16.9479))).toMatchObject({
      tc_implicito: 17.454477,
      desvio_pct: 3.0,
      nivel: 'LEJOS',
    });
    expect(ev(14431.18, 794.61, of(17.4691))).toMatchObject({
      desvio_pct: 4.0,
      nivel: 'LEJOS',
    });
  });

  it('(b) fuera de la banda 15–25: texto y marca', () => {
    const e = ev(3740.63, 325, of(18.4067, '2026-10-12'));
    expect(e).toMatchObject({
      tc_implicito: 11.509631,
      en_banda: false,
      desvio_pct: -37.5,
    });
    expect(textoTcCruce(e)).toBe(
      'T.C. 11.51 · oficial 18.41 (−37.5 %): fuera de la banda 15–25',
    );
    expect(ligaUsdFueraDeLugar(e)).toBe(true);
    const e2 = ev(9000, 300, of(17));
    expect(e2.en_banda).toBe(false);
    expect(ligaUsdFueraDeLugar(e2)).toBe(true);
  });

  it('(c) bordes con oficial 17.0000 y 100 USD: se decide con el valor de 1 decimal que se MUESTRA', () => {
    const o = of(17);
    expect(ev(1734, 100, o)).toMatchObject({ desvio_pct: 2, nivel: 'CERCA' });
    expect(ev(1735.7, 100, o)).toMatchObject({
      desvio_pct: 2.1,
      nivel: 'LEJOS',
    });
    expect(ev(1666, 100, o)).toMatchObject({ desvio_pct: -2, nivel: 'CERCA' });
    expect(ev(1664.3, 100, o)).toMatchObject({
      desvio_pct: -2.1,
      nivel: 'LEJOS',
    });
    const cero = ev(1699.32, 100, o);
    expect(Object.is(cero.desvio_pct, -0)).toBe(false);
    expect(textoTcCruce(cero)).toBe('T.C. 16.99 · oficial 17.00 (0.0 %)');
    expect(ev(1734, 100, null)).toMatchObject({
      nivel: 'SIN_OFICIAL',
      desvio_pct: null,
      tc_oficial: null,
    });
    expect(evaluarTcCruce(1734, 0, o)).toBeNull();
    expect(evaluarTcCruce(0, 100, o)).toBeNull();
  });

  it('(d) textos y títulos exactos', () => {
    expect(textoTcCruce(ev(7214.14, 422.86, of(17.0077)))).toBe(
      'T.C. 17.06 · oficial 17.01 (+0.3 %)',
    );
    expect(textoTcCruce(ev(8939.38, 422.86, of(17.0077)))).toBe(
      'T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial',
    );
    expect(textoTcCruce(ev(12451.49, 722.9, of(17.2881, '2026-08-04')))).toBe(
      'T.C. 17.22 · oficial 17.29 (−0.4 %)',
    );
    expect(textoTcCruce(ev(9062.34, 516.35, null))).toBe(
      'T.C. 17.55 · sin T.C. oficial del día',
    );
    expect(tituloTcCruce(ev(7214.14, 422.86, of(17.0077)))).toBe(
      'T.C. exacto 17.060351 (pesos del cargo ÷ dólares del gasto) · oficial 17.0077 del 01 sep 2026 · fuente open.er-api · tolerancia ±2 %',
    );
    expect(
      tituloTcCruce(
        ev(12451.49, 722.9, of(17.2881, '2026-08-04', 'BCE (frankfurter)')),
      ),
    ).toBe(
      'T.C. exacto 17.224360 (pesos del cargo ÷ dólares del gasto) · oficial 17.2881 del 04 ago 2026 · fuente BCE (frankfurter) · tolerancia ±2 %',
    );
    expect(tituloTcCruce(ev(9062.34, 516.35, null))).toBe(
      'T.C. exacto 17.550770 (pesos del cargo ÷ dólares del gasto) · sin T.C. oficial del día del cargo: no se puede comparar',
    );
    expect(tituloTcCruce(ev(3740.63, 325, of(18.4067, '2026-10-12')))).toBe(
      'T.C. exacto 11.509631 (pesos del cargo ÷ dólares del gasto) · oficial 18.4067 del 12 oct 2026 · fuente open.er-api · tolerancia ±2 % · fuera de la banda 15–25: la base de datos no deriva el T.C. de esta liga',
    );
    expect(tcCruceUsdPublico(ev(8939.38, 422.86, of(17.0077)))).toEqual({
      tc_implicito: 21.140283,
      en_banda: true,
      tc_oficial: 17.0077,
      tc_oficial_fecha: '2026-09-01',
      tc_oficial_fuente: 'open.er-api',
      desvio_pct: 24.3,
      nivel: 'LEJOS',
      tolerancia_pct: 2,
      fuera_de_lugar: true,
      texto: 'T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial',
      titulo:
        'T.C. exacto 21.140283 (pesos del cargo ÷ dólares del gasto) · oficial 17.0077 del 01 sep 2026 · fuente open.er-api · tolerancia ±2 %',
    });
  });

  const TUBO =
    'Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00-6 Straight Valve Stem (x2)';
  const BUJIAS =
    '1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 108, 1 llanta Goodyear 6.00-6';
  const NOTA_516 =
    'Champion Spark Plug RHB32E (bujías) · Proveedor: Aircraft Spruce & Specialty Co.';

  it('(e) contrasteDescripcionUsd con tokens CRUDOS y exclusiones', () => {
    expect(
      contrasteDescripcionUsd('AIRCRAFT SPRUCE AND SP', { notas: TUBO }),
    ).toBe('COINCIDE');
    expect(
      contrasteDescripcionUsd('AIRCRAFT SPRUCE AND SP 516.35 USD', {
        notas: NOTA_516,
      }),
    ).toBe('COINCIDE');
    expect(
      contrasteDescripcionUsd('AIRCRAFT SPRUCE AND SP', { notas: BUJIAS }),
    ).toBe('CONTRADICE');
    expect(contrasteDescripcionUsd('ASA CANCUN', { lugar: 'Cancún' })).toBe(
      'SIN_TEXTO',
    );
    expect(
      contrasteDescripcionUsd('ASA CANCUN', {
        notas: 'ASA Cancún · Carga de turbosina 374 L',
      }),
    ).not.toBe('COINCIDE');
    // Mutante: con `expandirTokens` (ASUR → AEROPUERTO, CANCUN → CUN)
    // coincidiría; con tokens crudos sin giro ni ciudades, no.
    expect(
      contrasteDescripcionUsd('ASUR CANCUN', { lugar: 'Aeropuerto de Cancún' }),
    ).not.toBe('COINCIDE');
    expect(contrasteDescripcionUsd('THE AND INC', { notas: TUBO })).toBe(
      'SIN_TEXTO',
    );
    expect(
      contrasteDescripcionUsd('GARMIN STORE', {
        notas: 'Garmin actualización',
      }),
    ).toBe('DEBIL');
    // Los specs de puntuarDescripcion no cambian (el desempate de siempre).
    expect(
      puntuarDescripcion('ASUR CANCUN', { lugar: 'Aeropuerto de Cancún' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  const cargo = (fecha: string, monto: number, descripcion: string | null) => ({
    fecha,
    monto,
    descripcion,
  });
  const opcion = (id: string, usd: number, notas: string) => ({
    id,
    usd,
    gasto: { notas },
  });

  it('(f) decidirCruceUsd: LIGAR, LEJOS, dos CERCA, CONTRADICE, DEBIL y sin oficial', () => {
    const ligar = decidirCruceUsd(
      cargo('2026-09-01', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
      [opcion('tubo', 422.86, TUBO)],
      of(17.0077),
    );
    expect(ligar).toMatchObject({
      resultado: 'LIGAR',
      elegido_id: 'tubo',
      elegido_usd: 422.86,
      candidatos_n: 1,
      detalle: null,
    });
    expect(ligar.evaluacion?.desvio_pct).toBe(0.3);

    const lejos = decidirCruceUsd(
      cargo('2026-09-01', 8939.38, 'ASA CANCUN'),
      [opcion('tubo', 422.86, TUBO)],
      of(17.0077),
    );
    expect(lejos).toMatchObject({
      resultado: 'SIN_CANDIDATOS',
      candidatos_n: 0,
      descartados_n: 1,
      detalle:
        'El gasto en USD de $422.86 USD daría T.C. 21.14 · oficial 17.01 (+24.3 %): fuera de ±2 %, no se liga.',
    });

    expect(
      decidirCruceUsd(
        cargo('2026-09-01', 2000, 'AIRCRAFT SPRUCE AND SP'),
        [opcion('a', 100, TUBO), opcion('b', 99.5, TUBO)],
        of(20),
      ),
    ).toMatchObject({
      resultado: 'AMBIGUO',
      candidatos_n: 2,
      detalle:
        '2 gastos en USD cuadran con este cargo a ±2 % del T.C. oficial del 01 sep (20.00): vincúlalo a mano.',
    });

    // Sintético: las bujías dentro de la ventana del 14,431.18 de AIRCRAFT,
    // pero la leyenda no nombra nada del gasto.
    expect(
      decidirCruceUsd(
        cargo('2026-09-29', 14431.18, 'AIRCRAFT SPRUCE AND SP'),
        [opcion('bujias', 794.61, BUJIAS)],
        of(17.8992, '2026-09-29'),
      ),
    ).toMatchObject({
      resultado: 'AMBIGUO',
      candidatos_n: 1,
      detalle:
        'El gasto en USD de $794.61 USD cuadra con el T.C. oficial (T.C. 18.16 · oficial 17.90 (+1.5 %)), pero la descripción del banco («AIRCRAFT SPRUCE AND SP») no coincide con el gasto: vincúlalo a mano si de verdad es ese.',
    });

    expect(
      decidirCruceUsd(
        // La leyenda no trae palabras propias (solo el agregador): SIN_TEXTO.
        cargo('2026-09-01', 2000, 'MERPAGO*'),
        [opcion('x', 100, 'Compra en línea')],
        of(20),
      ),
    ).toMatchObject({
      resultado: 'AMBIGUO',
      detalle:
        'El gasto en USD de $100.00 USD cuadra con el T.C. oficial (T.C. 20.00 · oficial 20.00 (0.0 %)), pero la descripción del banco no basta para confirmarlo: vincúlalo a mano.',
    });

    expect(
      decidirCruceUsd(
        cargo('2026-06-27', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
        [opcion('tubo', 422.86, TUBO)],
        null,
      ),
    ).toMatchObject({
      resultado: 'AMBIGUO',
      candidatos_n: 1,
      detalle:
        'No hay T.C. oficial del 27 jun para comprobar el gasto en USD que podría ser este cargo: vincúlalo a mano.',
    });
    expect(
      decidirCruceUsd(
        cargo('2026-06-27', 7214.14, 'AIRCRAFT SPRUCE AND SP'),
        [opcion('a', 422.86, TUBO), opcion('b', 420, TUBO)],
        null,
      ).detalle,
    ).toBe(
      'No hay T.C. oficial del 27 jun para comprobar los 2 gastos en USD que podrían ser este cargo: vincúlalo a mano.',
    );

    expect(
      decidirCruceUsd(
        cargo('2026-09-01', 8939.38, 'ASA CANCUN'),
        [opcion('a', 422.86, TUBO), opcion('b', 420, TUBO)],
        of(17.0077),
      ),
    ).toMatchObject({
      resultado: 'SIN_CANDIDATOS',
      descartados_n: 2,
      detalle:
        '2 gastos en USD quedan a más de ±2 % del T.C. oficial del 01 sep (17.01): no se liga ninguno.',
    });

    // Fuera de banda: ni candidato ni descartado.
    expect(
      decidirCruceUsd(
        cargo('2026-09-01', 2000, 'X'),
        [opcion('a', 10, TUBO)],
        of(20),
      ),
    ).toMatchObject({ resultado: 'SIN_CANDIDATOS', detalle: null });
  });

  it('(f) jamás usa la terminación de tarjeta: dos CERCA con tarjeta distinta siguen AMBIGUO', () => {
    const r = decidirCruceUsd(
      cargo('2026-09-01', 2000, 'AIRCRAFT SPRUCE AND SP 0577'),
      [
        { id: 'a', usd: 100, gasto: { notas: TUBO } },
        { id: 'b', usd: 99.5, gasto: { notas: TUBO } },
      ],
      of(20),
    );
    expect(r.resultado).toBe('AMBIGUO');
  });

  it('(g) recíproco: CERCA y SIN_OFICIAL compiten, LEJOS y el propio cargo no; sus 3 textos', () => {
    const competidor = (
      id: string,
      monto: number,
      oficial: ReturnType<typeof of> | null,
    ) => ({
      id,
      fecha: '2026-09-03',
      monto,
      descripcion: 'AIRCRAFT SPRUCE AND SP',
      oficial,
    });
    const cerca = competidoresCruceUsd('propio', 422.86, [
      competidor('propio', 7214.14, of(17.0077)),
      competidor('c1', 7250, of(17.0077)),
      competidor('asa', 8939.38, of(17.0077)),
    ]);
    expect(cerca.map((c) => c.cargo.id)).toEqual(['c1']);
    expect(textoReciprocoCruceUsd(422.86, cerca)).toBe(
      'El gasto en USD de $422.86 USD también cuadra con el cargo del 03 sep de $7,250.00 («AIRCRAFT SPRUCE AND SP»): vincúlalo a mano.',
    );
    const sinOficial = competidoresCruceUsd('propio', 422.86, [
      competidor('c2', 7250, null),
    ]);
    expect(textoReciprocoCruceUsd(422.86, sinOficial)).toBe(
      'El gasto en USD de $422.86 USD también podría ser el cargo del 03 sep de $7,250.00 («AIRCRAFT SPRUCE AND SP»), y no hay T.C. oficial de ese día para descartarlo: vincúlalo a mano.',
    );
    const dos = competidoresCruceUsd('propio', 422.86, [
      competidor('c1', 7250, of(17.0077)),
      competidor('c2', 7200, null),
    ]);
    expect(textoReciprocoCruceUsd(422.86, dos)).toBe(
      'El gasto en USD de $422.86 USD también podría corresponder a otros 2 cargos del banco: vincúlalo a mano.',
    );
    expect(textoReciprocoCruceUsd(422.86, [])).toBeNull();
  });

  it('(h) ligaUsdFueraDeLugar marca EXACTAMENTE las 2 equivocadas entre las 8 ligas', () => {
    const ligas: Array<[string, number, number, number]> = [
      ['llantas', 12451.49, 722.9, 17.2881],
      ['516.35', 9062.34, 516.35, 17.4803],
      ['tubo ok', 7214.14, 422.86, 17.0077],
      ['bujías ok', 14431.18, 794.61, 17.8992],
      ['325', 6015.21, 325.0, 18.4067],
      ['203.90', 3740.63, 203.9, 18.4067],
      ['tubo ↔ ASA', 8939.38, 422.86, 17.0077],
      ['bujías ↔ ASA I', 14197.17, 794.61, 17.4691],
    ];
    expect(
      ligas
        .filter(([, mxn, usd, o]) => ligaUsdFueraDeLugar(ev(mxn, usd, of(o))))
        .map(([n]) => n),
    ).toEqual(['tubo ↔ ASA', 'bujías ↔ ASA I']);
  });

  it('textoSePuedeCruzarUsd y las constantes', () => {
    expect(
      textoSePuedeCruzarUsd(422.86, ev(7214.14, 422.86, of(17.0077))),
    ).toBe(
      'El gasto en USD de $422.86 USD cuadra con el T.C. oficial (T.C. 17.06 · oficial 17.01 (+0.3 %)) y la descripción del banco lo confirma: el cruce automático todavía no corre sobre este cargo. Pulsa «Cruzar pendientes» (o vincúlalo tú desde el menú).',
    );
    expect(piezaTcCruce(ev(7214.14, 422.86, of(17.0077)))).toBe(
      'T.C. 17.06 · oficial 17.01 (+0.3 %)',
    );
    expect(TEXTO_CRUCE_USD_TRUNCADO).toBe(
      'Hay demasiados gastos en USD en esas fechas para decidir solo: vincúlalo a mano.',
    );
    expect(TEXTO_CRUCE_USD_RECIPROCO_TRUNCADO).toBe(
      'Hay demasiados cargos del banco en esas fechas para decidir solo: vincúlalo a mano.',
    );
    expect(TEXTO_CRUCE_USD_RECIPROCO_ERROR).toBe(
      'No se pudo comprobar si el gasto en USD cuadra con otro cargo: el cruce no se intenta.',
    );
    expect(TEXTO_CRUCE_USD_SIN_LECTURA_TC).toBe(
      'No se pudo leer el T.C. oficial del día del cargo: el cruce con gastos en USD no se intentó; vuelve a correr «Cruzar pendientes».',
    );
    expect([
      TC_IMPLICITO_MIN,
      TC_IMPLICITO_MAX,
      TOLERANCIA_TC_OFICIAL_PCT,
    ]).toEqual([15, 25, 2]);
  });
});
