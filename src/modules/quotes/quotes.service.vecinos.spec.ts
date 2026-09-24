jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../calendar/calendar-sync.service', () => ({
  CalendarSyncService: class {},
}));
jest.mock('../notifications/email.service', () => ({
  EmailService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { EstadoVuelo, type VecinosQuotesQuery } from './dto/list-quotes.query';
import type { AircraftService } from '../aircraft/aircraft.service';
import type { AirportsService } from '../airports/airports.service';
import type { RoutesService } from '../routes/routes.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { CalendarSyncService } from '../calendar/calendar-sync.service';
import type { EmailService } from '../notifications/email.service';
import type { NotificationsService } from '../realtime/notifications.service';
import type { FlightsService } from '../flights/flights.service';

/**
 * FLECHAS «‹ Anterior» / «Siguiente ›» entre cotizaciones (24-sep-2026,
 * pedido de Itzi: «ya le piqué al vuelo del 20 de septiembre … si hay una
 * flechita arriba me brinca el siguiente vuelito, ya sea de ese mismo día o
 * hasta el siguiente día»).
 *
 * La BD es EN MEMORIA y además INTERPRETA lo que el servicio le pide
 * (`eq/gt/lt/ilike/in/or/order/limit`), así que el orden cronológico, el
 * empate por folio y los filtros salen de las MISMAS consultas que corren en
 * producción — no de un mock que devuelve «lo que el test espera».
 */

type Fila = Record<string, unknown>;
type Op = [string, ...unknown[]];
interface Llamada {
  tabla: string;
  ops: Op[];
}

const CLI_MAQAR = 'cccccccc-0000-4000-8000-000000000001';
const CLI_PUNTA = 'cccccccc-0000-4000-8000-000000000002';
const AVION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const GRUPO = 'gggggggg-0000-4000-8000-000000000001';

/** Instante de pared Cancún (UTC−5) como lo devuelve PostgREST. */
const cancun = (dia: string, hora: string): string => {
  const d = new Date(`${dia}T${hora}:00-05:00`);
  return d.toISOString().replace('.000Z', '+00:00');
};

function vuelo(
  folio: number,
  fecha: string | null,
  extra: Partial<Fila> = {},
): Fila {
  return {
    id: `vvvvvvvv-0000-4000-8000-${String(folio).padStart(12, '0')}`,
    folio,
    fecha_vuelo: fecha,
    estado: 'COTIZADO',
    cliente_id: CLI_MAQAR,
    aeronave_id: AVION_A,
    es_externo: false,
    grupo_id: null,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    cliente: { nombre: 'Maqar' },
    ...extra,
  };
}
const idDe = (folio: number) =>
  `vvvvvvvv-0000-4000-8000-${String(folio).padStart(12, '0')}`;

/** Texto de un escalar de la BD en memoria (sin `[object Object]`). */
function texto(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);
}

function comparar(a: unknown, b: unknown): number {
  if (a == null || b == null) return Number.NaN;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  const sa = texto(a);
  const sb = texto(b);
  const ta = Date.parse(sa);
  const tb = Date.parse(sb);
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(sa) &&
    !Number.isNaN(ta) &&
    !Number.isNaN(tb)
  ) {
    return ta - tb;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** `%x%` / `_` de ilike → RegExp insensible a mayúsculas. */
function ilike(valor: unknown, patron: string): boolean {
  if (valor == null) return false;
  const re = new RegExp(
    '^' +
      patron
        .split('')
        .map((ch) =>
          ch === '%'
            ? '.*'
            : ch === '_'
              ? '.'
              : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('') +
      '$',
    'i',
  );
  return re.test(texto(valor));
}

/** Parte `a.eq.1,b.in.(x,y)` por las comas de NIVEL SUPERIOR. */
function partirOr(s: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let actual = '';
  for (const ch of s) {
    if (ch === '(') prof++;
    if (ch === ')') prof--;
    if (ch === ',' && prof === 0) {
      out.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  if (actual) out.push(actual);
  return out;
}

function condicionOr(cond: string, f: Fila): boolean {
  const [col, op, ...resto] = cond.split('.');
  const valor = resto.join('.');
  if (op === 'eq') return comparar(f[col], valor) === 0;
  if (op === 'ilike') return ilike(f[col], valor);
  if (op === 'in') {
    const lista = valor.replace(/^\(|\)$/g, '').split(',');
    return lista.includes(String(f[col]));
  }
  throw new Error(`condición no soportada por el doble: ${cond}`);
}

/** Supabase en memoria que registra cada consulta. */
function bd(tablas: Record<string, Fila[]>, fallaEn?: (l: Llamada) => boolean) {
  const llamadas: Llamada[] = [];
  const from = (tabla: string) => {
    const llamada: Llamada = { tabla, ops: [] };
    llamadas.push(llamada);
    const filtros: Array<(f: Fila) => boolean> = [];
    const orden: Array<[string, boolean]> = [];
    let limite: number | null = null;
    let unica = false;
    const b: Record<string, unknown> = {};
    const reg = (op: string, ...args: unknown[]) => {
      llamada.ops.push([op, ...args]);
      return b;
    };
    b.select = (...a: unknown[]) => reg('select', ...a);
    b.eq = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) === 0);
      return reg('eq', c, v);
    };
    b.gt = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) > 0);
      return reg('gt', c, v);
    };
    b.lt = (c: string, v: unknown) => {
      filtros.push((f) => comparar(f[c], v) < 0);
      return reg('lt', c, v);
    };
    b.ilike = (c: string, p: string) => {
      filtros.push((f) => ilike(f[c], p));
      return reg('ilike', c, p);
    };
    b.in = (c: string, vs: unknown[]) => {
      filtros.push((f) => vs.includes(f[c]));
      return reg('in', c, vs);
    };
    b.or = (s: string) => {
      const conds = partirOr(s);
      filtros.push((f) => conds.some((c) => condicionOr(c, f)));
      return reg('or', s);
    };
    b.order = (c: string, o?: { ascending?: boolean }) => {
      orden.push([c, o?.ascending !== false]);
      return reg('order', c, o);
    };
    b.limit = (n: number) => {
      limite = n;
      return reg('limit', n);
    };
    b.range = (a: number, z: number) => reg('range', a, z);
    b.maybeSingle = () => {
      unica = true;
      return reg('maybeSingle');
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const ejecutar = () => {
        if (fallaEn?.(llamada)) {
          return { data: null, error: { message: 'boom de PostgREST' } };
        }
        let filas = (tablas[tabla] ?? []).filter((f) =>
          filtros.every((fn) => fn(f)),
        );
        filas = [...filas].sort((x, y) => {
          for (const [c, asc] of orden) {
            const d = comparar(x[c], y[c]);
            if (d !== 0 && !Number.isNaN(d)) return asc ? d : -d;
          }
          return 0;
        });
        if (limite != null) filas = filas.slice(0, limite);
        if (unica) return { data: filas[0] ?? null, error: null };
        return { data: filas, error: null, count: filas.length };
      };
      return Promise.resolve(ejecutar()).then(res, rej);
    };
    return b;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  return { supabase, llamadas };
}

function servicio(supabase: SupabaseService): QuotesService {
  return new QuotesService(
    {} as AircraftService,
    {} as AirportsService,
    {} as RoutesService,
    supabase,
    {} as CalendarSyncService,
    {} as EmailService,
    {} as NotificationsService,
    {} as FlightsService,
  );
}

/**
 * Semana real de la oficina (hora Cancún):
 *   #340  19-sep 09:00  (anterior del 20)
 *   #341  20-sep 10:00  ← «el vuelo del 20 de septiembre»
 *   #346  20-sep 15:30  mismo día MÁS TARDE (folio mayor que el del 21)
 *   #343  21-sep 08:00  día siguiente
 *   #350, #351, #352  22-sep 10:00 EXACTO (empate por folio)
 *   #360  sin fecha (nunca es vecina)
 */
const SEMANA: Fila[] = [
  vuelo(343, cancun('2026-09-21', '08:00')),
  vuelo(341, cancun('2026-09-20', '10:00')),
  vuelo(352, cancun('2026-09-22', '10:00')),
  vuelo(346, cancun('2026-09-20', '15:30')),
  vuelo(340, cancun('2026-09-19', '09:00')),
  vuelo(360, null),
  vuelo(350, cancun('2026-09-22', '10:00')),
  vuelo(351, cancun('2026-09-22', '10:00')),
];

const folios = (r: {
  anterior: { folio: number } | null;
  siguiente: { folio: number } | null;
}) => [r.anterior?.folio ?? null, r.siguiente?.folio ?? null];

describe('QuotesService.vecinos — orden cronológico por fecha de vuelo', () => {
  it('«el siguiente vuelito de ese mismo día»: #341 (20-sep 10:00) ⇒ #346 (20-sep 15:30), aunque #343 tenga folio menor', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const r = await servicio(supabase).vecinos(idDe(341), {});
    expect(folios(r)).toEqual([340, 346]);
    expect(r.sin_fecha).toBe(false);
    expect(r.siguiente).toEqual({
      id: idDe(346),
      folio: 346,
      fecha_vuelo: cancun('2026-09-20', '15:30'),
      estado: 'COTIZADO',
      cliente_nombre: 'Maqar',
    });
  });

  it('«o hasta el siguiente día»: #346 (último del 20) ⇒ #343 (21-sep); anterior #341', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const r = await servicio(supabase).vecinos(idDe(346), {});
    expect(folios(r)).toEqual([341, 343]);
  });

  it('empate EXACTO de fecha/hora ⇒ manda el folio: 350 → 351 → 352', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const svc = servicio(supabase);
    expect(folios(await svc.vecinos(idDe(350), {}))).toEqual([343, 351]);
    expect(folios(await svc.vecinos(idDe(351), {}))).toEqual([350, 352]);
    // El último del empate no tiene siguiente (#360 no tiene fecha).
    expect(folios(await svc.vecinos(idDe(352), {}))).toEqual([351, null]);
  });

  it('extremos: el primero no tiene anterior y el último no tiene siguiente', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const svc = servicio(supabase);
    const primero = await svc.vecinos(idDe(340), {});
    expect(primero.anterior).toBeNull();
    expect(primero.siguiente?.folio).toBe(341);
    const ultimo = await svc.vecinos(idDe(352), {});
    expect(ultimo.siguiente).toBeNull();
  });

  it('recorrer con «Siguiente» visita TODA la semana con fecha en orden y sin repetir', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const svc = servicio(supabase);
    const visto: number[] = [];
    let actual: string | null = idDe(340);
    while (actual) {
      const r = await svc.vecinos(actual, {});
      visto.push(Number(actual.slice(-12)));
      actual = r.siguiente?.id ?? null;
    }
    expect(visto).toEqual([340, 341, 346, 343, 350, 351, 352]);
    // Y de regreso con «Anterior», exactamente al revés.
    const atras: number[] = [];
    actual = idDe(352);
    while (actual) {
      const r = await svc.vecinos(actual, {});
      atras.push(Number(actual.slice(-12)));
      actual = r.anterior?.id ?? null;
    }
    expect(atras).toEqual([...visto].reverse());
  });

  it('las consultas son baratas: ancla + 4 con limit(1), ordenadas por fecha y folio', async () => {
    const { supabase, llamadas } = bd({ vuelo: SEMANA });
    await servicio(supabase).vecinos(idDe(341), {});
    const vuelos = llamadas.filter((l) => l.tabla === 'vuelo');
    expect(vuelos).toHaveLength(5);
    const [ancla, ...vecinas] = vuelos;
    expect(ancla.ops).toContainEqual(['select', 'id, folio, fecha_vuelo']);
    for (const l of vecinas) {
      expect(l.ops).toContainEqual(['limit', 1]);
      const select = l.ops.find((o) => o[0] === 'select');
      expect(String(select?.[1])).not.toContain('calculo_snapshot');
    }
    // siguiente-después: fecha asc y luego folio asc.
    const despues = vecinas.find((l) =>
      l.ops.some((o) => o[0] === 'gt' && o[1] === 'fecha_vuelo'),
    );
    expect(despues?.ops.filter((o) => o[0] === 'order')).toEqual([
      ['order', 'fecha_vuelo', { ascending: true }],
      ['order', 'folio', { ascending: true }],
    ]);
    // anterior-antes: fecha desc y luego folio desc.
    const antes = vecinas.find((l) =>
      l.ops.some((o) => o[0] === 'lt' && o[1] === 'fecha_vuelo'),
    );
    expect(antes?.ops.filter((o) => o[0] === 'order')).toEqual([
      ['order', 'fecha_vuelo', { ascending: false }],
      ['order', 'folio', { ascending: false }],
    ]);
  });
});

describe('QuotesService.vecinos — sin fecha y errores', () => {
  it('cotización SIN fecha ⇒ sin_fecha y ninguna consulta de vecinos (ni la búsqueda)', async () => {
    const { supabase, llamadas } = bd({
      vuelo: SEMANA,
      cliente: [{ id: CLI_MAQAR, nombre: 'Maqar' }],
    });
    const r = await servicio(supabase).vecinos(idDe(360), { q: 'maqar' });
    expect(r).toEqual({ anterior: null, siguiente: null, sin_fecha: true });
    expect(llamadas).toHaveLength(1);
  });

  it('una cotización sin fecha nunca aparece como vecina', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    const r = await servicio(supabase).vecinos(idDe(352), {});
    expect(r.siguiente).toBeNull();
  });

  it('vuelo inexistente ⇒ 404 (como findById)', async () => {
    const { supabase } = bd({ vuelo: SEMANA });
    await expect(
      servicio(supabase).vecinos('vvvvvvvv-0000-4000-8000-999999999999', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('si UNA consulta de vecinos falla, el error SUBE (jamás «no hay siguiente»)', async () => {
    const { supabase } = bd({ vuelo: SEMANA }, (l) =>
      l.ops.some((o) => o[0] === 'gt' && o[1] === 'fecha_vuelo'),
    );
    await expect(servicio(supabase).vecinos(idDe(341), {})).rejects.toThrow(
      'boom de PostgREST',
    );
  });

  it('cliente sin nombre (relación vacía o arreglo) ⇒ cliente_nombre null / el primero del arreglo', async () => {
    const { supabase } = bd({
      vuelo: [
        vuelo(1, cancun('2026-09-20', '10:00')),
        vuelo(2, cancun('2026-09-21', '10:00'), { cliente: null }),
        vuelo(3, cancun('2026-09-19', '10:00'), {
          cliente: [{ nombre: '  Punta Pájaros ' }],
        }),
      ],
    });
    const r = await servicio(supabase).vecinos(idDe(1), {});
    expect(r.siguiente?.cliente_nombre).toBeNull();
    expect(r.anterior?.cliente_nombre).toBe('Punta Pájaros');
  });
});

describe('QuotesService.vecinos — MISMOS filtros que la lista', () => {
  it('estado: con «Cotizado» se salta la CONFIRMADA; las CANCELADAS entran si no hay filtro', async () => {
    const filas = [
      vuelo(1, cancun('2026-09-20', '10:00')),
      vuelo(2, cancun('2026-09-21', '10:00'), { estado: 'CONFIRMADO' }),
      vuelo(3, cancun('2026-09-22', '10:00'), { estado: 'CANCELADO' }),
      vuelo(4, cancun('2026-09-23', '10:00')),
    ];
    const { supabase } = bd({ vuelo: filas });
    const svc = servicio(supabase);
    const conFiltro = await svc.vecinos(idDe(1), {
      estado: EstadoVuelo.COTIZADO,
    });
    expect(conFiltro.siguiente?.folio).toBe(4);
    const sinFiltro = await svc.vecinos(idDe(2), {});
    expect(sinFiltro.siguiente?.folio).toBe(3);
    expect(sinFiltro.siguiente?.estado).toBe('CANCELADO');
  });

  it('el ANCLA no necesita cumplir el filtro: una CONFIRMADA abierta desde «Cotizado» navega entre las cotizadas', async () => {
    const filas = [
      vuelo(1, cancun('2026-09-20', '10:00')),
      vuelo(2, cancun('2026-09-21', '10:00'), { estado: 'CONFIRMADO' }),
      vuelo(3, cancun('2026-09-22', '10:00')),
    ];
    const { supabase } = bd({ vuelo: filas });
    const r = await servicio(supabase).vecinos(idDe(2), {
      estado: EstadoVuelo.COTIZADO,
    });
    expect(folios(r)).toEqual([1, 3]);
  });

  it('cliente_id, aeronave_id, es_externo y grupo_id viajan a las 4 consultas', async () => {
    const OTRO_AVION = 'aaaaaaaa-0000-4000-8000-000000000002';
    const filas = [
      vuelo(1, cancun('2026-09-20', '10:00'), { grupo_id: GRUPO }),
      vuelo(2, cancun('2026-09-21', '10:00'), {
        cliente_id: CLI_PUNTA,
        grupo_id: GRUPO,
      }),
      vuelo(3, cancun('2026-09-22', '10:00'), {
        aeronave_id: OTRO_AVION,
        grupo_id: GRUPO,
      }),
      vuelo(4, cancun('2026-09-23', '10:00'), {
        es_externo: true,
        grupo_id: GRUPO,
      }),
      vuelo(5, cancun('2026-09-24', '10:00')),
      vuelo(6, cancun('2026-09-25', '10:00'), { grupo_id: GRUPO }),
    ];
    const { supabase, llamadas } = bd({ vuelo: filas });
    const filtros: VecinosQuotesQuery = {
      cliente_id: CLI_MAQAR,
      aeronave_id: AVION_A,
      es_externo: false,
      grupo_id: GRUPO,
    };
    const r = await servicio(supabase).vecinos(idDe(1), filtros);
    expect(r.siguiente?.folio).toBe(6);
    const vecinas = llamadas.filter((l) => l.tabla === 'vuelo').slice(1);
    expect(vecinas).toHaveLength(4);
    for (const l of vecinas) {
      expect(l.ops).toEqual(
        expect.arrayContaining([
          ['eq', 'cliente_id', CLI_MAQAR],
          ['eq', 'aeronave_id', AVION_A],
          ['eq', 'es_externo', false],
          ['eq', 'grupo_id', GRUPO],
        ]),
      );
    }
  });

  it('búsqueda `q` por nombre de cliente: se resuelve UNA vez para las 4 consultas', async () => {
    const filas = [
      vuelo(1, cancun('2026-09-20', '10:00')),
      vuelo(2, cancun('2026-09-21', '10:00'), {
        cliente_id: CLI_PUNTA,
        cliente: { nombre: 'Punta Pájaros' },
      }),
      vuelo(3, cancun('2026-09-22', '10:00')),
      vuelo(4, cancun('2026-09-19', '10:00'), {
        cliente_id: CLI_PUNTA,
        cliente: { nombre: 'Punta Pájaros' },
      }),
    ];
    const { supabase, llamadas } = bd({
      vuelo: filas,
      cliente: [
        { id: CLI_MAQAR, nombre: 'Maqar Machinery' },
        { id: CLI_PUNTA, nombre: 'Punta Pájaros' },
      ],
      aeropuerto: [],
    });
    const r = await servicio(supabase).vecinos(idDe(1), { q: 'maqar' });
    expect(folios(r)).toEqual([null, 3]);
    expect(llamadas.filter((l) => l.tabla === 'cliente')).toHaveLength(1);
    expect(llamadas.filter((l) => l.tabla === 'aeropuerto')).toHaveLength(1);
    const vecinas = llamadas.filter((l) => l.tabla === 'vuelo').slice(1);
    const ors = vecinas.map((l) => l.ops.find((o) => o[0] === 'or')?.[1]);
    expect(new Set(ors).size).toBe(1);
    expect(String(ors[0])).toContain(`cliente_id.in.(${CLI_MAQAR})`);
  });

  it('búsqueda `q` por ciudad del aeropuerto y por folio: misma regla que la lista', async () => {
    const filas = [
      vuelo(1, cancun('2026-09-20', '10:00')),
      vuelo(2, cancun('2026-09-21', '10:00'), { destino_iata: 'HOL' }),
      vuelo(3, cancun('2026-09-22', '10:00'), { destino_iata: 'MIA' }),
    ];
    const { supabase } = bd({
      vuelo: filas,
      cliente: [],
      aeropuerto: [{ iata: 'hol', ciudad: 'Holbox', nombre: 'Holbox' }],
    });
    const svc = servicio(supabase);
    const porCiudad = await svc.vecinos(idDe(1), { q: 'holbox' });
    expect(porCiudad.siguiente?.folio).toBe(2);
    const porFolio = await svc.vecinos(idDe(1), { q: '3' });
    expect(porFolio.siguiente?.folio).toBe(3);
  });
});

describe('QuotesService.list — el refactor no cambia la lista', () => {
  it('la lista arma el MISMO `.or(...)` de búsqueda y los mismos `eq` que las flechas', async () => {
    const { supabase, llamadas } = bd({
      vuelo: SEMANA,
      // Nombres CON coma y paréntesis: el texto neutralizado (`_`) los encuentra.
      cliente: [{ id: CLI_MAQAR, nombre: 'Mérida, (MX) Tours' }],
      aeropuerto: [
        { iata: 'MID', ciudad: 'Mérida, (MX)', nombre: 'Aeropuerto de Mérida' },
      ],
      escala: [],
    });
    const svc = servicio(supabase);
    const r = await svc.list({
      q: 'Mérida, (MX)',
      estado: EstadoVuelo.COTIZADO,
      limit: 50,
      offset: 0,
    });
    const lista = llamadas.find(
      (l) => l.tabla === 'vuelo' && l.ops.some((o) => o[0] === 'range'),
    );
    expect(lista?.ops).toEqual(
      expect.arrayContaining([
        ['order', 'fecha_solicitud', { ascending: false }],
        ['range', 0, 49],
        ['eq', 'estado', 'COTIZADO'],
      ]),
    );
    const orLista = lista?.ops.find((o) => o[0] === 'or')?.[1];
    // Comas y paréntesis del texto se neutralizan como siempre.
    expect(orLista).toBe(
      'origen_iata.ilike.%MÉRIDA_ _MX_%,destino_iata.ilike.%MÉRIDA_ _MX_%,' +
        `cliente_id.in.(${CLI_MAQAR}),origen_iata.eq.MID,destino_iata.eq.MID`,
    );
    expect(r.count).toBe(r.data.length);

    llamadas.length = 0;
    await svc.vecinos(idDe(341), {
      q: 'Mérida, (MX)',
      estado: EstadoVuelo.COTIZADO,
    });
    const orVecinos = llamadas
      .filter((l) => l.tabla === 'vuelo')
      .slice(1)
      .map((l) => l.ops.find((o) => o[0] === 'or')?.[1]);
    expect(orVecinos).toEqual([orLista, orLista, orLista, orLista]);
  });
});
