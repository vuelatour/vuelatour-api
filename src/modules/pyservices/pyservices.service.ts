import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';
import type { UsoIaPayload } from '../ia-uso/ia-uso.service';

export interface RepartoSocioPayload {
  socio_nombre: string;
  porcentaje: number;
  monto_usd: number;
}

/**
 * Composición COTIZADA (pre-IVA + su IVA) del ingreso de VuelaTour — nombres
 * exactos de `RepartoOtrosIngresosDesglose` (pyservices app/schemas/reparto.py).
 * Solo informativo: nada de esto se reparte.
 */
export interface RepartoOtrosIngresosDesglosePayload {
  tuas_usd: number;
  extras_usd: number;
  pernocta_usd: number;
  /** Comisión del vendedor (pre-IVA): ingreso de VuelaTour, no del avión. */
  comision_usd: number;
  iva_usd: number;
}

/**
 * Un vuelo del avión en el PDF/XLSX del reparto — nombres exactos de
 * `RepartoVueloLinea` (pyservices). `cobrado_usd`/`pendiente_usd` son la
 * PARTE DEL AVIÓN (venta del avión); `participacion` < 1 = multi-avión.
 */
export interface RepartoVueloLineaPayload {
  folio: number | string | null;
  cliente: string | null;
  fecha: string | null;
  estado: string | null;
  cobrado_usd: number;
  pendiente_usd: number;
  participacion: number;
  multi_avion: boolean;
  /** Tramos de este avión ("CUN→MID"); informativo. */
  tramos_avion: string | null;
}

export interface RepartoAvionPayload {
  matricula: string;
  modelo: string;
  ingresos_cobrado_usd: number;
  pendiente_cobro_usd: number;
  /**
   * Deuda COMPLETA del cliente pendiente de cobro (total de la cotización −
   * cobrado, USD), SIN partir entre avión y VuelaTour. Informativo: lo que
   * el cliente aún debe; `pendiente_cobro_usd` es solo la parte del AVIÓN.
   */
  pendiente_bruto_usd?: number;
  gastos_directos_usd: number;
  gastos_indirectos_usd: number;
  permisos_usd: number;
  otros_usd: number;
  reserva_overhaul_usd: number;
  saldo_usd: number;
  reparto: RepartoSocioPayload[];
  /**
   * Ingreso de VUELATOUR excluido del reparto del avión (regla 28-ago):
   * TUAS + extras + pernocta cobrados + su IVA (particionIngresoVuelo).
   * Informativo: no entra a saldo_usd ni al reparto de socios.
   */
  otros_ingresos_vuelatour_usd?: number;
  /** Composición cotizada del bloque anterior (incluye comision_usd). */
  otros_ingresos_vuelatour_desglose?: RepartoOtrosIngresosDesglosePayload;
  /** Detalle de vuelos del avión (vacío = el PDF no lo imprime). */
  vuelos?: RepartoVueloLineaPayload[];
  /**
   * ADITIVOS (29-ago-2026): gastos MXN sin tc_gasto convertidos con el TC
   * oficial de referencia del día del gasto, y vuelos cuyos cobros MXN sin
   * TC se convirtieron con el TC oficial del día de la cotización. Ya están
   * DENTRO de los montos; solo alimentan una nota del PDF/XLSX.
   */
  gastos_tc_oficial?: { count: number; monto_mxn: number };
  cobros_tc_oficial_count?: number;
}

/** Resumen global del TC oficial de respaldo usado en el periodo (nota). */
export interface RepartoTcOficialPayload {
  vuelos: number;
  gastos: { count: number; monto_mxn: number };
  /** Fuentes legibles ("open.er-api", "BCE (frankfurter)"). */
  fuentes: string[];
  leyenda: string;
}

export interface RepartoPdfPayload {
  periodo_desde: string;
  periodo_hasta: string;
  generado: string;
  aviones: RepartoAvionPayload[];
  /** Σ otros_ingresos_vuelatour_usd de todos los aviones (informativo). */
  otros_ingresos_vuelatour_total_usd?: number;
  /** Composición del Σ anterior (Σ de los desgloses por avión). */
  otros_ingresos_vuelatour_desglose?: RepartoOtrosIngresosDesglosePayload;
  /** Nota global del TC oficial de respaldo (29-ago); opcional. */
  tc_oficial?: RepartoTcOficialPayload;
}

export type TablaColumnaTipo = 'texto' | 'money' | 'numero' | 'entero' | 'pct';
export interface TablaColumnaPayload {
  label: string;
  tipo?: TablaColumnaTipo;
}
export interface TablaXlsxPayload {
  titulo: string;
  subtitulo?: string;
  columnas: TablaColumnaPayload[];
  filas: (string | number | null)[][];
  totales?: (string | number | null)[];
  /** Bloque resumen arriba de la tabla: pares [etiqueta, valor]. */
  resumen_titulo?: string;
  resumen?: (string | number | null)[][];
  /**
   * ADITIVO: celdas de `filas` a resaltar (índices 0-based relativos a
   * `filas`; color hex sin "#", default naranja ED7D31). P. ej. los montos
   * SIN conciliar del reporte de conciliación. Omitirlo = render de siempre.
   */
  resaltes?: { fila: number; col: number; color?: string }[];
}

export interface ReporteVueloLineaPayload {
  fecha?: string | null;
  concepto?: string;
  detalle?: string | null;
  moneda?: string | null;
  monto?: number | null;
  /** Litros cargados (solo líneas de combustible; precio x litro = monto/litros). */
  litros?: number | null;
}
export interface ReporteVueloTramoPayload {
  orden: number;
  ruta: string;
  pasajeros?: number | null;
  pasajeros_nombres?: string | null;
  taco_salida?: number | null;
  taco_llegada?: number | null;
  horas?: number | null;
  es_ferry?: boolean;
  // Tripulación por tramo (29-ago, aditivo; pyservices ignora lo que no
  // conoce): piloto/copiloto EFECTIVOS y apoyos efectivos (nombres).
  piloto?: string | null;
  copiloto?: string | null;
  apoyos?: string[];
}
// ===== Bitácoras de vuelo del avión (PDF): una TIRA (página) por libro —
// planeador, motor, hélice — con las mismas filas y distinto tiempo
// acumulado. Espejo de BitacoraTacoRequest/BitacoraTira en pyservices. =====
export type BitacoraTiraTipo = 'PLANEADOR' | 'MOTOR' | 'HELICE';
/** Fila de una tira: UN vuelo. tiempo_* = acumulado del componente derivado
 *  del tacómetro (null ⇒ el PDF pinta "—" para llenarlo a mano). */
export interface BitacoraTiraFilaPayload {
  fecha: string;
  taco_inicial: number;
  horas: number;
  taco_final: number;
  tiempo_inicial: number | null;
  tiempo_final: number | null;
  ruta: string;
}
export interface BitacoraTiraPayload {
  tipo: BitacoraTiraTipo;
  /** "Bitácora de planeador", "Bitácora de motor izquierdo", ... */
  titulo: string;
  /** Encabezado de las columnas de tiempo: "Tiempo planeador", ... */
  etiqueta: string;
  /** Origen de la base (gris chico bajo el encabezado) o null. */
  nota: string | null;
  /** false ⇒ solo las columnas de tacómetro (sin columnas de tiempo). */
  con_tiempo: boolean;
  filas: BitacoraTiraFilaPayload[];
}
export interface BitacoraTacoPayload {
  matricula: string;
  modelo: string | null;
  desde: string | null;
  hasta: string | null;
  generado: string;
  tiras: BitacoraTiraPayload[];
}
// ===== Recibo de pago por cobro (PDF NO fiscal). Espejo de
// ReciboPdfRequest en pyservices (todo con default allá: skew tolerante). =====
export interface ReciboAbonoPdfPayload {
  fecha?: string | null;
  /** Negativo = reembolso (se pinta restando, con su etiqueta). */
  monto?: number;
  moneda?: string;
  /** "Abono" / "Reembolso". */
  etiqueta?: string | null;
}
export interface ReciboPdfPayload {
  folio_recibo?: string;
  empresa?: string;
  cliente?: string;
  vuelo_folio?: string;
  ruta?: string;
  fecha_vuelo?: string | null;
  fecha_cobro?: string | null;
  /** BRUTO que pagó el cliente, en su moneda (sin comisión bancaria). */
  monto?: number;
  moneda?: string;
  tc_usd_mxn?: number | null;
  equivalente_usd?: number | null;
  /** Método YA legible ("Transferencia", "BillPocket"…). */
  metodo?: string;
  cuenta_destino?: string | null;
  referencia?: string | null;
  total_cotizacion_usd?: number;
  cobrado_a_la_fecha_usd?: number;
  saldo_pendiente_usd?: number;
  liquidado?: boolean;
  sin_tc_nota?: string | null;
  notas?: string | null;
  cobros_previos?: ReciboAbonoPdfPayload[];
}
// ===== Libro "Dinero <periodo>" (réplica del control manual del equipo) =====
export interface DineroCobroPagoPayload {
  fecha?: string | null;
  monto_mxn?: number | null;
}
export interface DineroVueloFilaPayload {
  clave: string;
  matricula?: string | null;
  color?: string | null;
  fecha?: string | null;
  ruta: string;
  tiempo?: number | null;
  venta_hr_usd?: number | null;
  venta_hr_mxn?: number | null;
  iva_hr_usd?: number | null;
  venta_hr_masiva_usd?: number | null;
  total_cobrado_usd?: number | null;
  iva_total_usd?: number | null;
  tc_venta?: number | null;
  total_cobrado_mxn?: number | null;
  iva_total_mxn?: number | null;
  total_siva_mxn?: number | null;
  status_cobro?: string | null;
  cobros?: DineroCobroPagoPayload[];
  total_cobros_mxn?: number | null;
  me_deben_mxn?: number | null;
  factura_vuelatour?: string | null;
  /**
   * Total que paga el CLIENTE (monto_total_usd y su MXN): informativo al
   * lado de la venta del avión — regla 28-ago (la venta excluye TUAS/
   * extras/pernocta; el cruce venta + ingreso VuelaTour == total cliente).
   */
  total_cliente_usd?: number | null;
  total_cliente_mxn?: number | null;
  /**
   * Regla B (28-ago-2026, vuelo multi-avión): fracción de la venta del
   * avión que lleva ESTA fila (1 en vuelos de un solo avión) y si el vuelo
   * emitió una fila por avión (la clave lleva el sufijo "(50 % N4142R)").
   */
  participacion?: number | null;
  multi_avion?: boolean;
}
export interface DineroOtroIngresoFilaPayload {
  clave: string;
  fecha_vuelo?: string | null;
  concepto_egreso?: string | null;
  egreso_mxn?: number | null;
  fecha_egreso?: string | null;
  /** Nota/comentario de la celda del egreso (p. ej. "PROVISIÓN…"). */
  nota_egreso?: string | null;
  concepto_ingreso?: string | null;
  ingreso_mxn?: number | null;
  fecha_ingreso?: string | null;
  remanente_mxn?: number | null;
  factura?: string | null;
}
export interface DineroOtroGastoFilaPayload {
  fecha?: string | null;
  concepto: string;
  monto_mxn?: number | null;
  acumulado_mxn?: number | null;
}
export interface DineroUtilidadAvionPayload {
  matricula: string;
  gastos_indirectos_mxn?: number | null;
  otros_gastos_mxn?: number | null;
  permisos_mxn?: number | null;
  /** "Gasto de combustible" del mes del avión (pestaña Combustible). */
  combustible_mxn?: number | null;
}

/** Fila de la pestaña "Combustible" del Libro Dinero (26-ago-2026). */
export interface DineroCombustibleFilaPayload {
  fecha?: string | null;
  /** Matrícula del avión ('—' = carga sin avión, pendiente de asignar). */
  matricula: string;
  avion_color?: string | null;
  concepto: string;
  litros?: number | null;
  monto_mxn?: number | null;
  acumulado_mxn?: number | null;
}
export interface DineroXlsxPayload {
  periodo_desde?: string | null;
  periodo_hasta?: string | null;
  generado?: string | null;
  leyenda_colores?: {
    matricula: string;
    modelo?: string;
    color?: string | null;
  }[];
  vuelos: DineroVueloFilaPayload[];
  otros_ingresos: DineroOtroIngresoFilaPayload[];
  otros_gastos: DineroOtroGastoFilaPayload[];
  /** Pestaña "Combustible": el gas del mes por avión (26-ago-2026). */
  combustible?: DineroCombustibleFilaPayload[];
  combustible_total_mxn?: number | null;
  combustible_litros?: number | null;
  combustible_precio_litro?: number | null;
  /** Cargas del mes sin avión (van marcadas en la pestaña). */
  combustible_sin_avion?: number;
  /** "Gasto de combustible" del mes: resta en la hoja utilidades. */
  utilidades_combustible_mxn?: number | null;
  /**
   * Otros ingresos del mes NETOS de la provisión del pago al vendedor
   * (Σ ingreso_mxn de la hoja "otros ingresos" − Σ egresos provisionados
   * de comisión): ese egreso no es gasto de ninguna otra hoja, así que si
   * no se descuenta aquí la utilidad lo cuenta como ingreso puro.
   */
  utilidades_otros_ingresos_mxn?: number | null;
  /** Provisión del pago al vendedor ya descontada arriba (informativo). */
  utilidades_comision_vendedor_provisionada_mxn?: number | null;
  utilidades_otros_gastos_mxn?: number | null;
  utilidades_tc?: number | null;
  utilidades_aviones?: DineroUtilidadAvionPayload[];
}

export interface ReporteVueloPayload {
  generado: string;
  folio: string;
  cliente?: string;
  aeronave?: string | null;
  piloto?: string | null;
  copiloto?: string | null;
  /** Apoyos de nivel vuelo (nombres; 29-ago, aditivo). */
  apoyos?: string[];
  tipo?: string;
  estado?: string;
  ruta?: string;
  fecha_vuelo?: string | null;
  fecha_traslado_final?: string | null;
  pasajeros?: number;
  pasajeros_nombres?: string | null;
  tarifa_tipo?: string | null;
  tarifa_hora_usd?: number | null;
  tiempo_cobrable_hr?: number | null;
  subtotal_usd?: number;
  tuas_usd?: number;
  /** Detalle de TUAS por aeropuerto CON su moneda (líneas del desglose
   *  canónico, informativas; la fila numérica tuas_usd sigue cuadrando). */
  tuas_detalle?: string[];
  iva_usd?: number;
  viaticos_pernocta_usd?: number;
  extras_total_usd?: number;
  ajuste_final_usd?: number;
  total_usd?: number;
  total_mxn?: number | null;
  tc_usd_mxn?: number | null;
  // Comisión del vendedor (interna, pre-IVA).
  comision_vendedor_usd?: number;
  comision_vendedor_nombre?: string | null;
  /**
   * Lo que VuelaTour paga al vendedor: comisión + su IVA cuando la
   * cotización grava (`pagoVendedorUsd`, fuente única). null sin comisión.
   */
  pago_vendedor_usd?: number | null;
  /** total − pago_vendedor_usd (neto de VuelaTour = precio base con su IVA). */
  neto_vuelatour_usd?: number | null;
  metodo_cobro?: string | null;
  tramos?: ReporteVueloTramoPayload[];
  // Comparación horas cotizadas vs voladas (utilidad operativa) + motivos.
  horas_cotizadas_hr?: number | null;
  horas_voladas_hr?: number | null;
  horas_delta_hr?: number | null;
  notas_horas?: string[];
  cobros?: ReporteVueloLineaPayload[];
  total_cobrado_usd?: number;
  /** Comisiones bancarias de los cobros (USD): el banco depositó menos. */
  comision_banco_usd?: number;
  /** Total cobrado − comisiones bancarias = lo que entró a la cuenta. */
  total_cobrado_neto_usd?: number | null;
  saldo_usd?: number;
  combustible?: ReporteVueloLineaPayload[];
  gastos?: ReporteVueloLineaPayload[];
  // ===== Economía del vuelo (formato de los Excel de control del equipo:
  // "Balance VGV" / "Dinero"): venta vs costo, remanente y ganancia. =====
  /** Tacómetro global: primera salida y última llegada con lectura. */
  taco_inicio?: number | null;
  taco_fin?: number | null;
  /** Gastos del vuelo convertidos a USD (misma regla que el reparto:
   *  USD directo, MXN ÷ tc_gasto; los sin TC se excluyen y se reportan). */
  gastos_total_usd?: number;
  combustible_total_usd?: number;
  gastos_sin_tc_count?: number;
  gastos_sin_tc_mxn?: number;
  /** Venta sin IVA (total − IVA): base del % de ganancia, como en el Excel. */
  venta_sin_iva_usd?: number;
  /** Venta (total c/IVA) − gastos del vuelo. */
  remanente_usd?: number | null;
  /** Remanente − comisión vendedor − comisiones bancarias. */
  ganancia_final_usd?: number | null;
  /** Ganancia / horas cobradas (fallback: voladas), como el Excel. */
  ganancia_x_hr_usd?: number | null;
  /** Ganancia / venta sin IVA. */
  ganancia_pct?: number | null;
  notas?: string | null;
  /**
   * Partición del ingreso (regla 28-ago, particionIngresoVuelo): venta del
   * AVIÓN (tiempo + ajuste + IVA proporcional) e ingreso de VUELATOUR (TUAS
   * + extras + pernocta + comisión del vendedor + su IVA). Suman total_usd.
   */
  venta_avion_usd?: number | null;
  otros_ingresos_vuelatour_usd?: number | null;
  /**
   * Regla B (28-ago-2026): vuelo MULTI-AVIÓN — reparto de la venta del
   * avión entre los aviones que volaron sus tramos (participacionPorAeronave
   * + repartirUsd; Σ venta_usd == venta_avion_usd). Solo viaja cuando
   * participa más de un avión.
   */
  participacion_aviones?: ReporteVueloParticipacionPayload[];
}
export interface ReporteVueloParticipacionPayload {
  aeronave_id: string;
  matricula: string;
  /** Fracción (0, 1], 4 decimales. */
  factor: number;
  /** Tramos activos que voló este avión. */
  tramos: number;
  /** Parte de la venta del avión (USD, centavos por residuo mayor). */
  venta_usd: number;
}

// ===== Balance por avión (réplica sistematizada del Excel "Balance N990GG") =====
// El API calcula TODO el dinero; pyservices SOLO pinta el libro (null = celda
// vacía, nunca 0 falso).

export interface BalanceAvionCobroPayload {
  fecha: string | null;
  /** Monto REAL de la parcialidad en MXN (null = USD sin TC: no convertible).
   *  MULTI-AVIÓN: la parte de ESTA FILA (`parteFilaDeCobro`: parte del
   *  avión por tramo + la parte VuelaTour en la fila que reporta; Σ entre
   *  libros == el depósito). */
  monto_mxn: number | null;
  metodo?: string | null;
  /**
   * Comisión bancaria del cobro a MXN (punto 9 del cliente, 28-ago): MXN
   * directo; USD × (TC del cobro ?? TC de venta); sin TC → null.
   */
  comision_mxn?: number | null;
  /** Cuenta destino del cobro (cobro_vuelo.cuenta_destino). */
  cuenta?: string | null;
}

export interface BalanceAvionVueloPayload {
  /** Balance GENERAL: la fila se tiñe con el color del avión. */
  avion_color?: string | null;
  /**
   * Llave interna de orden cronológico (ISO): salida planeada más temprana
   * de los tramos del avión de la fila. Solo ordena (individual y
   * consolidado de flota) — pyservices no la pinta.
   */
  orden_ts?: string | null;
  /** Columna CLAVE del libro: "#<folio> · <cliente>". */
  clave: string;
  /**
   * Id del vuelo (28-ago): el consolidado de flota deduplica con él el
   * conteo de VUELOS del RESUMEN (un multi-avión es una fila por libro).
   * Solo interno — pyservices no lo pinta.
   */
  vuelo_id?: string;
  folio: string;
  cliente: string | null;
  estado: string;
  /**
   * true en filas CANCELADO (regla 28-ago tarde): la venta es lo REALMENTE
   * cobrado (cargo por cancelación / anticipo retenido; 100 % del avión, sin
   * partición), nada queda por cobrar y los costos reales se listan igual.
   * total_cotizacion_* viaja solo informativo. pyservices puede rotularla.
   */
  cancelado?: boolean;
  /**
   * true (28-ago) = vuelo AJENO cuyo único tramo de este avión se CANCELÓ y
   * que entra al libro solo por los gastos ligados a ese tramo (factor 0:
   * sin venta, cobros ni horas; la ruta dice "TRAMO CANCELADO (solo
   * gastos)"). Solo informativo para pyservices.
   */
  solo_gastos_tramo_cancelado?: boolean;
  /**
   * Vuelo cubierto por un operador AJENO. Con avión de referencia vive en
   * el libro de ese avión; sin avión, en el libro EXTERNOS del general
   * (regla 28-ago tarde: "un vuelo más"). pyservices pinta la clave en
   * gris/itálica. Su costo del operador va en OPERACIONES (op_detalle).
   */
  es_externo: boolean;
  /** Operador ajeno (texto libre, p. ej. XA-TYV); solo si es_externo. */
  operador_externo?: string | null;
  /** Fecha del vuelo (día Cancún, YYYY-MM-DD). */
  fecha: string | null;
  /** Fin del traslado si el vuelo es multi-día (día Cancún). */
  fecha_fin: string | null;
  ruta: string;
  // Bloque VENTA
  horas_cobradas: number;
  tarifa_usd: number | null;
  iva_hr_usd: number | null;
  /**
   * VENTA DEL AVIÓN (regla 28-ago): tiempo + ajuste + IVA proporcional
   * (particionIngresoVuelo). TUAS/extras/pernocta/comisión del vendedor y
   * su IVA quedan FUERA (otros_ingresos_usd). Sin cotización: horas ×
   * tarifa. CANCELADO: lo realmente cobrado (cobrosEnUsd), sin partición.
   * MULTI-AVIÓN (regla B, 28-ago tarde): la PARTE de este avión
   * (`participacion`; Σ partes entre libros == venta del vuelo exacta).
   */
  total_usd: number | null;
  /**
   * Fracción de este avión en la venta del vuelo (regla B): 1 en vuelos de
   * un solo avión; en multi-avión la parte por tramo (horas cobradas,
   * venta, IVA, cobros y por cobrar de la fila ya vienen repartidos).
   */
  participacion?: number;
  /** true = vuelo con tramos en más de un avión (la ruta dice el %). */
  multi_avion?: boolean;
  /**
   * Peso del reparto: 'tramos' = partes iguales por tramo VENDIDO (regla
   * literal del cliente, 28-ago: ida/regreso mitad y mitad; los tramos
   * operativos/ferry no venden), 'unico' = un solo avión. 'tacos' y
   * 'cotizacion' quedan reservados en el tipo: participacionPorAeronave ya
   * no los emite (nunca horas, ni reales ni cotizadas).
   */
  participacion_fuente?: 'tacos' | 'cotizacion' | 'tramos' | 'unico';
  /** IVA de la venta del avión (proporcional). */
  iva_usd: number | null;
  tc_venta: number | null;
  /** Total que paga el CLIENTE (monto_total_usd) — informativo. */
  total_cotizacion_usd?: number | null;
  /** total_cotizacion_usd × TC de venta. */
  total_cotizacion_mxn?: number | null;
  /** avion_usd / total_usd de la partición (1 sin precio); prorratea cobros. */
  venta_factor?: number | null;
  /** Ingreso de VUELATOUR de la fila: TUAS + extras + pernocta + su IVA
   *  (+ redondeo), EXCLUIDO de total_usd. total_usd + otros_ingresos_usd ==
   *  total_cotizacion_usd (no aplica en CANCELADO: 0 — su venta son los
   *  cobros retenidos y la cotización es solo referencia). */
  otros_ingresos_usd?: number | null;
  /** TUA pagado del vuelo (categoría TUAS + parte embebida), MXN. SOLO
   *  informativo (regla 7, 28-ago): no suma en OP ni en ninguna hoja. null si 0. */
  tua_pagado_mxn?: number | null;
  /** true = TC no capturado en la cotización: se usó el TC oficial de
   *  referencia (open.er-api / BCE) del día de la cotización. */
  tc_venta_oficial?: boolean;
  /** Fuente legible del TC oficial de la fila (solo con tc_venta_oficial):
   *  "open.er-api" / "BCE (frankfurter)" / "Banxico FIX (histórico)". */
  tc_venta_oficial_fuente?: string;
  /** Día real del dato del TC oficial (YYYY-MM-DD; ≤ día de la cotización
   *  en fines de semana/festivos). Solo con tc_venta_oficial. */
  tc_venta_oficial_fecha?: string;
  total_mxn: number | null;
  iva_mxn: number | null;
  subtotal_mxn: number | null;
  // Bloque TIEMPO/TACO
  tiempo_vuelo: number | null;
  taco_inicio: number | null;
  taco_fin: number | null;
  /** Salto en la cadena: el taco inicial NO empalma con el final de la fila
   *  anterior del avión (mismo amarillo que el detalle del avión en el panel). */
  salto_taco_inicio?: boolean;
  /** Valor con el que debía empalmar (taco final anterior), para la nota. */
  salto_taco_esperado?: number | null;
  /** Salto INTERNO: un tramo del vuelo no empalma con el anterior (infla
   *  las horas sin romper la cadena entre vuelos). */
  salto_taco_interno?: boolean;
  salto_taco_interno_detalle?: string | null;
  /** Observaciones del equipo (Tacómetros en vivo): líneas formateadas. */
  taco_inicio_obs?: string[];
  taco_fin_obs?: string[];
  // Bloque COSTOS (MXN)
  gas_mxn: number | null;
  gas_litros: number | null;
  gas_precio_litro: number | null;
  op_mxn: number | null;
  piloto_mxn: number | null;
  otros_mxn: number | null;
  permiso_afac_mxn: number | null;
  costo_total_mxn: number;
  tc_costos: number | null;
  /** Desglose por celda (nota de Excel): una línea por gasto, p. ej.
   *  "Comida · Starbucks — $206.00". Vacío = sin nota. */
  gas_detalle?: string[];
  op_detalle?: string[];
  piloto_detalle?: string[];
  otros_detalle?: string[];
  // Bloque INDICADORES USD e IVA
  costo_usd: number | null;
  costo_usd_siva: number | null;
  iva_pagado_usd: number | null;
  iva_pagado_mxn: number | null;
  /** null solo en una fila COMPARTIDA sin participación en la venta. */
  remanente_mxn: number | null;
  dif_iva_mxn: number | null;
  /** SIEMPRE null (regla A, 28-ago tarde): la comisión del vendedor ya no
   *  es costo del avión — vive en "Otros movimientos" del general. Campo
   *  conservado por compatibilidad de shape. */
  comision_vendedor_mxn: number | null;
  ganancia_mxn: number | null;
  ganancia_usd: number | null;
  costo_hr_usd: number | null;
  costo_hr_usd_siva: number | null;
  // Bloque STATUS DE COBROS
  status_cobro: string;
  cobros: BalanceAvionCobroPayload[];
  /** Lo cobrado que cuenta para el AVIÓN (cobrosEnUsd → cobradoParteAvion
   *  → parte multi-avión → × TC de venta). */
  cobrado_mxn: number;
  /** Σ parcialidades REALES en MXN (sin prorratear entre avión/VuelaTour);
   *  en multi-avión, la parte de ESTA FILA del MXN real del vuelo
   *  (`parteFilaDeCobro`: parte del avión por tramo + la parte VuelaTour en
   *  la fila que reporta; una sola partición; las líneas de `cobros` suman
   *  exactamente esto). Difiere de cobrado_mxn en filas repartidas (caminos
   *  USD vs MXN distintos a propósito; la fila que reporta lleva además lo
   *  cobrado de VuelaTour). */
  cobrado_real_mxn?: number | null;
  /** total_mxn − cobrado_mxn TAL CUAL (semántica del libro): NEGATIVO =
   *  sobrecobro o cobros en un vuelo sin TC/sin precio — se muestra, no se
   *  topa en 0. */
  por_cobrar_mxn: number;
  por_cobrar_usd: number | null;
}

export interface BalanceAvionTotalesPayload {
  horas_cobradas: number;
  tiempo_vuelo: number;
  total_mxn: number;
  iva_mxn: number;
  subtotal_mxn: number;
  gas_mxn: number;
  gas_litros: number;
  op_mxn: number;
  piloto_mxn: number;
  otros_mxn: number;
  permiso_afac_mxn: number;
  costo_total_mxn: number;
  remanente_mxn: number;
  dif_iva_mxn: number;
  comision_vendedor_mxn: number;
  ganancia_mxn: number;
  ganancia_usd: number;
  cobrado_mxn: number;
  por_cobrar_mxn: number;
  por_cobrar_usd: number;
  /** Promedio simple de los TC de costos (Z) no nulos del periodo. */
  tc_promedio: number | null;
  /** Promedio de costo por hora volada (AN) SOLO sobre no nulos. */
  costo_hr_prom_usd: number | null;
  /**
   * Ingreso de VUELATOUR del periodo (regla 28-ago): TUAS + extras +
   * pernocta cobrados + su IVA, EXCLUIDOS de las filas. Cuadre: Σ
   * filas.total_usd + otros_ingresos_usd == Σ monto_total_usd de los vuelos
   * propios con precio. Va a la pestaña "Otros movimientos" del general.
   */
  otros_ingresos_usd: number | null;
  /** Σ cobrado_real_mxn de las filas (parcialidades tal cual). */
  cobrado_real_mxn?: number | null;
  /** Σ total_cotizacion_mxn de las filas (total del cliente en MXN). */
  total_cotizacion_mxn?: number | null;
  /** Σ tua_pagado_mxn: informativo, NO resta en ninguna hoja ni cascada.
   *  null cuando no hubo TUA pagado (celda vacía, no "$0"). */
  tua_pagado_mxn?: number | null;
  /** Σ comisiones bancarias convertibles de los cobros de las filas. */
  comision_banco_mxn?: number | null;
}

export interface BalanceAvionGastoFilaPayload {
  fecha: string | null;
  /** Categoría del gasto (etiqueta amable es-MX) — columna CATEGORÍA de las
   *  hojas de gastos (29-ago-2026). null = API sin el dato. */
  categoria?: string | null;
  detalle: string;
  /** null = moneda extranjera sin TC (no convertible; va a pendientes). */
  monto_mxn: number | null;
  moneda_original: string | null;
  monto_original: number | null;
  /** Litros de la carga (solo hoja "combustible"). */
  litros?: number | null;
  /** Balance GENERAL: la fila se tiñe con el color del avión. */
  avion_color?: string | null;
  /**
   * Matrícula del avión de la fila (hoja "combustible" del GENERAL, 28-ago):
   * pyservices agrupa la hoja en SECCIONES por matrícula con subtotal.
   */
  matricula?: string | null;
  /** Movimiento de cardex ligado (solo hoja "refacciones", 29-ago): el
   *  GENERAL lo usa para el costo FIFO; pyservices lo ignora. */
  inventario_movimiento_id?: string | null;
  /** Solo hoja "refacciones" del GENERAL (29-ago): costo FIFO de la salida
   *  y VENTA al avión (= monto del gasto). pyservices pinta GANANCIA =
   *  venta − costo (0 mientras la salida se cargue a costo). */
  costo_mxn?: number | null;
  venta_mxn?: number | null;
}

export interface BalanceAvionHojaGastosPayload {
  filas: BalanceAvionGastoFilaPayload[];
  total_mxn: number;
  /** total_mxn al TC promedio del periodo (null = sin TC en el periodo). */
  usd: number | null;
  /** usd / horas voladas del periodo. */
  usd_hr: number | null;
}

/** Hoja "combustible" (26-ago-2026): el gas del avión POR MES, con litros. */
export interface BalanceAvionHojaCombustiblePayload extends BalanceAvionHojaGastosPayload {
  litros_total: number;
  /** total_mxn / litros_total (null si no hay litros capturados). */
  precio_litro_prom: number | null;
}

export interface BalanceAvionSocioPayload {
  nombre: string;
  porcentaje: number;
  monto_usd: number | null;
}

export interface BalanceAvionBalancePayload {
  utilidad_antes_usd: number;
  /** "Gasto de combustible" del mes (hoja combustible al TC promedio). */
  combustible_usd?: number | null;
  gastos_indirectos_usd: number | null;
  /** Hoja "refacciones" (29-ago): salidas de inventario, ANTES dentro de
   *  gastos indirectos — indirectos + refacciones == lo de antes (la
   *  utilidad no cambia). Opcional por skew de deploy. */
  refacciones_usd?: number | null;
  otros_usd: number | null;
  permisos_usd: number | null;
  utilidad_despues_usd: number | null;
  por_cobrar_usd: number;
  utilidad_cobrada_usd: number | null;
  socios: BalanceAvionSocioPayload[];
}

/** Fila del RESUMEN del balance general (= totales del libro de un avión). */
export interface BalanceGeneralResumenFilaPayload {
  matricula: string;
  /** Color del avión (aeronave.color_calendario) — leyenda del libro. */
  color: string | null;
  vuelos: number;
  horas: number | null;
  horas_cobradas: number | null;
  venta_mxn: number | null;
  costo_mxn: number | null;
  /** "Gasto de combustible" del mes (hoja combustible del avión). */
  combustible_mxn?: number | null;
  /** SIEMPRE 0 (regla A, 28-ago tarde): la comisión del vendedor ya no es
   *  costo del avión. Campo conservado por compatibilidad de shape. */
  comisiones_mxn?: number | null;
  /** VENTA − COSTO − COMBUSTIBLE = GANANCIA (leyenda impresa). */
  ganancia_mxn: number | null;
  cobrado_mxn: number | null;
  por_cobrar_mxn: number | null;
  pendientes: number;
}

/**
 * Fila del bloque POR ÍTEM de la hoja "inventario" del Balance GENERAL
 * (tiendita, 30-ago-2026). EXISTENCIA y VALOR A COSTO son A HOY (todo el
 * cardex FIFO), no una foto al corte del periodo; el resto es del periodo.
 * null = celda vacía (sin actividad de ese tipo), nunca un 0 falso.
 */
export interface BalanceInventarioItemFilaPayload {
  /** Nombre del ítem (+ ' · nº de parte' cuando lo tiene). */
  nombre: string;
  existencia: number | null;
  valor_costo_mxn: number | null;
  /** Cantidad y costo de las ENTRADAs del periodo (compras reales; una
   *  DEVOLUCION/AJUSTE suma stock pero no es compra). */
  compradas_cant: number | null;
  compradas_costo_mxn: number | null;
  salidas_cant: number | null;
  /** Σ venta de las salidas CON precio (lo cargado a los aviones). */
  vendido_mxn: number | null;
  /** vendido − costo FIFO consumido por esas salidas. */
  utilidad_mxn: number | null;
  /** Matrículas a las que se aplicó en el periodo (únicas, ' + '). */
  matriculas: string | null;
}

/** Hoja "inventario" del Balance GENERAL (tiendita): bloque por ítem +
 *  totales; el bloque 2 (detalle de salidas) sale de `refacciones`. */
export interface BalanceHojaInventarioPayload {
  filas: BalanceInventarioItemFilaPayload[];
  total_piezas: number | null;
  total_valor_mxn: number | null;
  total_compras_mxn: number | null;
  total_vendido_mxn: number | null;
  total_utilidad_mxn: number | null;
}

/**
 * Balance GENERAL (regla del cliente, 18-ago): UN solo juego de hojas con
 * los datos de todos los aviones JUNTOS (filas teñidas con el color de cada
 * avión). `consolidado` = el libro FLOTA; `aviones` alimenta los bloques de
 * la hoja "balance" (los socios son por avión).
 */
export interface BalanceGeneralPayload {
  generado: string;
  periodo_desde: string;
  periodo_hasta: string;
  resumen: BalanceGeneralResumenFilaPayload[];
  resumen_totales: BalanceGeneralResumenFilaPayload;
  consolidado: BalanceAvionPayload;
  aviones: BalanceAvionPayload[];
  /**
   * Hoja "otros gastos" del GENERAL (29-ago-2026; renombrada el
   * 1-sep-2026 — antes "gastos VuelaTour"; solo cambió el nombre de la
   * hoja en el renderer, este campo NO): gastos de EMPRESA — sin vuelo ni
   * avión (≠PERSONAL_DUENO, ≠GAS) sin reparto + remanentes de reparto
   * manual. Egresos de VuelaTour: FUERA de toda cascada por avión; antes
   * salían como filas sueltas de "Otros movimientos". Opcional por skew.
   */
  gastos_empresa?: BalanceAvionHojaGastosPayload;
  /**
   * Hoja "inventario" (tiendita, 30-ago-2026): resumen POR ÍTEM del periodo
   * (InventoryService.resumenTiendita — mismo FIFO del cardex, cero cálculo
   * paralelo). Sustituye a la hoja "refacciones" SOLO en el render del
   * general (su detalle de salidas pasa a ser el bloque 2 de esta hoja); el
   * libro INDIVIDUAL conserva la suya. Opcional por skew: un py viejo lo
   * ignora y un API viejo no lo manda (pyservices pinta "refacciones").
   */
  inventario?: BalanceHojaInventarioPayload;
}

/** Fila de la pestaña "Otros movimientos" (28-ago, hoja manual del cliente):
 *  egreso (lo pagado) apareado por concepto ESTRUCTURAL con el ingreso (lo
 *  cobrado al cliente) y su remanente. Lados opcionales: una fila puede ser
 *  solo-ingreso o solo-egreso. */
export interface BalanceOtroMovimientoFilaPayload {
  clave: string;
  avion_color: string | null;
  /**
   * Estado del vuelo de la fila (CANCELADO se pinta en rojo). undefined en
   * las filas sueltas (sin vuelo). La pestaña lista vuelos de TODOS los
   * estados — el MISMO universo que la hoja maestra del balance.
   */
  estado?: string | null;
  fecha_vuelo: string | null;
  concepto_egreso: string | null;
  egreso_mxn: number | null;
  fecha_egreso: string | null;
  concepto_ingreso: string | null;
  ingreso_mxn: number | null;
  fecha_ingreso: string | null;
  remanente_mxn: number | null;
  factura: string | null;
  /**
   * Desglose línea por línea de la celda (una fila por vuelo, 28-ago):
   * pyservices lo pinta como COMENTARIO de la celda de ingreso / egreso.
   */
  nota_ingreso?: string | null;
  nota_egreso?: string | null;
}

export interface BalanceHojaOtrosMovimientosPayload {
  /** Filas ligadas a vuelos (agrupadas por clave). */
  filas: BalanceOtroMovimientoFilaPayload[];
  /** Movimientos SIN avión y SIN vuelo (gastos de empresa hoy invisibles). */
  filas_sueltas: BalanceOtroMovimientoFilaPayload[];
}

export interface BalanceAvionPayload {
  generado: string;
  matricula: string;
  modelo: string | null;
  /** Color del avión (aeronave.color_calendario) — bloques del general. */
  avion_color?: string | null;
  periodo_desde: string;
  periodo_hasta: string;
  permiso_afac_usd_hr: number | null;
  tc_promedio: number | null;
  horas_voladas_hr: number;
  vuelos: BalanceAvionVueloPayload[];
  totales: BalanceAvionTotalesPayload;
  gastos_indirectos: BalanceAvionHojaGastosPayload;
  /** Hoja "refacciones" (29-ago-2026): salidas de inventario (gasto
   *  REFACCION medio BODEGA ligado al cardex), separadas de "gastos
   *  indirectos". Opcional por skew de deploy. */
  refacciones?: BalanceAvionHojaGastosPayload;
  otros_gastos: BalanceAvionHojaGastosPayload;
  permisos: BalanceAvionHojaGastosPayload;
  /** Hoja mensual de combustible (26-ago-2026). Opcional por skew de deploy. */
  combustible?: BalanceAvionHojaCombustiblePayload;
  balance: BalanceAvionBalancePayload;
  /** Pestaña "Otros movimientos" (28-ago): solo la manda el GENERAL. */
  otros_movimientos?: BalanceHojaOtrosMovimientosPayload;
  pendientes: string[];
}

export interface GastoVueloSugerenciaPayload {
  gasto: {
    fecha: string | null;
    monto: number | null;
    moneda: string | null;
    categoria: string | null;
    notas: string | null;
    lugar: string | null;
    piloto_nombre: string | null;
  };
  candidatos: Array<{
    vuelo_id: string;
    folio: number | null;
    fecha_vuelo: string | null;
    matricula: string | null;
    ruta: string | null;
    /** CANCELADO = ya no vuela (la IA lo elige solo con evidencia clara). */
    estado: string | null;
  }>;
}

export interface GastoVueloSugerenciaResult {
  vuelo_id_sugerido: string | null;
  confianza: number;
  razon: string;
  modelo: string;
  /** Consumo de tokens (aditivo; None en el early-return sin candidatos). */
  uso_ia?: UsoIaPayload | null;
}

export interface ArchivoZipPayload {
  nombre: string;
  contenido_b64: string;
}
export interface ZipPayload {
  archivos: ArchivoZipPayload[];
}

// ===== Carga masiva de combustibles (plantilla Excel + parseo del archivo) =====

export interface PlantillaCombustiblePayload {
  matriculas: string[];
  proveedores: string[];
  medios_pago: string[];
  monedas: string[];
  tipos_combustible: string[];
}

/**
 * Fila CRUDA leída del Excel por pyservices (sin validación de negocio:
 * cualquier campo puede venir null o con basura — el API valida todo).
 */
export interface FilaCombustibleCruda {
  fila: number;
  matricula: string | null;
  /** 'YYYY-MM-DD' */
  fecha: string | null;
  /** 'HH:MM' o null */
  hora: string | null;
  litros: number | null;
  monto: number | null;
  moneda: string | null;
  tipo_cambio: number | null;
  tipo_combustible: string | null;
  lugar: string | null;
  proveedor: string | null;
  medio_pago: string | null;
  folio_vuelo: string | number | null;
  comprobante: string | null;
  notas: string | null;
}

export interface ParseCombustibleResult {
  filas: FilaCombustibleCruda[];
}

// ===== Alta masiva de inventario (plantilla Excel + parseo del archivo) =====

export interface PlantillaInventarioPayload {
  /** Categorías ya usadas en bodega (lista desplegable). */
  categorias: string[];
  /** Unidades de medida sugeridas (pieza, botella, litro…). */
  unidades: string[];
  monedas: string[];
}

/**
 * Fila CRUDA del Excel de inventario leída por pyservices (sin validación de
 * negocio: el API valida todo en inventory/inventario-masivo). Claves
 * snake_case de las columnas de la plantilla: nombre, marca, categoria,
 * numero_parte, codigo, unidad, descripcion, ubicacion, stock_minimo,
 * existencia_inicial, costo_unitario, moneda, tipo_cambio, empaque_nombre,
 * empaque_factor, empaque_codigo, notas — el API tolera alias.
 */
export interface FilaInventarioCruda {
  fila: number;
  [columna: string]: string | number | boolean | null | undefined;
}

export interface ParseInventarioResult {
  filas: FilaInventarioCruda[];
}

export interface FacturaRecibidaParsed {
  uuid_fiscal: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  tipo_comprobante: string | null;
  subtotal: number | null;
  total: number | null;
  moneda: string | null;
  fecha_emision: string | null;
  conceptos_resumen: string | null;
}

/**
 * Cliente HTTP del microservicio Python (vuelatour-pyservices).
 * Autentica con el header X-Internal-Token contra INTERNAL_SHARED_TOKEN
 * (misma configuración que el resto de clientes a pyservices).
 */
@Injectable()
export class PyservicesService {
  private readonly logger = new Logger(PyservicesService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async generateRepartoPdf(payload: RepartoPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reparto', payload);
  }

  /** Reporte mensual por avión en Excel (mismos datos del reparto). */
  async generateRepartoXlsx(payload: RepartoPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reparto-xlsx', payload);
  }

  /** Export genérico de cualquier tabla a Excel. */
  async generateTablaXlsx(payload: TablaXlsxPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/tabla-xlsx', payload);
  }

  /** Ensambla archivos (base64) en un .zip. */
  async generateZip(payload: ZipPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/zip', payload);
  }

  /** Reporte consolidado de un vuelo en PDF. */
  async generateReporteVueloPdf(payload: ReporteVueloPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reporte-vuelo', payload);
  }

  /** Bitácoras de vuelo del avión (planeador / motor / hélice), una página por tira. */
  async generateBitacoraTacoPdf(payload: BitacoraTacoPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/bitacora-taco', payload);
  }

  /** Recibo de pago de UN cobro en PDF (documento NO fiscal). */
  async generateReciboPdf(payload: ReciboPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/recibo', payload);
  }

  /** Libro «Dinero» del periodo (réplica del control manual del equipo). */
  async generateDineroXlsx(payload: DineroXlsxPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/dinero-xlsx', payload, 30_000);
  }

  /** Reporte consolidado de un vuelo en Excel. */
  async generateReporteVueloXlsx(
    payload: ReporteVueloPayload,
  ): Promise<Buffer> {
    return this.postForBuffer('/pdf/reporte-vuelo-xlsx', payload);
  }

  /** Balance mensual por avión en Excel (libro de 9 hojas). */
  async generateBalanceAvionXlsx(
    payload: BalanceAvionPayload,
  ): Promise<Buffer> {
    // Libro grande (1 fila por vuelo + 3 ledgers): tope de 30s como el resto
    // de renders pesados (quotes-pdf) para no colgar el request del panel.
    return this.postForBuffer('/pdf/balance-avion-xlsx', payload, 30_000);
  }

  async generateBalanceGeneralXlsx(
    payload: BalanceGeneralPayload,
  ): Promise<Buffer> {
    // Varios libros completos en un workbook: tope más holgado.
    return this.postForBuffer('/pdf/balance-general-xlsx', payload, 60_000);
  }

  /** Plantilla Excel de carga masiva de combustibles (catálogos → listas). */
  async generarPlantillaCombustible(
    payload: PlantillaCombustiblePayload,
  ): Promise<Buffer> {
    return this.postForBuffer('/gastos/plantilla-combustible', payload);
  }

  /**
   * Parsea el Excel de carga masiva de combustibles. Devuelve filas CRUDAS:
   * la validación de negocio vive en el API (expenses/combustible-masivo).
   */
  async parseCombustible(
    archivoBase64: string,
    filename: string,
  ): Promise<ParseCombustibleResult> {
    return this.postForJson<ParseCombustibleResult>(
      '/gastos/parse-combustible',
      { archivo_base64: archivoBase64, filename },
    );
  }

  /** Plantilla Excel del alta masiva de inventario (categorías → listas). */
  async generarPlantillaInventario(
    payload: PlantillaInventarioPayload,
  ): Promise<Buffer> {
    return this.postForBuffer('/inventario/plantilla', payload);
  }

  /**
   * Parsea el Excel/CSV del alta masiva de inventario. Devuelve filas CRUDAS:
   * la validación de negocio vive en el API (inventory/inventario-masivo).
   */
  async parseInventario(
    archivoBase64: string,
    filename: string,
  ): Promise<ParseInventarioResult> {
    return this.postForJson<ParseInventarioResult>('/inventario/parse', {
      archivo_base64: archivoBase64,
      filename,
    });
  }

  /** Parsea un CFDI recibido (XML de proveedor) y devuelve sus datos. */
  async parseFacturaRecibida(xmlB64: string): Promise<FacturaRecibidaParsed> {
    return this.postForJson<FacturaRecibidaParsed>(
      '/facturacion/parse-recibida',
      {
        xml_b64: xmlB64,
      },
    );
  }

  /** Sugerencia IA gasto→vuelo (elige entre candidatos deterministas). */
  async sugerirGastoVuelo(
    payload: GastoVueloSugerenciaPayload,
  ): Promise<GastoVueloSugerenciaResult | null> {
    try {
      return await this.postForJson<GastoVueloSugerenciaResult>(
        '/gastos/sugerir-vuelo',
        payload,
      );
    } catch (err) {
      this.logger.warn(
        `sugerirGastoVuelo falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * POST JSON con timeout (default 60s): sin él, un pyservices colgado dejaba
   * el request del panel esperando para siempre (sin AbortController no hay
   * tope del lado Node).
   */
  private async postForJson<T>(
    path: string,
    body: unknown,
    timeoutMs = 60_000,
  ): Promise<T> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch((e: unknown) => {
        if (controller.signal.aborted) {
          throw new BadGatewayException(
            `pyservices no respondio en ${Math.round(timeoutMs / 1000)}s (${path})`,
          );
        }
        const msg = e instanceof Error ? e.message : 'error de red';
        throw new BadGatewayException(
          `No se pudo contactar a pyservices: ${msg}`,
        );
      });
      if (!res.ok) {
        const detalle = await res.text().catch(() => '');
        throw new BadGatewayException(
          `pyservices respondio ${res.status}: ${detalle.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST que devuelve binario (PDF/Excel/zip). Timeout default 60s. */
  private async postForBuffer(
    path: string,
    body: unknown,
    timeoutMs = 60_000,
  ): Promise<Buffer> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch((e: unknown) => {
        if (controller.signal.aborted) {
          throw new BadGatewayException(
            `pyservices no respondio en ${Math.round(timeoutMs / 1000)}s (${path})`,
          );
        }
        const msg = e instanceof Error ? e.message : 'error de red';
        throw new BadGatewayException(
          `No se pudo contactar a pyservices: ${msg}`,
        );
      });

      if (!res.ok) {
        const detalle = await res.text().catch(() => '');
        throw new BadGatewayException(
          `pyservices respondio ${res.status}: ${detalle.slice(0, 300)}`,
        );
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cardex de un ítem de inventario en formato LIBRO (réplica del cuaderno
   * del cliente): bloque ENTRADAS | bloque SALIDAS con venta y ganancia.
   * El payload llega YA calculado del API (pyservices solo renderiza).
   */
  async generateCardexLibroXlsx(payload: CardexLibroPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/cardex-libro-xlsx', payload);
  }
}

// ===== Cardex formato libro (venta de refacciones, 29-ago-2026) =====

/** Fila del bloque ENTRADAS del cardex libro (montos en MXN). */
export interface CardexLibroEntradaPayload {
  fecha: string;
  cantidad: number;
  /** Ítem + referencia/proveedor (DEVOLUCION/AJUSTE llegan con su prefijo). */
  descripcion: string;
  valor_compra_unitario: number | null;
  valor_compra_total: number | null;
  /** Stock corriente DESPUÉS de este movimiento. */
  stock_despues: number;
}

/** Fila del bloque SALIDAS del cardex libro (montos en MXN). */
export interface CardexLibroSalidaPayload {
  fecha: string;
  cantidad: number;
  descripcion: string;
  /** Precio al que se vendió (o el costo FIFO si la salida fue "a costo"). */
  venta_unitaria: number | null;
  venta_total: number | null;
  /** Stock corriente DESPUÉS de la salida. */
  remanente: number;
  /** Venta total MXN − costo FIFO MXN de las capas consumidas. */
  ganancia: number | null;
  /** Matrícula del avión, 'FLOTA' en salidas para toda la flota. */
  vendido_a: string;
}

export interface CardexLibroPayload {
  titulo: string;
  item_nombre: string;
  numero_parte?: string | null;
  unidad?: string | null;
  /** Fecha de generación (día Cancún, YYYY-MM-DD). */
  generado?: string | null;
  /** Moneda de TODOS los montos del libro (hoy siempre 'MXN'). */
  moneda: string;
  entradas: CardexLibroEntradaPayload[];
  salidas: CardexLibroSalidaPayload[];
  total_compra: number;
  total_venta: number;
  total_ganancia: number;
}
