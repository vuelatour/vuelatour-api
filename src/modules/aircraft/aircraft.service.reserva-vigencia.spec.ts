// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../expirations/expirations.service', () => ({
  ExpirationsService: class {},
}));
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { HttpException } from '@nestjs/common';
import { AircraftService } from './aircraft.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { alCambiarUtilidadesSocios } from '../../common/utilidades-socios-bus';
import { resetColumnasOpcionales } from '../../common/columna-opcional.util';

/**
 * RESERVA DE OVERHAUL CON VIGENCIA — «a partir de» (10-nov-2026, API
 * 0.0.135, invariante 130). Pedido del cliente con la captura del campo
 * «Reserva overhaul USD/hr (por motor)» de la ficha: «que pudiéramos ponerle
 * desde cuándo entra en vigor esa reserva de overhaul, porque nomás aparece
 * el monto… que dijera ahí "a partir de" y la fecha a partir de cuándo
 * quiere que afecte».
 *
 * Aquí se prueba la ESCRITURA (ficha del avión) contra una BD en memoria: la
 * tarifa de un día se crea o se corrige (guardando la anterior), eliminar es
 * una baja con sello, la única tarifa no se elimina, la ficha y la tabla por
 * motor quedan con la tarifa que vale HOY y la cuenta de los socios se entera
 * en el acto. El CÁLCULO está en `common/reserva-overhaul.util.spec` y en
 * `reserva-vigencia.libros.spec` (balance y reparto).
 */
type Fila = Record<string, unknown>;

const AV = 'aaaaaaaa-0000-4000-8000-000000004142';
const ALE = 'cccccccc-0000-4000-8000-0000000000a1';
const PABLO = 'cccccccc-0000-4000-8000-0000000000a2';

/** Mini-PostgREST en memoria (filtros + insert/update/upsert/delete). */
function fakeDb(
  tablas: Record<string, Fila[]>,
  opts: { sinVigencias?: boolean } = {},
) {
  let seq = 0;
  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let valor: Fila | Fila[] | null = null;
    let conflicto: string[] = [];
    let orden: { col: string; asc: boolean } | null = null;
    let devolver = false;
    const q: Record<string, unknown> = {};
    const ejecutar = (): { data: Fila[] | null; error: Fila | null } => {
      if (opts.sinVigencias && tabla === 'reserva_overhaul_vigencia') {
        return {
          data: null,
          error: {
            code: '42P01',
            message: 'relation "reserva_overhaul_vigencia" does not exist',
          },
        };
      }
      const filas = (tablas[tabla] ??= []);
      const cumple = (f: Fila) => filtros.every((fn) => fn(f));
      if (op === 'insert') {
        const nuevas: Fila[] = (Array.isArray(valor) ? valor : [valor!]).map(
          (v) => ({ id: `id-${++seq}`, deleted_at: null, ...v }),
        );
        if (tabla === 'reserva_overhaul_vigencia') {
          for (const n of nuevas) {
            const choca = filas.some(
              (f) =>
                f.deleted_at == null &&
                f.aeronave_id === n.aeronave_id &&
                f.vigente_desde === n.vigente_desde,
            );
            if (choca) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key' },
              };
            }
          }
        }
        filas.push(...nuevas);
        return { data: nuevas, error: null };
      }
      if (op === 'upsert') {
        for (const v of valor as Fila[]) {
          const i = filas.findIndex((f) =>
            conflicto.every((c) => f[c] === v[c]),
          );
          if (i >= 0) filas[i] = { ...filas[i], ...v };
          else filas.push({ id: `id-${++seq}`, ...v });
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        const tocadas = filas.filter(cumple);
        for (const f of tocadas) Object.assign(f, valor);
        return { data: devolver ? tocadas : null, error: null };
      }
      if (op === 'delete') {
        const quedan = filas.filter((f) => !cumple(f));
        filas.splice(0, filas.length, ...quedan);
        return { data: null, error: null };
      }
      const out = filas.filter(cumple).map((f) => ({ ...f }));
      if (orden) {
        const { col, asc } = orden;
        out.sort(
          (a, b) =>
            (asc ? 1 : -1) * String(a[col]).localeCompare(String(b[col])),
        );
      }
      return { data: out, error: null };
    };
    Object.assign(q, {
      select: () => {
        if (op !== 'select') devolver = true;
        return q;
      },
      insert: (v: Fila | Fila[]) => {
        op = 'insert';
        valor = v;
        return q;
      },
      update: (v: Fila) => {
        op = 'update';
        valor = v;
        return q;
      },
      upsert: (v: Fila[], o: { onConflict: string }) => {
        op = 'upsert';
        valor = v;
        conflicto = o.onConflict.split(',');
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
      is: (c: string, v: unknown) => {
        filtros.push((f) => (f[c] ?? null) === v);
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        filtros.push((f) => vs.includes(f[c]));
        return q;
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orden = { col, asc: o?.ascending !== false };
        return q;
      },
      limit: () => q,
      maybeSingle: () => {
        const r = ejecutar();
        return Promise.resolve(
          r.error
            ? { data: null, error: r.error }
            : { data: r.data?.[0] ?? null, error: null },
        );
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(ejecutar()).then(res, rej),
    });
    return q;
  };
  return { supabase: { service: { from } } as unknown as SupabaseService };
}

function mundo(
  opts: {
    vigencias?: Fila[];
    motores?: number;
    hoy?: string;
    sinVigencias?: boolean;
  } = {},
) {
  const tablas: Record<string, Fila[]> = {
    aeronave: [
      {
        id: AV,
        matricula: 'N4142R',
        num_motores: 2,
        reserva_overhaul_hr_usd: null,
      },
    ],
    motor: Array.from({ length: opts.motores ?? 2 }, (_, i) => ({
      id: `m-${i}`,
      aeronave_id: AV,
    })),
    reserva_overhaul: [],
    reserva_overhaul_vigencia: (opts.vigencias ?? []).map((v, i) => ({
      id: `v-${i}`,
      aeronave_id: AV,
      motores: 2,
      notas: null,
      historial: [],
      deleted_at: null,
      ...v,
    })),
  };
  const db = fakeDb(tablas, { sinVigencias: opts.sinVigencias });
  resetColumnasOpcionales(db.supabase.service as never);
  const service = new AircraftService(db.supabase, {} as never, {} as never);
  Object.assign(service as unknown as Record<string, unknown>, {
    prepararCombustible: () => Promise.resolve(),
    aeronaveCols: () => Promise.resolve('id, matricula'),
    hoyCancun: () => opts.hoy ?? '2026-11-10',
  });
  const avisos = { n: 0 };
  const baja = alCambiarUtilidadesSocios(() => {
    avisos.n += 1;
  });
  return { service, tablas, avisos, baja };
}

async function errorDe(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as { error?: string; message?: string };
      return { status: e.getStatus(), code: r.error, message: r.message };
    }
    throw e;
  }
  throw new Error('se esperaba un error');
}

const vivas = (t: Record<string, Fila[]>) =>
  t.reserva_overhaul_vigencia
    .filter((f) => f.deleted_at == null)
    .map((f) => [f.vigente_desde, Number(f.usd_hr_por_motor), f.motores]);

describe('Reserva de overhaul con vigencia — guardar desde la ficha', () => {
  it('el caso del cliente: 55 USD/hr por motor «a partir del 1-nov» sobre un avión que traía 0.01 «desde siempre» ⇒ tarifa NUEVA; la anterior no se toca', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-01-01', usd_hr_por_motor: 0.01 }],
    });
    const r = await m.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2026-11-01', usd_hr_por_motor: 55 },
      ALE,
    );
    m.baja();
    expect(vivas(m.tablas)).toEqual([
      ['2026-01-01', 0.01, 2],
      ['2026-11-01', 55, 2],
    ]);
    // La respuesta: la más reciente primero, con la que vale hoy marcada.
    expect(r).toEqual({
      disponible: true,
      vigencias: [
        expect.objectContaining({
          vigente_desde: '2026-11-01',
          usd_hr_por_motor: 55,
          motores: 2,
          usd_por_hora: 110,
          vigente_hoy: true,
          futura: false,
        }),
        expect.objectContaining({
          vigente_desde: '2026-01-01',
          usd_hr_por_motor: 0.01,
          usd_por_hora: 0.02,
          vigente_hoy: false,
        }),
      ],
    });
    // La ficha y la tabla por motor quedan con la tarifa que vale HOY.
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBe(55);
    expect(
      m.tablas.reserva_overhaul.map((f) => [f.motor_id, f.monto_por_hora_usd]),
    ).toEqual([
      ['m-0', 55],
      ['m-1', 55],
    ]);
    // Y la cuenta de los socios se entera en el acto.
    expect(m.avisos.n).toBe(1);
    expect(m.tablas.reserva_overhaul_vigencia[1]).toMatchObject({
      created_by: ALE,
      updated_by: ALE,
    });
  });

  it('la MISMA fecha CORRIGE esa tarifa y guarda la anterior en el historial (quién y cuándo)', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-11-01', usd_hr_por_motor: 55 }],
    });
    await m.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2026-11-01', usd_hr_por_motor: 60, notas: ' Ajuste ' },
      PABLO,
    );
    m.baja();
    expect(vivas(m.tablas)).toEqual([['2026-11-01', 60, 2]]);
    const fila = m.tablas.reserva_overhaul_vigencia[0];
    expect(fila).toMatchObject({ notas: 'Ajuste', updated_by: PABLO });
    expect(fila.historial).toEqual([
      expect.objectContaining({
        usd_hr_por_motor: 55,
        motores: 2,
        cambio_por: PABLO,
      }),
    ]);
    expect(m.avisos.n).toBe(1);
  });

  it('guardar lo MISMO no escribe nada ni avisa', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-11-01', usd_hr_por_motor: 55 }],
    });
    await m.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2026-11-01', usd_hr_por_motor: 55 },
      ALE,
    );
    m.baja();
    expect(m.tablas.reserva_overhaul_vigencia[0].historial).toEqual([]);
    expect(m.avisos.n).toBe(0);
  });

  it('una tarifa FUTURA no cambia la ficha de hoy; 0 = «sin reserva desde ese día»', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-01-01', usd_hr_por_motor: 55 }],
    });
    const r = await m.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2027-01-01', usd_hr_por_motor: 0 },
      ALE,
    );
    m.baja();
    expect(
      r.vigencias.map((v) => [v.vigente_desde, v.futura, v.vigente_hoy]),
    ).toEqual([
      ['2027-01-01', true, false],
      ['2026-01-01', false, true],
    ]);
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBe(55);
  });

  it('sin motores dados de alta toma los de la ficha (num_motores); `motores` explícito manda', async () => {
    const sin = mundo({ motores: 0 });
    await sin.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2026-11-01', usd_hr_por_motor: 55 },
      ALE,
    );
    sin.baja();
    expect(vivas(sin.tablas)).toEqual([['2026-11-01', 55, 2]]);
    const uno = mundo();
    await uno.service.guardarVigenciaReserva(
      AV,
      { vigente_desde: '2026-11-01', usd_hr_por_motor: 400, motores: 1 },
      ALE,
    );
    uno.baja();
    expect(vivas(uno.tablas)).toEqual([['2026-11-01', 400, 1]]);
  });

  it('rechaza una fecha que no existe y una tarifa negativa o con más de 2 decimales (400 con código)', async () => {
    const m = mundo();
    expect(
      await errorDe(
        m.service.guardarVigenciaReserva(
          AV,
          { vigente_desde: '2026-02-30', usd_hr_por_motor: 55 },
          ALE,
        ),
      ),
    ).toMatchObject({ status: 400, code: 'RESERVA_FECHA_INVALIDA' });
    expect(
      await errorDe(
        m.service.guardarVigenciaReserva(
          AV,
          { vigente_desde: '2026-11-01', usd_hr_por_motor: 55.123 },
          ALE,
        ),
      ),
    ).toMatchObject({ status: 400, code: 'RESERVA_TARIFA_INVALIDA' });
    m.baja();
    expect(m.tablas.reserva_overhaul_vigencia).toHaveLength(0);
    expect(m.avisos.n).toBe(0);
  });
});

describe('Reserva de overhaul con vigencia — eliminar una tarifa', () => {
  it('baja con sello (no se borra la fila): deja de contar, la ficha se alinea y la cuenta se entera', async () => {
    const m = mundo({
      vigencias: [
        { vigente_desde: '2026-01-01', usd_hr_por_motor: 0.01 },
        { vigente_desde: '2026-11-01', usd_hr_por_motor: 55 },
      ],
    });
    const r = await m.service.eliminarVigenciaReserva(AV, 'v-0', PABLO);
    m.baja();
    expect(r.vigencias.map((v) => v.vigente_desde)).toEqual(['2026-11-01']);
    expect(m.tablas.reserva_overhaul_vigencia).toHaveLength(2);
    expect(m.tablas.reserva_overhaul_vigencia[0]).toMatchObject({
      id: 'v-0',
      deleted_by: PABLO,
    });
    expect(m.tablas.reserva_overhaul_vigencia[0].deleted_at).toEqual(
      expect.any(String),
    );
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBe(55);
    expect(m.avisos.n).toBe(1);
  });

  it('la ÚNICA tarifa del avión no se elimina (409): para dejarlo sin reserva se captura en 0', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-11-01', usd_hr_por_motor: 55 }],
    });
    expect(
      await errorDe(m.service.eliminarVigenciaReserva(AV, 'v-0', ALE)),
    ).toEqual({
      status: 409,
      code: 'RESERVA_UNICA_TARIFA',
      message:
        'Es la única tarifa de reserva de overhaul de este avión: no se puede eliminar. Para dejarlo sin reserva captura la tarifa en 0, o cambia su fecha «a partir de».',
    });
    m.baja();
    expect(vivas(m.tablas)).toEqual([['2026-11-01', 55, 2]]);
    expect(m.avisos.n).toBe(0);
  });

  it('una tarifa que ya no existe ⇒ 404 con código', async () => {
    const m = mundo({
      vigencias: [
        { vigente_desde: '2026-01-01', usd_hr_por_motor: 55 },
        { vigente_desde: '2026-11-01', usd_hr_por_motor: 60 },
      ],
    });
    expect(
      await errorDe(m.service.eliminarVigenciaReserva(AV, 'no-existe', ALE)),
    ).toMatchObject({ status: 404, code: 'RESERVA_VIGENCIA_NO_EXISTE' });
    m.baja();
  });
});

describe('Reserva de overhaul con vigencia — la tarifa que llega con la ficha (PATCH /aircraft/:id)', () => {
  it('con «a partir de»: crea la tarifa de ese día', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-01-01', usd_hr_por_motor: 0.01 }],
    });
    await m.service.update(
      AV,
      { reserva_overhaul_hr_usd: 55, reserva_overhaul_desde: '2026-11-01' },
      ALE,
    );
    m.baja();
    expect(vivas(m.tablas)).toEqual([
      ['2026-01-01', 0.01, 2],
      ['2026-11-01', 55, 2],
    ]);
    // `reserva_overhaul_desde` NO es columna de `aeronave`.
    expect(m.tablas.aeronave[0]).not.toHaveProperty('reserva_overhaul_desde');
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBe(55);
  });

  it('SIN «a partir de» (panel anterior): corrige la tarifa que vale HOY, no una futura', async () => {
    const m = mundo({
      vigencias: [
        { vigente_desde: '2026-01-01', usd_hr_por_motor: 55 },
        { vigente_desde: '2027-01-01', usd_hr_por_motor: 70 },
      ],
    });
    await m.service.update(AV, { reserva_overhaul_hr_usd: 60 }, ALE);
    m.baja();
    expect(vivas(m.tablas)).toEqual([
      ['2026-01-01', 60, 2],
      ['2027-01-01', 70, 2],
    ]);
  });

  it('SIN «a partir de» y sin ninguna tarifa vigente: la crea «desde siempre» (lo que hacía la ficha de antes)', async () => {
    const m = mundo();
    await m.service.update(AV, { reserva_overhaul_hr_usd: 55 }, ALE);
    m.baja();
    expect(vivas(m.tablas)).toEqual([['2026-01-01', 55, 2]]);
  });

  it('guardar la ficha con la MISMA tarifa (el formulario la manda siempre) no escribe nada ni avisa; vacía o 0 sin fecha tampoco', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-11-01', usd_hr_por_motor: 55 }],
    });
    await m.service.update(AV, { reserva_overhaul_hr_usd: 55 }, ALE);
    await m.service.update(AV, { reserva_overhaul_hr_usd: 0 }, ALE);
    m.baja();
    expect(vivas(m.tablas)).toEqual([['2026-11-01', 55, 2]]);
    expect(m.tablas.reserva_overhaul_vigencia[0].historial).toEqual([]);
    expect(m.avisos.n).toBe(0);
    // Y la ficha NO se queda en 0: sigue diciendo la tarifa que vale hoy.
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBe(55);
  });

  it('lo que puede rechazar va ANTES de escribir la ficha: una fecha que no existe ⇒ 400 sin tocar nada', async () => {
    const m = mundo({
      vigencias: [{ vigente_desde: '2026-01-01', usd_hr_por_motor: 55 }],
    });
    expect(
      await errorDe(
        m.service.update(
          AV,
          { reserva_overhaul_hr_usd: 60, reserva_overhaul_desde: '2026-02-30' },
          ALE,
        ),
      ),
    ).toMatchObject({ status: 400, code: 'RESERVA_FECHA_INVALIDA' });
    m.baja();
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBeNull();
    expect(vivas(m.tablas)).toEqual([['2026-01-01', 55, 2]]);
  });

  it('la tarifa de la ficha con más de 2 decimales se guarda a centavos (como su columna)', async () => {
    const m = mundo();
    await m.service.update(
      AV,
      { reserva_overhaul_hr_usd: 55.126, reserva_overhaul_desde: '2026-11-01' },
      ALE,
    );
    m.baja();
    expect(vivas(m.tablas)).toEqual([['2026-11-01', 55.13, 2]]);
  });
});

describe('Reserva de overhaul con vigencia — sin la migración', () => {
  it('lecturas `disponible:false`; guardar con fecha ⇒ 503 MIGRACION_PENDIENTE sin escribir; la ficha sin fecha sigue como siempre (tabla por motor)', async () => {
    const m = mundo({ sinVigencias: true });
    expect(await m.service.listarVigenciasReserva(AV)).toEqual({
      disponible: false,
      vigencias: [],
    });
    expect(
      await errorDe(
        m.service.guardarVigenciaReserva(
          AV,
          { vigente_desde: '2026-11-01', usd_hr_por_motor: 55 },
          ALE,
        ),
      ),
    ).toMatchObject({ status: 503, code: 'MIGRACION_PENDIENTE' });
    expect(
      await errorDe(
        m.service.update(
          AV,
          { reserva_overhaul_hr_usd: 55, reserva_overhaul_desde: '2026-11-01' },
          ALE,
        ),
      ),
    ).toMatchObject({ status: 503, code: 'MIGRACION_PENDIENTE' });
    // Nada se escribió con el 503 (ni la ficha).
    expect(m.tablas.aeronave[0].reserva_overhaul_hr_usd).toBeNull();
    await m.service.update(AV, { reserva_overhaul_hr_usd: 55 }, ALE);
    m.baja();
    expect(
      m.tablas.reserva_overhaul.map((f) => [f.motor_id, f.monto_por_hora_usd]),
    ).toEqual([
      ['m-0', 55],
      ['m-1', 55],
    ]);
  });
});
