import { readFileSync } from 'fs';
import { join } from 'path';
import {
  coberturaCobro,
  cubreCobro,
  EPSILON_COBRO_BANCO,
  netoDeCobro,
  TC_COBRO_MAX,
  TC_COBRO_MIN,
  TOLERANCIA_COBRO_BANCO,
  type ParteCobroBanco,
} from './cobro-banco.util';
import {
  MIGRACION_COBROS_PARCIALES,
  OBJETOS_COBROS_PARCIALES,
  RPC_SONDA_COBROS_PARCIALES,
} from './cobros-parciales-disponible.util';
import {
  CODIGOS_ERROR_COBROS,
  TOKEN_ABONO_NO_CUADRA,
} from '../modules/conciliacion/cobros-lote.util';

/**
 * PARIDAD API ↔ migración 20261014000003 (14-oct-2026, invariante 77): lee
 * el ARCHIVO SQL y congela el espejo TS (`common/cobro-banco.util.ts`). Si
 * alguien cambia un lado sin el otro, esto truena en pruebas y no en el
 * cierre: las expresiones de `neto_de_cobro`, `regla_cobro_cubierto` y de la
 * vista `v_cobro_conciliacion` se comparan TEXTUALMENTE (sin comentarios ni
 * espacios) y se evalúan con aritmética decimal EXACTA (enteros en
 * millonésimas, como `numeric` con montos de 2 decimales —las columnas son
 * numeric(12,2)/(14,2) y el API guarda la comisión a centavos—) contra la
 * versión TS en 120 casos de semilla fija + los bordes.
 */
const ARCHIVO = join(
  __dirname,
  '../../supabase/migrations/20261014000003_conciliacion_cobros_varios_abonos.sql',
);
const SQL = readFileSync(ARCHIVO, 'utf8');
const CUERPO = SQL.slice(
  SQL.indexOf('-- >>> CUERPO'),
  SQL.indexOf('-- <<< CUERPO'),
);
/** El cuerpo SIN comentarios de línea (lo que de verdad se ejecuta). */
const CODIGO = CUERPO.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

/** Sin espacios ni saltos (para comparar expresiones). */
const compacto = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Cuerpo de UNA función SQL (`as $tag$ … $tag$;`). */
function funcionSql(tag: string): string {
  const ini = CODIGO.indexOf(`as $${tag}$`);
  const fin = CODIGO.indexOf(`$${tag}$;`, ini + 4 + tag.length);
  expect(ini).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(ini);
  return CODIGO.slice(ini + `as $${tag}$`.length, fin);
}

// ---- Aritmética decimal EXACTA (numeric) en millonésimas ----
const M = 1_000_000n;
/** Monto de 2 decimales ⇒ millonésimas exactas. */
const mic = (x: number): bigint => BigInt(Math.round(x * 100)) * 10_000n;
/** round(x, 2) de Postgres (mitad lejos del cero) sobre millonésimas. */
function round2(x: bigint): bigint {
  const paso = 10_000n;
  const abs = x < 0n ? -x : x;
  const r = ((abs + paso / 2n) / paso) * paso;
  return x < 0n ? -r : r;
}

/** `neto_de_cobro` transcrito del SQL (ver la aserción textual de abajo). */
function netoSql(monto: number | null, comision: number | null): bigint {
  const m = monto == null ? 0n : mic(monto);
  const c = comision == null ? 0n : mic(comision);
  const dif = round2(m - (c > 0n ? c : 0n));
  return dif > 0n ? dif : round2(m);
}

/** `regla_cobro_cubierto` transcrita del SQL (CASE ordenado). */
function reglaSql(
  neto: number | null,
  nPartes: number | null,
  cruzado: boolean | null,
  suma: number | null,
): boolean {
  if (cruzado ?? false) return true;
  if ((nPartes ?? 0) === 0) return false;
  if (round2(neto == null ? 0n : mic(neto)) <= 0n) return true;
  return (
    round2(suma == null ? 0n : mic(suma)) + 1n >=
    round2(mic(neto as number)) - M
  );
}

/** Generador con semilla fija (mulberry32): los mismos 120 casos siempre. */
function semilla(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const centavos = (r: () => number, max: number) =>
  Math.round(r() * max * 100) / 100;

describe('migración 20261014000003 — forma y constantes', () => {
  it('es la migración que sondea el API, con sus marcas de cuerpo y sus objetos', () => {
    expect(MIGRACION_COBROS_PARCIALES).toBe('20261014000003');
    expect(CUERPO.length).toBeGreaterThan(10_000);
    for (const o of OBJETOS_COBROS_PARCIALES) expect(CODIGO).toContain(o);
    // La sonda: regla_cobro_cubierto(1, 1, false, 1) DEBE ser true.
    expect(RPC_SONDA_COBROS_PARCIALES).toBe('regla_cobro_cubierto');
    expect(CODIGO).toContain('public.regla_cobro_cubierto(1, 1, false, 1)');
    expect(cubreCobro(1, 1, false, 1)).toBe(true);
  });

  it('la tolerancia ($1.00), el epsilon (0.000001), la banda 15–25 y PASARELA están en el SQL', () => {
    expect(TOLERANCIA_COBRO_BANCO).toBe(1);
    expect(EPSILON_COBRO_BANCO).toBe(0.000001);
    expect([TC_COBRO_MIN, TC_COBRO_MAX]).toEqual([15, 25]);
    const a = compacto(funcionSql('fn_parte_valida'));
    expect(a).toContain('v_tc<15orv_tc>25');
    expect(a).toContain("'tc_min',15,'tc_max',25");
    expect(a).toContain('+1.00+0.000001');
    expect(a).toContain("='pasarela'");
    expect(compacto(funcionSql('fn_regla_cobro'))).toContain(
      '+0.000001>=round(p_neto,2)-1.00',
    );
  });

  it('los códigos nuevos y la marca « [ABONO_NO_CUADRA]» están en el SQL Y en CODIGOS_ERROR_COBROS', () => {
    for (const c of [
      'ABONO_EXCEDE_COBRO',
      'COMISION_NO_CUADRA',
      'COBRO_MONEDA_DISTINTA',
      'COBRO_CONCILIADO',
    ] as const) {
      expect(CODIGO).toContain(`hint = '${c}'`);
      expect(CODIGOS_ERROR_COBROS).toContain(c);
    }
    expect(TOKEN_ABONO_NO_CUADRA).toBe(' [ABONO_NO_CUADRA]');
    expect(CODIGO).toContain(
      `v_token constant text := '${TOKEN_ABONO_NO_CUADRA}'`,
    );
    // TODO hint que lanza la migración lo traduce el API.
    const hints = [
      ...new Set([...CODIGO.matchAll(/hint = '([A-Z_]+)'/g)].map((m) => m[1])),
    ];
    for (const h of hints) {
      expect(CODIGOS_ERROR_COBROS as readonly string[]).toContain(h);
    }
  });
});

describe('neto_de_cobro ↔ netoDeCobro', () => {
  it('el SQL es exactamente la expresión transcrita', () => {
    expect(compacto(funcionSql('fn_neto'))).toBe(
      compacto(`
        select case
                 when round(coalesce(p_monto, 0)
                            - case when coalesce(p_comision, 0) > 0 then p_comision else 0 end, 2) > 0
                   then round(coalesce(p_monto, 0)
                              - case when coalesce(p_comision, 0) > 0 then p_comision else 0 end, 2)
                 else round(coalesce(p_monto, 0), 2)
               end;`),
    );
  });

  it('120 casos de semilla fija + bordes: mismo neto al centavo', () => {
    const r = semilla(20261014);
    const casos: Array<[number | null, number | null]> = [
      [5000, 250],
      [5000, null],
      [100, 150],
      [100, 100],
      [100, -5],
      [11870.24, 0],
      [12495, 624.76],
      [41000.01, 2050],
      [null, null],
      [-500, null],
      [0.01, 0.01],
    ];
    while (casos.length < 120 + 11) {
      const monto = centavos(r, 100_000) * (r() < 0.05 ? -1 : 1);
      const k = r();
      const comision =
        k < 0.3
          ? null
          : k < 0.4
            ? 0
            : k < 0.5
              ? monto
              : centavos(r, monto * 0.2);
      casos.push([monto, comision]);
    }
    for (const [monto, comision] of casos) {
      expect(mic(netoDeCobro(monto, comision))).toBe(netoSql(monto, comision));
    }
  });
});

describe('regla_cobro_cubierto ↔ cubreCobro', () => {
  it('el SQL es exactamente el CASE ordenado transcrito', () => {
    expect(compacto(funcionSql('fn_regla_cobro'))).toBe(
      compacto(`
        select case
                 when coalesce(p_cruzado, false) then true
                 when coalesce(p_n_partes, 0) = 0 then false
                 when round(coalesce(p_neto, 0), 2) <= 0 then true
                 else round(coalesce(p_suma, 0), 2) + 0.000001 >= round(p_neto, 2) - 1.00
               end;`),
    );
  });

  it('120 casos de semilla fija + bordes ($1.00 exacto, un centavo más, neto ≤ 0, cruzado, sin partes)', () => {
    const r = semilla(77);
    const casos: Array<[number, number, boolean, number]> = [
      [3400, 1, false, 1700],
      [3400, 2, false, 3399],
      [3400, 2, false, 3398.99],
      [1000, 1, true, 0],
      [1000, 0, false, 0],
      [0, 1, false, 0],
      [-500, 1, false, 0],
      [38950.01, 1, false, 38950],
      [0.99, 1, false, 0],
      [1.01, 1, false, 0],
    ];
    while (casos.length < 120 + 10) {
      const neto = centavos(r, 80_000);
      const n = Math.floor(r() * 4);
      const cruzado = r() < 0.1;
      const k = r();
      // Alrededor de la frontera neto − 1.00 la mitad de las veces.
      const suma =
        k < 0.5
          ? Math.max(
              0,
              Math.round((neto - 1 + (Math.floor(r() * 5) - 2) / 100) * 100) /
                100,
            )
          : centavos(r, neto * 1.2);
      casos.push([neto, n, cruzado, suma]);
    }
    let fronteras = 0;
    for (const [neto, n, cruzado, suma] of casos) {
      expect(cubreCobro(neto, n, cruzado, suma)).toBe(
        reglaSql(neto, n, cruzado, suma),
      );
      if (Math.abs(suma - (neto - 1)) < 0.025) fronteras += 1;
    }
    // La semilla de verdad prueba la frontera (no solo casos lejanos).
    expect(fronteras).toBeGreaterThan(20);
  });
});

describe('v_cobro_conciliacion ↔ coberturaCobro', () => {
  const VISTA = compacto(
    CODIGO.slice(
      CODIGO.indexOf('create or replace view public.v_cobro_conciliacion'),
      CODIGO.indexOf('comment on view public.v_cobro_conciliacion'),
    ),
  );

  it('las columnas derivadas de la vista son las que espeja coberturaCobro', () => {
    for (const expr of [
      // monto_vinculado
      `case when s.cruzado then public.neto_de_cobro(c.monto, c.comision_banco_monto) else s.suma end as monto_vinculado`,
      // faltante
      `case when public.neto_de_cobro(c.monto, c.comision_banco_monto) <= 0 then 0::numeric when s.cruzado then 0::numeric else greatest(round(public.neto_de_cobro(c.monto, c.comision_banco_monto) - s.suma, 2), 0::numeric) end as faltante`,
      // sobrante
      `case when s.n_partes = 0 or s.cruzado then 0::numeric else greatest(round(s.suma - public.neto_de_cobro(c.monto, c.comision_banco_monto), 2), 0::numeric) end as sobrante`,
      // cubierto
      `public.regla_cobro_cubierto(public.neto_de_cobro(c.monto, c.comision_banco_monto), s.n_partes, s.cruzado, s.suma) as cubierto`,
      // cruzado (una cuenta sin moneda cuenta como otra moneda)
      `coalesce(bool_or(cb.moneda::text is distinct from c.moneda::text), false) as cruzado`,
      // pasarela
      `coalesce(bool_or(coalesce(cb.tipo, '') = 'PASARELA'), false) as pasarela`,
      // suma: solo las partes de SU moneda
      `round(coalesce(sum(p.monto_parte) filter (where cb.moneda::text = c.moneda::text), 0), 2) as suma`,
      // antigüedad
      `array_agg(p.movimiento_id order by m.fecha, m.created_at, p.movimiento_id)`,
    ]) {
      expect(VISTA).toContain(compacto(expr));
    }
  });

  it('120 cobros de semilla fija: la fila de la vista (transcrita) = coberturaCobro', () => {
    const r = semilla(315);
    for (let i = 0; i < 120; i += 1) {
      const monto = centavos(r, 70_000) + 0.01;
      const comision = r() < 0.3 ? centavos(r, monto * 0.15) : null;
      const moneda = r() < 0.8 ? 'MXN' : 'USD';
      const n = Math.floor(r() * 4);
      const partes: ParteCobroBanco[] = [];
      for (let j = 0; j < n; j += 1) {
        const k = r();
        partes.push({
          movimiento_id: `m-${i}-${j}`,
          cobro_id: `c-${i}`,
          monto_parte: centavos(r, monto * 0.8) + 0.01,
          moneda_cuenta:
            k < 0.85
              ? moneda
              : k < 0.95
                ? moneda === 'MXN'
                  ? 'USD'
                  : 'MXN'
                : null,
          pasarela: r() < 0.15,
          fecha: `2026-09-${String(10 + Math.floor(r() * 5)).padStart(2, '0')}`,
          created_at: '2026-10-01T12:00:00Z',
          monto_abono: null,
          cobros_n: 1,
          cuenta_bancaria_id: null,
          cuenta_alias: null,
        });
      }
      const cob = coberturaCobro(
        { monto, moneda, comision_banco_monto: comision },
        partes,
      );
      // --- la vista, transcrita en aritmética exacta ---
      const neto = netoSql(monto, comision);
      const cruzado = partes.some((p) => (p.moneda_cuenta ?? null) !== moneda);
      const pasarela = partes.some((p) => p.pasarela);
      const suma = round2(
        partes
          .filter((p) => p.moneda_cuenta !== null && p.moneda_cuenta === moneda)
          .reduce((a, p) => a + mic(p.monto_parte), 0n),
      );
      const faltante =
        neto <= 0n || cruzado
          ? 0n
          : round2(neto - suma) > 0n
            ? round2(neto - suma)
            : 0n;
      const sobrante =
        partes.length === 0 || cruzado
          ? 0n
          : round2(suma - neto) > 0n
            ? round2(suma - neto)
            : 0n;
      expect(mic(cob.neto)).toBe(neto);
      expect(cob.n_partes).toBe(partes.length);
      expect(cob.cruzado).toBe(cruzado);
      expect(cob.pasarela).toBe(pasarela);
      expect(mic(cob.suma)).toBe(suma);
      expect(mic(cob.monto_vinculado)).toBe(cruzado ? neto : suma);
      expect(mic(cob.faltante)).toBe(faltante);
      expect(mic(cob.sobrante)).toBe(sobrante);
      expect(cob.cubierto).toBe(
        reglaSql(
          Number(neto) / 1e6,
          partes.length,
          cruzado,
          Number(suma) / 1e6,
        ),
      );
    }
  });
});
