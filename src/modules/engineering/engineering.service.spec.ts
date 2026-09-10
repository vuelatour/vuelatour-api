import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { EngineeringService } from './engineering.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Lote 2 Ola B (10-sep-2026) · B1 en mantenimiento: `if_updated_at` → CAS
 * solo cuando `mantenimiento` ya tiene trigger de updated_at (sonda rpc);
 * mientras no, se salta con warn una vez (último gana, como hoy). El patch
 * sella updated_at a mano y MANT_COLS lo expone.
 */
type Resultado = { data: unknown; error: null | { message: string } };
type Llamada = { tabla: string; metodo: string; args: unknown[] };

function armar(resultados: Resultado[]) {
  const llamadas: Llamada[] = [];
  let i = 0;
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {};
    const registra =
      (metodo: string) =>
      (...args: unknown[]) => {
        llamadas.push({ tabla, metodo, args });
        return q;
      };
    for (const m of ['select', 'eq', 'gte', 'lte', 'update', 'order']) {
      q[m] = registra(m);
    }
    q.maybeSingle = () => {
      const r = resultados[Math.min(i, resultados.length - 1)];
      i += 1;
      return Promise.resolve(r);
    };
    return q;
  };
  const rpc = jest.fn();
  const supabase = { service: { from, rpc } } as unknown as SupabaseService;
  return { service: new EngineeringService(supabase), llamadas, rpc };
}

const de = (llamadas: Llamada[], metodo: string) =>
  llamadas.filter((l) => l.tabla === 'mantenimiento' && l.metodo === metodo);

const MANT = {
  id: 'm-1',
  aeronave_id: 'a-1',
  estado: 'PROGRAMADO',
  fecha_programada: '2026-09-20',
  updated_at: '2026-09-10T15:00:00.123456+00:00',
};

describe('EngineeringService.updateMantenimiento — B1 if_updated_at', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('con trigger activo: ventana ±1 ms en el UPDATE, updated_at sellado y fila devuelta', async () => {
    const { service, llamadas, rpc } = armar([
      { data: { ...MANT, fecha_programada: '2026-09-22' }, error: null },
    ]);
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await service.updateMantenimiento('m-1', {
      fecha_programada: '2026-09-22',
      if_updated_at: '2026-09-10T15:00:00.123Z',
    });
    expect(res).toMatchObject({ id: 'm-1', fecha_programada: '2026-09-22' });
    expect(rpc).toHaveBeenCalledWith('updated_at_trigger_activo', {
      p_tabla: 'mantenimiento',
    });
    expect(de(llamadas, 'gte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.122Z',
    ]);
    expect(de(llamadas, 'lte')[0].args).toEqual([
      'updated_at',
      '2026-09-10T15:00:00.124Z',
    ]);
    const payload = de(llamadas, 'update')[0].args[0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('if_updated_at');
    expect(payload).toMatchObject({ fecha_programada: '2026-09-22' });
    expect(typeof payload.updated_at).toBe('string');
    // MANT_COLS expone updated_at (versión para la app).
    expect(String(de(llamadas, 'select')[0].args[0])).toMatch(/, updated_at$/);
  });

  it('sin trigger (función ausente): CAS omitido con un solo warn; el segundo PATCH no vuelve a avisar', async () => {
    const { service, llamadas, rpc } = armar([{ data: MANT, error: null }]);
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    await service.updateMantenimiento('m-1', {
      notas: 'x',
      if_updated_at: '2026-09-10T15:00:00.123Z',
    });
    await service.updateMantenimiento('m-1', {
      notas: 'y',
      if_updated_at: '2026-09-10T15:00:00.123Z',
    });
    expect(de(llamadas, 'gte')).toHaveLength(0);
    expect(de(llamadas, 'lte')).toHaveLength(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const aviso = (warn.mock.calls as unknown[][])[0][0];
    expect(String(aviso)).toMatch(/mantenimiento/);
  });

  it('0 filas con CAS → relee y 409 CONFLICTO_VERSION (mantenimiento); sin llave → 404', async () => {
    const vivo = { ...MANT, updated_at: '2026-09-10T16:00:00+00:00' };
    const { service, rpc } = armar([
      { data: null, error: null }, // UPDATE CAS
      { data: vivo, error: null }, // relectura
    ]);
    rpc.mockResolvedValue({ data: true, error: null });
    let err: unknown;
    try {
      await service.updateMantenimiento('m-1', {
        notas: 'x',
        if_updated_at: '2026-09-10T15:00:00.123Z',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<
      string,
      unknown
    >;
    expect(body.error).toBe('CONFLICTO_VERSION');
    expect(body.message).toMatch(/modificó este mantenimiento/);
    expect(body.details).toEqual({
      actual: vivo,
      updated_at_enviado: '2026-09-10T15:00:00.123Z',
      updated_at_actual: '2026-09-10T16:00:00+00:00',
    });

    const sinLlave = armar([{ data: null, error: null }]);
    await expect(
      sinLlave.service.updateMantenimiento('m-1', { notas: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PATCH sin campos (solo if_updated_at): lectura, sin UPDATE ni sonda', async () => {
    const { service, llamadas, rpc } = armar([{ data: MANT, error: null }]);
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await service.updateMantenimiento('m-1', {
      if_updated_at: '2026-09-10T15:00:00.123Z',
    });
    expect(res).toEqual(MANT);
    expect(de(llamadas, 'update')).toHaveLength(0);
  });
});
