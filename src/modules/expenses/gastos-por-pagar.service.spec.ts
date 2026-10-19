jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import { Logger } from '@nestjs/common';
import { GastosPorPagarService } from './gastos-por-pagar.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';

/**
 * RECORDATORIO de gastos «por pagar» (19-oct-2026, API 0.0.95, invariante
 * 93): cada día a las 09:00 Cancún, push a quien capturó el gasto cuando su
 * fecha es HOY («Gasto por pagar hoy») o fue AYER («Gasto por pagar
 * vencido», UNA vez). Dedupe en `alerta_emitida`, marca DESPUÉS de entregar.
 *
 * Reloj: lunes 19-oct-2026 09:00 Cancún.
 */
type Fila = Record<string, unknown>;

const LUIS = 'u-luis';
const ITZI = 'u-itzi';
const BAJA = 'u-baja';

const gasto = (id: string, extra: Fila = {}): Fila => ({
  id,
  categoria: 'TAXI',
  monto: 500,
  moneda: 'MXN',
  fecha_gasto: '2026-10-19',
  por_pagar: true,
  conciliado: false,
  created_by: LUIS,
  vuelo: { folio: 436 },
  ...extra,
});

function mundo(): Record<string, Fila[]> {
  return {
    usuario: [
      { id: LUIS, estado: 'ACTIVO' },
      { id: ITZI, estado: 'ACTIVO' },
      { id: BAJA, estado: 'INACTIVO' },
    ],
    alerta_emitida: [],
    gasto: [
      gasto('g-hoy'),
      gasto('g-ayer', {
        fecha_gasto: '2026-10-18',
        categoria: 'HOTEL',
        monto: 1200.5,
        vuelo: null,
        created_by: ITZI,
      }),
      gasto('g-anteayer', { fecha_gasto: '2026-10-17' }),
      gasto('g-futuro', { fecha_gasto: '2026-10-25' }),
      gasto('g-pagado', { por_pagar: false }),
      gasto('g-conc', { conciliado: true }),
      gasto('g-baja', { created_by: BAJA }),
      gasto('g-sin', { created_by: null }),
    ],
  };
}

function armar(
  opts: {
    sinPorPagar?: boolean;
    notifyOk?: boolean;
    marcarFalla?: 'duplicado' | 'error';
  } = {},
) {
  const db = mundo();
  const consultas: Array<{ tabla: string; sel: string }> = [];
  const from = (tabla: string) => {
    const q = { tabla, sel: '' };
    consultas.push(q);
    const filtros: Array<(r: Fila) => boolean> = [];
    let rango: [number, number] | null = null;
    let tope: number | null = null;
    let head = false;
    const ejecutar = () => {
      if (opts.sinPorPagar && tabla === 'gasto' && /\bpor_pagar\b/.test(q.sel))
        return {
          data: null,
          count: null,
          error: { code: '42703', message: 'column does not exist' },
        };
      let filas = (db[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
      const count = filas.length;
      if (rango) filas = filas.slice(rango[0], rango[1] + 1);
      if (tope != null) filas = filas.slice(0, tope);
      return { data: head ? null : filas, count, error: null };
    };
    const api: Record<string, unknown> = {
      select(s: string, o?: { head?: boolean }) {
        q.sel = s;
        head = o?.head === true;
        return api;
      },
      eq(col: string, v: unknown) {
        filtros.push((r) => r[col] === v);
        return api;
      },
      in(col: string, vs: unknown[]) {
        filtros.push((r) => vs.includes(r[col]));
        return api;
      },
      order: () => api,
      range(a: number, b: number) {
        rango = [a, b];
        return api;
      },
      limit(n: number) {
        tope = n;
        return api;
      },
      insert(v: Fila) {
        if (opts.marcarFalla === 'duplicado')
          return Promise.resolve({ error: { code: '23505', message: 'dup' } });
        if (opts.marcarFalla === 'error')
          return Promise.resolve({ error: { code: '500', message: 'caída' } });
        (db[tabla] ??= []).push(v);
        return Promise.resolve({ error: null });
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(res, rej),
    };
    return api;
  };
  const notifyUser = jest.fn().mockResolvedValue(opts.notifyOk ?? true);
  const svc = new GastosPorPagarService(
    { service: { from } } as unknown as SupabaseService,
    { notifyUser } as unknown as NotificationsService,
  );
  svc.ahora = () => new Date('2026-10-19T14:00:00Z');
  return { svc, db, notifyUser, consultas };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('GastosPorPagarService.recordar', () => {
  it('HOY ⇒ «Gasto por pagar hoy»; AYER ⇒ «Gasto por pagar vencido»; textos y datos exactos', async () => {
    const { svc, notifyUser, db } = armar();
    const r = await svc.recordar();
    expect(r).toEqual({
      activo: true,
      hoy: '2026-10-19',
      candidatos: 4,
      avisados: 2,
      ya_avisados: 0,
      saltados: 2,
      fallos: 0,
    });
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith(LUIS, {
      tipo: 'gasto_registrado',
      titulo: 'Gasto por pagar hoy',
      cuerpo:
        'Taxi / estacionamiento · $500 MXN · vuelo #436 — cuando lo pagues, márcalo pagado (Mis registros en la app, o Gastos en el panel).',
      data: {
        gasto_id: 'g-hoy',
        motivo: 'gasto_por_pagar',
        fecha_gasto: '2026-10-19',
      },
      link: '/admin/expenses?por_pagar=1',
    });
    expect(notifyUser).toHaveBeenCalledWith(
      ITZI,
      expect.objectContaining({
        titulo: 'Gasto por pagar vencido',
        cuerpo: expect.stringMatching(
          /^Hotel · \$1,200\.50 MXN — cuando lo pagues/,
        ) as unknown,
        data: {
          gasto_id: 'g-ayer',
          motivo: 'gasto_por_pagar',
          fecha_gasto: '2026-10-18',
        },
      }),
    );
    // Dedupe marcado DESPUÉS de entregar, uno por gasto y día.
    expect(db.alerta_emitida).toEqual([
      {
        dedupe_key: 'gasto_por_pagar:g-hoy:2026-10-19',
        clave: 'gasto_por_pagar',
      },
      {
        dedupe_key: 'gasto_por_pagar:g-ayer:2026-10-19',
        clave: 'gasto_por_pagar',
      },
    ]);
  });

  it('una segunda corrida el mismo día no repite (dedupe)', async () => {
    const { svc, notifyUser } = armar();
    await svc.recordar();
    notifyUser.mockClear();
    const r = await svc.recordar();
    expect(r).toMatchObject({ avisados: 0, ya_avisados: 2 });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('usuario inactivo y gasto sin capturista ⇒ se saltan; pagado, conciliado, anteayer y futuro ni son candidatos', async () => {
    const { svc, notifyUser } = armar();
    await svc.recordar();
    const avisados = (notifyUser.mock.calls as unknown[][]).map(
      (c) => (c[1] as { data: { gasto_id: string } }).data.gasto_id,
    );
    expect(avisados.sort()).toEqual(['g-ayer', 'g-hoy']);
  });

  it('sin entrega (`notifyUser` false) ⇒ la clave queda LIBRE (mañana lo vuelve a intentar)', async () => {
    const { svc, db } = armar({ notifyOk: false });
    const r = await svc.recordar();
    expect(r).toMatchObject({ avisados: 0, saltados: 4 });
    expect(db.alerta_emitida).toEqual([]);
  });

  it('23505 al marcar = otra corrida ya marcó: cuenta como avisado; otro error ⇒ fallo, nunca lanza', async () => {
    const dup = armar({ marcarFalla: 'duplicado' });
    expect(await dup.svc.recordar()).toMatchObject({ avisados: 2, fallos: 0 });
    const caida = armar({ marcarFalla: 'error' });
    expect(await caida.svc.recordar()).toMatchObject({
      avisados: 0,
      fallos: 2,
    });
  });

  it('SIN la migración ⇒ inactivo, no lee gastos (solo la sonda) ni avisa', async () => {
    const { svc, notifyUser, consultas } = armar({ sinPorPagar: true });
    const r = await svc.recordar();
    expect(r).toMatchObject({ activo: false, candidatos: 0 });
    expect(notifyUser).not.toHaveBeenCalled();
    expect(consultas.map((q) => `${q.tabla}:${q.sel}`)).toEqual([
      'gasto:por_pagar',
    ]);
  });

  it('candado en memoria: dos corridas simultáneas ⇒ la segunda responde null', async () => {
    const { svc } = armar();
    const [a, b] = await Promise.all([svc.recordar(), svc.recordar()]);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
  });

  it('`runRecordatorios` (cron) nunca lanza, ni con la BD fallando', async () => {
    const { svc } = armar({ marcarFalla: 'error' });
    await expect(svc.runRecordatorios()).resolves.toBeUndefined();
  });
});
