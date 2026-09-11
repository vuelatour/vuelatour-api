// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { DineroReportService } from './dinero-report.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DineroXlsxPayload } from '../pyservices/pyservices.service';

/**
 * LIBRO DINERO — **la categoría de EMPRESA manda sobre el vuelo** (regla del
 * cliente, 11-sep-2026; MISMA regla y MISMA fuente única que el Balance por
 * avión y el reparto a socios).
 *
 * Antes, la hoja "otros gastos" solo leía gastos SIN vuelo: un OTRO/NOMINA
 * ligado a un vuelo NO salía en NINGUNA hoja de este libro (el Balance ya lo
 * cobraba a la empresa y aquí se perdía), y un NOMINA con avión sellado se
 * acreditaba a sus "gastos indirectos" en la hoja utilidades — justo lo que
 * el Balance había dejado de hacer. Dos libros del mismo cierre, dos
 * números.
 */
type Fila = Record<string, unknown>;

const AV = 'av-1';
const V1 = 'v-1';
const DESDE = '2026-09-01';
const HASTA = '2026-09-30';
const DIA = '2026-09-10';

/** Valor de una columna, con soporte de rutas embebidas ("vuelo.folio"). */
function valorEn(f: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, f);
}

function cmp(a: unknown, b: unknown): number {
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) || iso(b)) {
    const na = Date.parse(String(a));
    const nb = Date.parse(String(b));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const txt = (v: unknown) =>
    v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const sa = txt(a);
  const sb = txt(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Separa las condiciones de un `.or(...)` sin romper los `in.(A,B)`. */
function partirOr(cond: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of cond) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

/**
 * Mini-PostgREST en memoria. Incluye `.or(...)` porque la hoja "otros
 * gastos" lo usa para unir «sin vuelo» con «categoría de empresa» en UNA
 * lectura (sin duplicar filas, que es justo el riesgo de dos consultas).
 */
function fakeSupabase(tablas: Record<string, Fila[]>): SupabaseService {
  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
    const filtrar = (fn: (f: Fila) => boolean) => {
      filas = filas.filter(fn);
      return q;
    };
    /** "vuelo_id.is.null" | "categoria.in.(A,B)" | "x.eq.y" */
    const cumple = (f: Fila, cond: string): boolean => {
      const m = /^([^.]+)\.([a-z]+)\.(.*)$/.exec(cond);
      if (!m) return false;
      const [, col, op, raw] = m;
      const v = valorEn(f, col);
      if (op === 'is') return (v ?? null) === (raw === 'null' ? null : raw);
      if (op === 'eq') return String(v) === raw;
      if (op === 'neq') return String(v) !== raw;
      if (op === 'in') {
        return raw
          .replace(/^\(|\)$/g, '')
          .split(',')
          .includes(String(v));
      }
      return false;
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) === v),
      neq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) !== v),
      is: (c: string, v: unknown) =>
        filtrar((f) => (valorEn(f, c) ?? null) === v),
      in: (c: string, arr: unknown[]) =>
        filtrar((f) => arr.includes(valorEn(f, c))),
      // Las comas de un `in.(A,B)` NO separan condiciones (igual que en
      // PostgREST): se corta solo fuera de paréntesis.
      or: (cond: string) =>
        filtrar((f) => partirOr(cond).some((c) => cumple(f, c))),
      gte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) >= 0),
      lte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) <= 0),
      order: (c: string, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1;
        filas.sort((a, b) => dir * cmp(valorEn(a, c), valorEn(b, c)));
        return q;
      },
      limit: (n: number) => {
        filas = filas.slice(0, n);
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: filas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: filas, error: null }).then(res, rej),
    };
    return q;
  };
  return { service: { from } } as unknown as SupabaseService;
}

const gastoBase = {
  aeronave_id: null,
  vuelo_id: null,
  escala_id: null,
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  propina: null,
  valor_ia_extraido: null,
  fecha_gasto: DIA,
  notas: null,
  lugar: null,
  proveedor: null,
  vuelo: null,
};

/** Ligado al vuelo #501 (el embebido `vuelo` alimenta la referencia). */
const conVuelo = { vuelo_id: V1, vuelo: { folio: 501 } };

function tablas(gastos: Fila[]): Record<string, Fila[]> {
  return {
    aeronave: [
      { id: AV, matricula: 'XB-TST', modelo: 'C206', color_calendario: null },
    ],
    cliente: [],
    vuelo: [
      {
        id: V1,
        folio: 501,
        cliente_id: null,
        aeronave_id: AV,
        estado: 'COMPLETADO',
        es_externo: false,
        fecha_vuelo: `${DIA}T15:00:00+00:00`,
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        iva_usd: 0,
        iva_pct: 0,
        monto_total_usd: 2000,
        monto_total_mxn: 40000,
        tc_usd_mxn: 20,
        cobrado: false,
        calculo_snapshot: null,
        subtotal_vuelo_usd: 2000,
        ajuste_final_usd: 0,
        comision_vendedor_usd: 0,
        comision_vendedor_nombre: null,
        tuas_usd: 0,
        extras_total_usd: 0,
        viaticos_pernocta_usd: 0,
      },
    ],
    escala: [
      {
        id: 'e-1',
        vuelo_id: V1,
        orden: 1,
        aeronave_id: null,
        cancelada_at: null,
        taco_salida: 100,
        taco_llegada: 102,
        solo_operativa: false,
        es_ferry: false,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        es_sobrevuelo: false,
        tipo_parada: 'NORMAL',
        pasajeros: 3,
      },
    ],
    cobro_vuelo: [],
    factura: [],
    gasto: gastos,
    gasto_reparto: [],
  };
}

type Privado = {
  buildPayload: (desde: string, hasta: string) => Promise<DineroXlsxPayload>;
};

function armar(gastos: Fila[], repartos: Fila[] = []) {
  const t = tablas(gastos);
  t.gasto_reparto = repartos;
  const service = new DineroReportService(fakeSupabase(t), {} as never);
  return (service as unknown as Privado).buildPayload(DESDE, HASTA);
}

const conceptos = (p: DineroXlsxPayload) =>
  p.otros_gastos.map((f) => f.concepto).join(' | ');

describe('Libro Dinero — la categoría de EMPRESA manda sobre el vuelo (11-sep-2026)', () => {
  it('un OTRO CON vuelo entra ENTERO a "otros gastos" citando el folio', async () => {
    const p = await armar([
      {
        ...gastoBase,
        ...conVuelo,
        id: 'g-otro',
        categoria: 'OTRO',
        monto: 1000,
        notas: 'Comisariato del vuelo',
      },
    ]);
    expect(p.otros_gastos).toHaveLength(1);
    expect(conceptos(p)).toContain('Comisariato del vuelo · vuelo #501');
    expect(p.otros_gastos[0].monto_mxn).toBe(1000);
    // Suma al acumulado de la EMPRESA (hoja utilidades), no a ningún avión.
    expect(p.utilidades_otros_gastos_mxn).toBe(1000);
    expect(p.utilidades_aviones ?? []).toHaveLength(0);
  });

  it('un NOMINA con AVIÓN sellado no se acredita al avión (sí a la empresa)', async () => {
    const p = await armar([
      {
        ...gastoBase,
        id: 'g-nomina',
        aeronave_id: AV,
        categoria: 'NOMINA',
        monto: 2000,
      },
      // Control: INDIRECTO con avión sigue siendo del avión.
      {
        ...gastoBase,
        id: 'g-ind',
        aeronave_id: AV,
        categoria: 'INDIRECTO',
        monto: 400,
      },
    ]);
    expect(p.utilidades_otros_gastos_mxn).toBe(2400);
    const avion = (p.utilidades_aviones ?? []).find(
      (a) => a.matricula === 'XB-TST',
    )!;
    expect(avion.gastos_indirectos_mxn).toBe(400);
  });

  it('las PARTES de un reparto manual SÍ se acreditan al avión (el reparto gana)', async () => {
    const p = await armar(
      [
        {
          ...gastoBase,
          ...conVuelo,
          id: 'g-otro-rep',
          categoria: 'OTRO',
          monto: 900,
        },
      ],
      [{ gasto_id: 'g-otro-rep', aeronave_id: AV, monto: 600 }],
    );
    const avion = (p.utilidades_aviones ?? []).find(
      (a) => a.matricula === 'XB-TST',
    )!;
    expect(avion.otros_gastos_mxn).toBe(600);
    // La FILA del libro no cambia: el pago es UNO (900) y el remanente (300)
    // se queda en el acumulado de la empresa.
    expect(p.otros_gastos[0].monto_mxn).toBe(900);
    expect(conceptos(p)).toContain('repartido entre 1 avión(es)');
  });

  it('el TUA embebido de un gasto de EMPRESA no sale además como egreso "tuas pagadas"', async () => {
    // Ya restó ENTERO en "otros gastos": aparearlo también en la pestaña de
    // otros ingresos lo contaría DOS veces en el MISMO libro.
    const p = await armar([
      {
        ...gastoBase,
        ...conVuelo,
        id: 'g-otro-tua',
        categoria: 'OTRO',
        monto: 1000,
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Tarifa TUA', monto: 600 },
            { concepto: 'Operaciones', monto: 400 },
          ],
        },
      },
    ]);
    const egresos = p.otros_ingresos
      .map((f) => f.concepto_egreso ?? '')
      .join(' | ');
    expect(egresos).not.toMatch(/tua/i);
    expect(p.otros_ingresos.reduce((a, f) => a + (f.egreso_mxn ?? 0), 0)).toBe(
      0,
    );
  });

  it('control: la MISMA factura como OPERACIONES sí aparea su TUA pagado y NO entra a "otros gastos"', async () => {
    const p = await armar([
      {
        ...gastoBase,
        ...conVuelo,
        id: 'g-op-tua',
        categoria: 'OPERACIONES',
        monto: 1000,
        valor_ia_extraido: {
          conceptos: [
            { concepto: 'Tarifa TUA', monto: 600 },
            { concepto: 'Operaciones', monto: 400 },
          ],
        },
      },
    ]);
    expect(p.otros_gastos).toHaveLength(0);
    const tua = p.otros_ingresos.find((f) =>
      /tuas pagadas/i.test(f.concepto_egreso ?? ''),
    );
    expect(tua?.egreso_mxn).toBe(600);
  });
});
