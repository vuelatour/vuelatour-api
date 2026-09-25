import * as fs from 'fs';
import * as path from 'path';
import {
  agregadosDeItem,
  montoGastoDeSalida,
  precioVentaDeSalida,
  round,
  ventaDeSalida,
  ventaUnitariaConMargen,
  walkCardex,
  type MovCardex,
} from './inventario-cardex.util';

/**
 * RE-PRECIO DE LAS 10 SALIDAS DEL 01-SEP-2026 (migración de DATOS
 * `20260925000002_repreciar_salidas_tienda.sql`) ⇄ LA REGLA DEL API.
 *
 * La migración escribe importes a mano (SQL). Este spec LEE las tuplas entre
 * `-- CASOS:INICIO` y `-- CASOS:FIN` del archivo y exige que cada número sea
 * EXACTAMENTE el que produce el código TS que usan las salidas nuevas
 * (`ventaUnitariaConMargen` / `precioVentaDeSalida` / `montoGastoDeSalida`) y
 * que, con el CARDEX REAL de producción (SELECT del 25-sep-2026), la utilidad
 * que lee el panel (`ventaDeSalida`) sea la de la tabla. Si alguien edita un
 * importe del SQL o cambia la regla en TS, esto se pone rojo.
 */

const MIGRACION = path.join(
  __dirname,
  '../../../supabase/migrations/20260925000002_repreciar_salidas_tienda.sql',
);

interface Caso {
  movId: string;
  gastoId: string;
  matricula: string;
  cantidad: number;
  costo: number;
  ventaNueva: number;
  montoViejo: number;
  montoNuevo: number;
}

function leerCasos(): Caso[] {
  const sql = fs.readFileSync(MIGRACION, 'utf8');
  const ini = sql.indexOf('-- CASOS:INICIO');
  // FIN se busca DESPUÉS de INICIO (la cabecera del archivo nombra las marcas).
  const fin = sql.indexOf('-- CASOS:FIN', ini);
  if (ini < 0 || fin < ini) throw new Error('Sin marcas CASOS en la migración');
  const bloque = sql.slice(ini, fin);
  const re =
    /\('([0-9a-f-]{36})'::uuid,\s*'([0-9a-f-]{36})'::uuid,\s*'([A-Z0-9-]+)',\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g;
  const casos: Caso[] = [];
  for (const m of bloque.matchAll(re)) {
    casos.push({
      movId: m[1],
      gastoId: m[2],
      matricula: m[3],
      cantidad: Number(m[4]),
      costo: Number(m[5]),
      ventaNueva: Number(m[6]),
      montoViejo: Number(m[7]),
      montoNuevo: Number(m[8]),
    });
  }
  return casos;
}

const CASOS = leerCasos();

/** Utilidad esperada por salida (tabla del contrato, USD). */
const UTILIDAD_USD: Record<string, number> = {
  '40da8327-e60f-41aa-a061-8071ed1f9fc3': 63.75,
  '19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7': 127.5,
  'e8920cba-2c8d-427a-b36c-13683630d1f1': 23.03,
  '63c2a335-98e3-45f6-a665-6ba8b9d07807': 11.52,
  '8452b4f4-e7fb-4632-972a-a3f7d2bb948c': 38.99,
  '276f0524-ad50-4194-9e00-ca8782026fcb': 48.05,
  '2872370e-c9d1-4926-b0aa-69251621dc99': 93.44,
  'e71c2c97-38e2-421e-af31-537ee8c97fe9': 93.44,
  '72b9b33f-facb-4cb7-8677-def258c921d1': 23.13,
  '142888c2-2ab4-441e-a8e9-649d9cc97410': 12.5,
};

// ===== Cardex REAL de prod (SELECT 25-sep-2026) de los 8 productos =====

const N4142R = '5a82eb4a-086c-4058-97bd-b2aacdc2e942';
const XAVGV = '3d0546c3-941f-45cc-b8a9-e3ee77545e68';
const XBPEV = 'a0114a3e-9919-41e8-b8e4-fa433d3f3737';
const N990GG = '8f37ec37-965a-42a8-bac4-9991d282f0a3';
const MATRICULA: Record<string, string> = {
  [N4142R]: 'N4142R',
  [XAVGV]: 'XA-VGV',
  [XBPEV]: 'XB-PEV',
  [N990GG]: 'N990GG',
};

const entradaUsd = (
  id: string,
  cantidad: number,
  costo: number,
  fecha: string,
  created: string,
): MovCardex => ({
  id,
  tipo: 'ENTRADA',
  cantidad,
  costo_unitario_usd: costo,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: null,
  venta_unitaria: null,
  venta_moneda: null,
  fecha_movimiento: fecha,
  created_at: created,
  para_flota: false,
  aeronave_id: null,
});

const salidaUsd = (
  id: string,
  cantidad: number,
  costo: number,
  avion: string,
  created: string,
  venta: number = costo,
): MovCardex => ({
  id,
  tipo: 'SALIDA',
  cantidad,
  costo_unitario_usd: costo,
  moneda: 'USD',
  costo_unitario_mxn: null,
  tc_usd_mxn: null,
  venta_unitaria: venta,
  venta_moneda: 'USD',
  fecha_movimiento: '2026-09-01',
  created_at: created,
  para_flota: false,
  aeronave_id: avion,
  aeronave: { matricula: MATRICULA[avion] },
});

const salidaMxnVieja = (
  id: string,
  cantidad: number,
  avion: string,
  fecha: string,
  created: string,
): MovCardex => ({
  id,
  tipo: 'SALIDA',
  cantidad,
  costo_unitario_usd: 94.71,
  moneda: 'MXN',
  costo_unitario_mxn: 1658.33,
  tc_usd_mxn: 17.51,
  venta_unitaria: null,
  venta_moneda: null,
  fecha_movimiento: fecha,
  created_at: created,
  para_flota: false,
  aeronave_id: avion,
  aeronave: { matricula: MATRICULA[avion] },
});

/** El cardex de cada producto tal como está HOY en prod (venta = costo). */
function cardexProd(): Record<string, MovCardex[]> {
  return {
    aceite: [
      {
        ...entradaUsd(
          'e3f20592-3282-4506-b154-8590ea8eeb84',
          30,
          94.71,
          '2026-07-13',
          '2026-07-13T15:37:31.991531+00:00',
        ),
        moneda: 'MXN',
        costo_unitario_mxn: 1658.33,
        tc_usd_mxn: 17.51,
      },
      salidaMxnVieja(
        'd45dae06-7478-4f33-a412-00ae6a57e588',
        4,
        N4142R,
        '2026-07-17',
        '2026-07-20T16:46:52.485836+00:00',
      ),
      salidaMxnVieja(
        'a9378a18-54e1-4259-b65a-35de6dd533c0',
        2,
        XBPEV,
        '2026-07-20',
        '2026-07-20T16:48:21.530909+00:00',
      ),
      salidaMxnVieja(
        '533fce35-6088-432b-b41f-a242aa471b42',
        24,
        N990GG,
        '2026-08-06',
        '2026-08-07T20:07:07.655395+00:00',
      ),
      entradaUsd(
        'a614e7af-6b74-4f97-8a34-1277c97ffcf0',
        120,
        21.25,
        '2026-08-29',
        '2026-08-29T17:36:43.6649+00:00',
      ),
      salidaUsd(
        '40da8327-e60f-41aa-a061-8071ed1f9fc3',
        12,
        21.25,
        XAVGV,
        '2026-09-22T14:13:06.388548+00:00',
      ),
      salidaUsd(
        '19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7',
        24,
        21.25,
        N4142R,
        '2026-09-22T14:14:18.318367+00:00',
      ),
    ],
    balata: [
      entradaUsd(
        '242afa43-8f99-4ac7-ae4b-75ac4693c382',
        12,
        23.13,
        '2026-08-29',
        '2026-08-29T17:36:21.895647+00:00',
      ),
      salidaUsd(
        '72b9b33f-facb-4cb7-8677-def258c921d1',
        4,
        23.13,
        XAVGV,
        '2026-09-22T14:34:49.272946+00:00',
      ),
    ],
    camara6: [
      entradaUsd(
        '6151ccc6-ce34-418d-b198-bc500d725d12',
        2,
        155.94,
        '2026-08-29',
        '2026-08-29T17:36:21.895647+00:00',
      ),
      salidaUsd(
        '8452b4f4-e7fb-4632-972a-a3f7d2bb948c',
        1,
        155.94,
        N4142R,
        '2026-09-22T14:27:25.220106+00:00',
      ),
    ],
    camara8: [
      entradaUsd(
        '6b01b77e-aa01-4c99-900a-65e9a69db863',
        1,
        192.19,
        '2026-08-29',
        '2026-08-29T17:36:21.895647+00:00',
      ),
      salidaUsd(
        '276f0524-ad50-4194-9e00-ca8782026fcb',
        1,
        192.19,
        XAVGV,
        '2026-09-22T14:28:28.512121+00:00',
      ),
    ],
    pitot: [
      entradaUsd(
        'a90b8f34-3781-4ee1-873b-7a23c03e8511',
        1,
        50,
        '2026-08-29',
        '2026-08-29T17:36:21.895647+00:00',
      ),
      salidaUsd(
        '142888c2-2ab4-441e-a8e9-649d9cc97410',
        1,
        50,
        N4142R,
        '2026-09-22T14:35:52.444391+00:00',
      ),
    ],
    ch48108: [
      entradaUsd(
        '9103637c-f581-468b-b47e-b41c2c4c7cc9',
        3,
        46.06,
        '2026-09-01',
        '2026-09-21T14:19:20.890717+00:00',
      ),
      salidaUsd(
        'e8920cba-2c8d-427a-b36c-13683630d1f1',
        2,
        46.06,
        N4142R,
        '2026-09-22T14:18:11.479114+00:00',
      ),
    ],
    ch48110: [
      entradaUsd(
        '8d366e4a-ce3c-45f6-aa2b-97e6b58e180f',
        1,
        46.06,
        '2026-09-01',
        '2026-09-21T14:23:04.509301+00:00',
      ),
      entradaUsd(
        '7e00d444-0e8a-4be0-999d-2c2755a858c3',
        3,
        46.06,
        '2026-09-01',
        '2026-09-21T14:24:03.7749+00:00',
      ),
      salidaUsd(
        '63c2a335-98e3-45f6-a665-6ba8b9d07807',
        1,
        46.06,
        XAVGV,
        '2026-09-22T14:21:42.47863+00:00',
      ),
    ],
    llanta: [
      entradaUsd(
        'bc17f68d-192c-48fb-bded-84fd206ff218',
        2,
        373.75,
        '2026-09-01',
        '2026-09-21T14:50:24.425815+00:00',
      ),
      salidaUsd(
        '2872370e-c9d1-4926-b0aa-69251621dc99',
        1,
        373.75,
        XAVGV,
        '2026-09-22T14:31:34.515404+00:00',
      ),
      salidaUsd(
        'e71c2c97-38e2-421e-af31-537ee8c97fe9',
        1,
        373.75,
        N4142R,
        '2026-09-22T14:33:24.034366+00:00',
      ),
    ],
  };
}

/** El mismo cardex DESPUÉS de la migración: venta_unitaria = venta nueva del SQL. */
function cardexRepreciado(): Record<string, MovCardex[]> {
  const nueva = new Map(CASOS.map((c) => [c.movId, c.ventaNueva]));
  const out: Record<string, MovCardex[]> = {};
  for (const [k, movs] of Object.entries(cardexProd())) {
    out[k] = movs.map((m) =>
      m.id && nueva.has(m.id) ? { ...m, venta_unitaria: nueva.get(m.id) } : m,
    );
  }
  return out;
}

describe('re-precio 25-sep-2026: SQL ⇄ regla del API', () => {
  it('la migración trae EXACTAMENTE las 10 salidas, sin repetir', () => {
    expect(CASOS).toHaveLength(10);
    expect(new Set(CASOS.map((c) => c.movId)).size).toBe(10);
    expect(new Set(CASOS.map((c) => c.gastoId)).size).toBe(10);
    expect(Object.keys(UTILIDAD_USD).sort()).toEqual(
      CASOS.map((c) => c.movId).sort(),
    );
  });

  it.each(CASOS.map((c) => [c.movId, c] as const))(
    '%s: venta nueva y monto del gasto = funciones TS',
    (_id, c) => {
      expect(ventaUnitariaConMargen(c.costo, 25)).toBe(c.ventaNueva);
      expect(
        precioVentaDeSalida({
          costoUnitario: c.costo,
          monedaSalida: 'USD',
          margenPct: 25,
        }),
      ).toEqual({
        ventaUnitaria: c.ventaNueva,
        ventaMoneda: 'USD',
        origen: 'MARGEN',
      });
      const salida = {
        cantidad: c.cantidad,
        costo_unitario_usd: c.costo,
        moneda: 'USD',
        costo_unitario_mxn: null,
        tc_usd_mxn: null,
        venta_moneda: 'USD',
      };
      expect(
        montoGastoDeSalida({ ...salida, venta_unitaria: c.ventaNueva }),
      ).toEqual({
        monto: c.montoNuevo,
        moneda: 'USD',
        tcGasto: null,
        esVenta: true,
      });
      // Lo de HOY (venta = costo) es el monto viejo que la guarda exige.
      expect(
        montoGastoDeSalida({ ...salida, venta_unitaria: c.costo }).monto,
      ).toBe(c.montoViejo);
    },
  );

  it('con el cardex REAL de prod, la utilidad por salida es la de la tabla, en USD', () => {
    const cardex = cardexRepreciado();
    const casos = new Map(CASOS.map((c) => [c.movId, c]));
    let vistos = 0;
    for (const movs of Object.values(cardex)) {
      const walk = walkCardex(movs);
      for (const m of movs) {
        if (m.tipo !== 'SALIDA' || !m.id) continue;
        const v = ventaDeSalida(m, walk.get(m.id));
        const caso = casos.get(m.id);
        if (caso) {
          vistos += 1;
          expect(v).toMatchObject({
            conVenta: true,
            ventaMoneda: 'USD',
            ventaTotal: caso.montoNuevo,
            ventaTotalUsd: caso.montoNuevo,
            costoUsd: round(caso.cantidad * caso.costo, 2),
            gananciaUsd: UTILIDAD_USD[m.id],
            gananciaMxn: null,
            monedaUtilidad: 'USD',
            utilidadIncompleta: false,
          });
        } else {
          // Las 3 salidas de jul/ago (antes de la tienda): a costo, sin utilidad.
          expect(v).toMatchObject({
            conVenta: false,
            gananciaMxn: null,
            gananciaUsd: null,
            monedaUtilidad: null,
            utilidadIncompleta: false,
          });
        }
      }
    }
    expect(vistos).toBe(10);
  });

  it('HOY (venta = costo) la utilidad de las 10 es 0 USD — por eso se re-precian', () => {
    let total = 0;
    for (const movs of Object.values(cardexProd())) {
      const a = agregadosDeItem(movs);
      total = round(total + (a.utilidad_usd ?? 0), 2);
    }
    expect(total).toBe(0);
  });

  it('por producto y en total: utilidad 535.35 USD sobre ventas de 2,676.68 (costo 2,141.33)', () => {
    const cardex = cardexRepreciado();
    const porProducto: Record<string, number | null> = {};
    let ventas = 0;
    let costo = 0;
    let utilidad = 0;
    let unidadesVendidas = 0;
    let unidadesCargadas = 0;
    for (const [k, movs] of Object.entries(cardex)) {
      const a = agregadosDeItem(movs);
      porProducto[k] = a.utilidad_usd;
      ventas = round(ventas + (a.ventas_usd ?? 0), 2);
      costo = round(costo + (a.costo_ventas_usd ?? 0), 2);
      utilidad = round(utilidad + (a.utilidad_usd ?? 0), 2);
      unidadesVendidas = round(unidadesVendidas + (a.ventas_cant ?? 0), 3);
      unidadesCargadas = round(unidadesCargadas + (a.salidas_cant ?? 0), 3);
      // Jamás las dos monedas en el mismo producto por estas salidas.
      expect(a.utilidad_mxn).toBeNull();
      expect(a.ventas_sin_utilidad).toBe(0);
    }
    expect(porProducto).toEqual({
      aceite: 191.25,
      balata: 23.13,
      camara6: 38.99,
      camara8: 48.05,
      pitot: 12.5,
      ch48108: 23.03,
      ch48110: 11.52,
      llanta: 186.88,
    });
    expect(ventas).toBe(2676.68);
    expect(costo).toBe(2141.33);
    expect(utilidad).toBe(535.35);
    expect(unidadesVendidas).toBe(48);
    expect(unidadesCargadas).toBe(78);
    // Aceite: 66 cargadas a aviones (30 a costo en jul/ago), 36 vendidas.
    const aceite = agregadosDeItem(cardex.aceite);
    expect(aceite.salidas_cant).toBe(66);
    expect(aceite.ventas_cant).toBe(36);
  });

  it('por avión: N4142R +295.46 y XA-VGV +239.89 USD (Σ +535.35); nuevos 1,477.27 / 1,199.41', () => {
    const suma = (f: (c: Caso) => number, mat: string) =>
      round(
        CASOS.filter((c) => c.matricula === mat).reduce((s, c) => s + f(c), 0),
        2,
      );
    const delta = (mat: string) =>
      round(suma((c) => c.montoNuevo, mat) - suma((c) => c.montoViejo, mat), 2);
    expect(suma((c) => c.montoViejo, 'N4142R')).toBe(1181.81);
    expect(suma((c) => c.montoNuevo, 'N4142R')).toBe(1477.27);
    expect(suma((c) => c.montoViejo, 'XA-VGV')).toBe(959.52);
    expect(suma((c) => c.montoNuevo, 'XA-VGV')).toBe(1199.41);
    expect(delta('N4142R')).toBe(295.46);
    expect(delta('XA-VGV')).toBe(239.89);
    expect(round(delta('N4142R') + delta('XA-VGV'), 2)).toBe(535.35);
    expect(
      round(
        CASOS.reduce((s, c) => s + c.montoNuevo, 0),
        2,
      ),
    ).toBe(2676.68);
  });

  it('diferencia de 1 ¢ por avión contra lo autorizado (+295.45 / +239.88): redondeo POR SALIDA, dos medios centavos', () => {
    // Lo autorizado = 25 % del SUBTOTAL por avión (una sola multiplicación).
    const subtotal = (mat: string) =>
      round(
        CASOS.filter((c) => c.matricula === mat).reduce(
          (s, c) => s + c.montoViejo,
          0,
        ),
        2,
      );
    expect(round(subtotal('N4142R') * 0.25, 2)).toBe(295.45);
    expect(round(subtotal('XA-VGV') * 0.25, 2)).toBe(239.88);
    // La regla del API (así nace CADA gasto) redondea cada salida: los dos
    // casos que quedan en medio centavo suben (JS y numeric de Postgres).
    expect(46.06 * 1.25).toBeCloseTo(57.575, 10);
    expect(round(1 * ventaUnitariaConMargen(46.06, 25), 2)).toBe(57.58);
    expect(155.94 * 1.25).toBeCloseTo(194.925, 10);
    expect(round(1 * ventaUnitariaConMargen(155.94, 25), 2)).toBe(194.93);
  });
});
