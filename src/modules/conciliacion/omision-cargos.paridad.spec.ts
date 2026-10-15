import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MIGRACION_OMISION_CARGOS,
  RPC_SONDA_OMISION_CARGOS,
  RPCS_OMISION_CARGOS,
} from '../../common/omision-cargos-disponible.util';
import {
  CARGOS_A_GASTO_MAX,
  CARGOS_A_GASTO_MIN,
  CODIGOS_ERROR_CARGOS_GASTO,
} from './cargos-a-gasto.util';
import { TOLERANCIA_CONCILIACION } from './conciliacion-parcial.util';
import { MEDIOS_BANCARIOS } from './gastos-candidatos.util';
import {
  CLASIFICACION_OMITIDO,
  CODIGOS_ERROR_OMISION,
  COLUMNAS_TRIGGER_OMITIDO,
  LINEA_OMISION_MAX,
  OMITIR_MAX,
  PREFIJO_LINEA_OMISION,
} from './omision.util';

/**
 * PARIDAD API ↔ migración 20261014000002 (14-oct-2026, invariantes 75 y
 * 76): lee el ARCHIVO SQL y congela los espejos. Si alguien cambia un lado
 * sin el otro, esto truena en pruebas y no en el cierre.
 */
const ARCHIVO = join(
  __dirname,
  '../../../supabase/migrations/20261014000002_conciliacion_omitir_y_cargos_a_gasto.sql',
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

/** Cuerpo de UNA función (`$tag$ … $tag$`). */
function cuerpoDe(tag: string): string {
  const ini = CODIGO.indexOf(`as $${tag}$`);
  const fin = CODIGO.indexOf(`end $${tag}$`);
  expect(ini).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(ini);
  return CODIGO.slice(ini, fin);
}

/** Los `hint = 'CODIGO'` que lanza un cuerpo. */
function hints(cuerpo: string): string[] {
  return [
    ...new Set([...cuerpo.matchAll(/hint = '([A-Z_]+)'/g)].map((m) => m[1])),
  ];
}

describe('migración 20261014000002 — forma del archivo', () => {
  it('es la migración que sondea el API y tiene sus marcas de cuerpo', () => {
    expect(MIGRACION_OMISION_CARGOS).toBe('20261014000002');
    expect(CUERPO.length).toBeGreaterThan(1000);
  });

  it('sin palabras que el MCP declina ni permisos (ni en comentarios)', () => {
    expect(SQL).not.toMatch(/\b(drop|delete|revoke|grant|truncate)\b/i);
  });

  it('TODAS las funciones son SECURITY INVOKER con search_path vacío', () => {
    const funciones = [
      ...CODIGO.matchAll(
        /create or replace function public\.([a-z_]+)\(([\s\S]*?)\n(?:as|begin)/g,
      ),
    ];
    expect(funciones.map((m) => m[1]).sort()).toEqual(
      [...RPCS_OMISION_CARGOS, 'tg_mov_bancario_omitido_sin_ligas'].sort(),
    );
    for (const f of funciones) {
      expect(f[2]).toMatch(/security invoker/);
      expect(f[2]).toMatch(/set search_path = ''/);
    }
    expect(CODIGO).not.toMatch(/security definer/i);
  });

  it('todo con «create or replace» (idempotente sin quitar nada) y recarga el esquema', () => {
    expect(CODIGO).toContain(
      'create or replace trigger trg_mov_bancario_omitido_sin_ligas',
    );
    expect(CODIGO).not.toMatch(/create (function|trigger)/);
    expect(SQL).toMatch(/pg_notify\('pgrst', 'reload schema'\)/);
  });
});

describe('migración 20261014000002 — espejos del API', () => {
  it('nombre canónico y prefijo de la línea', () => {
    expect(CODIGO).toContain(`lower('${CLASIFICACION_OMITIDO}')`);
    expect(CODIGO).toContain(`values ('${CLASIFICACION_OMITIDO}', p_actor)`);
    expect(CODIGO).toContain(
      `starts_with(p_linea, '${PREFIJO_LINEA_OMISION}')`,
    );
    expect(CODIGO).toContain(
      `starts_with(m.notas, '${PREFIJO_LINEA_OMISION}')`,
    );
    expect(cuerpoDe('fn_omitir')).toContain(
      `char_length(p_linea) > ${LINEA_OMISION_MAX}`,
    );
  });

  it('topes de las listas: 1..200 (omitir y deshacer) y 2..50 (cargos)', () => {
    for (const tag of ['fn_omitir', 'fn_quitar']) {
      expect(cuerpoDe(tag)).toContain(`v_n < 1 or v_n > ${OMITIR_MAX}`);
    }
    expect(cuerpoDe('fn_cargos')).toContain(
      `v_n < ${CARGOS_A_GASTO_MIN} or v_n > ${CARGOS_A_GASTO_MAX}`,
    );
  });

  it('medios bancarios en el MISMO orden que MEDIOS_BANCARIOS', () => {
    const m = /array\[('[A-Z_]+'(?:, '[A-Z_]+')*)\]/.exec(
      cuerpoDe('fn_cargos'),
    );
    expect(m).not.toBeNull();
    const sql = m![1].split(', ').map((x) => x.replace(/'/g, ''));
    expect(sql).toEqual([...MEDIOS_BANCARIOS]);
  });

  it('tolerancia por gasto = TOLERANCIA_CONCILIACION', () => {
    expect(TOLERANCIA_CONCILIACION).toBe(1);
    expect(cuerpoDe('fn_cargos')).toContain('v_g.monto + 1.00 + 0.000001');
    expect(cuerpoDe('fn_cargos')).toContain("'tolerancia', 1.00");
  });

  it('las 7 columnas del trigger = COLUMNAS_TRIGGER_OMITIDO', () => {
    const m = /before update of ([a-z_, ]+)\n/.exec(CODIGO);
    expect(m).not.toBeNull();
    expect(m![1].split(',').map((c) => c.trim())).toEqual([
      ...COLUMNAS_TRIGGER_OMITIDO,
    ]);
    expect(CODIGO).toContain('when (old.clasificacion_id is not null)');
  });

  it('la sonda llama la RPC con los nombres de parámetros de la BD', () => {
    expect(RPC_SONDA_OMISION_CARGOS).toBe('conciliacion_omitir_movimientos');
    expect(CODIGO).toMatch(
      /function public\.conciliacion_omitir_movimientos\(\s*p_movimiento_ids uuid\[\],\s*p_linea text,\s*p_actor uuid\s*\)/,
    );
    expect(CODIGO).toMatch(
      /function public\.conciliacion_quitar_omision\(\s*p_movimiento_ids uuid\[\],\s*p_actor uuid\s*\)/,
    );
    expect(CODIGO).toMatch(
      /function public\.conciliacion_ligar_cargos_a_gasto\(\s*p_gasto_id uuid,\s*p_movimiento_ids uuid\[\],\s*p_actor uuid\s*\)/,
    );
  });

  it('el API traduce TODOS los códigos que lanzan las RPC y el trigger', () => {
    const omision = [
      ...hints(cuerpoDe('fn_omitir')),
      ...hints(cuerpoDe('fn_quitar')),
      ...hints(cuerpoDe('fn_omitido_ligas')),
    ];
    for (const c of omision) {
      expect(CODIGOS_ERROR_OMISION as readonly string[]).toContain(c);
    }
    for (const c of [
      ...hints(cuerpoDe('fn_cargos')),
      ...hints(cuerpoDe('fn_omitido_ligas')),
    ]) {
      expect(CODIGOS_ERROR_CARGOS_GASTO as readonly string[]).toContain(c);
    }
    expect(hints(cuerpoDe('fn_omitido_ligas'))).toEqual(['MOVIMIENTO_OMITIDO']);
  });

  it('el CASE del estado tiene el MISMO orden que estadoMovimientoParaOmitir', () => {
    const orden = (cuerpo: string) =>
      [...cuerpo.matchAll(/then '([A-Z_]+)'/g)].map((m) => m[1]);
    const esperado = [
      'CON_GASTO',
      'CON_COBRO',
      'CON_SOBRE',
      'CON_INGRESO',
      'REVERSO',
      'OMITIDO',
      'CLASIFICADO',
    ];
    expect(orden(cuerpoDe('fn_omitir')).slice(0, 7)).toEqual(esperado);
    expect(orden(cuerpoDe('fn_cargos')).slice(0, 7)).toEqual(esperado);
  });
});
