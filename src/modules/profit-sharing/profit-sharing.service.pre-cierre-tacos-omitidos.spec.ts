// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { Logger } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';
import type { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';

/**
 * PRE-CIERRE · TACÓMETROS OMITIDOS (15-oct-2026, API 0.0.81, invariante 79):
 * renglón INFORMATIVO `tacometros_omitidos` INMEDIATAMENTE después de
 * `tacos_en_revision`; NO entra a `bloqueantes` (`listo` no cambia), NO lleva
 * `ids` (invariante 81), `count` = TRAMOS, `vuelos[]` deduplicado, `tramos[]`
 * con el motivo de la omisión, quién y cuándo. Lectura detrás de la SONDA
 * (sin migración ⇒ count 0 sin `lectura_fallida`); un fallo de lectura ⇒
 * count 0 + `lectura_fallida` (nunca tumba el pre-cierre). Los nombres salen
 * en UNA sola consulta a `usuario` junto con los de `tacos_en_revision`.
 *
 * Fake: BD EN MEMORIA (mismo intérprete que el spec de `ids`), con ganchos
 * para hacer fallar la sonda (42703) o la lectura de los omitidos.
 */
type Fila = Record<string, unknown>;
type Op = [string, unknown[]];

const ISO = /^\d{4}-\d{2}-\d{2}T/;

function valor(fila: Fila, col: string): unknown {
  let acc: unknown = fila;
  for (const k of col.split('.')) {
    if (Array.isArray(acc)) acc = acc[0] as unknown;
    if (acc == null || typeof acc !== 'object') return undefined;
    acc = (acc as Fila)[k];
  }
  return acc;
}

function comparar(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  const texto = (v: unknown) =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  const sa = texto(a);
  const sb = texto(b);
  if (ISO.test(sa) && ISO.test(sb)) return Date.parse(sa) - Date.parse(sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function aplica(fila: Fila, [op, args]: Op): boolean {
  const [col, v, v2] = args;
  if (typeof col !== 'string') return true;
  const x = valor(fila, col);
  switch (op) {
    case 'eq':
      return x === v;
    case 'neq':
      return x != null && x !== v;
    case 'in':
      return (v as unknown[]).includes(x);
    case 'is':
      return v === null ? x == null : x === v;
    case 'not':
      return v === 'is' && v2 === null ? x != null : true;
    case 'gte': {
      const c = comparar(x, v);
      return c != null && c >= 0;
    }
    case 'lte': {
      const c = comparar(x, v);
      return c != null && c <= 0;
    }
    default:
      return true;
  }
}

interface Consulta {
  tabla: string;
  select: string;
  ops: Op[];
}

interface Opciones {
  /** La sonda de `escala.taco_omitido_at` responde 42703 (sin migración). */
  sinMigracion?: boolean;
  /** La lectura de los omitidos responde error (no la sonda). */
  fallaLecturaOmitidos?: boolean;
}

function armar(tablas: Record<string, Fila[]>, opts: Opciones = {}) {
  const consultas: Consulta[] = [];
  const from = (tabla: string) => {
    const ops: Op[] = [];
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
      'limit',
      'range',
    ]) {
      q[m] = (...args: unknown[]) => {
        ops.push([m, args]);
        return q;
      };
    }
    const resolver = (): {
      data: Fila[] | null;
      error: { code: string; message: string } | null;
    } => {
      const arg = ops.find((o) => o[0] === 'select')?.[1][0];
      const select = typeof arg === 'string' ? arg.trim() : '*';
      consultas.push({ tabla, select, ops: [...ops] });
      if (tabla === 'escala' && select.includes('taco_omitido')) {
        if (opts.sinMigracion) {
          return {
            data: null,
            error: {
              code: '42703',
              message: 'column escala.taco_omitido_at does not exist',
            },
          };
        }
        if (opts.fallaLecturaOmitidos && select !== 'taco_omitido_at') {
          return {
            data: null,
            error: { code: '57014', message: 'canceling statement' },
          };
        }
      }
      let filas = (tablas[tabla] ?? []).filter((f) =>
        ops.every((o) => aplica(f, o)),
      );
      const limite = ops.find((o) => o[0] === 'limit')?.[1][0];
      if (typeof limite === 'number') filas = filas.slice(0, limite);
      return { data: filas, error: null };
    };
    q.maybeSingle = () =>
      Promise.resolve({ data: resolver().data?.[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolver()).then(res, rej);
    return q;
  };
  const supabase = { service: { from } } as unknown as SupabaseService;
  const conciliacion = {
    cobrosSinBanco: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, por_moneda: [] }),
    ligasUsdTcFueraDeLugar: jest
      .fn()
      .mockResolvedValue({ ligas: [], sin_verificar: 0 }),
    omitidosDelPeriodo: jest
      .fn()
      .mockResolvedValue({ count: 0, monto_mxn: 0, monto_usd: 0 }),
  } as unknown as ConciliacionService;
  const tipoCambio = {
    oficialDetallePara: jest.fn().mockResolvedValue(null),
  } as unknown as TipoCambioService;
  const nada = {} as never;
  const svc = new ProfitSharingService(
    supabase,
    nada,
    tipoCambio,
    conciliacion,
  );
  return { svc, consultas };
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };
const CLAVE = 'tacometros_omitidos';
const MOTIVO_300 =
  'Falló el tacómetro del N4142R entre el 10 y el 19 de sep; sin lectura posible';

const vuelo = (
  id: string,
  folio: number,
  estado: string,
  fecha: string,
  piloto_id: string | null = 'pv',
): Fila => ({ id, folio, estado, fecha_vuelo: fecha, piloto_id });

/** Tramo OMITIDO (caso #300 por omisión): CET → CUN, omitido por Itzi. */
const omitido = (id: string, extra: Fila = {}): Fila => ({
  id,
  vuelo_id: 'v300',
  orden: 1,
  origen_iata: 'CET',
  destino_iata: 'CUN',
  fecha_salida_plan: '2026-09-12T20:00:00+00:00',
  revision_motivo: 'Registro: tacómetro omitido por Itzi (oficina)',
  revision_requerida: false,
  piloto_id: 'p1',
  cancelada_at: null,
  taco_omitido_at: '2026-10-15T15:40:00+00:00',
  taco_omitido_por: 'u-itzi',
  taco_omitido_motivo: MOTIVO_300,
  vuelo: vuelo('v300', 300, 'COMPLETADO', '2026-09-12T20:00:00+00:00'),
  ...extra,
});

const USUARIOS: Fila[] = [
  { id: 'p1', nombre: 'Luis Pérez' },
  { id: 'pv', nombre: 'Piloto del vuelo' },
  { id: 'u-itzi', nombre: 'Itzi' },
  { id: 'p-amarillo', nombre: 'Ana Amarillo' },
];

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

const item = (r: Respuesta, clave: string): Fila => {
  const i = r.items.find((x) => x.clave === clave);
  if (!i) throw new Error(`falta el renglón ${clave}`);
  return i;
};

describe('ProfitSharingService.preCierre — tacómetros omitidos (invariante 79)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('va INMEDIATAMENTE después de tacos_en_revision, informativo, sin `ids`; `listo` no cambia', async () => {
    const { svc } = armar({ escala: [omitido('e300')], usuario: USUARIOS });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const claves = r.items.map((i) => i.clave);
    const i = claves.indexOf('tacos_en_revision');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(claves[i + 1]).toBe(CLAVE);
    expect(claves[i + 2]).toBe('fechas_tramos_incoherentes');
    expect(item(r, CLAVE)).toEqual({
      clave: CLAVE,
      titulo: 'Tacómetros omitidos (sin lectura, con motivo)',
      detalle:
        '1 tramo con tacómetro omitido en 1 vuelo: aportan 0 h al cierre. Revisa que el motivo sea válido; si al final hay lectura, captúrala y la omisión se retira sola.',
      count: 1,
      vuelos: [
        {
          id: 'v300',
          folio: 300,
          estado: 'COMPLETADO',
          fecha_vuelo: '2026-09-12T20:00:00+00:00',
        },
      ],
      tramos: [
        {
          vuelo_id: 'v300',
          folio: 300,
          orden: 1,
          origen_iata: 'CET',
          destino_iata: 'CUN',
          fecha_salida_plan: '2026-09-12T20:00:00+00:00',
          motivo: MOTIVO_300,
          piloto_nombre: 'Luis Pérez',
          escala_id: 'e300',
          omitido_por_nombre: 'Itzi',
          omitido_at: '2026-10-15T15:40:00+00:00',
        },
      ],
      informativo: true,
    });
    expect(item(r, CLAVE)).not.toHaveProperty('ids');
    expect(item(r, CLAVE)).not.toHaveProperty('lectura_fallida');
    // Un omitido no bloquea: con todo lo demás vacío, el periodo está listo.
    expect(item(r, 'tacos_en_revision').count).toBe(0);
    expect(r.listo).toBe(true);
  });

  it('count = TRAMOS; vuelos deduplicados (folio asc); fuera cancelados, vuelos cancelados, fuera de periodo y no omitidos', async () => {
    const v279 = vuelo('v279', 279, 'CONFIRMADO', '2026-09-13T15:00:00+00:00');
    const { svc } = armar({
      escala: [
        omitido('e300-2', {
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CET',
        }),
        omitido('e300'),
        omitido('e279', { vuelo_id: 'v279', piloto_id: null, vuelo: v279 }),
        // Fuera: tramo cancelado.
        omitido('e-cancelado', { cancelada_at: '2026-09-20T00:00:00+00:00' }),
        // Fuera: vuelo CANCELADO.
        omitido('e-vc', {
          vuelo_id: 'vc',
          vuelo: vuelo('vc', 280, 'CANCELADO', '2026-09-14T15:00:00+00:00'),
        }),
        // Fuera: vuelo de octubre (fuera del periodo, corte Cancún).
        omitido('e-oct', {
          vuelo_id: 'voct',
          vuelo: vuelo('voct', 450, 'EN_VUELO', '2026-10-01T05:30:00+00:00'),
        }),
        // Fuera: tramo normal (sin omisión).
        omitido('e-normal', {
          taco_omitido_at: null,
          taco_omitido_por: null,
          taco_omitido_motivo: null,
        }),
      ],
      usuario: USUARIOS,
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const it = item(r, CLAVE);
    expect(it.count).toBe(3);
    expect((it.vuelos as Fila[]).map((v) => v.folio)).toEqual([279, 300]);
    expect(
      (it.tramos as Fila[]).map((t) => `${String(t.folio)}/${String(t.orden)}`),
    ).toEqual(['279/1', '300/1', '300/2']);
    // Piloto heredado del vuelo cuando el tramo no tiene.
    expect((it.tramos as Fila[])[0].piloto_nombre).toBe('Piloto del vuelo');
    expect(it.detalle).toBe(
      '3 tramos con tacómetro omitido en 2 vuelos: aportan 0 h al cierre. Revisa que el motivo sea válido; si al final hay lectura, captúrala y la omisión se retira sola.',
    );
    expect(r.listo).toBe(true);
  });

  it('nombres de amarillos y omitidos en UNA sola consulta a `usuario`', async () => {
    const { svc, consultas } = armar({
      escala: [
        omitido('e300'),
        // Un amarillo del periodo (otro vuelo) con su piloto.
        omitido('e-amarillo', {
          vuelo_id: 'v301',
          revision_requerida: true,
          revision_motivo: 'Salida mayor que la llegada',
          piloto_id: 'p-amarillo',
          taco_omitido_at: null,
          taco_omitido_por: null,
          taco_omitido_motivo: null,
          vuelo: vuelo('v301', 301, 'COMPLETADO', '2026-09-14T15:00:00+00:00'),
        }),
      ],
      usuario: USUARIOS,
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const aUsuario = consultas.filter((c) => c.tabla === 'usuario');
    expect(aUsuario).toHaveLength(1);
    const ids = aUsuario[0].ops.find((o) => o[0] === 'in')?.[1][1] as string[];
    expect([...ids].sort()).toEqual(['p-amarillo', 'p1', 'u-itzi']);
    expect(
      (item(r, 'tacos_en_revision').tramos as Fila[])[0].piloto_nombre,
    ).toBe('Ana Amarillo');
    expect((item(r, CLAVE).tramos as Fila[])[0].omitido_por_nombre).toBe(
      'Itzi',
    );
    // El amarillo sí bloquea (como siempre); el omitido no suma a eso.
    expect(item(r, 'tacos_en_revision').count).toBe(1);
    expect(item(r, CLAVE).count).toBe(1);
    expect(r.listo).toBe(false);
  });

  it('lectura fallida ⇒ count 0 + `lectura_fallida`, sin tumbar el pre-cierre ni cambiar `listo`', async () => {
    const { svc } = armar(
      { escala: [omitido('e300')], usuario: USUARIOS },
      { fallaLecturaOmitidos: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(item(r, CLAVE)).toEqual({
      clave: CLAVE,
      titulo: 'Tacómetros omitidos (sin lectura, con motivo)',
      detalle: 'No se pudo leer qué tramos tienen el tacómetro omitido.',
      count: 0,
      vuelos: [],
      tramos: [],
      informativo: true,
      lectura_fallida: true,
    });
    expect(r.listo).toBe(true);
  });

  it('sonda «no» (sin migración) ⇒ count 0 SIN `lectura_fallida` y ninguna consulta nombra la columna fuera de la sonda', async () => {
    const { svc, consultas } = armar(
      { escala: [omitido('e300')], usuario: USUARIOS },
      { sinMigracion: true },
    );
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const it = item(r, CLAVE);
    expect(it).toMatchObject({
      count: 0,
      vuelos: [],
      tramos: [],
      informativo: true,
      detalle: 'Ningún tramo con tacómetro omitido en el periodo.',
    });
    expect(it).not.toHaveProperty('lectura_fallida');
    const nombran = consultas.filter(
      (c) => c.tabla === 'escala' && c.select.includes('taco_omitido'),
    );
    expect(nombran.map((c) => c.select)).toEqual(['taco_omitido_at']);
    expect(r.listo).toBe(true);
  });
});
