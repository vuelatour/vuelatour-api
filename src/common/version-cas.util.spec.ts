import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CODE_CONFLICTO_VERSION,
  aplicarCas,
  assertVersion,
  conflictoVersion,
  instanteDe,
  mensajeConflictoVersion,
  mismaVersion,
  ventanaCas,
} from './version-cas.util';

/**
 * Control de versión `if_updated_at` → 409 CONFLICTO_VERSION (10-sep-2026,
 * Ola B). El caso que importa: Postgres/PostgREST serializan MICROSEGUNDOS
 * (`…56.123456+00:00`) y la app reserializa a milisegundos (`…56.123Z`):
 * comparar strings rompería siempre; comparar instantes con ±1 ms no.
 */
const TS_DB = '2026-09-10T12:34:56.123456+00:00';
const TS_APP = '2026-09-10T12:34:56.123Z';

describe('instanteDe', () => {
  it('ISO con microsegundos, ISO con ms, Date y número → el mismo instante', () => {
    const t = instanteDe(TS_APP)!;
    expect(instanteDe(TS_DB)).toBe(t);
    expect(instanteDe(new Date(TS_APP))).toBe(t);
    expect(instanteDe(t)).toBe(t);
  });

  it('null, vacío, texto o Date inválido → null', () => {
    expect(instanteDe(null)).toBeNull();
    expect(instanteDe(undefined)).toBeNull();
    expect(instanteDe('')).toBeNull();
    expect(instanteDe('ayer')).toBeNull();
    expect(instanteDe(new Date('nope'))).toBeNull();
    expect(instanteDe(Number.NaN)).toBeNull();
  });
});

describe('mismaVersion — instantes con tolerancia de 1 ms', () => {
  it('microsegundos de BD vs milisegundos de la app = misma versión', () => {
    expect(mismaVersion(TS_APP, TS_DB)).toBe(true);
    expect(mismaVersion(TS_DB, TS_APP)).toBe(true);
  });

  it('±1 ms pasa; ±2 ms es otra versión', () => {
    expect(mismaVersion('2026-09-10T12:34:56.124Z', TS_DB)).toBe(true);
    expect(mismaVersion('2026-09-10T12:34:56.122Z', TS_DB)).toBe(true);
    expect(mismaVersion('2026-09-10T12:34:56.125Z', TS_DB)).toBe(false);
    expect(mismaVersion('2026-09-10T12:34:56.121Z', TS_DB)).toBe(false);
  });

  it('un lado ilegible nunca "coincide"', () => {
    expect(mismaVersion('ayer', TS_DB)).toBe(false);
    expect(mismaVersion(TS_APP, null)).toBe(false);
    expect(mismaVersion(undefined, TS_DB)).toBe(false);
  });
});

describe('ventanaCas / aplicarCas', () => {
  it('ventana [t−1 ms, t+1 ms] en forma canónica', () => {
    expect(ventanaCas(TS_DB)).toEqual({
      desde: '2026-09-10T12:34:56.122Z',
      hasta: '2026-09-10T12:34:56.124Z',
    });
  });

  it('valor ilegible → 400 (defensa; el DTO ya lo valida)', () => {
    expect(() => ventanaCas('ayer')).toThrow(BadRequestException);
  });

  type Q = {
    ops: string[];
    gte(c: string, v: string): Q;
    lte(c: string, v: string): Q;
  };
  const builder = (): Q => {
    const q: Q = {
      ops: [],
      gte(c, v) {
        q.ops.push(`gte:${c}:${v}`);
        return q;
      },
      lte(c, v) {
        q.ops.push(`lte:${c}:${v}`);
        return q;
      },
    };
    return q;
  };

  it('sin if_updated_at devuelve el builder INTACTO (comportamiento actual)', () => {
    const q = builder();
    expect(aplicarCas(q, undefined)).toBe(q);
    expect(aplicarCas(q, null)).toBe(q);
    expect(aplicarCas(q, '')).toBe(q);
    expect(q.ops).toEqual([]);
  });

  it('con if_updated_at encadena gte/lte sobre updated_at (o la columna dada)', () => {
    const q = builder();
    aplicarCas(q, TS_APP);
    expect(q.ops).toEqual([
      'gte:updated_at:2026-09-10T12:34:56.122Z',
      'lte:updated_at:2026-09-10T12:34:56.124Z',
    ]);
    const q2 = builder();
    aplicarCas(q2, TS_APP, 'modificado_en');
    expect(q2.ops[0]).toMatch(/^gte:modificado_en:/);
  });
});

describe('conflictoVersion / assertVersion', () => {
  const fila = { id: 'v-1', estado: 'CANCELADO', updated_at: TS_DB };

  it('409 estructurado: code CONFLICTO_VERSION, message es-MX y details {actual, enviado, actual}', () => {
    const err = conflictoVersion({
      entidad: 'vuelo',
      actual: fila,
      enviado: TS_APP,
    });
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    const r = err.getResponse() as Record<string, unknown>;
    expect(r.error).toBe(CODE_CONFLICTO_VERSION);
    expect(r.message).toBe(mensajeConflictoVersion('vuelo'));
    expect(r.message).toBe(
      'Alguien modificó este vuelo después de tu captura; se conserva la versión del servidor.',
    );
    expect(r.details).toEqual({
      actual: fila,
      updated_at_enviado: TS_APP,
      updated_at_actual: TS_DB,
    });
  });

  it('sin fila viva (no se pudo releer) → actual null y updated_at_actual null', () => {
    const r = conflictoVersion({
      entidad: 'tramo',
      actual: null,
      enviado: TS_APP,
    }).getResponse() as { details: Record<string, unknown> };
    expect(r.details.actual).toBeNull();
    expect(r.details.updated_at_actual).toBeNull();
  });

  it('assertVersion: sin llave → sin_llave; fila sin columna → omitido; igual → verificado', () => {
    expect(
      assertVersion({ entidad: 'vuelo', enviado: undefined, actual: fila }),
    ).toBe('sin_llave');
    expect(
      assertVersion({ entidad: 'vuelo', enviado: TS_APP, actual: { id: 1 } }),
    ).toBe('omitido');
    expect(
      assertVersion({
        entidad: 'vuelo',
        enviado: TS_APP,
        actual: { id: 1, updated_at: null },
      }),
    ).toBe('omitido');
    expect(
      assertVersion({ entidad: 'vuelo', enviado: TS_APP, actual: fila }),
    ).toBe('verificado');
  });

  it('assertVersion: distinta → lanza el 409 con la fila leída como actual', () => {
    let capturado: unknown;
    try {
      assertVersion({
        entidad: 'gasto',
        enviado: '2026-09-10T12:34:56.000Z',
        actual: fila,
      });
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBeInstanceOf(ConflictException);
    const r = (capturado as ConflictException).getResponse() as {
      error: string;
      message: string;
      details: { actual: unknown };
    };
    expect(r.error).toBe('CONFLICTO_VERSION');
    expect(r.message).toMatch(/este gasto/);
    expect(r.details.actual).toBe(fila);
  });
});
