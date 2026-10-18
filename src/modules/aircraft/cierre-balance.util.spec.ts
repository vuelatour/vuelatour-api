import type { BalanceAvionVueloPayload } from '../pyservices/pyservices.service';
import {
  aplicarFilaSombra,
  aplicarFilaViene,
  cierreDelGeneral,
  itemCierreDeFila,
  leyendaPasariaBalance,
  leyendaSombraBalance,
  marcarFilaNormal,
  pendienteVuelosQuePasan,
  resumenCierrePorAvion,
  type BalanceCierrePayload,
} from './cierre-balance.util';

/**
 * CIERRE DE MES en los balances (16-oct-2026, invariante 89): la fila SOMBRA
 * (mes de origen: horas reales, dinero null) y la fila que VIENE (mes
 * destino: dinero, horas null). Caso #337 (N621TX, 25-sep, 4,931.16 USD a
 * K 17.6425 ⇒ 86,997.99 MXN, 1.6 h).
 */

function fila(
  extra: Partial<BalanceAvionVueloPayload> = {},
): BalanceAvionVueloPayload {
  return {
    clave: '#337 · Ambulancia Internacional',
    vuelo_id: 'v-337',
    folio: '337',
    cliente: 'Ambulancia Internacional',
    estado: 'COMPLETADO',
    es_externo: false,
    fecha: '2026-09-25',
    fecha_fin: null,
    ruta: 'CUN → MID',
    horas_cobradas: 2,
    tarifa_usd: 2465.58,
    iva_hr_usd: 0,
    total_usd: 4931.16,
    iva_usd: 0,
    tc_venta: 17.6425,
    total_cotizacion_usd: 4931.16,
    total_cotizacion_mxn: 86997.99,
    total_mxn: 86997.99,
    iva_mxn: 0,
    subtotal_mxn: 86997.99,
    tiempo_vuelo: 1.6,
    taco_inicio: 100,
    taco_fin: 101.6,
    taco_inicio_obs: ['obs'],
    taco_fin_obs: [],
    salto_taco_interno: true,
    salto_taco_interno_detalle: 'x',
    gas_mxn: null,
    gas_litros: null,
    gas_precio_litro: null,
    op_mxn: 3180.4,
    piloto_mxn: 0,
    otros_mxn: 0,
    op_detalle: ['Op CUN $2,801.40'],
    op_vinculos: [{ id: 'g-1', rol: 'suma', monto_mxn: 2801.4 }],
    permiso_afac_mxn: 1200,
    permiso_afac_usd_hr: 30,
    costo_total_mxn: 4380.4,
    tc_costos: 17.7355,
    costo_usd: 246.98,
    costo_usd_siva: 246.98,
    iva_pagado_usd: 0,
    iva_pagado_mxn: 0,
    remanente_mxn: 82617.59,
    dif_iva_mxn: 0,
    comision_vendedor_mxn: 0,
    ganancia_mxn: 82617.59,
    ganancia_usd: 4684.18,
    costo_hr_usd: 154.36,
    costo_hr_usd_siva: 154.36,
    status_cobro: 'Cobrado',
    cobros: [],
    cobrado_mxn: 86997.99,
    por_cobrar_mxn: 0,
    por_cobrar_usd: 0,
    factura_vuelatour: 'Factura 1234',
    comisiones_mxn: 10,
    ...extra,
  };
}

describe('FILA SOMBRA (mes de origen)', () => {
  it('TODO el dinero en null / vacío y las horas reales intactas', () => {
    const f = fila();
    aplicarFilaSombra(
      f,
      '2026-10',
      'Pasa a octubre 2026 (pendiente de cobro: …)',
    );
    for (const k of [
      'horas_cobradas',
      'total_usd',
      'total_mxn',
      'op_mxn',
      'permiso_afac_mxn',
      'permiso_afac_usd_hr',
      'costo_total_mxn',
      'ganancia_usd',
      'ganancia_mxn',
      'cobrado_mxn',
      'por_cobrar_mxn',
      'por_cobrar_usd',
      'factura_vuelatour',
    ] as const) {
      expect(f[k]).toBeNull();
    }
    expect(f.op_detalle).toEqual([]);
    expect(f.op_vinculos).toEqual([]);
    expect(f.cobros).toEqual([]);
    expect('comisiones_mxn' in f).toBe(false);
    expect(f.tiempo_vuelo).toBe(1.6);
    expect(f.taco_inicio).toBe(100);
    expect(f.taco_fin).toBe(101.6);
    expect(f).toMatchObject({
      status_cobro: 'Pasa a oct-2026',
      fila_sombra: true,
      diferido_a: '2026-10',
      diferido_de: null,
      cierre_marca: 'Pasa a octubre 2026 (pendiente de cobro: …)',
    });
  });
});

describe('FILA QUE VIENE (mes destino)', () => {
  it('dinero completo y horas reales en null', () => {
    const f = fila();
    aplicarFilaViene(f, '2026-09');
    expect(f.total_mxn).toBe(86997.99);
    expect(f.horas_cobradas).toBe(2);
    expect(f.permiso_afac_mxn).toBe(1200);
    expect(f.tiempo_vuelo).toBeNull();
    expect(f.taco_inicio).toBeNull();
    expect(f.taco_fin).toBeNull();
    expect(f.taco_inicio_obs).toEqual([]);
    expect(f.salto_taco_interno).toBe(false);
    expect(f).toMatchObject({
      cierre_marca: 'Viene de septiembre 2026',
      fila_sombra: false,
      diferido_de: '2026-09',
      diferido_a: null,
    });
  });

  it('fila normal con la migración: llaves neutras', () => {
    const f = fila();
    marcarFilaNormal(f);
    expect(f).toMatchObject({
      cierre_marca: null,
      fila_sombra: false,
      diferido_a: null,
      diferido_de: null,
    });
  });
});

describe('listas del bloque CIERRE DEL MES', () => {
  it('item desde la fila (antes de vaciarla) con MXN al K de la venta y la leyenda en pesos', () => {
    const f = fila();
    const it = itemCierreDeFila(f, 'N621TX', {
      venta_usd: 4931.16,
      cobrado_usd: 0,
      por_cobrar_usd: 4931.16,
      destino: '2026-10',
      leyenda: '',
    });
    expect(it).toMatchObject({
      vuelo_id: 'v-337',
      folio: '337',
      matricula: 'N621TX',
      venta_mxn: 86997.99,
      cobrado_mxn: 0,
      por_cobrar_mxn: 86997.99,
      destino: '2026-10',
    });
    expect(leyendaSombraBalance('2026-10', it)).toBe(
      'Pasa a octubre 2026 (pendiente de cobro: cobrado $0.00 MXN de $86,997.99 MXN)',
    );
    expect(leyendaPasariaBalance('2026-11')).toBe(
      'Pendiente de cobro: pasará a noviembre 2026 al cerrar',
    );
  });

  it('COBRO_POSTERIOR (#351, «aparece que aún no se cobran pero sí están cobrados»): llaves aditivas y leyenda que dice cuándo se cobró', () => {
    const f = fila({ tc_venta: 17.71, total_cotizacion_mxn: null });
    const it = itemCierreDeFila(f, 'N621TX', {
      venta_usd: 2343.2,
      cobrado_usd: 0,
      por_cobrar_usd: 2343.2,
      destino: '2026-10',
      leyenda: '',
      motivo: 'COBRO_POSTERIOR',
      cobrado_despues_usd: 2343.2,
      fecha_cobro_despues: '2026-10-14',
    });
    expect(it).toMatchObject({
      motivo: 'COBRO_POSTERIOR',
      corte: '2026-09-30',
      cobrado_despues_usd: 2343.2,
      cobrado_despues_mxn: 41498.07,
      fecha_cobro_despues: '2026-10-14',
    });
    // Las llaves nuevas van AL FINAL (después de `leyenda`).
    const llaves = Object.keys(it);
    expect(llaves.indexOf('motivo')).toBeGreaterThan(llaves.indexOf('leyenda'));
    expect(leyendaSombraBalance('2026-10', it, 'COBRO_POSTERIOR')).toBe(
      'Pasa a octubre 2026 (cobrado después del 30-sep; al cierre: $0.00 MXN de $41,498.07 MXN)',
    );
    expect(
      leyendaPasariaBalance('2026-10', {
        motivo: 'COBRO_POSTERIOR',
        fecha_cobro_posterior: '2026-10-14',
      }),
    ).toBe(
      'Pasará a octubre 2026 al cerrar · cobrado el 14-oct, después del 30-sep',
    );
    // Sin motivo (bitácora vieja / API previo): ni una llave nueva.
    const viejo = itemCierreDeFila(fila(), 'N621TX', {
      venta_usd: 4931.16,
      cobrado_usd: 0,
      por_cobrar_usd: 4931.16,
      destino: '2026-10',
      leyenda: '',
    });
    for (const k of [
      'motivo',
      'corte',
      'cobrado_despues_usd',
      'cobrado_despues_mxn',
      'fecha_cobro_despues',
    ]) {
      expect(viejo).not.toHaveProperty(k);
    }
    // Con motivo pero sin saber lo cobrado después (sombra de la bitácora):
    // solo motivo + corte.
    const sombra = itemCierreDeFila(fila(), 'N621TX', {
      venta_usd: 4931.16,
      cobrado_usd: 0,
      por_cobrar_usd: 4931.16,
      destino: '2026-10',
      leyenda: '',
      motivo: 'SIN_COBRO',
    });
    expect(sombra).toMatchObject({ motivo: 'SIN_COBRO', corte: '2026-09-30' });
    expect(sombra).not.toHaveProperty('cobrado_despues_usd');
  });

  it('pendiente del libro y resumen por matrícula (un multi-avión cuenta una vez por libro)', () => {
    const a = itemCierreDeFila(fila(), 'N621TX', {
      venta_usd: 4931.16,
      cobrado_usd: 0,
      por_cobrar_usd: 4931.16,
      destino: '2026-10',
      leyenda: 'x',
    });
    const b = { ...a, vuelo_id: 'v-343', folio: '343' };
    expect(pendienteVuelosQuePasan('Avión N621TX', [a, b])).toEqual([
      'Avión N621TX: 2 vuelo(s) pasan a octubre 2026 por cobro pendiente al cerrar el mes (#337, #343) — no suman en este mes',
    ]);
    expect(resumenCierrePorAvion([a, b, a])).toEqual([
      {
        matricula: 'N621TX',
        vuelos: 2,
        venta_mxn: 173995.98,
        por_cobrar_mxn: 173995.98,
      },
    ]);
  });

  it('general: concatena las listas de los libros; sin cierre (sin migración) ⇒ {}', () => {
    expect(cierreDelGeneral([{}, {}])).toEqual({});
    const base: BalanceCierrePayload = {
      disponible: true,
      periodo: '2026-09',
      estado: 'CERRADO',
      cerrado_at: null,
      cerrado_por_nombre: 'Ale',
      reabierto_at: null,
      reabierto_por_nombre: null,
      pasan: [],
      vienen: [],
      pasarian: [],
    };
    const item = itemCierreDeFila(fila(), 'N621TX', {
      venta_usd: 1,
      cobrado_usd: 0,
      por_cobrar_usd: 1,
      destino: '2026-10',
      leyenda: 'x',
    });
    const r = cierreDelGeneral([
      { cierre: base },
      { cierre: { ...base, pasan: [item] } },
    ]);
    expect(r.cierre?.pasan).toHaveLength(1);
    expect(r.resumen_cierre?.pasan[0].matricula).toBe('N621TX');
  });
});
