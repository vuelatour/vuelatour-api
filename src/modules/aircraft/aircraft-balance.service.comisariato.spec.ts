// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * COMISARIATO (13-oct-2026, invariante 63; pedido del cliente: «agregar en
 * la categoría de gastos: Comisariato; entraría en [la columna OTROS de
 * costos directos] en el balance del avión»).
 *
 * Snacks/bebidas de los PASAJEROS = gasto DIRECTO del vuelo: con vuelo cae
 * ENTERO en la columna OTROS de la fila (junto al FBO) aunque la IA traiga
 * renglones del ticket; con avión y SIN vuelo, en «Gastos Indirectos» del
 * avión (misma regla que COMIDA). Un OTRO con vuelo (captura vieja) sigue
 * siendo de la EMPRESA: no asoma en la fila. Sin campos nuevos en el
 * payload.
 */
type Fila = Record<string, unknown>;

/** Valor de una columna, con soporte de rutas embebidas ("gasto.vuelo_id"). */
function valorEn(fila: Fila, col: string): unknown {
  return col.split('.').reduce<unknown>((acc, k) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const v = (acc as Record<string, unknown>)[k];
    return Array.isArray(v) ? (v[0] as unknown) : v;
  }, fila);
}

/** Comparación de PostgREST: fechas ISO por instante, lo demás crudo. */
function cmp(a: unknown, b: unknown): number {
  const iso = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  if (iso(a) || iso(b)) {
    const na = Date.parse(String(a));
    const nb = Date.parse(String(b));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = a == null ? '' : typeof a === 'string' ? a : JSON.stringify(a);
  const sb = b == null ? '' : typeof b === 'string' ? b : JSON.stringify(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Mini-PostgREST en memoria: filtra las filas que el servicio pide. */
function fakeSupabase(tablas: Record<string, Fila[]>): SupabaseService {
  const from = (tabla: string) => {
    let filas = [...(tablas[tabla] ?? [])];
    const filtrar = (fn: (f: Fila) => boolean) => {
      filas = filas.filter(fn);
      return q;
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) === v),
      neq: (c: string, v: unknown) => filtrar((f) => valorEn(f, c) !== v),
      is: (c: string, v: unknown) =>
        filtrar((f) => (valorEn(f, c) ?? null) === v),
      in: (c: string, arr: unknown[]) =>
        filtrar((f) => arr.includes(valorEn(f, c))),
      gte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) >= 0),
      lte: (c: string, v: unknown) =>
        filtrar((f) => cmp(valorEn(f, c), v) <= 0),
      gt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) > 0),
      lt: (c: string, v: unknown) => filtrar((f) => cmp(valorEn(f, c), v) < 0),
      not: (c: string, op: string, v: unknown) =>
        op === 'is' && v === null
          ? filtrar((f) => (valorEn(f, c) ?? null) !== null)
          : q,
      order: (c: string, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1;
        filas.sort((a, b) => dir * cmp(valorEn(a, c), valorEn(b, c)));
        return q;
      },
      limit: (n: number) => {
        filas = filas.slice(0, n);
        return q;
      },
      range: (a: number, b: number) => {
        filas = filas.slice(a, b + 1);
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

const AV = 'av-1';
const DESDE = '2026-09-01';
const HASTA = '2026-09-30';
const DIA = '2026-09-10';

const gastoBase = {
  escala_id: null,
  aeronave_id: null,
  vuelo_id: null,
  propina: null,
  moneda: 'MXN',
  tc_gasto: null,
  litros: null,
  fecha_gasto: DIA,
  notas: null,
  lugar: null,
  medio_pago: 'TRANSFERENCIA',
  tarjeta_terminacion: null,
  inventario_movimiento_id: null,
  valor_ia_extraido: null,
  proveedor: null,
};

/** Gasto ligado al vuelo #501 del avión AV. */
const conVuelo = { vuelo_id: 'v-1', vuelo: { folio: 501 } };

/** Controles de la fila del vuelo (siguen igual que siempre). */
const CONTROLES: Fila[] = [
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-op',
    categoria: 'OPERACIONES',
    monto: 300,
  },
  { ...gastoBase, ...conVuelo, id: 'g-fbo', categoria: 'FBO', monto: 500 },
  // Captura VIEJA (antes del 13-oct-2026): comisariato como OTRO con vuelo
  // = gasto de la EMPRESA, no asoma en la fila (regla del 11-sep-2026).
  {
    ...gastoBase,
    ...conVuelo,
    id: 'g-otro',
    categoria: 'OTRO',
    monto: 1000,
    notas: 'Comisariato viejo como OTRO',
  },
];

/** Comisariato del vuelo, con la lectura IA del ticket de OXXO (gasto 83da7c99). */
const COMISARIATO_VUELO: Fila = {
  ...gastoBase,
  ...conVuelo,
  id: 'g-comis',
  categoria: 'COMISARIATO',
  monto: 250,
  notas: 'Comisariato pasajeros Holbox',
  medio_pago: 'TARJETA_CORP',
  tarjeta_terminacion: '4321',
  valor_ia_extraido: {
    conceptos: [
      { concepto: 'Mafer surtido salado 120g', monto: 53 },
      { concepto: 'Cristal agua purificada 600ml', monto: 197 },
    ],
  },
};

/** Comisariato con avión y SIN vuelo (la oficina aún no lo liga). */
const COMISARIATO_AVION: Fila = {
  ...gastoBase,
  id: 'g-comis-avion',
  aeronave_id: AV,
  categoria: 'COMISARIATO',
  monto: 180,
};

function tablas(gastos: Fila[]): Record<string, Fila[]> {
  return {
    aeronave: [
      {
        id: AV,
        matricula: 'XB-TST',
        modelo: 'C206',
        color_calendario: null,
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    vuelo: [
      {
        id: 'v-1',
        folio: 501,
        cliente_id: null,
        aeronave_id: AV,
        estado: 'COMPLETADO',
        tipo: 'CHARTER',
        es_externo: false,
        operador_externo: null,
        costo_externo_usd: null,
        fecha_vuelo: `${DIA}T15:00:00+00:00`,
        fecha_solicitud: null,
        fecha_traslado_final: null,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        tiempo_cobrable_hr: 2,
        tarifa_hora_usd: 1000,
        iva_pct: 0,
        iva_usd: 0,
        subtotal_vuelo_usd: 2000,
        ajuste_final_usd: 0,
        tuas_usd: 0,
        extras_total_usd: 0,
        viaticos_pernocta_usd: 0,
        monto_total_usd: 2000,
        monto_total_mxn: 40000,
        tc_usd_mxn: 20,
        comision_vendedor_usd: 0,
        cobrado: false,
        calculo_snapshot: null,
      },
    ],
    escala: [
      {
        id: 'e-1',
        vuelo_id: 'v-1',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        taco_salida: 100,
        taco_llegada: 102,
        aeronave_id: null,
        cancelada_at: null,
        solo_operativa: false,
        es_ferry: false,
        fecha_salida_plan: `${DIA}T15:00:00+00:00`,
        taco_salida_obs: null,
        taco_llegada_obs: null,
        taco_obs_updated_by: null,
        taco_obs_updated_at: null,
        vuelo: { fecha_vuelo: `${DIA}T15:00:00+00:00`, aeronave_id: AV },
      },
    ],
    cobro_vuelo: [],
    gasto: gastos,
    gasto_reparto: [],
    aeronave_socio: [],
    aeropuerto: [],
    cliente: [],
    usuario: [],
  };
}

function armar(gastos: Fila[]) {
  const supabase = fakeSupabase(tablas(gastos));
  const nada = {} as never;
  const aircraft = { proximoServicio: () => null } as never;
  const tipoCambio = {
    oficialDetallePara: () => Promise.resolve(null),
  } as never;
  return new AircraftBalanceService(supabase, nada, aircraft, tipoCambio, nada);
}

type Privado = {
  buildPayload: (
    aircraftId: string | null,
    desde: string,
    hasta: string,
  ) => Promise<BalanceAvionPayload>;
};

const payloadDe = (gastos: Fila[]) =>
  (armar(gastos) as unknown as Privado).buildPayload(AV, DESDE, HASTA);

const filaDel501 = (p: BalanceAvionPayload) => {
  const fila = p.vuelos.find((v) => String(v.folio) === '501');
  expect(fila).toBeDefined();
  return fila!;
};

describe('Balance por avión — Comisariato (13-oct-2026, invariante 63)', () => {
  it('con vuelo: ENTERO en la columna OTROS junto al FBO (no en OPERACIONES ni en PILOTO)', async () => {
    const fila = filaDel501(await payloadDe([...CONTROLES, COMISARIATO_VUELO]));
    // FBO 500 + Comisariato 250; la IA trae renglones del ticket y aun así
    // nada se separa (CATS_SIN_TUA_EMBEBIDO ⇒ `separarPartes` null).
    expect(fila.otros_mxn).toBe(750);
    expect(fila.op_mxn).toBe(300);
    expect(fila.piloto_mxn).toBeNull();
    const lineaComis = (fila.otros_detalle ?? []).find((l) =>
      l.startsWith('Comisariato'),
    );
    expect(lineaComis).toBeDefined();
    expect(lineaComis).toContain('Comisariato pasajeros Holbox');
    expect(lineaComis).toContain('$250.00');
    // Sin traslados: ni TUA ni extensión de horario salen de un ticket de súper.
    expect(fila.tua_pagado_mxn).toBeNull();
    expect(fila).not.toHaveProperty('extension_pagada_mxn');
  });

  it('el OTRO con vuelo (captura vieja) sigue SIN asomar en la fila: es de la empresa', async () => {
    const fila = filaDel501(await payloadDe([...CONTROLES, COMISARIATO_VUELO]));
    const notas = [
      ...(fila.op_detalle ?? []),
      ...(fila.piloto_detalle ?? []),
      ...(fila.otros_detalle ?? []),
    ].join(' | ');
    expect(notas).not.toContain('Comisariato viejo');
  });

  it('la cascada baja EXACTAMENTE el comisariato (un peso, una vez, en el mes del vuelo)', async () => {
    const sin = await payloadDe(CONTROLES);
    const con = await payloadDe([...CONTROLES, COMISARIATO_VUELO]);
    const fSin = filaDel501(sin);
    const fCon = filaDel501(con);
    expect((fCon.otros_mxn ?? 0) - (fSin.otros_mxn ?? 0)).toBe(250);
    expect(fCon.op_mxn).toBe(fSin.op_mxn);
    expect(fSin.remanente_mxn).not.toBeNull();
    expect(fCon.remanente_mxn).not.toBeNull();
    expect(
      Math.round(
        ((fSin.remanente_mxn ?? 0) - (fCon.remanente_mxn ?? 0)) * 100,
      ) / 100,
    ).toBe(250);
  });

  it('con avión y SIN vuelo ⇒ hoja «Gastos Indirectos» del avión (la MISMA regla que COMIDA)', async () => {
    const p = await payloadDe([...CONTROLES, COMISARIATO_AVION]);
    const fila = p.gastos_indirectos.filas.find(
      (f) => f.categoria === 'Comisariato',
    );
    expect(fila).toBeDefined();
    expect(fila!.monto_mxn).toBe(180);
    expect(p.gastos_indirectos.total_mxn).toBe(180);
    // Control: la misma fila como COMIDA cae igual.
    const comida = await payloadDe([
      ...CONTROLES,
      { ...COMISARIATO_AVION, categoria: 'COMIDA' },
    ]);
    expect(comida.gastos_indirectos.total_mxn).toBe(180);
    expect(
      comida.gastos_indirectos.filas.find((f) => f.categoria === 'Comida'),
    ).toBeDefined();
  });

  it('sin campos nuevos: la fila y el payload tienen las MISMAS llaves con o sin comisariato', async () => {
    const sin = await payloadDe(CONTROLES);
    const con = await payloadDe([
      ...CONTROLES,
      COMISARIATO_VUELO,
      COMISARIATO_AVION,
    ]);
    expect(Object.keys(con).sort()).toEqual(Object.keys(sin).sort());
    expect(Object.keys(filaDel501(con)).sort()).toEqual(
      Object.keys(filaDel501(sin)).sort(),
    );
  });
});
