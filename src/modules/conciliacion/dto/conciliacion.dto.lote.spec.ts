import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GastosCandidatosQuery,
  LinkMovimientoDto,
  loteInvalido,
} from './conciliacion.dto';

/**
 * 1 cargo ↔ N gastos (2-oct-2026, API 0.0.52). Misma configuración del
 * ValidationPipe de main.ts (whitelist + forbidNonWhitelisted + conversión
 * implícita). El panel viejo sigue mandando `{gasto_id}`: debe pasar igual.
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';

function link(plain: Record<string, unknown>): LinkMovimientoDto {
  return plainToInstance(LinkMovimientoDto, plain, {
    enableImplicitConversion: true,
  });
}

async function props(plain: Record<string, unknown>): Promise<string[]> {
  return (await validate(link(plain), OPTS)).map((e) => e.property);
}

describe('LinkMovimientoDto — gasto_id (como hoy) y gasto_ids (lote)', () => {
  it('{gasto_id} (panel viejo) pasa y no es lote', async () => {
    const d = link({ gasto_id: A });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.gasto_id).toBe(A);
    expect(d.gasto_ids).toBeUndefined();
    expect(loteInvalido(d)).toBe(false);
  });

  it('{gasto_id: null} = desligar todo', async () => {
    const d = link({ gasto_id: null });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.gasto_id).toBeNull();
    expect(loteInvalido(d)).toBe(false);
  });

  it('{gasto_ids: [A, B]} pasa', async () => {
    const d = link({ gasto_ids: [A, B] });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.gasto_ids).toEqual([A, B]);
    expect(loteInvalido(d)).toBe(false);
  });

  it('{gasto_ids: null} = ausente', async () => {
    const d = link({ gasto_ids: null });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(loteInvalido(d)).toBe(false);
  });

  it('vacío, repetidos, no-uuid o más de 50 ⇒ 400 en gasto_ids', async () => {
    expect(await props({ gasto_ids: [] })).toEqual(['gasto_ids']);
    expect(await props({ gasto_ids: [A, A] })).toEqual(['gasto_ids']);
    expect(await props({ gasto_ids: [A, 'no-uuid'] })).toEqual(['gasto_ids']);
    const muchos = Array.from(
      { length: 51 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(await props({ gasto_ids: muchos })).toEqual(['gasto_ids']);
    expect(await props({ gasto_ids: A })).toEqual(['gasto_ids']);
  });

  it('gasto_ids + gasto_id (aunque sea null) ⇒ LOTE_INVALIDO', () => {
    expect(loteInvalido(link({ gasto_ids: [A, B], gasto_id: A }))).toBe(true);
    expect(loteInvalido(link({ gasto_ids: [A], gasto_id: null }))).toBe(true);
  });

  it('un campo desconocido sigue rebotando (forbidNonWhitelisted)', async () => {
    expect(await props({ gasto_ids: [A, B], otro: 1 })).toEqual(['otro']);
  });
});

describe('GastosCandidatosQuery — q, dias y limite', () => {
  const q = (plain: Record<string, unknown>) =>
    plainToInstance(GastosCandidatosQuery, plain, {
      enableImplicitConversion: true,
    });

  it('defaults: dias 30, limite 100, sin q', async () => {
    const d = q({});
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.dias).toBe(30);
    expect(d.limite).toBe(100);
    expect(d.q).toBeUndefined();
  });

  it('strings de la URL se convierten', async () => {
    const d = q({ q: '2801.40', dias: '120', limite: '300' });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d).toMatchObject({ q: '2801.40', dias: 120, limite: 300 });
  });

  it('fuera de rango o q larga ⇒ 400', async () => {
    const errs = async (p: Record<string, unknown>) =>
      (await validate(q(p), OPTS)).map((e) => e.property);
    expect(await errs({ dias: 0 })).toEqual(['dias']);
    expect(await errs({ dias: 181 })).toEqual(['dias']);
    expect(await errs({ limite: 301 })).toEqual(['limite']);
    expect(await errs({ q: 'x'.repeat(81) })).toEqual(['q']);
  });
});
