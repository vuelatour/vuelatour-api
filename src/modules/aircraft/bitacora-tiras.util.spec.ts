import {
  construirTiras,
  formatearHoras,
  normalizarTiras,
  resolverTirasSolicitadas,
  type FilaBaseBitacora,
} from './bitacora-tiras.util';

// Dos vuelos de la PEV: uno ANTERIOR a la referencia del planeador (taco
// 100.0 < ref 151.9) y el último del histórico (taco final 345.2 = hoy).
const filasPev: FilaBaseBitacora[] = [
  {
    fecha: '2025-03-10T15:00:00+00:00',
    taco_inicial: 100.0,
    horas: 1.5,
    taco_final: 101.5,
    ruta: 'cun-pps-cun',
  },
  {
    fecha: '2026-08-30T15:00:00+00:00',
    taco_inicial: 343.7,
    horas: 1.5,
    taco_final: 345.2,
    ruta: 'cun-hol-cun',
  },
];

// Ficha real de la PEV: base de planeador capturada, motor y hélice SIN
// horas (horas_totales 0 con ref anclada en 328.2).
const aeronavePev = { planeador_horas_base: 5226.1, planeador_taco_ref: 151.9 };
const motorPevSinBase = {
  posicion: 'UNICO',
  numero_serie: 'L-12345-48A',
  horas_totales: 0,
  aeronave_horas_ref: 328.2,
};
const helicePevSinBase = {
  posicion: 'UNICA',
  numero_serie: 'H-777',
  horas_totales: 0,
  aeronave_horas_ref: 328.2,
};

describe('construirTiras (bitácoras de vuelo: planeador, motor y hélice)', () => {
  it('PEV real: planeador con base (sin recorte), motor solo tacómetro, hélice en blanco', () => {
    const tiras = construirTiras({
      tiras: ['PLANEADOR', 'MOTOR', 'HELICE'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [motorPevSinBase],
      helices: [helicePevSinBase],
    });
    expect(tiras.map((t) => t.tipo)).toEqual(['PLANEADOR', 'MOTOR', 'HELICE']);

    const [planeador, motor, helice] = tiras;
    expect(planeador).toMatchObject({
      titulo: 'Bitácora de planeador',
      etiqueta: 'Tiempo planeador',
      con_tiempo: true,
      nota: 'Base del planeador: 5,226.1 h cuando el tacómetro marcaba 151.9',
    });
    // Renglón anterior a la referencia: 5226.1 + (100.0 − 151.9) = 5174.2
    expect(planeador.filas[0]).toMatchObject({
      fecha: filasPev[0].fecha,
      taco_inicial: 100.0,
      horas: 1.5,
      taco_final: 101.5,
      tiempo_inicial: 5174.2,
      tiempo_final: 5175.7,
      ruta: 'cun-pps-cun',
    });
    // Hoy: 5226.1 + (345.2 − 151.9) = 5419.4 (= tiempoTotalPlaneador).
    expect(planeador.filas[1].tiempo_final).toBe(5419.4);

    expect(motor).toMatchObject({
      titulo: 'Bitácora de motor',
      etiqueta: 'Tiempo motor',
      con_tiempo: false,
      nota: 'Tiempo del motor = lectura del tacómetro (sin horas del motor capturadas en su ficha)',
    });
    expect(motor.filas).toHaveLength(2);
    expect(motor.filas[1]).toMatchObject({
      taco_inicial: 343.7,
      taco_final: 345.2,
      tiempo_inicial: null,
      tiempo_final: null,
      ruta: 'cun-hol-cun',
    });

    expect(helice).toMatchObject({
      titulo: 'Bitácora de hélice',
      etiqueta: 'Tiempo hélice',
      con_tiempo: true,
      nota: 'Sin horas de hélice capturadas: llena las columnas a mano (o captúralas en Componentes → hélice)',
    });
    expect(helice.filas.map((f) => [f.tiempo_inicial, f.tiempo_final])).toEqual(
      [
        [null, null],
        [null, null],
      ],
    );
  });

  it('helice_base tecleado: offset constante desde el PRIMER renglón y gana sobre la ficha', () => {
    const [helice] = construirTiras({
      tiras: ['HELICE'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [],
      helices: [
        { ...helicePevSinBase, horas_totales: 900, aeronave_horas_ref: 300 },
      ],
      heliceBase: 1200,
    });
    expect(helice).toMatchObject({
      tipo: 'HELICE',
      titulo: 'Bitácora de hélice',
      con_tiempo: true,
      nota: 'Tiempo de hélice del primer renglón capturado a mano: 1,200.0',
    });
    // offset = 1200 − 100.0 = 1100
    expect(helice.filas[0]).toMatchObject({
      tiempo_inicial: 1200,
      tiempo_final: 1201.5,
    });
    expect(helice.filas[1]).toMatchObject({
      tiempo_inicial: 1443.7,
      tiempo_final: 1445.2,
    });
  });

  it('hélice con ficha (sin helice_base): misma fórmula que el motor', () => {
    const [helice] = construirTiras({
      tiras: ['HELICE'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [],
      helices: [
        {
          posicion: 'UNICA',
          numero_serie: 'H-777',
          horas_totales: 900,
          aeronave_horas_ref: 300,
        },
      ],
    });
    expect(helice).toMatchObject({
      titulo: 'Bitácora de hélice',
      etiqueta: 'Tiempo hélice',
      con_tiempo: true,
      nota: 'Hélice S/N H-777: 900.0 h cuando el tacómetro marcaba 300.0',
    });
    // 900 + (345.2 − 300) = 945.2; renglón viejo: 900 + (100 − 300) = 700
    expect(helice.filas[1].tiempo_final).toBe(945.2);
    expect(helice.filas[0].tiempo_inicial).toBe(700);
  });

  it('bimotor (enum real IZQUIERDO/DERECHO): una tira por motor con base, izquierdo antes que derecho', () => {
    const tiras = construirTiras({
      tiras: ['MOTOR'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [
        {
          posicion: 'DERECHO',
          numero_serie: 'D-2',
          horas_totales: 1500,
          aeronave_horas_ref: 300,
        },
        {
          posicion: 'IZQUIERDO',
          numero_serie: 'I-1',
          horas_totales: 1200.5,
          aeronave_horas_ref: 300,
        },
        // Sin base: no genera tira propia (los que sí tienen mandan).
        { posicion: 'CENTRAL', numero_serie: 'C-0', horas_totales: 0 },
      ],
      helices: [],
    });
    expect(tiras.map((t) => t.titulo)).toEqual([
      'Bitácora de motor izquierdo',
      'Bitácora de motor derecho',
    ]);
    expect(tiras[0]).toMatchObject({
      tipo: 'MOTOR',
      etiqueta: 'Tiempo motor',
      con_tiempo: true,
      nota: 'Motor S/N I-1: 1,200.5 h cuando el tacómetro marcaba 300.0',
    });
    // 1200.5 + (345.2 − 300) = 1245.7 (misma aritmética que componenteEstado)
    expect(tiras[0].filas[1].tiempo_final).toBe(1245.7);
    expect(tiras[1].filas[1].tiempo_final).toBe(1545.2);
    expect(tiras[1].nota).toBe(
      'Motor S/N D-2: 1,500.0 h cuando el tacómetro marcaba 300.0',
    );
  });

  it('hélices bimotor (enum real IZQUIERDA/DERECHA) y abreviaturas IZQ/DER', () => {
    const helices = construirTiras({
      tiras: ['HELICE'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [],
      helices: [
        {
          posicion: 'DERECHA',
          numero_serie: 'HD',
          horas_totales: 500,
          aeronave_horas_ref: 300,
        },
        {
          posicion: 'IZQUIERDA',
          numero_serie: 'HI',
          horas_totales: 400,
          aeronave_horas_ref: 300,
        },
      ],
    });
    expect(helices.map((t) => t.titulo)).toEqual([
      'Bitácora de hélice izquierda',
      'Bitácora de hélice derecha',
    ]);
    expect(helices[0].nota).toBe(
      'Hélice S/N HI: 400.0 h cuando el tacómetro marcaba 300.0',
    );
    // Abreviaturas toleradas (mismo lado).
    const abrev = construirTiras({
      tiras: ['MOTOR'],
      filasBase: [],
      aeronave: {},
      motores: [
        {
          posicion: 'der',
          numero_serie: 'D',
          horas_totales: 1,
          aeronave_horas_ref: 0,
        },
        {
          posicion: 'IZQ',
          numero_serie: 'I',
          horas_totales: 1,
          aeronave_horas_ref: 0,
        },
      ],
      helices: [],
    });
    expect(abrev.map((t) => t.titulo)).toEqual([
      'Bitácora de motor izquierdo',
      'Bitácora de motor derecho',
    ]);
  });

  it('posición fuera de IZQ/DER/UNICO va literal en el título', () => {
    const [tira] = construirTiras({
      tiras: ['MOTOR'],
      filasBase: [],
      aeronave: {},
      motores: [
        {
          posicion: 'CENTRAL',
          numero_serie: 'C-0',
          horas_totales: 10,
          aeronave_horas_ref: 0,
        },
      ],
      helices: [],
    });
    expect(tira.titulo).toBe('Bitácora de motor CENTRAL');
    expect(tira.filas).toEqual([]);
  });

  it('planeador sin base (0/0): el tiempo iguala al tacómetro con la nota de "sin base"', () => {
    const [planeador] = construirTiras({
      tiras: ['PLANEADOR'],
      filasBase: filasPev,
      aeronave: { planeador_horas_base: 0, planeador_taco_ref: 0 },
      motores: [],
      helices: [],
    });
    expect(planeador.nota).toBe(
      'Sin base de planeador capturada en la ficha del avión: el tiempo iguala al tacómetro',
    );
    expect(
      planeador.filas.map((f) => [f.tiempo_inicial, f.tiempo_final]),
    ).toEqual([
      [100.0, 101.5],
      [343.7, 345.2],
    ]);
    // La ficha con nulls también cuenta como "sin base".
    const [sinFicha] = construirTiras({
      tiras: ['PLANEADOR'],
      filasBase: filasPev,
      aeronave: { planeador_horas_base: null, planeador_taco_ref: null },
      motores: [],
      helices: [],
    });
    expect(sinFicha.nota).toMatch(/^Sin base de planeador/);
    expect(sinFicha.filas[1].tiempo_final).toBe(345.2);
  });

  it('dedupe y orden canónico de las tiras (PLANEADOR, MOTOR, HELICE)', () => {
    expect(
      normalizarTiras(['HELICE', 'motor', ' helice ', 'PLANEADOR', 'X']),
    ).toEqual(['PLANEADOR', 'MOTOR', 'HELICE']);
    expect(normalizarTiras(undefined)).toEqual([]);

    const tiras = construirTiras({
      tiras: ['HELICE', 'MOTOR', 'HELICE', 'PLANEADOR'],
      filasBase: filasPev,
      aeronave: aeronavePev,
      motores: [motorPevSinBase],
      helices: [helicePevSinBase],
    });
    expect(tiras.map((t) => t.tipo)).toEqual(['PLANEADOR', 'MOTOR', 'HELICE']);
    // Todas las tiras comparten EXACTAMENTE las mismas filas base.
    for (const t of tiras) {
      expect(
        t.filas.map((f) => [
          f.fecha,
          f.taco_inicial,
          f.horas,
          f.taco_final,
          f.ruta,
        ]),
      ).toEqual(
        filasPev.map((f) => [
          f.fecha,
          f.taco_inicial,
          f.horas,
          f.taco_final,
          f.ruta,
        ]),
      );
    }
  });

  it('resolverTirasSolicitadas: tiras manda; formato DEPRECADO solo sin tiras; default las tres', () => {
    expect(resolverTirasSolicitadas({})).toEqual([
      'PLANEADOR',
      'MOTOR',
      'HELICE',
    ]);
    expect(resolverTirasSolicitadas({ formato: 'MOTOR_HELICE' })).toEqual([
      'MOTOR',
      'HELICE',
    ]);
    expect(resolverTirasSolicitadas({ formato: 'PLANEADOR' })).toEqual([
      'MOTOR',
    ]);
    expect(
      resolverTirasSolicitadas({
        tiras: ['HELICE', 'PLANEADOR'],
        formato: 'MOTOR_HELICE',
      }),
    ).toEqual(['PLANEADOR', 'HELICE']);
  });

  it('sin vuelos en el periodo: las tiras salen con filas vacías (el PDF avisa)', () => {
    const tiras = construirTiras({
      tiras: ['PLANEADOR', 'MOTOR', 'HELICE'],
      filasBase: [],
      aeronave: aeronavePev,
      motores: [motorPevSinBase],
      helices: [helicePevSinBase],
      heliceBase: 1200,
    });
    expect(tiras).toHaveLength(3);
    expect(tiras.every((t) => t.filas.length === 0)).toBe(true);
  });

  it('formatearHoras: 1 decimal con separador de miles', () => {
    expect(formatearHoras(5226.1)).toBe('5,226.1');
    expect(formatearHoras(151.9)).toBe('151.9');
    expect(formatearHoras(1234567.4)).toBe('1,234,567.4');
    expect(formatearHoras(0)).toBe('0.0');
    expect(formatearHoras(-51.9)).toBe('-51.9');
  });
});
