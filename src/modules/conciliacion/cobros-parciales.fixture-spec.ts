/**
 * PostgREST FALSO de «UN COBRO, VARIOS ABONOS» — vincular y candados (14-oct-
 * 2026, API 0.0.78, invariante 77). Fuera del build (`*spec.ts`) y de jest
 * (no termina en `.spec.ts`): patrón `*.fixture-spec.ts` del repo.
 *
 * Emula la BD como la deja la migración 20261014000003, traducida del
 * plpgsql del ARCHIVO (no de los espejos TS que prueban los specs):
 * - la puente `movimiento_bancario_cobro` M:N (PK movimiento + cobro);
 * - A (BEFORE por fila, con el cobro «bloqueado»): candados del abono y del
 *   cobro; OTROS abonos ⇒ COBRO_YA_CONCILIADO CUBIERTO | UN_SOLO_ABONO; otra
 *   moneda ⇒ banda 15–25 (COBRO_MONEDA_DISTINTA); comisión o pasarela ⇒
 *   ABONO_EXCEDE_COBRO (un_solo) / COMISION_NO_CUADRA; banco ⇒
 *   ABONO_EXCEDE_COBRO. Los códigos nuevos cierran con « [ABONO_NO_CUADRA]»;
 * - B (espejos `cobros_n`, `cobro_id`, `conciliado`, `clasificacion_id`);
 * - C (espejo legado: un UPDATE directo de `cobro_id` borra las partes del
 *   abono y crea UNA por |monto| que pasa por A; un lote ⇒
 *   LOTE_SOLO_API_NUEVO). La fila que DEVUELVE el UPDATE es la de antes de
 *   B (como el RETURNING real: los espejos se recalculan después);
 * - D (con cobros no entra un sobre/gasto y no cambian tipo/monto/cuenta);
 * - E (con partes, el dinero del cobro no cambia: COBRO_CONCILIADO) y la FK
 *   RESTRICT de la puente al borrar un cobro (23503);
 * - G (RPC: 1 cobro ⇒ |abono| y A decide; lote ⇒ FALTANTE y tolerancia) y H
 *   (RPC: suelta las partes); la sonda `regla_cobro_cubierto(1,1,false,1)`.
 * `bdVieja: true` = 20261012000002 SIN 20261014000003: la sonda responde el
 * PGRST202 REAL, A sin reglas de monto y con «el espejo de OTRO movimiento
 * ocupa el cobro», índices ÚNICOS por cobro (puente y espejo ⇒ 23505), G con
 * NETOS y «ocupado» y sin E. Toda escritura que falla se REVIERTE completa.
 * Los errores tienen la forma REAL de PostgREST: `code`, `message`
 * («CODIGO: …»), `hint` (= CODIGO) y `details` (JSON en texto).
 */
import type { SupabaseService } from '../supabase/supabase.service';

export type Row = Record<string, unknown>;
export type Tablas = Record<string, Row[]>;

export interface ErrorBd {
  code: string;
  message: string;
  hint?: string;
  details?: string;
}

export interface OpcionesCobrosParciales {
  /** 20261012000002 sin 20261014000003 (ver arriba). */
  bdVieja?: boolean;
  /** Columnas que NO existen (42703 al nombrarlas). */
  ausentes?: string[];
  /** `tabla:op` ⇒ error forzado (p. ej. `cobro_vuelo:select`). */
  fallos?: Record<string, ErrorBd>;
  /** Antes de CADA operación (carreras): puede mutar `db` o devolver un error. */
  antes?: (
    op: { tabla: string; op: string; sel: string },
    db: Tablas,
  ) => ErrorBd | void;
}

export interface OperacionRegistrada {
  tabla: string;
  op: 'select' | 'update' | 'insert' | 'delete' | 'rpc';
  sel: string;
  cuerpo?: Row;
}

/** Columnas de migraciones que estos specs NO tienen (como los demás specs de cobros). */
export const COLUMNAS_AUSENTES_COBROS = [
  'ingreso_id',
  'ingreso_anticipo_id',
  'gastos_n',
  'reverso_de_id',
  'orden_archivo',
  'folio_releido_at',
];

const TOKEN = ' [ABONO_NO_CUADRA]';

class FalloBd extends Error {
  constructor(readonly bd: ErrorBd) {
    super(bd.message);
  }
}

function falla(
  codigo: string,
  texto: string,
  detail: Row,
  conToken = false,
): never {
  throw new FalloBd({
    code: '23514',
    hint: codigo,
    message: `${codigo}: ${texto}${conToken ? TOKEN : ''}`,
    details: JSON.stringify(detail),
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v) || 0;

/** `neto_de_cobro` (SQL). */
export function netoDeCobroSql(monto: unknown, comision: unknown): number {
  const c = Number(comision);
  if (comision != null && c > 0 && r2(num(monto) - c) > 0) {
    return r2(num(monto) - c);
  }
  return r2(num(monto));
}

/** `regla_cobro_cubierto` (SQL, CASE ordenado). */
export function reglaCobroCubiertoSql(
  neto: number,
  n: number,
  cruzado: boolean,
  suma: number,
): boolean {
  if (cruzado) return true;
  if (n === 0) return false;
  if (r2(neto) <= 0) return true;
  return r2(suma) + 0.000001 >= r2(neto) - 1.0;
}

const txt = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);

const cmp = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = txt(a);
  const sb = txt(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

export function fakeCobrosParciales(
  db: Tablas,
  opts: OpcionesCobrosParciales = {},
) {
  const log: OperacionRegistrada[] = [];
  const nueva = opts.bdVieja !== true;
  const ausentes = opts.ausentes ?? COLUMNAS_AUSENTES_COBROS;
  const tabla = (t: string): Row[] => (db[t] ??= []);
  const mov = (id: unknown) =>
    tabla('movimiento_bancario').find((m) => m.id === id) ?? null;
  const cobro = (id: unknown) =>
    tabla('cobro_vuelo').find((c) => c.id === id) ?? null;
  const cuentaDe = (m: Row | null) =>
    m
      ? (tabla('cuenta_bancaria').find((c) => c.id === m.cuenta_bancaria_id) ??
        null)
      : null;
  const folioDe = (c: Row) =>
    (tabla('vuelo').find((v) => v.id === c.vuelo_id)?.folio as
      | number
      | undefined) ?? null;
  const partes = () => tabla('movimiento_bancario_cobro');
  let seq = 0;

  // ---------------------------------------------------------------- A
  /** Trigger A sobre una parte NUEVA (`vieja` = la fila de un UPDATE). */
  const triggerA = (p: Row, vieja: Row | null) => {
    const m = mov(p.movimiento_id);
    if (!m) {
      falla(
        'LOTE_INVALIDO',
        `el movimiento ${txt(p.movimiento_id)} no existe`,
        {
          movimiento_id: p.movimiento_id,
        },
      );
    }
    if (m.tipo !== 'ABONO') {
      falla(
        'SOLO_ABONOS',
        `solo un ABONO del banco se concilia (es un ${txt(m.tipo)})`,
        {
          movimiento_id: m.id,
          tipo: m.tipo,
        },
      );
    }
    if (m.gasto_id || num(m.gastos_n) > 0 || m.cobro_grupo_id || m.ingreso_id) {
      falla(
        'MOVIMIENTO_YA_LIGADO',
        'el abono ya está conciliado con un gasto, un sobre de grupo o un ingreso',
        {
          movimiento_id: m.id,
          cobro_grupo_id: m.cobro_grupo_id ?? null,
        },
      );
    }
    if (m.reverso_de_id) {
      falla('REVERSO_INVALIDO', 'este abono es la devolución de un cargo', {
        movimiento_id: m.id,
      });
    }
    const c = cobro(p.cobro_id);
    if (!c) {
      falla('COBRO_NO_EXISTE', `el cobro ${txt(p.cobro_id)} no existe`, {
        cobro_id: p.cobro_id,
      });
    }
    const folio = folioDe(c);
    const f = folio == null ? '?' : String(folio);
    if (num(c.monto) <= 0) {
      falla('COBRO_INVALIDO', `el cobro del vuelo #${f} es un reembolso`, {
        cobro_id: c.id,
        folio,
        monto: c.monto,
      });
    }
    if (c.cobro_grupo_id) {
      falla(
        'COBRO_DE_GRUPO',
        `el cobro del vuelo #${f} es parte del sobre de un grupo`,
        {
          cobro_id: c.id,
          folio,
          cobro_grupo_id: c.cobro_grupo_id,
        },
      );
    }
    if (c.ingreso_anticipo_id) {
      falla(
        'COBRO_DE_ANTICIPO',
        `el cobro del vuelo #${f} salió de un anticipo`,
        {
          cobro_id: c.id,
          folio,
          ingreso_anticipo_id: c.ingreso_anticipo_id,
        },
      );
    }
    if (!nueva) {
      // 20261012000002: el espejo legado de OTRO movimiento ocupa el cobro.
      const otro = tabla('movimiento_bancario').find(
        (x) => x.cobro_id === c.id && x.id !== m.id,
      );
      if (otro) {
        falla(
          'COBRO_YA_CONCILIADO',
          `el cobro ${txt(c.id)} ya está conciliado con el movimiento ${txt(otro.id)}`,
          {
            cobro_id: c.id,
            movimiento_id: otro.id,
          },
        );
      }
      return;
    }
    const cuenta = cuentaDe(m);
    const monedaCuenta = (cuenta?.moneda as string | undefined) ?? null;
    const neto = netoDeCobroSql(c.monto, c.comision_banco_monto);
    const comision = num(c.comision_banco_monto) > 0;
    const cruzada = monedaCuenta !== null && monedaCuenta !== c.moneda;
    const pasarela = cuenta?.tipo === 'PASARELA';
    const otras = partes().filter(
      (x) =>
        x.cobro_id === p.cobro_id &&
        x.movimiento_id !== p.movimiento_id &&
        !(
          vieja &&
          x.movimiento_id === vieja.movimiento_id &&
          x.cobro_id === vieja.cobro_id
        ),
    );
    const monedaDe = (x: Row) =>
      (cuentaDe(mov(x.movimiento_id))?.moneda as string | undefined) ?? null;
    const n = otras.length;
    const cruzadas = otras.filter((x) => monedaDe(x) !== c.moneda).length;
    const pasarelas = otras.filter(
      (x) => cuentaDe(mov(x.movimiento_id))?.tipo === 'PASARELA',
    ).length;
    const suma = r2(
      otras
        .filter((x) => monedaDe(x) === c.moneda)
        .reduce((a, x) => a + num(x.monto_parte), 0),
    );
    const movs = otras
      .map((x) => mov(x.movimiento_id)!)
      .sort(
        (a, b) =>
          cmp(a.fecha, b.fecha) ||
          cmp(a.created_at, b.created_at) ||
          cmp(a.id, b.id),
      )
      .map((x) => x.id);
    if (n > 0) {
      if (cruzadas > 0 || reglaCobroCubiertoSql(neto, n, false, suma)) {
        falla(
          'COBRO_YA_CONCILIADO',
          `el cobro del vuelo #${f} ya está cubierto por ${n} abono(s) del banco`,
          {
            cobro_id: c.id,
            folio,
            motivo: 'CUBIERTO',
            neto,
            suma_ligada: suma,
            abonos_otros: n,
            movimiento_ids: movs,
            movimiento_id: movs[0] ?? null,
          },
        );
      }
      if (comision || pasarela || cruzada || pasarelas > 0) {
        const por = cruzada
          ? 'MONEDA_DISTINTA'
          : pasarela || pasarelas > 0
            ? 'PASARELA'
            : 'COMISION';
        falla(
          'COBRO_YA_CONCILIADO',
          `el cobro del vuelo #${f} se concilia con UN solo abono y ya tiene otro ligado`,
          {
            cobro_id: c.id,
            folio,
            motivo: 'UN_SOLO_ABONO',
            por,
            neto,
            suma_ligada: suma,
            abonos_otros: n,
            movimiento_ids: movs,
            movimiento_id: movs[0] ?? null,
          },
        );
      }
    }
    const parte = num(p.monto_parte);
    if (cruzada) {
      const tc =
        c.moneda === 'USD' && monedaCuenta === 'MXN'
          ? parte / neto
          : c.moneda === 'MXN' && monedaCuenta === 'USD'
            ? neto / parte
            : null;
      if (tc == null || tc < 15 || tc > 25) {
        falla(
          'COBRO_MONEDA_DISTINTA',
          `el cobro del vuelo #${f} está en ${txt(c.moneda)} y el abono en ${txt(monedaCuenta)}`,
          {
            movimiento_id: p.movimiento_id,
            cobro_id: c.id,
            folio,
            motivo: 'TC_FUERA_DE_BANDA',
            moneda_cobro: c.moneda,
            moneda_cuenta: monedaCuenta,
            neto,
            parte,
            tc_implicito: tc == null ? null : Math.round(tc * 1e6) / 1e6,
            tc_min: 15,
            tc_max: 25,
          },
          true,
        );
      }
      return;
    }
    if (comision || pasarela) {
      if (parte > r2(num(c.monto)) + 1.0 + 0.000001) {
        falla(
          'ABONO_EXCEDE_COBRO',
          `el abono (${parte}) es mayor que el cobro del vuelo #${f}`,
          {
            movimiento_id: p.movimiento_id,
            cobro_id: c.id,
            folio,
            moneda: c.moneda,
            monto_cobro: r2(num(c.monto)),
            neto,
            suma_otras: 0,
            abonos_otros: 0,
            parte,
            faltante: neto,
            excedente: r2(parte - neto),
            un_solo: true,
          },
          true,
        );
      }
      if (Math.abs(parte - neto) > 1.0 + 0.000001) {
        falla(
          'COMISION_NO_CUADRA',
          `el cobro del vuelo #${f} espera ${neto} después de la comisión y el abono es de ${parte}`,
          {
            movimiento_id: p.movimiento_id,
            cobro_id: c.id,
            folio,
            moneda: c.moneda,
            monto_cobro: r2(num(c.monto)),
            comision_capturada: r2(num(c.comision_banco_monto)),
            neto,
            parte,
            comision_real: Math.max(r2(num(c.monto) - parte), 0),
            por: pasarela ? 'PASARELA' : 'COMISION',
          },
          true,
        );
      }
      return;
    }
    if (suma + parte > neto + 1.0 + 0.000001) {
      falla(
        'ABONO_EXCEDE_COBRO',
        `con este abono el cobro del vuelo #${f} quedaría pagado de más por ${r2(suma + parte - neto)}`,
        {
          movimiento_id: p.movimiento_id,
          cobro_id: c.id,
          folio,
          moneda: c.moneda,
          monto_cobro: r2(num(c.monto)),
          neto,
          suma_otras: suma,
          abonos_otros: n,
          parte,
          faltante: Math.max(r2(neto - suma), 0),
          excedente: r2(suma + parte - neto),
          un_solo: false,
        },
        true,
      );
    }
  };

  /** INSERT en la puente: A + índices (PK; único por cobro en la BD vieja). */
  const insertarParte = (p: Row) => {
    triggerA(p, null);
    if (
      partes().some(
        (x) => x.movimiento_id === p.movimiento_id && x.cobro_id === p.cobro_id,
      )
    ) {
      throw new FalloBd({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "movimiento_bancario_cobro_pkey"',
      });
    }
    if (!nueva && partes().some((x) => x.cobro_id === p.cobro_id)) {
      throw new FalloBd({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_mov_cobro_parte_cobro"',
      });
    }
    partes().push({
      created_at: `2026-10-14T16:00:${String(++seq).padStart(2, '0')}Z`,
      created_by: null,
      ...p,
    });
  };

  // ---------------------------------------------------------------- B
  const triggerB = (movId: unknown, actor: unknown) => {
    const m = mov(movId);
    if (!m) return;
    const ps = partes().filter((x) => x.movimiento_id === movId);
    const n = ps.length;
    const clasif = m.clasificacion_id ?? null;
    m.cobros_n = n;
    m.cobro_id = n === 1 ? ps[0].cobro_id : null;
    m.conciliado =
      n > 0 ||
      !!m.gasto_id ||
      num(m.gastos_n) > 0 ||
      !!m.cobro_grupo_id ||
      !!m.ingreso_id ||
      clasif != null ||
      !!m.reverso_de_id;
    if (n > 0) m.clasificacion_id = null;
    if (actor) m.updated_by = actor;
  };

  // ---------------------------------------------------------------- D
  const triggerD = (viejo: Row, nuevo: Row) => {
    if (num(viejo.cobros_n) === 0) return;
    if (num(nuevo.cobros_n) === 0 && nuevo.cobros_n !== viejo.cobros_n) return;
    if (
      nuevo.gasto_id ||
      num(nuevo.gastos_n) > 0 ||
      nuevo.cobro_grupo_id ||
      nuevo.ingreso_id ||
      nuevo.reverso_de_id
    ) {
      falla(
        'MOVIMIENTO_YA_LIGADO',
        `el abono ya paga ${txt(viejo.cobros_n)} cobro(s) de vuelo`,
        {
          movimiento_id: nuevo.id,
          cobros_n: viejo.cobros_n,
        },
      );
    }
    const limite = nueva ? 1 : 2;
    if (
      num(viejo.cobros_n) >= limite &&
      (nuevo.tipo !== viejo.tipo ||
        num(nuevo.monto) !== num(viejo.monto) ||
        nuevo.cuenta_bancaria_id !== viejo.cuenta_bancaria_id)
    ) {
      falla(
        'ABONO_LIGADO',
        `el abono paga ${txt(viejo.cobros_n)} cobro(s); no cambia de tipo, monto ni cuenta`,
        {
          movimiento_id: nuevo.id,
          cobros_n: viejo.cobros_n,
        },
      );
    }
    if (num(viejo.cobros_n) >= 2 && nuevo.conciliado === false) {
      falla(
        'ABONO_LIGADO',
        `el abono paga ${txt(viejo.cobros_n)} cobros; para dejarlo pendiente desvincúlalos`,
        {
          movimiento_id: nuevo.id,
          cobros_n: viejo.cobros_n,
        },
      );
    }
  };

  /** UPDATE directo de un movimiento: índices, D, la fila, C (⇒ A, B). */
  const actualizarMovimiento = (m: Row, patch: Row): Row => {
    const viejo = { ...m };
    const nuevo = { ...m, ...patch };
    if (
      'cobro_grupo_id' in patch &&
      patch.cobro_grupo_id &&
      tabla('movimiento_bancario').some(
        (x) => x.id !== m.id && x.cobro_grupo_id === patch.cobro_grupo_id,
      )
    ) {
      throw new FalloBd({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_mov_bancario_cobro_grupo"',
      });
    }
    if (
      !nueva &&
      'cobro_id' in patch &&
      patch.cobro_id &&
      tabla('movimiento_bancario').some(
        (x) => x.id !== m.id && x.cobro_id === patch.cobro_id,
      )
    ) {
      throw new FalloBd({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "uq_mov_bancario_cobro"',
      });
    }
    triggerD(viejo, nuevo);
    Object.assign(m, patch);
    // RETURNING: la fila de ESTA sentencia (B la reescribe después).
    const devuelta = { ...m };
    if ('cobro_id' in patch && patch.cobro_id !== viejo.cobro_id) {
      // C (espejo legado).
      if (num(viejo.cobros_n) >= 2) {
        falla(
          'LOTE_SOLO_API_NUEVO',
          `este abono paga ${txt(viejo.cobros_n)} cobros`,
          {
            movimiento_id: m.id,
            cobros_n: viejo.cobros_n,
          },
        );
      }
      // `new.cobro_id` es el de ESTA sentencia (B lo reescribe al borrar).
      const nuevoCobro = m.cobro_id ?? null;
      const ps = partes().filter((x) => x.movimiento_id === m.id);
      const coincide =
        ps.length > 0 && ps.every((x) => x.cobro_id === nuevoCobro);
      if (
        !(
          (nuevoCobro == null && ps.length === 0) ||
          (nuevoCobro != null && ps.length === 1 && coincide)
        )
      ) {
        db.movimiento_bancario_cobro = partes().filter(
          (x) => x.movimiento_id !== m.id,
        );
        triggerB(m.id, m.updated_by);
        if (nuevoCobro != null) {
          insertarParte({
            movimiento_id: m.id,
            cobro_id: nuevoCobro,
            monto_parte: r2(Math.abs(num(m.monto))),
            created_by: m.updated_by ?? null,
          });
          triggerB(m.id, m.updated_by);
        }
      }
    }
    return devuelta;
  };

  /** UPDATE de un cobro: E (con 20261014000003). */
  const actualizarCobro = (c: Row, patch: Row) => {
    if (nueva) {
      const campos = [
        'monto',
        'moneda',
        'comision_banco_monto',
        'cobro_grupo_id',
        'ingreso_anticipo_id',
      ].filter((k) => {
        if (!(k in patch)) return false;
        const a = c[k] ?? null;
        const b = patch[k] ?? null;
        if (a === null || b === null) return a !== b;
        return typeof a === 'number' || typeof b === 'number'
          ? Number(a) !== Number(b)
          : a !== b;
      });
      const ps = partes()
        .filter((x) => x.cobro_id === c.id)
        .sort(
          (a, b) =>
            cmp(a.created_at, b.created_at) ||
            cmp(a.movimiento_id, b.movimiento_id),
        );
      if (campos.length > 0 && ps.length > 0) {
        falla(
          'COBRO_CONCILIADO',
          `el cobro tiene ${ps.length} abono(s) del banco ligados: su ${campos.join(', ')} no cambia`,
          {
            cobro_id: c.id,
            abonos: ps.length,
            campos,
            movimiento_ids: ps.map((x) => x.movimiento_id),
          },
        );
      }
    }
    Object.assign(c, patch);
  };

  // ---------------------------------------------------------------- G / H
  const rpcLigar = (args: Row) => {
    const movId = args.p_movimiento_id;
    const ids = (args.p_cobro_ids as unknown[]) ?? [];
    const actor = args.p_actor ?? null;
    const m = mov(movId);
    if (!m)
      falla('LOTE_INVALIDO', `el movimiento ${txt(movId)} no existe`, {
        movimiento_id: movId,
      });
    if (m.tipo !== 'ABONO')
      falla('SOLO_ABONOS', 'solo un ABONO', {
        movimiento_id: m.id,
        tipo: m.tipo,
      });
    if (m.gasto_id || num(m.gastos_n) > 0 || m.cobro_grupo_id || m.ingreso_id) {
      falla('MOVIMIENTO_YA_LIGADO', 'el abono ya está conciliado', {
        movimiento_id: m.id,
      });
    }
    if (m.reverso_de_id)
      falla('REVERSO_INVALIDO', 'devolución', { movimiento_id: m.id });
    const n = ids.length;
    if (n === 0)
      falla('LOTE_INVALIDO', 'manda al menos un cobro', {
        movimiento_id: m.id,
        cobro_ids: [],
      });
    if (n > 50)
      falla(
        'LOTE_INVALIDO',
        `un abono paga a lo más 50 cobros (llegaron ${n})`,
        { movimiento_id: m.id, n },
      );
    if (new Set(ids).size !== n)
      falla('LOTE_INVALIDO', 'la lista trae el mismo cobro repetido', {
        movimiento_id: m.id,
      });
    const cuenta = cuentaDe(m);
    const monedaCuenta = (cuenta?.moneda as string | undefined) ?? null;
    const tipoCuenta = (cuenta?.tipo as string | undefined) ?? null;
    const montoAbono = r2(Math.abs(num(m.monto)));
    let suma = 0;
    const cobrosDet: Row[] = [];
    const nuevas: Row[] = [];
    const ordenados = tabla('cobro_vuelo')
      .filter((c) => ids.includes(c.id))
      .sort((a, b) => cmp(a.id, b.id));
    for (const c of ordenados) {
      const folio = folioDe(c);
      const f = folio == null ? '?' : String(folio);
      if (num(c.monto) <= 0)
        falla('COBRO_INVALIDO', `el cobro del vuelo #${f} es un reembolso`, {
          cobro_id: c.id,
          folio,
          monto: c.monto,
        });
      if (c.cobro_grupo_id)
        falla(
          'COBRO_DE_GRUPO',
          `el cobro del vuelo #${f} es parte de un sobre`,
          { cobro_id: c.id, cobro_grupo_id: c.cobro_grupo_id, folio },
        );
      if (c.ingreso_anticipo_id)
        falla(
          'COBRO_DE_ANTICIPO',
          `el cobro del vuelo #${f} salió de un anticipo`,
          { cobro_id: c.id, folio },
        );
      if (n >= 2 && monedaCuenta !== null && c.moneda !== monedaCuenta) {
        falla(
          'LOTE_MONEDA_DISTINTA',
          `el cobro del vuelo #${f} está en ${txt(c.moneda)} y la cuenta en ${monedaCuenta}`,
          {
            cobro_id: c.id,
            folio,
            moneda_cobro: c.moneda,
            moneda_cuenta: monedaCuenta,
          },
        );
      }
      const neto = netoDeCobroSql(c.monto, c.comision_banco_monto);
      const otras = partes().filter(
        (x) => x.cobro_id === c.id && x.movimiento_id !== movId,
      );
      let faltante = neto;
      if (nueva) {
        const monedaDe = (x: Row) =>
          (cuentaDe(mov(x.movimiento_id))?.moneda as string | undefined) ??
          null;
        const cruzadas = otras.filter((x) => monedaDe(x) !== c.moneda).length;
        const pasarelas = otras.filter(
          (x) => cuentaDe(mov(x.movimiento_id))?.tipo === 'PASARELA',
        ).length;
        const sumaO = r2(
          otras
            .filter((x) => monedaDe(x) === c.moneda)
            .reduce((a, x) => a + num(x.monto_parte), 0),
        );
        const movs = otras
          .map((x) => mov(x.movimiento_id)!)
          .sort(
            (a, b) =>
              cmp(a.fecha, b.fecha) ||
              cmp(a.created_at, b.created_at) ||
              cmp(a.id, b.id),
          )
          .map((x) => x.id);
        const unSolo =
          num(c.comision_banco_monto) > 0 ||
          tipoCuenta === 'PASARELA' ||
          (monedaCuenta !== null && c.moneda !== monedaCuenta) ||
          cruzadas > 0 ||
          pasarelas > 0;
        if (otras.length > 0) {
          if (
            cruzadas > 0 ||
            reglaCobroCubiertoSql(neto, otras.length, false, sumaO)
          ) {
            falla(
              'COBRO_YA_CONCILIADO',
              `el cobro del vuelo #${f} ya está cubierto`,
              {
                cobro_id: c.id,
                folio,
                motivo: 'CUBIERTO',
                neto,
                suma_ligada: sumaO,
                abonos_otros: otras.length,
                movimiento_ids: movs,
                movimiento_id: movs[0] ?? null,
              },
            );
          }
          if (unSolo) {
            const por =
              monedaCuenta !== null && c.moneda !== monedaCuenta
                ? 'MONEDA_DISTINTA'
                : tipoCuenta === 'PASARELA' || pasarelas > 0
                  ? 'PASARELA'
                  : 'COMISION';
            falla(
              'COBRO_YA_CONCILIADO',
              `el cobro del vuelo #${f} se concilia con UN solo abono`,
              {
                cobro_id: c.id,
                folio,
                motivo: 'UN_SOLO_ABONO',
                por,
                neto,
                suma_ligada: sumaO,
                abonos_otros: otras.length,
                movimiento_ids: movs,
                movimiento_id: movs[0] ?? null,
              },
            );
          }
          faltante = Math.max(r2(neto - sumaO), 0);
        }
        cobrosDet.push({
          id: c.id,
          folio,
          vuelo_id: c.vuelo_id,
          monto: r2(num(c.monto)),
          neto,
          suma_otras: sumaO,
          abonos_otros: otras.length,
          faltante,
          parte: n === 1 ? montoAbono : faltante,
        });
      } else {
        const ocupado =
          otras[0]?.movimiento_id ??
          tabla('movimiento_bancario').find(
            (x) => x.cobro_id === c.id && x.id !== movId,
          )?.id;
        if (ocupado) {
          falla(
            'COBRO_YA_CONCILIADO',
            `el cobro del vuelo #${f} ya está conciliado con otro movimiento bancario`,
            {
              cobro_id: c.id,
              folio,
              movimiento_id: ocupado,
            },
          );
        }
        cobrosDet.push({ id: c.id, folio, monto: r2(num(c.monto)), neto });
      }
      const parte = n === 1 ? montoAbono : faltante;
      suma = r2(suma + parte);
      nuevas.push({ cobro_id: c.id, monto_parte: parte });
    }
    if (cobrosDet.length !== n) {
      falla('COBRO_NO_EXISTE', 'alguno de los cobros ya no existe', {
        movimiento_id: m.id,
        cobro_ids: ids,
      });
    }
    if (n >= 2) {
      const tol = Math.round(Math.min(1, Math.max(0.02, 0.01 * n)) * 100) / 100;
      const dif = r2(montoAbono - suma);
      if (Math.abs(dif) > tol + 0.000001) {
        falla(
          'ABONO_NO_CUADRA',
          `los ${n} cobros suman ${suma} y el abono es de ${montoAbono}`,
          {
            movimiento_id: m.id,
            monto_abono: montoAbono,
            suma_cobros: suma,
            diferencia: dif,
            tolerancia: tol,
            moneda: monedaCuenta,
            cobros: cobrosDet,
          },
        );
      }
    }
    // DIFF: salen los que ya no van; entran/cambian los demás (A por fila).
    db.movimiento_bancario_cobro = partes().filter(
      (x) => x.movimiento_id !== movId || ids.includes(x.cobro_id),
    );
    triggerB(movId, actor);
    for (const nv of [...nuevas].sort((a, b) => cmp(a.cobro_id, b.cobro_id))) {
      const ya = partes().find(
        (x) => x.movimiento_id === movId && x.cobro_id === nv.cobro_id,
      );
      if (ya) {
        if (num(ya.monto_parte) !== num(nv.monto_parte)) {
          triggerA({ ...ya, monto_parte: nv.monto_parte }, ya);
          ya.monto_parte = nv.monto_parte;
        }
      } else {
        insertarParte({
          movimiento_id: movId,
          cobro_id: nv.cobro_id,
          monto_parte: nv.monto_parte,
          created_by: actor,
        });
      }
    }
    triggerB(movId, actor);
    return { movimiento_id: movId, partes: nuevas, cobros: cobrosDet };
  };

  const rpcDesligar = (args: Row) => {
    const movId = args.p_movimiento_id;
    if (!mov(movId))
      falla('LOTE_INVALIDO', `el movimiento ${txt(movId)} no existe`, {
        movimiento_id: movId,
      });
    const salientes = partes().filter((x) => x.movimiento_id === movId);
    db.movimiento_bancario_cobro = partes().filter(
      (x) => x.movimiento_id !== movId,
    );
    triggerB(movId, args.p_actor ?? null);
    return { movimiento_id: movId, salientes };
  };

  // ---------------------------------------------------------------- embeds
  const conCuenta = (sel: string, r: Row | null): Row | null => {
    if (!r) return null;
    return sel.includes('cuenta:cuenta_bancaria')
      ? { ...r, cuenta: cuentaDe(r) }
      : { ...r };
  };
  const embeber = (t: string, sel: string, r: Row): Row => {
    let out: Row = { ...r };
    if (/\bvuelo:vuelo!vuelo_id\(/.test(sel)) {
      const v = tabla('vuelo').find((x) => x.id === r.vuelo_id) ?? null;
      out.vuelo = v
        ? {
            ...v,
            cliente:
              tabla('cliente').find((c) => c.id === v.cliente_id) ?? null,
          }
        : null;
    }
    if (/\bsobre:cobro_grupo!cobro_grupo_id\(/.test(sel)) {
      const s = tabla('cobro_grupo').find((x) => x.id === r.cobro_grupo_id);
      out.sobre = s
        ? {
            grupo:
              tabla('vuelo_grupo').find((g) => g.id === s.grupo_id) ?? null,
          }
        : null;
    }
    if (t === 'cobro_grupo' && /\bgrupo:vuelo_grupo!grupo_id\(/.test(sel)) {
      const g = tabla('vuelo_grupo').find((x) => x.id === r.grupo_id) ?? null;
      out.grupo = g
        ? {
            ...g,
            cliente:
              tabla('cliente').find((c) => c.id === g.cliente_id) ?? null,
          }
        : null;
    }
    if (/\bmovimiento:movimiento_bancario!movimiento_id\(/.test(sel)) {
      out.movimiento = conCuenta(sel, mov(r.movimiento_id));
    } else if (t === 'movimiento_bancario') {
      out = conCuenta(sel, out) as Row;
      if (sel.includes('clasificacion:conciliacion_clasificacion')) {
        const c = tabla('conciliacion_clasificacion').find(
          (x) => x.id === r.clasificacion_id,
        );
        out.clasificacion = c ? { nombre: c.nombre ?? null } : null;
      }
    }
    return out;
  };

  const nombraAusente = (texto: string) =>
    ausentes.find((c) => new RegExp(`(^|[^a-z_])${c}([^a-z_]|$)`).test(texto));

  const service = {
    from(t: string) {
      const filtros: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let cuerpo: Row = {};
      let sel = '';
      let devolver = false;
      let rango: [number, number] | null = null;
      let limite: number | null = null;
      const orden: Array<[string, boolean]> = [];
      let prohibido: string | undefined;
      const marcar = (texto: string) => {
        prohibido = prohibido ?? nombraAusente(texto);
      };
      const ejecutar = (uno: boolean) => {
        const registro: OperacionRegistrada = {
          tabla: t,
          op,
          sel,
          ...(op === 'update' || op === 'insert' ? { cuerpo } : {}),
        };
        log.push(registro);
        if (prohibido) {
          return {
            data: null,
            error: {
              code: '42703',
              message: `column ${t}.${prohibido} does not exist`,
            },
            count: null,
          };
        }
        const forzado =
          opts.fallos?.[`${t}:${op}`] ??
          opts.antes?.({ tabla: t, op, sel }, db) ??
          null;
        if (forzado) return { data: null, error: forzado, count: null };
        const filas = tabla(t).filter((r) => filtros.every((f) => f(r)));
        if (op !== 'select') {
          const foto = structuredClone(db);
          try {
            let devueltas: Row[] = [];
            if (op === 'update') {
              devueltas = filas.map((r) => {
                if (t === 'movimiento_bancario') {
                  return actualizarMovimiento(r, cuerpo);
                }
                if (t === 'cobro_vuelo') actualizarCobro(r, cuerpo);
                else Object.assign(r, cuerpo);
                return { ...r };
              });
            } else if (op === 'delete') {
              if (t === 'cobro_vuelo') {
                const conPartes = filas.find((r) =>
                  partes().some((x) => x.cobro_id === r.id),
                );
                if (conPartes) {
                  throw new FalloBd({
                    code: '23503',
                    message:
                      'update or delete on table "cobro_vuelo" violates foreign key constraint "movimiento_bancario_cobro_cobro_id_fkey" on table "movimiento_bancario_cobro"',
                  });
                }
              }
              db[t] = tabla(t).filter((r) => !filas.includes(r));
              devueltas = filas.map((r) => ({ ...r }));
            } else {
              const nuevaFila = { id: `${t}-${++seq}`, ...cuerpo };
              tabla(t).push(nuevaFila);
              devueltas = [{ ...nuevaFila }];
            }
            return {
              data: devolver
                ? uno
                  ? (devueltas[0] ?? null)
                  : devueltas
                : null,
              error: null,
              count: devueltas.length,
            };
          } catch (e) {
            for (const k of Object.keys(db)) delete db[k];
            Object.assign(db, foto);
            if (e instanceof FalloBd) {
              return { data: null, error: e.bd, count: null };
            }
            throw e;
          }
        }
        let out = filas.map((r) => embeber(t, sel, r));
        for (const [col, asc] of [...orden].reverse()) {
          out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        const total = out.length;
        if (rango) out = out.slice(rango[0], rango[1] + 1);
        if (limite != null) out = out.slice(0, limite);
        out = out.slice(0, 1000);
        return {
          data: uno ? (out[0] ?? null) : out,
          error: null,
          count: total,
        };
      };
      const api: Record<string, unknown> = {
        select(s?: string) {
          if (op === 'select') {
            sel = s ?? '*';
            marcar(sel);
          } else {
            devolver = true;
            marcar(s ?? '');
          }
          return api;
        },
        update(p: Row) {
          op = 'update';
          cuerpo = p;
          marcar(Object.keys(p).join(','));
          return api;
        },
        insert(p: Row) {
          op = 'insert';
          cuerpo = p;
          return api;
        },
        delete() {
          op = 'delete';
          return api;
        },
        eq(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => r[col] === val);
          return api;
        },
        neq(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => r[col] !== val);
          return api;
        },
        is(col: string, val: unknown) {
          marcar(col);
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        not(col: string, o: string, val: unknown) {
          marcar(col);
          if (o === 'is' && val === null)
            filtros.push((r) => (r[col] ?? null) !== null);
          return api;
        },
        ilike(col: string, patron: string) {
          marcar(col);
          const re = new RegExp(
            `^${patron
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/[%*]/g, '.*')
              .replace(/_/g, '.')}$`,
            'i',
          );
          filtros.push((r) => re.test(txt(r[col])));
          return api;
        },
        in(col: string, vals: unknown[]) {
          marcar(col);
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        gte(col: string, val: unknown) {
          filtros.push((r) => r[col] != null && cmp(r[col], val) >= 0);
          return api;
        },
        lte(col: string, val: unknown) {
          filtros.push((r) => r[col] != null && cmp(r[col], val) <= 0);
          return api;
        },
        gt(col: string, val: unknown) {
          filtros.push((r) => r[col] != null && cmp(r[col], val) > 0);
          return api;
        },
        lt(col: string, val: unknown) {
          filtros.push((r) => r[col] != null && cmp(r[col], val) < 0);
          return api;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orden.push([col, o?.ascending !== false]);
          return api;
        },
        range(a: number, b: number) {
          rango = [a, b];
          return api;
        },
        limit(n: number) {
          limite = n;
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        single: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
    rpc(nombre: string, args: Row) {
      log.push({
        tabla: `rpc:${nombre}`,
        op: 'rpc',
        sel: JSON.stringify(args),
      });
      if (nombre === 'regla_cobro_cubierto') {
        return Promise.resolve(
          nueva
            ? {
                data: reglaCobroCubiertoSql(
                  num(args.p_neto),
                  num(args.p_n_partes),
                  args.p_cruzado === true,
                  num(args.p_suma),
                ),
                error: null,
              }
            : {
                data: null,
                error: {
                  code: 'PGRST202',
                  message:
                    'Could not find the function public.regla_cobro_cubierto(p_cruzado, p_n_partes, p_neto, p_suma) in the schema cache',
                  details:
                    'Searched for the function public.regla_cobro_cubierto with parameters p_cruzado, p_n_partes, p_neto, p_suma or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
                  hint: 'Perhaps you meant to call the function public.regla_gasto_cubierto',
                },
              },
        );
      }
      if (
        nombre === 'conciliacion_ligar_abono_cobros' ||
        nombre === 'conciliacion_desligar_abono_cobros'
      ) {
        const forzado =
          opts.fallos?.[`rpc:${nombre}`] ??
          opts.antes?.({ tabla: `rpc:${nombre}`, op: 'rpc', sel: '' }, db) ??
          null;
        if (forzado) return Promise.resolve({ data: null, error: forzado });
        const foto = structuredClone(db);
        try {
          const data =
            nombre === 'conciliacion_ligar_abono_cobros'
              ? rpcLigar(args)
              : rpcDesligar(args);
          return Promise.resolve({ data, error: null });
        } catch (e) {
          for (const k of Object.keys(db)) delete db[k];
          Object.assign(db, foto);
          if (e instanceof FalloBd) {
            return Promise.resolve({ data: null, error: e.bd });
          }
          throw e;
        }
      }
      return Promise.resolve({
        data: null,
        error: {
          code: 'PGRST202',
          message: `Could not find the function public.${nombre} in the schema cache`,
        },
      });
    },
  };
  return {
    supabase: { service } as unknown as SupabaseService,
    log,
    /** Las escrituras registradas (update/insert/delete y RPC de escritura). */
    escrituras: () =>
      log.filter(
        (o) =>
          o.op === 'update' ||
          o.op === 'insert' ||
          o.op === 'delete' ||
          o.tabla === 'rpc:conciliacion_ligar_abono_cobros' ||
          o.tabla === 'rpc:conciliacion_desligar_abono_cobros',
      ),
  };
}
