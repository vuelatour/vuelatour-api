import type { SupabaseClient } from '@supabase/supabase-js';
import { ConflictException } from '@nestjs/common';
import {
  assertCobroEnMesAbierto,
  assertGastoEnMesAbierto,
  assertMesAbierto,
  avionesDeGastoCandado,
  bloqueCierreAvion,
  cierresAvionDeMes,
  errorMesCerrado,
  leerCierresMesAvion,
  leerDiferimientos,
  olvidarCierres,
  participantesDeVuelos,
  relojCierresParaSpecs,
  resumenCierreFlota,
} from './cierre-mes.lector';
import {
  cierreMesDisponible,
  cierrePorAvionDisponible,
} from './cierre-mes-disponible.util';
import { estadoMesDerivado, textoMesCerrado } from './mes-contable.util';
import { fakeCierre, type Fila } from './cierre-mes.fixture-spec';

/**
 * CIERRE DE MES POR AVIÓN (23-oct-2026, API 0.0.104, invariante 105): el
 * LECTOR de `cierre_mes_avion`, la segunda sonda y el CANDADO 409
 * `MES_CERRADO` con aviones. Septiembre 2026: N621TX CERRADO por Ale,
 * N990GG abierto, la flota (fila global) abierta.
 *  - V1 #318: de N621TX (solo).
 *  - V2 #320: de N990GG (solo).
 *  - V3 #105: multi-avión, principal N990GG, tramos N990GG + N621TX.
 *  - V4 #400: externo sin avión.
 */

const ALE = 'u-ale';
const AV621 = 'av-621';
const AV990 = 'av-990';
const V1 = 'v-318';
const V2 = 'v-320';
const V3 = 'v-105';
const V4 = 'v-400';

const filaCerrada = (aeronaveId: string, extra: Fila = {}): Fila => ({
  periodo: '2026-09-01',
  aeronave_id: aeronaveId,
  estado: 'CERRADO',
  cerrado_at: '2026-10-16T19:02:00Z',
  cerrado_por: ALE,
  reabierto_at: null,
  reabierto_por: null,
  reabierto_motivo: null,
  version: 1,
  totales: { saldo_usd: 100, incluidos: [] },
  updated_at: '2026-10-16T19:02:00Z',
  ...extra,
});

function mundo(extra: Record<string, Fila[]> = {}): Record<string, Fila[]> {
  return {
    usuario: [{ id: ALE, nombre: 'Ale Martínez' }],
    aeronave: [
      { id: AV621, matricula: 'N621TX', modelo: 'Kodiak', activa: true },
      { id: AV990, matricula: 'N990GG', modelo: 'C206', activa: true },
      { id: 'av-baja', matricula: 'XB-OLD', modelo: 'C206', activa: false },
    ],
    cierre_mes: [],
    cierre_mes_vuelo: [],
    cierre_mes_avion: [filaCerrada(AV621)],
    cierre_mes_avion_vuelo: [],
    vuelo: [
      {
        id: V1,
        folio: 318,
        fecha_vuelo: '2026-09-20T15:00:00Z',
        periodo_contable: null,
        aeronave_id: AV621,
        es_externo: false,
      },
      {
        id: V2,
        folio: 320,
        fecha_vuelo: '2026-09-22T15:00:00Z',
        periodo_contable: null,
        aeronave_id: AV990,
        es_externo: false,
      },
      {
        id: V3,
        folio: 105,
        fecha_vuelo: '2026-09-25T15:00:00Z',
        periodo_contable: null,
        aeronave_id: AV990,
        es_externo: false,
      },
      {
        id: V4,
        folio: 400,
        fecha_vuelo: '2026-09-26T15:00:00Z',
        periodo_contable: null,
        aeronave_id: null,
        es_externo: true,
      },
    ],
    escala: [
      {
        id: 'e-105-a',
        vuelo_id: V3,
        orden: 1,
        aeronave_id: AV990,
        cancelada_at: null,
        solo_operativa: false,
        es_ferry: false,
      },
      {
        id: 'e-105-b',
        vuelo_id: V3,
        orden: 2,
        aeronave_id: AV621,
        cancelada_at: null,
        solo_operativa: false,
        es_ferry: false,
      },
    ],
    gasto_reparto: [
      { id: 'r-1', gasto_id: 'g-rep', aeronave_id: AV621, monto: 50 },
      { id: 'r-2', gasto_id: 'g-rep', aeronave_id: AV990, monto: 50 },
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

const cuerpo = (e: ConflictException) =>
  e.getResponse() as {
    message: string;
    error: string;
    details: Record<string, unknown>;
  };

afterEach(() => relojCierresParaSpecs(null));

describe('sonda cierrePorAvionDisponible', () => {
  it('con la tabla ⇒ true; sin ella (42P01) ⇒ false y nada se lee de cierre_mes_avion', async () => {
    const con = fakeCierre(mundo());
    expect(await cierrePorAvionDisponible(sbDe(con))).toBe(true);
    const t = mundo();
    delete t.cierre_mes_avion;
    delete t.cierre_mes_avion_vuelo;
    const sin = fakeCierre(t);
    expect(await cierreMesDisponible(sbDe(sin))).toBe(true);
    expect(await cierrePorAvionDisponible(sbDe(sin))).toBe(false);
    expect(await leerCierresMesAvion(sbDe(sin))).toEqual([]);
    expect(await participantesDeVuelos(sbDe(sin), [{ id: V3 }])).toEqual(
      new Map(),
    );
    expect(
      sin.consultas.filter((c) => c.tabla === 'cierre_mes_avion'),
    ).toHaveLength(1); // solo la sonda
  });

  it('sin la migración del cierre (42703) la segunda sonda también dice que no', async () => {
    const sin = fakeCierre(mundo(), { sinMigracion: true });
    expect(await cierrePorAvionDisponible(sbDe(sin))).toBe(false);
  });
});

describe('leerCierresMesAvion / resumenCierreFlota / estadoMesDerivado', () => {
  it('fila legible con matrícula y nombre de quien cerró', async () => {
    const filas = await leerCierresMesAvion(sbDe(fakeCierre(mundo())));
    expect(filas).toEqual([
      expect.objectContaining({
        periodo: '2026-09',
        aeronave_id: AV621,
        matricula: 'N621TX',
        estado: 'CERRADO',
        cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
        version: 1,
      }),
    ]);
  });

  it('resumen de la flota: PARCIAL con 1 de 2 activos cerrados; el inactivo no cuenta', async () => {
    const r = await resumenCierreFlota(
      sbDe(fakeCierre(mundo())),
      '2026-09',
      null,
    );
    expect(r).toMatchObject({
      estado: 'PARCIAL',
      aviones_activos: 2,
      aviones_cerrados: ['N621TX'],
    });
    expect(r?.activos.map((a) => a.matricula)).toEqual(['N621TX', 'N990GG']);
    const t = mundo();
    delete t.cierre_mes_avion;
    expect(await resumenCierreFlota(sbDe(fakeCierre(t)), '2026-09', null)).toBe(
      null,
    );
  });

  it('estadoMesDerivado (fuente única): CERRADO manda; algún avión cerrado ⇒ PARCIAL; global REABIERTO sin cerrados ⇒ REABIERTO', () => {
    const c = { estado: 'CERRADO' as const };
    const r = { estado: 'REABIERTO' as const };
    expect(estadoMesDerivado({ global: null, aviones: [] })).toBe('ABIERTO');
    expect(estadoMesDerivado({ global: null, aviones: [c] })).toBe('PARCIAL');
    expect(estadoMesDerivado({ global: c, aviones: [c, c] })).toBe('CERRADO');
    expect(estadoMesDerivado({ global: r, aviones: [c, r] })).toBe('PARCIAL');
    expect(estadoMesDerivado({ global: r, aviones: [r, r] })).toBe('REABIERTO');
    expect(estadoMesDerivado({ global: null, aviones: [r] })).toBe('ABIERTO');
  });

  it('bloqueCierreAvion: fila ⇒ sus sellos (con reabierto_por_nombre); sin fila ⇒ ABIERTO, o CERRADO si la flota lo está', () => {
    const fa = {
      periodo: '2026-09',
      aeronave_id: AV621,
      matricula: 'N621TX',
      estado: 'REABIERTO' as const,
      cerrado_at: '2026-10-16T19:02:00Z',
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
      reabierto_at: '2026-10-17T19:02:00Z',
      reabierto_por: { id: 'u-2', nombre: 'Paco López' },
      reabierto_motivo: 'faltó un gasto',
      version: 1,
      totales: null,
      updated_at: null,
    };
    expect(bloqueCierreAvion(fa, null)).toEqual({
      estado: 'REABIERTO',
      cerrado_at: '2026-10-16T19:02:00Z',
      cerrado_por_nombre: 'Ale Martínez',
      reabierto_at: '2026-10-17T19:02:00Z',
      reabierto_por_nombre: 'Paco López',
      version: 1,
      coincide_con_snapshot: null,
    });
    expect(bloqueCierreAvion(null, null)).toMatchObject({
      estado: 'ABIERTO',
      version: null,
    });
    expect(
      bloqueCierreAvion(null, {
        periodo: '2026-09',
        estado: 'CERRADO',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: { id: ALE, nombre: 'Ale' },
        reabierto_at: null,
        reabierto_por: null,
        reabierto_motivo: null,
        version: 2,
        totales: null,
        updated_at: null,
      }),
    ).toMatchObject({
      estado: 'CERRADO',
      cerrado_por_nombre: 'Ale',
      version: 2,
    });
  });
});

describe('participantesDeVuelos / avionesDeGastoCandado', () => {
  it('un solo avión ⇒ [principal]; multi-avión ⇒ los dos; externo sin avión ⇒ []', async () => {
    const f = fakeCierre(mundo());
    const p = await participantesDeVuelos(sbDe(f), [
      { id: V1, aeronave_id: AV621 },
      { id: V3, aeronave_id: AV990 },
      { id: V4, aeronave_id: null, es_externo: true },
    ]);
    expect(p.get(V1)).toEqual([AV621]);
    expect(p.get(V3)?.sort()).toEqual([AV621, AV990]);
    expect(p.get(V4)).toEqual([]);
  });

  it('gasto: avión de la ESCALA (con herencia) ⇒ sellado ⇒ del vuelo, más las partes del reparto manual', async () => {
    const f = fakeCierre(mundo());
    const sb = sbDe(f);
    // Escala de N621TX en el vuelo de N990GG: el gasto es de N621TX.
    expect(
      await avionesDeGastoCandado(
        sb,
        { escala_id: 'e-105-b', vuelo_id: V3 },
        { fecha_vuelo: null, aeronave_id: AV990, es_externo: false },
      ),
    ).toEqual([AV621]);
    // Sin escala: el avión del vuelo.
    expect(
      await avionesDeGastoCandado(
        sb,
        { vuelo_id: V2 },
        { fecha_vuelo: null, aeronave_id: AV990, es_externo: false },
      ),
    ).toEqual([AV990]);
    // Sin vuelo, repartido a mano: el sellado (ninguno) + las partes.
    expect(
      (await avionesDeGastoCandado(sb, { id: 'g-rep' }, null)).sort(),
    ).toEqual([AV621, AV990]);
    // Sin nada ⇒ [] (solo la fila global).
    expect(await avionesDeGastoCandado(sb, { id: 'g-x' }, null)).toEqual([]);
  });
});

describe('CANDADO 409 MES_CERRADO por avión', () => {
  it('N621TX cerrado ⇒ 409 con la matrícula en el texto y details.aeronave; N990GG ⇒ pasa; sin avión ⇒ pasa (la flota está abierta)', async () => {
    const f = fakeCierre(mundo());
    const e = await atrapa(
      assertMesAbierto(sbDe(f), '2026-09', 'gasto', [AV621]),
    );
    expect(cuerpo(e)).toEqual({
      message:
        'N621TX · Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
      error: 'MES_CERRADO',
      details: {
        periodo: '2026-09',
        cerrado_at: '2026-10-16T19:02:00Z',
        cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
        registro: 'gasto',
        aeronave: { id: AV621, matricula: 'N621TX' },
      },
    });
    await expect(
      assertMesAbierto(sbDe(f), '2026-09', 'gasto', [AV990]),
    ).resolves.toBeUndefined();
    await expect(
      assertMesAbierto(sbDe(f), '2026-09', 'caja_chica'),
    ).resolves.toBeUndefined();
    await expect(
      assertMesAbierto(sbDe(f), '2026-09', 'gasto', [null, undefined]),
    ).resolves.toBeUndefined();
    await expect(
      assertMesAbierto(sbDe(f), '2026-10', 'gasto', [AV621]),
    ).resolves.toBeUndefined();
  });

  it('con la FLOTA cerrada (fila global) todo rebota y details.aeronave es null', async () => {
    const f = fakeCierre(
      mundo({
        cierre_mes: [
          {
            periodo: '2026-09-01',
            estado: 'CERRADO',
            cerrado_at: '2026-10-16T19:02:00Z',
            cerrado_por: ALE,
            version: 1,
          },
        ],
        cierre_mes_avion: [filaCerrada(AV621), filaCerrada(AV990)],
      }),
    );
    const e = await atrapa(assertMesAbierto(sbDe(f), '2026-09', 'caja_chica'));
    expect(cuerpo(e).message).toBe(
      'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
    );
    expect(cuerpo(e).details.aeronave).toBeNull();
    const e2 = await atrapa(
      assertMesAbierto(sbDe(f), '2026-09', 'gasto', [AV990]),
    );
    expect(cuerpo(e2).details.aeronave).toBeNull();
  });

  it('sin la migración por avión los details son los de siempre (sin la llave aeronave) y los aviones se ignoran', async () => {
    const t = mundo({
      cierre_mes: [
        {
          periodo: '2026-09-01',
          estado: 'CERRADO',
          cerrado_at: '2026-10-16T19:02:00Z',
          cerrado_por: ALE,
          version: 1,
        },
      ],
    });
    delete t.cierre_mes_avion;
    delete t.cierre_mes_avion_vuelo;
    const f = fakeCierre(t);
    const e = await atrapa(
      assertMesAbierto(sbDe(f), '2026-09', 'gasto', [AV621]),
    );
    expect(cuerpo(e).details).toEqual({
      periodo: '2026-09',
      cerrado_at: '2026-10-16T19:02:00Z',
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
      registro: 'gasto',
    });
  });

  it('errorMesCerrado / textoMesCerrado: con matrícula el texto la antepone; sin ella, el de siempre', () => {
    const base = {
      periodo: '2026-09',
      estado: 'CERRADO' as const,
      cerrado_at: '2026-10-16T19:02:00Z',
      cerrado_por: { id: ALE, nombre: 'Ale Martínez' },
      reabierto_at: null,
      reabierto_por: null,
      reabierto_motivo: null,
      version: 1,
      totales: null,
      updated_at: null,
    };
    expect(
      cuerpo(errorMesCerrado(base, 'cobro', { id: AV621, matricula: 'N621TX' }))
        .message,
    ).toBe(
      'N621TX · Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
    );
    expect(cuerpo(errorMesCerrado(base, 'cobro', null)).details.aeronave).toBe(
      null,
    );
    expect(cuerpo(errorMesCerrado(base, 'cobro')).details).not.toHaveProperty(
      'aeronave',
    );
    expect(textoMesCerrado({ periodo: '2026-09', matricula: '  ' })).toBe(
      'Septiembre 2026 ya está cerrado (la oficina). Reábrelo en Reportes para corregir.',
    );
  });

  it('COBRO: el vuelo de N990GG pasa; el de N621TX y el multi-avión (N621TX participa por tramo) rebotan', async () => {
    const f = fakeCierre(mundo());
    await expect(assertCobroEnMesAbierto(sbDe(f), V2)).resolves.toBeUndefined();
    const e1 = await atrapa(assertCobroEnMesAbierto(sbDe(f), V1));
    expect(cuerpo(e1).details).toMatchObject({
      registro: 'cobro',
      aeronave: { id: AV621, matricula: 'N621TX' },
    });
    const e3 = await atrapa(assertCobroEnMesAbierto(sbDe(f), [V2, V3]));
    expect(cuerpo(e3).details.aeronave).toEqual({
      id: AV621,
      matricula: 'N621TX',
    });
  });

  it('GASTO: eje vuelo de N990GG pasa; sellado a N621TX rebota; repartido a mano con parte de N621TX rebota; de empresa sin avión pasa', async () => {
    const f = fakeCierre(mundo());
    const sb = sbDe(f);
    await expect(
      assertGastoEnMesAbierto(sb, [
        {
          categoria: 'OPERACIONES',
          fecha_gasto: '2026-09-22',
          monto: 100,
          vuelo_id: V2,
        },
      ]),
    ).resolves.toBeUndefined();
    const e = await atrapa(
      assertGastoEnMesAbierto(sb, [
        {
          categoria: 'OTRO',
          fecha_gasto: '2026-09-22',
          monto: 100,
          vuelo_id: null,
          aeronave_id: AV621,
        },
      ]),
    );
    expect(cuerpo(e).details.aeronave).toEqual({
      id: AV621,
      matricula: 'N621TX',
    });
    await atrapa(
      assertGastoEnMesAbierto(sb, [
        {
          id: 'g-rep',
          categoria: 'FIJO',
          fecha_gasto: '2026-09-22',
          monto: 100,
          vuelo_id: null,
          aeronave_id: null,
        },
      ]),
    );
    await expect(
      assertGastoEnMesAbierto(sb, [
        {
          categoria: 'OTRO',
          fecha_gasto: '2026-09-22',
          monto: 100,
          vuelo_id: null,
          aeronave_id: null,
        },
      ]),
    ).resolves.toBeUndefined();
    // Replay con llave: no rebota.
    await expect(
      assertGastoEnMesAbierto(
        sb,
        [
          {
            categoria: 'OTRO',
            fecha_gasto: '2026-09-22',
            monto: 100,
            aeronave_id: AV621,
          },
        ],
        () => Promise.resolve(true),
      ),
    ).resolves.toBeUndefined();
  });

  it('caché ≤ 60 s compartida con la global; olvidarCierres la limpia; un mes PASADO abierto se relee tras 10 s', async () => {
    let ahora = Date.parse('2026-11-05T15:00:00Z');
    relojCierresParaSpecs(() => ahora);
    const f = fakeCierre(mundo());
    const sb = sbDe(f);
    olvidarCierres(sb);
    expect([...(await cierresAvionDeMes(sb, '2026-09')).keys()]).toEqual([
      AV621,
    ]);
    // Otra instancia cierra N990GG en septiembre: la caché manda (< 10 s).
    f.tablas.cierre_mes_avion.push(filaCerrada(AV990));
    ahora += 5_000;
    expect((await cierresAvionDeMes(sb, '2026-09')).has(AV990)).toBe(false);
    // Un mes pasado que la caché da por abierto (octubre) se relee tras 10 s
    // y, con esa relectura, septiembre también ve el avión nuevo.
    ahora += 6_000;
    await assertMesAbierto(sb, '2026-10', 'gasto', [AV990]);
    expect((await cierresAvionDeMes(sb, '2026-09')).has(AV990)).toBe(true);
    // olvidarCierres: la siguiente lectura vuelve a la tabla.
    f.tablas.cierre_mes_avion.length = 0;
    expect((await cierresAvionDeMes(sb, '2026-09')).size).toBe(2);
    olvidarCierres(sb);
    expect((await cierresAvionDeMes(sb, '2026-09')).size).toBe(0);
  });
});

describe('leerDiferimientos con la bitácora por avión', () => {
  it('une la legada y la viva; la viva dice qué avión cerró (cierre_aeronave_id) y el avión del vuelo', async () => {
    const f = fakeCierre(
      mundo({
        cierre_mes_vuelo: [
          {
            id: 'b-legada',
            periodo: '2026-08-01',
            cierre_version: 1,
            vuelo_id: V1,
            periodo_origen: '2026-08-01',
            periodo_destino: '2026-09-01',
            folio: 318,
            cliente: 'Cliente',
            aeronave_id: AV621,
            matricula: 'N621TX',
            venta_usd: 100,
            cobrado_usd: 0,
            por_cobrar_usd: 100,
            motivo: 'SIN_COBRO',
            revertido_at: null,
            created_at: '2026-09-02T10:00:00Z',
          },
        ],
        cierre_mes_avion_vuelo: [
          {
            id: 'b-viva',
            periodo: '2026-09-01',
            aeronave_id: AV621,
            cierre_version: 1,
            vuelo_id: V3,
            periodo_origen: '2026-09-01',
            periodo_destino: '2026-10-01',
            folio: 105,
            cliente: 'Cliente',
            vuelo_aeronave_id: AV990,
            matricula: 'N990GG',
            venta_usd: 2000,
            cobrado_usd: 0,
            por_cobrar_usd: 2000,
            motivo: 'COBRO_POSTERIOR',
            revertido_at: null,
            created_at: '2026-10-16T19:02:00Z',
          },
          {
            id: 'b-revertida',
            periodo: '2026-09-01',
            aeronave_id: AV621,
            cierre_version: 1,
            vuelo_id: V2,
            periodo_origen: '2026-09-01',
            periodo_destino: '2026-10-01',
            motivo: 'SIN_COBRO',
            revertido_at: '2026-10-17T19:02:00Z',
            created_at: '2026-10-16T19:02:00Z',
          },
        ],
      }),
    );
    const d = await leerDiferimientos(sbDe(f), [V1, V2, V3]);
    expect(d).toEqual([
      expect.objectContaining({
        vuelo_id: V1,
        origen: '2026-08',
        destino: '2026-09',
        aeronave_id: AV621,
      }),
      expect.objectContaining({
        vuelo_id: V3,
        origen: '2026-09',
        destino: '2026-10',
        aeronave_id: AV990,
        matricula: 'N990GG',
        motivo: 'COBRO_POSTERIOR',
        cierre_aeronave_id: AV621,
      }),
    ]);
    expect(d[0]).not.toHaveProperty('cierre_aeronave_id');
  });
});
