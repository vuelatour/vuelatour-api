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

import type { SupabaseService } from '../supabase/supabase.service';
import { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { NotificationsService } from '../realtime/notifications.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import { CierresService } from './cierres.service';
import {
  fakeCierre,
  type Escritura,
  type FakeOpts,
  type Fila,
} from '../../common/cierre-mes.fixture-spec';

/**
 * CIERRE DE MES — servicio (16-oct-2026, API 0.0.88, invariante 89). Mundo
 * SINTÉTICO de septiembre 2026 (un avión, K 20) con el `compute` REAL:
 *  - #1 cobrado completo el 20-sep ⇒ se queda
 *  - #2 cobrado completo el 2-oct ⇒ PASA (COBRO_POSTERIOR)
 *  - #3 cobrado 500 de 1,000 el 15-sep ⇒ PASA (COBRO_PARCIAL)
 *  - #4 precio $0 ⇒ se queda
 *  - #5 sin cobro ⇒ PASA (SIN_COBRO)
 *  - #6 CANCELADO sin cobros ⇒ se queda
 * Hoy = 16-oct-2026 (octubre en curso).
 */

const AV = 'av-1';
const ALE = 'u-ale';
const ids = {
  v1: 'v-1',
  v2: 'v-2',
  v3: 'v-3',
  v4: 'v-4',
  v5: 'v-5',
  v6: 'v-6',
};

function vuelo(
  id: string,
  folio: number,
  monto: number,
  extra: Fila = {},
): Fila {
  return {
    id,
    folio,
    cliente_id: 'cli-1',
    aeronave_id: AV,
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

function mundo(): Record<string, Fila[]> {
  return {
    aeronave: [{ id: AV, matricula: 'XB-TST', modelo: 'C206', activa: true }],
    cliente: [{ id: 'cli-1', nombre: 'Cliente Uno', es_interno: false }],
    usuario: [{ id: ALE, nombre: 'Ale Martínez' }],
    vuelo: [
      vuelo(ids.v1, 1, 1000),
      vuelo(ids.v2, 2, 1000),
      vuelo(ids.v3, 3, 1000),
      vuelo(ids.v4, 4, 0),
      vuelo(ids.v5, 5, 1000),
      vuelo(ids.v6, 6, 800, { estado: 'CANCELADO' }),
    ],
    escala: [],
    cobro_vuelo: [
      cobro('c-1', ids.v1, 1000, '2026-09-20T16:00:00Z'),
      cobro('c-2', ids.v2, 1000, '2026-10-02T16:00:00Z'),
      cobro('c-3', ids.v3, 500, '2026-09-15T16:00:00Z'),
    ],
    gasto: [],
    gasto_reparto: [],
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: 's-1',
        porcentaje: 100,
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ],
    reserva_overhaul: [],
    cierre_mes: [],
    cierre_mes_vuelo: [],
  };
}

const actor = (rol: Rol = Rol.ADMIN): AuthenticatedUser =>
  ({ userId: ALE, nombre: 'Ale Martínez', rol }) as AuthenticatedUser;

function armar(
  tablas: Record<string, Fila[]> = mundo(),
  opts: {
    sinMigracion?: boolean;
    listo?: boolean;
    hoy?: string;
    fallarEscritura?: FakeOpts['fallarEscritura'];
  } = {},
) {
  const f = fakeCierre(tablas, {
    sinMigracion: opts.sinMigracion,
    fallarEscritura: opts.fallarEscritura,
  });
  const ps = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    {} as never,
    { fecha: (_c: string, d: string) => Promise.resolve(d) } as never,
  );
  jest.spyOn(ps, 'preCierre').mockResolvedValue({
    periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
    listo: opts.listo ?? true,
    items:
      opts.listo === false
        ? [
            {
              clave: 'vuelos_sin_completar',
              titulo: 'Vuelos del periodo sin completar',
              count: 2,
            },
          ]
        : [],
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
  return { svc, ps, f, avisos };
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

const PERIODO_OCT = '2026-10-01T00:00:00-05:00';

describe('GET /v1/cierres — estado', () => {
  it('del inicio (septiembre) al mes en curso: septiembre se puede cerrar, octubre está en curso', async () => {
    const { svc } = armar();
    const r = await svc.estado();
    expect(r.disponible).toBe(true);
    expect(r.mes_en_curso).toBe('2026-10');
    expect(
      r.meses.map((m) => [m.periodo, m.estado, m.motivo_no_cerrable]),
    ).toEqual([
      ['2026-09', 'ABIERTO', null],
      ['2026-10', 'ABIERTO', 'MES_EN_CURSO'],
    ]);
    expect(r.siguiente_a_cerrar).toBe('2026-09');
  });

  it('SIN la migración ⇒ {disponible:false, meses:[]} y cerrar ⇒ 503 CIERRE_NO_DISPONIBLE', async () => {
    const { svc } = armar(mundo(), { sinMigracion: true });
    expect(await svc.estado()).toMatchObject({ disponible: false, meses: [] });
    const e = await atrapa(svc.cerrar('2026-09', { confirmar: true }, actor()));
    expect(e.status).toBe(503);
    expect(e.body.error).toBe('CIERRE_NO_DISPONIBLE');
  });
});

describe('GET /v1/cierres/:periodo/previa', () => {
  it('lista EXACTAMENTE los no cobrados al corte (posterior, parcial, sin cobro) y NO los de $0 ni el cancelado', async () => {
    const { svc } = armar();
    const p = await svc.previa('2026-09');
    expect(p.listo).toBe(true);
    expect(p.motivo_no_cerrable).toBeNull();
    expect(p.vuelos_que_pasan.map((v) => [v.id, v.motivo])).toEqual([
      [ids.v2, 'COBRO_POSTERIOR'],
      [ids.v3, 'COBRO_PARCIAL'],
      [ids.v5, 'SIN_COBRO'],
    ]);
    expect(p.vuelos_que_pasan[1]).toMatchObject({
      venta_usd: 1000,
      cobrado_usd: 500,
      por_cobrar_usd: 500,
      destino: '2026-10',
      leyenda:
        'Pasa a octubre 2026 · pendiente de cobro: cobrado $500.00 USD de $1,000.00 USD',
    });
    expect(p.totales).toMatchObject({
      completados: 5,
      cancelados: 1,
      pasan: 3,
      pasan_venta_usd: 3000,
      pasan_cobrado_al_corte_usd: 500,
      pasan_por_cobrar_usd: 2500,
      pasan_cobrado_posterior_usd: 1000,
      pasan_usd_nativo: 1500,
      pasan_mxn: 0,
      se_quedan_en_cero: 1,
    });
    // Reparto antes/después: lo cobrado del avión baja lo que se difiere.
    expect(p.reparto?.antes[0].cobrado_usd).toBe(2500);
    expect(p.reparto?.despues[0].cobrado_usd).toBe(1000);
  });
});

describe('POST /v1/cierres/:periodo — cerrar septiembre', () => {
  it('difiere #2, #3 y #5 a octubre (CAS + bitácora), congela el reparto y avisa a ADMIN', async () => {
    const { svc, f, ps, avisos } = armar();
    const r = await svc.cerrar(
      '2026-09',
      { confirmar: true, vuelos_esperados: [ids.v2, ids.v3, ids.v5] },
      actor(),
    );
    expect(r.cierre).toMatchObject({
      periodo: '2026-09',
      estado: 'CERRADO',
      version: 1,
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
    });
    expect(r.diferidos.map((d) => d.id)).toEqual([ids.v2, ids.v3, ids.v5]);
    const porId = new Map(f.tablas.vuelo.map((v) => [v.id, v]));
    for (const id of [ids.v2, ids.v3, ids.v5]) {
      expect(porId.get(id)?.periodo_contable).toBe(PERIODO_OCT);
      expect(porId.get(id)?.updated_by).toBe(ALE);
    }
    for (const id of [ids.v1, ids.v4, ids.v6]) {
      expect(porId.get(id)?.periodo_contable).toBeNull();
    }
    expect(f.tablas.cierre_mes).toHaveLength(1);
    expect(f.tablas.cierre_mes[0]).toMatchObject({
      periodo: '2026-09-01',
      estado: 'CERRADO',
      version: 1,
      cerrado_por: ALE,
    });
    expect(
      f.tablas.cierre_mes_vuelo.map((b) => [
        b.vuelo_id,
        b.motivo,
        b.cierre_version,
      ]),
    ).toEqual([
      [ids.v2, 'COBRO_POSTERIOR', 1],
      [ids.v3, 'COBRO_PARCIAL', 1],
      [ids.v5, 'SIN_COBRO', 1],
    ]);
    expect(avisos).toEqual([
      expect.objectContaining({
        rol: Rol.ADMIN,
        titulo: 'Septiembre 2026 cerrado',
      }),
    ]);
    expect(avisos[0].cuerpo).toContain('3 vuelo(s) pasan a octubre 2026');
    // El reparto EN VIVO de septiembre ya es el congelado.
    const vivo = await ps.compute({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(vivo.cierre?.estado).toBe('CERRADO');
    expect(vivo.cierre?.coincide_con_snapshot).toBe(true);
    expect(vivo.aviones[0].ingresos.cobrado_usd).toBe(1000);
    expect(vivo.cierre?.diferidos_salen.map((d) => d.id)).toEqual([
      ids.v2,
      ids.v3,
      ids.v5,
    ]);
    // Octubre los recibe completos.
    const oct = await ps.compute({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(oct.aviones[0].ingresos.cobrado_usd).toBe(1500);
    expect(oct.cierre?.diferidos_entran).toHaveLength(3);
    // La cuenta de los socios toma septiembre del SNAPSHOT.
    const [u] = await ps.utilidadesSociosPorMes(['2026-09'], '2026-10');
    expect(u.origen).toBe('SNAPSHOT_CIERRE');
  });

  it('precondiciones: MES_EN_CURSO, YA_CERRADO, PERIODO_ANTES_DEL_INICIO, PRECIERRE_NO_LISTO y PREVIA_CAMBIO', async () => {
    const a = armar();
    expect(
      (await atrapa(a.svc.cerrar('2026-10', { confirmar: true }, actor()))).body
        .error,
    ).toBe('MES_EN_CURSO');
    expect(
      (await atrapa(a.svc.cerrar('2026-08', { confirmar: true }, actor()))).body
        .error,
    ).toBe('PERIODO_ANTES_DEL_INICIO');
    const cambio = await atrapa(
      a.svc.cerrar(
        '2026-09',
        { confirmar: true, vuelos_esperados: [ids.v2] },
        actor(),
      ),
    );
    expect(cambio.status).toBe(409);
    expect(cambio.body.error).toBe('PREVIA_CAMBIO');
    expect(a.f.tablas.cierre_mes).toHaveLength(0);
    await a.svc.cerrar('2026-09', { confirmar: true }, actor());
    expect(
      (await atrapa(a.svc.cerrar('2026-09', { confirmar: true }, actor()))).body
        .error,
    ).toBe('YA_CERRADO');
    const noListo = armar(mundo(), { listo: false });
    const e = await atrapa(
      noListo.svc.cerrar('2026-09', { confirmar: true }, actor()),
    );
    expect(e.body.error).toBe('PRECIERRE_NO_LISTO');
    expect(
      (e.body.details as { bloqueantes: unknown[] }).bloqueantes,
    ).toHaveLength(1);
  });

  it('el 5-nov con septiembre ABIERTO, octubre no se cierra (MES_ANTERIOR_ABIERTO)', async () => {
    const { svc } = armar(mundo(), { hoy: '2026-11-05' });
    const e = await atrapa(svc.cerrar('2026-10', { confirmar: true }, actor()));
    expect(e.body).toMatchObject({
      error: 'MES_ANTERIOR_ABIERTO',
      message: 'Para cerrar octubre 2026 primero cierra septiembre 2026.',
      details: { periodo_anterior: '2026-09' },
    });
  });

  it('dos cierres a la vez: el INSERT choca (23505) ⇒ 409 YA_CERRADO, ningún vuelo se mueve', async () => {
    const tablas = mundo();
    const { svc, f } = armar(tablas, {
      fallarEscritura: (e: Escritura) => {
        if (e.tabla === 'cierre_mes' && e.op === 'insert') {
          tablas.cierre_mes.push({
            periodo: '2026-09-01',
            estado: 'CERRADO',
            cerrado_at: '2026-10-16T17:00:00Z',
            cerrado_por: ALE,
            version: 1,
          });
          return { code: '23505', message: 'duplicate key' };
        }
        return null;
      },
    });
    const e = await atrapa(svc.cerrar('2026-09', { confirmar: true }, actor()));
    expect(e.body.error).toBe('YA_CERRADO');
    expect(f.tablas.vuelo.every((v) => v.periodo_contable == null)).toBe(true);
  });

  it('falla a la mitad ⇒ 500 CIERRE_INCOMPLETO: lo movido REGRESA y el mes queda REABIERTO con el motivo', async () => {
    const { svc, f } = armar(mundo(), {
      fallarEscritura: (e: Escritura) =>
        e.tabla === 'vuelo' &&
        e.op === 'update' &&
        e.valores.id === ids.v3 &&
        e.valores.periodo_contable
          ? { message: 'timeout' }
          : null,
    });
    const e = await atrapa(svc.cerrar('2026-09', { confirmar: true }, actor()));
    expect(e.status).toBe(500);
    expect(e.body.error).toBe('CIERRE_INCOMPLETO');
    expect(f.tablas.vuelo.every((v) => v.periodo_contable == null)).toBe(true);
    expect(f.tablas.cierre_mes[0]).toMatchObject({
      estado: 'REABIERTO',
      reabierto_motivo: 'cierre incompleto: timeout',
    });
    expect(f.tablas.cierre_mes_vuelo.every((b) => b.revertido_at != null)).toBe(
      true,
    );
  });
});

describe('POST /v1/cierres/:periodo/reabrir', () => {
  it('revierte EXACTO los diferimientos de ese cierre, avisa, y volver a cerrar da version 2 con los mismos vuelos', async () => {
    const { svc, f, ps, avisos } = armar();
    const antes = await ps.compute({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    await svc.cerrar('2026-09', { confirmar: true }, actor());
    const r = await svc.reabrir(
      '2026-09',
      { motivo: 'Faltó un gasto de septiembre', confirmar: true },
      actor(),
    );
    expect(r).toMatchObject({
      cierre: { periodo: '2026-09', estado: 'REABIERTO', version: 1 },
      revertidos: 3,
      no_revertidos: [],
    });
    expect(f.tablas.vuelo.every((v) => v.periodo_contable == null)).toBe(true);
    expect(f.tablas.cierre_mes[0]).toMatchObject({
      estado: 'REABIERTO',
      reabierto_por: ALE,
      reabierto_motivo: 'Faltó un gasto de septiembre',
    });
    expect(f.tablas.cierre_mes_vuelo.every((b) => b.revertido_at != null)).toBe(
      true,
    );
    expect(avisos[1]).toMatchObject({ titulo: 'Septiembre 2026 REABIERTO' });
    const despues = await ps.compute({
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(despues.aviones[0].saldo_disponible_usd).toBe(
      antes.aviones[0].saldo_disponible_usd,
    );
    const r2 = await svc.cerrar('2026-09', { confirmar: true }, actor());
    expect(r2.cierre.version).toBe(2);
    expect(
      f.tablas.cierre_mes_vuelo
        .filter((b) => b.cierre_version === 2)
        .map((b) => b.vuelo_id),
    ).toEqual([ids.v2, ids.v3, ids.v5]);
  });

  it('NO_ESTA_CERRADO y MES_SIGUIENTE_CERRADO', async () => {
    const { svc, f } = armar();
    expect(
      (
        await atrapa(
          svc.reabrir(
            '2026-09',
            { motivo: 'prueba', confirmar: true },
            actor(),
          ),
        )
      ).body.error,
    ).toBe('NO_ESTA_CERRADO');
    await svc.cerrar('2026-09', { confirmar: true }, actor());
    f.tablas.cierre_mes.push({
      periodo: '2026-10-01',
      estado: 'CERRADO',
      cerrado_at: '2026-11-02T17:00:00Z',
      cerrado_por: ALE,
      version: 1,
    });
    const e = await atrapa(
      svc.reabrir('2026-09', { motivo: 'prueba', confirmar: true }, actor()),
    );
    expect(e.body).toMatchObject({
      error: 'MES_SIGUIENTE_CERRADO',
      message: 'Octubre 2026 ya está cerrado: reábrelo primero.',
    });
  });
});

describe('periodo inválido', () => {
  it('400 PERIODO_INVALIDO', async () => {
    const { svc } = armar();
    const e = await atrapa(svc.previa('2026-9'));
    expect(e.status).toBe(400);
    expect(e.body.error).toBe('PERIODO_INVALIDO');
  });
});
