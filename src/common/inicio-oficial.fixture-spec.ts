import type { SupabaseService } from '../modules/supabase/supabase.service';

/**
 * Fixture de los specs del INICIO OFICIAL (invariante 86): un Supabase falso
 * que GRABA cada cadena de PostgREST (`from(tabla)` + métodos en orden) y
 * responde lo que diga `responder` (default: lista vacía). Sirve para
 * afirmar QUÉ filtros lleva cada lector con y sin piso, no para simular la BD.
 */
export type OpGrabada = { m: string; args: unknown[] };
export type ConsultaGrabada = { tabla: string; ops: OpGrabada[] };
export type Respuesta = { data: unknown; error: unknown; count?: number };
export type Responder = (
  tabla: string,
  ops: OpGrabada[],
) => Respuesta | undefined;

export function supabaseGrabador(responder?: Responder) {
  const consultas: ConsultaGrabada[] = [];
  const responde = (tabla: string, ops: OpGrabada[]): Respuesta =>
    responder?.(tabla, ops) ?? { data: [], error: null, count: 0 };
  const crear = (tabla: string) => {
    const ops: OpGrabada[] = [];
    consultas.push({ tabla, ops });
    const final = (unica: boolean): Respuesta => {
      const r = responde(tabla, ops);
      if (!unica) return r;
      return {
        ...r,
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
      };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'then') {
            return (
              res: (v: unknown) => unknown,
              rej?: (e: unknown) => unknown,
            ) => Promise.resolve(final(false)).then(res, rej);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => {
              ops.push({ m: prop, args: [] });
              return Promise.resolve(final(true));
            };
          }
          return (...args: unknown[]) => {
            ops.push({ m: prop, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const service = {
    from: crear,
    rpc: (fn: string, args: unknown) => {
      const ops: OpGrabada[] = [{ m: 'rpc', args: [args] }];
      consultas.push({ tabla: `rpc:${fn}`, ops });
      return Promise.resolve(responde(`rpc:${fn}`, ops));
    },
  };
  /** Consultas a una tabla (en orden). */
  const de = (tabla: string) => consultas.filter((c) => c.tabla === tabla);
  /** ¿La consulta lleva esta op con estos args? */
  const lleva = (c: ConsultaGrabada, m: string, ...args: unknown[]) =>
    c.ops.some(
      (o) =>
        o.m === m &&
        args.every((a, i) => JSON.stringify(o.args[i]) === JSON.stringify(a)),
    );
  return {
    supabase: { service } as unknown as SupabaseService,
    consultas,
    de,
    lleva,
  };
}

/** `ConfiguracionService` parcial con el inicio oficial dado. */
export function cfgInicio(inicio: string | null, extra: object = {}) {
  return {
    inicioOficial: jest.fn().mockResolvedValue(inicio),
    isActiva: jest.fn().mockResolvedValue(true),
    numero: jest
      .fn()
      .mockImplementation((_c: string, d: number) => Promise.resolve(d)),
    fecha: jest
      .fn()
      .mockImplementation((_c: string, d: string) => Promise.resolve(d)),
    ...extra,
  };
}
