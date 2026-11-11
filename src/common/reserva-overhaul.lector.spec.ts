import type { SupabaseClient } from '@supabase/supabase-js';
import { resetColumnasOpcionales } from './columna-opcional.util';
import {
  leerTarifasReserva,
  reservaVigenciaDisponible,
} from './reserva-overhaul.lector';

/**
 * LECTOR ÚNICO DE LA TARIFA DE LA RESERVA DE OVERHAUL (10-nov-2026, API
 * 0.0.135, invariante 130). El 0.0.135 se despliega ANTES de la migración
 * `20261110000001`: mientras la tabla `reserva_overhaul_vigencia` no exista
 * (o esté vacía) el reparto y el balance deben leer la tabla por motor de
 * siempre y dar EXACTAMENTE los mismos números.
 */
type Fila = Record<string, unknown>;
type Err = { code: string; message: string };

const AV1 = 'aaaaaaaa-0000-4000-8000-000000004142';
const AV2 = 'aaaaaaaa-0000-4000-8000-000000000621';

function fake(opts: {
  /** undefined = la tabla NO existe (PGRST205); [] = existe y está vacía. */
  vigencias?: Fila[];
  legado?: Fila[];
  errorLegado?: Err;
  errorVigencias?: Err;
}) {
  const leidas: string[] = [];
  const from = (tabla: string) => {
    leidas.push(tabla);
    const filtros: Array<(f: Fila) => boolean> = [];
    const resolver = (): { data: Fila[] | null; error: Err | null } => {
      if (tabla === 'reserva_overhaul_vigencia') {
        if (opts.vigencias === undefined) {
          return {
            data: null,
            error: {
              code: 'PGRST205',
              message:
                "Could not find the table 'public.reserva_overhaul_vigencia' in the schema cache",
            },
          };
        }
        if (opts.errorVigencias) {
          return { data: null, error: opts.errorVigencias };
        }
        return {
          data: opts.vigencias.filter((f) => filtros.every((fn) => fn(f))),
          error: null,
        };
      }
      if (opts.errorLegado) return { data: null, error: opts.errorLegado };
      return {
        data: (opts.legado ?? []).filter((f) => filtros.every((fn) => fn(f))),
        error: null,
      };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push((f) => f[c] === v);
        return q;
      },
      is: (c: string, v: unknown) => {
        filtros.push((f) => (f[c] ?? null) === v);
        return q;
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(res, rej),
    };
    return q;
  };
  const sb = { from } as unknown as SupabaseClient;
  resetColumnasOpcionales(sb);
  return { sb, leidas };
}

/** Lo que hay hoy en prod: una fila por motor. */
const LEGADO: Fila[] = [
  { aeronave_id: AV1, monto_por_hora_usd: '0.01' },
  { aeronave_id: AV1, monto_por_hora_usd: '0.01' },
  { aeronave_id: AV2, monto_por_hora_usd: '200.00' },
];

describe('leerTarifasReserva', () => {
  it('SIN la migración (la tabla no existe): la tabla por motor como UNA tarifa «desde siempre» por avión — la suma de siempre', async () => {
    const { sb } = fake({ legado: LEGADO });
    expect(await reservaVigenciaDisponible(sb)).toBe(false);
    expect(await leerTarifasReserva(sb)).toEqual({
      con_vigencias: false,
      tarifas: [
        {
          aeronave_id: AV1,
          vigente_desde: null,
          usd_por_hora: 0.02,
          motores: 2,
        },
        {
          aeronave_id: AV2,
          vigente_desde: null,
          usd_por_hora: 200,
          motores: 1,
        },
      ],
    });
    // De UN avión: solo sus filas.
    expect((await leerTarifasReserva(sb, AV2)).tarifas).toEqual([
      { aeronave_id: AV2, vigente_desde: null, usd_por_hora: 200, motores: 1 },
    ]);
  });

  it('con la tabla VACÍA (migración sin su copia): también la tabla por motor', async () => {
    const { sb } = fake({ vigencias: [], legado: LEGADO });
    expect(await reservaVigenciaDisponible(sb)).toBe(true);
    const r = await leerTarifasReserva(sb, AV1);
    expect(r.con_vigencias).toBe(false);
    expect(r.tarifas).toEqual([
      { aeronave_id: AV1, vigente_desde: null, usd_por_hora: 0.02, motores: 2 },
    ]);
  });

  it('con tarifas con vigencia: ellas mandan (total = por motor × motores), las eliminadas no cuentan y la tabla por motor ya no se lee', async () => {
    const { sb, leidas } = fake({
      legado: LEGADO,
      vigencias: [
        {
          aeronave_id: AV1,
          vigente_desde: '2026-01-01',
          usd_hr_por_motor: '0.01',
          motores: 2,
          deleted_at: null,
        },
        {
          aeronave_id: AV1,
          vigente_desde: '2026-11-01',
          usd_hr_por_motor: '55.00',
          motores: 2,
          deleted_at: null,
        },
        {
          aeronave_id: AV1,
          vigente_desde: '2026-10-01',
          usd_hr_por_motor: '99.00',
          motores: 2,
          deleted_at: '2026-11-10T20:00:00Z',
        },
      ],
    });
    const r = await leerTarifasReserva(sb);
    expect(r).toEqual({
      con_vigencias: true,
      tarifas: [
        {
          aeronave_id: AV1,
          vigente_desde: '2026-01-01',
          usd_por_hora: 0.02,
          motores: 2,
        },
        {
          aeronave_id: AV1,
          vigente_desde: '2026-11-01',
          usd_por_hora: 110,
          motores: 2,
        },
      ],
    });
    expect(leidas).not.toContain('reserva_overhaul');
    // Un avión SIN vigencias no tiene reserva aunque conserve filas por motor.
    expect((await leerTarifasReserva(sb, AV2)).tarifas).toEqual([]);
  });

  it('un fallo de lectura SUBE (jamás una reserva en $0 inventada)', async () => {
    const legado = fake({
      errorLegado: { code: '57014', message: 'statement timeout' },
    });
    await expect(leerTarifasReserva(legado.sb)).rejects.toThrow(
      'Fallo al leer la reserva de overhaul: statement timeout',
    );
    const vig = fake({
      vigencias: [{ aeronave_id: AV1 }],
      legado: LEGADO,
    });
    // La sonda pasa; la lectura de las tarifas falla después.
    expect(await reservaVigenciaDisponible(vig.sb)).toBe(true);
    const roto = fake({
      vigencias: [],
      errorVigencias: { code: '57014', message: 'statement timeout' },
      legado: LEGADO,
    });
    // Con error «no es tabla inexistente» la sonda no memoriza y la lectura lanza.
    await expect(leerTarifasReserva(roto.sb)).rejects.toThrow(
      'Fallo al leer las tarifas de la reserva de overhaul: statement timeout',
    );
  });
});
