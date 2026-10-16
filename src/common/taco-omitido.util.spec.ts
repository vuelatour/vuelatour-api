import {
  TACO_OMITIDO_MOTIVO_EN_BITACORA,
  TACO_OMITIDO_MOTIVO_MAX,
  TACO_OMITIDO_MOTIVO_MIN,
  conNombreOmitidoPor,
  esTramoOmitido,
  faltaTacoParaBadge,
  faltanLlegadas,
  faltanLlegadasReales,
  idsOmitidoPor,
  lineaRegistroDeshacerOmision,
  lineaRegistroOmision,
  lineaRegistroOmisionRetirada,
  motivoParaBitacora,
  normalizarMotivoOmision,
  textoTacoOmitido,
  tramoExigeLlegada,
} from './taco-omitido.util';
import {
  COLS_TACO_OMITIDO,
  MIGRACION_TACO_OMITIDO,
  colsTacoOmitido,
} from './taco-omitido-disponible.util';
import { leerBitacora, soloPendientes } from './taco-motivo.util';

/** Instante fijo: 15:40 UTC = 10:40 en Cancún (UTC−5). */
const AHORA = '2026-10-15T15:40:00Z';
const OMITIDO = {
  taco_omitido_at: AHORA,
  taco_omitido_por: 'u-itzi',
  taco_omitido_motivo: 'Falló el tacómetro',
  taco_salida: null,
  taco_llegada: null,
};

describe('taco-omitido.util (fuente única del tacómetro omitido, invariante 79)', () => {
  it('constantes y sonda', () => {
    expect(TACO_OMITIDO_MOTIVO_MIN).toBe(10);
    expect(TACO_OMITIDO_MOTIVO_MAX).toBe(500);
    expect(TACO_OMITIDO_MOTIVO_EN_BITACORA).toBe(160);
    expect(MIGRACION_TACO_OMITIDO).toBe('20261015000001');
    expect(colsTacoOmitido(true)).toBe(
      ', taco_omitido_at, taco_omitido_por, taco_omitido_motivo',
    );
    expect(colsTacoOmitido(false)).toBe('');
    expect(COLS_TACO_OMITIDO).toBe(
      'taco_omitido_at, taco_omitido_por, taco_omitido_motivo',
    );
  });

  it('renglones EXACTOS del bloque «Registro:» en hora Cancún', () => {
    expect(
      lineaRegistroOmision({
        quien: 'Itzi',
        cuando: AHORA,
        motivo: 'Falló el tacómetro',
      }),
    ).toBe(
      'tacómetro omitido por Itzi (oficina) el 2026-10-15 10:40: Falló el tacómetro',
    );
    expect(
      lineaRegistroDeshacerOmision({ quien: 'Itzi', cuando: new Date(AHORA) }),
    ).toBe(
      'omisión del tacómetro deshecha por Itzi (oficina) el 2026-10-15 10:40: vuelve a pedir la llegada',
    );
    expect(
      lineaRegistroOmisionRetirada({
        cuando: AHORA,
        como: 'capturada',
        quien: 'Luis Pérez',
      }),
    ).toBe(
      'omisión del tacómetro retirada el 2026-10-15 10:40: llegada capturada por Luis Pérez',
    );
    expect(
      lineaRegistroOmisionRetirada({
        cuando: AHORA,
        como: 'leída con IA',
        quien: 'Luis Pérez',
      }),
    ).toBe(
      'omisión del tacómetro retirada el 2026-10-15 10:40: llegada leída con IA por Luis Pérez',
    );
  });

  it('textoTacoOmitido: nunca «pendiente»; sin nombre ⇒ oficina; sin fecha ⇒ fecha desconocida', () => {
    expect(
      textoTacoOmitido({
        nombre: 'Itzi',
        at: AHORA,
        motivo: 'Falló el tacómetro',
      }),
    ).toBe('tacómetro omitido por Itzi (2026-10-15 10:40): Falló el tacómetro');
    expect(textoTacoOmitido({ nombre: null, at: null, motivo: null })).toBe(
      'tacómetro omitido por oficina (fecha desconocida): sin motivo',
    );
  });

  it('normalizarMotivoOmision: 10 y 500 pasan, 9 ⇒ null, 501 ⇒ recorte, espacios no cuentan', () => {
    expect(normalizarMotivoOmision('x'.repeat(10))).toBe('x'.repeat(10));
    expect(normalizarMotivoOmision('x'.repeat(500))).toBe('x'.repeat(500));
    expect(normalizarMotivoOmision('x'.repeat(9))).toBeNull();
    expect(normalizarMotivoOmision('x'.repeat(501))).toBe('x'.repeat(500));
    expect(normalizarMotivoOmision(' '.repeat(12))).toBeNull();
    expect(normalizarMotivoOmision('  Falló   el\n tacómetro  ')).toBe(
      'Falló el tacómetro',
    );
    // «a  b  c  d  e» = 9 caracteres útiles tras colapsar espacios.
    expect(normalizarMotivoOmision('a    b    c    d    e')).toBeNull();
    expect(normalizarMotivoOmision(null)).toBeNull();
    expect(normalizarMotivoOmision(12345678901)).toBeNull();
  });

  it('motivoParaBitacora: 161 ⇒ 160 con «…»; el «;» no parte la bitácora', () => {
    const m = motivoParaBitacora('x'.repeat(161));
    expect(m).toHaveLength(160);
    expect(m.endsWith('…')).toBe(true);
    expect(motivoParaBitacora('x'.repeat(160))).toBe('x'.repeat(160));
    const linea = lineaRegistroOmision({
      quien: 'Itzi',
      cuando: AHORA,
      motivo: 'Falló el tacómetro; sin foto',
    });
    expect(linea).toContain('Falló el tacómetro, sin foto');
    const revision = `Registro: ${linea}`;
    // Sin el cambio, «sin foto» saldría como PENDIENTE (amarillo falso).
    expect(soloPendientes(revision)).toBeNull();
    expect(leerBitacora(revision)).toBe(linea);
  });

  it('esTramoOmitido / tramoExigeLlegada', () => {
    expect(esTramoOmitido(OMITIDO)).toBe(true);
    expect(esTramoOmitido({ taco_omitido_at: null })).toBe(false);
    expect(esTramoOmitido({})).toBe(false);
    expect(tramoExigeLlegada(OMITIDO)).toBe(false);
    expect(tramoExigeLlegada({ taco_llegada: null })).toBe(true);
    expect(tramoExigeLlegada({ taco_llegada: 4455.1 })).toBe(false);
    expect(
      tramoExigeLlegada({ taco_llegada: null, cancelada_at: AHORA }),
    ).toBe(false);
  });

  it('faltanLlegadas: [omitido] ⇒ false, [] ⇒ true, [omitido, sin llegada] ⇒ true', () => {
    expect(faltanLlegadas([OMITIDO])).toBe(false);
    expect(faltanLlegadas([])).toBe(true);
    expect(
      faltanLlegadas([OMITIDO, { orden: 2, taco_salida: 1, taco_llegada: null }]),
    ).toBe(true);
    expect(
      faltanLlegadas([OMITIDO, { orden: 2, taco_salida: 1, taco_llegada: 2 }]),
    ).toBe(false);
  });

  it('faltanLlegadasReales (solo el cron zombi): el omitido CUENTA como faltante', () => {
    expect(faltanLlegadasReales([OMITIDO])).toBe(true);
    expect(faltanLlegadasReales([])).toBe(true);
    expect(faltanLlegadasReales([{ taco_salida: 1, taco_llegada: 2 }])).toBe(
      false,
    );
  });

  it('faltaTacoParaBadge', () => {
    expect(faltaTacoParaBadge([OMITIDO])).toEqual({
      falta: false,
      omitido: true,
    });
    expect(
      faltaTacoParaBadge([OMITIDO, { taco_salida: null, taco_llegada: 5 }]),
    ).toEqual({ falta: true, omitido: true });
    expect(faltaTacoParaBadge([])).toEqual({ falta: true, omitido: false });
    expect(faltaTacoParaBadge([{ taco_salida: 1, taco_llegada: 2 }])).toEqual(
      { falta: false, omitido: false },
    );
    expect(
      faltaTacoParaBadge([{ taco_salida: 1, taco_llegada: null }]),
    ).toEqual({ falta: true, omitido: false });
  });

  it('conNombreOmitidoPor nunca inventa; idsOmitidoPor deduplica', () => {
    const filas = [
      { id: 'a', taco_omitido_por: 'u-itzi' },
      { id: 'b', taco_omitido_por: 'u-borrado' },
      { id: 'c', taco_omitido_por: null },
      { id: 'd', taco_omitido_por: 'u-itzi' },
    ];
    expect(idsOmitidoPor(filas)).toEqual(['u-itzi', 'u-borrado']);
    const out = conNombreOmitidoPor(filas, new Map([['u-itzi', 'Itzi']]));
    expect(out.map((f) => f.taco_omitido_por_nombre)).toEqual([
      'Itzi',
      null,
      null,
      'Itzi',
    ]);
    // ADITIVO: la fila conserva sus llaves y su orden.
    expect(Object.keys(out[0])).toEqual([
      'id',
      'taco_omitido_por',
      'taco_omitido_por_nombre',
    ]);
  });
});
