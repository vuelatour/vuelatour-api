// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) => f ?? 'TC oficial',
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  assertCobroEnMesAbierto,
  assertMesAbierto,
} from '../../common/cierre-mes.lector';
import { CierresService } from './cierres.service';
import type { CerrarMesDto, ReabrirMesDto } from './dto/cierres.dto';
import {
  fakeCierre,
  type Escritura,
  type FakeOpts,
  type Fila,
} from '../../common/cierre-mes.fixture-spec';

/**
 * CIERRE DE MES POR AVIÓN (23-oct-2026, API 0.0.104, invariante 105).
 * Mundo SINTÉTICO de septiembre 2026 (K 20) con el `compute` REAL:
 *  - XB-AAA (AV1) y XB-BBB (AV2) activos; XB-CCC inactivo (no cuenta).
 *  - #1 AV1, 1,000 cobrado el 20-sep ⇒ se queda.
 *  - #2 AV1, 1,000 cobrado el 2-oct ⇒ PASA (COBRO_POSTERIOR).
 *  - #3 AV2, 1,000 sin cobro ⇒ PASA (SIN_COBRO).
 *  - #4 MULTI-AVIÓN (principal AV1, tramos AV1 + AV2), 2,000 cobrado el
 *    5-oct ⇒ PASA (COBRO_POSTERIOR): el PRIMER avión que cierra decide.
 *  - #5 AV2, 500 cobrado el 10-sep ⇒ se queda.
 *  - #6 AV2 EN_VUELO (sin completar): solo para el bloqueante atribuible.
 * Hoy = 16-oct-2026 (octubre en curso).
 */

const AV1 = 'av-1';
const AV2 = 'av-2';
const AV3 = 'av-3';
const ALE = 'u-ale';
const ids = {
  v1: 'v-1',
  v2: 'v-2',
  v3: 'v-3',
  v4: 'v-4',
  v5: 'v-5',
  v6: 'v-6',
};
const PERIODO_OCT = '2026-10-01T00:00:00-05:00';
const SEP = { desde: '2026-09-01', hasta: '2026-09-30' };

function vuelo(
  id: string,
  folio: number,
  monto: number,
  aeronaveId: string,
  extra: Fila = {},
): Fila {
  return {
    id,
    folio,
    cliente_id: 'cli-1',
    aeronave_id: aeronaveId,
    estado: 'COMPLETADO',
    es_externo: false,
    costo_externo_usd: null,
    fecha_vuelo: `2026-09-${String(folio + 9).padStart(2, '0')}T15:00:00Z`,
    fecha_solicitud: null,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    subtotal_vuelo_usd: monto,
    ajuste_final_usd: 0,
    iva_usd: 0,
    iva_pct: 0,
    tuas_usd: 0,
    extras_total_usd: 0,
    viaticos_pernocta_usd: 0,
    comision_vendedor_usd: 0,
    monto_total_usd: monto,
    tc_usd_mxn: 20,
    cobrado: false,
    calculo_snapshot: null,
    periodo_contable: null,
    ...extra,
  };
}

const cobro = (
  id: string,
  vueloId: string,
  monto: number,
  fecha: string,
): Fila => ({
  id,
  vuelo_id: vueloId,
  monto,
  moneda: 'USD',
  tc_usd_mxn: null,
  fecha_cobro: fecha,
  metodo_cobro: 'TRANSFERENCIA',
  comision_banco_monto: null,
  comision_banco_pct: null,
  cobro_grupo_id: null,
});

const escala = (
  id: string,
  vueloId: string,
  orden: number,
  aeronaveId: string,
): Fila => ({
  id,
  vuelo_id: vueloId,
  orden,
  aeronave_id: aeronaveId,
  cancelada_at: null,
  solo_operativa: false,
  es_ferry: false,
  taco_salida: null,
  taco_llegada: null,
  origen_iata: orden === 1 ? 'CUN' : 'MID',
  destino_iata: orden === 1 ? 'MID' : 'CUN',
});

function mundo(): Record<string, Fila[]> {
  return {
    aeronave: [
      { id: AV1, matricula: 'XB-AAA', modelo: 'C206', activa: true },
      { id: AV2, matricula: 'XB-BBB', modelo: 'Kodiak', activa: true },
      { id: AV3, matricula: 'XB-CCC', modelo: 'C206', activa: false },
    ],
    cliente: [{ id: 'cli-1', nombre: 'Cliente Uno', es_interno: false }],
    usuario: [{ id: ALE, nombre: 'Ale Martínez' }],
    vuelo: [
      vuelo(ids.v1, 1, 1000, AV1),
      vuelo(ids.v2, 2, 1000, AV1),
      vuelo(ids.v3, 3, 1000, AV2),
      vuelo(ids.v4, 4, 2000, AV1),
      vuelo(ids.v5, 5, 500, AV2),
      vuelo(ids.v6, 6, 1000, AV2, { estado: 'EN_VUELO' }),
    ],
    escala: [escala('e-4a', ids.v4, 1, AV1), escala('e-4b', ids.v4, 2, AV2)],
    cobro_vuelo: [
      cobro('c-1', ids.v1, 1000, '2026-09-20T16:00:00Z'),
      cobro('c-2', ids.v2, 1000, '2026-10-02T16:00:00Z'),
      cobro('c-4', ids.v4, 2000, '2026-10-05T16:00:00Z'),
      cobro('c-5', ids.v5, 500, '2026-09-10T16:00:00Z'),
    ],
    gasto: [],
    gasto_reparto: [],
    aeronave_socio: [
      {
        aeronave_id: AV1,
        socio_id: 's-1',
        porcentaje: 100,
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        aeronave_id: AV2,
        socio_id: 's-2',
        porcentaje: 100,
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ],
    reserva_overhaul: [],
    cierre_mes: [],
    cierre_mes_vuelo: [],
    cierre_mes_avion: [],
    cierre_mes_avion_vuelo: [],
  };
}

const actor = (rol: Rol = Rol.ADMIN): AuthenticatedUser =>
  ({ userId: ALE, nombre: 'Ale Martínez', rol }) as AuthenticatedUser;

// `cerrar` / `reabrir` devuelven la forma del 0.0.103 sin la migración por
// avión y la del 0.0.104 con ella: estos specs viven en la segunda.
type RespCerrar = Extract<
  Awaited<ReturnType<CierresService['cerrar']>>,
  { cierres: unknown }
>;
type RespReabrir = Extract<
  Awaited<ReturnType<CierresService['reabrir']>>,
  { cierres: unknown }
>;
const cerrarA = (
  svc: CierresService,
  periodo: string,
  dto: CerrarMesDto,
  quien: AuthenticatedUser,
) => svc.cerrar(periodo, dto, quien) as Promise<RespCerrar>;
const reabrirA = (
  svc: CierresService,
  periodo: string,
  dto: ReabrirMesDto,
  quien: AuthenticatedUser,
) => svc.reabrir(periodo, dto, quien) as Promise<RespReabrir>;

type ItemPre = Record<string, unknown>;

function armar(
  tablas: Record<string, Fila[]> = mundo(),
  opts: {
    sinPorAvion?: boolean;
    listo?: boolean;
    items?: ItemPre[];
    hoy?: string;
    fallarEscritura?: FakeOpts['fallarEscritura'];
  } = {},
) {
  if (opts.sinPorAvion) {
    delete tablas.cierre_mes_avion;
    delete tablas.cierre_mes_avion_vuelo;
  }
  const f = fakeCierre(tablas, { fallarEscritura: opts.fallarEscritura });
  const ps = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
    { fecha: (_c: string, d: string) => Promise.resolve(d) } as never,
  );
  const pre = jest.spyOn(ps, 'preCierre').mockResolvedValue({
    periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
    listo: opts.listo ?? true,
    items: opts.items ?? [],
  } as never);
  const avisos: Array<{ rol: Rol; titulo: string; cuerpo?: string | null }> =
    [];
  const notifications = {
    notifyRole: (rol: Rol, n: { titulo: string; cuerpo?: string | null }) => {
      avisos.push({ rol, titulo: n.titulo, cuerpo: n.cuerpo });
      return Promise.resolve(1);
    },
  } as unknown as NotificationsService;
  const svc = new CierresService(
    f.supabase as unknown as SupabaseService,
    ps,
    notifications,
    undefined,
  );
  svc.ahora = () => new Date(`${opts.hoy ?? '2026-10-16'}T17:00:00Z`);
  const sb = f.service as unknown as SupabaseClient;
  return { svc, ps, f, avisos, sb, pre };
}

async function atrapa(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const ex = e as { getStatus: () => number; getResponse: () => unknown };
    return {
      status: ex.getStatus(),
      body: ex.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('esperaba un error');
}

const detalles = (b: Record<string, unknown>) =>
  b.details as Record<string, unknown>;

const porId = (f: ReturnType<typeof fakeCierre>) =>
  new Map(f.tablas.vuelo.map((v) => [v.id, v]));

describe('GET /v1/cierres — por avión', () => {
  it('lista cada avión activo (el inactivo sin fila no) con su estado, puede_cerrar y motivo; «N de M» y la flota', async () => {
    const { svc } = armar();
    const r = await svc.estado();
    expect(r.por_avion).toBe(true);
    const sep = r.meses[0];
    expect(sep).toMatchObject({
      periodo: '2026-09',
      estado: 'ABIERTO',
      puede_cerrar: true,
      motivo_no_cerrable: null,
      aviones_activos: 2,
      aviones_cerrados: 0,
      version: 0,
    });
    expect(
      sep.aviones?.map((a) => [
        a.matricula,
        a.modelo,
        a.activa,
        a.estado,
        a.puede_cerrar,
        a.motivo_no_cerrable,
        a.version,
      ]),
    ).toEqual([
      ['XB-AAA', 'C206', true, 'ABIERTO', true, null, 0],
      ['XB-BBB', 'Kodiak', true, 'ABIERTO', true, null, 0],
    ]);
    const oct = r.meses[1];
    expect(oct.estado).toBe('ABIERTO');
    expect(oct.motivo_no_cerrable).toBe('MES_EN_CURSO');
    expect(oct.aviones?.map((a) => a.motivo_no_cerrable)).toEqual([
      'MES_EN_CURSO',
      'MES_EN_CURSO',
    ]);
    expect(r.siguiente_a_cerrar).toBe('2026-09');
  });

  it('SIN la migración por avión: por_avion:false, sin `aviones`, la previa de siempre y aeronave_id ⇒ 503 CIERRE_POR_AVION_NO_DISPONIBLE', async () => {
    const { svc } = armar(mundo(), { sinPorAvion: true });
    const r = await svc.estado();
    expect(r.por_avion).toBe(false);
    expect(r.meses[0]).not.toHaveProperty('aviones');
    expect(r.meses[0]).not.toHaveProperty('aviones_activos');
    const p = await svc.previa('2026-09');
    expect(p).not.toHaveProperty('aeronave');
    expect(p).not.toHaveProperty('aviones_alcance');
    expect(p.vuelos_que_pasan[0]).not.toHaveProperty('multi_avion');
    const e = await atrapa(
      cerrarA(svc, '2026-09', { confirmar: true, aeronave_id: AV1 }, actor()),
    );
    expect(e.status).toBe(503);
    expect(e.body.error).toBe('CIERRE_POR_AVION_NO_DISPONIBLE');
    const e2 = await atrapa(
      reabrirA(
        svc,
        '2026-09',
        { confirmar: true, motivo: 'prueba de reapertura', aeronave_id: AV1 },
        actor(),
      ),
    );
    expect(e2.body.error).toBe('CIERRE_POR_AVION_NO_DISPONIBLE');
  });
});

describe('GET /v1/cierres/:periodo/previa — por avión', () => {
  it('?aeronave_id=AV1: solo sus vuelos (#2 y el compartido #4 con multi_avion/otros_aviones), su reparto y sus totales', async () => {
    const { svc } = armar();
    const p = await svc.previa('2026-09', { aeronaveId: AV1 });
    expect(p.aeronave).toEqual({
      id: AV1,
      matricula: 'XB-AAA',
      modelo: 'C206',
    });
    expect(p.aviones_alcance).toEqual([
      { aeronave_id: AV1, matricula: 'XB-AAA' },
    ]);
    expect(p.estado).toBe('ABIERTO');
    expect(p.listo).toBe(true);
    expect(p.motivo_no_cerrable).toBeNull();
    expect(p.bloqueantes_otros_aviones).toEqual([]);
    expect(
      p.vuelos_que_pasan.map((v) => [v.id, v.motivo, v.multi_avion]),
    ).toEqual([
      [ids.v2, 'COBRO_POSTERIOR', false],
      [ids.v4, 'COBRO_POSTERIOR', true],
    ]);
    expect(p.vuelos_que_pasan[0].otros_aviones).toEqual([]);
    expect(p.vuelos_que_pasan[1].otros_aviones).toEqual([
      { aeronave_id: AV2, matricula: 'XB-BBB', estado: 'ABIERTO' },
    ]);
    expect(p.totales).toMatchObject({
      vuelos: 3,
      completados: 3,
      cancelados: 0,
      pasan: 2,
      pasan_venta_usd: 3000,
      incluidos: 0,
    });
    expect(p.reparto?.antes.map((a) => a.matricula)).toEqual(['XB-AAA']);
    expect(p.reparto?.antes[0].cobrado_usd).toBe(3000);
    expect(p.reparto?.despues[0].cobrado_usd).toBe(1000);
  });

  it('sin aeronave_id: toda la flota abierta (los 3 que pasan, los dos aviones en el reparto)', async () => {
    const { svc } = armar();
    const p = await svc.previa('2026-09');
    expect(p.aeronave).toBeNull();
    expect(p.aviones_alcance?.map((a) => a.matricula)).toEqual([
      'XB-AAA',
      'XB-BBB',
    ]);
    expect(p.vuelos_que_pasan.map((v) => v.id)).toEqual([
      ids.v2,
      ids.v3,
      ids.v4,
    ]);
    expect(p.totales.vuelos).toBe(5);
    expect(p.reparto?.antes.map((a) => a.matricula)).toEqual([
      'XB-AAA',
      'XB-BBB',
    ]);
  });

  it('avión inválido ⇒ 404 AERONAVE_NO_EXISTE', async () => {
    const { svc } = armar();
    const e = await atrapa(svc.previa('2026-09', { aeronaveId: 'av-x' }));
    expect(e.status).toBe(404);
    expect(e.body.error).toBe('AERONAVE_NO_EXISTE');
  });
});

describe('POST /v1/cierres/:periodo con aeronave_id — cerrar UN avión', () => {
  it('cierra XB-AAA: snapshot y bitácora PROPIAS, candado solo de ese avión, XB-BBB sigue abierto; cerrar el último crea la fila global; reabrir con la flota cerrada ⇒ global REABIERTO', async () => {
    const { svc, f, ps, avisos, sb } = armar();
    const r = await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV1, vuelos_esperados: [ids.v2, ids.v4] },
      actor(),
    );
    expect(r.aeronave).toEqual({ id: AV1, matricula: 'XB-AAA' });
    expect(r.cierres).toHaveLength(1);
    expect(r.cierres[0]).toMatchObject({
      aeronave_id: AV1,
      matricula: 'XB-AAA',
      estado: 'CERRADO',
      version: 1,
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
      totales: { vuelos: 3, vuelos_diferidos: 2, vuelos_incluidos: 0 },
    });
    expect(r.mes).toMatchObject({
      periodo: '2026-09',
      estado: 'PARCIAL',
      aviones_activos: 2,
      aviones_cerrados: 1,
    });
    expect(r.cierre).toMatchObject({ periodo: '2026-09', estado: 'PARCIAL' });
    expect(r.diferidos.map((d) => d.id)).toEqual([ids.v2, ids.v4]);
    // La fila GLOBAL no se escribe en un cierre parcial.
    expect(f.tablas.cierre_mes).toHaveLength(0);
    expect(f.tablas.cierre_mes_avion).toHaveLength(1);
    const fila = f.tablas.cierre_mes_avion[0];
    expect(fila).toMatchObject({
      periodo: '2026-09-01',
      aeronave_id: AV1,
      estado: 'CERRADO',
      version: 1,
      cerrado_por: ALE,
    });
    expect(
      (fila.reparto_snapshot as { aeronave: { id: string } }).aeronave.id,
    ).toBe(AV1);
    expect(
      (
        fila.socios_snapshot as { socios: Array<{ socio_id: string }> }
      ).socios.map((s) => s.socio_id),
    ).toEqual(['s-1']);
    expect(
      f.tablas.cierre_mes_avion_vuelo.map((b) => [
        b.vuelo_id,
        b.aeronave_id,
        b.vuelo_aeronave_id,
        b.motivo,
        b.cierre_version,
      ]),
    ).toEqual([
      [ids.v2, AV1, AV1, 'COBRO_POSTERIOR', 1],
      [ids.v4, AV1, AV1, 'COBRO_POSTERIOR', 1],
    ]);
    const v = porId(f);
    expect(v.get(ids.v2)?.periodo_contable).toBe(PERIODO_OCT);
    expect(v.get(ids.v4)?.periodo_contable).toBe(PERIODO_OCT);
    expect(v.get(ids.v3)?.periodo_contable).toBeNull();
    expect(avisos).toEqual([
      expect.objectContaining({
        rol: Rol.ADMIN,
        titulo: 'XB-AAA · Septiembre 2026 cerrado',
      }),
    ]);
    // CANDADO: solo XB-AAA; la flota (registros sin avión) sigue abierta.
    const e = await atrapa(assertMesAbierto(sb, '2026-09', 'gasto', [AV1]));
    expect(e.body.error).toBe('MES_CERRADO');
    expect(detalles(e.body).aeronave).toEqual({ id: AV1, matricula: 'XB-AAA' });
    expect(String(e.body.message)).toMatch(
      /^XB-AAA · Septiembre 2026 ya está cerrado/,
    );
    await expect(
      assertMesAbierto(sb, '2026-09', 'gasto', [AV2]),
    ).resolves.toBeUndefined();
    await expect(
      assertMesAbierto(sb, '2026-09', 'caja_chica'),
    ).resolves.toBeUndefined();
    await expect(assertCobroEnMesAbierto(sb, ids.v5)).resolves.toBeUndefined();
    expect((await atrapa(assertCobroEnMesAbierto(sb, ids.v1))).body.error).toBe(
      'MES_CERRADO',
    );
    // El reparto EN VIVO: PARCIAL, cierre_avion por avión, coincide.
    const vivo = await ps.compute(SEP);
    expect(vivo.cierre).toMatchObject({
      estado: 'PARCIAL',
      aviones_activos: 2,
      aviones_cerrados: ['XB-AAA'],
      coincide_con_snapshot: true,
    });
    const a1 = vivo.aviones.find((a) => a.aeronave.id === AV1);
    const a2 = vivo.aviones.find((a) => a.aeronave.id === AV2);
    expect(a1?.cierre_avion).toMatchObject({
      estado: 'CERRADO',
      version: 1,
      cerrado_por_nombre: 'Ale Martínez',
      reabierto_at: null,
      reabierto_por_nombre: null,
      coincide_con_snapshot: true,
    });
    expect(a2?.cierre_avion).toMatchObject({
      estado: 'ABIERTO',
      version: null,
      coincide_con_snapshot: null,
    });
    expect(a1?.ingresos.cobrado_usd).toBe(1000);
    expect(vivo.cierre?.diferidos_salen.map((d) => d.id)).toEqual([
      ids.v2,
      ids.v4,
    ]);
    expect(vivo.cierre?.pendientes_que_pasarian.map((d) => d.id)).toEqual([
      ids.v3,
    ]);
    // La cuenta de los socios MEZCLA: XB-AAA del snapshot, XB-BBB en vivo.
    const [u] = await ps.utilidadesSociosPorMes(['2026-09'], '2026-10');
    expect(u.origen).toBe('EN_VIVO');
    expect(u.aviones.map((a) => [a.aeronave.matricula, a.origen])).toEqual([
      ['XB-AAA', 'SNAPSHOT_CIERRE'],
      ['XB-BBB', 'EN_VIVO'],
    ]);
    // Estado del mes: PARCIAL, XB-AAA YA_CERRADO, XB-BBB todavía puede.
    const est = await svc.estado();
    expect(est.meses[0]).toMatchObject({
      estado: 'PARCIAL',
      aviones_cerrados: 1,
      puede_cerrar: true,
    });
    expect(
      est.meses[0].aviones?.map((a) => [a.estado, a.motivo_no_cerrable]),
    ).toEqual([
      ['CERRADO', 'YA_CERRADO'],
      ['ABIERTO', null],
    ]);
    // Volver a cerrar XB-AAA ⇒ YA_CERRADO con el avión.
    const ya = await atrapa(
      cerrarA(svc, '2026-09', { confirmar: true, aeronave_id: AV1 }, actor()),
    );
    expect(ya.body.error).toBe('YA_CERRADO');
    expect(detalles(ya.body).aeronave).toEqual({
      id: AV1,
      matricula: 'XB-AAA',
    });

    // Previa de XB-BBB: #4 ya pasó (lo decidió XB-AAA) ⇒ solo #3.
    const p2 = await svc.previa('2026-09', { aeronaveId: AV2 });
    expect(p2.vuelos_que_pasan.map((d) => d.id)).toEqual([ids.v3]);
    expect(p2.vuelos_incluidos).toEqual([]);
    expect(p2.totales.vuelos).toBe(2);

    // Cerrar XB-BBB (el último activo) ⇒ fila global DERIVADA CERRADO.
    const r2 = await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV2, vuelos_esperados: [ids.v3] },
      actor(),
    );
    expect(r2.mes).toMatchObject({ estado: 'CERRADO', aviones_cerrados: 2 });
    expect(f.tablas.cierre_mes).toHaveLength(1);
    const global = f.tablas.cierre_mes[0];
    expect(global).toMatchObject({
      periodo: '2026-09-01',
      estado: 'CERRADO',
      version: 1,
      cerrado_por: ALE,
    });
    const tot = global.totales as Record<string, unknown>;
    expect(tot.vuelos_diferidos).toBe(3);
    expect(tot.vuelos).toBe(5);
    expect((tot.por_avion as unknown[]).length).toBe(2);
    expect(tot.derivado_de).toBe('cierre_mes_avion');
    expect(
      (global.socios_snapshot as { aviones: unknown[] }).aviones,
    ).toHaveLength(2);
    const cerrado = await ps.compute(SEP);
    expect(cerrado.cierre).toMatchObject({
      estado: 'CERRADO',
      coincide_con_snapshot: true,
      aviones_cerrados: ['XB-AAA', 'XB-BBB'],
    });
    const [u2] = await ps.utilidadesSociosPorMes(['2026-09'], '2026-10');
    expect(u2.origen).toBe('SNAPSHOT_CIERRE');
    expect(
      (await atrapa(assertMesAbierto(sb, '2026-09', 'caja_chica'))).body.error,
    ).toBe('MES_CERRADO');

    // Reabrir XB-AAA: comparte #4 (que difirió) con XB-BBB cerrado ⇒ 409.
    const otro = await atrapa(
      reabrirA(
        svc,
        '2026-09',
        { confirmar: true, motivo: 'Faltó un gasto', aeronave_id: AV1 },
        actor(),
      ),
    );
    expect(otro.status).toBe(409);
    expect(otro.body.error).toBe('OTRO_AVION_CERRADO');
    expect(detalles(otro.body)).toMatchObject({
      aeronave: { id: AV1, matricula: 'XB-AAA' },
      matriculas: ['XB-BBB'],
      aviones: [{ aeronave_id: AV2, matricula: 'XB-BBB' }],
    });
    // Reabrir XB-BBB sí: su fila REABIERTO, #3 regresa, la global REABIERTO
    // y el mes queda PARCIAL (XB-AAA sigue cerrado).
    const rb = await reabrirA(
      svc,
      '2026-09',
      { confirmar: true, motivo: 'Faltó un gasto', aeronave_id: AV2 },
      actor(),
    );
    expect(rb.aeronave).toEqual({ id: AV2, matricula: 'XB-BBB' });
    expect(rb.cierres[0]).toMatchObject({
      aeronave_id: AV2,
      matricula: 'XB-BBB',
      estado: 'REABIERTO',
      version: 1,
      reabierto_motivo: 'Faltó un gasto',
    });
    expect(rb.revertidos).toBe(1);
    expect(rb.no_revertidos).toEqual([]);
    expect(rb.mes.estado).toBe('PARCIAL');
    expect(f.tablas.cierre_mes[0]).toMatchObject({
      estado: 'REABIERTO',
      reabierto_motivo: 'Faltó un gasto',
    });
    expect(porId(f).get(ids.v3)?.periodo_contable).toBeNull();
    expect(porId(f).get(ids.v4)?.periodo_contable).toBe(PERIODO_OCT);
    expect(avisos.at(-1)?.titulo).toBe('XB-BBB · Septiembre 2026 REABIERTO');
    // Ahora XB-AAA sí se reabre: #2 y #4 regresan y el mes queda REABIERTO.
    const ra = await reabrirA(
      svc,
      '2026-09',
      { confirmar: true, motivo: 'Faltó un gasto', aeronave_id: AV1 },
      actor(),
    );
    expect(ra.revertidos).toBe(2);
    expect(ra.mes.estado).toBe('REABIERTO');
    expect(f.tablas.vuelo.every((x) => x.periodo_contable == null)).toBe(true);
    expect(
      f.tablas.cierre_mes_avion_vuelo.every((b) => b.revertido_at != null),
    ).toBe(true);
    const abierto = await ps.compute(SEP);
    expect(abierto.cierre?.estado).toBe('REABIERTO');
    expect(a1 && abierto.aviones[0].cierre_avion?.estado).toBe('REABIERTO');
    // Volver a cerrar XB-AAA ⇒ version 2.
    const r3 = await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV1 },
      actor(),
    );
    expect(r3.cierres[0].version).toBe(2);
    expect(
      f.tablas.cierre_mes_avion_vuelo
        .filter((b) => b.cierre_version === 2)
        .map((b) => b.vuelo_id),
    ).toEqual([ids.v2, ids.v4]);
  });

  it('MES_ANTERIOR_ABIERTO es POR AVIÓN: con septiembre de XB-AAA cerrado, XB-AAA puede cerrar octubre y XB-BBB no', async () => {
    const { svc } = armar(mundo(), { hoy: '2026-11-05' });
    await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV1 },
      actor(),
    );
    const est = await svc.estado();
    const oct = est.meses.find((m) => m.periodo === '2026-10');
    expect(
      oct?.aviones?.map((a) => [
        a.matricula,
        a.puede_cerrar,
        a.motivo_no_cerrable,
      ]),
    ).toEqual([
      ['XB-AAA', true, null],
      ['XB-BBB', false, 'MES_ANTERIOR_ABIERTO'],
    ]);
    expect(oct?.puede_cerrar).toBe(true);
    const e = await atrapa(
      cerrarA(svc, '2026-10', { confirmar: true, aeronave_id: AV2 }, actor()),
    );
    expect(e.body).toMatchObject({
      error: 'MES_ANTERIOR_ABIERTO',
      message:
        'XB-BBB: Para cerrar octubre 2026 primero cierra septiembre 2026.',
      details: {
        periodo_anterior: '2026-09',
        aeronave: { id: AV2, matricula: 'XB-BBB' },
      },
    });
    const p = await svc.previa('2026-10', { aeronaveId: AV2 });
    expect(p.motivo_no_cerrable).toBe('MES_ANTERIOR_ABIERTO');
    // MES_SIGUIENTE_CERRADO también por avión: XB-AAA con octubre cerrado no
    // reabre septiembre.
    await cerrarA(
      svc,
      '2026-10',
      { confirmar: true, aeronave_id: AV1 },
      actor(),
    );
    const sig = await atrapa(
      reabrirA(
        svc,
        '2026-09',
        { confirmar: true, motivo: 'prueba de reapertura', aeronave_id: AV1 },
        actor(),
      ),
    );
    expect(sig.body.error).toBe('MES_SIGUIENTE_CERRADO');
    expect(detalles(sig.body).aeronave).toEqual({
      id: AV1,
      matricula: 'XB-AAA',
    });
  });

  it('bloqueantes: uno ATRIBUIBLE (vuelo sin completar de XB-BBB) frena solo a XB-BBB; uno SIN avión (gastos por pagar) frena a todos; lectura fallida frena a todos', async () => {
    const sinCompletar = {
      clave: 'vuelos_sin_completar',
      titulo: 'Vuelos del periodo sin completar',
      count: 1,
      vuelos: [{ id: ids.v6, folio: 6, estado: 'EN_VUELO', fecha_vuelo: null }],
    };
    const a = armar(mundo(), { listo: false, items: [sinCompletar] });
    const p1 = await a.svc.previa('2026-09', { aeronaveId: AV1 });
    expect(p1.listo).toBe(true);
    expect(p1.motivo_no_cerrable).toBeNull();
    expect(p1.bloqueantes).toEqual([]);
    expect(p1.bloqueantes_otros_aviones).toEqual([
      {
        clave: 'vuelos_sin_completar',
        titulo: 'Vuelos del periodo sin completar',
        count: 1,
      },
    ]);
    const p2 = await a.svc.previa('2026-09', { aeronaveId: AV2 });
    expect(p2.listo).toBe(false);
    expect(p2.motivo_no_cerrable).toBe('PRECIERRE_NO_LISTO');
    expect(p2.bloqueantes).toEqual([
      {
        clave: 'vuelos_sin_completar',
        titulo: 'Vuelos del periodo sin completar',
        count: 1,
      },
    ]);
    expect(p2.bloqueantes_otros_aviones).toEqual([]);
    const e = await atrapa(
      cerrarA(a.svc, '2026-09', { confirmar: true, aeronave_id: AV2 }, actor()),
    );
    expect(e.body.error).toBe('PRECIERRE_NO_LISTO');
    expect(detalles(e.body).aeronave).toEqual({ id: AV2, matricula: 'XB-BBB' });
    expect(a.f.tablas.cierre_mes_avion).toHaveLength(0);
    // XB-AAA sí cierra aunque el pre-cierre GLOBAL diga listo:false.
    const r = await cerrarA(
      a.svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV1 },
      actor(),
    );
    expect(r.cierres[0].estado).toBe('CERRADO');
    // El estado del mes refleja la atribución: XB-BBB con PRECIERRE_NO_LISTO
    // no sale de `GET /v1/cierres` (no evalúa el pre-cierre), como antes.
    // Sin avión ⇒ todos.
    const b = armar(mundo(), {
      listo: false,
      items: [
        {
          clave: 'gastos_por_pagar',
          titulo: 'Gastos por pagar sin confirmar',
          count: 1,
          ids: ['g-1'],
        },
      ],
    });
    const pb = await b.svc.previa('2026-09', { aeronaveId: AV1 });
    expect(pb.listo).toBe(false);
    expect(pb.bloqueantes.map((x) => x.clave)).toEqual(['gastos_por_pagar']);
    // Lectura fallida de un atribuible ⇒ todos.
    const c = armar(mundo(), {
      listo: false,
      items: [
        {
          clave: 'cobros_sin_tc',
          titulo: 'Vuelos con cobros MXN sin tipo de cambio',
          count: 0,
          lectura_fallida: true,
          vuelos: [],
        },
      ],
    });
    const pc = await c.svc.previa('2026-09', { aeronaveId: AV1 });
    expect(pc.listo).toBe(false);
    expect(pc.bloqueantes).toEqual([
      expect.objectContaining({
        clave: 'cobros_sin_tc',
        lectura_fallida: true,
      }),
    ]);
  });

  it('MULTI-AVIÓN «se queda»: XB-AAA deja #4 en septiembre; en la previa de XB-BBB aparece decidido_por y no se puede diferir; la lista esperada lo incluye', async () => {
    const { svc, f, ps } = armar();
    const p1 = await svc.previa('2026-09', {
      aeronaveId: AV1,
      incluir: [ids.v4],
    });
    expect(p1.vuelos_que_pasan.map((d) => d.id)).toEqual([ids.v2]);
    expect(p1.vuelos_incluidos.map((d) => d.id)).toEqual([ids.v4]);
    expect(p1.vuelos_incluidos[0].leyenda).toMatch(
      /^Se queda en septiembre 2026 · /,
    );
    expect(p1.vuelos_incluidos[0]).not.toHaveProperty('decidido_por');
    await cerrarA(
      svc,
      '2026-09',
      {
        confirmar: true,
        aeronave_id: AV1,
        incluir_vuelos: [ids.v4],
        vuelos_esperados: [ids.v2, ids.v4],
      },
      actor(),
    );
    expect(porId(f).get(ids.v4)?.periodo_contable).toBeNull();
    expect(porId(f).get(ids.v2)?.periodo_contable).toBe(PERIODO_OCT);
    expect(
      (
        f.tablas.cierre_mes_avion[0].totales as {
          incluidos: Array<{ id: string }>;
        }
      ).incluidos.map((i) => i.id),
    ).toEqual([ids.v4]);
    // XB-BBB: #3 pasa; #4 se queda por decisión de XB-AAA (no modificable).
    const p2 = await svc.previa('2026-09', { aeronaveId: AV2 });
    expect(p2.vuelos_que_pasan.map((d) => d.id)).toEqual([ids.v3]);
    expect(p2.vuelos_incluidos).toHaveLength(1);
    expect(p2.vuelos_incluidos[0]).toMatchObject({
      id: ids.v4,
      multi_avion: true,
      decidido_por: { aeronave_id: AV1, matricula: 'XB-AAA' },
    });
    expect(p2.vuelos_incluidos[0].leyenda).toContain(
      'Se queda en septiembre 2026 (decidido al cerrar XB-AAA)',
    );
    expect(p2.totales.incluidos).toBe(1);
    // El reparto en vivo ya no lo lista como «pasaría».
    const vivo = await ps.compute(SEP);
    expect(vivo.cierre?.pendientes_que_pasarian.map((d) => d.id)).toEqual([
      ids.v3,
    ]);
    // La lista que vio el diálogo debe traer también el decidido.
    const cambio = await atrapa(
      cerrarA(
        svc,
        '2026-09',
        { confirmar: true, aeronave_id: AV2, vuelos_esperados: [ids.v3] },
        actor(),
      ),
    );
    expect(cambio.body.error).toBe('PREVIA_CAMBIO');
    const r2 = await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, aeronave_id: AV2, vuelos_esperados: [ids.v3, ids.v4] },
      actor(),
    );
    expect(r2.mes.estado).toBe('CERRADO');
    expect(porId(f).get(ids.v4)?.periodo_contable).toBeNull();
    const filaB = f.tablas.cierre_mes_avion.find((x) => x.aeronave_id === AV2);
    expect(
      (filaB?.totales as { incluidos: Array<Record<string, unknown>> })
        .incluidos,
    ).toEqual([
      expect.objectContaining({
        id: ids.v4,
        decidido_por: { aeronave_id: AV1, matricula: 'XB-AAA' },
      }),
    ]);
    // La global derivada no repite el incluido.
    expect(
      (f.tablas.cierre_mes[0].totales as { vuelos_incluidos: number })
        .vuelos_incluidos,
    ).toBe(1);
  });
});

describe('POST /v1/cierres/:periodo SIN aeronave_id — toda la flota abierta, secuencial', () => {
  it('cierra XB-AAA y luego XB-BBB con una sola previa: el compartido #4 lo lleva el primero; una sola notificación; la global queda CERRADO', async () => {
    const { svc, f, avisos } = armar();
    const r = await cerrarA(
      svc,
      '2026-09',
      { confirmar: true, vuelos_esperados: [ids.v2, ids.v3, ids.v4] },
      actor(),
    );
    expect(r.aeronave).toBeNull();
    expect(r.cierres.map((c) => [c.matricula, c.estado, c.version])).toEqual([
      ['XB-AAA', 'CERRADO', 1],
      ['XB-BBB', 'CERRADO', 1],
    ]);
    expect(r.mes).toMatchObject({ estado: 'CERRADO', aviones_cerrados: 2 });
    expect(r.diferidos.map((d) => d.id)).toEqual([ids.v2, ids.v3, ids.v4]);
    expect(
      f.tablas.cierre_mes_avion_vuelo.map((b) => [b.vuelo_id, b.aeronave_id]),
    ).toEqual([
      [ids.v2, AV1],
      [ids.v4, AV1],
      [ids.v3, AV2],
    ]);
    expect(f.tablas.cierre_mes).toHaveLength(1);
    expect(f.tablas.cierre_mes[0].estado).toBe('CERRADO');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].titulo).toBe('Septiembre 2026 cerrado (2 avión(es))');
    expect(r.reparto.aviones.map((a) => a.matricula)).toEqual([
      'XB-AAA',
      'XB-BBB',
    ]);
    // Reabrir todos: ambos REABIERTO en una llamada (sin OTRO_AVION_CERRADO
    // porque los dos se reabren juntos), los 3 vuelos regresan.
    const rb = await reabrirA(
      svc,
      '2026-09',
      { confirmar: true, motivo: 'Faltó un gasto de septiembre' },
      actor(),
    );
    expect(rb.aeronave).toBeNull();
    expect(rb.cierres.map((c) => [c.matricula, c.estado])).toEqual([
      ['XB-AAA', 'REABIERTO'],
      ['XB-BBB', 'REABIERTO'],
    ]);
    expect(rb.revertidos).toBe(3);
    expect(rb.mes.estado).toBe('REABIERTO');
    expect(f.tablas.cierre_mes[0].estado).toBe('REABIERTO');
    expect(f.tablas.vuelo.every((x) => x.periodo_contable == null)).toBe(true);
    expect(
      (
        await atrapa(
          reabrirA(
            svc,
            '2026-09',
            { confirmar: true, motivo: 'Faltó un gasto de septiembre' },
            actor(),
          ),
        )
      ).body.error,
    ).toBe('NO_ESTA_CERRADO');
    // Toda la flota ya cerrada ⇒ YA_CERRADO.
    await cerrarA(svc, '2026-09', { confirmar: true }, actor());
    expect(
      (await atrapa(cerrarA(svc, '2026-09', { confirmar: true }, actor()))).body
        .error,
    ).toBe('YA_CERRADO');
  });

  it('falla a la mitad (el update de #3 de XB-BBB): XB-AAA se QUEDA cerrado, XB-BBB queda REABIERTO «cierre incompleto» y el 500 trae details.cerrados + aeronave con un mensaje legible', async () => {
    const { svc, f } = armar(mundo(), {
      fallarEscritura: (e: Escritura) =>
        e.tabla === 'vuelo' &&
        e.op === 'update' &&
        e.valores.id === ids.v3 &&
        e.valores.periodo_contable
          ? { message: 'timeout' }
          : null,
    });
    const e = await atrapa(
      cerrarA(svc, '2026-09', { confirmar: true }, actor()),
    );
    expect(e.status).toBe(500);
    expect(e.body.error).toBe('CIERRE_INCOMPLETO');
    expect(String(e.body.message)).toMatch(/^XB-BBB: /);
    expect(detalles(e.body)).toMatchObject({
      cerrados: ['XB-AAA'],
      aeronave: { id: AV2, matricula: 'XB-BBB' },
    });
    expect(
      f.tablas.cierre_mes_avion.map((x) => [x.aeronave_id, x.estado]),
    ).toEqual([
      [AV1, 'CERRADO'],
      [AV2, 'REABIERTO'],
    ]);
    expect(f.tablas.cierre_mes_avion[1].reabierto_motivo).toBe(
      'cierre incompleto: timeout',
    );
    expect(f.tablas.cierre_mes).toHaveLength(0);
    const v = porId(f);
    expect(v.get(ids.v2)?.periodo_contable).toBe(PERIODO_OCT);
    expect(v.get(ids.v4)?.periodo_contable).toBe(PERIODO_OCT);
    expect(v.get(ids.v3)?.periodo_contable).toBeNull();
    // Un fallo NO HTTP (el insert de la fila) sale como 500 CIERRE_FALLIDO con
    // los mismos details.
    const b = armar(mundo(), {
      fallarEscritura: (e2: Escritura) =>
        e2.tabla === 'cierre_mes_avion' &&
        e2.op === 'insert' &&
        e2.valores.aeronave_id === AV2
          ? { message: 'conexión perdida' }
          : null,
    });
    const e2 = await atrapa(
      cerrarA(b.svc, '2026-09', { confirmar: true }, actor()),
    );
    expect(e2.body.error).toBe('CIERRE_FALLIDO');
    expect(detalles(e2.body)).toMatchObject({
      cerrados: ['XB-AAA'],
      aeronave: { id: AV2, matricula: 'XB-BBB' },
    });
    expect(String(e2.body.message)).toMatch(/^XB-BBB: /);
  });
});
