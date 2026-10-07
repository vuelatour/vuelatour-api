import {
  AV,
  gastoComision,
  mundoLibros,
  vuelo2,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * MUNDO DEL CIERRE DE SEPTIEMBRE para el spec de la regla ajustada de las
 * COMISIONES en el GENERAL (7-oct-2026, API 0.0.66):
 * `aircraft-balance.service.comisiones-general.spec`.
 *
 * Dos aviones con socios (la empresa como socia en los dos) y un mes con de
 * todo lo que toca las comisiones:
 *  - #501 XB-TST (10-sep, K 20): 2,230 USD = 2,000 de tiempo + 100 TUAS + 50
 *    extras + 80 de comisión del vendedor (Vendedor Uno, sin IVA); cobros
 *    20,000 MXN con 350 de comisión bancaria + 1,000 USD. Mundo de los libros.
 *  - #503 MULTI-AVIÓN (15-sep, K 18): XB-TST + un tramo de XB-DOS, 2,100 USD
 *    = 2,000 + 100 de comisión (Pablo Canales); cobro 37,800 MXN con 630.01
 *    de comisión bancaria.
 *  - #504 EXTERNO sin avión (18-sep, K 18): 1,000 USD, cobro 18,000 MXN con
 *    900 de comisión bancaria (sin avión que absorba nada).
 *  - #505 XB-DOS (22-sep, K 18): 1,150 USD = 1,000 + 150 de comisión (Pablo
 *    Canales); cobrado; PAGO REAL al vendedor 3,000 MXN > provisión 2,700.
 *  - #506 XB-TST (24-sep, K 18): 1,100 USD = 1,000 + 100 de comisión (Alex
 *    Saab); cobro Paywise 19,800 MXN con 594 de comisión; PAGO REAL 1,500 MXN
 *    < provisión 1,800 (parcial: faltan 300).
 *  - #507 XB-DOS (4-sep, K 16.956) — el caso del cliente (#247): desglose
 *    v1.3 con IVA 16 %: 1,000 de tiempo + 278 de comisión (Pablo Canales) +
 *    204.48 de IVA = 1,482.48 USD; provisión 322.48 USD × 16.956 =
 *    $5,467.97; cobrado en USD.
 *  - #513 XB-TST CONFIRMADO (25-sep, K 18): 1,080 USD = 1,000 + 80 (Saab);
 *    ANTICIPO 9,720 MXN con 486 de comisión bancaria (el reparto no lee el
 *    vuelo; el balance sí cuenta su cobro y su comisión).
 *  - #514 XB-DOS (26-sep, K 18): 1,050 USD = 1,000 + 50 «Comisión BillPocket
 *    (sin IVA)»; cobro BillPocket 18,900 MXN con 945 de comisión.
 *
 * `*-spec.ts` (sin punto) ⇒ fuera del build y fuera de jest.
 */

export const AV2 = 'av-2';
export const V3 = 'v-3';
export const V4 = 'v-4';
export const V5 = 'v-5';
export const V6 = 'v-6';
export const V7 = 'v-7';
export const V13 = 'v-13';
export const V14 = 'v-14';
export const MAU = 'u-mau';
export const ACC = 'u-acc';

const socio = (
  aeronaveId: string,
  socioId: string,
  porcentaje: string,
  nombre: string,
  esEmpresa: boolean,
): Fila => ({
  aeronave_id: aeronaveId,
  socio_id: socioId,
  porcentaje,
  vigente_desde: '2020-01-01',
  vigente_hasta: null,
  usuario: { nombre, es_empresa: esEmpresa },
});

/** Tramo con la forma que leen el libro, la cadena de tacos y el reparto. */
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

/** Cobro con la forma de `cobro_vuelo` (comisión en la moneda del cobro). */
function cobro(
  id: string,
  vueloId: string,
  monto: number,
  moneda: 'MXN' | 'USD',
  tc: number,
  fecha: string,
  comision: number | null,
  extra: Fila = {},
): Fila {
  return {
    id,
    vuelo_id: vueloId,
    monto,
    moneda,
    tc_usd_mxn: tc,
    fecha_cobro: fecha,
    comision_banco_monto: comision,
    ...extra,
  };
}

/** Gasto `COMISION_VENDEDOR` (pago real al vendedor) ligado a un vuelo. */
function pagoVendedor(
  id: string,
  vueloId: string,
  folio: number,
  avion: string,
  monto: number,
  fecha: string,
): Fila {
  return gastoComision(id, monto, {
    vuelo_id: vueloId,
    aeronave_id: avion,
    vuelo: { folio, aeronave_id: avion },
    fecha_gasto: fecha,
  });
}

/** El mundo del cierre (ver la cabecera). Nunca muta el mundo base. */
export function mundoCierre(): Record<string, Fila[]> {
  const m = mundoLibros();
  const f3 = '2026-09-15T15:00:00+00:00';
  return {
    ...m,
    aeronave: [
      { ...m.aeronave[0], activa: true },
      {
        id: AV2,
        matricula: 'XB-DOS',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
        activa: true,
      },
    ],
    aeronave_socio: [
      socio(AV, MAU, '71.000', 'Mauricio Roque', false),
      socio(AV, ACC, '29.000', 'Aero Charter Cancun S.A. de C.V.', true),
      socio(AV2, MAU, '50.000', 'Mauricio Roque', false),
      socio(AV2, ACC, '50.000', 'Aero Charter Cancun S.A. de C.V.', true),
    ],
    usuario: [
      { id: MAU, nombre: 'Mauricio Roque' },
      { id: ACC, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ],
    reserva_overhaul: [],
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V3,
        folio: 503,
        fecha_vuelo: f3,
        destino_iata: 'MID',
        tiempo_cobrable_hr: 2,
        subtotal_vuelo_usd: 2000,
        comision_vendedor_usd: 100,
        comision_vendedor_nombre: 'Pablo Canales',
        monto_total_usd: 2100,
        monto_total_mxn: 37800,
      }),
      vuelo2({
        id: V4,
        folio: 504,
        aeronave_id: null,
        es_externo: true,
        operador_externo: 'XA-TYV',
        costo_externo_usd: 500,
        fecha_vuelo: '2026-09-18T15:00:00+00:00',
      }),
      vuelo2({
        id: V5,
        folio: 505,
        aeronave_id: AV2,
        fecha_vuelo: '2026-09-22T15:00:00+00:00',
        comision_vendedor_usd: 150,
        comision_vendedor_nombre: 'Pablo Canales',
        monto_total_usd: 1150,
        monto_total_mxn: 20700,
      }),
      vuelo2({
        id: V6,
        folio: 506,
        fecha_vuelo: '2026-09-24T15:00:00+00:00',
        comision_vendedor_usd: 100,
        comision_vendedor_nombre: 'Alex Saab',
        monto_total_usd: 1100,
        monto_total_mxn: 19800,
      }),
      vuelo2({
        id: V7,
        folio: 507,
        aeronave_id: AV2,
        fecha_vuelo: '2026-09-04T15:00:00+00:00',
        comision_vendedor_usd: 278,
        comision_vendedor_nombre: 'Pablo Canales',
        iva_pct: 0.16,
        iva_usd: 204.48,
        monto_total_usd: 1482.48,
        monto_total_mxn: 25136.93,
        tc_usd_mxn: 16.956,
        calculo_snapshot: {
          desglose: [
            {
              clave: 'TIEMPO_VUELO',
              concepto: 'Tiempo de vuelo · 1 hr × $1000/hr',
              monto_usd: 1000,
            },
            {
              clave: 'COMISION_VENDEDOR',
              concepto: 'Comisión del vendedor',
              monto_usd: 278,
            },
            { clave: 'IVA', concepto: 'IVA 16 %', monto_usd: 204.48 },
          ],
          meta: { comision_vendedor_nombre: 'Pablo Canales' },
        },
      }),
      vuelo2({
        id: V13,
        folio: 513,
        estado: 'CONFIRMADO',
        fecha_vuelo: '2026-09-25T15:00:00+00:00',
        comision_vendedor_usd: 80,
        comision_vendedor_nombre: 'Saab',
        monto_total_usd: 1080,
        monto_total_mxn: 19440,
      }),
      vuelo2({
        id: V14,
        folio: 514,
        aeronave_id: AV2,
        fecha_vuelo: '2026-09-26T15:00:00+00:00',
        extras_total_usd: 50,
        monto_total_usd: 1050,
        monto_total_mxn: 18900,
        calculo_snapshot: {
          desglose: [
            {
              clave: 'TIEMPO_VUELO',
              concepto: 'Tiempo de vuelo · 1 hr × $1000/hr',
              monto_usd: 1000,
            },
            {
              clave: 'EXTRA',
              concepto: 'Comisión BillPocket (sin IVA)',
              monto_usd: 50,
            },
          ],
        },
      }),
    ],
    escala: [
      ...m.escala,
      tramo('e-3a', V3, 1, { fecha: f3, avionVuelo: AV }),
      tramo('e-3b', V3, 2, {
        fecha: '2026-09-15T18:00:00+00:00',
        avionVuelo: AV,
        aeronave_id: AV2,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      }),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      cobro('c-4', V3, 37800, 'MXN', 18, '2026-09-15T20:00:00+00:00', 630.01),
      cobro('c-5', V4, 18000, 'MXN', 18, '2026-09-18T20:00:00+00:00', 900),
      cobro('c-15', V5, 20700, 'MXN', 18, '2026-09-22T20:00:00+00:00', null),
      cobro('c-16', V6, 19800, 'MXN', 18, '2026-09-24T20:00:00+00:00', 594, {
        comision_banco_pct: 3,
        metodo_cobro: 'PAYWISE',
      }),
      cobro(
        'c-17',
        V7,
        1482.48,
        'USD',
        16.956,
        '2026-09-04T20:00:00+00:00',
        null,
      ),
      cobro('c-13', V13, 9720, 'MXN', 18, '2026-09-20T16:00:00+00:00', 486),
      cobro('c-14', V14, 18900, 'MXN', 18, '2026-09-26T20:00:00+00:00', 945, {
        metodo_cobro: 'BILLPOCKET',
      }),
    ],
    gasto: [
      ...m.gasto,
      pagoVendedor('g-com-505', V5, 505, AV2, 3000, '2026-09-28'),
      pagoVendedor('g-com-506', V6, 506, AV, 1500, '2026-09-29'),
    ],
  };
}

// ===== Casos de la REVISIÓN del 0.0.66 (7-oct-2026) =====

type Mundo = Record<string, Fila[]>;

export const V21 = 'v-21';
export const V22 = 'v-22';

/**
 * + #521 XB-DOS SIN K (27-sep, COMPLETADO): 1,100 USD = 1,000 de tiempo + 100
 * de comisión del vendedor («Sin K»), sin T.C. capturado (y el spec no da
 * oficial); cobro 19,800 MXN con T.C. propio 18 y 396 de comisión bancaria.
 * La provisión del vendedor NO llega a pesos (`vendedor_sin_tc`); la parte
 * del avión de la comisión bancaria sí (396 × 1,000/1,100 = 360). Sin K la
 * venta tampoco llega a pesos: remanente 0 y ganancia −360.
 */
export function conVueloSinK(m: Mundo): Mundo {
  return {
    ...m,
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V21,
        folio: 521,
        aeronave_id: AV2,
        fecha_vuelo: '2026-09-27T15:00:00+00:00',
        comision_vendedor_usd: 100,
        comision_vendedor_nombre: 'Sin K',
        monto_total_usd: 1100,
        monto_total_mxn: null,
        tc_usd_mxn: null,
      }),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      cobro('c-21', V21, 19800, 'MXN', 18, '2026-09-27T20:00:00+00:00', 396),
    ],
  };
}

/**
 * XB-DOS con UN solo vuelo, el #521 sin K: el libro no tiene NINGÚN T.C.
 * (sin T.C. de costos ni promedio) ⇒ la fila resta en pesos pero su ganancia
 * USD queda vacía. XB-TST conserva sus vuelos (sin el multi-avión #503).
 */
export function mundoDosSoloSinK(): Mundo {
  const m = mundoCierre();
  const fuera = new Set([V3, V5, V7, V14]);
  return conVueloSinK({
    ...m,
    vuelo: m.vuelo.filter((v) => !fuera.has(v.id as string)),
    escala: m.escala.filter((e) => !fuera.has(e.vuelo_id as string)),
    cobro_vuelo: m.cobro_vuelo.filter((c) => !fuera.has(c.vuelo_id as string)),
    gasto: m.gasto.filter((g) => !fuera.has(g.vuelo_id as string)),
  });
}

/**
 * + #522 XB-DOS (28-sep, K 18, COMPLETADO) con DOS líneas
 * `COMISION_VENDEDOR` en el desglose (100 + 50 USD, Pablo Canales): la
 * partición suma las dos (150 USD ⇒ provisión de 2,700 MXN en la fila) y
 * «otros movimientos» lista dos ingresos (1,800 + 900). `pagoMxn` = pago
 * real al vendedor (gasto `COMISION_VENDEDOR`); null = sin pago.
 */
export function conVueloDosComisiones(m: Mundo, pagoMxn: number | null): Mundo {
  return {
    ...m,
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V22,
        folio: 522,
        aeronave_id: AV2,
        fecha_vuelo: '2026-09-28T15:00:00+00:00',
        comision_vendedor_usd: 150,
        comision_vendedor_nombre: 'Pablo Canales',
        monto_total_usd: 1150,
        monto_total_mxn: 20700,
        calculo_snapshot: {
          desglose: [
            {
              clave: 'TIEMPO_VUELO',
              concepto: 'Tiempo de vuelo · 1 hr × $1000/hr',
              monto_usd: 1000,
            },
            {
              clave: 'COMISION_VENDEDOR',
              concepto: 'Comisión del vendedor',
              monto_usd: 100,
            },
            {
              clave: 'COMISION_VENDEDOR',
              concepto: 'Comisión del vendedor (segunda línea)',
              monto_usd: 50,
            },
          ],
          meta: { comision_vendedor_nombre: 'Pablo Canales' },
        },
      }),
    ],
    cobro_vuelo: [
      ...m.cobro_vuelo,
      cobro('c-22', V22, 20700, 'MXN', 18, '2026-09-28T20:00:00+00:00', null),
    ],
    gasto:
      pagoMxn == null
        ? m.gasto
        : [
            ...m.gasto,
            pagoVendedor('g-com-522', V22, 522, AV2, pagoMxn, '2026-09-30'),
          ],
  };
}
