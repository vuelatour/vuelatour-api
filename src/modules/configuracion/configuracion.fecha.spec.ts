import {
  CONFIG_FOLIOS_RELEER_DESDE,
  ConfiguracionService,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * FECHA en `valor_json` (6-oct-2026, relectura del folio de gastos):
 * `["AAAA-MM-DD"]` (la tabla solo admite arreglos en `valor_json`), default
 * si no hay fila / no es una fecha real / la consulta falla, y caché de 60 s.
 */
function armar(respuestas: Array<{ data: unknown; error: unknown }>) {
  const consultas: Array<{ select: string; eq: unknown[] }> = [];
  let i = 0;
  const service = {
    from(tabla: string) {
      expect(tabla).toBe('configuracion_sistema');
      const c = { select: '', eq: [] as unknown[] };
      consultas.push(c);
      const q = {
        select(s: string) {
          c.select = s;
          return q;
        },
        eq(...a: unknown[]) {
          c.eq = a;
          return q;
        },
        maybeSingle() {
          const r = respuestas[Math.min(i, respuestas.length - 1)];
          i += 1;
          return Promise.resolve(r);
        },
      };
      return q;
    },
  };
  const svc = new ConfiguracionService({
    service,
  } as unknown as SupabaseService);
  return { svc, consultas };
}

describe('ConfiguracionService.fecha', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lee el primer elemento de valor_json si es AAAA-MM-DD real', async () => {
    const { svc, consultas } = armar([
      { data: { clave: 'x', valor_json: ['2026-08-01'] }, error: null },
    ]);
    await expect(
      svc.fecha(CONFIG_FOLIOS_RELEER_DESDE, '2026-09-01'),
    ).resolves.toBe('2026-08-01');
    expect(consultas[0]).toEqual({
      select: 'clave, valor_json',
      eq: ['clave', 'folios_releer_desde'],
    });
  });

  it.each([
    ['sin fila', null],
    ['valor_json null', { valor_json: null }],
    ['día inexistente', { valor_json: ['2026-02-30'] }],
    ['otro formato', { valor_json: ['01/08/2026'] }],
    ['número', { valor_json: [20260801] }],
    ['arreglo vacío', { valor_json: [] }],
  ])('%s ⇒ default', async (_n, data) => {
    const { svc } = armar([{ data, error: null }]);
    await expect(svc.fecha('k', '2026-09-01')).resolves.toBe('2026-09-01');
  });

  it('acepta un string suelto (por si algún día se relaja el CHECK)', () => {
    expect(ConfiguracionService.fechaDeValorJson(' 2026-07-15 ')).toBe(
      '2026-07-15',
    );
  });

  it('consulta caída ⇒ default, y con un valor previo ⇒ el último leído', async () => {
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, consultas } = armar([
      { data: { valor_json: ['2026-08-01'] }, error: null },
      { data: null, error: { message: 'timeout' } },
    ]);
    await expect(svc.fecha('k', '2026-09-01')).resolves.toBe('2026-08-01');
    // Dentro de 60 s: caché, sin consultar.
    await expect(svc.fecha('k', '2026-09-01')).resolves.toBe('2026-08-01');
    expect(consultas).toHaveLength(1);
    // Vencido el caché y la BD caída: el último leído.
    ahora.mockReturnValue(1_000_000 + 61_000);
    await expect(svc.fecha('k', '2026-09-01')).resolves.toBe('2026-08-01');
    expect(consultas).toHaveLength(2);
    // Otra clave sin caché y la BD caída: el default.
    await expect(svc.fecha('otra', '2026-09-01')).resolves.toBe('2026-09-01');
  });
});
