import * as fs from 'fs';
import * as path from 'path';
import {
  agregadosDeItem,
  round,
  ventaDeSalida,
} from './inventario-cardex.util';
import {
  cardexProd25sep,
  TC_MIGRACION,
  todosLosMovimientos,
} from './cardex-prod-25sep.fixture-spec';

/**
 * MIGRACIÓN DE DATOS `20260925000003_inventario_tc_oficial_movimientos.sql`
 * ⇄ LA REGLA DEL API 0.0.36.
 *
 * La migración pone el T.C. oficial de su día a los 77 movimientos USD sin
 * T.C. (63 entradas del 29-ago a 17.0115; 4 entradas y 10 salidas del 01-sep
 * a 17.0077) y su dry-run exige totales en pesos escritos a mano. Este spec
 * LEE el archivo y ata esos literales —y la tabla de las 10 salidas, fila por
 * fila— al util del inventario con el cardex REAL de prod. Si alguien edita un
 * número del SQL o cambia la regla en TS, se pone rojo.
 */

const MIGRACION = path.join(
  __dirname,
  '../../../supabase/migrations/20260925000003_inventario_tc_oficial_movimientos.sql',
);
const SQL = fs.readFileSync(MIGRACION, 'utf8');

/** Lo que no es comentario (el cuerpo que se ejecuta). */
const CUERPO = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

interface FilaSalida {
  movId: string;
  cantidad: number;
  costo: number;
  venta: number;
  ventaUsd: number;
  ventaMxn: number;
  costoMxn: number;
  utilidadMxn: number;
  utilidadUsd: number;
}

function leerSalidas(): FilaSalida[] {
  const ini = SQL.indexOf('-- SALIDAS:INICIO');
  const fin = SQL.indexOf('-- SALIDAS:FIN', ini);
  if (ini < 0 || fin < ini)
    throw new Error('Sin marcas SALIDAS en la migración');
  const re =
    /^--\s+([0-9a-f-]{36})\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/gm;
  const out: FilaSalida[] = [];
  for (const m of SQL.slice(ini, fin).matchAll(re)) {
    out.push({
      movId: m[1],
      cantidad: Number(m[2]),
      costo: Number(m[3]),
      venta: Number(m[4]),
      ventaUsd: Number(m[5]),
      ventaMxn: Number(m[6]),
      costoMxn: Number(m[7]),
      utilidadMxn: Number(m[8]),
      utilidadUsd: Number(m[9]),
    });
  }
  return out;
}

const SALIDAS = leerSalidas();

describe('migración 20260925000003 ⇄ regla del API', () => {
  it('la población: USD sin T.C. REGISTRADOS antes del 23-sep Cancún, con guarda por grupo (≤ 63 / 4 / 10)', () => {
    const corte = "m.created_at < timestamptz '2026-09-23 00:00:00-05'";
    expect(CUERPO).toContain(corte);
    expect(CUERPO).toContain('m.tc_usd_mxn is null');
    expect(CUERPO).toContain(
      "(m.moneda::text = 'USD' or coalesce(m.venta_moneda::text, '') = 'USD')",
    );
    // Ventana de 7 días: la de TipoCambioService.oficialDetallePara.
    expect(CUERPO).toContain(
      'o.fecha between m.fecha_movimiento - 7 and m.fecha_movimiento',
    );
    expect(CUERPO).toMatch(/fecha_movimiento = date '2026-08-29'\) > 63/);
    expect(CUERPO).toMatch(/fecha_movimiento = date '2026-09-01'\) > 4/);
    expect(CUERPO).toMatch(/fecha_movimiento = date '2026-09-01'\) > 10/);
    expect(CUERPO).toContain('v_pend > 77');
    // T.C. por grupo = el que el fixture (y el util) usa para cada fecha.
    expect(CUERPO).toContain(`tc = ${TC_MIGRACION['2026-08-29']}`);
    expect(CUERPO).toContain(`tc = ${TC_MIGRACION['2026-09-01']}`);
  });

  it('jamás escribe en gasto (ni monto ni tc_gasto) — solo inventario_movimiento.tc_usd_mxn y la descripción de la config', () => {
    expect(CUERPO).not.toMatch(/update\s+public\.gasto\b/i);
    expect(CUERPO).not.toMatch(/insert\s+into\s+public\.gasto\b/i);
    expect(CUERPO).not.toMatch(/delete\s+from\s+public\.gasto\b/i);
    const updates = [...CUERPO.matchAll(/update\s+public\.(\w+)/gi)].map(
      (m) => m[1],
    );
    expect(new Set(updates)).toEqual(
      new Set(['inventario_movimiento', 'configuracion_sistema']),
    );
    expect(CUERPO).toMatch(/set tc_usd_mxn = t\.tc/);
  });

  it('el ROLLBACK (comentado) usa el MISMO corte de población', () => {
    const rb = SQL.slice(SQL.indexOf('-- ROLLBACK'));
    expect(rb).toContain("created_at < timestamptz '2026-09-23 00:00:00-05'");
    expect(rb).toContain('tc_usd_mxn in (17.0115, 17.0077)');
    expect(rb.split('\n').every((l) => !l.trim() || l.startsWith('--'))).toBe(
      true,
    );
  });

  it('los literales del DRY-RUN salen del util con el cardex real', () => {
    for (const lit of [
      '45524.17',
      '36419.10',
      '9105.07',
      '1351908.88',
      '18196.87',
      'DRYRUN_OK',
    ]) {
      expect(SQL).toContain(lit);
    }
    // Compras en pesos (T.C. del día de la compra), por fecha.
    const compras = new Map<string, number>();
    let ventas = 0;
    let costo = 0;
    for (const m of todosLosMovimientos({ tcOficial: true })) {
      if (m.moneda !== 'USD') continue;
      if (m.tipo === 'ENTRADA') {
        const t = round(
          round(Number(m.cantidad) * Number(m.costo_unitario_usd), 2) *
            Number(m.tc_usd_mxn),
          2,
        );
        compras.set(
          m.fecha_movimiento,
          round((compras.get(m.fecha_movimiento) ?? 0) + t, 2),
        );
      } else {
        const v = ventaDeSalida(m);
        ventas = round(ventas + (v.ventaTotalMxn as number), 2);
        costo = round(costo + (v.costoMxn as number), 2);
      }
    }
    expect(compras.get('2026-08-29')).toBe(1351908.88);
    expect(compras.get('2026-09-01')).toBe(18196.87);
    expect(ventas).toBe(45524.17);
    expect(costo).toBe(36419.1);
    expect(round(ventas - costo, 2)).toBe(9105.07);
  });

  it('la tabla de las 10 salidas, FILA POR FILA, es la que calcula ventaDeSalida con el T.C. 17.0077', () => {
    expect(SALIDAS).toHaveLength(10);
    const porId = new Map(
      todosLosMovimientos({ tcOficial: true }).map((m) => [m.id, m]),
    );
    for (const f of SALIDAS) {
      const m = porId.get(f.movId)!;
      expect(m).toBeDefined();
      expect(m.tipo).toBe('SALIDA');
      expect(Number(m.tc_usd_mxn)).toBe(17.0077);
      expect(Number(m.cantidad)).toBe(f.cantidad);
      expect(Number(m.costo_unitario_usd)).toBe(f.costo);
      expect(Number(m.venta_unitaria)).toBe(f.venta);
      const v = ventaDeSalida(m);
      expect({
        id: f.movId,
        ventaUsd: v.ventaTotal,
        ventaMxn: v.ventaTotalMxn,
        costoMxn: v.costoMxn,
        utilidadMxn: v.gananciaMxn,
        utilidadUsd: v.gananciaUsdOriginal,
      }).toEqual({
        id: f.movId,
        ventaUsd: f.ventaUsd,
        ventaMxn: f.ventaMxn,
        costoMxn: f.costoMxn,
        utilidadMxn: f.utilidadMxn,
        utilidadUsd: f.utilidadUsd,
      });
    }
    const suma = (k: keyof FilaSalida) =>
      round(
        SALIDAS.reduce((s, f) => s + (f[k] as number), 0),
        2,
      );
    expect(suma('ventaMxn')).toBe(45524.17);
    expect(suma('costoMxn')).toBe(36419.1);
    expect(suma('utilidadMxn')).toBe(9105.07);
    expect(suma('utilidadUsd')).toBe(535.35);
  });

  it('ANTES de aplicarla (sin T.C.) la utilidad sigue en dólares — el API 0.0.36 tolera la migración pendiente', () => {
    let usd = 0;
    let mxn: number | null = null;
    for (const movs of cardexProd25sep().values()) {
      const a = agregadosDeItem(movs);
      usd = round(usd + (a.utilidad_usd ?? 0), 2);
      if (a.utilidad_mxn != null) mxn = round((mxn ?? 0) + a.utilidad_mxn, 2);
    }
    expect(usd).toBe(535.35);
    expect(mxn).toBeNull();
  });
});
