/**
 * Tipos JSON de INGRESOS y de la CONCILIACIÓN DE INGRESOS (24-sep-2026).
 * COPIA EXACTA de `vuelatour-next/src/types/ingresos.ts` (contrato §4):
 * números como `number`, fechas `YYYY-MM-DD` (día Cancún), instantes ISO.
 */
export type CategoriaIngreso =
  | 'OTRO_INGRESO'
  | 'ANTICIPO_CLIENTE'
  | 'INGRESO_BANCARIO'
  | 'REEMBOLSO_DEVOLUCION'
  | 'VENTA_ACTIVO'
  | 'APORTACION_PRESTAMO';
export type MonedaIngreso = 'MXN' | 'USD';
export type MetodoIngreso =
  | 'TRANSFERENCIA'
  | 'EFECTIVO'
  | 'DOLARES'
  | 'CHEQUE'
  | 'HSBC_LINK'
  | 'PAYWISE'
  | 'BILLPOCKET'
  | 'OTRO'; // = valores del enum metodo_cobro
export type EstadoConciliacionIngreso =
  | 'CONCILIADO'
  | 'SIN_CONCILIAR'
  | 'NO_BANCARIO';
/** Cobro de vuelo (regla ÚNICA = la de «cobros sin banco», crítica):
 *  CONCILIADO   = liga directa o por sobre (fuente única cobro-conciliado.util);
 *  VIA_ANTICIPO = cobro de un anticipo cuyo anticipo YA está conciliado;
 *  SIN_CONCILIAR= método ∈ METODOS_COBRO_ABONO_AUTO sin liga — o cobro de anticipo cuyo
 *                 anticipo tiene cuenta y NO está conciliado;
 *  NO_BANCARIO  = el resto (efectivo, dólares directo, BillPocket, otro) sin liga, o cobro de
 *                 un anticipo en efectivo. (BillPocket ligado a mano ⇒ CONCILIADO.) */
export type EstadoConciliacionEntrada =
  | EstadoConciliacionIngreso
  | 'VIA_ANTICIPO';

export interface CuentaResumen {
  id: string;
  alias: string;
  banco: string;
  moneda: MonedaIngreso;
  tipo: 'BANCO' | 'PASARELA';
}

export interface Ingreso {
  id: string;
  folio: number;
  etiqueta: string; // 'ING-12'
  categoria: CategoriaIngreso;
  categoria_etiqueta: string;
  suma_a_resultados: boolean;
  fecha: string; // día Cancún
  descripcion: string;
  monto: number; // bruto
  comision_monto: number | null;
  neto: number; // monto − comisión
  moneda: MonedaIngreso;
  tc_usd_mxn: number | null;
  metodo: MetodoIngreso;
  metodo_etiqueta: string; // METODO_COBRO_LABELS
  cuenta_bancaria_id: string | null; // null = efectivo / caja
  cuenta: CuentaResumen | null;
  referencia: string | null;
  pagador: string | null;
  cliente_id: string | null;
  cliente_nombre: string | null;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  aeronave_id: string | null;
  matricula: string | null;
  gasto_id: string | null;
  notas: string | null;
  archivo: {
    nombre: string;
    subido_at: string | null;
    subido_por_nombre: string | null;
  } | null;
  conciliacion: {
    estado: EstadoConciliacionIngreso;
    movimiento_id: string | null;
    movimiento_fecha: string | null;
    movimiento_monto: number | null;
  };
  /** Solo ANTICIPO_CLIENTE; null en el resto. */
  anticipo: { aplicado: number; saldo: number; aplicaciones_n: number } | null;
  registrado_por_nombre: string | null;
  created_at: string;
  updated_at: string;
  baja: { at: string; por_nombre: string | null; motivo: string } | null;
}

export interface IngresoAplicacion {
  cobro_id: string;
  vuelo_id: string;
  vuelo_folio: number | null;
  monto: number;
  moneda: MonedaIngreso;
  comision_banco_monto: number | null;
  fecha_cobro: string; // ISO
  registrado_por_nombre: string | null;
  created_at: string;
}

export interface IngresoBitacoraFila {
  id: string;
  accion:
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'APLICAR'
    | 'DESAPLICAR'
    | 'CONCILIAR'
    | 'DESCONCILIAR';
  actor_nombre: string | null;
  created_at: string;
  cambios: Array<{ campo: string; antes: unknown; despues: unknown }>;
  nota: string | null;
}

export interface IngresoDetalle {
  ingreso: Ingreso;
  aplicaciones: IngresoAplicacion[];
  movimiento: {
    id: string;
    fecha: string;
    monto: number;
    descripcion: string | null;
    cuenta_alias: string | null;
  } | null;
  bitacora: IngresoBitacoraFila[]; // ≤ 100, más nueva primero
}

export interface ListaIngresos {
  data: Ingreso[];
  total: number;
  limit: number;
  offset: number;
  desde: string;
  hasta: string;
  por_moneda: Array<{
    moneda: MonedaIngreso;
    monto: number;
    neto: number;
    n: number;
  }>;
}

/** Fila unificada de «Todos» y «Cobros de vuelos» (solo lectura). */
export interface EntradaDinero {
  origen: 'COBRO_VUELO' | 'INGRESO';
  id: string; // cobro_id | ingreso_id
  dia: string; // YYYY-MM-DD Cancún (fecha_cobro o ingreso.fecha)
  etiqueta: string; // 'Vuelo #312' | 'ING-12'
  categoria: CategoriaIngreso | 'COBRO_VUELO';
  categoria_etiqueta: string; // 'Cobro de vuelo' | etiqueta de la categoría
  cliente_nombre: string | null; // cliente del vuelo / cliente o pagador del ingreso
  concepto: string | null; // descripción del ingreso | referencia/notas 1a línea del cobro
  monto: number; // bruto; reembolso NEGATIVO
  comision: number | null;
  neto: number;
  moneda: MonedaIngreso;
  metodo: string;
  metodo_etiqueta: string;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  grupo_folio: number | null; // parte de sobre de grupo
  vuelo_estado: string | null; // estado_vuelo (solo cobros)
  /** Cobro de un vuelo que aún no vuela (RESERVA/SOLICITUD/COTIZADO/CONFIRMADO con fecha_vuelo
   *  ≥ hoy Cancún o sin fecha): es un DEPÓSITO por adelantado. null en ingresos. */
  por_volar: boolean | null;
  anticipo_etiqueta: string | null; // cobro aplicado de un anticipo ('ING-12')
  /** false = NO suma al «total recibido» (cobro aplicado de anticipo: el dinero ya entró como anticipo). */
  cuenta_en_total: boolean;
  es_reembolso: boolean;
  conciliacion: {
    estado: EstadoConciliacionEntrada;
    movimiento_id: string | null;
  };
  registrado_por_nombre: string | null;
}
export interface ListaEntradas {
  data: EntradaDinero[];
  total: number;
  limit: number;
  offset: number;
  desde: string;
  hasta: string;
}

export interface ResumenIngresosMoneda {
  moneda: MonedaIngreso;
  cobros_vuelo: {
    recibido: number;
    reembolsos: number;
    n: number;
    conciliado: number;
    sin_conciliar: number;
    no_bancario: number;
  };
  /** Informativo (YA está dentro de cobros_vuelo.recibido — NO se suma otra vez): cobros del
   *  periodo de vuelos que aún no vuelan = depósitos por adelantado de reservas. */
  depositos_por_volar: { monto: number; n: number };
  aplicado_de_anticipos: { monto: number; n: number }; // informativo: NO suma
  otros_ingresos: {
    monto: number;
    n: number;
    conciliado: number;
    sin_conciliar: number;
    no_bancario: number;
  };
  anticipos: {
    recibido: number;
    aplicado: number;
    saldo: number;
    n: number;
    conciliado: number;
    sin_conciliar: number;
    no_bancario: number;
  };
  fuera_de_resultados: { monto: number; n: number }; // APORTACION_PRESTAMO
  total_recibido: number; // cobros.recibido + otros + anticipos.recibido + fuera
  neto_de_reembolsos: number; // total_recibido − cobros.reembolsos
  abonos_por_identificar: { n: number; monto: number }; // ABONO sin conciliar del periodo en cuentas de esa moneda
}
export interface ResumenIngresos {
  desde: string;
  hasta: string;
  por_moneda: ResumenIngresosMoneda[]; // MXN primero, luego USD; solo monedas con algo
  anticipos_con_saldo: Array<{
    moneda: MonedaIngreso;
    saldo: number;
    n: number;
  }>; // TODAS las fechas
}

// ---- Conciliación de ingresos ----
export interface CandidatoIngresoAbono {
  tipo: 'INGRESO';
  id: string; // ingreso_id
  etiqueta: string; // 'ING-12'
  categoria: CategoriaIngreso;
  categoria_etiqueta: string;
  es_anticipo: boolean;
  fecha: string;
  monto: number;
  comision_monto: number | null;
  neto: number;
  moneda: MonedaIngreso;
  cliente: string | null; // cliente o pagador
  descripcion: string;
  cuenta_bancaria_id: string;
  cuenta_alias: string | null;
  otra_cuenta: boolean; // registrado en una cuenta distinta a la del abono
  dif_monto: number; // |neto − abono| (o bruto vs monto_bruto en pasarela)
}

export interface AbonoPendiente {
  id: string;
  cuenta_bancaria_id: string;
  cuenta_alias: string | null;
  cuenta_moneda: MonedaIngreso | null;
  cuenta_tipo: 'BANCO' | 'PASARELA' | null;
  fecha: string;
  monto: number; // lo depositado (neto en pasarela)
  monto_bruto: number | null;
  comision_monto: number | null;
  descripcion: string | null;
  referencia: string | null;
  notas: string | null;
  patron: 'TRASPASO' | 'REVERSO' | null;
  /** Qué haría el AUTO-cruce («Cruzar pendientes»), mismas reglas que 6.1. null = no se pudo calcular. */
  motivo_pendiente: 'SE_PUEDE_CRUZAR' | 'AMBIGUO' | 'SIN_CANDIDATOS' | null;
  candidatos_n: number | null;
  /** Candidatos MANUALES (cobros de METODOS_COBRO_ABONO_MANUAL + sobres + ingresos, ±30 días,
   *  misma moneda, libres) cuyo NETO o BRUTO es EXACTO (r2) al abono. El caso real #235 da 1
   *  aunque el auto diga SIN_CANDIDATOS. null = no se pudo calcular. */
  exactos_manual: number | null;
  /** Otra línea del banco de la MISMA cuenta, tipo, fecha y monto (cualquier estado). */
  posible_duplicado_de: {
    id: string;
    conciliado: boolean;
    descripcion: string | null;
    referencia: string | null;
  } | null;
  /** Cliente ACTIVO cuyo nombre empata con la descripción (empataNombre, exactamente uno). */
  cliente_sugerido: { id: string; nombre: string } | null;
  categoria_sugerida: CategoriaIngreso | null; // heurística determinista
}
export interface AbonosPendientesRespuesta {
  data: AbonoPendiente[];
  total: number;
  desde: string;
  hasta: string;
  truncado: boolean;
  motivos_calculados: boolean; // false = la lectura de candidatos falló o se truncó: no se anotó nada
  por_moneda: Array<{ moneda: MonedaIngreso; n: number; monto: number }>;
}

export type AccionPropuestaAbono =
  | 'LIGAR'
  | 'REGISTRAR_INGRESO'
  | 'CLASIFICAR_TRASPASO'
  | 'CLASIFICAR_REVERSO'
  | 'REVISAR';
export interface CandidatoAbonoFicha {
  tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO' | 'INGRESO';
  id: string; // cobro_id | cobro_grupo_id | ingreso_id (uuid SIN prefijo)
  etiqueta: string; // 'Cobro · vuelo #312' | 'Sobre G-4' | 'ING-12 · Anticipo'
  fecha: string; // día Cancún
  monto: number;
  neto: number;
  moneda: MonedaIngreso;
  metodo_etiqueta: string | null;
  cliente: string | null;
  vuelo_id: string | null;
  grupo_id: string | null;
  es_anticipo: boolean;
}
export interface PropuestaAbono {
  movimiento_id: string;
  fecha: string;
  monto: number;
  descripcion: string | null;
  referencia: string | null;
  cuenta_alias: string | null;
  cuenta_moneda: MonedaIngreso | null;
  origen: 'IA' | 'REGLA';
  accion: AccionPropuestaAbono;
  candidato: CandidatoAbonoFicha | null;
  confianza: number; // 0..1 (ya topada por evidencia determinista)
  /** Calculado por el API (no por la IA): neto o bruto del candidato == abono (r2). Solo las
   *  propuestas LIGAR con monto_exacto && confianza ≥ 0.85 van PRESELECCIONADAS en el panel. */
  monto_exacto: boolean;
  razon: string;
  evidencias: string[];
  alternativas: Array<{
    candidato: CandidatoAbonoFicha;
    confianza: number;
    razon: string;
  }>;
  categoria_sugerida: CategoriaIngreso | null;
  cliente_sugerido: { id: string; nombre: string } | null;
  posible_duplicado: boolean;
  motivo_sin_match: string | null;
}
export interface SugerirAbonosRespuesta {
  revisados: number;
  con_propuesta: number; // accion LIGAR con candidato
  sin_propuesta: number;
  errores: number;
  disponible: boolean; // false SOLO si se preguntó y nadie contestó
  nota: string | null;
  desde: string;
  hasta: string;
  limite: number;
  propuestas: PropuestaAbono[];
}
