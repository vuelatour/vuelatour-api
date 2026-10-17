import type { SupabaseClient } from '@supabase/supabase-js';
import { ConflictException } from '@nestjs/common';
import {
  assertCobroEnMesAbierto,
  assertGastoEnMesAbierto,
  assertMesAbierto,
  cierresCerrados,
  leerCierresMes,
  leerDiferimientos,
  mesCandadoDeGasto,
  olvidarCierres,
  relojCierresParaSpecs,
} from './cierre-mes.lector';
import { cierreMesDisponible } from './cierre-mes-disponible.util';
import { fakeCierre, type Fila } from './cierre-mes.fixture-spec';

/**
 * CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89): el LECTOR de los
 * cierres y el CANDADO 409 `MES_CERRADO` de capturas.
 */

const ALE = 'u-ale';
const V318 = 'v-318'; // septiembre, se quedó (cobrado al corte)
const V337 = 'v-337'; // septiembre diferido a octubre

function mundo(extra: Record<string, Fila[]> = {}): Record<string, Fila[]> {
  return {
    usuario: [{ id: ALE, nombre: 'Ale Martínez' }],
    cierre_mes: [
      {
        periodo: '2026-09-01',
        estado: 'CERRADO',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: ALE,
        reabierto_at: null,
        reabierto_por: null,
        reabierto_motivo: null,
        version: 1,
        totales: { vuelos_diferidos: 1 },
        updated_at: '2026-10-16T19:02:00Z',
      },
    ],
    cierre_mes_vuelo: [
      {
        id: 'b-1',
        periodo: '2026-09-01',
        cierre_version: 1,
        vuelo_id: V337,
        periodo_origen: '2026-09-01',
        periodo_destino: '2026-10-01',
        folio: 337,
        cliente: 'Ambulancia Internacional',
        aeronave_id: 'av-621',
        matricula: 'N621TX',
        venta_usd: 4931.16,
        cobrado_usd: 0,
        por_cobrar_usd: 4931.16,
        motivo: 'COBRO_POSTERIOR',
        revertido_at: null,
        created_at: '2026-10-16T19:02:00Z',
      },
    ],
    vuelo: [
      {
        id: V318,
        folio: 318,
        fecha_vuelo: '2026-09-20T15:00:00Z',
        periodo_contable: null,
        aeronave_id: 'av-621',
        es_externo: false,
      },
      {
        id: V337,
        folio: 337,
        fecha_vuelo: '2026-09-25T15:00:00Z',
        periodo_contable: '2026-10-01T00:00:00-05:00',
        aeronave_id: 'av-621',
        es_externo: false,
      },
    ],
    ...extra,
  };
}

const sbDe = (f: ReturnType<typeof fakeCierre>) =>
  f.service as unknown as SupabaseClient;

async function atrapa(p: Promise<unknown>): Promise<ConflictException> {
  try {
    await p;
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error('esperaba un 409');
}

afterEach(() => relojCierresParaSpecs(null));

describe('sonda cierreMesDisponible', () => {
  it('con la migración ⇒ true; sin ella (42703) ⇒ false y nada se lee del cierre', async () => {
    expect(await cierreMesDisponible(sbDe(fakeCierre(mundo())))).toBe(true);
    const sin = fakeCierre(mundo(), { sinMigracion: true });
    expect(await cierreMesDisponible(sbDe(sin))).toBe(false);
    expect(await leerCierresMes(sbDe(sin))).toEqual([]);
    expect(await leerDiferimientos(sbDe(sin), [V337])).toEqual([]);
    expect(sin.consultas.some((c) => c.tabla === 'cierre_mes')).toBe(false);
  });
});

describe('leerCierresMes / leerDiferimientos', () => {
  it('periodo YYYY-MM y el nombre de quien cerró', async () => {
    const f = fakeCierre(mundo());
    const filas = await leerCierresMes(sbDe(f));
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      periodo: '2026-09',
      estado: 'CERRADO',
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
      version: 1,
    });
  });

  it('diferimientos vigentes con meses YYYY-MM', async () => {
    const d = await leerDiferimientos(sbDe(fakeCierre(mundo())), [V337]);
    expect(d).toEqual([
      expect.objectContaining({
        vuelo_id: V337,
        origen: '2026-09',
        destino: '2026-10',
        venta_usd: 4931.16,
        motivo: 'COBRO_POSTERIOR',
      }),
    ]);
  });
});

describe('CANDADO 409 MES_CERRADO', () => {
  it('mes cerrado ⇒ 409 con el texto es-MX y details {periodo, cerrado_at, cerrado_por, registro}', async () => {
    const f = fakeCierre(mundo());
    const e = await atrapa(assertMesAbierto(sbDe(f), '2026-09', 'gasto'));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toEqual({
      message:
        'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
      error: 'MES_CERRADO',
      details: {
        periodo: '2026-09',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
        registro: 'gasto',
      },
    });
  });

  it('costo real AFAC (invariante 90): registro «afac_real» en el cuerpo del 409', async () => {
    const f = fakeCierre(mundo());
    const e = await atrapa(assertMesAbierto(sbDe(f), '2026-09', 'afac_real'));
    expect(e.getResponse()).toMatchObject({
      error: 'MES_CERRADO',
      details: { periodo: '2026-09', registro: 'afac_real' },
    });
  });

  it('mes abierto, null o sin la migración ⇒ pasa', async () => {
    const f = fakeCierre(mundo());
    await expect(
      assertMesAbierto(sbDe(f), '2026-10', 'cobro'),
    ).resolves.toBeUndefined();
    await expect(
      assertMesAbierto(sbDe(f), null, 'cobro'),
    ).resolves.toBeUndefined();
    const sin = fakeCierre(mundo(), { sinMigracion: true });
    await expect(
      assertMesAbierto(sbDe(sin), '2026-09', 'gasto'),
    ).resolves.toBeUndefined();
  });

  it('caché ≤ 60 s; un mes PASADO «abierto» se relee tras 10 s (otra instancia pudo cerrarlo)', async () => {
    let ahora = Date.parse('2026-11-05T15:00:00Z');
    relojCierresParaSpecs(() => ahora);
    const f = fakeCierre(mundo());
    olvidarCierres(sbDe(f));
    await assertMesAbierto(sbDe(f), '2026-10', 'gasto');
    // Otra instancia cierra octubre.
    f.tablas.cierre_mes.push({
      periodo: '2026-10-01',
      estado: 'CERRADO',
      cerrado_at: '2026-11-05T15:00:01Z',
      cerrado_por: ALE,
      version: 1,
    });
    ahora += 5_000; // < 10 s: la caché manda
    await expect(
      assertMesAbierto(sbDe(f), '2026-10', 'gasto'),
    ).resolves.toBeUndefined();
    ahora += 6_000; // > 10 s: se relee
    const e = await atrapa(assertMesAbierto(sbDe(f), '2026-10', 'gasto'));
    expect((e.getResponse() as { error: string }).error).toBe('MES_CERRADO');
    expect((await cierresCerrados(sbDe(f))).has('2026-10')).toBe(true);
  });
});

describe('CANDADO por el mes CONTABLE (cobros y gastos)', () => {
  it('cobro de un vuelo que SE QUEDÓ en septiembre cerrado ⇒ 409; de uno DIFERIDO a octubre ⇒ pasa', async () => {
    const f = fakeCierre(mundo());
    const e = await atrapa(assertCobroEnMesAbierto(sbDe(f), V318));
    expect(
      (e.getResponse() as { details: { registro: string } }).details.registro,
    ).toBe('cobro');
    await expect(
      assertCobroEnMesAbierto(sbDe(f), V337),
    ).resolves.toBeUndefined();
  });

  it('gasto OPERACIONES del 28-sep: de #318 ⇒ 409; de #337 (diferido) ⇒ pasa (cuenta en octubre)', async () => {
    const f = fakeCierre(mundo());
    const g = {
      categoria: 'OPERACIONES',
      fecha_gasto: '2026-09-28',
      monto: 100,
    };
    expect(await mesCandadoDeGasto(sbDe(f), { ...g, vuelo_id: V318 })).toBe(
      '2026-09',
    );
    expect(await mesCandadoDeGasto(sbDe(f), { ...g, vuelo_id: V337 })).toBe(
      '2026-10',
    );
    await atrapa(assertGastoEnMesAbierto(sbDe(f), [{ ...g, vuelo_id: V318 }]));
    await expect(
      assertGastoEnMesAbierto(sbDe(f), [{ ...g, vuelo_id: V337 }]),
    ).resolves.toBeUndefined();
  });

  it('GAS y gastos sin vuelo cuentan por su fecha: 30-sep ⇒ 409 aunque sean de un vuelo diferido', async () => {
    const f = fakeCierre(mundo());
    await atrapa(
      assertGastoEnMesAbierto(sbDe(f), [
        {
          categoria: 'GAS',
          fecha_gasto: '2026-09-30',
          vuelo_id: V337,
          aeronave_id: 'av-621',
        },
      ]),
    );
    await atrapa(
      assertGastoEnMesAbierto(sbDe(f), [
        { categoria: 'OTRO', fecha_gasto: '2026-09-30', vuelo_id: null },
      ]),
    );
  });

  it('PATCH: el estado de ANTES y el de DESPUÉS (mover un gasto HACIA el mes cerrado también rebota)', async () => {
    const f = fakeCierre(mundo());
    await atrapa(
      assertGastoEnMesAbierto(sbDe(f), [
        { categoria: 'OTRO', fecha_gasto: '2026-10-05' },
        { categoria: 'OTRO', fecha_gasto: '2026-09-29' },
      ]),
    );
  });

  it('REPLAY de un alta con llave: el mes está cerrado pero la llave ya creó el gasto ⇒ no rebota', async () => {
    const f = fakeCierre(mundo());
    await expect(
      assertGastoEnMesAbierto(
        sbDe(f),
        [{ categoria: 'OTRO', fecha_gasto: '2026-09-29' }],
        () => Promise.resolve(true),
      ),
    ).resolves.toBeUndefined();
    await atrapa(
      assertGastoEnMesAbierto(
        sbDe(f),
        [{ categoria: 'OTRO', fecha_gasto: '2026-09-29' }],
        () => Promise.resolve(false),
      ),
    );
  });

  it('sin la migración: ni cobros ni gastos se bloquean y no se lee el vuelo', async () => {
    const sin = fakeCierre(mundo(), { sinMigracion: true });
    await expect(
      assertCobroEnMesAbierto(sbDe(sin), V318),
    ).resolves.toBeUndefined();
    await expect(
      assertGastoEnMesAbierto(sbDe(sin), [
        { categoria: 'OTRO', fecha_gasto: '2026-09-29' },
      ]),
    ).resolves.toBeUndefined();
    expect(sin.consultas.some((c) => c.tabla === 'cierre_mes')).toBe(false);
  });
});
