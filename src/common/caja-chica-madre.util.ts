/**
 * FONDO CONSOLIDADO DE UNA CAJA MADRE (27-oct-2026). Pedido de Mary Cruz:
 * «tengo un fondo fijo de $40,000 de los cuales $16,500 están distribuidos
 * entre mis compañeros. Necesito que el sistema me muestre el fondo total, los
 * fondos asignados a cada colaborador, el saldo en efectivo que conserva cada
 * persona, los gastos comprobados y pendientes por reponer, y el efectivo real
 * disponible en mi caja, considerando también las entregas de dinero y las
 * reposiciones registradas».
 *
 * Modelo (el de la oficina): el fondo total de la madre INCLUYE lo asignado a
 * las cajas que fondea (`monto_fondo` de cada hija). Entonces:
 *  · «debe estar en mi caja» (`fondo_propio`) = fondo total − Σ asignado;
 *  · «por solicitar a la empresa» = lo que SALIÓ de la caja desde la última
 *    reposición: gastos propios + entregas a colaboradores (espejos) ± otros
 *    movimientos (reintegros a mano, ajustes) — el tramo PENDIENTE de
 *    `tramoDeReposicion`, el mismo del Excel «Por reponer»;
 *  · efectivo ESPERADO = fondo propio − por solicitar; efectivo SEGÚN EL LIBRO
 *    = el saldo corrido de siempre (`historialConSaldo`). Si difieren, la
 *    diferencia se DICE (faltan entradas por registrar, o un fondo asignado
 *    no es el real; una entrega inicial a un colaborador que siga en el tramo
 *    pendiente sale como diferencia positiva hasta la siguiente reposición).
 *
 * Nada se recalcula: todo sale de las filas del historial y de los libros de
 * las hijas que `cajasFondeadas` ya carga (`saldo`, `por_reponer`). Aquí solo
 * se SUMAN cifras que ya existen. PURO; spec `caja-chica-madre.util.spec.ts`.
 */
import {
  round2,
  tramoDeReposicion,
  type EntradaConSaldo,
  type EntradaTramoLike,
} from './caja-chica-saldo.util';

/** «N movimientos por $X» (X POSITIVO). */
export interface ConteoMonto {
  n: number;
  total: number;
}

/** Lo que cada caja hija aporta al resumen (sale de SU libro). */
export interface HijaResumen {
  /** Fondo asignado (nominal); null = sin fijar (o acumulada). */
  monto_fondo: number | null;
  /** Saldo crudo de su libro = efectivo que conserva (negativo = sobregiro /
   *  lo que puso de su bolsa). */
  saldo_libro: number;
  /** Lo por reponer (≥ 0), la misma cifra de su tarjeta y su Excel. */
  por_reponer: number;
  /** Gastos de SU tramo pendiente (desde su última reposición). */
  gastos_pendientes: ConteoMonto;
}

export interface ResumenCajaMadre {
  /** `monto_fondo` de la madre; null = sin fondo fijo (o acumulada). */
  fondo_total: number | null;
  /** Cajas activas que fondea. */
  cajas: number;
  /** Σ fondos asignados a los colaboradores. */
  asignado_colaboradores: number;
  /** Lo que debe estar en la caja madre: fondo total − asignado (null sin fondo total). */
  fondo_propio: number | null;
  /** Σ efectivo que conservan los colaboradores (saldo de cada libro). */
  efectivo_colaboradores: number;
  /** Σ por reponer de los colaboradores. */
  pendiente_colaboradores: number;
  /** Σ gastos pendientes de los colaboradores. */
  gastos_pendientes_colaboradores: ConteoMonto;
  /** Gastos propios desde la última reposición de la madre. */
  gastos_pendientes: ConteoMonto;
  /** Entregas a colaboradores (espejos) desde la última reposición. */
  entregas_pendientes: ConteoMonto;
  /** Otros movimientos del tramo pendiente, con signo (reintegro a mano −, ajuste ±). */
  otros_pendientes: number;
  /** Lo que salió de la caja desde la última reposición = gastos + entregas − otros. */
  por_solicitar: number;
  /** Saldo del libro hoy (última fila; 0 sin libro). */
  efectivo_libro: number;
  /** fondo propio − por solicitar (null sin fondo total). */
  efectivo_esperado: number | null;
  /** efectivo según el libro − esperado (null sin fondo total). */
  diferencia: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Monto nominal del fondo (> 0) o null. */
export function montoFondoDe(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? round2(n) : null;
}

/** Gastos del tramo PENDIENTE (desde la última reposición): cuántos y cuánto. */
export function gastosPendientesDe<T extends EntradaTramoLike>(
  historial: EntradaConSaldo<T>[],
): ConteoMonto {
  const t = tramoDeReposicion(historial, null);
  return { n: t?.gastos.length ?? 0, total: t?.total_gastos ?? 0 };
}

export function resumenCajaMadre<T extends EntradaTramoLike>(args: {
  montoFondo: unknown;
  historial: EntradaConSaldo<T>[];
  /** ¿Este movimiento de caja es un ESPEJO (entrega a una caja que fondea)? */
  esEspejo: (id: string) => boolean;
  hijas: readonly HijaResumen[];
}): ResumenCajaMadre {
  const fondoTotal = montoFondoDe(args.montoFondo);
  const asignado = round2(
    args.hijas.reduce((s, h) => s + (num(h.monto_fondo) ?? 0), 0),
  );
  const fondoPropio = fondoTotal != null ? round2(fondoTotal - asignado) : null;
  const efectivoColab = round2(
    args.hijas.reduce((s, h) => s + (num(h.saldo_libro) ?? 0), 0),
  );
  const pendienteColab = round2(
    args.hijas.reduce((s, h) => s + (num(h.por_reponer) ?? 0), 0),
  );
  const gastosColab: ConteoMonto = {
    n: args.hijas.reduce((s, h) => s + (h.gastos_pendientes?.n ?? 0), 0),
    total: round2(
      args.hijas.reduce((s, h) => s + (h.gastos_pendientes?.total ?? 0), 0),
    ),
  };

  const t = tramoDeReposicion(args.historial, null);
  const gastos: ConteoMonto = {
    n: t?.gastos.length ?? 0,
    total: t?.total_gastos ?? 0,
  };
  const otrosFilas = t?.otros ?? [];
  const entregasFilas = otrosFilas.filter((e) => args.esEspejo(e.id));
  const entregas: ConteoMonto = {
    n: entregasFilas.length,
    // Los espejos son REINTEGROS (monto negativo): se expone en positivo.
    total: round2(entregasFilas.reduce((s, e) => s - e.monto, 0)),
  };
  const otros = round2(
    otrosFilas
      .filter((e) => !args.esEspejo(e.id))
      .reduce((s, e) => s + e.monto, 0),
  );
  const porSolicitar = round2(gastos.total + entregas.total - otros);
  const ultima = args.historial[args.historial.length - 1];
  const efectivoLibro = ultima ? round2(ultima.saldo) : 0;
  const esperado =
    fondoPropio != null ? round2(fondoPropio - porSolicitar) : null;
  return {
    fondo_total: fondoTotal,
    cajas: args.hijas.length,
    asignado_colaboradores: asignado,
    fondo_propio: fondoPropio,
    efectivo_colaboradores: efectivoColab,
    pendiente_colaboradores: pendienteColab,
    gastos_pendientes_colaboradores: gastosColab,
    gastos_pendientes: gastos,
    entregas_pendientes: entregas,
    otros_pendientes: otros,
    por_solicitar: porSolicitar,
    efectivo_libro: efectivoLibro,
    efectivo_esperado: esperado,
    diferencia: esperado != null ? round2(efectivoLibro - esperado) : null,
  };
}
