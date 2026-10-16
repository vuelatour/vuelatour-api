import { HttpException } from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

/**
 * INICIO OFICIAL (16-oct-2026, invariante 86): el piso va en las ANCLAS
 * (listas, bandejas, auto-cruce sin ids) y JAMÁS en candidatos ni ventanas
 * ±N días. Hoy fijo: 16-oct-2026 (hoy − 90 = 18-jul).
 */
const INICIO = '2026-09-01';

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const cfg = cfgInicio(inicio, { headersModeloIa: () => ({}) });
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    g.supabase,
    {
      generateTablaXlsx: jest.fn().mockResolvedValue(Buffer.from('x')),
    } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
    cfg as unknown as ConfiguracionService,
  );
  return { svc, cfg, ...g };
}

/** Consulta de `tabla` que lleva `m(col, …)`. */
const conOp = (
  g: ReturnType<typeof armar>,
  tabla: string,
  m: string,
  col: string,
) => g.de(tabla).find((c) => c.ops.some((o) => o.m === m && o.args[0] === col));

describe('ConciliacionService — inicio oficial', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-10-16T17:00:00Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'queueMicrotask',
        'setTimeout',
        'setInterval',
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('cobros-sin-banco: default (hoy − 90) sube al inicio; eje fecha_cobro', async () => {
    const g = armar(INICIO);
    await g.svc.cobrosSinBanco();
    const c = conOp(g, 'cobro_vuelo', 'gte', 'fecha_cobro');
    expect(c?.ops.find((o) => o.m === 'gte')?.args).toEqual([
      'fecha_cobro',
      '2026-09-01T00:00:00-05:00',
    ]);
  });

  it('cobros-sin-banco: explícito anterior a inicio y hasta anterior ⇒ sin 400 (lista vacía)', async () => {
    const g = armar(INICIO);
    await expect(
      g.svc.cobrosSinBanco('2026-08-01', '2026-08-31'),
    ).resolves.toBeDefined();
  });

  it('gastos-sin-banco: default sube y el desde devuelto es el subido', async () => {
    const g = armar(INICIO);
    const r = await g.svc.gastosSinBanco();
    expect(r.desde).toBe(INICIO);
    expect(
      g.lleva(
        conOp(g, 'gasto', 'gte', 'fecha_gasto')!,
        'gte',
        'fecha_gasto',
        INICIO,
      ),
    ).toBe(true);
  });

  it('gastos-sin-banco con inicio null: hoy − 90 (como 0.0.83)', async () => {
    const g = armar(null);
    const r = await g.svc.gastosSinBanco();
    expect(r.desde).toBe('2026-07-18');
  });

  it('abonos-pendientes: ventana con piso', async () => {
    const g = armar(INICIO);
    const r = await g.svc.abonosPendientes({});
    expect(r.desde).toBe(INICIO);
    expect(
      g.lleva(
        conOp(g, 'movimiento_bancario', 'gte', 'fecha')!,
        'gte',
        'fecha',
        INICIO,
      ),
    ).toBe(true);
  });

  it('auto-cruce SIN ids: anclas desde el inicio', async () => {
    const g = armar(INICIO);
    await g.svc.autoMatchPendientes({}, 'u');
    expect(
      g.lleva(
        conOp(g, 'movimiento_bancario', 'gte', 'fecha')!,
        'gte',
        'fecha',
        INICIO,
      ),
    ).toBe(true);
  });

  it('auto-cruce CON ids: sin piso (el operador eligió las filas)', async () => {
    const g = armar(INICIO);
    await g.svc.autoMatchPendientes({ movimiento_ids: ['m1'] }, 'u');
    const c = conOp(g, 'movimiento_bancario', 'in', 'id')!;
    expect(c.ops.some((o) => o.m === 'gte')).toBe(false);
  });

  it('Revisión: «Emparejar devoluciones» (auto-reversos) — anclas con piso y desde devuelto subido', async () => {
    const g = armar(INICIO);
    const r = await g.svc.autoReversos({}, 'u');
    expect(r.desde).toBe(INICIO);
    expect(
      g.lleva(
        conOp(g, 'movimiento_bancario', 'gte', 'fecha')!,
        'gte',
        'fecha',
        INICIO,
      ),
    ).toBe(true);
  });

  it('Revisión: auto-reversos con inicio null ⇒ hoy − 90 (como 0.0.83); rango de agosto ⇒ sin 400', async () => {
    const g = armar(null);
    const r = await g.svc.autoReversos({}, 'u');
    expect(r.desde).toBe('2026-07-18');
    const g2 = armar(INICIO);
    const r2 = await g2.svc.autoReversos(
      { desde: '2026-08-01', hasta: '2026-08-31' },
      'u',
    );
    expect(r2.revisados).toBe(0);
  });

  it('sugerir lote: anclas con piso', async () => {
    const g = armar(INICIO);
    await g.svc.sugerirLote({}, 'u').catch(() => undefined);
    expect(
      g.lleva(
        conOp(g, 'movimiento_bancario', 'gte', 'fecha')!,
        'gte',
        'fecha',
        INICIO,
      ),
    ).toBe(true);
  });

  it('movimientos y resumen: piso AND sobre fecha', async () => {
    const g = armar(INICIO);
    await g.svc.list({ limit: 50, offset: 0 });
    await g.svc.resumen();
    const conFecha = g
      .de('movimiento_bancario')
      .filter((c) => g.lleva(c, 'gte', 'fecha', INICIO));
    expect(conFecha.length).toBeGreaterThanOrEqual(2);
  });

  it('reporte.xlsx de agosto ⇒ 400 PERIODO_ANTES_DEL_INICIO; que cruza ⇒ desde subido', async () => {
    const g = armar(INICIO);
    try {
      await g.svc.reporteXlsx(
        undefined,
        '2026-08-01',
        '2026-08-31',
        'sin_banco',
      );
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect(
        ((e as HttpException).getResponse() as { error: string }).error,
      ).toBe('PERIODO_ANTES_DEL_INICIO');
    }
    const r = await g.svc.reporteXlsx(
      undefined,
      '2026-08-20',
      '2026-09-30',
      'sin_banco',
    );
    expect(r.desde).toBe(INICIO);
  });

  it('REGRESIÓN: candidatos de un cargo del 2-sep siguen viendo gastos del 30-ago (sin piso)', async () => {
    const g = armar(INICIO);
    const priv = g.svc as unknown as {
      gastosCandidatos(o: {
        moneda: string | null;
        desde: string;
        hasta: string;
        limite: number;
      }): Promise<unknown>;
    };
    await priv.gastosCandidatos({
      moneda: 'MXN',
      desde: '2026-08-30',
      hasta: '2026-09-05',
      limite: 10,
    });
    expect(g.lleva(g.de('gasto')[0], 'gte', 'fecha_gasto', '2026-08-30')).toBe(
      true,
    );
    expect(g.cfg.inicioOficial).not.toHaveBeenCalled();
  });
});

// ===== Auditoría 16-oct-2026 (API 0.0.85) =====

describe('ConciliacionService — inicio oficial, auditoría 16-oct (0.0.85)', () => {
  const ARCH = (id: string, created_at: string) => ({
    id,
    cuenta_bancaria_id: 'c1',
    filename: `${id}.pdf`,
    formato: 'PDF',
    movimientos_importados: 1,
    created_at,
  });
  /** Archivos: julio (movs de julio), sep (movs de sep), vacío viejo,
   *  vacío nuevo (re-importe 100 % duplicado). */
  const archivos = [
    ARCH('a-jul', '2026-07-27T18:00:00Z'),
    ARCH('a-sep', '2026-09-08T18:00:00Z'),
    ARCH('a-vacio-ago', '2026-08-18T18:00:00Z'),
    ARCH('a-vacio-oct', '2026-10-12T18:00:00Z'),
    ARCH('a-cruza', '2026-09-02T18:00:00Z'),
  ];
  const movsDe: Record<string, string[]> = {
    'a-jul': ['2026-07-16', '2026-07-27'],
    'a-sep': ['2026-09-01'],
    'a-cruza': ['2026-08-28', '2026-09-01'],
  };
  function conArchivos(inicio: string | null) {
    const g = supabaseGrabador((tabla, ops) => {
      if (tabla === 'estado_cuenta_archivo') {
        return { data: archivos, error: null };
      }
      if (tabla === 'movimiento_bancario') {
        const ids = (ops.find((o) => o.m === 'in')?.args[1] ?? []) as string[];
        const lt = ops.find((o) => o.m === 'lt')?.args[1] as string | undefined;
        const gte = ops.find((o) => o.m === 'gte')?.args[1] as
          | string
          | undefined;
        const data = ids.flatMap((id) =>
          (movsDe[id] ?? [])
            .filter((f) => (!lt || f < lt) && (!gte || f >= gte))
            .map(() => ({ estado_cuenta_id: id })),
        );
        return { data, error: null };
      }
      return undefined;
    });
    const svc = new ConciliacionService(
      { get: () => '' } as unknown as ConstructorParameters<
        typeof ConciliacionService
      >[0],
      g.supabase,
      {} as unknown as PyservicesService,
      { registrar: jest.fn() } as unknown as IaUsoService,
      cfgInicio(inicio, {
        headersModeloIa: () => ({}),
      }) as unknown as ConfiguracionService,
    );
    return { svc, ...g };
  }

  it('estados de cuenta: oculta los que TERMINAN antes del inicio (o vacíos importados antes)', async () => {
    const r = await conArchivos(INICIO).svc.listEstadosCuenta();
    expect(r.data.map((a) => (a as { id: string }).id)).toEqual([
      'a-sep',
      'a-vacio-oct',
      'a-cruza',
    ]);
  });

  it('estados de cuenta con inicio null ⇒ todos, sin leer movimientos', async () => {
    const a = conArchivos(null);
    const r = await a.svc.listEstadosCuenta();
    expect(r.data).toHaveLength(5);
    expect(a.de('movimiento_bancario')).toHaveLength(0);
  });

  it('Paywise: «Cobros sin Paywise» no lista cobros anteriores al inicio (día Cancún)', async () => {
    type Priv = {
      sinSoloSistemaAnterior(r: object): Promise<{
        solo_sistema: Array<{ id: string }>;
        coinciden: unknown[];
      }>;
    };
    const cobro = (id: string, fecha_cobro: string) => ({
      tipo: 'COBRO_VUELO',
      id,
      fecha_cobro,
      monto: 1,
      moneda: 'MXN',
    });
    const cruce = {
      coinciden: [{ x: 1 }],
      comision_distinta: [],
      referencia_monto_distinto: [],
      solo_paywise: [],
      solo_sistema: [
        cobro('c-ago', '2026-08-29T18:00:00Z'),
        cobro('c-borde', '2026-09-01T04:30:00Z'),
        cobro('c-sep', '2026-09-01T06:00:00Z'),
      ],
      ambiguos: [],
      ya_conciliados_fuera: 0,
    };
    const r = await (
      armar(INICIO).svc as unknown as Priv
    ).sinSoloSistemaAnterior(cruce);
    expect(r.solo_sistema.map((c) => c.id)).toEqual(['c-sep']);
    expect(r.coinciden).toHaveLength(1);
    const r0 = await (
      armar(null).svc as unknown as Priv
    ).sinSoloSistemaAnterior(cruce);
    expect(r0.solo_sistema).toHaveLength(3);
  });

  it('«también en otro pago»: la ventana no baja del inicio', async () => {
    type Priv = {
      anotarFacturaConcepto(
        filas: Array<Record<string, unknown>>,
        folios: Map<string, unknown>,
      ): Promise<void>;
    };
    const filas = () => [
      {
        id: 'm1',
        fecha: '2026-09-10',
        tipo: 'CARGO',
        descripcion: 'PAGO Factura 7360',
      },
    ];
    const a = armar(INICIO);
    await (a.svc as unknown as Priv).anotarFacturaConcepto(filas(), new Map());
    const q = a
      .de('movimiento_bancario')
      .find((c) => c.ops.some((o) => o.m === 'ilike'))!;
    expect(a.lleva(q, 'gte', 'fecha', INICIO)).toBe(true);
    const b = armar(null);
    await (b.svc as unknown as Priv).anotarFacturaConcepto(filas(), new Map());
    const q0 = b
      .de('movimiento_bancario')
      .find((c) => c.ops.some((o) => o.m === 'ilike'))!;
    const gte0 = q0.ops.find((o) => o.m === 'gte')!.args[1] as string;
    expect(gte0 < INICIO).toBe(true);
  });
});
