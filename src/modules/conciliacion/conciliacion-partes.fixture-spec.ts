/**
 * EMULACIÓN EN MEMORIA de la migración 20261002000002 (1 cargo ↔ N gastos)
 * para los PostgREST falsos de los specs. Fuera del build (`*spec.ts`) y de
 * jest (no termina en `.spec.ts`): patrón `*.fixture-spec.ts` del repo.
 *
 * Reproduce, sobre `db.movimiento_bancario`, `db.movimiento_bancario_gasto`,
 * `db.gasto` y `db.cuenta_bancaria`, lo que hace la BD:
 * - G `conciliacion_ligar_cargo_gastos` (validación A + escritura como DIFF),
 * - H `conciliacion_desligar_cargo_gastos`,
 * - B (espejo `gasto_id`, `gastos_n`, `conciliado`, `clasificacion_id`),
 * - I `recalcular_gasto_conciliado` (CASE ordenado + `tc_gasto`),
 * - la vista `v_gasto_conciliacion` (calculada en cada lectura),
 * con los errores en la forma de PostgREST: `code 23514`, `message
 * 'CODIGO: texto'`, `hint 'CODIGO'` y `details` = JSON en texto.
 *
 * NO es la fuente de la regla (esa es la BD y su espejo puro
 * `conciliacion-parcial.util.ts`): es el doble de prueba del contrato.
 */

export type Row = Record<string, unknown>;
export type Tablas = Record<string, Row[]>;

export const TABLA_PARTES = 'movimiento_bancario_gasto';
export const VISTA_CONCILIACION = 'v_gasto_conciliacion';
export const RPC_LIGAR = 'conciliacion_ligar_cargo_gastos';
export const RPC_DESLIGAR = 'conciliacion_desligar_cargo_gastos';

export interface ErrorBd {
  code: string;
  message: string;
  hint: string;
  details: string;
}

const c2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const abs2 = (x: unknown) => Math.abs(c2(Number(x) || 0));
const tolLote = (n: number) => c2(Math.min(1, Math.max(0.02, 0.01 * n)));

export function errorBd(
  codigo: string,
  texto: string,
  detalle: Record<string, unknown> = {},
): ErrorBd {
  return {
    code: '23514',
    message: `${codigo}: ${texto}`,
    hint: codigo,
    details: JSON.stringify(detalle),
  };
}

function partes(db: Tablas): Row[] {
  if (!db[TABLA_PARTES]) db[TABLA_PARTES] = [];
  return db[TABLA_PARTES];
}

function monedaCuentaDe(db: Tablas, mov: Row): string | null {
  const c = (db.cuenta_bancaria ?? []).find(
    (x) => x.id === mov.cuenta_bancaria_id,
  );
  return typeof c?.moneda === 'string' ? c.moneda : null;
}

const cruzada = (p: Row, g: Row | undefined) =>
  p.moneda != null && g?.moneda != null && p.moneda !== g.moneda;

/**
 * Backfill 1.3 de la migración + vista: cada movimiento con `gasto_id`
 * (espejo) obtiene SU parte (`monto_parte = |monto|`, moneda de su cuenta),
 * todos ganan `gastos_n`, y `db.v_gasto_conciliacion` pasa a ser una vista
 * CALCULADA en cada lectura. Llamar UNA vez al armar el mundo.
 */
export function sembrarPartes(db: Tablas): Tablas {
  const ps = partes(db);
  for (const m of db.movimiento_bancario ?? []) {
    if (
      typeof m.gasto_id === 'string' &&
      !ps.some((p) => p.movimiento_id === m.id && p.gasto_id === m.gasto_id)
    ) {
      ps.push({
        movimiento_id: m.id,
        gasto_id: m.gasto_id,
        monto_parte: abs2(m.monto),
        moneda: monedaCuentaDe(db, m),
        created_at: '2026-10-02T00:00:00Z',
        created_by: null,
      });
    }
    m.gastos_n = ps.filter((p) => p.movimiento_id === m.id).length;
  }
  Object.defineProperty(db, VISTA_CONCILIACION, {
    configurable: true,
    enumerable: false,
    get: () => vistaConciliacion(db),
  });
  return db;
}

/**
 * `v_gasto_conciliacion`: como la vista real (`from gasto cross join
 * lateral`), TODOS los gastos — los que no tienen partes con `n_partes 0`,
 * `suma 0`, `faltante = monto` y `cubierto false` — más las partes cuyo
 * gasto no está sembrado en `db.gasto`.
 */
export function vistaConciliacion(db: Tablas): Row[] {
  const out: Row[] = [];
  const porGasto = new Map<string, Row[]>();
  for (const g of db.gasto ?? []) {
    if (typeof g.id === 'string') porGasto.set(g.id, []);
  }
  for (const p of partes(db)) {
    const l = porGasto.get(p.gasto_id as string) ?? [];
    l.push(p);
    porGasto.set(p.gasto_id as string, l);
  }
  for (const [gid, ps] of porGasto) {
    const g = (db.gasto ?? []).find((x) => x.id === gid);
    const monto = abs2(g?.monto);
    const hayCruzada = ps.some((p) => cruzada(p, g));
    const suma = c2(
      ps
        .filter((p) => !cruzada(p, g))
        .reduce((a, p) => a + abs2(p.monto_parte), 0),
    );
    out.push({
      gasto_id: gid,
      n_partes: ps.length,
      cruzado: hayCruzada,
      suma,
      monto_vinculado: hayCruzada ? monto : suma,
      faltante: hayCruzada ? 0 : Math.max(0, c2(monto - suma)),
      cubierto: cubierto(monto, ps, g),
    });
  }
  return out;
}

function cubierto(monto: number, ps: Row[], g: Row | undefined): boolean {
  if (ps.some((p) => cruzada(p, g))) return true;
  if (ps.length === 0) return false;
  if (monto <= 0) return true;
  const suma = c2(ps.reduce((a, p) => a + abs2(p.monto_parte), 0));
  return suma + 1e-6 >= monto - 1;
}

/** I: `recalcular_gasto_conciliado` (escribe solo si algo cambia). */
export function recalcularGasto(
  db: Tablas,
  gastoId: string,
  actor: string | null,
  montoDesligado: number | null = null,
): void {
  const g = (db.gasto ?? []).find((x) => x.id === gastoId);
  if (!g) return;
  const ps = partes(db).filter((p) => p.gasto_id === gastoId);
  const monto = abs2(g.monto);
  const conciliado = cubierto(monto, ps, g);
  let tc = g.tc_gasto ?? null;
  if (
    ps.length === 1 &&
    cruzada(ps[0], g) &&
    g.moneda === 'USD' &&
    ps[0].moneda === 'MXN' &&
    g.tc_gasto == null &&
    monto > 0
  ) {
    const t = abs2(ps[0].monto_parte) / monto;
    if (t >= 15 && t <= 25) tc = Math.round(t * 1e6) / 1e6;
  }
  if (
    ps.length === 0 &&
    montoDesligado != null &&
    g.moneda === 'USD' &&
    g.tc_gasto != null &&
    monto > 0 &&
    Math.abs(Number(g.tc_gasto) - montoDesligado / monto) < 0.001
  ) {
    tc = null;
  }
  if (g.conciliado !== conciliado || (g.tc_gasto ?? null) !== tc) {
    g.conciliado = conciliado;
    g.tc_gasto = tc;
    if (actor) g.updated_by = actor;
  }
}

/** B: espejo del movimiento tras tocar sus partes. */
export function sincronizarMovimiento(
  db: Tablas,
  movId: string,
  actor: string | null,
): void {
  const m = (db.movimiento_bancario ?? []).find((x) => x.id === movId);
  if (!m) return;
  const ps = partes(db).filter((p) => p.movimiento_id === movId);
  const n = ps.length;
  m.gastos_n = n;
  m.gasto_id = n === 1 ? ps[0].gasto_id : null;
  if (n > 0) m.clasificacion_id = null;
  m.conciliado =
    n > 0 ||
    !!m.cobro_id ||
    !!m.cobro_grupo_id ||
    !!m.ingreso_id ||
    !!m.clasificacion_id ||
    !!m.reverso_de_id;
  if (actor) m.updated_by = actor;
}

export interface OpcionesRpc {
  /** Error inyectado (carrera / RPC ausente) ANTES de emular. */
  fallo?: (nombre: string, args: Row) => unknown;
  /** Bitácora de llamadas (nombre + args). */
  llamadas?: Array<{ nombre: string; args: Row }>;
}

/** G / H como las expone PostgREST (`rpc(nombre, args)`). */
export function rpcPartes(
  db: Tablas,
  nombre: string,
  args: Row,
  opts: OpcionesRpc = {},
): { data: unknown; error: unknown } {
  opts.llamadas?.push({ nombre, args });
  const inyectado = opts.fallo?.(nombre, args);
  if (inyectado) return { data: null, error: inyectado };
  if (nombre === RPC_LIGAR) return ligar(db, args);
  if (nombre === RPC_DESLIGAR) return desligar(db, args);
  return {
    data: null,
    error: {
      code: 'PGRST202',
      message: `Could not find the function public.${nombre}`,
    },
  };
}

function ligar(db: Tablas, args: Row): { data: unknown; error: unknown } {
  const movId = args.p_movimiento_id as string;
  const ids = (args.p_gasto_ids as string[]) ?? [];
  const actor = (args.p_actor as string | null) ?? null;
  const fallo = (e: ErrorBd) => ({ data: null, error: e });
  const movs = db.movimiento_bancario ?? [];
  const mov = movs.find((m) => m.id === movId);
  if (!mov) {
    return fallo(errorBd('LOTE_INVALIDO', 'el movimiento no existe'));
  }
  if (mov.tipo !== 'CARGO') {
    return fallo(
      errorBd(
        'LOTE_INVALIDO',
        `solo un CARGO del banco se concilia con gastos (este movimiento es un ${String(mov.tipo)})`,
        { movimiento_id: movId, tipo: mov.tipo },
      ),
    );
  }
  if (mov.cobro_id || mov.cobro_grupo_id || mov.ingreso_id) {
    return fallo(
      errorBd(
        'MOVIMIENTO_YA_LIGADO',
        'el movimiento ya está ligado a un cobro, sobre o ingreso',
      ),
    );
  }
  if (mov.reverso_de_id || movs.some((m) => m.reverso_de_id === movId)) {
    return fallo(
      errorBd('REVERSO_INVALIDO', 'el cargo está emparejado con su devolución'),
    );
  }
  const actuales = partes(db).filter((p) => p.movimiento_id === movId);
  if (
    Number(mov.gastos_n) >= 2 &&
    ids.length === 1 &&
    !actuales.some((p) => p.gasto_id === ids[0])
  ) {
    return fallo(
      errorBd(
        'MOVIMIENTO_CON_LOTE',
        `este cargo ya paga ${String(mov.gastos_n)} gastos; desvincúlalos primero`,
        { gastos_n: mov.gastos_n },
      ),
    );
  }
  const gastos = ids.map((id) => (db.gasto ?? []).find((g) => g.id === id));
  if (
    ids.length === 0 ||
    new Set(ids).size !== ids.length ||
    gastos.some((g) => !g)
  ) {
    return fallo(errorBd('LOTE_INVALIDO', 'gastos repetidos o inexistentes'));
  }
  const monedaCuenta = monedaCuentaDe(db, mov);
  const montoCargo = abs2(mov.monto);
  const nuevas: Array<{ gasto_id: string; monto_parte: number }> = [];
  if (ids.length === 1) {
    const g = gastos[0]!;
    const otras = partes(db).filter(
      (p) => p.gasto_id === g.id && p.movimiento_id !== movId,
    );
    const esta: Row = { moneda: monedaCuenta };
    const cruzadaOtra = otras.some((p) => cruzada(p, g));
    if (cruzadaOtra || (cruzada(esta, g) && otras.length > 0)) {
      return fallo(
        errorBd(
          'GASTO_YA_CUBIERTO',
          `el gasto ${String(g.id)} se concilió contra otra MONEDA: solo admite un cargo (1 a 1)`,
          { motivo: 'MONEDA_DISTINTA', gasto_id: g.id },
        ),
      );
    }
    if (!cruzada(esta, g)) {
      const suma = c2(otras.reduce((a, p) => a + abs2(p.monto_parte), 0));
      if (suma + montoCargo > abs2(g.monto) + 1 + 1e-9) {
        return fallo(
          errorBd(
            'GASTO_YA_CUBIERTO',
            `los cargos ligados al gasto ${String(g.id)} suman ${suma} y con este (${montoCargo}) rebasan su monto (${abs2(g.monto)})`,
            {
              motivo: 'GASTO_YA_CUBIERTO',
              gasto_id: g.id,
              suma_ligada: suma,
              monto_nuevo: montoCargo,
            },
          ),
        );
      }
    }
    nuevas.push({ gasto_id: g.id as string, monto_parte: montoCargo });
  } else {
    // Como el loop de G: GASTO POR GASTO en el orden de la lista, primero la
    // moneda y luego el faltante (con un cubierto en la posición 1 y un USD
    // en la 2 la BD dice GASTO_YA_CUBIERTO). G manda motivo
    // GASTO_YA_CUBIERTO también cuando el gasto ya tiene su 1 ↔ 1 cruzado.
    for (const g of gastos) {
      if (g!.moneda !== monedaCuenta) {
        return fallo(
          errorBd(
            'LOTE_MONEDA_DISTINTA',
            `el gasto ${String(g!.id)} está en ${String(g!.moneda)} y la cuenta en ${String(monedaCuenta)}`,
            {
              gasto_id: g!.id,
              moneda_gasto: g!.moneda,
              moneda_cuenta: monedaCuenta,
            },
          ),
        );
      }
      const otras = partes(db).filter(
        (p) => p.gasto_id === g!.id && p.movimiento_id !== movId,
      );
      const suma = c2(
        otras
          .filter((p) => !cruzada(p, g))
          .reduce((a, p) => a + abs2(p.monto_parte), 0),
      );
      const yaCubierto =
        otras.some((p) => cruzada(p, g)) ||
        (otras.length > 0 && cubierto(abs2(g!.monto), otras, g));
      const faltante = yaCubierto ? 0 : Math.max(0, c2(abs2(g!.monto) - suma));
      if (!(faltante > 0)) {
        return fallo(
          errorBd(
            'GASTO_YA_CUBIERTO',
            `el gasto ${String(g!.id)} ya está cubierto por otros cargos (${suma} de ${abs2(g!.monto)})`,
            { motivo: 'GASTO_YA_CUBIERTO', gasto_id: g!.id },
          ),
        );
      }
      nuevas.push({ gasto_id: g!.id as string, monto_parte: faltante });
    }
    const suma = c2(nuevas.reduce((a, p) => a + p.monto_parte, 0));
    const dif = c2(montoCargo - suma);
    const tol = tolLote(ids.length);
    if (Math.abs(dif) > tol + 1e-9) {
      return fallo(
        errorBd(
          'CARGO_NO_CUADRA',
          `los ${ids.length} gastos suman ${suma} y el cargo es de ${montoCargo} (diferencia ${dif}, tolerancia ${tol})`,
          {
            monto_cargo: montoCargo,
            suma_gastos: suma,
            diferencia: dif,
            tolerancia: tol,
            moneda: monedaCuenta,
          },
        ),
      );
    }
  }
  // Escritura como DIFF (A valida arriba; B y I recalculan lo que cambió).
  const anteriores = actuales.map((p) => ({ ...p }));
  const salientes = actuales.filter((p) => !ids.includes(p.gasto_id as string));
  db[TABLA_PARTES] = partes(db).filter(
    (p) => !(p.movimiento_id === movId && salientes.includes(p)),
  );
  const tocados = new Set<string>(salientes.map((p) => p.gasto_id as string));
  for (const n of nuevas) {
    const ya = partes(db).find(
      (p) => p.movimiento_id === movId && p.gasto_id === n.gasto_id,
    );
    if (ya) {
      if (abs2(ya.monto_parte) !== n.monto_parte) {
        ya.monto_parte = n.monto_parte;
        tocados.add(n.gasto_id);
      }
      continue;
    }
    partes(db).push({
      movimiento_id: movId,
      gasto_id: n.gasto_id,
      monto_parte: n.monto_parte,
      moneda: monedaCuenta,
      created_at: new Date().toISOString(),
      created_by: actor,
    });
    tocados.add(n.gasto_id);
  }
  if (tocados.size > 0) sincronizarMovimiento(db, movId, actor);
  for (const gid of tocados) {
    const salio = salientes.find((p) => p.gasto_id === gid);
    recalcularGasto(db, gid, actor, salio ? abs2(salio.monto_parte) : null);
  }
  const vivas = partes(db).filter((p) => p.movimiento_id === movId);
  return {
    data: {
      movimiento_id: movId,
      partes: vivas.map((p) => ({
        gasto_id: p.gasto_id,
        monto_parte: p.monto_parte,
        moneda: p.moneda,
      })),
      salientes: salientes.map((p) => ({
        gasto_id: p.gasto_id,
        monto_parte: p.monto_parte,
        moneda: p.moneda,
      })),
      anteriores,
    },
    error: null,
  };
}

function desligar(db: Tablas, args: Row): { data: unknown; error: unknown } {
  const movId = args.p_movimiento_id as string;
  const actor = (args.p_actor as string | null) ?? null;
  if (!(db.movimiento_bancario ?? []).some((m) => m.id === movId)) {
    return {
      data: null,
      error: errorBd('LOTE_INVALIDO', `el movimiento ${movId} no existe`, {
        movimiento_id: movId,
      }),
    };
  }
  const salientes = partes(db).filter((p) => p.movimiento_id === movId);
  db[TABLA_PARTES] = partes(db).filter((p) => p.movimiento_id !== movId);
  if (salientes.length > 0) sincronizarMovimiento(db, movId, actor);
  for (const p of salientes) {
    recalcularGasto(db, p.gasto_id as string, actor, abs2(p.monto_parte));
  }
  return {
    data: {
      movimiento_id: movId,
      salientes: salientes.map((p) => ({
        gasto_id: p.gasto_id,
        monto_parte: p.monto_parte,
        moneda: p.moneda,
      })),
    },
    error: null,
  };
}
