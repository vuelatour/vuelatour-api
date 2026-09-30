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
import type {
  BalanceAvionPayload,
  BalanceAvionVueloPayload,
} from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  V2,
  fakeSupabase,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * COLUMNA «FACTURA VUELATOUR» EN LA HOJA PRINCIPAL del balance por avión y
 * del Balance general (30-sep-2026, API 0.0.45). Marie, para Ale: «en
 * balance por avión el reporte de excel se ocupa que diga el num de factura
 * que nosotros emitimos del servicio, no aparece en la columna, y si puede
 * salir en el reporte general también».
 *
 * Contrato: cada fila de `vuelos` lleva `factura_vuelatour` con la etiqueta
 * de la FUENTE ÚNICA `etiquetasFacturaDeVuelos` (CFDI vivo → facturas
 * EMITIDAS vigentes → folio tecleado → estatus → null). Es del VUELO: un
 * multi-avión lleva la misma en sus dos filas y un CANCELADO también la
 * lleva. El mapa se carga UNA vez por libro con un memo compartido con
 * «otros movimientos»: en el general cada vuelo se pide UNA sola vez.
 */

const AV2 = 'av-2';
const V3 = 'v-3';
const V4 = 'v-4';
const V5 = 'v-5';

/** Tramo con la forma que leen el libro y la cadena de tacos. */
function tramo(
  id: string,
  vueloId: string,
  orden: number,
  extra: Fila & { fecha: string; avionVuelo: string | null },
): Fila {
  const { fecha, avionVuelo, ...resto } = extra;
  return {
    id,
    vuelo_id: vueloId,
    orden,
    aeronave_id: null,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    solo_operativa: false,
    es_ferry: false,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    es_sobrevuelo: false,
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    fecha_salida_plan: fecha,
    taco_salida_obs: null,
    taco_llegada_obs: null,
    taco_obs_updated_by: null,
    taco_obs_updated_at: null,
    vuelo: { fecha_vuelo: fecha, aeronave_id: avionVuelo },
    ...resto,
  };
}

/**
 * El mundo de los libros + un segundo avión y cuatro vuelos más:
 * - #501 (AV): factura EMITIDA vigente «A-0424» (gana sobre el folio
 *   tecleado «VIEJO-1»); una emitida CANCELADA no cuenta.
 * - #502 (AV): CANCELADO con el folio tecleado «B-77».
 * - #503 MULTI-AVIÓN (AV principal + un tramo del AV2): CFDI vivo «VT-9».
 * - #504 (AV2): sin nada ⇒ null.
 * - #505 sin avión (cotizado): solo lo lee «otros movimientos».
 */
function mundoFacturas(): Record<string, Fila[]> {
  const m = mundoLibros();
  const f3 = '2026-09-15T15:00:00+00:00';
  const f4 = '2026-09-18T15:00:00+00:00';
  const f5 = '2026-09-25T15:00:00+00:00';
  const v1 = {
    ...m.vuelo[0],
    factura_estatus: 'FACTURADO',
    factura_folio: 'VIEJO-1',
  };
  const v2 = vuelo2({
    estado: 'CANCELADO',
    factura_estatus: 'FACTURADO',
    factura_folio: 'B-77',
  });
  const v3 = vuelo2({
    id: V3,
    folio: 503,
    fecha_vuelo: f3,
    destino_iata: 'MID',
    tiempo_cobrable_hr: 2,
    subtotal_vuelo_usd: 2000,
    monto_total_usd: 2000,
    monto_total_mxn: 36000,
  });
  const v4 = vuelo2({
    id: V4,
    folio: 504,
    aeronave_id: AV2,
    fecha_vuelo: f4,
  });
  const v5 = vuelo2({
    id: V5,
    folio: 505,
    aeronave_id: null,
    estado: 'COTIZADO',
    fecha_vuelo: f5,
    factura_folio: 'C-5',
  });
  return {
    ...m,
    aeronave: [
      ...m.aeronave,
      {
        id: AV2,
        matricula: 'XB-DOS',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    vuelo: [v1, v2, v3, v4, v5],
    escala: [
      ...m.escala,
      tramo('e-2', V2, 1, {
        fecha: '2026-09-20T15:00:00+00:00',
        avionVuelo: AV,
        destino_iata: 'CZM',
      }),
      tramo('e-3a', V3, 1, { fecha: f3, avionVuelo: AV }),
      tramo('e-3b', V3, 2, {
        fecha: '2026-09-15T18:00:00+00:00',
        avionVuelo: AV,
        aeronave_id: AV2,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      }),
      tramo('e-4', V4, 1, { fecha: f4, avionVuelo: AV2 }),
      tramo('e-5', V5, 1, { fecha: f5, avionVuelo: null }),
    ],
    factura: [
      { vuelo_id: V3, serie: 'VT', folio: '9', estado: 'TIMBRADA' },
      // Un CFDI cancelado no cuenta (la cascada sigue al folio).
      { vuelo_id: V2, serie: 'VT', folio: '8', estado: 'CANCELADA' },
    ],
    factura_emitida_vuelo: [
      {
        vuelo_id: V1,
        factura: {
          serie: 'A',
          folio: '0424',
          folio_num: 424,
          estatus: 'VIGENTE',
          deleted_at: null,
        },
      },
      {
        vuelo_id: V1,
        factura: {
          serie: 'A',
          folio: '0400',
          folio_num: 400,
          estatus: 'CANCELADA',
          deleted_at: null,
        },
      },
    ],
  };
}

/**
 * Supabase del mundo con registro de los lotes pedidos a `factura` (la
 * primera consulta de `etiquetasFacturaDeVuelos` por lote) y, con
 * `fallaFactura`, un error de lectura en esa tabla.
 */
function supabaseCon(
  mundo: Record<string, Fila[]>,
  opts: { fallaFactura?: boolean } = {},
) {
  const base = fakeSupabase(mundo);
  const lotesFactura: string[][] = [];
  const from = (tabla: string) => {
    const q = base.supabase.service.from(tabla);
    if (tabla === 'factura') {
      const inOriginal = q.in as (c: string, arr: unknown[]) => unknown;
      q.in = (c: string, arr: unknown[]) => {
        if (c === 'vuelo_id') lotesFactura.push([...(arr as string[])]);
        return inOriginal(c, arr);
      };
      if (opts.fallaFactura) {
        q.then = (
          res: (v: unknown) => unknown,
          rej?: (e: unknown) => unknown,
        ) =>
          Promise.resolve({
            data: null,
            error: { code: '57014', message: 'statement timeout' },
          }).then(res, rej);
      }
    }
    return q;
  };
  return { supabase: { service: { from } }, lotesFactura };
}

function armar(
  mundo: Record<string, Fila[]>,
  opts: { fallaFactura?: boolean } = {},
) {
  const s = supabaseCon(mundo, opts);
  const enviados: { individual?: BalanceAvionPayload; general?: unknown } = {};
  const pyservices = {
    generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
      enviados.individual = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
    generateBalanceGeneralXlsx: (p: unknown) => {
      enviados.general = p;
      return Promise.resolve(Buffer.from('xlsx'));
    },
  };
  const service = new AircraftBalanceService(
    s.supabase as unknown as SupabaseService,
    pyservices as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, enviados, lotesFactura: s.lotesFactura };
}

type General = {
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
};

const filasDe = (
  vuelos: BalanceAvionVueloPayload[],
  vueloId: string,
): BalanceAvionVueloPayload[] => vuelos.filter((f) => f.vuelo_id === vueloId);

/** Payload sin lo que cambia entre corridas (sello de generación). */
const sinSello = (p: BalanceAvionPayload) => ({ ...p, generado: null });

describe('Balance por avión — columna «FACTURA VUELATOUR» en la hoja principal (30-sep-2026)', () => {
  it('cada fila lleva la etiqueta de la fuente única: emitida vigente, folio tecleado (CANCELADO) y CFDI vivo', async () => {
    const { service, enviados } = armar(mundoFacturas());
    await service.xlsx(AV, DESDE, HASTA);
    const p = enviados.individual!;
    const folios = p.vuelos.map((f) => [f.folio, f.factura_vuelatour]);
    expect(folios).toEqual([
      ['501', 'A-0424'],
      ['503', 'VT-9'],
      ['502', 'B-77'],
    ]);
    // El CANCELADO se sigue rotulando como cancelado y lleva su factura.
    const cancelado = filasDe(p.vuelos, V2)[0];
    expect(cancelado.cancelado).toBe(true);
    expect(cancelado.factura_vuelatour).toBe('B-77');
  });

  it('libro sin facturas: la clave viaja en TODAS las filas, en null', async () => {
    const { service, enviados } = armar(mundoLibros());
    await service.xlsx(AV, DESDE, HASTA);
    const p = enviados.individual!;
    expect(p.vuelos.length).toBeGreaterThan(0);
    for (const f of p.vuelos) {
      expect(f).toHaveProperty('factura_vuelatour', null);
    }
  });

  it('la columna NO mueve ningún otro número: con y sin facturas el payload es idéntico salvo `factura_vuelatour`', async () => {
    const con = armar(mundoFacturas());
    await con.service.xlsx(AV, DESDE, HASTA);
    const sinFacturas = mundoFacturas();
    sinFacturas.factura = [];
    sinFacturas.factura_emitida_vuelo = [];
    sinFacturas.vuelo = sinFacturas.vuelo.map((v) => ({
      ...v,
      factura_estatus: null,
      factura_folio: null,
    }));
    const sin = armar(sinFacturas);
    await sin.service.xlsx(AV, DESDE, HASTA);
    const pCon = con.enviados.individual!;
    const pSin = sin.enviados.individual!;
    expect(pSin.vuelos.every((f) => f.factura_vuelatour === null)).toBe(true);
    const quitar = (p: BalanceAvionPayload) =>
      sinSello({
        ...p,
        vuelos: p.vuelos.map((f) => ({ ...f, factura_vuelatour: null })),
      });
    expect(quitar(pCon)).toEqual(quitar(pSin));
  });

  it('en lote: UNA consulta a `factura` con todos los vuelos del libro (nunca N+1)', async () => {
    const { service, lotesFactura } = armar(mundoFacturas());
    await service.xlsx(AV, DESDE, HASTA);
    expect(lotesFactura).toHaveLength(1);
    expect([...lotesFactura[0]].sort()).toEqual([V1, V2, V3].sort());
  });

  it('un fallo al leer las facturas tumba el libro con contexto (jamás la columna vacía en silencio)', async () => {
    const { service } = armar(mundoFacturas(), { fallaFactura: true });
    await expect(service.xlsx(AV, DESDE, HASTA)).rejects.toThrow(
      'Balance XB-TST: fallo al leer facturas: statement timeout',
    );
  });
});

describe('Balance GENERAL — «FACTURA VUELATOUR» en la hoja principal consolidada (30-sep-2026)', () => {
  it('multi-avión: las filas de LOS DOS libros llevan la misma etiqueta; el consolidado también', async () => {
    const { service, enviados } = armar(mundoFacturas());
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    const deV3 = filasDe(g.consolidado.vuelos, V3);
    expect(deV3).toHaveLength(2);
    expect(deV3.map((f) => f.factura_vuelatour)).toEqual(['VT-9', 'VT-9']);
    const porLibro = Object.fromEntries(
      g.aviones.map((p) => [
        p.matricula,
        p.vuelos.map((f) => [f.folio, f.factura_vuelatour]),
      ]),
    );
    expect(porLibro).toEqual({
      'XB-DOS': [
        ['503', 'VT-9'],
        ['504', null],
      ],
      'XB-TST': [
        ['501', 'A-0424'],
        ['503', 'VT-9'],
        ['502', 'B-77'],
      ],
    });
    // Consolidado: cada fila con la etiqueta de su vuelo (cancelado incluido).
    const consolidado = g.consolidado.vuelos.map((f) => [
      f.folio,
      f.factura_vuelatour,
    ]);
    expect(consolidado).toEqual([
      ['501', 'A-0424'],
      ['503', 'VT-9'],
      ['503', 'VT-9'],
      ['504', null],
      ['502', 'B-77'],
    ]);
  });

  it('memo compartido: cada vuelo se pide UNA vez en todo el general; «otros movimientos» solo pide el que ningún libro leyó', async () => {
    const { service, enviados, lotesFactura } = armar(mundoFacturas());
    await service.xlsxGeneral(DESDE, HASTA);
    const pedidos = lotesFactura.flat();
    // Sin duplicados: el #503 (dos libros) y los que la pestaña vuelve a
    // listar no se consultan otra vez.
    expect(new Set(pedidos).size).toBe(pedidos.length);
    expect([...pedidos].sort()).toEqual([V1, V2, V3, V4, V5].sort());
    // Los libros van en orden de matrícula: XB-DOS lee #503 y #504; XB-TST
    // solo #501 y #502 (el #503 ya está en el memo) y la pestaña solo el
    // #505 (sin avión: ningún libro lo cargó).
    expect(lotesFactura.map((l) => [...l].sort())).toEqual([
      [V3, V4],
      [V1, V2],
      [V5],
    ]);
    // Y la pestaña sigue diciendo la misma etiqueta que la hoja principal.
    const om = (
      enviados.general as {
        consolidado: {
          otros_movimientos: {
            filas: Array<{ clave: string; factura: unknown }>;
          };
        };
      }
    ).consolidado.otros_movimientos;
    const fila501 = om.filas.find((f) => f.clave.endsWith('501'));
    expect(fila501?.factura).toBe('A-0424');
  });

  it('libro EXTERNOS y fila «solo gastos de tramo cancelado»: también llevan la etiqueta de su vuelo', async () => {
    const V6 = 'v-6';
    const V7 = 'v-7';
    const f6 = '2026-09-26T15:00:00+00:00';
    const f7 = '2026-09-27T15:00:00+00:00';
    const m = mundoFacturas();
    const mundo: Record<string, Fila[]> = {
      ...m,
      vuelo: [
        ...m.vuelo,
        // Externo SIN avión de referencia ⇒ libro EXTERNOS del general.
        vuelo2({
          id: V6,
          folio: 506,
          aeronave_id: null,
          es_externo: true,
          operador_externo: 'Operador Ajeno',
          fecha_vuelo: f6,
          factura_estatus: 'FACTURADO',
          factura_folio: 'X-6',
        }),
        // Del XB-TST con un tramo CANCELADO del XB-DOS que tiene un gasto:
        // en el libro del XB-DOS entra como fila «solo gastos».
        vuelo2({ id: V7, folio: 507, fecha_vuelo: f7 }),
      ],
      escala: [
        ...m.escala,
        tramo('e-6', V6, 1, { fecha: f6, avionVuelo: null }),
        tramo('e-7a', V7, 1, { fecha: f7, avionVuelo: AV }),
        tramo('e-7b', V7, 2, {
          fecha: '2026-09-27T18:00:00+00:00',
          avionVuelo: AV,
          aeronave_id: AV2,
          cancelada_at: '2026-09-26T12:00:00+00:00',
          origen_iata: 'MID',
          destino_iata: 'CUN',
        }),
      ],
      gasto: [
        ...m.gasto,
        {
          id: 'g-tramo-cancelado',
          vuelo_id: V7,
          escala_id: 'e-7b',
          aeronave_id: AV2,
          categoria: 'OPERACIONES',
          monto: 500,
          propina: null,
          moneda: 'MXN',
          tc_gasto: null,
          litros: null,
          fecha_gasto: '2026-09-27',
          notas: 'Aterrizaje del tramo cancelado',
          lugar: null,
          medio_pago: 'TRANSFERENCIA',
          tarjeta_terminacion: null,
          inventario_movimiento_id: null,
          valor_ia_extraido: null,
          proveedor: null,
          vuelo: { folio: 507, aeronave_id: AV },
        },
      ],
      factura_emitida_vuelo: [
        ...m.factura_emitida_vuelo,
        {
          vuelo_id: V7,
          factura: {
            serie: 'A',
            folio: '0500',
            folio_num: 500,
            estatus: 'VIGENTE',
            deleted_at: null,
          },
        },
      ],
    };
    const { service, enviados, lotesFactura } = armar(mundo);
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    const libro = (mat: string) => g.aviones.find((p) => p.matricula === mat);
    // Libro EXTERNOS (no va en `aviones`: sin bloque de socios; sus filas
    // entran al consolidado): el externo lleva su folio tecleado.
    expect(g.aviones.some((p) => p.matricula === 'EXTERNOS')).toBe(false);
    expect(
      filasDe(g.consolidado.vuelos, V6).map((f) => [
        f.es_externo,
        f.factura_vuelatour,
      ]),
    ).toEqual([[true, 'X-6']]);
    // XB-DOS: la fila «solo gastos» del #507 lleva la etiqueta del vuelo.
    const soloGastos = filasDe(libro('XB-DOS')!.vuelos, V7);
    expect(soloGastos).toHaveLength(1);
    expect(soloGastos[0].solo_gastos_tramo_cancelado).toBe(true);
    expect(soloGastos[0].factura_vuelatour).toBe('A-0500');
    // XB-TST: la fila normal del #507, la misma etiqueta.
    expect(
      filasDe(libro('XB-TST')!.vuelos, V7).map((f) => f.factura_vuelatour),
    ).toEqual(['A-0500']);
    // Consolidado: TODAS las filas de estos dos vuelos con su etiqueta.
    expect(
      g.consolidado.vuelos
        .filter((f) => f.vuelo_id === V6 || f.vuelo_id === V7)
        .map((f) => [f.folio, f.factura_vuelatour]),
    ).toEqual([
      ['506', 'X-6'],
      ['507', 'A-0500'],
      ['507', 'A-0500'],
    ]);
    // Y sigue sin repetir un solo vuelo en las lecturas de facturas.
    const pedidos = lotesFactura.flat();
    expect(new Set(pedidos).size).toBe(pedidos.length);
  });

  it('general sin facturas: todas las filas de la hoja principal en null', async () => {
    const { service, enviados } = armar(mundoLibros());
    await service.xlsxGeneral(DESDE, HASTA);
    const g = enviados.general as General;
    expect(g.consolidado.vuelos.length).toBeGreaterThan(0);
    for (const f of g.consolidado.vuelos) {
      expect(f).toHaveProperty('factura_vuelatour', null);
    }
  });
});

describe('etiquetasFacturaMemo (memo por vuelo)', () => {
  type ConMemo = {
    etiquetasFacturaMemo: (
      ids: string[],
      memo: Map<string, Promise<string | null>>,
    ) => Promise<Map<string, string>>;
  };

  it('solo consulta los vuelos que faltan y reutiliza las promesas del memo', async () => {
    const { service, lotesFactura } = armar(mundoFacturas());
    const priv = service as unknown as ConMemo;
    const memo = new Map<string, Promise<string | null>>([
      [V1, Promise.resolve('YA-EN-MEMO')],
    ]);
    const m = await priv.etiquetasFacturaMemo([V1, V3, V3, V4, ''], memo);
    expect(lotesFactura).toEqual([[V3, V4]]);
    // Solo los vuelos CON etiqueta (mismo contrato que la helper).
    expect([...m.entries()]).toEqual([
      [V1, 'YA-EN-MEMO'],
      [V3, 'VT-9'],
    ]);
    // Segunda llamada con los mismos vuelos: cero consultas.
    await priv.etiquetasFacturaMemo([V3, V4], memo);
    expect(lotesFactura).toHaveLength(1);
  });

  it('un lote fallido rechaza a quien espera (sin etiqueta vacía inventada)', async () => {
    const { service } = armar(mundoFacturas(), { fallaFactura: true });
    const priv = service as unknown as ConMemo;
    const memo = new Map<string, Promise<string | null>>();
    await expect(priv.etiquetasFacturaMemo([V1], memo)).rejects.toThrow(
      'statement timeout',
    );
  });

  it('sin vuelos: ni una consulta', async () => {
    const { service, lotesFactura } = armar(mundoFacturas());
    const priv = service as unknown as ConMemo;
    await expect(priv.etiquetasFacturaMemo([], new Map())).resolves.toEqual(
      new Map(),
    );
    expect(lotesFactura).toHaveLength(0);
  });
});
