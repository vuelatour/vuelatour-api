import {
  DETALLE_TACOS_OMITIDOS_FALLIDA,
  detalleTacosOmitidos,
  motivoOmisionCorto,
  resumenTacosOmitidos,
  usuariosDeTacosOmitidos,
  type EscalaOmitidaRow,
} from './tacos-omitidos.util';
import { MAX_TRAMOS_EN_REVISION } from './tacos-revision.util';

/** Caso #300 (prod, 15-oct-2026): CET → CUN, salida 20:00 UTC del 12-sep. */
const fila = (over: Partial<EscalaOmitidaRow> = {}): EscalaOmitidaRow => ({
  id: 'e300',
  vuelo_id: 'v300',
  orden: 1,
  origen_iata: 'CET',
  destino_iata: 'CUN',
  fecha_salida_plan: '2026-09-12T20:00:00+00:00',
  revision_motivo:
    'Registro: salida leída con IA · tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro',
  piloto_id: 'p1',
  taco_omitido_at: '2026-10-15T15:40:00+00:00',
  taco_omitido_por: 'u-itzi',
  taco_omitido_motivo: 'Falló el tacómetro',
  vuelo: {
    id: 'v300',
    folio: 300,
    estado: 'COMPLETADO',
    fecha_vuelo: '2026-09-12T20:00:00+00:00',
    piloto_id: 'pv',
  },
  ...over,
});

describe('tacos-omitidos.util (pre-cierre: renglón INFORMATIVO tacometros_omitidos)', () => {
  it('detalleTacosOmitidos: 0, singular y plural', () => {
    expect(detalleTacosOmitidos(0, 0)).toBe(
      'Ningún tramo con tacómetro omitido en el periodo.',
    );
    expect(detalleTacosOmitidos(1, 1)).toBe(
      '1 tramo con tacómetro omitido en 1 vuelo: aportan 0 h al cierre. Revisa que el motivo sea válido; si al final hay lectura, captúrala y la omisión se retira sola.',
    );
    expect(detalleTacosOmitidos(3, 2)).toBe(
      '3 tramos con tacómetro omitido en 2 vuelos: aportan 0 h al cierre. Revisa que el motivo sea válido; si al final hay lectura, captúrala y la omisión se retira sola.',
    );
  });

  it('usuariosDeTacosOmitidos: pilotos (con herencia) + quien omitió, sin repetir', () => {
    expect(
      usuariosDeTacosOmitidos([
        fila(),
        fila({ id: 'e2', piloto_id: null, taco_omitido_por: 'u-itzi' }),
        fila({ id: 'e3', taco_omitido_por: null }),
      ]).sort(),
    ).toEqual(['p1', 'pv', 'u-itzi']);
  });

  it('resumenTacosOmitidos: motivo de la OMISIÓN (no revision_motivo), quién y cuándo', () => {
    const { vuelos, tramos } = resumenTacosOmitidos(
      [fila()],
      new Map([
        ['p1', 'Luis Pérez'],
        ['u-itzi', 'Itzi'],
      ]),
    );
    expect(vuelos).toEqual([
      {
        id: 'v300',
        folio: 300,
        estado: 'COMPLETADO',
        fecha_vuelo: '2026-09-12T20:00:00+00:00',
      },
    ]);
    expect(tramos).toEqual([
      {
        vuelo_id: 'v300',
        folio: 300,
        orden: 1,
        origen_iata: 'CET',
        destino_iata: 'CUN',
        fecha_salida_plan: '2026-09-12T20:00:00+00:00',
        motivo: 'Falló el tacómetro',
        piloto_nombre: 'Luis Pérez',
        escala_id: 'e300',
        omitido_por_nombre: 'Itzi',
        omitido_at: '2026-10-15T15:40:00+00:00',
      },
    ]);
  });

  it('vuelos deduplicados, tramos por folio y orden; nombres que no resuelven ⇒ null', () => {
    const { vuelos, tramos } = resumenTacosOmitidos([
      fila({ id: 'e2', orden: 2, origen_iata: 'CUN', destino_iata: 'CET' }),
      fila(),
      fila({
        id: 'e9',
        vuelo_id: 'v279',
        piloto_id: null,
        taco_omitido_por: null,
        vuelo: {
          id: 'v279',
          folio: 279,
          estado: 'CONFIRMADO',
          fecha_vuelo: '2026-09-13T15:00:00+00:00',
          piloto_id: 'pv',
        },
      }),
    ]);
    expect(vuelos.map((v) => v.folio)).toEqual([279, 300]);
    expect(tramos.map((t) => `${t.folio}/${t.orden}`)).toEqual([
      '279/1',
      '300/1',
      '300/2',
    ]);
    expect(tramos.every((t) => t.omitido_por_nombre === null)).toBe(true);
    expect(tramos.every((t) => t.piloto_nombre === null)).toBe(true);
  });

  it(`tope de ${MAX_TRAMOS_EN_REVISION} líneas (el count lo pone el service con el total real)`, () => {
    const rows = Array.from({ length: MAX_TRAMOS_EN_REVISION + 5 }, (_, i) =>
      fila({ id: `e${i}`, orden: i + 1 }),
    );
    expect(resumenTacosOmitidos(rows).tramos).toHaveLength(
      MAX_TRAMOS_EN_REVISION,
    );
  });

  it('escala_id (invariante 81) sale de la fila; sin id ⇒ null (jamás inventado)', () => {
    const { tramos } = resumenTacosOmitidos([
      fila({ id: undefined as unknown as string }),
    ]);
    expect(tramos[0]).toHaveProperty('escala_id', null);
  });

  it('DETALLE_TACOS_OMITIDOS_FALLIDA: lectura fallida nunca dice «Ningún tramo…»', () => {
    expect(DETALLE_TACOS_OMITIDOS_FALLIDA).toBe(
      'No se pudo leer qué tramos tienen el tacómetro omitido.',
    );
  });

  it('motivoOmisionCorto: recorta a 180 con «…»; vacío ⇒ null', () => {
    const m = motivoOmisionCorto('x'.repeat(400));
    expect(m).toHaveLength(180);
    expect(m?.endsWith('…')).toBe(true);
    expect(motivoOmisionCorto('  ')).toBeNull();
    expect(motivoOmisionCorto(null)).toBeNull();
  });
});
