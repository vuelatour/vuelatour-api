import { HttpException } from '@nestjs/common';
import type { SupabaseService } from '../supabase/supabase.service';
import { VueloSeguimientoService } from './vuelo-seguimiento.service';

/**
 * SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026) contra una BD en memoria
 * mínima: lista sin borradas y en orden, alta con defaults, sellos de
 * resolver/reabrir, soft delete, 404/503 y la degradación de los contadores
 * ADITIVOS (tabla ausente ⇒ 0; lectura fallida ⇒ null).
 */
type Fila = Record<string, unknown>;

const V358 = 'aaaaaaaa-0000-4000-8000-000000000358';
const V999 = 'aaaaaaaa-0000-4000-8000-000000000999';
const ITZI = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const MARY = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const N1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const N2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const N3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const N4 = 'bbbbbbbb-0000-4000-8000-000000000004';

interface Opciones {
  /** La migración 20260929000002 no está aplicada. */
  sinTabla?: boolean;
  /** Cualquier lectura de vuelo_seguimiento falla (red, timeout…). */
  falla?: boolean;
}

function fakeDb(datos: Record<string, Fila[]>, opts: Opciones = {}) {
  const tablas: Record<string, Fila[]> = {};
  for (const [k, v] of Object.entries(datos))
    tablas[k] = v.map((f) => ({ ...f }));
  const tabla = (t: string) => (tablas[t] ??= []);
  const escrituras: Array<{ tabla: string; op: string; valor: Fila }> = [];
  let seq = 100;

  const from = (t: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    let valor: Fila = {};
    const filtros: Array<(f: Fila) => boolean> = [];
    let orden: { col: string; asc: boolean } | null = null;
    const ejecutar = (): { data: unknown; error: unknown } => {
      if (t === 'vuelo_seguimiento' && opts.sinTabla) {
        return {
          data: null,
          error: {
            code: 'PGRST205',
            message:
              "Could not find the table 'public.vuelo_seguimiento' in the schema cache",
          },
        };
      }
      if (t === 'vuelo_seguimiento' && opts.falla) {
        return { data: null, error: { code: '57014', message: 'timeout' } };
      }
      if (op === 'insert') {
        if (
          t === 'vuelo_seguimiento' &&
          !tabla('vuelo').some((v) => v.id === valor.vuelo_id)
        ) {
          return {
            data: null,
            error: { code: '23503', message: 'fk vuelo' },
          };
        }
        const nueva: Fila = {
          id: `cccccccc-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          estado: 'PENDIENTE',
          afecta_cotizacion: true,
          created_at: '2026-09-29T21:00:00+00:00',
          updated_at: '2026-09-29T21:00:00+00:00',
          resuelta_at: null,
          resuelta_por: null,
          resolucion: null,
          deleted_at: null,
          deleted_by: null,
          ...valor,
        };
        tabla(t).push(nueva);
        escrituras.push({ tabla: t, op, valor });
        return { data: [{ ...nueva }], error: null };
      }
      let filas = tabla(t).filter((f) => filtros.every((fn) => fn(f)));
      if (op === 'update') {
        for (const f of filas) Object.assign(f, valor);
        escrituras.push({ tabla: t, op, valor });
      }
      if (orden) {
        const { col, asc } = orden;
        filas = [...filas].sort((a, b) =>
          String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      return { data: filas.map((f) => ({ ...f })), error: null };
    };
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.insert = (v: Fila) => {
      op = 'insert';
      valor = v;
      return q;
    };
    q.update = (v: Fila) => {
      op = 'update';
      valor = v;
      return q;
    };
    q.eq = (c: string, v: unknown) => {
      filtros.push((f) => f[c] === v);
      return q;
    };
    q.in = (c: string, arr: unknown[]) => {
      filtros.push((f) => arr.includes(f[c]));
      return q;
    };
    q.is = (c: string, v: unknown) => {
      filtros.push((f) => (v === null ? f[c] == null : f[c] === v));
      return q;
    };
    q.order = (col: string, o?: { ascending?: boolean }) => {
      orden = { col, asc: o?.ascending !== false };
      return q;
    };
    q.limit = () => q;
    const uno = () => {
      const r = ejecutar();
      return Promise.resolve({
        data: Array.isArray(r.data)
          ? ((r.data as unknown[])[0] ?? null)
          : r.data,
        error: r.error,
      });
    };
    q.maybeSingle = uno;
    q.single = uno;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(ejecutar()).then(res, rej);
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    tablas,
    escrituras,
  };
}

function base(opts: Opciones = {}) {
  return fakeDb(
    {
      vuelo: [{ id: V358, folio: 358 }],
      usuario: [
        { id: ITZI, nombre: 'Itzi' },
        { id: MARY, nombre: 'Mary Cruz' },
      ],
      vuelo_seguimiento: [
        {
          id: N1,
          vuelo_id: V358,
          texto: 'Transporte terrestre para los pax',
          afecta_cotizacion: true,
          estado: 'PENDIENTE',
          created_at: '2026-09-28T15:00:00+00:00',
          created_by: ITZI,
          resuelta_at: null,
          resuelta_por: null,
          resolucion: null,
          deleted_at: null,
        },
        {
          id: N2,
          vuelo_id: V358,
          texto: 'Confirmar hielo con el FBO',
          afecta_cotizacion: false,
          estado: 'PENDIENTE',
          created_at: '2026-09-29T15:00:00+00:00',
          created_by: MARY,
          resuelta_at: null,
          resuelta_por: null,
          resolucion: null,
          deleted_at: null,
        },
        {
          id: N3,
          vuelo_id: V358,
          texto: 'Pernocta extra en MID',
          afecta_cotizacion: true,
          estado: 'RESUELTA',
          created_at: '2026-09-29T18:00:00+00:00',
          created_by: ITZI,
          resuelta_at: '2026-09-29T19:00:00+00:00',
          resuelta_por: MARY,
          resolucion: 'Agregada en la v4',
          deleted_at: null,
        },
        {
          id: N4,
          vuelo_id: V358,
          texto: 'Borrada',
          afecta_cotizacion: true,
          estado: 'PENDIENTE',
          created_at: '2026-09-29T20:00:00+00:00',
          created_by: ITZI,
          resuelta_at: null,
          resuelta_por: null,
          resolucion: null,
          deleted_at: '2026-09-29T20:30:00+00:00',
        },
      ],
    },
    opts,
  );
}

async function rebote(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const r = err.getResponse() as Record<string, unknown>;
    return { status: err.getStatus(), error: r.error };
  }
  throw new Error('no rebotó');
}

describe('VueloSeguimientoService.listar', () => {
  it('sin borradas, PENDIENTE primero y luego la más reciente, con nombres', async () => {
    const { supabase } = base();
    const r = await new VueloSeguimientoService(supabase).listar(V358);
    expect(r.map((n) => n.id)).toEqual([N2, N1, N3]);
    expect(r[0].creado_por).toEqual({ id: MARY, nombre: 'Mary Cruz' });
    expect(r[0].resuelta_por).toBeNull();
    expect(r[2]).toMatchObject({
      estado: 'RESUELTA',
      resuelta_at: '2026-09-29T19:00:00+00:00',
      resuelta_por: { id: MARY, nombre: 'Mary Cruz' },
      resolucion: 'Agregada en la v4',
    });
  });

  it('vuelo inexistente ⇒ 404 VUELO_NO_EXISTE', async () => {
    const { supabase } = base();
    expect(
      await rebote(new VueloSeguimientoService(supabase).listar(V999)),
    ).toEqual({ status: 404, error: 'VUELO_NO_EXISTE' });
  });

  it('sin la migración ⇒ [] (no existe ninguna nota)', async () => {
    const { supabase } = base({ sinTabla: true });
    await expect(
      new VueloSeguimientoService(supabase).listar(V358),
    ).resolves.toEqual([]);
  });
});

describe('VueloSeguimientoService.crear', () => {
  it('recorta el texto, default afecta_cotizacion=true y sella el autor', async () => {
    const { supabase, escrituras } = base();
    const n = await new VueloSeguimientoService(supabase).crear(
      V358,
      { texto: '  Los pax pidieron transporte terrestre  ' },
      ITZI,
    );
    expect(escrituras).toEqual([
      {
        tabla: 'vuelo_seguimiento',
        op: 'insert',
        valor: {
          vuelo_id: V358,
          texto: 'Los pax pidieron transporte terrestre',
          afecta_cotizacion: true,
          created_by: ITZI,
        },
      },
    ]);
    expect(n).toMatchObject({
      vuelo_id: V358,
      texto: 'Los pax pidieron transporte terrestre',
      estado: 'PENDIENTE',
      afecta_cotizacion: true,
      creado_por: { id: ITZI, nombre: 'Itzi' },
      resuelta_por: null,
    });
  });

  it('afecta_cotizacion=false viaja tal cual', async () => {
    const { supabase, escrituras } = base();
    await new VueloSeguimientoService(supabase).crear(
      V358,
      { texto: 'Nota operativa', afecta_cotizacion: false },
      ITZI,
    );
    expect(escrituras[0].valor.afecta_cotizacion).toBe(false);
  });

  it('texto vacío ⇒ 400 sin escribir; vuelo inexistente ⇒ 404; sin migración ⇒ 503', async () => {
    const a = base();
    expect(
      await rebote(
        new VueloSeguimientoService(a.supabase).crear(
          V358,
          { texto: '  ' },
          ITZI,
        ),
      ),
    ).toEqual({ status: 400, error: 'SEGUIMIENTO_TEXTO_VACIO' });
    expect(a.escrituras).toEqual([]);
    expect(
      await rebote(
        new VueloSeguimientoService(a.supabase).crear(
          V999,
          { texto: 'x' },
          ITZI,
        ),
      ),
    ).toEqual({ status: 404, error: 'VUELO_NO_EXISTE' });
    const b = base({ sinTabla: true });
    expect(
      await rebote(
        new VueloSeguimientoService(b.supabase).crear(
          V358,
          { texto: 'x' },
          ITZI,
        ),
      ),
    ).toEqual({ status: 503, error: 'SEGUIMIENTO_NO_DISPONIBLE' });
  });
});

describe('VueloSeguimientoService.actualizar', () => {
  it('Marcar resuelta sella quién/cuándo y guarda la resolución', async () => {
    const { supabase, tablas } = base();
    const n = await new VueloSeguimientoService(supabase).actualizar(
      N1,
      { estado: 'RESUELTA', resolucion: 'Se cobró como extra en la v5' },
      MARY,
    );
    const fila = tablas.vuelo_seguimiento.find((f) => f.id === N1)!;
    expect(fila.estado).toBe('RESUELTA');
    expect(fila.resuelta_por).toBe(MARY);
    expect(typeof fila.resuelta_at).toBe('string');
    expect(n.resuelta_por).toEqual({ id: MARY, nombre: 'Mary Cruz' });
    expect(n.resolucion).toBe('Se cobró como extra en la v5');
  });

  it('Reabrir limpia el sello y la resolución', async () => {
    const { supabase, tablas } = base();
    const n = await new VueloSeguimientoService(supabase).actualizar(
      N3,
      { estado: 'PENDIENTE' },
      ITZI,
    );
    expect(tablas.vuelo_seguimiento.find((f) => f.id === N3)).toMatchObject({
      estado: 'PENDIENTE',
      resuelta_at: null,
      resuelta_por: null,
      resolucion: null,
    });
    expect(n.resuelta_por).toBeNull();
  });

  it('doble clic en «Marcar resuelta»: no re-sella ni escribe', async () => {
    const { supabase, escrituras } = base();
    const n = await new VueloSeguimientoService(supabase).actualizar(
      N3,
      { estado: 'RESUELTA' },
      ITZI,
    );
    expect(escrituras).toEqual([]);
    expect(n.resuelta_por).toEqual({ id: MARY, nombre: 'Mary Cruz' });
  });

  it('nota borrada o inexistente ⇒ 404 SEGUIMIENTO_NO_EXISTE', async () => {
    const { supabase } = base();
    const svc = new VueloSeguimientoService(supabase);
    expect(
      await rebote(svc.actualizar(N4, { estado: 'RESUELTA' }, ITZI)),
    ).toEqual({
      status: 404,
      error: 'SEGUIMIENTO_NO_EXISTE',
    });
    expect(
      await rebote(
        svc.actualizar(
          'bbbbbbbb-0000-4000-8000-00000000dead',
          { texto: 'x' },
          ITZI,
        ),
      ),
    ).toEqual({ status: 404, error: 'SEGUIMIENTO_NO_EXISTE' });
  });
});

/**
 * Carrera (revisión adversaria 29-sep-2026): alguien cambia el ESTADO de la
 * nota entre la lectura y la escritura de `actualizar`. `cambio` corre justo
 * después de la PRIMERA lectura de la nota.
 */
function conCarrera(
  db: ReturnType<typeof base>,
  cambio: (fila: Fila) => void,
): SupabaseService {
  const service = db.supabase.service as unknown as {
    from: (t: string) => Record<string, unknown>;
  };
  const fromOrig = service.from;
  let lecturas = 0;
  return {
    service: {
      from: (t: string) => {
        const q = fromOrig(t);
        if (t !== 'vuelo_seguimiento') return q;
        const ms = q.maybeSingle as () => Promise<{ data: Fila | null }>;
        q.maybeSingle = async () => {
          const r = await ms();
          lecturas += 1;
          if (lecturas === 1 && r.data) {
            cambio(
              db.tablas.vuelo_seguimiento.find((f) => f.id === r.data!.id)!,
            );
          }
          return r;
        };
        return q;
      },
    },
  } as unknown as SupabaseService;
}

describe('VueloSeguimientoService.actualizar — carreras (CAS por estado)', () => {
  it('dos personas marcan «resuelta» a la vez: la segunda NO re-sella ni borra la resolución de la primera', async () => {
    const db = base();
    const sb = conCarrera(db, (f) =>
      Object.assign(f, {
        estado: 'RESUELTA',
        resuelta_at: '2026-09-29T21:30:00+00:00',
        resuelta_por: ITZI,
        resolucion: 'Ya lo cobré en la v5',
      }),
    );
    const n = await new VueloSeguimientoService(sb).actualizar(
      N1,
      { estado: 'RESUELTA' },
      MARY,
    );
    expect(db.tablas.vuelo_seguimiento.find((f) => f.id === N1)).toMatchObject({
      estado: 'RESUELTA',
      resuelta_at: '2026-09-29T21:30:00+00:00',
      resuelta_por: ITZI,
      resolucion: 'Ya lo cobré en la v5',
    });
    expect(n).toMatchObject({
      estado: 'RESUELTA',
      resuelta_por: { id: ITZI, nombre: 'Itzi' },
      resolucion: 'Ya lo cobré en la v5',
    });
  });

  it('corregir la resolución de una nota que otra persona acaba de reabrir ⇒ 400 (no un 500 del CHECK)', async () => {
    const db = base();
    const sb = conCarrera(db, (f) =>
      Object.assign(f, {
        estado: 'PENDIENTE',
        resuelta_at: null,
        resuelta_por: null,
        resolucion: null,
      }),
    );
    expect(
      await rebote(
        new VueloSeguimientoService(sb).actualizar(
          N3,
          { resolucion: 'Agregada en la v5' },
          MARY,
        ),
      ),
    ).toEqual({ status: 400, error: 'SEGUIMIENTO_RESOLUCION_SIN_RESOLVER' });
    // La fila reabierta NO se tocó (el CHECK de BD la habría rechazado).
    expect(db.tablas.vuelo_seguimiento.find((f) => f.id === N3)).toMatchObject({
      estado: 'PENDIENTE',
      resolucion: null,
    });
  });

  it('la borraron entre la lectura y la escritura ⇒ 404', async () => {
    const db = base();
    const sb = conCarrera(db, (f) =>
      Object.assign(f, { deleted_at: '2026-09-29T21:30:00+00:00' }),
    );
    expect(
      await rebote(
        new VueloSeguimientoService(sb).actualizar(N1, { texto: 'x' }, MARY),
      ),
    ).toEqual({ status: 404, error: 'SEGUIMIENTO_NO_EXISTE' });
  });

  it('editar el texto mientras otra persona la resuelve: el texto se guarda y el sello ajeno se conserva', async () => {
    const db = base();
    const sb = conCarrera(db, (f) =>
      Object.assign(f, {
        estado: 'RESUELTA',
        resuelta_at: '2026-09-29T21:30:00+00:00',
        resuelta_por: ITZI,
        resolucion: null,
      }),
    );
    const n = await new VueloSeguimientoService(sb).actualizar(
      N1,
      { texto: 'Transporte CUN–Tulum (2 camionetas)' },
      MARY,
    );
    expect(n).toMatchObject({
      texto: 'Transporte CUN–Tulum (2 camionetas)',
      estado: 'RESUELTA',
      resuelta_por: { id: ITZI, nombre: 'Itzi' },
    });
  });
});

describe('VueloSeguimientoService.eliminar', () => {
  it('soft delete: sella deleted_at/by, la lista ya no la trae y la segunda vez es 404', async () => {
    const { supabase, tablas } = base();
    const svc = new VueloSeguimientoService(supabase);
    await expect(svc.eliminar(N3, MARY)).resolves.toEqual({
      ok: true,
      id: N3,
      vuelo_id: V358,
    });
    const fila = tablas.vuelo_seguimiento.find((f) => f.id === N3)!;
    expect(fila.deleted_by).toBe(MARY);
    expect(typeof fila.deleted_at).toBe('string');
    // La fila se CONSERVA (soft delete), solo deja de listarse.
    expect(tablas.vuelo_seguimiento).toHaveLength(4);
    expect((await svc.listar(V358)).map((n) => n.id)).toEqual([N2, N1]);
    expect(await rebote(svc.eliminar(N3, MARY))).toEqual({
      status: 404,
      error: 'SEGUIMIENTO_NO_EXISTE',
    });
  });
});

describe('Bloques ADITIVOS (detalle del vuelo y cotización)', () => {
  it('contadores: PENDIENTE vivas y las que afectan la cotización', async () => {
    const { supabase } = base();
    await expect(
      new VueloSeguimientoService(supabase).contadoresDeVuelo(V358),
    ).resolves.toEqual({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
    });
  });

  it('sin la migración ⇒ 0 (no hay notas); lectura fallida ⇒ null (nunca un 0 falso)', async () => {
    await expect(
      new VueloSeguimientoService(
        base({ sinTabla: true }).supabase,
      ).contadoresDeVuelo(V358),
    ).resolves.toEqual({
      seguimiento_pendientes: 0,
      seguimiento_cotizacion_pendientes: 0,
    });
    await expect(
      new VueloSeguimientoService(
        base({ falla: true }).supabase,
      ).contadoresDeVuelo(V358),
    ).resolves.toEqual({
      seguimiento_pendientes: null,
      seguimiento_cotizacion_pendientes: null,
    });
  });

  it('cotización: contadores + detalle SOLO de las que afectan la cotización', async () => {
    const { supabase } = base();
    await expect(
      new VueloSeguimientoService(supabase).deCotizacion(V358),
    ).resolves.toEqual({
      seguimiento_pendientes: 2,
      seguimiento_cotizacion_pendientes: 1,
      seguimiento_pendientes_detalle: [
        {
          id: N1,
          texto: 'Transporte terrestre para los pax',
          created_at: '2026-09-28T15:00:00+00:00',
          creado_por_nombre: 'Itzi',
        },
      ],
    });
  });

  it('resolver la última pendiente de cotización hace desaparecer el banner', async () => {
    const { supabase } = base();
    const svc = new VueloSeguimientoService(supabase);
    await svc.actualizar(N1, { estado: 'RESUELTA' }, MARY);
    await expect(svc.deCotizacion(V358)).resolves.toEqual({
      seguimiento_pendientes: 1,
      seguimiento_cotizacion_pendientes: 0,
      seguimiento_pendientes_detalle: [],
    });
  });

  it('cotización con lectura fallida ⇒ contadores null y detalle []', async () => {
    await expect(
      new VueloSeguimientoService(base({ falla: true }).supabase).deCotizacion(
        V358,
      ),
    ).resolves.toEqual({
      seguimiento_pendientes: null,
      seguimiento_cotizacion_pendientes: null,
      seguimiento_pendientes_detalle: [],
    });
  });
});
