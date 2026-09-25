import { HttpException } from '@nestjs/common';
import {
  CONFIG_INVENTARIO_MARGEN_VENTA_PCT,
  CONFIG_RESPONSABLES_FACTURACION,
  ConfiguracionService,
  INVENTARIO_MARGEN_VENTA_PCT_DEFAULT,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * RESPONSABLES DE FACTURACIÓN (24-sep-2026): la clave nueva NO aparece en el
 * listado de banderas (el panel pinta cada fila como switch), no se edita por
 * `PATCH :clave`, y el aviso «Factura pedida» elige el nivel (config → rol
 * FACTURACION → ADMIN) ANTES de excluir a quien pidió.
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const MARY = 'aaaaaaaa-0000-4000-8000-00000000000b';
const ALE = 'aaaaaaaa-0000-4000-8000-00000000000c';
const ITZI = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FACT = 'aaaaaaaa-0000-4000-8000-00000000000d';
const EXPILOTO = 'aaaaaaaa-0000-4000-8000-00000000000e';

function armar(m: {
  config?: unknown[] | null;
  usuarios?: Fila[];
  migracion?: boolean;
}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const oficina = m.usuarios ?? [
    {
      id: MARY,
      nombre: 'Mary Cruz',
      rol: 'ADMIN',
      estado: 'ACTIVO',
      es_piloto_externo: false,
    },
    {
      id: ALE,
      nombre: 'Alejandro',
      rol: 'ADMIN',
      estado: 'ACTIVO',
      es_piloto_externo: false,
    },
    {
      id: ITZI,
      nombre: 'Itzi',
      rol: 'ADMIN',
      estado: 'ACTIVO',
      es_piloto_externo: false,
    },
  ];
  const from = (tabla: string) => {
    const ops: Op[] = [];
    llamadas.push({ tabla, ops });
    const q: Record<string, unknown> = {};
    for (const met of [
      'select',
      'eq',
      'neq',
      'in',
      'order',
      'limit',
      'update',
      'insert',
    ]) {
      q[met] = (...args: unknown[]) => {
        ops.push({ m: met, args });
        return q;
      };
    }
    const resolver = () => {
      const s0 = ops.find((o) => o.m === 'select')?.args[0];
      const sel = typeof s0 === 'string' ? s0 : '';
      if (m.migracion === false && sel.includes('factura_solicitada_at')) {
        return { data: null, error: { code: '42703', message: 'no existe' } };
      }
      if (tabla === 'vuelo') return { data: [], error: null };
      if (tabla === 'configuracion_sistema') {
        const upd = ops.find((o) => o.m === 'update');
        if (upd) {
          m.config = (upd.args[0] as Fila).valor_json as unknown[];
          return { data: [{ clave: 'x' }], error: null };
        }
        if (sel.includes('valor_json')) {
          return {
            data:
              m.config === null
                ? null
                : {
                    clave: CONFIG_RESPONSABLES_FACTURACION,
                    valor_json: m.config ?? [],
                  },
            error: null,
          };
        }
        return { data: [{ clave: 'captura_taco_foto_ia' }], error: null };
      }
      if (tabla === 'usuario') {
        const inOp = ops.find((o) => o.m === 'in');
        const col = inOp?.args[0];
        const vals = (inOp?.args[1] as unknown[]) ?? [];
        let filas = oficina;
        if (col === 'rol') filas = filas.filter((u) => vals.includes(u.rol));
        if (col === 'id') filas = filas.filter((u) => vals.includes(u.id));
        if (ops.some((o) => o.m === 'eq' && o.args[0] === 'estado')) {
          filas = filas.filter(
            (u) => u.estado === 'ACTIVO' && u.es_piloto_externo === false,
          );
        }
        return { data: filas, error: null };
      }
      return { data: [], error: null };
    };
    q.maybeSingle = () => Promise.resolve(resolver());
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res);
    return q;
  };
  const svc = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  return { svc, llamadas };
}

describe('ConfiguracionService — responsables de facturación', () => {
  it('list() EXCLUYE la clave de responsables', async () => {
    const { svc, llamadas } = armar({});
    await svc.list();
    const ops = llamadas.find((l) => l.tabla === 'configuracion_sistema')!.ops;
    expect(ops).toContainEqual({
      m: 'neq',
      args: ['clave', CONFIG_RESPONSABLES_FACTURACION],
    });
  });

  it('PATCH de la clave ⇒ 400 CLAVE_NO_EDITABLE_AQUI', async () => {
    const { svc } = armar({});
    try {
      await svc.update(
        CONFIG_RESPONSABLES_FACTURACION,
        { activa: false },
        MARY,
      );
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect(((e as HttpException).getResponse() as Fila).error).toBe(
        'CLAVE_NO_EDITABLE_AQUI',
      );
    }
  });

  it('nivel 1 (config): solo activos de oficina, sin quien pide', async () => {
    const { svc } = armar({ config: [MARY, EXPILOTO] });
    expect(await svc.destinatariosFacturacion(ITZI)).toEqual([
      { id: MARY, nombre: 'Mary Cruz' },
    ]);
    // Si quien pide es la única responsable, NADIE recibe (no baja de nivel).
    expect(await svc.destinatariosFacturacion(MARY)).toEqual([]);
  });

  it('nivel 2 (rol FACTURACION) y nivel 3 (ADMIN)', async () => {
    const conFact = armar({
      config: [],
      usuarios: [
        {
          id: FACT,
          nombre: 'Facturista',
          rol: 'FACTURACION',
          estado: 'ACTIVO',
          es_piloto_externo: false,
        },
        {
          id: ALE,
          nombre: 'Alejandro',
          rol: 'ADMIN',
          estado: 'ACTIVO',
          es_piloto_externo: false,
        },
      ],
    });
    expect(await conFact.svc.destinatariosFacturacion(ITZI)).toEqual([
      { id: FACT, nombre: 'Facturista' },
    ]);
    const soloAdmins = armar({ config: [] });
    expect(
      (await soloAdmins.svc.destinatariosFacturacion(ITZI)).map((u) => u.id),
    ).toEqual([MARY, ALE]);
  });

  it('GET: fuente, efectivos y candidatos; sin migración ⇒ 503', async () => {
    const { svc } = armar({ config: [MARY] });
    const r = await svc.responsablesFacturacion();
    expect(r).toMatchObject({
      usuario_ids: [MARY],
      fuente: 'CONFIG',
      efectivos: [{ id: MARY, nombre: 'Mary Cruz' }],
      usuarios: [{ id: MARY, nombre: 'Mary Cruz', rol: 'ADMIN', activo: true }],
    });
    expect(r.candidatos).toHaveLength(3);
    const sin = armar({ migracion: false });
    await expect(sin.svc.responsablesFacturacion()).rejects.toMatchObject({
      status: 503,
    });
  });

  it('PUT con un usuario que no es de oficina ⇒ 400 USUARIOS_INVALIDOS', async () => {
    const { svc } = armar({});
    try {
      await svc.setResponsablesFacturacion([MARY, EXPILOTO], ALE);
      throw new Error('no lanzó');
    } catch (e) {
      const body = (e as HttpException).getResponse() as Fila;
      expect(body.error).toBe('USUARIOS_INVALIDOS');
      expect(body.details).toEqual({ ids: [EXPILOTO] });
    }
    const ok = await svc.setResponsablesFacturacion([MARY], ALE);
    expect(ok.fuente).toBe('CONFIG');
  });
});

/**
 * MARGEN DE LA TIENDA (25-sep-2026): `inventario_margen_venta_pct` va de 0 a
 * 100 %. La BD solo exige ≥ 0; el tope lo pone el API con un 400 legible.
 */
describe('ConfiguracionService — margen de la tienda', () => {
  it('la clave y su default (25) son los del inventario', () => {
    expect(CONFIG_INVENTARIO_MARGEN_VENTA_PCT).toBe(
      'inventario_margen_venta_pct',
    );
    expect(INVENTARIO_MARGEN_VENTA_PCT_DEFAULT).toBe(25);
  });

  it('101 ⇒ 400 VALOR_FUERA_DE_RANGO (y no escribe)', async () => {
    const { svc, llamadas } = armar({});
    try {
      await svc.update(
        CONFIG_INVENTARIO_MARGEN_VENTA_PCT,
        { valor_numerico: 101 },
        MARY,
      );
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(400);
      expect((e as HttpException).getResponse()).toMatchObject({
        error: 'VALOR_FUERA_DE_RANGO',
        message: 'El margen de la tienda va de 0 a 100 %.',
      });
    }
    expect(llamadas.some((l) => l.ops.some((o) => o.m === 'update'))).toBe(
      false,
    );
  });

  it('0, 25 y 100 pasan; otra clave numérica no tiene ese tope', async () => {
    for (const v of [0, 25, 100]) {
      const { svc, llamadas } = armar({});
      await svc.update(
        CONFIG_INVENTARIO_MARGEN_VENTA_PCT,
        { valor_numerico: v },
        MARY,
      );
      const upd = llamadas.flatMap((l) => l.ops).find((o) => o.m === 'update');
      expect((upd?.args[0] as Fila).valor_numerico).toBe(v);
    }
    const { svc } = armar({});
    await expect(
      svc.update('dias_gracia_gastos_semana', { valor_numerico: 150 }, MARY),
    ).resolves.toBeDefined();
  });
});
