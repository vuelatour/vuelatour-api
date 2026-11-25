import { ConfiguracionService } from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Lecturas simultáneas de la configuración comparten UNA consulta
 * (25-nov-2026). El caché de 60 s ya existía, pero al vencer —o al arrancar—
 * cada petición que llegaba mientras la lectura seguía en curso lanzaba la
 * suya: con la base lenta (lecturas de 20 s) eran decenas de consultas
 * idénticas a la vez. En los registros de Supabase del 25-nov, 14:43 Cancún:
 * 237 lecturas de `fecha_inicio_oficial` y 97 de las banderas en UN minuto.
 */

type Res = { data: unknown; error: null | { message: string } };

/** Doble de Supabase con respuestas que el test suelta cuando quiere. */
function armar() {
  const pendientes: Array<{ tabla: string; soltar: (r: Res) => void }> = [];
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order']) q[m] = () => q;
    const esperar = () =>
      new Promise<Res>((soltar) => pendientes.push({ tabla, soltar }));
    q.maybeSingle = esperar;
    q.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      esperar().then(resolve, reject);
    return q;
  };
  const service = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  return { service, pendientes };
}

const tic = () => new Promise<void>((r) => setImmediate(r));

describe('ConfiguracionService — lecturas simultáneas comparten una consulta', () => {
  it('inicio oficial: 40 peticiones a la vez = UNA lectura y todas reciben la fecha', async () => {
    const { service, pendientes } = armar();
    const rafaga = Array.from({ length: 40 }, () => service.inicioOficial());
    await tic();
    expect(pendientes).toHaveLength(1);
    pendientes[0].soltar({
      data: { activa: true, valor_json: ['2026-09-01'] },
      error: null,
    });
    expect(new Set(await Promise.all(rafaga))).toEqual(new Set(['2026-09-01']));
    // Ya en caché: ni una consulta más.
    await expect(service.inicioOficial()).resolves.toBe('2026-09-01');
    expect(pendientes).toHaveLength(1);
  });

  it('inicio oficial: si la lectura falla nadie se queda colgado y la siguiente reintenta', async () => {
    const { service, pendientes } = armar();
    const rafaga = Array.from({ length: 5 }, () => service.inicioOficial());
    await tic();
    pendientes[0].soltar({ data: null, error: { message: 'caída' } });
    expect(await Promise.all(rafaga)).toEqual([null, null, null, null, null]);
    const otra = service.inicioOficial();
    await tic();
    expect(pendientes).toHaveLength(2);
    pendientes[1].soltar({
      data: { activa: true, valor_json: ['2026-09-01'] },
      error: null,
    });
    await expect(otra).resolves.toBe('2026-09-01');
  });

  it('banderas: 40 peticiones a la vez = UNA lectura de la tabla', async () => {
    const { service, pendientes } = armar();
    const rafaga = [
      ...Array.from({ length: 20 }, () => service.isActiva('alguna', false)),
      ...Array.from({ length: 20 }, () => service.numero('dias', 3)),
    ];
    await tic();
    expect(pendientes).toHaveLength(1);
    pendientes[0].soltar({
      data: [
        { clave: 'alguna', activa: true, valor_numerico: null },
        { clave: 'dias', activa: true, valor_numerico: 7 },
      ],
      error: null,
    });
    const r = await Promise.all(rafaga);
    expect(r.slice(0, 20).every((v) => v === true)).toBe(true);
    expect(r.slice(20).every((v) => v === 7)).toBe(true);
    await expect(service.numero('dias', 3)).resolves.toBe(7);
    expect(pendientes).toHaveLength(1);
  });

  it('banderas: con la consulta caída todas responden su default y la siguiente reintenta', async () => {
    const { service, pendientes } = armar();
    const rafaga = Array.from({ length: 5 }, () => service.numero('dias', 3));
    await tic();
    pendientes[0].soltar({ data: null, error: { message: 'caída' } });
    expect(await Promise.all(rafaga)).toEqual([3, 3, 3, 3, 3]);
    const otra = service.numero('dias', 3);
    await tic();
    expect(pendientes).toHaveLength(2);
    pendientes[1].soltar({
      data: [{ clave: 'dias', activa: true, valor_numerico: 7 }],
      error: null,
    });
    await expect(otra).resolves.toBe(7);
  });
});
