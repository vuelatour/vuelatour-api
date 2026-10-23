/**
 * CIERRE DE MES en los BALANCES (16-oct-2026, API 0.0.88, invariante 89).
 * PURO. El libro por avión / EXTERNOS / general lee los vuelos del DINERO
 * por `fecha_contable` y además las «sombras» (vuelos que VOLARON en el
 * periodo pero un cierre difirió fuera). Aquí viven las DOS
 * transformaciones de fila — una sola vez, para que el libro individual, el
 * consolidado FLOTA y la vista en pantalla (invariante 52) digan lo mismo:
 *
 *  - FILA SOMBRA (mes de ORIGEN): horas, tacos y ruta REALES; TODO el
 *    dinero en `null` (venta, IVA, horas cobradas, costos, ganancias,
 *    cobros, por cobrar, AFAC, comisiones, factura) — ninguna suma ni
 *    fórmula del libro la cuenta. `status_cobro = 'Pasa a oct-2026'`,
 *    `cierre_marca = 'Pasa a octubre 2026 (pendiente de cobro: cobrado
 *    $0.00 de $36,632.89 MXN)'`, `fila_sombra = true`, `diferido_a`.
 *  - FILA QUE VIENE (mes DESTINO): el dinero completo; las HORAS reales en
 *    `null` (se quedaron en el mes en que se voló): `tiempo_vuelo`, tacos,
 *    observaciones y saltos. `cierre_marca = 'Viene de septiembre 2026'`,
 *    `diferido_de`.
 * Las horas COBRADAS (`horas_cobradas`) son de la venta: viajan con el
 * dinero (la fórmula del AFAC por fila las usa).
 */
import type { BalanceAvionVueloPayload } from '../pyservices/pyservices.service';
import {
  corteDeDestino,
  diaCortoDeDia,
  dineroTexto,
  etiquetaMesMinuscula,
  leyendaVieneDe,
  marcaPasaraAlCerrar,
  statusCobroSombra,
  type DecisionDiferir,
  type EstadoMesFlota,
  type MotivoDiferir,
} from '../../common/mes-contable.util';

/** Un vuelo de las listas `cierre.pasan` / `vienen` / `pasarian` del libro. */
export interface BalanceCierreVueloPayload {
  clave: string;
  vuelo_id: string;
  folio: string;
  cliente: string | null;
  matricula: string | null;
  fecha: string | null;
  venta_mxn: number | null;
  venta_usd: number | null;
  cobrado_mxn: number | null;
  cobrado_usd: number | null;
  por_cobrar_mxn: number | null;
  por_cobrar_usd: number | null;
  /** 'YYYY-MM' (pasan / pasarían). */
  destino?: string;
  /** 'YYYY-MM' (vienen). */
  origen?: string;
  leyenda: string;
  /**
   * ADITIVOS (16-oct-2026, «aparece que aún no se cobran pero sí están
   * cobrados»): por qué pasa (`COBRO_POSTERIOR` = se cobró DESPUÉS del
   * corte), el día del corte con el que se midió «cobrado» (YYYY-MM-DD) y,
   * si se sabe, lo cobrado después del corte y la fecha del último cobro.
   * Solo viajan cuando la lista los conoce (pasan / pasarían).
   */
  motivo?: MotivoDiferir;
  corte?: string;
  cobrado_despues_usd?: number | null;
  cobrado_despues_mxn?: number | null;
  fecha_cobro_despues?: string | null;
}

/** Bloque raíz `cierre` de los balances (avión y general) y del Libro Dinero. */
export interface BalanceCierrePayload {
  disponible: true;
  /** 'YYYY-MM' solo si el periodo es un mes calendario completo. */
  periodo: string | null;
  /**
   * Balance por avión: el estado del AVIÓN (CIERRE POR AVIÓN, 23-oct-2026,
   * invariante 105). Balance general y Libro Dinero: el de la FLOTA (puede
   * ser `PARCIAL`). Sin la migración por avión, el de la fila global.
   */
  estado: EstadoMesFlota;
  cerrado_at: string | null;
  cerrado_por_nombre: string | null;
  reabierto_at: string | null;
  reabierto_por_nombre: string | null;
  pasan: BalanceCierreVueloPayload[];
  vienen: BalanceCierreVueloPayload[];
  pasarian: BalanceCierreVueloPayload[];
  /** ADITIVOS (invariante 105; solo con la migración por avión). */
  estado_flota?: EstadoMesFlota;
  aviones_activos?: number;
  aviones_cerrados?: string[];
}

/** Renglón por avión de `resumen_cierre` (general). */
export interface BalanceCierreResumenFilaPayload {
  matricula: string;
  vuelos: number;
  venta_mxn: number;
  por_cobrar_mxn: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Leyenda de la fila sombra (MXN): «Pasa a octubre 2026 (pendiente de
 * cobro: cobrado $0.00 de $36,632.89 MXN)». Sin monto MXN legible, en USD.
 * Con `motivo` COBRO_POSTERIOR (se cobró después del corte): «Pasa a
 * octubre 2026 (cobrado después del 30-sep; al cierre: $0.00 de
 * $36,632.89 MXN)».
 */
export function leyendaSombraBalance(
  destino: string,
  m: {
    venta_mxn: number | null;
    cobrado_mxn: number | null;
    venta_usd: number | null;
    cobrado_usd: number | null;
  },
  motivo?: MotivoDiferir | null,
): string {
  const enMxn = m.venta_mxn != null && Number.isFinite(m.venta_mxn);
  const venta = enMxn ? (m.venta_mxn as number) : (m.venta_usd ?? 0);
  const cobrado = enMxn ? (m.cobrado_mxn ?? 0) : (m.cobrado_usd ?? 0);
  const moneda = enMxn ? 'MXN' : 'USD';
  if (motivo === 'COBRO_POSTERIOR') {
    return `Pasa a ${etiquetaMesMinuscula(destino)} (cobrado después del ${diaCortoDeDia(
      corteDeDestino(destino),
    )}; al cierre: ${dineroTexto(cobrado, moneda)} de ${dineroTexto(venta, moneda)})`;
  }
  return `Pasa a ${etiquetaMesMinuscula(destino)} (pendiente de cobro: cobrado ${dineroTexto(
    cobrado,
    moneda,
  )} de ${dineroTexto(venta, moneda)})`;
}

/**
 * Marca de una fila de un mes ABIERTO que pasaría al cerrar: la de
 * `marcaPasaraAlCerrar` (fuente única; con COBRO_POSTERIOR dice cuándo se
 * cobró en vez de «pendiente de cobro»).
 */
export function leyendaPasariaBalance(
  destino: string,
  d?: Partial<Pick<DecisionDiferir, 'motivo' | 'fecha_cobro_posterior'>> | null,
): string {
  return marcaPasaraAlCerrar(destino, d);
}

/** Fila normal con la migración: las llaves del cierre en su valor neutro. */
export function marcarFilaNormal(fila: BalanceAvionVueloPayload): void {
  fila.cierre_marca = null;
  fila.fila_sombra = false;
  fila.diferido_a = null;
  fila.diferido_de = null;
}

/** FILA SOMBRA: dinero en null, horas reales, marca «Pasa a …». */
export function aplicarFilaSombra(
  fila: BalanceAvionVueloPayload,
  destino: string,
  leyenda: string,
): void {
  fila.horas_cobradas = null;
  fila.tarifa_usd = null;
  fila.iva_hr_usd = null;
  fila.total_usd = null;
  fila.iva_usd = null;
  fila.tc_venta = null;
  fila.total_cotizacion_usd = null;
  fila.total_cotizacion_mxn = null;
  fila.otros_ingresos_usd = null;
  fila.tua_pagado_mxn = null;
  fila.total_mxn = null;
  fila.iva_mxn = null;
  fila.subtotal_mxn = null;
  fila.gas_mxn = null;
  fila.gas_litros = null;
  fila.gas_precio_litro = null;
  fila.op_mxn = null;
  fila.piloto_mxn = null;
  fila.otros_mxn = null;
  fila.permiso_afac_mxn = null;
  fila.permiso_afac_usd_hr = null;
  fila.costo_total_mxn = null;
  fila.tc_costos = null;
  fila.gas_detalle = [];
  fila.op_detalle = [];
  fila.piloto_detalle = [];
  fila.otros_detalle = [];
  fila.op_vinculos = [];
  fila.piloto_vinculos = [];
  fila.otros_vinculos = [];
  fila.costo_usd = null;
  fila.costo_usd_siva = null;
  fila.iva_pagado_usd = null;
  fila.iva_pagado_mxn = null;
  fila.remanente_mxn = null;
  fila.dif_iva_mxn = null;
  fila.comision_vendedor_mxn = null;
  fila.ganancia_mxn = null;
  fila.ganancia_usd = null;
  fila.costo_hr_usd = null;
  fila.costo_hr_usd_siva = null;
  fila.status_cobro = statusCobroSombra(destino);
  fila.cobros = [];
  fila.cobrado_mxn = null;
  fila.cobrado_real_mxn = null;
  fila.por_cobrar_mxn = null;
  fila.por_cobrar_usd = null;
  fila.factura_vuelatour = null;
  delete fila.extension_pagada_mxn;
  delete fila.comisiones_mxn;
  delete fila.comisiones_detalle;
  delete fila.comision_banco_avion_mxn;
  delete fila.comision_vendedor_prov_mxn;
  delete fila.comision_vendedor_real_mxn;
  delete fila.comision_vendedor_real_pagos;
  fila.cierre_marca = leyenda;
  fila.fila_sombra = true;
  fila.diferido_a = destino;
  fila.diferido_de = null;
}

/** FILA QUE VIENE: horas reales en null, dinero completo, «Viene de …». */
export function aplicarFilaViene(
  fila: BalanceAvionVueloPayload,
  origen: string,
): void {
  fila.tiempo_vuelo = null;
  fila.taco_inicio = null;
  fila.taco_fin = null;
  fila.taco_inicio_obs = [];
  fila.taco_fin_obs = [];
  fila.salto_taco_inicio = false;
  fila.salto_taco_esperado = null;
  fila.salto_taco_interno = false;
  fila.salto_taco_interno_detalle = null;
  fila.cierre_marca = leyendaVieneDe(origen);
  fila.fila_sombra = false;
  fila.diferido_a = null;
  fila.diferido_de = origen;
}

/** Elemento de las listas del cierre a partir de la fila (ANTES de vaciarla). */
export function itemCierreDeFila(
  fila: BalanceAvionVueloPayload,
  matricula: string | null,
  extra: {
    venta_usd: number | null;
    cobrado_usd: number | null;
    por_cobrar_usd: number | null;
    destino?: string;
    origen?: string;
    leyenda: string;
    /** ADITIVOS (16-oct-2026): ver `BalanceCierreVueloPayload`. */
    motivo?: MotivoDiferir;
    cobrado_despues_usd?: number | null;
    fecha_cobro_despues?: string | null;
  },
): BalanceCierreVueloPayload {
  const k = fila.tc_venta != null && fila.tc_venta > 0 ? fila.tc_venta : null;
  const ventaMxn =
    fila.total_cotizacion_mxn ??
    (extra.venta_usd != null && k != null ? r2(extra.venta_usd * k) : null);
  const cobradoMxn =
    extra.cobrado_usd != null && k != null
      ? r2(extra.cobrado_usd * k)
      : (fila.cobrado_mxn ?? null);
  return {
    clave: fila.clave,
    vuelo_id: fila.vuelo_id ?? '',
    folio: fila.folio,
    cliente: fila.cliente,
    matricula,
    fecha: fila.fecha,
    venta_mxn: ventaMxn,
    venta_usd: extra.venta_usd,
    cobrado_mxn: cobradoMxn,
    cobrado_usd: extra.cobrado_usd,
    por_cobrar_mxn:
      ventaMxn != null && cobradoMxn != null
        ? r2(Math.max(0, ventaMxn - cobradoMxn))
        : null,
    por_cobrar_usd: extra.por_cobrar_usd,
    ...(extra.destino ? { destino: extra.destino } : {}),
    ...(extra.origen ? { origen: extra.origen } : {}),
    leyenda: extra.leyenda,
    ...(extra.motivo
      ? {
          motivo: extra.motivo,
          ...(extra.destino ? { corte: corteDeDestino(extra.destino) } : {}),
          ...(extra.cobrado_despues_usd !== undefined
            ? {
                cobrado_despues_usd: extra.cobrado_despues_usd,
                cobrado_despues_mxn:
                  extra.cobrado_despues_usd != null && k != null
                    ? r2(extra.cobrado_despues_usd * k)
                    : null,
                fecha_cobro_despues: extra.fecha_cobro_despues ?? null,
              }
            : {}),
        }
      : {}),
  };
}

/** `resumen_cierre` del general: por matrícula, Σ de las listas. */
export function resumenCierrePorAvion(
  items: ReadonlyArray<BalanceCierreVueloPayload>,
): BalanceCierreResumenFilaPayload[] {
  const porMat = new Map<string, BalanceCierreResumenFilaPayload>();
  const vistos = new Set<string>();
  for (const it of items) {
    const mat = it.matricula ?? 'EXTERNOS';
    const llave = `${mat}|${it.vuelo_id}`;
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    const acc = porMat.get(mat) ?? {
      matricula: mat,
      vuelos: 0,
      venta_mxn: 0,
      por_cobrar_mxn: 0,
    };
    acc.vuelos += 1;
    acc.venta_mxn = r2(acc.venta_mxn + (it.venta_mxn ?? 0));
    acc.por_cobrar_mxn = r2(acc.por_cobrar_mxn + (it.por_cobrar_mxn ?? 0));
    porMat.set(mat, acc);
  }
  return [...porMat.values()].sort((a, b) =>
    a.matricula.localeCompare(b.matricula, 'es'),
  );
}

/**
 * Pendiente del libro por los vuelos que SALEN: «Avión N621TX: 3 vuelo(s)
 * pasan a octubre 2026 por cobro pendiente al cerrar septiembre 2026 (#337,
 * #343, #344) — no suman en este mes».
 */
export function pendienteVuelosQuePasan(
  etiquetaLibro: string,
  pasan: ReadonlyArray<BalanceCierreVueloPayload>,
): string[] {
  const porDestino = new Map<string, BalanceCierreVueloPayload[]>();
  for (const p of pasan) {
    const d = p.destino ?? '';
    porDestino.set(d, [...(porDestino.get(d) ?? []), p]);
  }
  return [...porDestino.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([destino, lista]) => {
      const folios = lista.map((p) => `#${p.folio}`).join(', ');
      const mes = destino ? etiquetaMesMinuscula(destino) : 'otro mes';
      return `${etiquetaLibro}: ${lista.length} vuelo(s) pasan a ${mes} por cobro pendiente al cerrar el mes (${folios}) — no suman en este mes`;
    });
}

/**
 * `cierre` + `resumen_cierre` del Balance GENERAL a partir de los libros
 * (aviones + EXTERNOS): las listas concatenadas (cada elemento ya trae su
 * matrícula) y el resumen por matrícula. Sin `cierre` en los libros (sin la
 * migración) ⇒ `{}` (el payload de siempre).
 */
export function cierreDelGeneral(
  libros: ReadonlyArray<{ cierre?: BalanceCierrePayload }>,
): {
  cierre?: BalanceCierrePayload;
  resumen_cierre?: {
    pasan: BalanceCierreResumenFilaPayload[];
    vienen: BalanceCierreResumenFilaPayload[];
  };
} {
  const conCierre = libros
    .map((l) => l.cierre)
    .filter((c): c is BalanceCierrePayload => c != null);
  if (conCierre.length === 0) return {};
  const base = conCierre[0];
  const porFolio = (
    a: BalanceCierreVueloPayload,
    b: BalanceCierreVueloPayload,
  ) =>
    (Number(a.folio) || 0) - (Number(b.folio) || 0) ||
    (a.matricula ?? '').localeCompare(b.matricula ?? '', 'es');
  const pasan = conCierre.flatMap((c) => c.pasan).sort(porFolio);
  const vienen = conCierre.flatMap((c) => c.vienen).sort(porFolio);
  const pasarian = conCierre.flatMap((c) => c.pasarian).sort(porFolio);
  return {
    cierre: {
      ...base,
      // CIERRE POR AVIÓN (invariante 105): el general dice el estado de la
      // FLOTA (el `estado` de cada libro es el de su avión).
      ...(base.estado_flota ? { estado: base.estado_flota } : {}),
      pasan,
      vienen,
      pasarian,
    },
    resumen_cierre: {
      pasan: resumenCierrePorAvion(pasan),
      vienen: resumenCierrePorAvion(vienen),
    },
  };
}
