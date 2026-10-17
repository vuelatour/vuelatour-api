jest.mock('../../common/afac-real-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/afac-real-disponible.util',
  ),
  afacRealDisponible: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../common/cierre-mes.lector', () => ({
  assertMesAbierto: jest.fn(() => Promise.resolve()),
}));

import { ConflictException } from '@nestjs/common';
import type { SupabaseService } from '../supabase/supabase.service';
import { afacRealDisponible } from '../../common/afac-real-disponible.util';
import { assertMesAbierto } from '../../common/cierre-mes.lector';
import { AfacRealService } from './afac-real.service';

/**
 * COSTO REAL AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90):
 * validaciones en orden, idempotencia, quitar = UPDATE a null, carrera
 * 23505 y candado del mes CONTABLE.
 */
type Fila = Record<string, unknown>;

const V = 'v-236';
const ALE = 'u-ale';

function vuelo(extra: Fila = {}): Fila {
  return {
    id: V,
    folio: 236,
    fecha_vuelo: '2026-09-02T15:00:00Z',
    aeronave_id: 'av-621',
    es_externo: false,
    periodo_contable: null,
    fecha_contable: '2026-09-02T15:00:00Z',
    ...extra,
  };
}

function fake(t: {
  vuelo?: Fila[];
  afac_vuelo?: Fila[];
  errorInsert?: string;
}) {
  const tablas: Record<string, Fila[]> = {
    vuelo: t.vuelo ?? [vuelo()],
    afac_vuelo: t.afac_vuelo ?? [],
    usuario: [{ id: ALE, nombre: 'Alejandra Pérez' }],
  };
  const escrituras: Array<{ op: string; tabla: string; datos: Fila }> = [];
  const from = (tabla: string) => {
    let filtro: (f: Fila) => boolean = () => true;
    let op: 'select' | 'insert' | 'update' = 'select';
    let datos: Fila = {};
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        const prev = filtro;
        filtro = (f) => prev(f) && f[c] === v;
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        const prev = filtro;
        filtro = (f) => prev(f) && vs.includes(f[c]);
        return q;
      },
      insert: (d: Fila) => {
        op = 'insert';
        datos = d;
        return q;
      },
      update: (d: Fila) => {
        op = 'update';
        datos = d;
        return q;
      },
      maybeSingle: () => {
        if (op === 'insert') {
          escrituras.push({ op, tabla, datos });
          if (t.errorInsert) {
            const error = { code: t.errorInsert, message: 'duplicate key' };
            t.errorInsert = undefined;
            tablas[tabla].push({
              ...datos,
              notas: null,
              capturado_por: 'otro',
            });
            return Promise.resolve({ data: null, error });
          }
          const fila = { ...datos, updated_at: '2026-10-16T19:05:00Z' };
          tablas[tabla].push(fila);
          return Promise.resolve({ data: fila, error: null });
        }
        if (op === 'update') {
          escrituras.push({ op, tabla, datos });
          const fila = tablas[tabla].find(filtro);
          if (fila)
            Object.assign(fila, datos, { updated_at: '2026-10-16T20:00:00Z' });
          return Promise.resolve({ data: fila ?? null, error: null });
        }
        return Promise.resolve({
          data: tablas[tabla].find(filtro) ?? null,
          error: null,
        });
      },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: tablas[tabla].filter(filtro),
          error: null,
        }).then(res),
    };
    return q;
  };
  const svc = new AfacRealService(
    { service: { from } } as unknown as SupabaseService,
    { inicioOficial: () => Promise.resolve('2026-09-01') } as never,
  );
  return { svc, escrituras, tablas };
}

const sonda = afacRealDisponible as jest.MockedFunction<
  typeof afacRealDisponible
>;
const candado = assertMesAbierto as jest.MockedFunction<
  typeof assertMesAbierto
>;

describe('AfacRealService (invariante 90)', () => {
  beforeEach(() => {
    sonda.mockReset().mockResolvedValue(true);
    candado.mockReset().mockResolvedValue(undefined);
  });

  it('validaciones EN ORDEN: 503 sin migración → 404 → 400 sin avión → 400 sin fecha → 400 antes del inicio → 409 mes cerrado; nada se escribe', async () => {
    sonda.mockResolvedValue(false);
    await expect(
      fake({}).svc.guardar(V, { costo_real_mxn: 1 }, ALE),
    ).rejects.toMatchObject({
      response: { error: 'AFAC_REAL_NO_DISPONIBLE' },
    });
    sonda.mockResolvedValue(true);
    await expect(
      fake({ vuelo: [] }).svc.guardar(V, { costo_real_mxn: 1 }, ALE),
    ).rejects.toMatchObject({
      response: { error: 'VUELO_NO_EXISTE' },
    });
    await expect(
      fake({
        vuelo: [vuelo({ aeronave_id: null, es_externo: true })],
      }).svc.guardar(V, { costo_real_mxn: 1 }, ALE),
    ).rejects.toMatchObject({ response: { error: 'AFAC_VUELO_SIN_AVION' } });
    await expect(
      fake({
        vuelo: [vuelo({ fecha_vuelo: null, fecha_contable: null })],
      }).svc.guardar(V, { costo_real_mxn: 1 }, ALE),
    ).rejects.toMatchObject({ response: { error: 'AFAC_VUELO_SIN_FECHA' } });
    await expect(
      fake({
        vuelo: [
          vuelo({
            fecha_vuelo: '2026-08-30T15:00:00Z',
            fecha_contable: '2026-08-30T15:00:00Z',
          }),
        ],
      }).svc.quitar(V, ALE),
    ).rejects.toMatchObject({
      response: { error: 'PERIODO_ANTES_DEL_INICIO' },
    });
    candado.mockRejectedValue(
      new ConflictException({
        message:
          'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
        error: 'MES_CERRADO',
      }),
    );
    const f = fake({});
    await expect(
      f.svc.guardar(V, { costo_real_mxn: 1 }, ALE),
    ).rejects.toMatchObject({
      response: { error: 'MES_CERRADO' },
    });
    expect(candado).toHaveBeenLastCalledWith(
      expect.anything(),
      '2026-09',
      'afac_real',
    );
    expect(f.escrituras).toEqual([]);
  });

  it('el candado va por el mes CONTABLE: un vuelo diferido a octubre (abierto) acepta aunque su fecha real sea de septiembre', async () => {
    const f = fake({
      vuelo: [
        vuelo({
          periodo_contable: '2026-10-01T05:00:00Z',
          fecha_contable: '2026-10-01T05:00:00Z',
        }),
      ],
    });
    const r = await f.svc.guardar(V, { costo_real_mxn: 4234.2 }, ALE);
    expect(candado).toHaveBeenCalledWith(
      expect.anything(),
      '2026-10',
      'afac_real',
    );
    expect(r.mes_contable).toBe('2026-10');
  });

  it('ALTA: inserta con quién/cuándo y responde con el nombre; el MISMO cuerpo después ⇒ sin_cambios y SIN escribir', async () => {
    const f = fake({});
    const r = await f.svc.guardar(
      V,
      { costo_real_mxn: 4500, notas: '  F-123 ' },
      ALE,
    );
    expect(f.escrituras).toHaveLength(1);
    expect(f.escrituras[0]).toMatchObject({
      op: 'insert',
      tabla: 'afac_vuelo',
      datos: {
        vuelo_id: V,
        costo_real_mxn: 4500,
        notas: 'F-123',
        capturado_por: ALE,
        updated_by: ALE,
      },
    });
    expect(r).toMatchObject({
      vuelo_id: V,
      folio: 236,
      costo_real_mxn: 4500,
      notas: 'F-123',
      capturado_por: { id: ALE, nombre: 'Alejandra Pérez' },
      mes_contable: '2026-09',
      sin_cambios: false,
    });
    const otra = await f.svc.guardar(V, { costo_real_mxn: 4500 }, ALE);
    expect(otra.sin_cambios).toBe(true);
    expect(f.escrituras).toHaveLength(1);
  });

  it('CAMBIO: solo notas ⇒ conserva quién/cuándo; monto distinto ⇒ los renueva; notas null ⇒ se borran', async () => {
    const f = fake({
      afac_vuelo: [
        {
          vuelo_id: V,
          costo_real_mxn: '4500.00',
          notas: 'F-1',
          capturado_por: 'u-otro',
          capturado_at: '2026-10-01T00:00:00Z',
          updated_at: 'x',
          updated_by: 'u-otro',
        },
      ],
    });
    await f.svc.guardar(V, { costo_real_mxn: 4500, notas: 'F-2' }, ALE);
    expect(f.escrituras[0].datos).toEqual({
      costo_real_mxn: 4500,
      notas: 'F-2',
      updated_by: ALE,
    });
    await f.svc.guardar(V, { costo_real_mxn: 4600, notas: null }, ALE);
    expect(f.escrituras[1].datos).toMatchObject({
      costo_real_mxn: 4600,
      notas: null,
      updated_by: ALE,
      capturado_por: ALE,
    });
    expect(f.escrituras[1].datos.capturado_at).toEqual(expect.any(String));
  });

  it('carrera: el INSERT choca (23505) ⇒ camino UPDATE (última escritura gana)', async () => {
    const f = fake({ errorInsert: '23505' });
    const r = await f.svc.guardar(V, { costo_real_mxn: 100 }, ALE);
    expect(f.escrituras.map((e) => e.op)).toEqual(['insert', 'update']);
    expect(r.costo_real_mxn).toBe(100);
  });

  it('QUITAR = UPDATE a null (nunca borrado); sin fila o ya null ⇒ sin_cambios sin escribir', async () => {
    const vacia = fake({});
    expect((await vacia.svc.quitar(V, ALE)).sin_cambios).toBe(true);
    expect(vacia.escrituras).toEqual([]);
    const f = fake({
      afac_vuelo: [
        {
          vuelo_id: V,
          costo_real_mxn: 4500,
          notas: 'F-1',
          capturado_por: ALE,
          capturado_at: 't',
          updated_at: 't',
          updated_by: ALE,
        },
      ],
    });
    const r = await f.svc.quitar(V, ALE);
    expect(f.escrituras).toEqual([
      {
        op: 'update',
        tabla: 'afac_vuelo',
        datos: {
          costo_real_mxn: null,
          capturado_por: null,
          capturado_at: null,
          updated_by: ALE,
        },
      },
    ]);
    expect(r).toMatchObject({
      costo_real_mxn: null,
      capturado_por: null,
      notas: 'F-1',
      sin_cambios: false,
    });
    expect((await f.svc.quitar(V, ALE)).sin_cambios).toBe(true);
  });

  it('defensa del servicio: un monto inválido (aunque el DTO lo dejara pasar) ⇒ 400 sin consultar', async () => {
    const f = fake({});
    await expect(
      f.svc.guardar(V, { costo_real_mxn: -5 }, ALE),
    ).rejects.toMatchObject({
      response: { error: 'AFAC_COSTO_INVALIDO' },
    });
    expect(sonda).not.toHaveBeenCalled();
  });
});
