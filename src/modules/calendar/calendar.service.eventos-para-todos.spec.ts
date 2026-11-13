// Dependencias pesadas (gateway/jose/googleapis/firebase) fuera del spec.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../realtime/push.service', () => ({ PushService: class {} }));
jest.mock('./calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalendarService } from './calendar.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { CalendarSyncService } from './calendar-sync.service';
import type { PushService } from '../realtime/push.service';

/**
 * EVENTO SIN RESPONSABLE = PARA TODOS (12-nov-2026, API 0.0.139, invariante
 * 134, SIN migración). Pedido de Dirección con la captura de «Agendar evento
 * (no vuelo)» («Jorge Cortes Avionico IJP», Sin responsable): «que se le
 * pueda poner como responsable "Todos", o que al momento de poner "sin
 * responsable" le apareciera a todos en su calendario más bien, en la app y
 * en web».
 *
 * Qué se congela aquí:
 *  - `GET /me/eventos` (calendario de cada quien) = lo suyo + lo de todos;
 *  - el expediente del piloto sigue siendo SOLO lo asignado;
 *  - `GET /calendar?piloto_id=` (vista de un piloto) = lo suyo + lo de todos;
 *  - un evento para todos NO avisa a nadie (ni al agendar, ni al editar, ni
 *    al quitar, ni los recordatorios del servidor);
 *  - quien deja de ser el responsable porque el evento pasó a ser de todos
 *    recibe «Ahora es para todos», no «Ya no te toca».
 *
 * El PostgREST falso FILTRA de verdad (`eq`, `or`, `lte`, `gte`, `order`,
 * `limit`; varios `.or()` = AND, como el real): así la prueba dice quién ve
 * qué, no solo qué llamadas se hicieron.
 */
type Fila = Record<string, unknown>;
type Op = { m: string; args: unknown[] };

const SAAB = 'aaaaaaaa-1111-4111-8111-000000000001'; // piloto
const ZAMORA = 'aaaaaaaa-1111-4111-8111-000000000002'; // piloto
const LUIS = 'aaaaaaaa-1111-4111-8111-000000000003'; // mecánico
const ITZI = 'aaaaaaaa-1111-4111-8111-000000000004'; // oficina (quien agenda)

const NOMBRES: Record<string, string> = {
  [SAAB]: 'Alexander E. Saab',
  [ZAMORA]: 'Abraham Zamora',
  [LUIS]: 'Luis',
  [ITZI]: 'Itzi',
};

/** Hoy = jueves 12-nov-2026, 13:00 Cancún. */
const AHORA = new Date('2026-11-12T18:00:00Z');

function evento(extra: Fila): Fila {
  return {
    titulo: 'Evento',
    fecha_fin: null,
    aeronave_id: null,
    responsable_id: null,
    notas: null,
    created_at: '2026-11-12T12:59:00+00:00',
    updated_at: '2026-11-12T12:59:00+00:00',
    created_by: ITZI,
    google_calendar_id: null,
    client_request_id: null,
    ...extra,
  };
}

/** Los eventos del caso: el de la captura es `AVIONICO`. */
const AVIONICO = evento({
  id: 'ev-avionico',
  titulo: 'Jorge Cortes Avionico IJP',
  fecha: '2026-11-17T13:00:00+00:00', // mar 17/11 08:00 Cancún
});
const BITACORA = evento({
  id: 'ev-bitacora',
  titulo: 'Llenar bitácora',
  fecha: '2026-11-13T14:45:00+00:00',
  responsable_id: SAAB,
});
const TRAMITE = evento({
  id: 'ev-tramite',
  titulo: 'Trámite AFAC',
  fecha: '2026-11-18T15:00:00+00:00',
  responsable_id: ZAMORA,
});
/** Para todos, de varios días, que empezó antes del rango y sigue vivo. */
const FERIA = evento({
  id: 'ev-feria',
  titulo: 'Feria aeronáutica',
  fecha: '2026-11-03T15:00:00+00:00',
  fecha_fin: '2026-11-14T23:00:00+00:00',
});
/** Para todos, pero fuera del rango de /me/eventos (hoy−7 → hoy+90). */
const VIEJO = evento({
  id: 'ev-viejo',
  titulo: 'Lavado de septiembre',
  fecha: '2026-09-20T15:00:00+00:00',
});

// ───────────────────────── PostgREST falso (filtra) ─────────────────────────

/** Divide por comas de nivel superior (fuera de paréntesis). */
function partes(expr: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of expr) {
    if (ch === '(') nivel++;
    if (ch === ')') nivel--;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual) out.push(actual);
  return out;
}

const instante = (v: unknown): number => Date.parse(String(v));

/** `col.op.valor` | `and(…)` | `or(…)` contra una fila. */
function cumple(fila: Fila, expr: string): boolean {
  if (expr.startsWith('and(') && expr.endsWith(')')) {
    return partes(expr.slice(4, -1)).every((p) => cumple(fila, p));
  }
  if (expr.startsWith('or(') && expr.endsWith(')')) {
    return partes(expr.slice(3, -1)).some((p) => cumple(fila, p));
  }
  const i = expr.indexOf('.');
  const j = expr.indexOf('.', i + 1);
  const col = expr.slice(0, i);
  const op = expr.slice(i + 1, j);
  const val = expr.slice(j + 1);
  const v = fila[col];
  switch (op) {
    case 'eq':
      return v === val;
    case 'is':
      if (val !== 'null') throw new Error(`is.${val} no soportado`);
      return v == null;
    case 'gte':
      return v != null && instante(v) >= instante(val);
    case 'lte':
      return v != null && instante(v) <= instante(val);
    default:
      throw new Error(`operador no soportado en la prueba: ${expr}`);
  }
}

function armar(filasIniciales: Fila[]) {
  const filas = filasIniciales.map((f) => ({ ...f }));
  const consultas: Array<{ tabla: string; ops: Op[] }> = [];
  const conEmbeds = (f: Fila): Fila => ({
    ...f,
    aeronave: f.aeronave_id
      ? { matricula: 'XA-IJP', color_calendario: '#123456' }
      : null,
    responsable: f.responsable_id
      ? { nombre: NOMBRES[f.responsable_id as string] ?? 'Sin nombre' }
      : null,
    creador: f.created_by
      ? { nombre: NOMBRES[f.created_by as string] ?? 'Sin nombre' }
      : null,
  });
  const filtradas = (ops: Op[]): Fila[] => {
    let r = filas.slice();
    for (const o of ops) {
      const [a, b, c] = o.args as [string, unknown, unknown];
      if (o.m === 'eq') r = r.filter((f) => f[a] === b);
      if (o.m === 'or') r = r.filter((f) => cumple(f, `or(${a})`));
      if (o.m === 'lte') r = r.filter((f) => instante(f[a]) <= instante(b));
      if (o.m === 'gte') r = r.filter((f) => instante(f[a]) >= instante(b));
      if (o.m === 'not') {
        if (b !== 'is' || c !== null) throw new Error('not no soportado');
        r = r.filter((f) => f[a] != null);
      }
    }
    if (ops.some((o) => o.m === 'order')) {
      r.sort((x, y) => instante(x.fecha) - instante(y.fecha));
    }
    const lim = ops.find((o) => o.m === 'limit');
    return lim ? r.slice(0, lim.args[0] as number) : r;
  };
  const from = (tabla: string) => {
    const ops: Op[] = [];
    consultas.push({ tabla, ops });
    const q: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push({ m, args });
        return q;
      };
    }
    const resolver = (unica: boolean) => {
      if (tabla !== 'evento_flota')
        return { data: unica ? null : [], error: null };
      // Sonda de ColumnaOpcional: la columna existe.
      const sel = ops.find((o) => o.m === 'select');
      if (
        ops.length === 2 &&
        ops.some((o) => o.m === 'limit') &&
        sel?.args[0] === 'client_request_id'
      ) {
        return { data: [], error: null };
      }
      const ins = ops.find((o) => o.m === 'insert');
      if (ins) {
        const nueva: Fila = {
          id: `ev-nuevo-${filas.length + 1}`,
          created_at: AHORA.toISOString(),
          updated_at: AHORA.toISOString(),
          google_calendar_id: null,
          client_request_id: null,
          ...(ins.args[0] as Fila),
        };
        filas.push(nueva);
        return { data: conEmbeds(nueva), error: null };
      }
      const upd = ops.find((o) => o.m === 'update');
      if (upd) {
        const tocadas = filtradas(ops);
        for (const f of tocadas) Object.assign(f, upd.args[0] as Fila);
        return { data: tocadas[0] ? conEmbeds(tocadas[0]) : null, error: null };
      }
      if (ops.some((o) => o.m === 'delete')) {
        for (const f of filtradas(ops)) filas.splice(filas.indexOf(f), 1);
        return { data: null, error: null };
      }
      const r = filtradas(ops).map(conEmbeds);
      return { data: unica ? (r[0] ?? null) : r, error: null };
    };
    q.maybeSingle = () => Promise.resolve(resolver(true));
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver(false)).then(res, rej);
    return q;
  };
  // Sonda del trigger de updated_at: «no existe» (el CAS se salta).
  const rpc = jest.fn().mockResolvedValue({ data: false, error: null });
  const notifyUser = jest.fn().mockResolvedValue(true);
  const notifyUserDetallado = jest.fn().mockResolvedValue({
    notificado: true,
    push_dispositivos: 1,
    plataformas: ['ios'],
  });
  const upsertEventoFlotaEvent = jest.fn().mockResolvedValue(null);
  const removeEventoFlotaEvent = jest.fn().mockResolvedValue(undefined);
  const service = new CalendarService(
    { service: { from, rpc } } as unknown as SupabaseService,
    { notifyUser, notifyUserDetallado } as unknown as NotificationsService,
    {
      upsertEventoFlotaEvent,
      removeEventoFlotaEvent,
    } as unknown as CalendarSyncService,
    {
      contarDispositivosPorUsuario: jest.fn().mockResolvedValue(new Map()),
      dispositivosDe: jest.fn().mockResolvedValue([{ plataforma: 'ios' }]),
    } as unknown as PushService,
  );
  /** Avisos mandados (los dos caminos): destinatario, tipo, título y cuerpo. */
  const avisos = () => {
    const llamadas: unknown[][] = [
      ...(notifyUser.mock.calls as unknown[][]),
      ...(notifyUserDetallado.mock.calls as unknown[][]),
    ];
    return llamadas.map((c) => {
      const n = c[1] as { tipo: string; titulo: string; cuerpo: string };
      return {
        para: c[0] as string,
        tipo: n.tipo,
        titulo: n.titulo,
        cuerpo: n.cuerpo,
      };
    });
  };
  return {
    service,
    filas,
    consultas,
    avisos,
    notifyUser,
    notifyUserDetallado,
    upsertEventoFlotaEvent,
  };
}

const TODOS = [AVIONICO, BITACORA, TRAMITE, FERIA, VIEJO];

describe('Evento sin responsable = para todos (invariante 134)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  describe('GET /me/eventos — el calendario de cada quien', () => {
    it('el piloto ve LO SUYO y LO DE TODOS, en orden; lo de otro responsable no', async () => {
      const { service } = armar(TODOS);
      const mios = await service.listEventosDeUsuario(SAAB);
      expect(mios.map((e) => [e.id, e.para_todos])).toEqual([
        ['ev-feria', true], // empezó el 3-nov y sigue hasta el 14
        ['ev-bitacora', false], // suyo
        ['ev-avionico', true], // el de la captura
      ]);
      // El de todos no trae responsable; el suyo, sí.
      expect(
        mios.find((e) => e.id === 'ev-avionico')?.responsable_id,
      ).toBeNull();
      expect(mios.find((e) => e.id === 'ev-bitacora')?.responsable_id).toBe(
        SAAB,
      );
    });

    it('a quien no tiene nada asignado (el mecánico) le aparecen los de todos — antes no veía ninguno', async () => {
      const { service } = armar(TODOS);
      const mios = await service.listEventosDeUsuario(LUIS);
      expect(mios.map((e) => e.id)).toEqual(['ev-feria', 'ev-avionico']);
      expect(mios.every((e) => e.para_todos)).toBe(true);
    });

    it('cada quien ve los MISMOS eventos para todos y solo sus propias citas', async () => {
      const { service } = armar(TODOS);
      const deTodos = ['ev-feria', 'ev-avionico'];
      for (const [usuario, propias] of [
        [SAAB, ['ev-bitacora']],
        [ZAMORA, ['ev-tramite']],
        [LUIS, []],
        [ITZI, []],
      ] as const) {
        const ids = (await service.listEventosDeUsuario(usuario)).map(
          (e) => e.id,
        );
        expect(ids.filter((id) => deTodos.includes(id))).toEqual(deTodos);
        expect(ids.filter((id) => !deTodos.includes(id))).toEqual(propias);
      }
    });

    it('el rango (hoy−7 → hoy+90, cortes Cancún) aplica igual a los de todos: uno viejo no sale', async () => {
      const { service } = armar(TODOS);
      const ids = (await service.listEventosDeUsuario(LUIS)).map((e) => e.id);
      expect(ids).not.toContain('ev-viejo');
      // …y con un rango pedido, solo lo que cae dentro.
      const semana = await service.listEventosDeUsuario(
        LUIS,
        '2026-11-16',
        '2026-11-18',
      );
      expect(semana.map((e) => e.id)).toEqual(['ev-avionico']);
    });

    it('la consulta es UNA: `or` de responsable (él o nadie) Y `or` de fechas', async () => {
      const { service, consultas } = armar(TODOS);
      await service.listEventosDeUsuario(SAAB);
      const lecturas = consultas.filter(
        (c) => c.tabla === 'evento_flota' && c.ops.some((o) => o.m === 'order'),
      );
      expect(lecturas).toHaveLength(1);
      const ors = lecturas[0].ops
        .filter((o) => o.m === 'or')
        .map((o) => o.args[0]);
      expect(ors[0]).toBe(`responsable_id.eq.${SAAB},responsable_id.is.null`);
      expect(String(ors[1])).toMatch(/^fecha_fin\.gte\./);
      expect(lecturas[0].ops.some((o) => o.m === 'eq')).toBe(false);
    });

    it('un id que no es uuid nunca entra al filtro: quedan solo los de todos', async () => {
      const { service, consultas } = armar(TODOS);
      const ids = (
        await service.listEventosDeUsuario('x,responsable_id.not.is.null')
      ).map((e) => e.id);
      expect(ids).toEqual(['ev-feria', 'ev-avionico']);
      const ors = consultas
        .flatMap((c) => c.ops)
        .filter((o) => o.m === 'or')
        .map((o) => o.args[0]);
      expect(ors[0]).toBe('responsable_id.is.null');
    });
  });

  describe('expediente del piloto (eventos próximos)', () => {
    it('sigue siendo SOLO lo asignado: los de todos no entran (ni llenan el tope)', async () => {
      const { service, consultas } = armar(TODOS);
      const proximos = await service.eventosProximosDe(SAAB);
      expect(proximos.map((e) => e.id)).toEqual(['ev-bitacora']);
      expect(proximos[0].para_todos).toBe(false);
      expect(await service.eventosProximosDe(LUIS)).toEqual([]);
      const lectura = consultas.find(
        (c) => c.tabla === 'evento_flota' && c.ops.some((o) => o.m === 'order'),
      )!;
      expect(lectura.ops).toContainEqual({
        m: 'eq',
        args: ['responsable_id', SAAB],
      });
      expect(lectura.ops).toContainEqual({ m: 'limit', args: [10] });
    });
  });

  describe('GET /calendar — calendario de flota', () => {
    const rango = {
      from: new Date('2026-11-01T05:00:00Z'),
      to: new Date('2026-12-01T04:59:59Z'),
    };
    const eventosDe = async (
      service: CalendarService,
      extra: Record<string, unknown> = {},
    ) => {
      const res = await service.listEvents({ ...rango, ...extra });
      return (res.events as Fila[]).filter((e) => e.tipo_evento === 'evento');
    };

    it('cada evento dice si es para todos (`para_todos`, aditivo); el responsable sigue en `piloto_id`', async () => {
      const { service } = armar(TODOS);
      const evs = await eventosDe(service);
      const porId = new Map(evs.map((e) => [e.evento_id, e]));
      expect(porId.get('ev-avionico')).toMatchObject({
        para_todos: true,
        piloto_id: null,
        piloto_nombre: null,
        responsable_push_dispositivos: null,
        titulo: 'Jorge Cortes Avionico IJP',
        hora: '08:00',
      });
      expect(porId.get('ev-bitacora')).toMatchObject({
        para_todos: false,
        piloto_id: SAAB,
        piloto_nombre: 'Alexander E. Saab',
      });
      // La oficina sigue viendo TODO (lo de cada responsable y lo de todos).
      expect(new Set(evs.map((e) => e.evento_id))).toEqual(
        new Set(['ev-avionico', 'ev-bitacora', 'ev-tramite', 'ev-feria']),
      );
    });

    it('la vista de UN piloto (`piloto_id`) trae lo suyo y lo de todos; lo de otro responsable no', async () => {
      const { service } = armar(TODOS);
      const ids = new Set(
        (await eventosDe(service, { piloto_id: SAAB })).map((e) => e.evento_id),
      );
      expect(ids).toEqual(new Set(['ev-bitacora', 'ev-avionico', 'ev-feria']));
      const deZamora = new Set(
        (await eventosDe(service, { piloto_id: ZAMORA })).map(
          (e) => e.evento_id,
        ),
      );
      expect(deZamora).toEqual(
        new Set(['ev-tramite', 'ev-avionico', 'ev-feria']),
      );
    });
  });

  describe('avisos: un evento para todos no avisa a nadie', () => {
    it('agendar SIN responsable: `para_todos: true`, `aviso: null`, cero avisos; sí se espeja a Google', async () => {
      const { service, avisos, filas, upsertEventoFlotaEvent } = armar([]);
      const res = await service.createEvento(
        {
          titulo: ' Jorge Cortes Avionico IJP ',
          fecha: new Date('2026-11-17T13:00:00Z'),
        },
        ITZI,
      );
      expect(res).toMatchObject({
        titulo: 'Jorge Cortes Avionico IJP',
        responsable_id: null,
        para_todos: true,
        aviso: null,
        idempotente: false,
      });
      expect(filas[0].responsable_id).toBeNull();
      expect(avisos()).toEqual([]);
      expect(upsertEventoFlotaEvent).toHaveBeenCalledTimes(1);
    });

    it('agendar CON responsable no cambió: `para_todos: false` y aviso a esa persona', async () => {
      const { service, avisos } = armar([]);
      const res = await service.createEvento(
        {
          titulo: 'Llenar bitácora',
          fecha: new Date('2026-11-13T14:45:00Z'),
          responsable_id: SAAB,
        },
        ITZI,
      );
      expect(res.para_todos).toBe(false);
      expect(res.aviso).toMatchObject({
        responsable_id: SAAB,
        notificado: true,
      });
      expect(avisos().map((a) => [a.para, a.tipo])).toEqual([
        [SAAB, 'evento_asignado'],
      ]);
    });

    it('editar un evento para todos (hora, título, notas): nadie recibe aviso', async () => {
      const { service, avisos } = armar([AVIONICO]);
      const res = await service.updateEvento(
        'ev-avionico',
        { fecha: new Date('2026-11-17T15:00:00Z'), notas: 'Hangar 2' },
        ITZI,
      );
      expect(res).toMatchObject({ para_todos: true, aviso: null });
      expect(avisos()).toEqual([]);
    });

    it('quitar al responsable lo vuelve PARA TODOS: al anterior se le dice «Ahora es para todos» (sigue en su calendario), no «Ya no te toca»', async () => {
      const { service, avisos, filas } = armar([BITACORA]);
      const res = await service.updateEvento(
        'ev-bitacora',
        { responsable_id: null } as never,
        ITZI,
      );
      expect(res).toMatchObject({
        responsable_id: null,
        para_todos: true,
        aviso: null,
      });
      expect(filas[0].responsable_id).toBeNull();
      const a = avisos();
      expect(a).toHaveLength(1);
      expect(a[0].para).toBe(SAAB);
      expect(a[0].tipo).toBe('evento_actualizado');
      expect(a[0].titulo).toBe('Evento actualizado');
      expect(a[0].cuerpo).toBe(
        'Ahora es para todos (ya no eres el responsable): vie 13/11/2026, 09:45 · Llenar bitácora',
      );
      expect(a[0].cuerpo).not.toContain('Ya no te toca');
      // …y de verdad sigue en su calendario.
      const suyos = await service.listEventosDeUsuario(SAAB);
      expect(suyos.map((e) => [e.id, e.para_todos])).toEqual([
        ['ev-bitacora', true],
      ]);
    });

    it('si quien lo vuelve para todos ES el responsable, no se auto-avisa', async () => {
      const { service, avisos } = armar([BITACORA]);
      await service.updateEvento(
        'ev-bitacora',
        { responsable_id: null } as never,
        SAAB,
      );
      expect(avisos()).toEqual([]);
    });

    it('cambiar de un responsable a OTRO no cambió: «Ya no te toca» al anterior y aviso al nuevo', async () => {
      const { service, avisos } = armar([BITACORA]);
      const res = await service.updateEvento(
        'ev-bitacora',
        { responsable_id: ZAMORA },
        ITZI,
      );
      expect(res.para_todos).toBe(false);
      expect(avisos().map((a) => [a.para, a.tipo])).toEqual([
        [SAAB, 'evento_cancelado'],
        [ZAMORA, 'evento_asignado'],
      ]);
      expect(avisos()[0].cuerpo).toMatch(/^Ya no te toca: /);
    });

    it('ponerle responsable a uno que era de todos: aviso SOLO a esa persona; los demás dejan de verlo sin aviso', async () => {
      const { service, avisos } = armar([AVIONICO]);
      const res = await service.updateEvento(
        'ev-avionico',
        { responsable_id: LUIS },
        ITZI,
      );
      expect(res).toMatchObject({ responsable_id: LUIS, para_todos: false });
      expect(avisos().map((a) => [a.para, a.tipo])).toEqual([
        [LUIS, 'evento_asignado'],
      ]);
      expect(await service.listEventosDeUsuario(SAAB)).toEqual([]);
      expect(
        (await service.listEventosDeUsuario(LUIS)).map((e) => e.id),
      ).toEqual(['ev-avionico']);
    });

    it('quitar del calendario un evento para todos: nadie recibe aviso (el de un responsable sí avisa, como siempre)', async () => {
      const general = armar([AVIONICO]);
      await general.service.removeEvento('ev-avionico');
      expect(general.filas).toEqual([]);
      expect(general.avisos()).toEqual([]);

      const personal = armar([BITACORA]);
      await personal.service.removeEvento('ev-bitacora');
      expect(personal.avisos().map((a) => [a.para, a.tipo])).toEqual([
        [SAAB, 'evento_cancelado'],
      ]);
    });
  });

  describe('cableado (por regex sobre los fuentes)', () => {
    const leer = (rel: string) =>
      readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

    it('los recordatorios del servidor (víspera y 90 min) siguen siendo SOLO de eventos con responsable', () => {
      const alerts = leer('../alerts/alerts.service.ts');
      const lector = alerts.slice(
        alerts.indexOf('private async eventosConResponsableEntre('),
        alerts.indexOf('private async avisarRecordatorioEvento('),
      );
      expect(lector).toContain(".not('responsable_id', 'is', null)");
      const aviso = alerts.slice(
        alerts.indexOf('private async avisarRecordatorioEvento('),
      );
      expect(aviso).toContain('if (!ev.responsable_id) return;');
    });

    it('`/me/eventos`: VISITANTE recibe [] SIN consultar (tampoco los de todos); los demás, su calendario', () => {
      const me = leer('../me/me.controller.ts');
      expect(me).toMatch(
        /if \(current\.rol === Rol\.VISITANTE\) return \[\];\s*return this\.calendar\.listEventosDeUsuario\(\s*current\.userId,\s*query\.desde,\s*query\.hasta,\s*\);/,
      );
    });
  });
});
