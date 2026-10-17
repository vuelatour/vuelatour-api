// Módulos pesados que expenses.service importa solo para inyección.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../vision/vision.service', () => ({ VisionService: class {} }));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// CIERRE DE MES (invariante 89): septiembre 2026 CERRADO cuando
// `septiembreCerrado` está prendido. El 409 sale del armador REAL
// (`errorMesCerrado`), con el texto de siempre. Lo usan la validación del
// reparto en partes iguales Y el núcleo `reemplazarRepartoDeGasto`.
const mockEstadoCierre = { septiembreCerrado: false };
jest.mock('../../common/cierre-mes.lector', () => {
  const real = jest.requireActual<
    typeof import('../../common/cierre-mes.lector')
  >('../../common/cierre-mes.lector');
  return {
    ...real,
    assertMesAbierto: jest.fn((_sb: unknown, meses: unknown) => {
      const lista = (Array.isArray(meses) ? meses : [meses]) as unknown[];
      if (mockEstadoCierre.septiembreCerrado && lista.includes('2026-09')) {
        return Promise.reject(
          real.errorMesCerrado(
            {
              periodo: '2026-09',
              estado: 'CERRADO',
              cerrado_at: '2026-10-16T19:02:00Z',
              cerrado_por: { id: 'u-ale', nombre: 'Ale' },
              reabierto_at: null,
              reabierto_por: null,
              reabierto_motivo: null,
              version: 1,
              totales: null,
              updated_at: null,
            } as unknown as Parameters<typeof real.errorMesCerrado>[0],
            'gasto',
          ),
        );
      }
      return Promise.resolve();
    }),
  };
});

import { BadRequestException, Logger } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { NOMINA_OCTUBRE_2026 } from './reparto-iguales.fixture-spec';
import type { RespuestaRepartoIguales } from './reparto-iguales.util';

/**
 * NÓMINA: REPARTO EN PARTES IGUALES (16-oct-2026, API 0.0.90, invariante
 * 91) — `ExpensesService.putRepartoIguales` contra una BD EN MEMORIA
 * (aeronave, gasto, gasto_reparto) que LEE y ESCRIBE como PostgREST
 * (insert / update / delete con `not in`, `range` con max-rows 1000). El
 * núcleo `reemplazarRepartoDeGasto` corre DE VERDAD (sus candados y su
 * reemplazo sin estado intermedio); en algunos casos se espía para
 * comprobar los montos exactos que recibe.
 */
type Fila = Record<string, unknown>;
type Escritura = { tabla: string; op: string; valores: unknown };

const AV = {
  N4142R: '5a82eb4a-086c-4058-97bd-b2aacdc2e942',
  N621TX: 'e1a85e5b-9eaa-4367-9920-68d5d78883e8',
  N990GG: '8f37ec37-965a-42a8-bac4-9991d282f0a3',
  XA_VGV: '3d0546c3-941f-45cc-b8a9-e3ee77545e68',
  XB_PEV: 'a0114a3e-9919-41e8-b8e4-fa433d3f3737',
  XB_IJP: '90823b46-1e0e-4cfc-9301-9cb416857c4a',
} as const;
const AERONAVES: Fila[] = [
  { id: AV.N4142R, matricula: 'N4142R', activa: true },
  { id: AV.N621TX, matricula: 'N621TX', activa: true },
  { id: AV.N990GG, matricula: 'N990GG', activa: true },
  { id: AV.XA_VGV, matricula: 'XA-VGV', activa: true },
  { id: AV.XB_PEV, matricula: 'XB-PEV', activa: true },
  { id: AV.XB_IJP, matricula: 'XB-IJP', activa: false },
];
const USUARIO = 'u-ale';

const nomina = (id: string, extra: Fila = {}): Fila => ({
  id,
  categoria: 'NOMINA',
  monto: '1000.00',
  moneda: 'MXN',
  fecha_gasto: '2026-10-15',
  vuelo_id: null,
  aeronave_id: null,
  ...extra,
});

/** Los 12 pagos REALES de octubre 2026 como filas de `gasto`. */
const OCTUBRE: Fila[] = NOMINA_OCTUBRE_2026.map((g) =>
  nomina(g.id, { monto: g.monto.toFixed(2), fecha_gasto: g.fecha_gasto }),
);

function bd(tablas: Record<string, Fila[]>) {
  const escrituras: Escritura[] = [];
  const lecturas: Array<{ tabla: string; select: string }> = [];
  const from = (tabla: string) => {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Fila | null = null;
    let rango: [number, number] | null = null;
    const filtros: Array<(f: Fila) => boolean> = [];
    const ejecutar = () => {
      const base = (tablas[tabla] ??= []);
      if (op === 'insert') {
        const fila = { ...payload };
        if (
          tabla === 'gasto_reparto' &&
          base.some(
            (f) =>
              f.gasto_id === fila.gasto_id &&
              f.aeronave_id === fila.aeronave_id,
          )
        ) {
          return { data: null, error: { code: '23505', message: 'dup' } };
        }
        base.push(fila);
        escrituras.push({ tabla, op, valores: fila });
        return { data: [fila], error: null };
      }
      const tocadas = base.filter((f) => filtros.every((fn) => fn(f)));
      if (op === 'update') {
        for (const f of tocadas) Object.assign(f, payload);
        escrituras.push({
          tabla,
          op,
          valores: { ...payload, n: tocadas.length },
        });
        return { data: tocadas, error: null };
      }
      if (op === 'delete') {
        tablas[tabla] = base.filter((f) => !tocadas.includes(f));
        escrituras.push({
          tabla,
          op,
          valores: tocadas.map((f) => ({ ...f })),
        });
        return { data: null, error: null };
      }
      let filas = tocadas.map((f) => ({ ...f }));
      if (rango)
        filas = filas.slice(rango[0], Math.min(rango[1] + 1, rango[0] + 1000));
      return { data: filas, error: null };
    };
    const q: Record<string, unknown> = {
      select: (cols: string) => {
        if (op === 'select') lecturas.push({ tabla, select: cols });
        return q;
      },
      insert: (v: Fila) => {
        op = 'insert';
        payload = v;
        return q;
      },
      update: (v: Fila) => {
        op = 'update';
        payload = v;
        return q;
      },
      delete: () => {
        op = 'delete';
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push((f) => f[c] === v);
        return q;
      },
      in: (c: string, arr: unknown[]) => {
        filtros.push((f) => arr.includes(f[c]));
        return q;
      },
      not: (c: string, o: string, v: string) => {
        expect(o).toBe('in');
        const lista = v.replace(/^\(|\)$/g, '').split(',');
        filtros.push((f) => !lista.includes(String(f[c])));
        return q;
      },
      order: () => q,
      range: (a: number, b: number) => {
        rango = [a, b];
        return q;
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(res, rej),
    };
    return q;
  };
  return {
    supabase: { service: { from } } as unknown as SupabaseService,
    tablas,
    escrituras,
    lecturas,
  };
}

function armar(gastos: Fila[], repartos: Fila[] = []) {
  const f = bd({
    aeronave: AERONAVES.map((a) => ({ ...a })),
    gasto: gastos.map((g) => ({ ...g })),
    gasto_reparto: repartos.map((r) => ({ ...r })),
  });
  const nada = {} as never;
  const service = new ExpensesService(
    f.supabase,
    nada,
    nada,
    nada,
    nada,
    nada,
    nada,
  );
  const nucleo = jest.spyOn(
    service as unknown as {
      reemplazarRepartoDeGasto: (
        g: Fila,
        items: Array<{ aeronave_id: string; monto: number }>,
        u: string,
      ) => Promise<void>;
    },
    'reemplazarRepartoDeGasto',
  );
  return { service, nucleo, ...f };
}

const CUATRO = [AV.XA_VGV, AV.N4142R, AV.N990GG, AV.N621TX];
const r2 = (x: number) => Math.round(x * 100) / 100;
const filasDe = (tablas: Record<string, Fila[]>, gastoId: string) =>
  (tablas.gasto_reparto ?? []).filter((r) => r.gasto_id === gastoId);

describe('ExpensesService.putRepartoIguales — nómina en partes iguales', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    mockEstadoCierre.septiembreCerrado = false;
  });

  it('simular: calcula con la nómina REAL de octubre (12 pagos, 4 aviones) y NO escribe nada', async () => {
    const { service, escrituras, nucleo } = armar(OCTUBRE);
    const r = await service.putRepartoIguales(
      {
        gasto_ids: OCTUBRE.map((g) => g.id as string),
        aeronave_ids: CUATRO,
        simular: true,
      },
      USUARIO,
    );
    expect(escrituras).toEqual([]);
    expect(nucleo).not.toHaveBeenCalled();
    expect(r.simulado).toBe(true);
    expect(r.quitar).toBe(false);
    // Aviones por matrícula ascendente (no en el orden pedido).
    expect(r.aeronaves).toEqual([
      { id: AV.N4142R, matricula: 'N4142R' },
      { id: AV.N621TX, matricula: 'N621TX' },
      { id: AV.N990GG, matricula: 'N990GG' },
      { id: AV.XA_VGV, matricula: 'XA-VGV' },
    ]);
    expect(r.aplicados).toBe(12);
    expect(r.errores).toBe(0);
    // Pagos por fecha y luego id.
    expect(r.gastos[0].gasto_id).toBe('f907e6fe');
    expect(r.gastos.map((g) => g.fecha_gasto)).toEqual(
      [...r.gastos.map((g) => g.fecha_gasto)].sort(),
    );
    for (const g of r.gastos) {
      expect(g.ok).toBe(true);
      expect(g.ya_repartido).toBe(false);
      expect(g.error).toBeNull();
      expect(g.partes).toHaveLength(4);
      expect(r2(g.partes.reduce((a, p) => a + p.monto, 0))).toBe(g.monto);
      for (const p of g.partes) expect(p.monto).toBe(r2(p.monto));
    }
    expect(r.totales).toHaveLength(1);
    const [t] = r.totales;
    expect(t.moneda).toBe('MXN');
    expect(t.monto).toBe(109921.46);
    expect(t.gastos_n).toBe(12);
    const porAvion = t.por_avion.map((p) => p.monto);
    expect(r2(porAvion.reduce((a, x) => a + x, 0))).toBe(109921.46);
    expect(
      r2(Math.max(...porAvion) - Math.min(...porAvion)),
    ).toBeLessThanOrEqual(0.01);
    expect(t.por_avion.map((p) => p.matricula)).toEqual([
      'N4142R',
      'N621TX',
      'N990GG',
      'XA-VGV',
    ]);
    // La forma EXACTA de un pago.
    expect(r.gastos[0]).toEqual({
      gasto_id: 'f907e6fe',
      fecha_gasto: '2026-10-07',
      monto: 5663.86,
      moneda: 'MXN',
      ok: true,
      ya_repartido: false,
      partes: [
        { aeronave_id: AV.N4142R, matricula: 'N4142R', monto: 1415.97 },
        { aeronave_id: AV.N621TX, matricula: 'N621TX', monto: 1415.97 },
        { aeronave_id: AV.N990GG, matricula: 'N990GG', monto: 1415.96 },
        { aeronave_id: AV.XA_VGV, matricula: 'XA-VGV', monto: 1415.96 },
      ],
      error: null,
    });
  });

  it('aplicar: el núcleo recibe los montos EXACTOS de la vista previa y gasto_reparto queda con Σ == monto por pago', async () => {
    const ids = OCTUBRE.map((g) => g.id as string);
    const previa = await armar(OCTUBRE).service.putRepartoIguales(
      { gasto_ids: ids, aeronave_ids: CUATRO, simular: true },
      USUARIO,
    );
    const { service, nucleo, tablas } = armar(OCTUBRE);
    const r = await service.putRepartoIguales(
      { gasto_ids: ids, aeronave_ids: CUATRO },
      USUARIO,
    );
    expect(r.simulado).toBe(false);
    expect(r.aplicados).toBe(12);
    // Lo aplicado == lo previsto (mismo plan, mismo orden).
    expect(r.gastos).toEqual(previa.gastos);
    expect(r.totales).toEqual(previa.totales);
    expect(nucleo).toHaveBeenCalledTimes(12);
    for (const [i, g] of r.gastos.entries()) {
      const [gasto, items, usuario] = nucleo.mock.calls[i];
      expect(gasto.id).toBe(g.gasto_id);
      expect(usuario).toBe(USUARIO);
      expect(items).toEqual(
        g.partes.map((p) => ({ aeronave_id: p.aeronave_id, monto: p.monto })),
      );
      const filas = filasDe(tablas, g.gasto_id);
      expect(filas).toHaveLength(4);
      expect(
        Math.round(filas.reduce((a, f) => a + Number(f.monto) * 100, 0)),
      ).toBe(Math.round(g.monto! * 100));
      for (const f of filas) expect(f.created_by).toBe(USUARIO);
    }
    // Σ por avión en la BD: difiere ≤ 1 ¢ y suma el mes completo.
    const porAvion = CUATRO.map((a) =>
      (tablas.gasto_reparto ?? [])
        .filter((f) => f.aeronave_id === a)
        .reduce((s, f) => s + Math.round(Number(f.monto) * 100), 0),
    );
    expect(porAvion.reduce((a, x) => a + x, 0)).toBe(10992146);
    expect(Math.max(...porAvion) - Math.min(...porAvion)).toBeLessThanOrEqual(
      1,
    );
  });

  it('re-repartir un pago YA repartido: `ya_repartido` y el reparto se REEMPLAZA (el avión que sale se borra)', async () => {
    const g = nomina('g-1', { monto: '900.00' });
    const { service, tablas } = armar(
      [g],
      [
        { gasto_id: 'g-1', aeronave_id: AV.XB_PEV, monto: 450 },
        { gasto_id: 'g-1', aeronave_id: AV.N4142R, monto: 450 },
      ],
    );
    const r = await service.putRepartoIguales(
      { gasto_ids: ['g-1'], aeronave_ids: [AV.N4142R, AV.N621TX, AV.N990GG] },
      USUARIO,
    );
    expect(r.gastos[0].ya_repartido).toBe(true);
    expect(r.gastos[0].ok).toBe(true);
    expect(
      filasDe(tablas, 'g-1')
        .map((f) => [f.aeronave_id, Number(f.monto)])
        .sort(),
    ).toEqual(
      [
        [AV.N4142R, 300],
        [AV.N621TX, 300],
        [AV.N990GG, 300],
      ].sort(),
    );
  });

  it('quitar con aeronave_ids [] ⇒ borra el reparto; partes [] y totales sin por_avion', async () => {
    const { service, tablas, nucleo } = armar(
      [nomina('g-1'), nomina('g-2', { monto: '500.00' })],
      [
        { gasto_id: 'g-1', aeronave_id: AV.XB_PEV, monto: 500 },
        { gasto_id: 'g-1', aeronave_id: AV.N4142R, monto: 500 },
      ],
    );
    const previa = await service.putRepartoIguales(
      { gasto_ids: ['g-1', 'g-2'], aeronave_ids: [], simular: true },
      USUARIO,
    );
    expect(filasDe(tablas, 'g-1')).toHaveLength(2);
    const r = await service.putRepartoIguales(
      { gasto_ids: ['g-1', 'g-2'], aeronave_ids: [] },
      USUARIO,
    );
    expect(previa.gastos).toEqual(r.gastos);
    expect(r.quitar).toBe(true);
    expect(r.aeronaves).toEqual([]);
    expect(
      r.gastos.map((g) => [g.gasto_id, g.ok, g.ya_repartido, g.partes]),
    ).toEqual([
      ['g-1', true, true, []],
      ['g-2', true, false, []],
    ]);
    expect(r.totales).toEqual([
      { moneda: 'MXN', monto: 1500, gastos_n: 2, por_avion: [] },
    ]);
    expect(filasDe(tablas, 'g-1')).toHaveLength(0);
    expect(nucleo.mock.calls.map((c) => c[1])).toEqual([[], []]);
  });

  it('errores POR PAGO no tumban el lote: no existe, no repartible, con vuelo, monto muy chico y mes cerrado; los demás se aplican', async () => {
    mockEstadoCierre.septiembreCerrado = true;
    const { service, nucleo, tablas } = armar([
      nomina('g-ok-1', { monto: '1000.00', fecha_gasto: '2026-10-01' }),
      nomina('g-comida', { categoria: 'COMIDA' }),
      nomina('g-vuelo', { vuelo_id: 'v-1' }),
      nomina('g-chico', { monto: '0.03' }),
      nomina('g-sep', { fecha_gasto: '2026-09-30' }),
      nomina('g-ok-2', { monto: '1001.00', fecha_gasto: '2026-10-20' }),
    ]);
    const r: RespuestaRepartoIguales = await service.putRepartoIguales(
      {
        gasto_ids: [
          'g-ok-1',
          'g-comida',
          'g-vuelo',
          'g-chico',
          'g-sep',
          'g-ok-2',
          'g-fantasma',
        ],
        aeronave_ids: CUATRO,
      },
      USUARIO,
    );
    const errores = Object.fromEntries(
      r.gastos.map((g) => [g.gasto_id, g.error?.code ?? null]),
    );
    expect(errores).toEqual({
      'g-ok-1': null,
      'g-comida': 'CATEGORIA_NO_REPARTIBLE',
      'g-vuelo': 'GASTO_CON_VUELO',
      'g-chico': 'MONTO_MUY_CHICO',
      'g-sep': 'MES_CERRADO',
      'g-ok-2': null,
      'g-fantasma': 'GASTO_NO_EXISTE',
    });
    const porId = new Map(r.gastos.map((g) => [g.gasto_id, g]));
    expect(porId.get('g-sep')!.error!.message).toBe(
      'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
    );
    expect(porId.get('g-chico')!.error!.message).toBe(
      '$0.03 MXN no alcanza para repartir entre 4 aviones: cada avión necesita al menos un centavo.',
    );
    expect(porId.get('g-fantasma')).toEqual({
      gasto_id: 'g-fantasma',
      fecha_gasto: null,
      monto: null,
      moneda: null,
      ok: false,
      ya_repartido: false,
      partes: [],
      error: {
        code: 'GASTO_NO_EXISTE',
        message:
          'Este pago ya no existe (pudo haberse eliminado): recarga la lista.',
      },
    });
    // El que no existe va al FINAL (en el orden pedido).
    expect(r.gastos.at(-1)!.gasto_id).toBe('g-fantasma');
    for (const id of ['g-comida', 'g-vuelo', 'g-chico', 'g-sep']) {
      expect(porId.get(id)!.partes).toEqual([]);
      expect(filasDe(tablas, id)).toHaveLength(0);
    }
    expect(nucleo.mock.calls.map((c) => c[0].id)).toEqual(['g-ok-1', 'g-ok-2']);
    expect(r.aplicados).toBe(2);
    expect(r.errores).toBe(5);
    // Totales SOLO de los OK; el residuo rota entre los dos válidos (el
    // pago con error no mueve el cursor): 1000 ⇒ 250 c/u; 1001 ⇒ 250.25.
    expect(r.totales).toEqual([
      {
        moneda: 'MXN',
        monto: 2001,
        gastos_n: 2,
        por_avion: [
          { aeronave_id: AV.N4142R, matricula: 'N4142R', monto: 500.25 },
          { aeronave_id: AV.N621TX, matricula: 'N621TX', monto: 500.25 },
          { aeronave_id: AV.N990GG, matricula: 'N990GG', monto: 500.25 },
          { aeronave_id: AV.XA_VGV, matricula: 'XA-VGV', monto: 500.25 },
        ],
      },
    ]);
  });

  it('un fallo inesperado del núcleo en UN pago ⇒ ERROR con texto genérico + warn; los demás se aplican', async () => {
    const { service, nucleo, tablas } = armar([
      nomina('g-1', { fecha_gasto: '2026-10-01' }),
      nomina('g-2', { fecha_gasto: '2026-10-02' }),
    ]);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    nucleo.mockImplementationOnce(() =>
      Promise.reject(new Error('fetch failed')),
    );
    const r = await service.putRepartoIguales(
      { gasto_ids: ['g-1', 'g-2'], aeronave_ids: [AV.N4142R, AV.XB_PEV] },
      USUARIO,
    );
    expect(
      r.gastos.map((g) => [g.gasto_id, g.ok, g.error?.code ?? null]),
    ).toEqual([
      ['g-1', false, 'ERROR'],
      ['g-2', true, null],
    ]);
    expect(r.gastos[0].error!.message).toBe(
      'No se pudo aplicar el reparto de este pago. Intenta de nuevo; si persiste, avisa a soporte.',
    );
    expect(r.gastos[0].partes).toEqual([]);
    expect(filasDe(tablas, 'g-2')).toHaveLength(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('g-1'))).toBe(
      true,
    );
  });

  it('un candado del núcleo (HttpException) ⇒ su código y su texto en ese pago', async () => {
    const { service, nucleo } = armar([nomina('g-1')]);
    nucleo.mockImplementationOnce(() =>
      Promise.reject(
        new BadRequestException('Hay un avión repetido en el reparto.'),
      ),
    );
    const r = await service.putRepartoIguales(
      { gasto_ids: ['g-1'], aeronave_ids: [AV.N4142R] },
      USUARIO,
    );
    expect(r.gastos[0].error).toEqual({
      code: 'BAD_REQUEST',
      message: 'Hay un avión repetido en el reparto.',
    });
  });

  it('avión inactivo o inexistente ⇒ 400 AERONAVE_INACTIVA ANTES de leer o escribir gastos', async () => {
    for (const malo of [AV.XB_IJP, '00000000-0000-4000-8000-000000000000']) {
      const { service, lecturas, escrituras } = armar(OCTUBRE);
      let error: unknown = null;
      try {
        await service.putRepartoIguales(
          { gasto_ids: ['f907e6fe'], aeronave_ids: [AV.N4142R, malo] },
          USUARIO,
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        message:
          'Alguno de los aviones elegidos no existe o está inactivo: solo se reparte entre aviones activos.',
        error: 'AERONAVE_INACTIVA',
        details: { aeronave_ids: [malo] },
      });
      expect(lecturas.map((l) => l.tabla)).toEqual(['aeronave']);
      expect(escrituras).toEqual([]);
    }
  });

  it('el avión sellado del pago se limpia al repartir (núcleo de siempre)', async () => {
    const { service, tablas } = armar([
      nomina('g-1', { aeronave_id: AV.XB_PEV }),
    ]);
    await service.putRepartoIguales(
      { gasto_ids: ['g-1'], aeronave_ids: [AV.N4142R, AV.N621TX] },
      USUARIO,
    );
    expect(tablas.gasto[0].aeronave_id).toBeNull();
  });

  it('moneda por moneda: un USD y un MXN no se mezclan en los totales', async () => {
    const { service } = armar([
      nomina('g-mxn', { monto: '100.00' }),
      nomina('g-usd', { monto: '100.00', moneda: 'USD' }),
    ]);
    const r = await service.putRepartoIguales(
      {
        gasto_ids: ['g-mxn', 'g-usd'],
        aeronave_ids: [AV.N4142R, AV.N621TX, AV.N990GG],
        simular: true,
      },
      USUARIO,
    );
    expect(r.totales.map((t) => [t.moneda, t.monto, t.gastos_n])).toEqual([
      ['MXN', 100, 1],
      ['USD', 100, 1],
    ]);
    // Cada moneda con su propio cursor: los dos empiezan en el 1.er avión.
    expect(r.totales.map((t) => t.por_avion.map((p) => p.monto))).toEqual([
      [33.34, 33.33, 33.33],
      [33.34, 33.33, 33.33],
    ]);
  });

  it('lee los pagos en lotes de ≤ 150 ids', async () => {
    const muchos = Array.from({ length: 200 }, (_, i) =>
      nomina(`g-${String(i).padStart(3, '0')}`),
    );
    const { service, lecturas } = armar(muchos);
    const r = await service.putRepartoIguales(
      {
        gasto_ids: muchos.map((g) => g.id as string),
        aeronave_ids: [AV.N4142R],
        simular: true,
      },
      USUARIO,
    );
    expect(r.aplicados).toBe(200);
    expect(lecturas.filter((l) => l.tabla === 'gasto')).toHaveLength(2);
  });
});
