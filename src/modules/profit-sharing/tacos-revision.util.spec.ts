import {
  detalleTacosEnRevision,
  motivoCorto,
  pilotosDeTacosEnRevision,
  resumenTacosEnRevision,
  type EscalaEnRevisionRow,
} from './tacos-revision.util';

const fila = (
  over: Partial<EscalaEnRevisionRow> = {},
): EscalaEnRevisionRow => ({
  id: 'e1',
  vuelo_id: 'v1',
  orden: 1,
  origen_iata: 'CUN',
  destino_iata: 'CZM',
  fecha_salida_plan: '2026-09-03T14:00:00+00:00',
  revision_motivo: 'Taco de llegada menor al de salida',
  piloto_id: 'p1',
  vuelo: {
    id: 'v1',
    folio: 10,
    estado: 'COMPLETADO',
    fecha_vuelo: '2026-09-03T14:00:00+00:00',
    piloto_id: 'pv',
  },
  ...over,
});

describe('tacos-revision.util (pre-cierre: ¿cuáles son?)', () => {
  it('motivoCorto: primera línea accionable, SIN la bitácora de procedencia', () => {
    expect(
      motivoCorto(
        'Falta foto del tacómetro; Registro: IA 0.62 · foto BAJA · confirmó Ana',
      ),
    ).toBe('Falta foto del tacómetro');
    // Solo bitácora = no hay nada accionable que decirle al operador.
    expect(motivoCorto('Registro: IA 0.9 · confirmó Ana')).toBeNull();
    expect(motivoCorto(null)).toBeNull();
    expect(motivoCorto('   ')).toBeNull();
    // Motivos larguísimos se recortan (en BD llegan a 1800 caracteres).
    const largo = motivoCorto('x'.repeat(400));
    expect(largo).not.toBeNull();
    expect((largo as string).length).toBeLessThanOrEqual(180);
    expect(largo as string).toMatch(/…$/);
  });

  it('pilotosDeTacosEnRevision: el del TRAMO y, si falta, el del VUELO (herencia)', () => {
    expect(
      pilotosDeTacosEnRevision([
        fila(),
        fila({ id: 'e2', piloto_id: null }),
        fila({ id: 'e3', piloto_id: 'p1' }),
      ]).sort(),
    ).toEqual(['p1', 'pv']);
  });

  it('arma vuelos deduplicados y tramos ordenados por folio y orden', () => {
    const nombres = new Map([
      ['p1', 'Luis Pérez'],
      ['pv', 'Ana Ruiz'],
    ]);
    const { vuelos, tramos } = resumenTacosEnRevision(
      [
        fila({ id: 'e2', orden: 2, origen_iata: 'CZM', destino_iata: 'CUN' }),
        fila(),
        fila({
          id: 'e3',
          vuelo_id: 'v0',
          orden: 1,
          piloto_id: null,
          revision_motivo: null,
          vuelo: {
            id: 'v0',
            folio: 9,
            estado: 'EN_VUELO',
            fecha_vuelo: '2026-09-01T10:00:00+00:00',
            piloto_id: 'pv',
          },
        }),
      ],
      nombres,
    );
    // Un chip por VUELO (el vuelo 10 traía dos tramos), ordenados por folio.
    expect(vuelos).toEqual([
      {
        id: 'v0',
        folio: 9,
        estado: 'EN_VUELO',
        fecha_vuelo: '2026-09-01T10:00:00+00:00',
      },
      {
        id: 'v1',
        folio: 10,
        estado: 'COMPLETADO',
        fecha_vuelo: '2026-09-03T14:00:00+00:00',
      },
    ]);
    expect(tramos.map((t) => [t.folio, t.orden])).toEqual([
      [9, 1],
      [10, 1],
      [10, 2],
    ]);
    expect(tramos[0]).toEqual({
      vuelo_id: 'v0',
      folio: 9,
      orden: 1,
      origen_iata: 'CUN',
      destino_iata: 'CZM',
      fecha_salida_plan: '2026-09-03T14:00:00+00:00',
      motivo: null,
      // Sin piloto en el tramo: hereda el del vuelo.
      piloto_nombre: 'Ana Ruiz',
    });
    expect(tramos[1].piloto_nombre).toBe('Luis Pérez');
    expect(tramos[1].motivo).toBe('Taco de llegada menor al de salida');
  });

  it('un piloto que no resuelve sale null, jamás un nombre inventado', () => {
    const { tramos } = resumenTacosEnRevision([fila()], new Map());
    expect(tramos[0].piloto_nombre).toBeNull();
  });

  it('sin filas: listas vacías', () => {
    expect(resumenTacosEnRevision([])).toEqual({ vuelos: [], tramos: [] });
  });

  it('detalle: dice cuántos TRAMOS y en cuántos vuelos (singular/plural)', () => {
    expect(detalleTacosEnRevision(3, 2)).toBe(
      '3 tramos con lectura en revisión en 2 vuelos. Confírmalos o ajústalos en Tacómetros en vivo.',
    );
    expect(detalleTacosEnRevision(1, 1)).toBe(
      '1 tramo con lectura en revisión en 1 vuelo. Confírmalos o ajústalos en Tacómetros en vivo.',
    );
    expect(detalleTacosEnRevision(0, 0)).toBe(
      'Confírmalos o ajústalos en Tacómetros en vivo.',
    );
  });
});
