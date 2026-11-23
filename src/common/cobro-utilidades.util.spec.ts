/**
 * Piezas PURAS y lectores del cobro con utilidades del socio (23-nov-2026,
 * API 0.0.148, invariante 143): etiquetas, llave de un cobro sin id, día de
 * Cancún, traducción de los errores de la BD y los tres lectores tolerantes
 * a la migración ausente.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claveCobroUtilidades,
  codigoBdCobroUtilidades,
  colCobroUtilidades,
  diaCancunDe,
  entregaDeCobro,
  errorAltaCobroUtilidades,
  errorCobroConUtilidades,
  errorEntregaDeVuelo,
  etiquetaCobroConUtilidades,
  etiquetasUtilidadesDeVuelos,
  referenciaEntregaDeVuelo,
  utilidadesDeCobros,
  vuelosDeEntregas,
} from './cobro-utilidades.util';

type Fila = Record<string, unknown>;

/** Cliente mínimo: `cobro_vuelo` en memoria, con `in`, `eq`, `not`, `limit`. */
function fakeSb(
  cobros: Fila[],
  opts: { sinColumna?: boolean; error?: Fila } = {},
) {
  const lecturas: string[] = [];
  const from = () => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let sel = '';
    const ejecutar = () => {
      lecturas.push(sel);
      if (opts.sinColumna && sel.includes('reparto_pago_id')) {
        return {
          data: null,
          error: {
            code: '42703',
            message: 'column cobro_vuelo.reparto_pago_id does not exist',
          },
        };
      }
      // La sonda (`select reparto_pago_id limit 1`) siempre pasa.
      if (opts.error && sel !== 'reparto_pago_id') {
        return { data: null, error: opts.error };
      }
      return {
        data: cobros.filter((f) => filtros.every((fn) => fn(f))),
        error: null,
      };
    };
    const q = {
      select: (c: string) => {
        sel = c;
        return q;
      },
      eq: (col: string, v: unknown) => {
        filtros.push((f) => f[col] === v);
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        filtros.push((f) => vs.includes(f[col]));
        return q;
      },
      not: (col: string) => {
        filtros.push((f) => f[col] != null);
        return q;
      },
      limit: () => q,
      maybeSingle: () => {
        const r = ejecutar();
        return Promise.resolve({
          data: (r.data ?? [])[0] ?? null,
          error: r.error,
        });
      },
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(ok),
    };
    return q;
  };
  return { sb: { from } as unknown as SupabaseClient, lecturas };
}

const COBRO_498 = {
  id: 'c-498',
  vuelo_id: 'v-498',
  monto: 44174.3,
  moneda: 'MXN',
  fecha_cobro: '2026-10-28T17:00:00+00:00',
  reparto_pago_id: 'e-498',
  vuelo: {
    folio: 498,
    fecha_vuelo: '2026-10-28T15:00:00+00:00',
    cliente: { nombre: ' Macedo ' },
    aeronave: [{ matricula: 'N621TX' }],
  },
  entrega: {
    id: 'e-498',
    socio_id: 's-macedo',
    aeronave_id: 'a-n621tx',
    periodo: '2026-10-01',
    fecha_pago: '2026-10-28',
    socio: { nombre: 'Macedo' },
    aeronave: { matricula: 'N621TX' },
  },
};
const COBRO_NORMAL = {
  id: 'c-normal',
  vuelo_id: 'v-498',
  monto: 1000,
  moneda: 'MXN',
  fecha_cobro: '2026-10-29T17:00:00+00:00',
  reparto_pago_id: null,
};

describe('etiquetas y llaves', () => {
  it('etiqueta del cobro: con el socio entre paréntesis; sin nombre, a secas', () => {
    expect(etiquetaCobroConUtilidades('Macedo')).toBe(
      'Utilidades del socio (Macedo)',
    );
    expect(etiquetaCobroConUtilidades('  ')).toBe('Utilidades del socio');
    expect(etiquetaCobroConUtilidades(null)).toBe('Utilidades del socio');
  });

  it('referencia de la entrega y sufijo del select', () => {
    expect(referenciaEntregaDeVuelo(498)).toBe('Vuelo #498');
    expect(referenciaEntregaDeVuelo(null)).toBe('Vuelo');
    expect(colCobroUtilidades(true)).toBe(', reparto_pago_id');
    expect(colCobroUtilidades(false)).toBe('');
  });

  it('día de Cancún (UTC−5, sin horario de verano): la madrugada UTC es el día anterior', () => {
    expect(diaCancunDe('2026-11-01T03:00:00.000Z')).toBe('2026-10-31');
    expect(diaCancunDe('2026-11-01T05:00:00.000Z')).toBe('2026-11-01');
    expect(diaCancunDe('2026-10-28T12:00:00-05:00')).toBe('2026-10-28');
    expect(diaCancunDe('no es fecha')).toBeNull();
    expect(diaCancunDe(null)).toBeNull();
  });

  it('llave de un cobro sin id: el mismo instante escrito de dos formas da la misma llave', () => {
    const a = claveCobroUtilidades(COBRO_498);
    expect(a).toBe(
      claveCobroUtilidades({
        ...COBRO_498,
        monto: '44174.30',
        fecha_cobro: '2026-10-28T12:00:00-05:00',
      }),
    );
    expect(a).not.toBe(claveCobroUtilidades({ ...COBRO_498, monto: 44174.31 }));
    expect(a).not.toBe(
      claveCobroUtilidades({ ...COBRO_498, vuelo_id: 'otro' }),
    );
  });
});

describe('errores con code estable', () => {
  it('código de la BD: por el hint o por el prefijo del mensaje; lo demás, null', () => {
    expect(codigoBdCobroUtilidades({ hint: 'ENTREGA_DE_VUELO' })).toBe(
      'ENTREGA_DE_VUELO',
    );
    expect(
      codigoBdCobroUtilidades({ message: 'COBRO_CON_UTILIDADES: este cobro…' }),
    ).toBe('COBRO_CON_UTILIDADES');
    expect(codigoBdCobroUtilidades({ hint: 'COBRO_CONCILIADO' })).toBeNull();
    expect(codigoBdCobroUtilidades(null)).toBeNull();
  });

  it('alta: candado de la BD ⇒ 409 con el texto sin el prefijo; función o columna ausente ⇒ 503; CHECK/FK ⇒ 400; lo demás, el Error tal cual', () => {
    const forma = (e: unknown) => {
      const x = e as { getStatus?: () => number; getResponse?: () => Fila };
      return [x.getStatus?.() ?? 500, x.getResponse?.().error ?? null];
    };
    const candado = errorAltaCobroUtilidades({
      code: '23514',
      hint: 'UTILIDADES_ENTREGA_DADA_DE_BAJA',
      message:
        'UTILIDADES_ENTREGA_DADA_DE_BAJA: la entrega al socio está dada de baja',
    });
    expect(forma(candado)).toEqual([409, 'UTILIDADES_ENTREGA_DADA_DE_BAJA']);
    expect(
      (candado as unknown as { getResponse: () => Fila }).getResponse().message,
    ).toBe('la entrega al socio está dada de baja');
    expect(
      forma(
        errorAltaCobroUtilidades({
          code: 'PGRST202',
          message: 'Could not find the function',
        }),
      ),
    ).toEqual([503, 'COBRO_UTILIDADES_NO_DISPONIBLE']);
    expect(
      forma(
        errorAltaCobroUtilidades({
          code: '42703',
          message:
            'column "reparto_pago_id" of relation "cobro_vuelo" does not exist',
        }),
      ),
    ).toEqual([503, 'COBRO_UTILIDADES_NO_DISPONIBLE']);
    expect(
      forma(errorAltaCobroUtilidades({ code: '23514', message: 'check' })),
    ).toEqual([400, 'COBRO_UTILIDADES_INVALIDO']);
    expect(
      forma(errorAltaCobroUtilidades({ code: '23503', message: 'fk' })),
    ).toEqual([400, 'COBRO_UTILIDADES_REFERENCIA_INVALIDA']);
    const otro = errorAltaCobroUtilidades({
      code: '57014',
      message: 'timeout',
    });
    expect(forma(otro)).toEqual([500, null]);
    expect(otro.message).toBe('timeout');
  });

  it('corrección del cobro y de la entrega: 409 con su code y sus details', () => {
    const c = errorCobroConUtilidades({ campos: ['monto'] });
    expect(c.getStatus()).toBe(409);
    expect(c.getResponse()).toMatchObject({
      error: 'COBRO_CON_UTILIDADES',
      details: { campos: ['monto'] },
    });
    const e = errorEntregaDeVuelo({
      id: 'v-498',
      folio: 498,
      cobro_id: 'c-498',
      fecha: null,
      cliente: null,
      matricula: null,
    });
    expect(e.getResponse()).toMatchObject({
      error: 'ENTREGA_DE_VUELO',
      details: { vuelo_id: 'v-498', folio: 498, cobro_id: 'c-498' },
    });
    expect((e.getResponse() as Fila).message).toContain('vuelo #498');
  });
});

describe('lectores (tolerantes a la migración ausente)', () => {
  it('vuelosDeEntregas: entrega → vuelo (folio, día Cancún, cliente y matrícula del embed, objeto o arreglo)', async () => {
    const { sb } = fakeSb([COBRO_498, COBRO_NORMAL]);
    const esperado = {
      id: 'v-498',
      folio: 498,
      cobro_id: 'c-498',
      fecha: '2026-10-28',
      cliente: 'Macedo',
      matricula: 'N621TX',
    };
    expect([...(await vuelosDeEntregas(sb, ['e-498', 'e-otra']))]).toEqual([
      ['e-498', esperado],
    ]);
    // Sin ids: todas las ligadas.
    expect([...(await vuelosDeEntregas(sb))]).toEqual([['e-498', esperado]]);
    // Lista vacía: ni una lectura de datos.
    const vacio = fakeSb([COBRO_498]);
    expect((await vuelosDeEntregas(vacio.sb, [])).size).toBe(0);
    expect(vacio.lecturas.filter((s) => s.includes('vuelo:vuelo_id'))).toEqual(
      [],
    );
  });

  it('utilidadesDeCobros: cobro → socio, avión y mes; un cobro normal no entra', async () => {
    const { sb } = fakeSb([COBRO_498, COBRO_NORMAL]);
    expect([...(await utilidadesDeCobros(sb, ['c-498', 'c-normal']))]).toEqual([
      [
        'c-498',
        {
          entrega_id: 'e-498',
          socio_id: 's-macedo',
          socio_nombre: 'Macedo',
          aeronave_id: 'a-n621tx',
          matricula: 'N621TX',
          mes: '2026-10',
        },
      ],
    ]);
  });

  it('etiquetasUtilidadesDeVuelos y entregaDeCobro', async () => {
    const { sb } = fakeSb([COBRO_498, COBRO_NORMAL]);
    const etiquetas = await etiquetasUtilidadesDeVuelos(sb, ['v-498']);
    expect([...etiquetas]).toEqual([
      [claveCobroUtilidades(COBRO_498), 'Utilidades del socio (Macedo)'],
    ]);
    expect(await entregaDeCobro(sb, 'c-498')).toBe('e-498');
    expect(await entregaDeCobro(sb, 'c-normal')).toBeNull();
    expect(await entregaDeCobro(sb, 'no-existe')).toBeNull();
  });

  it('SIN la migración: todo vacío, nunca lanza', async () => {
    const { sb } = fakeSb([COBRO_498], { sinColumna: true });
    expect((await vuelosDeEntregas(sb, ['e-498'])).size).toBe(0);
    expect((await utilidadesDeCobros(sb, ['c-498'])).size).toBe(0);
    expect((await etiquetasUtilidadesDeVuelos(sb, ['v-498'])).size).toBe(0);
    expect(await entregaDeCobro(sb, 'c-498')).toBeNull();
  });

  it('otro error de lectura SÍ se lanza (un mapa vacío falso escondería el desglose)', async () => {
    const { sb } = fakeSb([COBRO_498], {
      error: { code: '57014', message: 'canceling statement due to timeout' },
    });
    await expect(vuelosDeEntregas(sb, ['e-498'])).rejects.toThrow('timeout');
    await expect(utilidadesDeCobros(sb, ['c-498'])).rejects.toThrow('timeout');
  });
});
