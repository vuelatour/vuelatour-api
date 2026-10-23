// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
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
// Sin la migración del cierre de mes (el eje de siempre).
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { Rol } from '../../common/types/auth.types';
import {
  AV,
  DESDE,
  HASTA,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';
import {
  ACC,
  AV2,
  HERNAN,
  MAU,
  TC_OFICIAL_PESOS,
  fakeSupabaseReparto,
  mundoPesos,
} from './reparto-pesos.fixture-spec';

/**
 * PANTALLA POR AVIÓN (20-oct-2026, invariante 99). Pedido del cliente: «una
 * pantalla por avión y no un card para ver más detalles para saber cuáles
 * son esos permisos, gastos indirectos y directos de lo que hablan en el
 * excel… y vengan los números de todo el histórico del avión y poder
 * filtrar por mes» y «que las cuentas de dispersión se lleve en un balance
 * en el detalle o pantalla del avión… el seguimiento de pagos por socios
 * pero solo de ese avión… todo en pesos».
 *
 *  - `avionDetalle`: el avión del compute + `detalle.gastos[]` gasto por
 *    gasto (los subtotales por grupo SON las filas de la cascada) + las
 *    entregas «corresponde a» ese avión en los meses del periodo + por socio
 *    lo generado / entregado / por entregar DE ESE AVIÓN, en pesos.
 *  - `avionHistorico`: la cascada en pesos mes a mes, totales, socios
 *    acumulados y entregas del rango.
 *  - SOCIO: solo su renglón y sus entregas. 404 / 400 con sus claves.
 */

const r2 = (x: number) => Math.round(x * 100) / 100;

function entregaBase(extra: Fila): Fila {
  return {
    id: 'p-x',
    aeronave_id: AV,
    socio_id: HERNAN,
    periodo: null,
    monto: 0,
    moneda: 'MXN',
    tc_usd_mxn: null,
    monto_usd: 0,
    monto_mxn: 0,
    utilidad_snapshot_usd: null,
    saldo_snapshot_usd: null,
    saldo_snapshot_mxn: null,
    fecha_pago: '2026-10-05',
    metodo: 'TRANSFERENCIA',
    referencia: null,
    entregado_por: ACC,
    recibido_por: null,
    factura_folio: null,
    comprobante_path: null,
    notas: null,
    client_request_id: null,
    created_by: ACC,
    created_at: '2026-10-05T15:00:00Z',
    updated_by: null,
    updated_at: '2026-10-05T15:00:00Z',
    deleted_at: null,
    deleted_by: null,
    motivo_baja: null,
    ...extra,
  };
}

/** El mundo del reparto en pesos con entregas a los socios del XB-TST. */
function mundoConEntregas(): Record<string, Fila[]> {
  return {
    ...mundoPesos(),
    reparto_pago: [
      // «Corresponde a» septiembre, en pesos: descuenta 1,000.
      entregaBase({
        id: 'p-sep-mxn',
        periodo: '2026-09-01',
        monto: 1000,
        monto_mxn: 1000,
        fecha_pago: '2026-10-05',
      }),
      // Sin «corresponde a»: se acredita al mes de su FECHA (septiembre); en
      // dólares, descuenta sus pesos (100 × 18.50 = 1,850).
      entregaBase({
        id: 'p-sep-usd',
        moneda: 'USD',
        monto: 100,
        monto_usd: 100,
        monto_mxn: 1850,
        fecha_pago: '2026-09-20',
        created_at: '2026-09-20T15:00:00Z',
      }),
      // Borrada: no cuenta.
      entregaBase({
        id: 'p-borrada',
        periodo: '2026-09-01',
        monto: 500,
        monto_mxn: 500,
        deleted_at: '2026-10-06T15:00:00Z',
        deleted_by: ACC,
      }),
      // De OTRO avión: no cuenta aquí.
      entregaBase({
        id: 'p-otro-avion',
        aeronave_id: AV2,
        socio_id: MAU,
        periodo: '2026-09-01',
        monto: 999,
        monto_mxn: 999,
      }),
      // De agosto: fuera del periodo del detalle; sí en el histórico.
      entregaBase({
        id: 'p-ago',
        periodo: '2026-08-01',
        monto: 700,
        monto_mxn: 700,
        fecha_pago: '2026-09-02',
        created_at: '2026-09-02T15:00:00Z',
      }),
    ],
  };
}

function servicio(m: Record<string, Fila[]>) {
  const f = fakeSupabaseReparto(m);
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        const tc = TC_OFICIAL_PESOS[dia];
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  svc.ahora = () => new Date('2026-10-19T15:00:00Z');
  return svc;
}

const ADMIN = { rol: Rol.ADMIN, userId: 'u-admin' };
const SOCIO_HERNAN = { rol: Rol.SOCIO, userId: HERNAN };

describe('ProfitSharingService.avionDetalle — la pantalla por avión', () => {
  it('trae el avión del compute con `detalle.gastos[]`: los subtotales por grupo SON las filas de la cascada (pesos y dólares) y los EXCLUIDOS dicen por qué', async () => {
    const svc = servicio(mundoConEntregas());
    const d = await svc.avionDetalle(AV, { desde: DESDE, hasta: HASTA }, ADMIN);
    expect(d.reparto_como_balance).toBe(true);
    expect(d.reparto_en_pesos).toBe(true);
    expect(d.periodo).toEqual({ desde: DESDE, hasta: HASTA });
    const a = d.avion;
    expect(a.aeronave.id).toBe(AV);
    // El compute de siempre NO trae las filas; aquí sí.
    const normal = await svc.compute({ desde: DESDE, hasta: HASTA });
    const mismo = normal.aviones.find((x) => x.aeronave.id === AV)!;
    expect('gastos' in mismo.detalle).toBe(false);
    const filas = a.detalle.gastos ?? [];
    expect(filas.length).toBeGreaterThan(0);
    // Mismo saldo que el compute (el detalle no mueve un centavo).
    expect(a.saldo_disponible_mxn).toBe(mismo.saldo_disponible_mxn);
    expect(a.saldo_disponible_usd).toBe(mismo.saldo_disponible_usd);
    const suma = (grupo: string, k: 'mxn' | 'usd') =>
      r2(
        filas
          .filter((f) => f.grupo === grupo)
          .reduce((acc, f) => acc + (f[k] ?? 0), 0),
      );
    expect(suma('DIRECTO', 'mxn')).toBe(a.gastos.directos_mxn);
    // COMBUSTIBLE aparte (23-oct-2026, invariante 104).
    expect(suma('COMBUSTIBLE', 'mxn')).toBe(a.gastos.combustible_mxn);
    expect(suma('INDIRECTO', 'mxn')).toBe(a.gastos.indirectos_mxn);
    expect(suma('PERMISO', 'mxn')).toBe(a.gastos.permisos_mxn);
    expect(suma('DIRECTO', 'usd')).toBe(a.gastos.directos_usd);
    expect(suma('COMBUSTIBLE', 'usd')).toBe(a.gastos.combustible_usd);
    expect(suma('INDIRECTO', 'usd')).toBe(a.gastos.indirectos_usd);
    expect(suma('PERMISO', 'usd')).toBe(a.gastos.permisos_usd);
    // Cada fila lleva lo que la pantalla pinta: etiqueta, clave, vuelo.
    const ref = filas.find((f) => f.id === 'g-ref-usd')!;
    expect(ref).toMatchObject({
      grupo: 'INDIRECTO',
      categoria: 'REFACCION',
      moneda: 'USD',
      monto: 100,
      usd: 100,
      tc: null,
      tc_oficial: true,
    });
    expect(typeof ref.etiqueta).toBe('string');
    const op = filas.find((f) => f.id === 'g-op-usd')!;
    expect(op.vuelo).toEqual({ id: 'v-1', folio: 501 });
    // Orden: por fecha y luego id (estable para la pantalla).
    const fechas = filas.map((f) => f.fecha ?? '9999-99-99');
    expect([...fechas].sort()).toEqual(fechas);
  });

  it('socios DE ESE AVIÓN en pesos: generado / reserva / entregado / por entregar; cuentan las entregas vivas «corresponde a» este avión en los meses del periodo (periodo ?? fecha), no las borradas ni las de otro avión', async () => {
    const svc = servicio(mundoConEntregas());
    const d = await svc.avionDetalle(AV, { desde: DESDE, hasta: HASTA }, ADMIN);
    const hernan = d.socios.find((s) => s.socio_id === HERNAN)!;
    const acc = d.socios.find((s) => s.socio_id === ACC)!;
    const repHernan = d.avion.reparto.find((s) => s.socio_id === HERNAN)!;
    // 1,000 (sep, MXN) + 1,850 (USD 100 del 20-sep) = 2,850; la borrada, la
    // de otro avión y la de agosto NO.
    expect(hernan.entregado_mxn).toBe(2850);
    expect(hernan.monto_mxn).toBe(repHernan.monto_mxn);
    expect(hernan.utilidad_mxn).toBe(repHernan.utilidad_mxn);
    expect(hernan.reserva_mxn).toBe(repHernan.reserva_mxn);
    expect(hernan.descuenta_reserva).toBe(false);
    expect(hernan.por_entregar_mxn).toBe(r2(repHernan.monto_mxn - 2850));
    expect(acc.entregado_mxn).toBe(0);
    expect(acc.por_entregar_mxn).toBe(acc.monto_mxn);
    // Las entregas del periodo, más reciente primero, en pesos.
    expect(d.entregas.map((p) => p.id)).toEqual(['p-sep-mxn', 'p-sep-usd']);
    expect(d.entregas[1]).toMatchObject({
      moneda: 'USD',
      monto: 100,
      monto_mxn: 1850,
      aeronave: { id: AV },
      entregado_por_nombre: 'Aero Charter Cancun S.A. de C.V.',
    });
  });

  it('SOCIO: solo su renglón y sus entregas; otro avión ⇒ 404 AERONAVE_NO_EXISTE', async () => {
    const svc = servicio(mundoConEntregas());
    const d = await svc.avionDetalle(
      AV,
      { desde: DESDE, hasta: HASTA },
      SOCIO_HERNAN,
    );
    expect(d.socios.map((s) => s.socio_id)).toEqual([HERNAN]);
    expect(d.entregas.every((p) => p.socio_id === HERNAN)).toBe(true);
    // El reparto completo del avión sigue visible (es el compute de siempre).
    expect(d.avion.reparto.length).toBe(2);
    await expect(
      svc.avionDetalle('av-nope', { desde: DESDE, hasta: HASTA }, ADMIN),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { error: 'AERONAVE_NO_EXISTE' },
    });
  });
});

describe('ProfitSharingService.avionHistorico — mes a mes, en pesos', () => {
  it('un renglón por mes con la cascada en pesos (el de septiembre = el compute de septiembre), el mes en curso marcado, totales y socios acumulados (generado − entregado)', async () => {
    const svc = servicio(mundoConEntregas());
    const h = await svc.avionHistorico(AV, '2026-08', '2026-10', ADMIN);
    expect(h.aeronave.id).toBe(AV);
    expect(h.mes_actual).toBe('2026-10');
    expect(h.reparto_como_balance).toBe(true);
    const meses = h.meses.map((m) => m.mes);
    expect(meses).toEqual(['2026-08', '2026-09', '2026-10']);
    const sep = h.meses.find((m) => m.mes === '2026-09')!;
    const oct = h.meses.find((m) => m.mes === '2026-10')!;
    const ago = h.meses.find((m) => m.mes === '2026-08')!;
    expect(sep.en_curso).toBe(false);
    expect(oct.en_curso).toBe(true);
    const r = await svc.compute({ desde: DESDE, hasta: HASTA });
    const a = r.aviones.find((x) => x.aeronave.id === AV)!;
    expect(sep).toMatchObject({
      cobrado_mxn: a.ingresos.cobrado_mxn,
      directos_mxn: a.gastos.directos_mxn,
      combustible_mxn: a.gastos.combustible_mxn,
      indirectos_mxn: a.gastos.indirectos_mxn,
      permisos_mxn: a.gastos.permisos_mxn,
      otros_mxn: a.gastos.otros_prorrateados_mxn,
      afac_mxn: a.afac_reservado_mxn,
      saldo_mxn: a.saldo_disponible_mxn,
      reserva_mxn: a.reserva_overhaul_mxn,
      saldo_usd: a.saldo_disponible_usd,
      horas_voladas_hr: a.horas_voladas_hr,
    });
    // Entregado por mes: agosto 700 («corresponde a» agosto aunque se pagó
    // el 2-sep), septiembre 2,850, octubre 0.
    expect(ago.entregado_mxn).toBe(700);
    expect(sep.entregado_mxn).toBe(2850);
    expect(oct.entregado_mxn).toBe(0);
    // Por socio y mes.
    const sepHernan = (
      sep.reparto as Array<{ socio_id: string; entregado_mxn: number }>
    ).find((s) => s.socio_id === HERNAN)!;
    expect(sepHernan.entregado_mxn).toBe(2850);
    // Totales = Σ de los meses.
    const sumaMeses = (k: string) =>
      r2(h.meses.reduce((acc, m) => acc + ((m[k] as number) ?? 0), 0));
    for (const k of ['saldo_mxn', 'cobrado_mxn', 'entregado_mxn', 'afac_mxn'])
      expect(h.totales[k]).toBe(sumaMeses(k));
    expect(h.totales.entregado_mxn).toBe(3550);
    // Socios acumulados: generado − entregado.
    const hernan = h.socios.find((s) => s.socio_id === HERNAN)!;
    const generado = r2(
      h.meses.reduce(
        (acc, m) =>
          acc +
          ((m.reparto as Array<{ socio_id: string; monto_mxn: number }>).find(
            (s) => s.socio_id === HERNAN,
          )?.monto_mxn ?? 0),
        0,
      ),
    );
    expect(hernan.generado_mxn).toBe(generado);
    expect(hernan.entregado_mxn).toBe(3550);
    expect(hernan.por_entregar_mxn).toBe(r2(generado - 3550));
    // Entregas del rango (vivas, de este avión), más reciente primero.
    expect(h.entregas.map((p) => p.id)).toEqual([
      'p-sep-mxn',
      'p-sep-usd',
      'p-ago',
    ]);
  });

  it('defaults: sin inicio oficial configurado arranca en el mes en curso; rango invertido o > 36 meses ⇒ 400 RANGO_INVALIDO; SOCIO solo lo suyo', async () => {
    const svc = servicio(mundoConEntregas());
    const h = await svc.avionHistoricoDefault(AV, {}, ADMIN);
    expect(h.desde).toBe('2026-10');
    expect(h.hasta).toBe('2026-10');
    expect(h.meses.map((m) => m.mes)).toEqual(['2026-10']);
    await expect(
      svc.avionHistorico(AV, '2026-10', '2026-09', ADMIN),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { error: 'RANGO_INVALIDO' },
    });
    await expect(
      svc.avionHistorico(AV, '2020-01', '2026-10', ADMIN),
    ).rejects.toMatchObject({ response: { error: 'RANGO_INVALIDO' } });
    const s = await svc.avionHistorico(AV, '2026-09', '2026-09', SOCIO_HERNAN);
    expect(s.socios.map((x) => x.socio_id)).toEqual([HERNAN]);
    expect(s.entregas.every((p) => p.socio_id === HERNAN)).toBe(true);
    expect(
      (s.meses[0].reparto as Array<{ socio_id: string }>).map(
        (x) => x.socio_id,
      ),
    ).toEqual([HERNAN]);
  });
});
