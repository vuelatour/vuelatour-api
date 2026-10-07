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
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));

import { ProfitSharingService } from './profit-sharing.service';
import { AircraftBalanceService } from '../aircraft/aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  HASTA,
  V1,
  fakeSupabase,
  mundoCon,
  mundoLibros,
  vuelo2,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

/**
 * REPARTO A SOCIOS — COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65).
 * `compute()` (y con él las utilidades por mes de la cuenta corriente)
 * descuenta por vuelo, desde `comisiones_al_avion_desde`, las MISMAS
 * comisiones que el balance por avión — fuente única `comisionesDelVuelo`,
 * aquí en USD — en `comisiones_venta_usd`, el campo que el PDF/XLSX y el
 * panel ya restan en la cascada del saldo.
 *
 * Mundo de los libros: #501 COMPLETADO de XB-TST (10-sep, K 20), 2,230 USD
 * = 2,000 de tiempo + 100 TUAS + 50 extras + 80 de comisión del vendedor;
 * cobrado 2,000 USD (20,000 MXN con 350 de comisión bancaria + 1,000 USD).
 *  - venta del avión cobrada = round2(2,000 × 2,000/2,230) = 1,793.72;
 *  - banco: 350 ÷ 20 = 17.50 USD × 2,000/2,230 = 15.70; vendedor: 80;
 *  - saldo = 1,793.72 − 95.70 = 1,698.02 (el GAS sin T.C. no convierte).
 */

const AV2 = 'av-2';
const V3 = 'v-3';
const MAU = 'u-mau';
const ACC = 'u-acc';
const POSTERIOR = '2026-12-01';
const r2 = (x: number) => Math.round(x * 100) / 100;

type Avion = Awaited<
  ReturnType<ProfitSharingService['compute']>
>['aviones'][number];

/** El mundo de los libros con lo que lee el reparto (avión activo y socios). */
function mundoReparto(extra: Partial<Record<string, Fila[]>> = {}) {
  const m = mundoLibros();
  const base: Record<string, Fila[]> = {
    ...m,
    aeronave: m.aeronave.map((a) => ({ ...a, activa: true })),
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: MAU,
        porcentaje: '71.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        aeronave_id: AV,
        socio_id: ACC,
        porcentaje: '29.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ],
    usuario: [
      { id: MAU, nombre: 'Mauricio Roque' },
      { id: ACC, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ],
    reserva_overhaul: [],
  };
  return { ...base, ...extra } as Record<string, Fila[]>;
}

function armar(mundo: Record<string, Fila[]>, vigencia?: string) {
  const f = fakeSupabase(mundo);
  const selectsCobro: string[] = [];
  const from = (tabla: string) => {
    const q = f.supabase.service.from(tabla);
    if (tabla === 'cobro_vuelo') {
      const original = q.select as (cols?: string) => unknown;
      q.select = (cols?: string) => {
        selectsCobro.push(cols ?? '');
        return original(cols);
      };
    }
    return q;
  };
  const lecturas: Array<[string, string]> = [];
  const config = {
    fecha: (clave: string, porDefecto: string) => {
      lecturas.push([clave, porDefecto]);
      return Promise.resolve(vigencia ?? porDefecto);
    },
  };
  const nada = {} as never;
  const svc = new ProfitSharingService(
    { service: { from } } as unknown as SupabaseService,
    nada,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    nada,
    config as never,
  );
  return { svc, selectsCobro, lecturas };
}

async function avion(
  mundo: Record<string, Fila[]>,
  vigencia?: string,
  id: string = AV,
): Promise<Avion> {
  const { svc } = armar(mundo, vigencia);
  const r = await svc.compute({ desde: DESDE, hasta: HASTA });
  const a = r.aviones.find((x) => x.aeronave.id === id);
  if (!a) throw new Error(`sin avión ${id}`);
  return a;
}

/** Rutas (a.b.0.c) donde dos resultados difieren. */
function diferencias(a: unknown, b: unknown, ruta = ''): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...claves].flatMap((k) =>
      diferencias(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        ruta ? `${ruta}.${k}` : k,
      ),
    );
  }
  return [ruta];
}

describe('Reparto a socios — COMISIONES a cargo del avión (API 0.0.65)', () => {
  it('descuenta la parte del avión de la comisión bancaria + la provisión del vendedor (USD) en `comisiones_venta_usd` y en el saldo', async () => {
    const a = await avion(mundoReparto());
    expect(a.ingresos.cobrado_usd).toBe(1793.72);
    expect(a.ingresos.comisiones_venta_usd).toBe(95.7);
    expect(a.saldo_disponible_usd).toBe(1698.02);
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect(v.comisiones_avion_usd).toBe(95.7);
    expect(v.comision_banco_avion_usd).toBe(15.7);
    expect(v.comision_vendedor_prov_usd).toBe(80);
    // La regla A sigue: la columna vieja del detalle no se usa.
    expect(v.comision_vendedor_usd).toBe(0);
    // Reparto por residuo mayor sobre el saldo después de comisiones.
    expect(a.reparto.map((r) => [r.socio_id, r.monto_usd])).toEqual([
      [MAU, 1205.59],
      [ACC, 492.43],
    ]);
  });

  it('ANTES de la vigencia: el reparto de siempre (solo cambian comisiones, saldo, montos de los socios y las llaves nuevas del detalle)', async () => {
    const { svc: antes } = armar(mundoReparto(), POSTERIOR);
    const { svc: con } = armar(mundoReparto());
    const rAntes = await antes.compute({ desde: DESDE, hasta: HASTA });
    const rCon = await con.compute({ desde: DESDE, hasta: HASTA });
    const a = rAntes.aviones[0];
    expect(a.ingresos.comisiones_venta_usd).toBe(0);
    expect(a.saldo_disponible_usd).toBe(1793.72);
    expect('comisiones_avion_usd' in a.detalle.vuelos[0]).toBe(false);
    expect(diferencias(rAntes, rCon).sort()).toEqual(
      [
        'aviones.0.detalle.vuelos.0.comision_banco_avion_usd',
        'aviones.0.detalle.vuelos.0.comision_vendedor_prov_usd',
        'aviones.0.detalle.vuelos.0.comisiones_avion_usd',
        'aviones.0.ingresos.comisiones_venta_usd',
        'aviones.0.reparto.0.monto_usd',
        'aviones.0.reparto.1.monto_usd',
        'aviones.0.saldo_disponible_usd',
      ].sort(),
    );
  });

  it('lee la vigencia de `comisiones_al_avion_desde` UNA vez y trae la comisión de cada cobro', async () => {
    const { svc, lecturas, selectsCobro } = armar(mundoReparto());
    await svc.compute({ desde: DESDE, hasta: HASTA });
    expect(lecturas).toEqual([['comisiones_al_avion_desde', '2026-09-01']]);
    expect(selectsCobro).toHaveLength(1);
    for (const col of [
      'comision_banco_monto',
      'comision_banco_pct',
      'metodo_cobro',
    ]) {
      expect(selectsCobro[0]).toContain(col);
    }
  });

  it('CANCELADO con dinero retenido: el avión absorbe la comisión bancaria COMPLETA y no hay provisión del vendedor', async () => {
    const a = await avion(
      mundoReparto({
        vuelo: mundoCon({ v1: { estado: 'CANCELADO' } }).vuelo,
      }),
    );
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    expect(v.comision_banco_avion_usd).toBe(17.5);
    expect(v.comision_vendedor_prov_usd).toBe(0);
    expect(a.ingresos.comisiones_venta_usd).toBe(17.5);
    // Lo retenido (2,000 USD) es 100 % del avión.
    expect(a.saldo_disponible_usd).toBe(r2(2000 - 17.5));
  });

  it('MULTI-AVIÓN: cada avión descuenta SU parte (repartirUsd) y Σ de los dos == comisión × factor + provisión', async () => {
    const m = mundoReparto();
    const f3 = '2026-09-15T15:00:00+00:00';
    const mundo = mundoReparto({
      aeronave: [
        ...m.aeronave,
        {
          ...m.aeronave[0],
          id: AV2,
          matricula: 'XB-DOS',
          activa: true,
        },
      ],
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
          monto_total_usd: 2100,
          monto_total_mxn: 37800,
        }),
      ],
      escala: [
        ...m.escala,
        {
          id: 'e-3a',
          vuelo_id: V3,
          orden: 1,
          aeronave_id: null,
          cancelada_at: null,
          taco_salida: null,
          taco_llegada: null,
          solo_operativa: false,
          es_ferry: false,
          origen_iata: 'CUN',
          destino_iata: 'MID',
        },
        {
          id: 'e-3b',
          vuelo_id: V3,
          orden: 2,
          aeronave_id: AV2,
          cancelada_at: null,
          taco_salida: null,
          taco_llegada: null,
          solo_operativa: false,
          es_ferry: false,
          origen_iata: 'MID',
          destino_iata: 'CUN',
        },
      ],
      cobro_vuelo: [
        ...m.cobro_vuelo,
        {
          id: 'c-4',
          vuelo_id: V3,
          monto: 37800,
          moneda: 'MXN',
          tc_usd_mxn: 18,
          fecha_cobro: '2026-09-15T20:00:00+00:00',
          comision_banco_monto: 630.01,
        },
      ],
    });
    const tst = (await avion(mundo, undefined, AV)).detalle.vuelos.find(
      (x) => x.id === V3,
    )!;
    const dos = (await avion(mundo, undefined, AV2)).detalle.vuelos.find(
      (x) => x.id === V3,
    )!;
    // 630.01 ÷ 18 = 35.00 USD × 2,000/2,100 = 33.33 ⇒ 16.67 (principal) +
    // 16.66; provisión 100 USD ⇒ 50 + 50.
    expect([
      tst.comision_banco_avion_usd,
      dos.comision_banco_avion_usd,
    ]).toEqual([16.67, 16.66]);
    expect([
      tst.comision_vendedor_prov_usd,
      dos.comision_vendedor_prov_usd,
    ]).toEqual([50, 50]);
    expect(
      r2((tst.comisiones_avion_usd ?? 0) + (dos.comisiones_avion_usd ?? 0)),
    ).toBe(133.33);
  });

  it('utilidades por mes (cuenta corriente): los socios reciben su parte del saldo DESPUÉS de comisiones', async () => {
    const { svc } = armar(mundoReparto());
    const [sep] = await svc.utilidadesSociosPorMes(['2026-09'], '2026-10');
    const socios = sep.aviones.find((x) => x.aeronave.id === AV)!.socios;
    expect(socios.map((s) => [s.socio_id, s.monto_usd])).toEqual([
      [MAU, 1205.59],
      [ACC, 492.43],
    ]);
  });
});

describe('Reparto ↔ balance por avión: las MISMAS comisiones (fuente única)', () => {
  it('la provisión del vendedor del reparto × K == la del balance y la bancaria cuadra al centavo con su conversión', async () => {
    const mundo = mundoReparto();
    const a = await avion(mundo);
    const v = a.detalle.vuelos.find((x) => x.id === V1)!;
    const enviados: { individual?: BalanceAvionPayload } = {};
    const balance = new AircraftBalanceService(
      fakeSupabase(mundo).supabase as unknown as SupabaseService,
      {
        generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
          enviados.individual = p;
          return Promise.resolve(Buffer.from('xlsx'));
        },
      } as never,
      { proximoServicio: () => null } as never,
      { oficialDetallePara: () => Promise.resolve(null) } as never,
      {} as never,
    );
    await balance.xlsx(AV, DESDE, HASTA);
    const fila = enviados.individual!.vuelos.find((x) => x.vuelo_id === V1)!;
    const k = fila.tc_venta!;
    expect(r2((v.comision_vendedor_prov_usd ?? 0) * k)).toBe(
      fila.comision_vendedor_prov_mxn,
    );
    expect(
      Math.abs(
        (v.comision_banco_avion_usd ?? 0) -
          (fila.comision_banco_avion_mxn ?? 0) / k,
      ),
    ).toBeLessThan(0.01);
  });
});
