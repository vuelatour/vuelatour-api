/**
 * FACTURAS EMITIDAS (registro manual) + «Necesito factura» — TIPOS DEL
 * CONTRATO (24-sep-2026). JSON idéntico en API y panel
 * (`vuelatour-next/src/types/facturas-emitidas.ts`): nombres EXACTOS.
 *
 * Reglas: dinero SIEMPRE `number` (PostgREST devuelve `numeric` como string:
 * se convierte con `Number()` antes de responder), fechas-día `YYYY-MM-DD`,
 * instantes ISO 8601. NUNCA se exponen `pdf_path`/`xml_path`: el archivo se
 * ve con `GET :id/archivo-url` (URL firmada 600 s).
 */

import type { ExigenciaFacturaVuelo } from '../../common/cuentas-cobro';

export type EstatusFacturaEmitida = 'VIGENTE' | 'CANCELADA';
export type MonedaFactura = 'MXN' | 'USD';
export type MetodoPagoFactura = 'PUE' | 'PPD';
export type AlertaFactura =
  | 'DUPLICADO_VUELO'
  | 'SIN_PDF'
  | 'SIN_VUELO'
  | 'VUELO_CANCELADO';
export type OrdenFacturas = 'folio_desc' | 'folio_asc' | 'fecha_desc';

export const ESTATUS_FACTURA_EMITIDA: readonly EstatusFacturaEmitida[] = [
  'VIGENTE',
  'CANCELADA',
];
export const MONEDAS_FACTURA: readonly MonedaFactura[] = ['MXN', 'USD'];
export const METODOS_PAGO_FACTURA: readonly MetodoPagoFactura[] = [
  'PUE',
  'PPD',
];
export const ORDENES_FACTURAS: readonly OrdenFacturas[] = [
  'folio_desc',
  'folio_asc',
  'fecha_desc',
];
/** Valores del filtro `alerta` (minúsculas en la URL). */
export const FILTROS_ALERTA = [
  'duplicado_vuelo',
  'sin_pdf',
  'sin_vuelo',
  'vuelo_cancelado',
] as const;
export type FiltroAlerta = (typeof FILTROS_ALERTA)[number];

export type CodigoAvisoFactura =
  | 'VUELO_CON_OTRA_FACTURA'
  | 'EMISOR_NO_VUELATOUR'
  | 'EMISOR_SIN_VERIFICAR'
  | 'RECEPTOR_DISTINTO_CLIENTE'
  | 'PDF_SIN_TEXTO'
  | 'PDF_NO_LEIDO'
  | 'PDF_XML_NO_CUADRAN'
  | 'CAMPOS_NO_ENCONTRADOS'
  | 'LECTURA_PDF'
  | 'CFDI_NO_ES_INGRESO'
  | 'MONEDA_NO_SOPORTADA'
  | 'TOTAL_DISTINTO_VUELO'
  | 'VUELO_SIGUE_FACTURADO'
  // FACTURAS POR COBRO (16-oct-2026, API 0.0.82, invariante 84):
  /** la factura no suma lo que los cobros que marcó */
  | 'TOTAL_DISTINTO_COBROS'
  /** al cancelar/baja/quitar vuelo: n cobros quedaron sin factura */
  | 'COBROS_DESLIGADOS'
  /** tras guardar, el vuelo sigue con cobros sin factura asignada */
  | 'COBROS_SIN_FACTURA';

/** Aviso NO bloqueante (la operación ya se hizo o se puede hacer). */
export interface AvisoFactura {
  code: CodigoAvisoFactura;
  /** es-MX, listo para pintar. */
  mensaje: string;
  details?: Record<string, unknown>;
}

// ---- FACTURAS POR COBRO (16-oct-2026, API 0.0.82, invariante 84) ----

/**
 * Por qué un vuelo con ≥ 2 VIGENTES lleva `DUPLICADO_VUELO`: la suma de sus
 * facturas (de un solo vuelo, misma moneda) rebasa lo cotizado/cobrado, o
 * una vigente no ampara ningún cobro del vuelo mientras otra sí.
 */
export type MotivoDuplicadoVuelo = 'SUMA_SUPERA' | 'SIN_COBRO_ASIGNADO';

export interface AlertaFacturaDetalle {
  /** hoy solo 'DUPLICADO_VUELO' trae detalle */
  code: AlertaFactura;
  motivo: MotivoDuplicadoVuelo;
  vuelo_folio: number;
  /** es-MX listo para el title del chip */
  mensaje: string;
}

/** Cobro que AMPARA una factura (lista/detalle del registro y Excel). */
export interface CobroDeFactura {
  id: string;
  vuelo_id: string;
  vuelo_folio: number;
  monto: number;
  moneda: 'USD' | 'MXN';
  /** ISO */
  fecha_cobro: string;
  metodo_cobro: string;
  cuenta_destino: string | null;
}

/** Cobro de un vuelo candidato (diálogo «Registrar factura»). */
export interface CobroCandidatoFactura extends CobroDeFactura {
  /** null = sin factura; {id, etiqueta} = ya amparado (por ESTA u otra) */
  factura: { id: string; etiqueta: string } | null;
}

export type SemaforoCobroKey =
  | 'COBRADO'
  | 'PARCIAL'
  | 'SIN_COBROS'
  | 'NO_APLICA';

/** Insumos del semáforo de cobro de UN vuelo (el panel pinta con SU estadoCobroSemaforo). */
export interface CobroResumen {
  /** vuelo.monto_total_usd */
  monto_total_usd: number;
  /** FlightsService.cobroStatus (cobrosEnUsd); null = el lote falló. */
  total_cobrado_usd: number | null;
  sin_tc_count: number;
  /** vuelo.cobrado */
  cobrado: boolean;
  cotizacion_abierta: boolean;
  /** EstadoVuelo */
  estado_vuelo: string;
  /** cliente.es_interno */
  es_interno: boolean;
  /** Espejo server (common/semaforo-cobro.util.ts) — lo usa el Excel. */
  semaforo: {
    key: SemaforoCobroKey;
    label: string;
    color: 'verde' | 'amarillo' | 'rojo' | 'gris';
    title?: string;
  };
}

export interface TotalVuelo {
  /** vuelo.monto_total_usd */
  usd: number;
  /** totalMxnDeVuelo(v) — fuente única. */
  mxn: number | null;
}

export interface VueloDeFactura {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  estado: string;
  cliente_nombre: string | null;
  total: TotalVuelo;
  cobro: CobroResumen;
  /** Etiquetas de OTRAS facturas VIGENTES ligadas al mismo vuelo («A-120»). */
  otras_vigentes: string[];
  /** ADITIVOS (16-oct-2026, invariante 84; 0 sin la migración 20261016000001). */
  /** cobros de este vuelo amparados por ESTA factura */
  cobros_n: number;
  /** cobros positivos (sin sobre) de este vuelo sin ninguna factura */
  cobros_sin_factura: number;
}

export interface FacturaEmitida {
  id: string;
  serie: string | null;
  folio: string;
  folio_num: number | null;
  /** etiquetaSerieFolio(serie, folio) ⇒ «A-123» / «123» */
  etiqueta: string;
  uuid: string | null;
  /** YYYY-MM-DD */
  fecha_emision: string;
  estatus: EstatusFacturaEmitida;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  emisora: { id: string; razon_social: string } | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  cliente: { id: string; nombre: string } | null;
  moneda: MonedaFactura;
  subtotal: number | null;
  iva: number | null;
  total: number;
  metodo_pago: MetodoPagoFactura | null;
  forma_pago: string | null;
  notas: string | null;
  /** anticipo/finiquito */
  es_parcial: boolean;
  pdf: {
    nombre: string | null;
    subido_at: string | null;
    subido_por_nombre: string | null;
  } | null;
  xml: { nombre: string | null; subido_at: string | null } | null;
  /** entradas de archivos_historial (nunca se exponen paths) */
  archivos_anteriores: number;
  /** orden fecha_vuelo asc */
  vuelos: VueloDeFactura[];
  alertas: AlertaFactura[];
  cancelada: { at: string; por_nombre: string | null; motivo: string } | null;
  created_at: string;
  created_por_nombre: string | null;
  updated_at: string;
  /**
   * ADITIVOS (16-oct-2026, API 0.0.82, invariante 84), ÚLTIMAS llaves:
   * los cobros que ampara (orden vuelo_folio, fecha_cobro; `[]` sin la
   * migración) y el detalle de `DUPLICADO_VUELO` (`[]` si no hay).
   */
  cobros: CobroDeFactura[];
  alertas_detalle: AlertaFacturaDetalle[];
}

/** «Ya está registrada» (409 y leer-archivo). */
export interface FacturaExistente {
  id: string;
  etiqueta: string;
  uuid: string | null;
  estatus: EstatusFacturaEmitida;
  fecha_emision: string;
  vuelos: { id: string; folio: number }[];
  /** «Ya está registrada: A-123 del vuelo #297.» */
  mensaje: string;
}

export interface HuecoSerie {
  /** la numeración es por emisora; null = sin emisora identificada */
  emisora: { id: string; razon_social: string } | null;
  /** null = sin serie */
  serie: string | null;
  /** «A» · «(sin serie)»; si hay filas de ≥2 emisoras: «A · Aero Charter Cancun» */
  etiqueta_serie: string;
  /** folio_num menor */
  desde: number;
  /** folio_num mayor */
  hasta: number;
  /** conteo COMPLETO */
  total_faltantes: number;
  /** ≤ 20 etiquetas «A-104» */
  faltantes: string[];
  /** total_faltantes > faltantes.length */
  truncado: boolean;
}

export interface TotalMoneda {
  moneda: MonedaFactura;
  total: number;
}

export interface ResumenFacturas {
  /** no borradas (VIGENTE + CANCELADA) */
  registradas: number;
  vigentes: number;
  canceladas: number;
  /** VIGENTES sin PDF */
  sin_pdf: number;
  /** VIGENTES sin vuelo */
  sin_vuelo: number;
  /**
   * vuelos con alerta DUPLICADO_VUELO (≥2 VIGENTES y, desde el 16-oct-2026,
   * la suma rebasa lo cotizado/cobrado o una vigente no ampara ningún cobro
   * mientras otra sí; `es_parcial` ya no decide)
   */
  vuelos_con_varias: number;
  /** VIGENTES con alerta VUELO_CANCELADO */
  en_vuelo_cancelado: number;
  /** §3.8 */
  por_facturar: number;
  totales_vigentes: TotalMoneda[];
  /** solo series con total_faltantes > 0 (sobre TODA la serie) */
  huecos: HuecoSerie[];
  /**
   * ADITIVO (0.0.85, invariante 86): conteos y totales cuentan desde esta
   * fecha (`fecha_emision ≥ desde`); null = todo el registro. Opcional: un
   * API previo no la manda.
   */
  desde?: string | null;
}

export interface ListaFacturasEmitidas {
  data: FacturaEmitida[];
  /** total del FILTRO */
  count: number;
  limit: number;
  offset: number;
  /** GLOBAL (todas las no borradas, sin filtros) */
  resumen: ResumenFacturas;
  /** VIGENTES del filtro */
  filtrado: { count: number; totales: TotalMoneda[] };
}

/** Campos que se leen de un PDF/XML (todos opcionales). */
export interface CamposLeidosFactura {
  serie: string | null;
  folio: string | null;
  uuid: string | null;
  fecha_emision: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  moneda: MonedaFactura | null;
  subtotal: number | null;
  iva: number | null;
  total: number | null;
  metodo_pago: MetodoPagoFactura | null;
  forma_pago: string | null;
}

export interface LecturaArchivoFactura {
  campos: CamposLeidosFactura;
  fuente: { xml: boolean; pdf: boolean };
  /** null = no vino PDF */
  texto_extraido: boolean | null;
  ya_registrada: FacturaExistente | null;
  cliente_sugerido: {
    id: string;
    nombre: string;
    por: 'RFC' | 'NOMBRE';
  } | null;
  emisora: { id: string; razon_social: string } | null;
  avisos: AvisoFactura[];
}

/** Datos del alta/edición (van como JSON en el campo multipart `datos`). */
export interface FacturaEmitidaDatos {
  serie?: string | null;
  folio?: string;
  uuid?: string | null;
  fecha_emision?: string;
  emisor_rfc?: string | null;
  emisor_nombre?: string | null;
  emisora_id?: string | null;
  receptor_rfc?: string | null;
  receptor_nombre?: string | null;
  cliente_id?: string | null;
  moneda?: MonedaFactura;
  subtotal?: number | null;
  iva?: number | null;
  total?: number;
  metodo_pago?: MetodoPagoFactura | null;
  forma_pago?: string | null;
  notas?: string | null;
  es_parcial?: boolean;
  vuelo_ids?: string[];
  /**
   * ADITIVO (16-oct-2026, invariante 84): cobros que AMPARA esta factura.
   * Ausente = no se tocan ligas (ni avisos nuevos); `[]` presente = el
   * operador vio las casillas y no marcó ninguna (en PATCH, suelta todas).
   */
  cobro_ids?: string[];
}

export interface ResultadoGuardarFactura {
  factura: FacturaEmitida;
  avisos: AvisoFactura[];
}

// ---- Solicitud / bloque del vuelo ----
export interface SolicitudFactura {
  solicitada_at: string;
  solicitada_por: { id: string; nombre: string | null } | null;
  nota: string | null;
  paga_contra_factura: boolean;
}

export interface FacturaEmitidaMini {
  id: string;
  serie: string | null;
  folio: string;
  etiqueta: string;
  uuid: string | null;
  fecha_emision: string;
  total: number;
  moneda: MonedaFactura;
  metodo_pago: MetodoPagoFactura | null;
  tiene_pdf: boolean;
  tiene_xml: boolean;
  /**
   * ADITIVOS (16-oct-2026, API 0.0.82, invariante 84), ÚLTIMAS llaves y en
   * este orden: `es_parcial` de la fila; `cobros_n` = cobros de ESTE vuelo
   * que ampara; `cobros_monto` = Σ BRUTA por moneda de esos cobros. Sin la
   * migración: 0 y [].
   */
  es_parcial: boolean;
  cobros_n: number;
  cobros_monto: { moneda: MonedaFactura; monto: number }[];
}

/** Bloque ADITIVO `factura_servicio` del snapshot del vuelo. */
export interface FacturaServicioBloque {
  solicitud: SolicitudFactura | null;
  /** derivado §3.8 */
  por_facturar: boolean;
  /** VIGENTES ligadas, orden serie, folio_num, folio */
  facturas: FacturaEmitidaMini[];
  /** CANCELADAS ligadas (no borradas) */
  canceladas: number;
  /**
   * ADITIVO (13-oct-2026, invariante 65): pedida, sin factura VIGENTE ligada
   * y marcada «Facturado» a mano en el vuelo. Ya NO cuenta como
   * `por_facturar` (sale de la bandeja y del badge); el panel la pinta como
   * chip gris «… marcada «Facturado» en el vuelo, sin factura registrada».
   */
  marcado_sin_registro: boolean;
  /**
   * ADITIVOS (14-oct-2026, API 0.0.77, invariante 60), ÚLTIMAS llaves y en
   * este orden. `exigencia` = `vueloExigeFactura` del vuelo (neto por cuenta
   * y moneda; un anticipo devuelto completo, por cualquier vía, NO exige —
   * decisión del cliente del 14-oct-2026—); null = no se pudo leer. Desde el
   * 0.0.77 la exigencia la decide el API: el panel pinta «Factura
   * obligatoria» con `origenes_exigen` (`origenCobroTexto` de los grupos que
   * la exigen: «en HSBC Pesos» / «por Transferencia») y su espejo queda
   * como respaldo de un API ≤ 0.0.76 (cuando la llave falta).
   */
  exigencia: ExigenciaFacturaVuelo | null;
  origenes_exigen: string[];
  /**
   * La solicitud viva es AUTOMÁTICA y el vuelo ya no exige factura (dinero
   * devuelto, cobro corregido o eliminado): ya no cuenta en «Por facturar»
   * y el panel pinta el chip gris «ya no aplica» con «Retirar». NO mira el
   * estado del vuelo. Una manual, nunca.
   */
  solicitud_ya_no_aplica: boolean;
  /**
   * ADITIVOS (16-oct-2026, API 0.0.82, invariante 84), ÚLTIMAS llaves y en
   * este orden. `cobros_sin_factura` = cobros positivos del vuelo, sin
   * sobre, con `factura_emitida_id` null; `cobros_sin_factura_exigen` = de
   * esos, los que `cobroExigeFactura` (decide el TONO del chip);
   * `asignacion_disponible` = la sonda de 20261016000001 (el panel ofrece
   * selector/casillas/pistas SOLO con `true`). Sin la migración: 0, 0, false.
   */
  cobros_sin_factura: number;
  cobros_sin_factura_exigen: number;
  asignacion_disponible: boolean;
}

/** Campo ADITIVO por fila de GET /flights y GET /quotes. */
export interface FacturaServicioResumen {
  solicitada: boolean;
  por_facturar: boolean;
  paga_contra_factura: boolean;
  /** VIGENTES ligadas */
  facturas: number;
}

/** Grupo multi-avión al que pertenece un vuelo (null = vuelo suelto). */
export interface GrupoDeVueloFactura {
  id: string;
  /** vuelo_grupo.folio (se pinta «G-12») */
  folio: number | null;
  nombre: string | null;
  /** hijos NO cancelados del grupo */
  total_aviones: number;
}

export type EstatusManualFactura =
  | 'SIN_FACTURA'
  | 'ELABORADA_ENVIADA'
  | 'FACTURADO';

export interface PorFacturarItem {
  vuelo: {
    id: string;
    folio: number;
    estado: string;
    fecha_vuelo: string | null;
    ruta_iatas: string[];
    es_externo: boolean;
    grupo: GrupoDeVueloFactura | null;
    /** vuelo.factura_estatus (seguimiento manual). */
    estatus_manual: EstatusManualFactura;
  };
  cliente: {
    id: string;
    nombre: string;
    rfc: string | null;
    razon_social: string | null;
    regimen_fiscal: string | null;
    uso_cfdi: string | null;
    codigo_postal: string | null;
    domicilio_fiscal: string | null;
    pais_residencia: string | null;
  } | null;
  /** etiquetas es-MX: «RFC», «Razón social», «Régimen fiscal», «Uso de CFDI», «Código postal» */
  faltan_datos_fiscales: string[];
  total: TotalVuelo;
  cobro: CobroResumen;
  solicitud: SolicitudFactura;
  facturas_canceladas: number;
  /**
   * ADITIVO (13-oct-2026, invariante 65, prevención del caso #376): facturas
   * VIGENTES (no borradas) del MISMO cliente que NO están ligadas a este
   * vuelo, emitidas desde el día Cancún de (solicitud − 30 días); máximo 3,
   * las más recientes primero (fecha_emision desc, folio_num desc). El panel
   * ofrece «Ligar a A-0440» (con confirmación). `[]` si no hay o si la
   * lectura falla (nunca tumba la bandeja).
   */
  facturas_del_cliente: FacturaDelClienteSugerida[];
}

/** Factura del cliente que PODRÍA cubrir también este vuelo (sugerencia). */
export interface FacturaDelClienteSugerida {
  id: string;
  /** «A-0440» (serie-folio). */
  etiqueta: string;
  /** YYYY-MM-DD */
  fecha_emision: string;
  total: number;
  moneda: MonedaFactura;
  /** Vuelos a los que YA está ligada (el PATCH de la liga manda la unión). */
  vuelo_ids: string[];
  vuelo_folios: number[];
}

/** `GET /v1/facturas-emitidas/por-facturar` */
export interface ListaPorFacturar {
  /** Solo 'POR_FACTURAR': paga contra factura primero, luego la solicitud más vieja. */
  data: PorFacturarItem[];
  /** = data.length */
  count: number;
  /**
   * ADITIVO (13-oct-2026, invariante 65): pedidos, sin factura registrada y
   * marcados «Facturado» a mano (`estadoSolicitud` 'MARCADO_SIN_REGISTRO'),
   * con la MISMA forma y orden que `data`.
   */
  marcados_sin_registro: PorFacturarItem[];
  /**
   * ADITIVO (14-oct-2026, API 0.0.77, invariante 60): solicitudes
   * AUTOMÁTICAS cuyo vuelo ya no exige factura (`estadoSolicitud`
   * 'YA_NO_APLICA'), con la MISMA forma y orden que `data`. No cuentan en
   * «Por facturar»; la oficina las retira desde aquí (con confirmación).
   */
  ya_no_aplican: PorFacturarItem[];
}

/** `GET /v1/facturas-emitidas/por-facturar/conteo` (badge del menú). */
export interface ConteoPorFacturar {
  /** El badge del menú usa SOLO este número. */
  por_facturar: number;
  paga_contra_factura: number;
  /** ADITIVO (13-oct-2026, invariante 65). */
  marcados_sin_registro: number;
  /** ADITIVO (14-oct-2026, API 0.0.77, invariante 60). */
  ya_no_aplican: number;
}

export interface VueloCandidatoFactura {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  /** estado CANCELADO se pinta con chip */
  estado: string;
  cliente_id: string;
  cliente_nombre: string | null;
  cliente_rfc: string | null;
  total: TotalVuelo;
  /** etiquetas */
  facturas_vigentes: string[];
  /** tiene solicitud pendiente (por_facturar) */
  solicitud: boolean;
  grupo: GrupoDeVueloFactura | null;
  /**
   * ADITIVO (16-oct-2026, invariante 84), SOLO con la migración
   * 20261016000001: cobros positivos sin sobre del vuelo (orden fecha_cobro
   * asc) con la factura que ya los ampara. Ausente = API viejo o sin
   * migración (el panel no pinta casillas).
   */
  cobros?: CobroCandidatoFactura[];
}

export interface ResponsablesFacturacion {
  /** lo guardado en config */
  usuario_ids: string[];
  /** resolución de usuario_ids */
  usuarios: { id: string; nombre: string; rol: string; activo: boolean }[];
  /** oficina activa (ADMIN/COORDINADOR/FACTURACION) */
  candidatos: { id: string; nombre: string; rol: string }[];
  /** a quién le llegaría HOY el aviso (sin excluir a nadie) */
  efectivos: { id: string; nombre: string }[];
  fuente: 'CONFIG' | 'ROL_FACTURACION' | 'ADMINS';
}
