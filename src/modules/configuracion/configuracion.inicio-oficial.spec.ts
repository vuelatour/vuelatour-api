import { HttpException } from '@nestjs/common';
import {
  CONFIG_FECHA_INICIO_OFICIAL,
  ConfiguracionService,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * INICIO OFICIAL (16-oct-2026, invariante 86): `inicioOficial()` respeta
 * `activa`, valida el día y su default es `null` (= sin piso, como 0.0.83).
 * La clave no sale en `GET /v1/config` ni se edita por `PATCH :clave`.
 */
type Op = { m: string; args: unknown[] };

function armar(respuestas: Array<{ data: unknown; error: unknown }>) {
  const llamadas: Op[][] = [];
  let i = 0;
  const from = (tabla: string) => {
    expect(tabla).toBe('configuracion_sistema');
    const ops: Op[] = [];
    llamadas.push(ops);
    const q: Record<string, unknown> = {};
    for (const met of ['select', 'eq', 'neq', 'order', 'update']) {
      q[met] = (...args: unknown[]) => {
        ops.push({ m: met, args });
        return q;
      };
    }
    q.maybeSingle = () => {
      const r = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return Promise.resolve(r);
    };
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  const svc = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  return { svc, llamadas };
}

describe('ConfiguracionService.inicioOficial', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fila activa con ["2026-09-01"] ⇒ la fecha (lee clave, activa y valor_json de SU clave)', async () => {
    const { svc, llamadas } = armar([
      {
        data: { clave: 'x', activa: true, valor_json: ['2026-09-01'] },
        error: null,
      },
    ]);
    await expect(svc.inicioOficial()).resolves.toBe('2026-09-01');
    expect(llamadas[0]).toEqual([
      { m: 'select', args: ['clave, activa, valor_json'] },
      { m: 'eq', args: ['clave', CONFIG_FECHA_INICIO_OFICIAL] },
    ]);
  });

  it.each([
    ['sin fila', null],
    ['activa = false', { activa: false, valor_json: ['2026-09-01'] }],
    ['día inexistente', { activa: true, valor_json: ['2026-02-30'] }],
    ['valor_json null', { activa: true, valor_json: null }],
    ['otro formato', { activa: true, valor_json: ['01/09/2026'] }],
  ])('%s ⇒ null (sin piso)', async (_n, data) => {
    const { svc } = armar([{ data, error: null }]);
    await expect(svc.inicioOficial()).resolves.toBeNull();
  });

  it('caché de 60 s: una sola consulta; vencido, vuelve a leer', async () => {
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, llamadas } = armar([
      { data: { activa: true, valor_json: ['2026-09-01'] }, error: null },
      { data: { activa: false, valor_json: ['2026-09-01'] }, error: null },
    ]);
    await expect(svc.inicioOficial()).resolves.toBe('2026-09-01');
    await expect(svc.inicioOficial()).resolves.toBe('2026-09-01');
    expect(llamadas).toHaveLength(1);
    ahora.mockReturnValue(1_000_000 + 61_000);
    await expect(svc.inicioOficial()).resolves.toBeNull();
    expect(llamadas).toHaveLength(2);
  });

  it('BD caída tras una lectura ⇒ el último valor; sin lectura previa ⇒ null', async () => {
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc } = armar([
      { data: { activa: true, valor_json: ['2026-09-01'] }, error: null },
      { data: null, error: { message: 'timeout' } },
    ]);
    await expect(svc.inicioOficial()).resolves.toBe('2026-09-01');
    ahora.mockReturnValue(1_000_000 + 61_000);
    await expect(svc.inicioOficial()).resolves.toBe('2026-09-01');

    const otro = armar([{ data: null, error: { message: 'timeout' } }]);
    await expect(otro.svc.inicioOficial()).resolves.toBeNull();
  });

  it('list() EXCLUYE la clave', async () => {
    const { svc, llamadas } = armar([]);
    await svc.list();
    expect(llamadas[0]).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_FECHA_INICIO_OFICIAL],
    });
  });

  it('PATCH de la clave ⇒ 400 CLAVE_NO_EDITABLE_AQUI y no escribe', async () => {
    const { svc, llamadas } = armar([]);
    try {
      await svc.update(CONFIG_FECHA_INICIO_OFICIAL, { activa: false }, 'u');
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const r = (e as HttpException).getResponse() as Record<string, unknown>;
      expect((e as HttpException).getStatus()).toBe(400);
      expect(r.error).toBe('CLAVE_NO_EDITABLE_AQUI');
      expect(r.message).toContain('invariante 86');
    }
    expect(llamadas).toHaveLength(0);
  });
});
