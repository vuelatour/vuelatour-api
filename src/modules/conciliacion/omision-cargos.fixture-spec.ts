/**
 * EMULACIÓN EN MEMORIA de la migración 20261014000002 (14-oct-2026, API
 * 0.0.77, invariantes 75 y 76) para los PostgREST falsos de los specs.
 * Fuera del build (`*spec.ts`) y de jest (no termina en `.spec.ts`): patrón
 * `*.fixture-spec.ts` del repo.
 *
 * Reproduce, sobre las tablas en memoria, lo que hacen las RPC de la BD:
 * - `conciliacion_clasificacion_omitido` (busca / crea / reactiva la
 *   canónica por `lower(nombre)`),
 * - `conciliacion_omitir_movimientos` y `conciliacion_quitar_omision` (todo
 *   o nada, con el CASE del estado y las notas del UPDATE),
 * - `conciliacion_ligar_cargos_a_gasto` (validaciones en el orden de la RPC
 *   y escritura de UNA parte por cargo, con los espejos B / I de
 *   `conciliacion-partes.fixture-spec`),
 * - el trigger `trg_mov_bancario_omitido_sin_ligas` sobre la RPC G de un
 *   cargo (un omitido no se liga),
 * con los errores en la forma de PostgREST (`code 23514`, `message 'CODIGO:
 * texto'`, `hint 'CODIGO'`, `details` = JSON en texto).
 *
 * NO es la fuente de la regla (esa es la BD; sus espejos puros son
 * `omision.util.ts` y `cargos-a-gasto.util.ts`): es el doble de prueba del
 * contrato. `sinMigracion` ⇒ PGRST202 en las 4 RPC (y sin trigger).
 */
import {
  errorBd,
  recalcularGasto,
  RPC_LIGAR,
  rpcPartes,
  sincronizarMovimiento,
  TABLA_PARTES,
  vistaConciliacion,
  type Row,
  type Tablas,
} from './conciliacion-partes.fixture-spec';

export const CANONICA = 'Omitido de la conciliación';
export const PREFIJO = 'Omitido de la conciliación: ';
export const RPC_OMITIR = 'conciliacion_omitir_movimientos';
export const RPC_QUITAR = 'conciliacion_quitar_omision';
export const RPC_CARGOS = 'conciliacion_ligar_cargos_a_gasto';
export const RPC_CANONICA = 'conciliacion_clasificacion_omitido';

const MEDIOS = ['TARJETA_CORP', 'TRANSFERENCIA', 'PAYWISE', 'DOMICILIADO'];

export interface OpcionesOmision {
  /** Migración NO aplicada: PGRST202 en las 4 RPC (y sin trigger). */
  sinMigracion?: boolean;
  /** Error inyectado ANTES de emular (carrera, interbloqueo…). */
  fallo?: (nombre: string, args: Row) => unknown;
  /** Bitácora de llamadas. */
  llamadas?: Array<{ nombre: string; args: Row }>;
}

const c2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
/** Texto de una celda (sin «[object Object]»). */
const txt = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const lleno = (v: unknown) =>
  typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined;

function movs(db: Tablas): Row[] {
  if (!db.movimiento_bancario) db.movimiento_bancario = [];
  return db.movimiento_bancario;
}

function idCanonica(db: Tablas): string | null {
  const c = (db.conciliacion_clasificacion ?? []).find(
    (x) =>
      txt(x.nombre).toLocaleLowerCase('es-MX') ===
      CANONICA.toLocaleLowerCase('es-MX'),
  );
  return typeof c?.id === 'string' ? c.id : null;
}

/** 1) Busca / crea / reactiva la canónica. */
export function canonica(db: Tablas, actor: string | null): string {
  if (!db.conciliacion_clasificacion) db.conciliacion_clasificacion = [];
  let id = idCanonica(db);
  if (!id) {
    id = `clasif-omitido-${db.conciliacion_clasificacion.length + 1}`;
    db.conciliacion_clasificacion.push({
      id,
      nombre: CANONICA,
      activo: true,
      created_by: actor,
    });
  }
  const fila = db.conciliacion_clasificacion.find((x) => x.id === id)!;
  if (fila.activo === false) {
    fila.activo = true;
    fila.updated_at = '2026-10-14T12:00:00Z';
  }
  return id;
}

const tieneDevolucion = (db: Tablas, id: unknown) =>
  movs(db).some((r) => r.reverso_de_id === id);

const ocupado = (db: Tablas, m: Row) =>
  m.conciliado === true ||
  (Number(m.gastos_n) || 0) > 0 ||
  (Number(m.cobros_n) || 0) > 0 ||
  [
    m.gasto_id,
    m.cobro_id,
    m.cobro_grupo_id,
    m.ingreso_id,
    m.clasificacion_id,
    m.reverso_de_id,
  ].some(lleno) ||
  tieneDevolucion(db, m.id);

/** CASE del estado (omitir y ligar cargos). */
function estado(db: Tablas, m: Row, idOmitido: string | null): string {
  if ((Number(m.gastos_n) || 0) > 0 || lleno(m.gasto_id)) return 'CON_GASTO';
  if ((Number(m.cobros_n) || 0) > 0 || lleno(m.cobro_id)) return 'CON_COBRO';
  if (lleno(m.cobro_grupo_id)) return 'CON_SOBRE';
  if (lleno(m.ingreso_id)) return 'CON_INGRESO';
  if (lleno(m.reverso_de_id) || tieneDevolucion(db, m.id)) return 'REVERSO';
  if (idOmitido && m.clasificacion_id === idOmitido) return 'OMITIDO';
  if (lleno(m.clasificacion_id)) return 'CLASIFICADO';
  return 'CONCILIADO';
}

const fila = (db: Tablas, m: Row, est: string): Row => ({
  id: m.id,
  fecha: m.fecha,
  tipo: m.tipo,
  monto: m.monto,
  descripcion: txt(m.descripcion).slice(0, 80),
  estado: est,
});

const porFechaId = (a: Row, b: Row) =>
  String(a.fecha) === String(b.fecha)
    ? String(a.id) < String(b.id)
      ? -1
      : 1
    : String(a.fecha) < String(b.fecha)
      ? -1
      : 1;

function lista(
  args: Row,
  min: number,
  max: number,
): { ids: string[]; error: unknown } {
  const ids = (args.p_movimiento_ids as unknown[] | null) ?? [];
  if (ids.length < min || ids.length > max || ids.some((x) => x == null)) {
    return {
      ids: [],
      error: errorBd('LOTE_INVALIDO', `manda de ${min} a ${max}`, {
        n: ids.length,
      }),
    };
  }
  if (new Set(ids).size !== ids.length) {
    return {
      ids: [],
      error: errorBd(
        'LOTE_INVALIDO',
        'la lista trae el mismo movimiento repetido',
        {
          n: ids.length,
          distintos: new Set(ids).size,
        },
      ),
    };
  }
  return { ids: ids.map(String), error: null };
}

function faltantes(db: Tablas, ids: string[]): unknown {
  const faltan = ids.filter((x) => !movs(db).some((m) => m.id === x)).sort();
  return faltan.length > 0
    ? errorBd('MOVIMIENTO_NO_EXISTE', `${faltan.length} ya no existen`, {
        ids: faltan,
      })
    : null;
}

function omitir(db: Tablas, args: Row): { data: unknown; error: unknown } {
  const { ids, error } = lista(args, 1, 200);
  if (error) return { data: null, error };
  const linea = args.p_linea;
  if (
    typeof linea !== 'string' ||
    !linea.startsWith(PREFIJO) ||
    linea.includes('\n') ||
    linea.includes('\r') ||
    linea.length > 500
  ) {
    return {
      data: null,
      error: errorBd(
        'OMISION_INVALIDA',
        'la línea no tiene la forma canónica',
        {
          largo: typeof linea === 'string' ? linea.length : 0,
        },
      ),
    };
  }
  const falta = faltantes(db, ids);
  if (falta) return { data: null, error: falta };
  const actor = (args.p_actor as string | null) ?? null;
  const clasif = canonica(db, actor);
  const elegidos = movs(db).filter((m) => ids.includes(String(m.id)));
  const ocupados = elegidos
    .filter((m) => ocupado(db, m))
    .sort(porFechaId)
    .map((m) => fila(db, m, estado(db, m, clasif)));
  if (ocupados.length > 0) {
    return {
      data: null,
      error: errorBd(
        'MOVIMIENTO_NO_PENDIENTE',
        `${ocupados.length} de ${ids.length} ya no están pendientes`,
        { movimientos: ocupados },
      ),
    };
  }
  for (const m of elegidos) {
    m.clasificacion_id = clasif;
    m.conciliado = true;
    m.notas =
      m.notas == null || m.notas === '' ? linea : `${linea}\n${txt(m.notas)}`;
    m.updated_by = actor ?? m.updated_by;
  }
  return {
    data: {
      omitidos: ids.length,
      clasificacion_id: clasif,
      movimiento_ids: ids,
    },
    error: null,
  };
}

function quitar(db: Tablas, args: Row): { data: unknown; error: unknown } {
  const { ids, error } = lista(args, 1, 200);
  if (error) return { data: null, error };
  const falta = faltantes(db, ids);
  if (falta) return { data: null, error: falta };
  const clasif = idCanonica(db);
  const elegidos = movs(db).filter((m) => ids.includes(String(m.id)));
  const otros = elegidos
    .filter((m) => !clasif || m.clasificacion_id !== clasif)
    .sort(porFechaId)
    .map((m) =>
      fila(
        db,
        m,
        m.conciliado !== true
          ? 'PENDIENTE'
          : lleno(m.clasificacion_id)
            ? 'CLASIFICADO'
            : 'CONCILIADO',
      ),
    );
  if (otros.length > 0) {
    return {
      data: null,
      error: errorBd(
        'MOVIMIENTO_NO_OMITIDO',
        `${otros.length} de ${ids.length} ya no están omitidos`,
        { movimientos: otros },
      ),
    };
  }
  const actor = (args.p_actor as string | null) ?? null;
  for (const m of elegidos) {
    m.clasificacion_id = null;
    m.conciliado = false;
    const n = m.notas;
    if (typeof n === 'string' && n.startsWith(PREFIJO)) {
      const i = n.indexOf('\n');
      m.notas = i < 0 ? null : n.slice(i + 1) || null;
    }
    m.updated_by = actor ?? m.updated_by;
  }
  return {
    data: { restaurados: ids.length, movimiento_ids: ids },
    error: null,
  };
}

function monedaCuenta(db: Tablas, m: Row): string | null {
  const c = (db.cuenta_bancaria ?? []).find(
    (x) => x.id === m.cuenta_bancaria_id,
  );
  return typeof c?.moneda === 'string' ? c.moneda : null;
}

function ligarCargos(db: Tablas, args: Row): { data: unknown; error: unknown } {
  const gastoId = String(args.p_gasto_id);
  const { ids, error } = lista(args, 2, 50);
  if (error) return { data: null, error };
  const falta = faltantes(db, ids);
  if (falta) return { data: null, error: falta };
  const elegidos = movs(db)
    .filter((m) => ids.includes(String(m.id)))
    .sort(porFechaId);
  const abonos = elegidos.filter((m) => m.tipo !== 'CARGO');
  if (abonos.length > 0) {
    return {
      data: null,
      error: errorBd('SOLO_CARGOS', `${abonos.length} son abonos`, {
        abonos: abonos.map((m) => ({
          id: m.id,
          fecha: m.fecha,
          monto: m.monto,
          descripcion: txt(m.descripcion).slice(0, 80),
        })),
      }),
    };
  }
  const ya = elegidos
    .filter((m) => Number(m.gastos_n) === 1 && m.gasto_id === gastoId)
    .map((m) => String(m.id));
  const nuevos = ids.filter((x) => !ya.includes(x)).sort();
  const idOmitido = idCanonica(db);
  const ocupados = elegidos
    .filter((m) => nuevos.includes(String(m.id)) && ocupado(db, m))
    .map((m) => fila(db, m, estado(db, m, idOmitido)));
  if (ocupados.length > 0) {
    return {
      data: null,
      error: errorBd('MOVIMIENTO_NO_PENDIENTE', `${ocupados.length} ocupados`, {
        gasto_id: gastoId,
        movimientos: ocupados,
      }),
    };
  }
  const monedas = [
    ...new Set(elegidos.map((m) => monedaCuenta(db, m) ?? '?')),
  ].sort();
  if (monedas.length !== 1) {
    return {
      data: null,
      error: errorBd('CARGOS_MONEDA_DISTINTA', monedas.join(' y '), {
        monedas,
      }),
    };
  }
  const moneda = monedas[0];
  const g = (db.gasto ?? []).find((x) => x.id === gastoId);
  if (!g) {
    return {
      data: null,
      error: errorBd('GASTO_NO_EXISTE', 'el gasto ya no existe', {
        gasto_id: gastoId,
      }),
    };
  }
  const montoGasto = c2(Math.abs(Number(g.monto) || 0));
  if (String(g.moneda) !== moneda) {
    return {
      data: null,
      error: errorBd('LOTE_MONEDA_DISTINTA', 'moneda distinta', {
        gasto_id: gastoId,
        moneda_gasto: g.moneda,
        moneda_cuenta: moneda,
      }),
    };
  }
  if (!MEDIOS.includes(String(g.medio_pago))) {
    return {
      data: null,
      error: errorBd('GASTO_NO_BANCARIO', 'no pasa por el banco', {
        gasto_id: gastoId,
        medio_pago: g.medio_pago,
      }),
    };
  }
  if (!db[TABLA_PARTES]) db[TABLA_PARTES] = [];
  const otras = db[TABLA_PARTES].filter(
    (p) => p.gasto_id === gastoId && !nuevos.includes(String(p.movimiento_id)),
  );
  if (otras.some((p) => String(p.moneda) !== String(g.moneda))) {
    return {
      data: null,
      error: errorBd('GASTO_YA_CUBIERTO', 'cubierto 1 a 1 en otra moneda', {
        motivo: 'MONEDA_DISTINTA',
        gasto_id: gastoId,
        moneda: g.moneda,
        monto_gasto: montoGasto,
      }),
    };
  }
  const vinculado = c2(otras.reduce((a, p) => a + Number(p.monto_parte), 0));
  const respuesta = (idempotente: boolean, nuevosIds: string[]) => {
    const v = vistaConciliacion(db).find((x) => x.gasto_id === gastoId)!;
    return {
      gasto_id: gastoId,
      idempotente,
      nuevos: nuevosIds,
      partes: db[TABLA_PARTES].filter(
        (p) => p.gasto_id === gastoId && ids.includes(String(p.movimiento_id)),
      )
        .sort((a, b) =>
          String(a.movimiento_id) < String(b.movimiento_id) ? -1 : 1,
        )
        .map((p) => ({
          movimiento_id: p.movimiento_id,
          monto_parte: p.monto_parte,
          moneda: p.moneda,
        })),
      gasto_estado: {
        monto: montoGasto,
        moneda: g.moneda,
        n_partes: v.n_partes,
        monto_vinculado: v.monto_vinculado,
        faltante: v.faltante,
        cubierto: v.cubierto,
      },
    };
  };
  if (nuevos.length === 0) return { data: respuesta(true, []), error: null };
  const suma = c2(
    elegidos
      .filter((m) => nuevos.includes(String(m.id)))
      .reduce((a, m) => a + Math.abs(Number(m.monto) || 0), 0),
  );
  if (vinculado + suma > montoGasto + 1 + 0.000001) {
    return {
      data: null,
      error: errorBd('CARGOS_EXCEDEN_GASTO', 'se pasan', {
        gasto_id: gastoId,
        moneda: g.moneda,
        monto_gasto: montoGasto,
        suma_ligada: vinculado,
        faltante: Math.max(c2(montoGasto - vinculado), 0),
        suma_cargos: suma,
        excedente: c2(vinculado + suma - montoGasto),
        tolerancia: 1,
      }),
    };
  }
  const actor = (args.p_actor as string | null) ?? null;
  for (const id of nuevos) {
    const m = elegidos.find((x) => x.id === id)!;
    db[TABLA_PARTES].push({
      movimiento_id: id,
      gasto_id: gastoId,
      monto_parte: c2(Math.abs(Number(m.monto) || 0)),
      moneda,
      created_at: '2026-10-14T12:00:00Z',
      created_by: actor,
    });
    sincronizarMovimiento(db, id, actor);
  }
  recalcularGasto(db, gastoId, actor);
  return { data: respuesta(false, nuevos), error: null };
}

/** El trigger `trg_mov_bancario_omitido_sin_ligas` sobre la RPC G. */
function omitidoEnG(db: Tablas, args: Row): unknown {
  const ids = (args.p_gasto_ids as unknown[] | null) ?? [];
  if (ids.length === 0) return null;
  const m = movs(db).find((x) => x.id === args.p_movimiento_id);
  const clasif = idCanonica(db);
  if (!m || !clasif || m.clasificacion_id !== clasif) return null;
  return errorBd(
    'MOVIMIENTO_OMITIDO',
    'el movimiento se omitió de la conciliación; deshaz la omisión antes de vincularlo',
    { movimiento_id: m.id },
  );
}

/**
 * Las RPC de la migración 20261014000002 (y el trigger sobre G). Para
 * cualquier otra RPC devuelve `null` (el PostgREST falso cae a
 * `rpcPartes`).
 */
export function rpcOmisionCargos(
  db: Tablas,
  nombre: string,
  args: Row,
  opts: OpcionesOmision = {},
): { data: unknown; error: unknown } | null {
  const propias = [RPC_OMITIR, RPC_QUITAR, RPC_CARGOS, RPC_CANONICA];
  if (propias.includes(nombre)) {
    opts.llamadas?.push({ nombre, args });
    if (opts.sinMigracion) {
      return {
        data: null,
        error: {
          code: 'PGRST202',
          message: `Could not find the function public.${nombre}(…) in the schema cache`,
        },
      };
    }
    const inyectado = opts.fallo?.(nombre, args);
    if (inyectado) return { data: null, error: inyectado };
    if (nombre === RPC_OMITIR) return omitir(db, args);
    if (nombre === RPC_QUITAR) return quitar(db, args);
    if (nombre === RPC_CARGOS) return ligarCargos(db, args);
    return {
      data: canonica(db, (args.p_actor as string | null) ?? null),
      error: null,
    };
  }
  if (nombre === RPC_LIGAR && !opts.sinMigracion) {
    const err = omitidoEnG(db, args);
    if (err) return { data: null, error: err };
    return rpcPartes(db, nombre, args);
  }
  return null;
}
