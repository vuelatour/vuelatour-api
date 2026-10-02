import { HttpException } from '@nestjs/common';
import {
  CONFIG_EDITORES_COTIZACION_COBRADA,
  CONFIG_IA_MODELO,
  CONFIG_RESPONSABLES_FACTURACION,
  ConfiguracionService,
  ESPERA_TRAS_FALLO_MODELO_IA_MS,
  TOPE_LECTURA_MODELO_IA_MS,
} from './configuracion.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  AVISO_FUERA_DE_CATALOGO,
  AVISO_SIN_TARIFA,
  CATALOGO_MODELOS_IA,
  DESCRIPCION_CONFIG_IA_MODELO,
} from '../../common/ia-modelo.util';

/**
 * MODELO DE IA (2-oct-2026, API 0.0.51): la clave `ia_modelo` se crea si no
 * existe (sin migración) y luego se actualiza SOLO su valor (la descripción
 * no se pisa), guarda `["<id>"]` (la BD solo admite null o arreglo en
 * `valor_json`), se lee con caché de 60 s que se rearma al escribir y con
 * TOPE de tiempo (una BD lenta no retrasa las llamadas a pyservices), NO
 * sale en `GET /v1/config` y `PATCH :clave` la rechaza.
 */
type Op = { m: string; args: unknown[] };
type Resultado = { data: unknown; error: { message: string } | null };
const ALE = 'c691cc8b-3034-4f04-a383-d0b25c1971ec';

/** Promesa que se resuelve a mano (lectura lenta controlada por la prueba). */
function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((r) => (resolver = r));
  return { promesa, resolver };
}

function armar(m: {
  fila?: Record<string, unknown> | null;
  falla?: boolean;
  usuarios?: Record<string, string>;
  /**
   * Sustituye la LECTURA de `ia_modelo` (maybeSingle): p. ej. una que nunca
   * responde. Recibe el `AbortSignal` que pasó el service (si pasó uno).
   */
  lectura?: (signal: AbortSignal | undefined) => Promise<Resultado>;
}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
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
      'update',
      'upsert',
      'insert',
      'abortSignal',
    ]) {
      q[met] = (...args: unknown[]) => {
        ops.push({ m: met, args });
        return q;
      };
    }
    const resolver = () => {
      if (m.falla) return { data: null, error: { message: 'BD caída' } };
      if (tabla === 'configuracion_sistema') {
        const up = ops.find((o) => o.m === 'upsert');
        if (up) {
          const [fila, opts] = up.args as [
            Record<string, unknown>,
            { ignoreDuplicates?: boolean } | undefined,
          ];
          // ON CONFLICT DO NOTHING con ignoreDuplicates: una fila existente
          // no se toca.
          if (!m.fila || !opts?.ignoreDuplicates) m.fila = { ...fila };
          return { data: null, error: null };
        }
        const upd = ops.find((o) => o.m === 'update');
        if (upd) {
          if (m.fila) {
            m.fila = { ...m.fila, ...(upd.args[0] as Record<string, unknown>) };
          }
          return { data: null, error: null };
        }
        const eqClave = ops.find((o) => o.m === 'eq' && o.args[0] === 'clave')
          ?.args[1];
        if (eqClave === CONFIG_IA_MODELO) {
          return { data: m.fila ?? null, error: null };
        }
        return { data: [{ clave: 'captura_taco_foto_ia' }], error: null };
      }
      if (tabla === 'usuario') {
        const id = ops.find((o) => o.m === 'eq' && o.args[0] === 'id')
          ?.args[1] as string;
        const nombre = m.usuarios?.[id];
        return {
          data: nombre === undefined ? null : { id, nombre },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    q.maybeSingle = () => {
      const esLecturaModelo =
        tabla === 'configuracion_sistema' &&
        ops.some((o) => o.m === 'eq' && o.args[1] === CONFIG_IA_MODELO);
      if (esLecturaModelo && m.lectura) {
        const signal = ops.find((o) => o.m === 'abortSignal')?.args[0] as
          | AbortSignal
          | undefined;
        return m.lectura(signal);
      }
      return Promise.resolve(resolver());
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  };
  const svc = new ConfiguracionService({
    service: { from },
  } as unknown as SupabaseService);
  const lecturasModelo = () =>
    llamadas.filter(
      (l) =>
        l.tabla === 'configuracion_sistema' &&
        l.ops.some((o) => o.m === 'select') &&
        l.ops.some((o) => o.m === 'eq' && o.args[1] === CONFIG_IA_MODELO),
    ).length;
  return { svc, llamadas, m, lecturasModelo };
}

async function errorDe(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const ex = e as HttpException;
    return {
      status: ex.getStatus(),
      body: ex.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('se esperaba un error');
}

describe('ConfiguracionService — modelo de IA', () => {
  afterEach(() => jest.useRealTimers());

  it('sin fila (estado de prod tras el deploy): null = el del servidor, sin header', async () => {
    const { svc } = armar({ fila: null });
    await expect(svc.modeloIa()).resolves.toBeNull();
    await expect(svc.headersModeloIa()).resolves.toEqual({});
  });

  it('con ["claude-sonnet-5"] guardado: lo devuelve y arma el header', async () => {
    const { svc } = armar({ fila: { valor_json: ['claude-sonnet-5'] } });
    await expect(svc.modeloIa()).resolves.toBe('claude-sonnet-5');
    await expect(svc.headersModeloIa()).resolves.toEqual({
      'X-IA-Modelo': 'claude-sonnet-5',
    });
  });

  it('valor editado a mano que no es un id válido ⇒ null (nunca viaja basura en el header)', async () => {
    for (const valor_json of [['Mary'], [], { a: 1 }, ['claude-x\r\ny']]) {
      const { svc } = armar({ fila: { valor_json } });
      await expect(svc.modeloIa()).resolves.toBeNull();
      await expect(svc.headersModeloIa()).resolves.toEqual({});
    }
  });

  it('caché de 60 s: una lectura por ventana; al vencer vuelve a leer', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    const { svc, m, lecturasModelo } = armar({
      fila: { valor_json: ['claude-sonnet-5'] },
    });
    await svc.modeloIa();
    await svc.modeloIa();
    await svc.headersModeloIa();
    expect(lecturasModelo()).toBe(1);
    // Cambio por fuera (otra réplica): este proceso lo ve al vencer el caché.
    m.fila = { valor_json: ['claude-haiku-4-5-20251001'] };
    jest.setSystemTime(new Date('2026-10-02T15:00:59Z'));
    await expect(svc.modeloIa()).resolves.toBe('claude-sonnet-5');
    jest.setSystemTime(new Date('2026-10-02T15:01:01Z'));
    await expect(svc.modeloIa()).resolves.toBe('claude-haiku-4-5-20251001');
    expect(lecturasModelo()).toBe(2);
  });

  it('best-effort: BD caída ⇒ último valor conocido (o null) y nunca lanza', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    const ctx = armar({ fila: { valor_json: ['claude-sonnet-5'] } });
    await ctx.svc.modeloIa();
    ctx.m.falla = true;
    jest.setSystemTime(new Date('2026-10-02T15:02:00Z'));
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-sonnet-5');
    await expect(ctx.svc.headersModeloIa()).resolves.toEqual({
      'X-IA-Modelo': 'claude-sonnet-5',
    });
    const frio = armar({ falla: true });
    await expect(frio.svc.modeloIa()).resolves.toBeNull();
    await expect(frio.svc.headersModeloIa()).resolves.toEqual({});
  });

  it('lectura COLGADA: a los 1.5 s responde el último conocido (o null) y aborta la consulta', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    expect(TOPE_LECTURA_MODELO_IA_MS).toBe(1_500);
    const ctx = armar({ fila: { valor_json: ['claude-sonnet-4-6'] } });
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-sonnet-4-6');
    let senal: AbortSignal | undefined;
    ctx.m.lectura = (s) => {
      senal = s;
      return new Promise<Resultado>(() => {});
    };
    jest.setSystemTime(new Date('2026-10-02T15:01:01Z'));
    const p = ctx.svc.modeloIa();
    await jest.advanceTimersByTimeAsync(TOPE_LECTURA_MODELO_IA_MS);
    await expect(p).resolves.toBe('claude-sonnet-4-6');
    expect(senal?.aborted).toBe(true);
    await expect(ctx.svc.headersModeloIa()).resolves.toEqual({
      'X-IA-Modelo': 'claude-sonnet-4-6',
    });

    const frio = armar({ lectura: () => new Promise<Resultado>(() => {}) });
    const q = frio.svc.headersModeloIa();
    await jest.advanceTimersByTimeAsync(TOPE_LECTURA_MODELO_IA_MS);
    await expect(q).resolves.toEqual({});
  });

  it('tras un fallo no vuelve a consultar durante 10 s (BD caída en frío ya no cuesta en CADA llamada); después sí', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    expect(ESPERA_TRAS_FALLO_MODELO_IA_MS).toBe(10_000);
    const ctx = armar({ falla: true });
    await expect(ctx.svc.modeloIa()).resolves.toBeNull();
    await expect(ctx.svc.headersModeloIa()).resolves.toEqual({});
    jest.setSystemTime(new Date('2026-10-02T15:00:09.999Z'));
    await expect(ctx.svc.modeloIa()).resolves.toBeNull();
    expect(ctx.lecturasModelo()).toBe(1);
    ctx.m.falla = false;
    ctx.m.fila = { valor_json: ['claude-haiku-4-5-20251001'] };
    jest.setSystemTime(new Date('2026-10-02T15:00:10Z'));
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-haiku-4-5-20251001');
    expect(ctx.lecturasModelo()).toBe(2);
  });

  it('N llamadas simultáneas con el caché vencido comparten UNA consulta', async () => {
    const d = diferida<Resultado>();
    const ctx = armar({ lectura: () => d.promesa });
    const ps = [
      ctx.svc.modeloIa(),
      ctx.svc.headersModeloIa(),
      ctx.svc.modeloIa(),
    ];
    expect(ctx.lecturasModelo()).toBe(1);
    d.resolver({ data: { valor_json: ['claude-sonnet-4-6'] }, error: null });
    await expect(Promise.all(ps)).resolves.toEqual([
      'claude-sonnet-4-6',
      { 'X-IA-Modelo': 'claude-sonnet-4-6' },
      'claude-sonnet-4-6',
    ]);
    expect(ctx.lecturasModelo()).toBe(1);
  });

  it('una lectura lenta que empezó ANTES del PUT no pisa lo recién guardado', async () => {
    const d = diferida<Resultado>();
    const ctx = armar({ fila: null, lectura: () => d.promesa });
    const p = ctx.svc.modeloIa();
    await ctx.svc.setModeloIa('claude-haiku-4-5-20251001', ALE);
    d.resolver({ data: { valor_json: ['claude-opus-4-8'] }, error: null });
    await expect(p).resolves.toBe('claude-haiku-4-5-20251001');
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-haiku-4-5-20251001');
  });

  it('PUT sin fila: la CREA (activa, descripción fija) y escribe arreglo y quién; invalida el caché al instante', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    const { svc, llamadas, m, lecturasModelo } = armar({ fila: null });
    await expect(svc.modeloIa()).resolves.toBeNull();
    await svc.setModeloIa('claude-sonnet-5', ALE);
    const ops = llamadas.flatMap((l) => l.ops);
    const up = ops.find((o) => o.m === 'upsert');
    expect(up).toBeDefined();
    const [fila, opts] = up!.args as [Record<string, unknown>, unknown];
    expect(fila).toEqual({
      clave: CONFIG_IA_MODELO,
      activa: true,
      descripcion: DESCRIPCION_CONFIG_IA_MODELO,
      valor_json: ['claude-sonnet-5'],
      updated_at: '2026-10-02T15:00:00.000Z',
      updated_by: ALE,
    });
    // ON CONFLICT DO NOTHING: si ya existe, el upsert no pisa nada…
    expect(opts).toEqual({ onConflict: 'clave', ignoreDuplicates: true });
    // …y el valor se escribe con un UPDATE de SOLO valor_json y quién/cuándo.
    const upd = llamadas.find((l) => l.ops.some((o) => o.m === 'update'));
    expect(upd?.ops).toEqual([
      {
        m: 'update',
        args: [
          {
            valor_json: ['claude-sonnet-5'],
            updated_at: '2026-10-02T15:00:00.000Z',
            updated_by: ALE,
          },
        ],
      },
      { m: 'eq', args: ['clave', CONFIG_IA_MODELO] },
    ]);
    expect(m.fila).toEqual(fila);
    // Dentro de la misma ventana de 60 s ya responde el nuevo, sin releer.
    const antes = lecturasModelo();
    await expect(svc.modeloIa()).resolves.toBe('claude-sonnet-5');
    expect(lecturasModelo()).toBe(antes);
    // Volver al del servidor: null en valor_json y en el caché.
    await svc.setModeloIa(null, ALE);
    expect(m.fila?.valor_json).toBeNull();
    await expect(svc.modeloIa()).resolves.toBeNull();
    await expect(svc.headersModeloIa()).resolves.toEqual({});
  });

  it('PUT con fila existente: NO pisa la descripción ni `activa` (solo valor_json y quién/cuándo)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T16:00:00Z') });
    const { svc, m } = armar({
      fila: {
        clave: CONFIG_IA_MODELO,
        activa: false,
        descripcion: 'Editada a mano en la BD',
        valor_json: ['claude-opus-4-8'],
        updated_at: '2026-10-02T15:00:00+00:00',
        updated_by: null,
      },
    });
    await svc.setModeloIa('claude-sonnet-4-6', ALE);
    expect(m.fila).toEqual({
      clave: CONFIG_IA_MODELO,
      activa: false,
      descripcion: 'Editada a mano en la BD',
      valor_json: ['claude-sonnet-4-6'],
      updated_at: '2026-10-02T16:00:00.000Z',
      updated_by: ALE,
    });
    await expect(svc.modeloIa()).resolves.toBe('claude-sonnet-4-6');
  });

  it('PUT recorta espacios; id con forma inválida ⇒ 400 MODELO_INVALIDO sin escribir', async () => {
    const ok = armar({ fila: null });
    await ok.svc.setModeloIa('  claude-sonnet-5  ', ALE);
    expect(ok.m.fila?.valor_json).toEqual(['claude-sonnet-5']);

    for (const malo of [
      '',
      '   ',
      'gpt-4o',
      'Claude-Opus-4-8',
      'claude-opus 4',
      `claude-${'a'.repeat(81)}`,
    ]) {
      const { svc, llamadas } = armar({ fila: null });
      const e = await errorDe(svc.setModeloIa(malo, ALE));
      expect(e.status).toBe(400);
      expect(e.body.error).toBe('MODELO_INVALIDO');
      expect(e.body.details).toEqual({ modelo: malo });
      expect(
        llamadas
          .flatMap((l) => l.ops)
          .some((o) => o.m === 'upsert' || o.m === 'update'),
      ).toBe(false);
    }
  });

  it('PUT: error de la BD al escribir se propaga y el caché NO cambia', async () => {
    const ctx = armar({ fila: { valor_json: ['claude-opus-4-8'] } });
    await ctx.svc.modeloIa();
    ctx.m.falla = true;
    await expect(ctx.svc.setModeloIa('claude-sonnet-5', ALE)).rejects.toThrow(
      'BD caída',
    );
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-opus-4-8');
  });

  it('GET: sin fila ⇒ configurado null, efectivo = default del servidor, catálogo completo, sin fecha ni autor', async () => {
    const { svc } = armar({ fila: null });
    const r = await svc.modeloIaConfig('claude-opus-4-8');
    expect(r).toEqual({
      configurado: null,
      default_servidor: 'claude-opus-4-8',
      efectivo: 'claude-opus-4-8',
      catalogo: CATALOGO_MODELOS_IA,
      actualizado_at: null,
      actualizado_por_nombre: null,
      aviso: null,
    });
  });

  it('GET: configurado gana sobre el del servidor; nombra a quién lo cambió y cuándo', async () => {
    const { svc } = armar({
      fila: {
        valor_json: ['claude-sonnet-4-6'],
        updated_at: '2026-10-02T15:00:00+00:00',
        updated_by: ALE,
      },
      usuarios: { [ALE]: '  Alejandro Canales ' },
    });
    const r = await svc.modeloIaConfig('claude-opus-4-8');
    expect(r.configurado).toBe('claude-sonnet-4-6');
    expect(r.efectivo).toBe('claude-sonnet-4-6');
    expect(r.actualizado_at).toBe('2026-10-02T15:00:00+00:00');
    expect(r.actualizado_por_nombre).toBe('Alejandro Canales');
    expect(r.aviso).toBeNull();
  });

  it('GET: pyservices viejo o caído (default null) ⇒ efectivo = configurado o null', async () => {
    const sin = armar({ fila: null });
    expect((await sin.svc.modeloIaConfig(null)).efectivo).toBeNull();
    const con = armar({ fila: { valor_json: ['claude-sonnet-5'] } });
    expect((await con.svc.modeloIaConfig(null)).efectivo).toBe(
      'claude-sonnet-5',
    );
  });

  it('GET: id fuera del catálogo trae aviso (y el de costo 0 si no hay tarifa)', async () => {
    for (const id of ['claude-opus-4-7', 'claude-sonnet-5']) {
      const conTarifa = armar({ fila: { valor_json: [id] } });
      expect((await conTarifa.svc.modeloIaConfig(null)).aviso).toBe(
        AVISO_FUERA_DE_CATALOGO,
      );
    }
    const sinTarifa = armar({ fila: { valor_json: ['claude-nuevo-9'] } });
    expect((await sinTarifa.svc.modeloIaConfig(null)).aviso).toBe(
      `${AVISO_FUERA_DE_CATALOGO} ${AVISO_SIN_TARIFA}`,
    );
  });

  it('GET refresca el caché de 60 s (lo que se ve es lo que viaja)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T15:00:00Z') });
    const ctx = armar({ fila: { valor_json: ['claude-opus-4-8'] } });
    await ctx.svc.modeloIa();
    ctx.m.fila = { valor_json: ['claude-sonnet-5'] };
    await ctx.svc.modeloIaConfig(null);
    await expect(ctx.svc.modeloIa()).resolves.toBe('claude-sonnet-5');
  });

  it('autor que ya no existe ⇒ sin nombre (no un uuid)', async () => {
    const { svc } = armar({
      fila: {
        valor_json: null,
        updated_at: '2026-10-02T15:00:00+00:00',
        updated_by: ALE,
      },
    });
    const r = await svc.modeloIaConfig('claude-opus-4-8');
    expect(r.configurado).toBeNull();
    expect(r.actualizado_at).toBe('2026-10-02T15:00:00+00:00');
    expect(r.actualizado_por_nombre).toBeNull();
  });

  it('se EXCLUYE del listado general (junto con las listas)', async () => {
    const { svc, llamadas } = armar({});
    await svc.list();
    const ops = llamadas[0].ops;
    const excluidas = ops
      .filter((o) => o.m === 'neq' && o.args[0] === 'clave')
      .map((o) => o.args[1]);
    expect(excluidas).toEqual(
      expect.arrayContaining([
        CONFIG_RESPONSABLES_FACTURACION,
        CONFIG_EDITORES_COTIZACION_COBRADA,
        CONFIG_IA_MODELO,
      ]),
    );
    // El order va después de los filtros.
    expect(ops[ops.length - 1]).toEqual({ m: 'order', args: ['clave'] });
  });

  it('PATCH :clave la rechaza (400 CLAVE_NO_EDITABLE_AQUI) sin escribir', async () => {
    const { svc, llamadas } = armar({});
    const e = await errorDe(
      svc.update(CONFIG_IA_MODELO, { activa: false }, ALE),
    );
    expect(e.status).toBe(400);
    expect(e.body.error).toBe('CLAVE_NO_EDITABLE_AQUI');
    expect(e.body.message).toBe(
      'Esta configuración se edita en Créditos de IA → Modelo de IA.',
    );
    expect(e.body.details).toEqual({ clave: CONFIG_IA_MODELO });
    expect(llamadas).toHaveLength(0);
  });
});
