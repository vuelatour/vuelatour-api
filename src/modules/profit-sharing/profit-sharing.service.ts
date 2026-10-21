import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import {
  fuenteTcLegible,
  TipoCambioService,
  type TipoCambioDetalle,
} from '../tipo-cambio/tipo-cambio.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import { MEDIOS_BANCARIOS } from '../conciliacion/gastos-candidatos.util';
// COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65): vigencia por
// configuración y la aritmética en la fuente única pura (la MISMA del
// balance por avión).
import {
  CONFIG_COMISIONES_AL_AVION_DESDE,
  ConfiguracionService,
} from '../configuracion/configuracion.service';
import {
  COMISIONES_AL_AVION_DESDE_DEFAULT,
  comisionesDelVuelo,
  pagoVendedorAvionEnUniverso,
  type ComisionesDelVuelo,
} from '../../common/comisiones-avion.util';
import type { ProfitSharingQuery } from './dto/profit-sharing.dto';
// Grupos del clasificador del reparto (DIRECTO, INDIRECTO, PERMISO, FIJO y
// TUAS_CAT): se MUDARON tal cual a `grupos-reparto.util` (14-oct-2026,
// invariante 74) para que la confirmación de «Corregir la fecha del gasto»
// lea la MISMA fuente. El ternario de `computeAvion` no cambia.
import {
  DIRECTO,
  FIJO,
  INDIRECTO,
  PERMISO,
  TUAS_CAT,
} from './grupos-reparto.util';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  CATEGORIA_NOMINA,
  CATEGORIAS_GASTO_SIN_AVION,
  categoriaEsDeEmpresa,
  categoriaEsPagoVendedor,
  etiquetaCategoriaGasto,
  ladoPagoVendedor,
} from '../../common/categoria-gasto.util';
import { cobrosEnUsd, retieneCobros } from '../../common/cobros-usd.util';
import {
  reservaOverhaulIncompleta,
  reservaOverhaulPeriodoUsd,
  tarifaReservaOverhaul,
} from '../../common/reserva-overhaul.util';
import {
  gastoRestaEnColumnasDelVuelo,
  pagoOperadorExternoEnGastos,
  usdDelPagoOperador,
} from '../../common/costo-externo.util';
import { dineroDevueltoCompleto } from '../../common/cuentas-cobro';
import {
  expandirConReparto,
  fetchRepartos,
  gastosConReparto,
} from '../../common/gasto-reparto.util';
// NÓMINA SIN REPARTIR (16-oct-2026, invariante 91): renglón BLOQUEANTE del
// pre-cierre (sumas y textos en la fuente única pura).
import {
  CLAVE_PRECIERRE_NOMINA_SIN_REPARTIR,
  TITULO_PRECIERRE_NOMINA_SIN_REPARTIR,
  detallePrecierreNominaSinRepartir,
  resumenNominaSinRepartir,
} from '../../common/nomina-sin-repartir.util';
// GASTOS «POR PAGAR» (19-oct-2026, invariante 93): renglón BLOQUEANTE del
// pre-cierre (estado de pago, sumas y textos en la fuente única pura).
import { porPagarDisponible } from '../../common/por-pagar-disponible.util';
import {
  CLAVE_PRECIERRE_GASTOS_POR_PAGAR,
  TITULO_PRECIERRE_GASTOS_POR_PAGAR,
  detallePrecierreGastosPorPagar,
  porPagarVigente,
  resumenGastosPorPagar,
} from '../expenses/por-pagar.util';
// Revisión del 19-oct-2026 (P1/P2): el renglón cuenta por MES CONTABLE (la
// regla del candado de mes cerrado) y separa los ids de NÓMINA.
import {
  idsNominaDe,
  porPagarEnPeriodoContable,
  selectPorPagarPrecierre,
} from './gastos-por-pagar-precierre.util';
import {
  cobradoParteAvion,
  pagoVendedorUsd,
  particionIngresoVuelo,
  type VueloIngresoInput,
} from '../../common/ingreso-vuelo.util';
import { trasladosEmbebidosDeGasto } from '../../common/desglose-gasto.util';
// INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75, invariante 67): los
// ingresos de resultado CON avión suman al saldo de ESE avión (partición
// única `partirIngresosPorAvion`, la misma del balance y el Libro Dinero).
// Desde el 0.0.77 (decisión del cliente del 14-oct-2026) su USD sale de la
// fuente única `usdDeIngresoAvion`: la MISMA conversión del balance.
import {
  avisosReembolsoGasto,
  diaTcOficialIngreso,
  filaLibroDeIngreso,
  gastosLigadosDelLibro,
  ingresoEsDelAvion,
  leerIngresosDeResultado,
  partirIngresosPorAvion,
  usdDeIngresoAvion,
  type IngresoParaLibro,
  type OrigenTcIngreso,
  type ParteGastoCargada,
} from '../../common/ingreso-resultado.util';
import {
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
} from '../../common/categoria-ingreso.util';
// «TUA incluida» de la oficina (13-oct-2026, invariante 66): sonda ÚNICA de
// `gasto.tua_incluida` (reparto y pre-cierre la leen detrás de ella).
import {
  colTuaIncluida,
  tuaIncluidaDisponible,
} from '../../common/tua-incluida-disponible.util';
// AFAC POR VUELO (16-oct-2026, invariante 90): la marca «Pago de AFAC» del
// gasto (fuente única `esPagoAfac`) detrás de la sonda de la migración
// 20261016000005. Un PERMISO marcado lo paga VuelaTour: grupo EXCLUIDO.
import {
  afacRealDisponible,
  colPagoAfac,
} from '../../common/afac-real-disponible.util';
import {
  DETALLE_PERMISOS_SIN_AVION_AFAC,
  PAGO_AFAC_CLAVE_DETALLE,
  esPagoAfac,
} from '../../common/afac-real.util';
import { cuadreSobre } from '../groups/particion-cobro.util';
import {
  avionDelGasto,
  avionQueReporta,
  factorDe,
  participacionPorAeronave,
  repartirUsd,
  type ParticipacionAeronave,
} from '../../common/participacion-aeronave.util';
import { cuentaComoSinFacturar } from '../../common/facturacion-gasto.util';
import {
  CLAVE_PRECIERRE_SEGUIMIENTO,
  SEGUIMIENTO_PRECIERRE_MAX_PAGINAS,
  SEGUIMIENTO_PRECIERRE_PAGINA,
  resumenPrecierreSeguimiento,
  type SeguimientoPrecierreRow,
} from '../flights/vuelo-seguimiento.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import { SIN_MIGRACION, lectorCuentaSocios } from './reparto-cuenta.lector';
import {
  CLAVE_PRECIERRE_SOCIOS_ADELANTADOS,
  CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR,
  DETALLE_PRECIERRE_CUENTAS_LECTURA_FALLIDA,
  DETALLE_PRECIERRE_CUENTAS_NO_DISPONIBLE,
  TITULO_PRECIERRE_SOCIOS_ADELANTADOS,
  TITULO_PRECIERRE_SOCIOS_POR_ENTREGAR,
  armarSociosBase,
  mesActualCancun,
  mesHastaAdelantosPrecierre,
  mesesEntre,
  movimientosDeCuenta,
  resumenPrecierreCuentas,
  utilidadMesDesdeAviones,
  type ResumenPrecierreCuentas,
  type UtilidadMesSocios,
} from './reparto-cuenta.util';
import {
  ROLES_PAGOS_SOCIOS_LECTURA,
  aPagoSocio,
  mesAcreditadoDeEntrega,
  mesDePeriodo,
  rangoDeMes,
  type PagoSocio,
} from './reparto-pago.util';
import { UtilidadesMensualesSocios } from './reparto-utilidades.memo';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { cierreMesDisponible } from '../../common/cierre-mes-disponible.util';
import {
  colPeriodoContable,
  colsVueloContable,
} from '../../common/filtro-periodo-contable.util';
import {
  decisionDiferir,
  diaContableDeGasto,
  ejeContableDeGasto,
  leyendaPasaA,
  leyendaPasara,
  leyendaPasaraAlCerrar as leyendaPasaraPrecierre,
  leyendaVieneDe,
  mesCalendarioDeRango,
  motivoNoCerrable,
  mesContableDeVuelo,
  mesRealDeVuelo,
  mesSiguienteDe,
  origenDeVuelo,
  papelContableEnPeriodo,
  rangoDelMes,
  salidaDeVuelo,
  type DecisionDiferir,
  type GastoParaMesContable,
  type MotivoDiferir,
} from '../../common/mes-contable.util';
import {
  leerCierresMes,
  leerDiferimientos,
  type CierreMesLeido,
} from '../../common/cierre-mes.lector';
import {
  exigirPeriodoDesdeInicio,
  inicioOficialDe,
} from '../../common/inicio-oficial.util';
import {
  detalleTacosEnRevision,
  pilotosDeTacosEnRevision,
  resumenTacosEnRevision,
  type EscalaEnRevisionRow,
} from './tacos-revision.util';
import { idsPrecierre } from './pre-cierre-ids.util';
import {
  DETALLE_TACOS_OMITIDOS_FALLIDA,
  detalleTacosOmitidos,
  resumenTacosOmitidos,
  usuariosDeTacosOmitidos,
  type EscalaOmitidaRow,
} from './tacos-omitidos.util';
import { tacoOmitidoDisponible } from '../../common/taco-omitido-disponible.util';
import {
  CATEGORIAS_GASTO_OPERACIONES,
  CLAVE_PRECIERRE_VUELOS_SIN_GASTO,
  DETALLE_PRECIERRE_VUELOS_SIN_GASTO,
  DETALLE_PRECIERRE_VUELOS_SIN_GASTO_FALLIDA,
  TITULO_PRECIERRE_VUELOS_SIN_GASTO,
  candidatosSinGastoOperaciones,
  vuelosSinGastoOperaciones,
  type VueloCompletadoSinGastoRow,
  type VueloSinGastoOperaciones,
} from './vuelos-sin-gasto.util';
import {
  CLAVE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA,
  DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA,
  TITULO_PRECIERRE_VUELOS_SIN_FACTURA,
  vuelosCobradosSinFactura,
  type VueloCobradoRow,
  type VueloCobradoSinFactura,
} from './vuelos-sin-factura.util';
import {
  renglonVuelosCobradosDeMas,
  type VueloConCobradoDeMas,
} from './vuelos-cobrados-de-mas.util';
import {
  cobradoDeMas,
  entradaCobradoDeMas,
} from '../../common/cobrado-de-mas.util';
import { facturasDeVuelos } from '../flights/factura-cliente-etiquetas';
import { itemPrecierreLigasUsdTc } from './ligas-usd-tc-precierre.util';
import type { ResultadoLigasUsdTc } from '../conciliacion/ligas-usd-tc.util';
import {
  textoOmitidosPreCierre,
  type OmitidosPeriodo,
} from '../conciliacion/omision.util';
// Renglones INVERSOS del pre-cierre (15-oct-2026, PEDIDO 4): sustituyen a
// `tua_cobrada_sin_pagada` (retirado).
import {
  CLAVE_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR_FALLIDA,
  TITULO_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
  candidatosPrecierreInversos,
  vuelosConTuaPagadaSinCobrar,
  type VueloCandidatoInverso,
  type VueloInversoRow,
  type VueloTuaPagadaSinCobrar,
} from './tua-pagada-sin-cobrar.util';
import {
  CLAVE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR_FALLIDA,
  TITULO_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
  vuelosConTransportePagadoSinCotizar,
  type VueloTransporteSinCotizar,
} from './transporte-pagado-sin-cotizar.util';

/** Lecturas `in (…)` en lote: ids por consulta (URL acotada). */
const LOTE_IDS = 200;

/**
 * Pre-cierre `cobros_pendientes.detalle` con la migración del cierre de mes
 * (invariante 89): la regla de siempre + qué pasa al cerrar.
 */
const DETALLE_COBROS_PENDIENTES_CIERRE =
  'Solo se reparte lo cobrado: la parte del avión de este saldo queda fuera del reparto (el resto —TUAS/extras/pernocta/comisión del vendedor— es ingreso de VuelaTour, tampoco cobrado). Al cerrar el mes, estos vuelos pasan completos al mes siguiente (venta, gastos y comisiones); se reparten cuando estén cobrados.';

/** Columnas de `vuelo` del reparto (las de siempre; 0.0.87). */
const VUELO_REPARTO_COLS =
  'id, aeronave_id, cliente_id, estado, monto_total_usd, tc_usd_mxn, cobrado, comision_vendedor_usd, folio, fecha_vuelo, fecha_solicitud, origen_iata, destino_iata, es_externo, costo_externo_usd, subtotal_vuelo_usd, ajuste_final_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot, tiempo_cobrable_hr';

/**
 * Embeds del gasto para decidir su EJE contable (invariante 89, solo con la
 * migración): el vuelo con su mes contable y el avión del tramo.
 */
const GASTO_REPARTO_EMBED_CONTABLE =
  ', escala:escala_id(aeronave_id), vuelo:vuelo_id(fecha_vuelo, periodo_contable, fecha_contable, aeronave_id, es_externo)';
/** max-rows de PostgREST: una respuesta NUNCA trae más filas. */
const PAGINA_POSTGREST = 1000;
/** Tope de páginas por lote (200 vuelos × 20,000 filas ⇒ algo anda mal). */
const LOTE_PAGINADO_MAX_PAGINAS = 20;

const TUAS_CLAVE_DETALLE = 'TUAS (egreso VuelaTour — Otros movimientos)';
/**
 * PAGO AL VENDEDOR (28-sep-2026, invariante 31; DOS categorías desde el
 * 13-oct-2026, invariante 61): por el eje de `fetchGastos` (fecha_gasto) es
 * SIEMPRE grupo EXCLUIDO — SOLO transparencia, ninguna clave suma a
 * `gastos.*`. La «Comisión del vendedor (avión)» cuenta en el MES DEL VUELO
 * por OTRA vía: la lectura por vuelo (`fetchGastosVendedorDeVuelos`) que
 * alimenta `comisionesDelVuelo` (`comisiones_venta_usd`). La «Comisión del
 * vendedor (VuelaTour)» nunca resta al avión. Cada clave EMPIEZA con el
 * código EXACTO de su categoría (con « · »), así `detalleGastos` deriva bien
 * la etiqueta con `categoria.startsWith(acc.categoria)` (espejo de
 * `TUAS_CLAVE_DETALLE`): «Comisión del vendedor (VuelaTour) · egreso en …» /
 * «Comisión del vendedor (avión) · …».
 */
/** Toda «(VuelaTour)», de cualquier vuelo: la paga VuelaTour. */
export const PAGO_VENDEDOR_CLAVE_DETALLE =
  'COMISION_VENDEDOR · egreso en «otros movimientos» del Balance general';
/** «(avión)» de un vuelo del reparto que la carga un avión (Comisiones). */
export const PAGO_VENDEDOR_AVION_CLAVE_DETALLE =
  'COMISION_VENDEDOR_AVION · resta en Comisiones del avión (mes del vuelo)';
/**
 * «(avión)» cuyo vuelo NO está en este reparto: de otro periodo o, del
 * mismo, aún no completado (el reparto solo lee COMPLETADO y CANCELADO).
 * Cuenta en el mes de SU vuelo, nunca por su fecha_gasto.
 */
export const PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE =
  'COMISION_VENDEDOR_AVION · vuelo de otro periodo o aún no completado (cuenta en el mes de su vuelo)';
/**
 * «(avión)» de un vuelo del reparto que NINGÚN avión carga (CANCELADO sin
 * cobros retenidos, o sin avión con parte de la venta): la paga VuelaTour en
 * «otros movimientos» del Balance general.
 */
export const PAGO_VENDEDOR_AVION_VUELATOUR_CLAVE_DETALLE =
  'COMISION_VENDEDOR_AVION · ningún avión la carga: la paga VuelaTour en «otros movimientos»';
/**
 * TUA EMBEBIDO en facturas de aeródromo/handling (leído por IA): esa parte se
 * descuenta del costo del avión con la FUENTE ÚNICA `trasladosEmbebidosDeGasto`
 * (`.tua`; toda categoría CON vuelo salvo CATS_SIN_TUA_EMBEBIDO y las de
 * EMPRESA) — la MISMA regla que
 * el Balance por avión y el Libro Dinero. Antes este archivo traía su propia
 * lista blanca de 4 categorías y el reparto divergía del balance.
 */
const TUA_EMBEBIDO_CLAVE_DETALLE = 'TUA embebido (excluido)';
/**
 * EXTENSIÓN DE HORARIO embebida (1-oct-2026, caso #192): la parte «extensión
 * y/o antelación de horario» de una factura de aeródromo (conceptos IA o, sin
 * ellos, el respaldo por TEXTO de las notas — caso #314) es un traslado al
 * cliente como el TUA: se descuenta del costo del avión con la MISMA fuente
 * única (`trasladosEmbebidosDeGasto`) y sale en su propia fila informativa
 * (solo cuando hubo: sin extensiones el detalle es byte-idéntico).
 */
const EXTENSION_EMBEBIDA_CLAVE_DETALLE = 'Extensión de horario (excluido)';
/**
 * Leyenda del bloque informativo `tc_oficial` (regla del cliente, 29-ago-2026):
 * una cotización sin TC (no se sabía cuándo volaría) y un gasto MXN sin TC
 * capturado se convierten con el TC oficial de referencia del día — la MISMA
 * cadena que el Balance por avión/general (tc capturado ?? oficial del día).
 */
const TC_OFICIAL_LEYENDA =
  'Cobros y gastos en MXN sin tipo de cambio capturado se convierten con el TC oficial de referencia (open.er-api / BCE) del día de la cotización o del gasto; capturar el TC en el vuelo o en el gasto lo sustituye.';
/** Leyenda del bloque informativo `otros_ingresos_vuelatour` (regla 6). */
const OTROS_INGRESOS_LEYENDA =
  'Ingreso de VuelaTour (TUAS, extras, pernocta y comisión del vendedor cobrados con su IVA): vive en Otros movimientos del Balance general; no se reparte.';

/** Etiqueta legible de la fuente del peso del reparto multi-avión. */
function fuenteParticipacionLabel(
  fuente: ParticipacionAeronave['fuente'],
): string {
  switch (fuente) {
    case 'tacos':
      return 'por horas reales de tacómetro';
    case 'cotizacion':
      return 'por horas cotizadas por tramo';
    case 'tramos':
      return 'partes iguales por tramo';
    default:
      return '';
  }
}

/** "50 %", "33.33 %". */
function pctLabel(f: number): string {
  return `${Math.round(f * 10000) / 100} %`;
}

// El avión que REPORTA la parte de VuelaTour, los avisos no repartibles
// (cobros MXN sin TC), el bloque informativo `otros_ingresos_vuelatour` y los
// CONTEOS de vuelos de un vuelo multi-avión es `avionQueReporta` (fuente
// única, misma regla que el balance por avión y el Libro Dinero).

/** Un vuelo de las listas del bloque `cierre` del reparto (invariante 89). */
export interface CierreRepartoVuelo {
  id: string;
  folio: number | null;
  cliente: string | null;
  matricula: string | null;
  venta_usd: number;
  cobrado_usd: number;
  por_cobrar_usd: number;
  /** 'YYYY-MM' al que pasa (salen / pasarían). */
  destino?: string;
  /** 'YYYY-MM' del que viene (entran). */
  origen?: string;
  leyenda: string;
  /** Datos del vuelo (los usa la previa del cierre). */
  fecha_vuelo: string | null;
  aeronave_id: string | null;
  cliente_id: string | null;
  /** Solo en los que la DECISIÓN manda (pasarían / excluidos). */
  motivo?: MotivoDiferir;
  cobrado_posterior_usd?: number;
  /** Día Cancún del último cobro después del corte (16-oct-2026, ADITIVO). */
  fecha_cobro_posterior?: string | null;
}

/** Bloque ADITIVO `cierre` de `GET /v1/profit-sharing` (invariante 89). */
export interface CierreRepartoBloque {
  disponible: true;
  /** 'YYYY-MM' solo si el rango es un mes calendario completo. */
  periodo: string | null;
  estado: 'ABIERTO' | 'CERRADO' | 'REABIERTO';
  cerrado_at: string | null;
  cerrado_por_nombre: string | null;
  reabierto_at: string | null;
  reabierto_por_nombre: string | null;
  version: number | null;
  coincide_con_snapshot: boolean | null;
  diferidos_salen: CierreRepartoVuelo[];
  diferidos_entran: CierreRepartoVuelo[];
  pendientes_que_pasarian: CierreRepartoVuelo[];
}

interface AeronaveRow {
  id: string;
  matricula: string;
  modelo: string;
  /**
   * Aportación AFAC USD/hr (ficha del avión). PROVISIÓN AFAC del reparto
   * (20-oct-2026, invariante 99): tarifa × horas cobradas de cada vuelo, la
   * MISMA columna T «PERMISO AFAC (PROVISIÓN)» del balance. Opcional solo
   * para los specs que arman aviones a mano (sin ella, 0).
   */
  permiso_afac_usd_hr?: string | number | null;
}
interface VueloRow {
  id: string;
  aeronave_id: string | null;
  /** CIERRE DE MES (invariante 89): solo con la migración. */
  periodo_contable?: string | null;
  fecha_contable?: string | null;
  /** Cliente del vuelo (nombre resuelto aparte: detalle.vuelos / PDF). */
  cliente_id: string | null;
  /**
   * COMPLETADO o CANCELADO (regla del cliente 28-ago-2026): un cancelado
   * puede tener dinero real — cobros NO reembolsados (cargo por cancelación /
   * anticipo retenido) y gastos (se voló a recoger, cancelaron, ferry de
   * regreso) — y ambos cuentan en el reparto.
   */
  estado: string;
  monto_total_usd: string | null;
  tc_usd_mxn: string | null;
  cobrado: boolean;
  /**
   * Horas COBRADAS del viaje (20-oct-2026, invariante 99): base de la
   * provisión AFAC (tarifa × horas), como la columna D del balance.
   */
  tiempo_cobrable_hr?: string | number | null;
  /**
   * Comisión de quien vendió (pre-IVA). Regla A (28-ago-2026 tarde): es
   * INGRESO DE VUELATOUR (como un extra) — ya viene dentro de
   * `vuelatour_usd` de la partición; el avión ni la cobra ni la descuenta.
   * Aquí solo es insumo de `particionIngresoVuelo` (rama columnas).
   */
  comision_vendedor_usd: string | null;
  // Insumos de `particionIngresoVuelo` (venta del avión vs ingreso de
  // VuelaTour — regla 6). Sin snapshot el util cae a estas columnas.
  subtotal_vuelo_usd: string | null;
  ajuste_final_usd: string | null;
  iva_usd: string | null;
  iva_pct: string | null;
  tuas_usd: string | null;
  extras_total_usd: string | null;
  viaticos_pernocta_usd: string | null;
  calculo_snapshot: unknown;
  // Campos informativos para el desglose por avión (detalle.vuelos); no
  // alteran ningún cálculo del reparto.
  folio: number | null;
  fecha_vuelo: string | null;
  /**
   * Día de la COTIZACIÓN: sin tc_usd_mxn, los cobros MXN sin TC se convierten
   * con el TC oficial de ese día (fecha_solicitud ?? fecha_vuelo, hora
   * Cancún) — misma cadena que el balance (`tcOficialPorVuelos`).
   */
  fecha_solicitud: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  es_externo: boolean;
  /** Solo externos: lo que cobra el operador dueño del avión. */
  costo_externo_usd: string | null;
}

/** Grupo del reparto al que aporta una categoría de gasto (doc 4.8). */
type GrupoGasto = 'DIRECTO' | 'INDIRECTO' | 'PERMISO' | 'FIJO' | 'EXCLUIDO';

interface GastoCategoriaAcc {
  grupo: GrupoGasto;
  /** Código CRUDO de la categoría base (la clave del mapa puede llevar
   *  sufijo " (repartido)" o ser la nota de TUAS); null en la fila
   *  informativa del TUA embebido. Solo alimenta `etiqueta` del detalle. */
  categoria: string | null;
  /** Gastos que SÍ convirtieron a USD (los sin TC van en sin_tc_count). */
  count: number;
  usd: number;
  sin_tc_count: number;
  sin_tc_mxn: number;
  /** De `count`: los MXN convertidos con el TC oficial del día del gasto. */
  tc_oficial_count: number;
  tc_oficial_mxn: number;
  /**
   * REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): la
   * categoría EN PESOS (MXN tal cual —menos TUA/extensión embebidas—, con o
   * sin T.C.; USD × su `tc_gasto` o el oficial de su día) y los DÓLARES que
   * no llegaron a pesos (USD sin ningún T.C.; solo cuentan si restan).
   */
  mxn: number;
  sin_pesos_usd: number;
}
interface CobroRow {
  /** ADITIVOS (14-oct-2026, invariante 77): «Vuelos cobrados de más». */
  id?: string;
  fecha_cobro?: string | null;
  cobro_grupo_id?: string | null;
  vuelo_id: string;
  monto: string;
  moneda: string;
  tc_usd_mxn: string | null;
  /**
   * Comisión bancaria del cobro (en su moneda), su % y el método: insumos de
   * las comisiones a cargo del avión (6-oct-2026, API 0.0.65).
   */
  comision_banco_monto?: string | number | null;
  comision_banco_pct?: string | number | null;
  metodo_cobro?: string | null;
}
interface EscalaHorasRow {
  id: string;
  vuelo_id: string;
  orden: number | null;
  aeronave_id: string | null;
  /** Tramo cancelado: no suma horas ni participa en el reparto por avión. */
  cancelada_at: string | null;
  taco_salida: string | null;
  taco_llegada: string | null;
  /**
   * Tramo OPERATIVO (ferry / posicionamiento / parada técnica): no vendió,
   * no reparte la venta (`participacionPorAeronave`); sí suma horas reales.
   */
  solo_operativa: boolean | null;
  es_ferry: boolean | null;
  /** Ruta del tramo ("CUN→MID"): etiqueta de los tramos del avión en el PDF. */
  origen_iata: string | null;
  destino_iata: string | null;
}
interface GastoRow {
  id: string;
  aeronave_id: string | null;
  vuelo_id: string | null;
  /** Tramo al que está ligado el gasto (Regla B: su avión manda). */
  escala_id?: string | null;
  categoria: string;
  monto: string | number;
  moneda: string;
  tc_gasto: string | null;
  /** Día del gasto (date): TC oficial de respaldo cuando es MXN sin tc_gasto. */
  fecha_gasto?: string | null;
  /** Propina (ya incluida en `monto`): fuera de la base del desglose IA. */
  propina?: string | number | null;
  /** Renglones leídos por IA de la factura (para separar el TUA embebido). */
  valor_ia_extraido?: {
    conceptos?: Array<{ concepto: string; monto: number }> | null;
    /** TUA CON IVA leída aparte por la IA (13-oct-2026). */
    tua_monto?: number | null;
  } | null;
  /** Notas: respaldo por TEXTO de la extensión de horario sin IA. */
  notas?: string | null;
  /**
   * TUA (IVA incluido) que fijó la OFICINA (13-oct-2026, invariante 66):
   * manda sobre la lectura en `trasladosEmbebidosDeGasto` (fila informativa
   * «TUA embebido (excluido)» y costo del avión). Detrás de la sonda.
   */
  tua_incluida?: string | number | null;
  /**
   * PAGO DE AFAC que paga VuelaTour (16-oct-2026, invariante 90): grupo
   * EXCLUIDO (no resta al avión). Detrás de la sonda `afacRealDisponible`.
   */
  es_pago_afac?: boolean | null;
  /** Clon parcial generado por el reparto manual (gasto_reparto). */
  es_reparto_parcial?: boolean;
}
/**
 * Gasto de la lectura POR VUELO del pago al vendedor (13-oct-2026, API
 * 0.0.74, invariante 61; `fetchGastosVendedorDeVuelos`): las DOS categorías.
 * Compatible con `GastoPagoVendedorRow` (`pago-vendedor.util`):
 * `comisionesDelVuelo` lo convierte con tc_gasto ?? K y elige el lado en JS
 * (solo la «(avión)» resta; la «(VuelaTour)» solo se cuenta).
 */
type GastoVendedorVueloRow = {
  vuelo_id: string | null;
  categoria: string;
  monto: string | number;
  moneda: string;
  tc_gasto: string | null;
  fecha_gasto: string | null;
};
/**
 * Un gasto del avión en el reparto, tal cual se sumó (pantalla por avión,
 * 20-oct-2026, invariante 99). `grupo` EXCLUIDO = no resta (su `clave` dice
 * por qué: TUA, pago al vendedor, pago de AFAC, categoría de empresa…).
 */
export interface FilaGastoDetalle {
  id: string;
  fecha: string | null;
  categoria: string;
  etiqueta: string;
  clave: string;
  grupo: 'DIRECTO' | 'INDIRECTO' | 'PERMISO' | 'FIJO' | 'EXCLUIDO';
  concepto: string | null;
  vuelo: { id: string; folio: number | null } | null;
  monto: number;
  moneda: string;
  tc: number | null;
  /** TUA / extensión embebidas que se le quitaron antes de sumar. */
  descontado_mxn: number;
  usd: number | null;
  mxn: number | null;
  tc_oficial: boolean;
  es_reparto_parcial: boolean;
}

interface SocioRow {
  aeronave_id: string;
  socio_id: string;
  porcentaje: string;
  vigente_desde: string;
  vigente_hasta: string | null;
  /**
   * RESERVA DE OVERHAUL POR SOCIO (20-oct-2026, invariante 99, migración
   * `20261020000005`): true = su parte de la reserva (reserva × %) se le
   * DESCUENTA de la utilidad; false/ausente = solo se le informa.
   */
  descontar_reserva_overhaul?: boolean | null;
}
interface ReservaRow {
  aeronave_id: string;
  monto_por_hora_usd: string;
  horas_acumuladas: string;
}

/**
 * Items del pre-cierre de la CUENTA CORRIENTE DE LOS SOCIOS
 * (`socios_por_entregar` y `socios_adelantados`, invariante 38 v2): lo
 * común tipado; el resto (socios, disponible…) viaja tal cual.
 */
export interface ItemPrecierreCuentasSocios {
  clave: string;
  titulo: string;
  mes: string;
  detalle: string;
  count: number;
  /** EN PESOS (20-oct-2026, invariante 99): la cuenta corriente es en MXN. */
  monto_mxn: number;
  lectura_fallida: boolean;
  [extra: string]: unknown;
}

/**
 * Renglones del pre-cierre que BLOQUEAN el cierre (`listo`): FUENTE ÚNICA
 * (revisión 16-oct-2026) — la previa del cierre de mes
 * (`CierresService`) los lista con esta MISMA constante.
 */
export const CLAVES_BLOQUEANTES_PRECIERRE = [
  'vuelos_sin_completar',
  'tacos_en_revision',
  'gastos_sin_tc',
  'cobros_sin_tc',
  'combustible_sin_avion',
  'permisos_sin_avion',
  // 16-oct-2026 (API 0.0.90, invariante 91): no se cierra un mes con
  // nómina sin repartir (no entra a ningún balance ni al reparto).
  'nomina_sin_repartir',
  // 19-oct-2026 (API 0.0.95, invariante 93): no se cierra un mes con
  // gastos «por pagar» sin confirmar (marcarlos pagados o eliminarlos).
  'gastos_por_pagar',
] as const;

@Injectable()
export class ProfitSharingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly tipoCambio: TipoCambioService,
    private readonly conciliacion: ConciliacionService,
    // Vigencia de las comisiones a cargo del avión (6-oct-2026, API 0.0.65).
    // Opcional SOLO para los specs que arman el servicio a mano (sin ella
    // rige el default en código); en la app la inyecta Nest.
    private readonly configuracion?: ConfiguracionService,
  ) {}

  /**
   * Primer día (Cancún, por `fecha_vuelo`) de las COMISIONES A CARGO DEL
   * AVIÓN (6-oct-2026, API 0.0.65): `comisiones_al_avion_desde` de la
   * configuración (caché de 60 s, best-effort) o el default en código — la
   * MISMA lectura que el balance por avión.
   */
  private async vigenciaComisiones(): Promise<string> {
    if (!this.configuracion) return COMISIONES_AL_AVION_DESDE_DEFAULT;
    return this.configuracion.fecha(
      CONFIG_COMISIONES_AL_AVION_DESDE,
      COMISIONES_AL_AVION_DESDE_DEFAULT,
    );
  }

  private readonly logger = new Logger(ProfitSharingService.name);

  /**
   * INICIO OFICIAL (16-oct-2026, invariante 86, forma R): el periodo del
   * reparto, sus PDF/Excel y el pre-cierre sube al inicio; uno que termina
   * antes ⇒ 400 `PERIODO_ANTES_DEL_INICIO`. Un periodo ≥ inicio sale
   * IDÉNTICO (mismas consultas): el piso solo oculta.
   */
  private async periodoOficial(
    q: ProfitSharingQuery,
  ): Promise<ProfitSharingQuery> {
    if (q.desde > q.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const p = exigirPeriodoDesdeInicio(
      q.desde,
      q.hasta,
      await inicioOficialDe(this.configuracion),
    );
    return p.desde === q.desde ? q : { ...q, desde: p.desde };
  }

  /**
   * Reloj inyectable (specs): decide el MES EN CURSO de las cuentas de los
   * socios en el pre-cierre (hora Cancún).
   */
  ahora: () => Date = () => new Date();

  /**
   * Utilidades por MES de los socios (cuenta corriente, invariante 38 v2):
   * un `compute` por mes calendario, meses cerrados memoizados 10 min, el
   * mes en curso nunca, ≤ 3 a la vez. Vive AQUÍ (dueño de `compute`) para
   * que el pre-cierre y los servicios de la cuenta compartan la memoria sin
   * ciclo de dependencias.
   */
  private readonly utilidadesMes = new UtilidadesMensualesSocios(
    (mes, enCurso) => this.utilidadMesSocios(mes, enCurso),
  );

  /** Construye el payload (compartido por el PDF y el Excel) desde el cómputo. */
  private async buildRepartoPayload(q: ProfitSharingQuery) {
    const result = await this.compute(q);
    const payload = {
      periodo_desde: result.periodo.desde,
      periodo_hasta: result.periodo.hasta,
      // Fecha de generación en hora de Cancún (UTC−5), no UTC.
      generado: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Cancun',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
      // Informativo global (regla 6): ingreso de VuelaTour cobrado en vuelos
      // de la flota — vive en Otros movimientos, no entra a ninguna cascada.
      otros_ingresos_vuelatour_total_usd:
        result.otros_ingresos_vuelatour.cobrado_usd,
      // Composición COTIZADA (pre-IVA + IVA) del bloque anterior; incluye la
      // comisión del vendedor (Regla A). Nombres = RepartoOtrosIngresosDesglose
      // de pyservices (app/schemas/reparto.py).
      otros_ingresos_vuelatour_desglose:
        result.otros_ingresos_vuelatour.desglose,
      // ADITIVO (29-ago-2026): cuántos vuelos/gastos del periodo se
      // convirtieron con el TC oficial de referencia (nota en PDF/XLSX).
      tc_oficial: result.tc_oficial,
      aviones: result.aviones.map((a) => ({
        matricula: a.aeronave.matricula,
        modelo: a.aeronave.modelo,
        // Venta del AVIÓN cobrada (sin TUAS/extras/pernocta/comisión del
        // vendedor ni su IVA; en multi-avión, la parte de este avión).
        ingresos_cobrado_usd: a.ingresos.cobrado_usd,
        otros_ingresos_vuelatour_usd: a.ingresos.otros_ingresos_vuelatour_usd,
        otros_ingresos_vuelatour_desglose:
          a.detalle.otros_ingresos_vuelatour.desglose,
        comisiones_venta_usd: a.ingresos.comisiones_venta_usd,
        pendiente_cobro_usd: a.ingresos.pendiente_cobro_usd,
        // Deuda completa del cliente (informativa: el pendiente de arriba es
        // solo la parte del avión).
        pendiente_bruto_usd: a.ingresos.pendiente_bruto_usd,
        horas_voladas_hr: a.horas_voladas_hr,
        gastos_directos_usd: a.gastos.directos_usd,
        gastos_indirectos_usd: a.gastos.indirectos_usd,
        permisos_usd: a.gastos.permisos_usd,
        otros_usd: a.gastos.otros_prorrateados_usd,
        reserva_overhaul_usd: a.reserva_overhaul_usd,
        saldo_usd: a.saldo_disponible_usd,
        // Advertencias de integridad: montos que NO pudieron entrar al balance.
        gastos_sin_tc_mxn: a.gastos.gastos_sin_tc_mxn,
        cobros_sin_tc_mxn: a.ingresos.cobros_sin_tc_mxn,
        // ADITIVOS (29-ago): convertidos con el TC oficial del día — ya
        // DENTRO de los montos de arriba; solo alimentan una nota.
        gastos_tc_oficial: a.gastos.gastos_tc_oficial,
        cobros_tc_oficial_count: a.ingresos.cobros_tc_oficial_count,
        reserva_incompleta: a.reserva_overhaul_incompleta,
        // El PDF/XLSX a socios es el reporte VITAL: si las vigencias de
        // socios traslapan mal (total ≠ 100%), la advertencia debe viajar
        // impresa — la web ya lo delataba con un badge, el papel no.
        reparto_porcentaje_total: a.reparto_porcentaje_total,
        reparto: a.reparto.map((r) => ({
          socio_nombre: r.socio_nombre,
          porcentaje: r.porcentaje,
          monto_usd: r.monto_usd,
          // ADITIVO (0.0.94, invariante 92): el mismo reparto EN PESOS.
          monto_mxn: r.monto_mxn,
          // ADITIVOS (20-oct-2026, invariante 99): su parte del saldo antes
          // de la reserva, su parte de la reserva y si se le descuenta.
          utilidad_usd: r.utilidad_usd,
          utilidad_mxn: r.utilidad_mxn,
          reserva_usd: r.reserva_usd,
          reserva_mxn: r.reserva_mxn,
          descuenta_reserva: r.descuenta_reserva,
        })),
        // Detalle de vuelos del avión (RepartoVueloLinea de pyservices): la
        // PARTE del avión cobrada / pendiente (misma cifra que la card y que
        // Σ ingresos.*); en multi-avión `participacion` < 1 y el PDF imprime
        // "#105 · 50 % (CUN-MID)". Sale del mismo loop que los agregados.
        vuelos: a.detalle.vuelos.map((v) => ({
          folio: v.folio,
          cliente: v.cliente,
          fecha: v.fecha,
          estado: v.estado,
          cobrado_usd: v.cobrado_avion_usd,
          pendiente_usd: v.pendiente_avion_usd,
          // ADITIVOS (0.0.94, invariante 92): lo mismo EN PESOS (null = sin
          // ningún T.C. para pasarlo a pesos ⇒ «—»).
          cobrado_mxn: v.cobrado_avion_mxn,
          pendiente_mxn: v.pendiente_avion_mxn,
          participacion: v.participacion ?? 1,
          multi_avion: v.multi_avion ?? false,
          tramos_avion: v.tramos_ruta_avion ?? v.tramos_avion ?? null,
          // CIERRE DE MES (16-oct-2026, invariante 89, ADITIVOS): solo con
          // la migración (sin ella la línea es la de siempre).
          ...(v.cierre_marca !== undefined
            ? {
                cierre_marca: v.cierre_marca,
                diferido_de: v.diferido_de ?? null,
                diferido_a: v.diferido_a ?? null,
              }
            : {}),
        })),
        // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92; §2b
        // del contrato, nombres de `RepartoAvion` de pyservices): la MISMA
        // cascada EN PESOS que la pantalla. OJO a los nombres: el saldo viaja
        // como `saldo_mxn` (en la pantalla, `saldo_disponible_mxn`) y los
        // otros prorrateados como `otros_mxn`. Los gastos MXN sin T.C. y los
        // otros ingresos MXN SÍ cuentan en pesos; los cobros MXN sin ningún
        // T.C. (`cobros_sin_tc_mxn`) quedan fuera (igual que de los dólares).
        // Van ANTES de las llaves que los specs fijan como las últimas.
        ingresos_cobrado_mxn: a.ingresos.cobrado_mxn,
        comisiones_venta_mxn: a.ingresos.comisiones_venta_mxn,
        pendiente_cobro_mxn: a.ingresos.pendiente_cobro_mxn,
        gastos_directos_mxn: a.gastos.directos_mxn,
        gastos_indirectos_mxn: a.gastos.indirectos_mxn,
        permisos_mxn: a.gastos.permisos_mxn,
        otros_mxn: a.gastos.otros_prorrateados_mxn,
        reserva_overhaul_mxn: a.reserva_overhaul_mxn,
        otros_ingresos_avion_mxn: a.ingresos.otros_ingresos_avion_mxn,
        saldo_mxn: a.saldo_disponible_mxn,
        pesos_sin_tc_usd: a.pesos_sin_tc_usd,
        reserva_tc: a.detalle.reserva.tc,
        // ADITIVOS (20-oct-2026, invariante 99; `reparto_como_balance`): la
        // provisión AFAC que resta y la reserva retenida a los socios que
        // la descuentan. `reserva_overhaul_*` pasa a ser INFORMATIVA.
        afac_reservado_usd: a.afac_reservado_usd,
        afac_reservado_mxn: a.afac_reservado_mxn,
        afac_horas_cobradas_hr: a.detalle.afac.horas_cobradas_hr,
        afac_tarifa_usd_hr: a.detalle.afac.tarifa_usd_hr,
        reserva_retenida_usd: a.reserva_retenida_usd,
        reserva_retenida_mxn: a.reserva_retenida_mxn,
        // ADITIVOS (13-oct-2026, API 0.0.75, invariante 67): los ingresos
        // asignados a este avión. `saldo_usd` YA incluye
        // `otros_ingresos_avion_usd` (pyservices jamás lo vuelve a sumar);
        // los MXN sin T.C. NO entraron al saldo (se avisan). Siempre (0 / []).
        otros_ingresos_avion_usd: a.ingresos.otros_ingresos_avion_usd,
        otros_ingresos_avion_sin_tc_mxn:
          a.ingresos.otros_ingresos_avion_sin_tc_mxn,
        otros_ingresos_avion: a.detalle.otros_ingresos_avion.map((l) => ({
          clave: l.clave,
          fecha: l.fecha,
          categoria: l.categoria_etiqueta,
          concepto: l.concepto,
          monto: l.monto,
          moneda: l.moneda,
          comision: l.comision,
          usd: l.usd,
          // ADITIVO (0.0.94, invariante 92): el neto EN PESOS.
          mxn: l.mxn,
        })),
      })),
      // ADITIVA (18/19-oct-2026, API 0.0.94, invariante 92): el PDF y el
      // Excel del reparto van EN PESOS (los `*_mxn` de cada avión); los
      // dólares quedan informativos. Viaja SIEMPRE, ANTES de la bandera que
      // los specs fijan como la última.
      reparto_en_pesos: true as const,
      // ADITIVA (20-oct-2026, invariante 99): la cascada del balance —
      // provisión AFAC en la cascada y reserva de overhaul informativa (por
      // socio, descontada solo a quien lo pidió).
      reparto_como_balance: true as const,
      // ADITIVA (13-oct-2026, API 0.0.74, invariante 61): la comisión del
      // vendedor resta SOLO como gasto real, en dos categorías —
      // `comisiones_venta_usd` = parte del avión de la bancaria + los pagos
      // «Comisión del vendedor (avión)» (la «(VuelaTour)» la paga VuelaTour).
      // pyservices cambia con ella solo textos. Viaja SIEMPRE.
      comision_vendedor_solo_gasto_real: true as const,
      // CIERRE DE MES (16-oct-2026, invariante 89, ADITIVO): estado del mes
      // y las listas de diferidos (`RepartoCierre` de pyservices). Solo con
      // la migración.
      ...('cierre' in result && result.cierre ? { cierre: result.cierre } : {}),
    };
    return {
      payload,
      desde: result.periodo.desde,
      hasta: result.periodo.hasta,
    };
  }

  /** Genera el PDF del reparto delegando el render al microservicio Python. */
  async repartoPdf(
    q: ProfitSharingQuery,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    const { payload, desde, hasta } = await this.buildRepartoPayload(q);
    const buffer = await this.pyservices.generateRepartoPdf(payload);
    return { buffer, desde, hasta };
  }

  /** Genera el reporte mensual por avión en Excel (mismos datos). */
  async repartoXlsx(
    q: ProfitSharingQuery,
  ): Promise<{ buffer: Buffer; desde: string; hasta: string }> {
    const { payload, desde, hasta } = await this.buildRepartoPayload(q);
    const buffer = await this.pyservices.generateRepartoXlsx(payload);
    return { buffer, desde, hasta };
  }

  /**
   * `opts.sinPiso` SOLO para las utilidades por mes de la cuenta corriente
   * de los socios (saldo con su propio arranque, invariante 38: NO TOCAR).
   */
  async compute(
    qPedido: ProfitSharingQuery,
    opts: {
      sinPiso?: boolean;
      /**
       * CIERRE DE MES (16-oct-2026, invariante 89), INTERNO: simula el mes
       * ya cerrado — esos vuelos salen del dinero del periodo (con sus
       * gastos de eje vuelo y comisiones) y sus HORAS se quedan. Lo usan la
       * previa y el snapshot del cierre (`CierresService`). Sin él, byte a
       * byte.
       */
      excluirVuelos?: ReadonlyArray<string>;
      /**
       * PANTALLA POR AVIÓN (20-oct-2026, invariante 99): con `true` cada
       * avión trae `detalle.gastos[]` (gasto por gasto, con su grupo y sus
       * pesos). Sin él la respuesta es la de siempre (sin la llave).
       */
      detalleGastos?: boolean;
    } = {},
  ) {
    if (qPedido.desde > qPedido.hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const q = opts.sinPiso ? qPedido : await this.periodoOficial(qPedido);

    const aeronaves = await this.fetchAeronaves(q.aeronave_id);
    if (aeronaves.length === 0) {
      // MISMO shape que la respuesta normal: el panel lee gastos_sin_tc y
      // externos antes de revisar aviones.length (sin esto crasheaba antes
      // de llegar a su propio EmptyState).
      return {
        periodo: { desde: q.desde, hasta: q.hasta },
        // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92):
        // la bandera viaja también en la respuesta vacía.
        reparto_en_pesos: true as const,
        // LA CASCADA DEL BALANCE (20-oct-2026, invariante 99): ídem.
        reparto_como_balance: true as const,
        gastos_sin_tc: { count: 0, monto_mxn: 0 },
        gastos_tc_oficial: { count: 0, monto_mxn: 0 },
        tc_oficial: {
          vuelos: 0,
          gastos: { count: 0, monto_mxn: 0 },
          fuentes: [] as string[],
          leyenda: TC_OFICIAL_LEYENDA,
          // ADITIVO (13-oct-2026, invariante 67): mismo shape que la normal.
          ingresos: { count: 0, monto_mxn: 0 },
        },
        externos: {
          vuelos: 0,
          cobrado_usd: 0,
          costo_usd: 0,
          comisiones_vendedor_usd: 0,
          utilidad_usd: 0,
          sin_costo_count: 0,
          cobros_sin_tc_mxn: 0,
          cobros_tc_oficial_count: 0,
        },
        otros_ingresos_vuelatour: {
          vuelos: 0,
          cobrado_usd: 0,
          pendiente_usd: 0,
          desglose: {
            tuas_usd: 0,
            extras_usd: 0,
            pernocta_usd: 0,
            comision_usd: 0,
            iva_usd: 0,
          },
          leyenda: OTROS_INGRESOS_LEYENDA,
        },
        aviones: [],
      };
    }

    // CIERRE DE MES (16-oct-2026, invariante 89): con la migración el eje
    // del DINERO es `vuelo.fecha_contable` (un vuelo diferido al cerrar un
    // mes cuenta completo en el mes destino) y las HORAS siguen por
    // `fecha_vuelo`. Sin ella, `contable = false` ⇒ byte a byte 0.0.87.
    const contable = await cierreMesDisponible(this.supabase.service);
    const excluir = new Set(opts.excluirVuelos ?? []);
    const [
      leidos,
      gastosPorFecha,
      socios,
      reservas,
      vigenciaComisiones,
      ingresosResultado,
    ] = await Promise.all([
      this.fetchVuelosPeriodo(q.desde, q.hasta, contable),
      this.fetchGastos(q.desde, q.hasta, contable),
      this.fetchSocios(),
      this.fetchReservas(),
      // Comisiones a cargo del avión (6-oct-2026, API 0.0.65): UNA lectura
      // para todos los aviones del cómputo.
      this.vigenciaComisiones(),
      // INGRESOS ASIGNADOS A UN AVIÓN (13-oct-2026, API 0.0.75, invariante
      // 67): los de resultado del periodo (`ingreso.fecha` ∈ [desde, hasta],
      // día Cancún). La sonda va dentro: sin la migración de ingresos
      // devuelve [] sin consultar la tabla.
      leerIngresosDeResultado(this.supabase.service, q.desde, q.hasta),
    ]);
    // Universo del DINERO (sin los excluidos de la simulación del cierre) y
    // universo de las HORAS (vuelos que VOLARON en el periodo: los del
    // dinero cuyo día real cae en él + las «sombras» diferidas fuera + los
    // excluidos). Sin la migración los dos son el mismo (0.0.87).
    const vuelos = leidos.dinero.filter((v) => !excluir.has(v.id));
    const excluidos = leidos.dinero.filter((v) => excluir.has(v.id));
    const vuelosHoras = contable
      ? [...leidos.dinero, ...leidos.sombras].filter((v) => {
          const dia = diaCancun(v.fecha_vuelo);
          return dia != null && dia >= q.desde && dia <= q.hasta;
        })
      : vuelos;
    const idsHoras = new Set(vuelosHoras.map((v) => v.id));
    // Gastos: con la migración, eje de cada gasto (invariante 72) — eje
    // VUELO ⇒ mes contable de su vuelo; eje GASTO ⇒ fecha_gasto.
    const gastos = contable
      ? await this.gastosDelPeriodoContable(
          gastosPorFecha,
          vuelos.map((v) => v.id),
          q,
          excluir,
        )
      : gastosPorFecha;
    // Partición ÚNICA (su avión XOR VuelaTour): aquí solo cuentan los de los
    // aviones de ESTE cómputo (activos; `q.aeronave_id` limita). Los de
    // VuelaTour no son de ningún reparto.
    const ingresosPartidos = partirIngresosPorAvion(ingresosResultado);
    const ingresosDeAviones = aeronaves.flatMap(
      (a) => ingresosPartidos.porAvion.get(a.id) ?? [],
    );
    const vueloIds = vuelos.map((v) => v.id);
    // Vuelos EXTERNOS del periodo: la MISMA lectura por vuelo trae sus
    // gastos para saber si uno ES el pago al operador (invariante 88).
    const externosIds = new Set(
      vuelos.filter((v) => v.es_externo === true).map((v) => v.id),
    );
    // Escalas: las del dinero (participación) + las de los vuelos que solo
    // aportan HORAS (sombras y excluidos). Cobros: también los de los
    // excluidos (la decisión de diferir los lee); computeAvion solo recorre
    // `vuelos`, así que no cuentan dinero.
    const idsSoloHoras = vuelosHoras
      .map((v) => v.id)
      .filter((id) => !vueloIds.includes(id));
    const [cobros, escalas, gastosDeVuelos] = await Promise.all([
      this.fetchCobros([...vueloIds, ...excluidos.map((v) => v.id)]),
      this.fetchEscalasHoras([...vueloIds, ...idsSoloHoras]),
      // PAGO REAL AL VENDEDOR por VUELO (13-oct-2026, API 0.0.74, invariante
      // 61): la «Comisión del vendedor (avión)» cuenta en el mes del VUELO
      // (los gastos de cada vuelo del periodo, de cualquier fecha_gasto) — la
      // ÚNICA vía por la que el reparto la resta (`comisionesDelVuelo`, que
      // elige el lado; la «(VuelaTour)» solo se cuenta).
      this.leerGastosDeVuelos(vueloIds, externosIds),
    ]);
    const gastosVendedorPorVuelo = gastosDeVuelos.vendedor;
    const gastosExternoPorVuelo = gastosDeVuelos.externos;
    // T.C. DE COSTOS (z) DE CADA VUELO (20-oct-2026, invariante 99): los
    // gastos crudos de cada vuelo del reparto, para que la provisión AFAC en
    // pesos salga con el MISMO z del balance (promedio de `tc_gasto` de sus
    // gastos MXN sin el pago al vendedor; sin ninguno, el K del vuelo).
    const gastosPorVuelo = new Map<string, GastoRow[]>();
    for (const g of gastos) {
      if (!g.vuelo_id) continue;
      const list = gastosPorVuelo.get(g.vuelo_id) ?? [];
      list.push(g);
      gastosPorVuelo.set(g.vuelo_id, list);
    }

    // Ingreso canónico por vuelo: suma de cobro_vuelo convertida a USD
    // (cobrosEnUsd, la MISMA fuente que la bandera `cobrado` y el reporte por
    // vuelo). Soporta cobro parcial: lo recibido cuenta, el resto es pendiente.
    const cobrosPorVuelo = new Map<string, CobroRow[]>();
    for (const c of cobros) {
      const list = cobrosPorVuelo.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVuelo.set(c.vuelo_id, list);
    }

    // TC OFICIAL DE RESPALDO (regla del cliente, 29-ago-2026) — UNA sola
    // resolución por día para todo el cómputo: (a) vuelos sin tc_usd_mxn con
    // cobros MXN sin TC → TC oficial del día de la COTIZACIÓN; (b) gastos
    // MXN sin tc_gasto → TC oficial del día del GASTO. Misma cadena que el
    // Balance por avión (tc capturado ?? oficial del día). Sin dato (sin
    // red) el monto sigue en sin_tc_* como siempre — jamás se inventa.
    //
    // (c) K DE LAS COMISIONES (revisión 13-oct-2026, invariante 61): vuelos
    // sin tc_usd_mxn cuyos cobros NO piden T.C. pero que traen un pago
    // «Comisión del vendedor (avión)» en pesos SIN tc_gasto. El balance
    // (`tcOficialPorVuelos`) resuelve el oficial del día de la cotización
    // para TODO vuelo sin tc_usd_mxn y con ese K convierte y resta el pago;
    // sin (c) el reparto lo dejaba en `gastos_sin_tc` y los socios cobraban
    // el pago completo de más (101 de 271 vuelos COMPLETADO de jul–oct no
    // traen tc_usd_mxn). Va en un mapa APARTE (`tcKComisionesVuelo`) para
    // que `cobros_tc_oficial_count`, `detalle.vuelos[].tc_oficial` y
    // `tc_oficial` sigan contando SOLO los vuelos cuyos COBROS lo usaron.
    // Mismo lote de días: una consulta por día para (a), (b) y (c).
    const vuelosTcCobros = new Set(
      vuelos
        .filter((v) =>
          cobrosNecesitanTc(cobrosPorVuelo.get(v.id) ?? [], v.tc_usd_mxn),
        )
        .map((v) => v.id),
    );
    // (d) INGRESOS de los aviones en MXN sin T.C. propio (13-oct-2026,
    // invariante 67): el oficial del día del INGRESO, en el MISMO lote.
    //
    // Vuelos que HOY (0.0.93) piden el K oficial para sus DÓLARES: los de
    // los cobros (a), los de la «(avión)» en pesos (c) y (e) el externo sin
    // T.C. en la cotización con costo del operador y algún gasto de columnas
    // (el K —oficial del día de la cotización, el MISMO del balance— decide
    // si ese gasto es el pago al operador, invariante 88; va al mapa de (c)).
    const vuelosKDolares = new Set(
      vuelos
        .filter(
          (v) =>
            vuelosTcCobros.has(v.id) ||
            pagoVendedorAvionNecesitaK(
              gastosVendedorPorVuelo.get(v.id) ?? [],
              v.tc_usd_mxn,
            ) ||
            (v.es_externo === true &&
              v.estado !== 'CANCELADO' &&
              pos(v.tc_usd_mxn) == null &&
              pos(v.costo_externo_usd) != null &&
              (gastosExternoPorVuelo.get(v.id) ?? []).some((g) =>
                gastoRestaEnColumnasDelVuelo(g.categoria),
              )),
        )
        .map((v) => v.id),
    );
    // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): el
    // resolver recibe TODOS los vuelos —el K de los pesos es el del balance:
    // capturado ?? oficial del día de la cotización para TODO vuelo sin
    // tc_usd_mxn—, los gastos en DÓLARES sin tc_gasto (el oficial de su día
    // los pasa a pesos) y el día de la RESERVA (oficial del cierre del
    // periodo: min(hasta, hoy Cancún)), en el MISMO lote de días. Los mapas
    // de los DÓLARES (`tcOficial.vuelo`, `tcKComisionesVuelo`) siguen
    // restringidos a los vuelos que ya lo pedían: ningún USD se mueve.
    const diaReserva = [q.hasta, hoyCancun(this.ahora())].sort()[0];
    const tcResuelto = await this.resolverTcOficial(
      vuelos,
      gastos,
      ingresosDeAviones,
      { gastosUsd: gastos, dias: [diaReserva] },
    );
    const tcOficial = {
      vuelo: new Map(
        [...tcResuelto.vuelo].filter(([id]) => vuelosTcCobros.has(id)),
      ),
      gasto: tcResuelto.gasto,
      ingreso: tcResuelto.ingreso,
    };
    const tcKComisionesVuelo = new Map(
      [...tcResuelto.vuelo].filter(
        ([id]) => !vuelosTcCobros.has(id) && vuelosKDolares.has(id),
      ),
    );
    // K de los PESOS de cada vuelo (mapa completo) y oficiales en pesos.
    const tcPesosVuelo = tcResuelto.vuelo;
    const tcOficialGastoUsd = tcResuelto.gastoUsd;
    const tcReserva = tcResuelto.porDia.get(diaReserva)?.tc ?? null;

    // Horas voladas del periodo por avión (por tramo: el avión de la escala
    // puede diferir del principal del vuelo). Base de la reserva de overhaul.
    // Las horas REALES de cada avión son SIEMPRE por escala (Regla B): no se
    // reparten con el factor del vuelo.
    const vueloAvion = new Map<string, string | null>(
      [...vuelos, ...vuelosHoras].map((v) => [v.id, v.aeronave_id]),
    );
    const horasPorAvion = new Map<string, number>();
    const escalasPorVuelo = new Map<string, EscalaHorasRow[]>();
    // Mapa escala → avión (crudo; la herencia la aplica `avionDelGasto`).
    // Incluye tramos cancelados: un gasto ligado a un tramo cancelado sigue
    // siendo del avión de ese tramo.
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    for (const e of escalas) {
      escalaPorId.set(e.id, { aeronave_id: e.aeronave_id });
      const list = escalasPorVuelo.get(e.vuelo_id) ?? [];
      list.push(e);
      escalasPorVuelo.set(e.vuelo_id, list);
      // Tramos cancelados fuera de las horas (cinturón, 28-ago): cancelEscala
      // anula sus lecturas, pero un residuo con tacos sumaría horas de una
      // operación que no ocurrió. Los tramos vivos de un vuelo CANCELADO sí
      // entran (avión que voló a recoger y regresó ferry: movió el horómetro).
      if (e.cancelada_at != null) continue;
      // HORAS por fecha REAL (invariante 89): solo los vuelos que volaron en
      // el periodo (un diferido que VIENE de otro mes no trae horas).
      if (!idsHoras.has(e.vuelo_id)) continue;
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (!Number.isFinite(h) || h <= 0) continue;
      const avionId = e.aeronave_id ?? vueloAvion.get(e.vuelo_id) ?? null;
      if (!avionId) continue;
      horasPorAvion.set(avionId, (horasPorAvion.get(avionId) ?? 0) + h);
    }

    // REGLA B (cliente, 28-ago-2026): participación de cada avión en la VENTA
    // DEL AVIÓN de cada vuelo — fuente única `participacionPorAeronave`
    // (tramos activos, avión con herencia, pesos por horas cotizadas / por
    // tramo). Vuelos EXTERNOS no se reparten (sin avión de flota): conservan
    // su tratamiento (factor 1 al avión de referencia si lo hubiera, como
    // siempre, y el bloque `externos`).
    const participacionPorVuelo = new Map<string, ParticipacionAeronave>();
    for (const v of vuelos) {
      participacionPorVuelo.set(
        v.id,
        participacionPorAeronave(
          v,
          v.es_externo === true ? [] : (escalasPorVuelo.get(v.id) ?? []),
        ),
      );
    }

    // «COMISIÓN DEL VENDEDOR (AVIÓN)» QUE CARGA ALGÚN AVIÓN (13-oct-2026, API
    // 0.0.74, invariante 61): vuelos del reparto en el universo de la
    // «(avión)» (`pagoVendedorAvionEnUniverso`: COMPLETADO, o CANCELADO con
    // cobros retenidos, con el MISMO K de `comisionesDelVuelo` en
    // `computeAvion`: `kComisionesDeVuelo`) y con
    // algún avión con parte de la venta. GLOBAL (no por avión): decide la
    // clave EXCLUIDO del eje fecha_gasto de cada gasto «(avión)» aunque esté
    // sellado a OTRO avión (caso i5). Solo transparencia: no suma nada.
    const vuelosConPagoVendedorAvion = new Set<string>();
    for (const v of vuelos) {
      const part = participacionPorVuelo.get(v.id);
      if (!part || ![...part.factores.values()].some((f) => f > 0)) continue;
      if (
        pagoVendedorAvionEnUniverso({
          estado: v.estado,
          cobros: cobrosPorVuelo.get(v.id) ?? [],
          tcVenta: kComisionesDeVuelo(v, tcOficial.vuelo, tcKComisionesVuelo),
        })
      ) {
        vuelosConPagoVendedorAvion.add(v.id);
      }
    }

    // Escalas referidas por gastos del periodo pero de vuelos FUERA del
    // periodo (gasto de agosto de un vuelo de julio): se traen con su avión
    // ya heredado para que `avionDelGasto` resuelva igual que en el balance.
    const escalasFaltantes = [
      ...new Set(
        gastos
          .map((g) => g.escala_id)
          .filter((id): id is string => !!id && !escalaPorId.has(id)),
      ),
    ];
    for (const [id, aeronaveId] of await this.fetchAvionDeEscalas(
      escalasFaltantes,
    )) {
      escalaPorId.set(id, { aeronave_id: aeronaveId });
    }
    // Matrículas de TODA la flota (activa o no) para etiquetar el reparto
    // multi-avión ("tramos también en N4142R") aunque se filtre por avión.
    const matriculas = await this.fetchMatriculas();

    // Conteo de aviones activos para prorratear los gastos fijos.
    const activos = await this.countAeronavesActivas();

    // REPARTO MANUAL (26-ago-2026, gasto_reparto): el reparto GANA sobre
    // aeronave_id — el gasto repartido se sustituye por sus PARCIALES (uno
    // por avión, moneda/TC del padre) y el remanente queda como gasto de la
    // EMPRESA (no se carga a nadie). Regla única en gasto-reparto.util.
    const repartos = await fetchRepartos(
      this.supabase.service,
      gastos.map((g) => g.id),
    );
    const { atribuciones: gastosAtribuidos } = expandirConReparto(
      gastos,
      repartos,
    );

    // Pool de gastos fijos (sueldos, seguros) de todo el periodo. Un FIJO
    // con reparto MANUAL sale del pool (sus parciales van directo al avión
    // elegido; contar ambos lo restaría DOBLE).
    let fijoPoolUsd = 0;
    let sinTcCount = 0;
    let sinTcMxn = 0;
    let fijosTcOficialCount = 0;
    let fijosTcOficialMxn = 0;
    // REPARTO EN PESOS (0.0.94, invariante 92): el MISMO pool EN PESOS (MXN
    // tal cual, con o sin T.C.; USD × tc_gasto ?? oficial de su día) y los
    // dólares del pool que no llegaron a pesos.
    let fijoPoolMxn = 0;
    let fijoPoolSinPesosUsd = 0;
    for (const g of gastosAtribuidos) {
      if (g.categoria !== FIJO || g.es_reparto_parcial) continue;
      const conv = this.toUsd(g, tcOficial.gasto);
      if (conv === null) {
        sinTcCount += 1;
        sinTcMxn += Number(g.monto);
      } else {
        fijoPoolUsd += conv.usd;
        if (conv.oficial) {
          fijosTcOficialCount += 1;
          fijosTcOficialMxn += Number(g.monto);
        }
      }
      const mxn = this.toMxn(g, tcOficialGastoUsd);
      if (mxn != null) fijoPoolMxn += mxn;
      else if (conv !== null) fijoPoolSinPesosUsd += conv.usd;
    }
    const otrosPorAvion = activos > 0 ? fijoPoolUsd / activos : 0;
    const otrosPorAvionMxn = activos > 0 ? fijoPoolMxn / activos : 0;
    const otrosPorAvionSinPesosUsd =
      activos > 0 ? fijoPoolSinPesosUsd / activos : 0;

    const socioIds = [...new Set(socios.map((s) => s.socio_id))];
    const [nombres, clientes] = await Promise.all([
      this.fetchNombres(socioIds),
      this.fetchClientes([
        ...new Set(
          vuelos.map((v) => v.cliente_id).filter((id): id is string => !!id),
        ),
      ]),
    ]);

    const aviones = aeronaves.map((a) =>
      this.computeAvion(a, {
        vuelos,
        cobrosPorVuelo,
        horasPorAvion,
        participacionPorVuelo,
        escalaPorId,
        escalasPorVuelo,
        vueloAvion,
        matriculas,
        clientes,
        gastos: gastosAtribuidos,
        socios,
        reservas,
        nombres,
        otrosPorAvion,
        periodo: q,
        tcOficialVuelo: tcOficial.vuelo,
        tcOficialGasto: tcOficial.gasto,
        tcKComisionesVuelo,
        vigenciaComisiones,
        gastosVendedorPorVuelo,
        vuelosConPagoVendedorAvion,
        ingresosAvion: ingresosPartidos.porAvion.get(a.id) ?? [],
        tcOficialIngreso: tcOficial.ingreso,
        // REPARTO EN PESOS (0.0.94, invariante 92).
        tcPesosVuelo,
        tcOficialGastoUsd,
        otrosPorAvionMxn,
        otrosPorAvionSinPesosUsd,
        tcReserva,
        // PROVISIÓN AFAC (20-oct-2026, invariante 99): z por vuelo.
        gastosPorVuelo,
        conDetalleGastos: opts.detalleGastos === true,
      }),
    );

    // Vuelos EXTERNOS del periodo (aeronave_id null: no entran a ninguna
    // card por avión). Su dinero cobrado ANTES desaparecía del reparto sin
    // rastro; aquí se hace visible como bloque informativo — la utilidad
    // externa NO se distribuye entre socios (el vuelo no es de un avión de
    // la flota) hasta que el cliente decida su tratamiento.
    let extCobrado = 0;
    let extCosto = 0;
    let extComisionVendedor = 0;
    let extSinCosto = 0;
    let extSinTcMxn = 0;
    let extTcOficialCount = 0;
    const externosVuelos = vuelos.filter((v) => v.es_externo === true);
    for (const v of externosVuelos) {
      // Misma cadena de TC que los aviones de flota y el balance:
      // capturado en la cotización ?? oficial del día de la cotización.
      const tcOficialExt = tcOficial.vuelo.get(v.id);
      const conv = cobrosEnUsd(
        cobrosPorVuelo.get(v.id) ?? [],
        pos(v.tc_usd_mxn) ?? tcOficialExt?.tc ?? null,
        pos(v.tc_usd_mxn),
      );
      if (tcOficialExt != null) extTcOficialCount += 1;
      extCobrado += conv.total_usd;
      extSinTcMxn += conv.sin_tc_mxn;
      // Externo CANCELADO (28-ago): lo retenido al cliente sí es ingreso; el
      // costo pactado con el operador NO se resta (el servicio no se prestó;
      // si el operador cobró penalización va como gasto del vuelo) ni se
      // reclama como "sin costo". Tampoco se provisiona pago al vendedor.
      if (v.estado === 'CANCELADO') continue;
      if (v.costo_externo_usd == null) {
        extSinCosto += 1;
      } else {
        // EL PAGO AL OPERADOR ES EL GASTO REAL (16-oct-2026, invariante 88;
        // fuente única `pagoOperadorExternoEnGastos`, la MISMA del balance y
        // del reporte por vuelo): si un gasto del vuelo coincide con el
        // costo capturado, el costo del operador es LO PAGADO (ese gasto en
        // USD: tc_gasto ?? K). Este bloque no cuenta ningún otro gasto del
        // externo, así que jamás hubo doble conteo aquí: solo se alinea el
        // monto con los otros dos lectores. Sin T.C. para pasarlo a USD,
        // sigue el costo capturado.
        const kExt = kComisionesDeVuelo(v, tcOficial.vuelo, tcKComisionesVuelo);
        const pagoOp = pagoOperadorExternoEnGastos({
          esExterno: true,
          cancelado: false,
          costoUsd: v.costo_externo_usd,
          tcVenta: kExt,
          gastos: gastosExternoPorVuelo.get(v.id) ?? [],
        });
        const pagadoUsd =
          pagoOp.cubre != null ? usdDelPagoOperador(pagoOp.cubre, kExt) : null;
        extCosto += pagadoUsd ?? Number(v.costo_externo_usd);
      }
      // COMISIÓN DEL VENDEDOR en externos (verificación 28-ago): el vuelo
      // externo no se parte (no hay avión de flota), así que lo cobrado
      // incluye la comisión que el cliente pagó sumada al precio — y ese
      // dinero VuelaTour se lo paga al vendedor. Sin restarlo, la utilidad
      // externa quedaba inflada por el pago al vendedor. Fuente única
      // `pagoVendedorUsd` (comisión + su IVA cuando la cotización grava).
      extComisionVendedor += pagoVendedorUsd(particionIngresoVuelo(v));
    }
    const extCobradoR = round2(extCobrado);
    const extCostoR = round2(extCosto);
    const extComisionVendedorR = round2(extComisionVendedor);

    // INGRESO DE VUELATOUR del periodo (regla 6 + Regla A, 28-ago-2026): TUAS
    // + extras + pernocta + comisión del vendedor cobrados (+ su IVA) en
    // vuelos de la FLOTA. Sale de los mismos acumuladores por avión (misma
    // partición, mismos cobros; en multi-avión lo reporta UN solo avión), así
    // Σ cobrado_bruto == Σ venta avión cobrada + este bloque, al centavo.
    // Bloque INFORMATIVO: no se reparte ni entra a ninguna cascada; su lugar
    // contable es la pestaña Otros movimientos del Balance general. Los
    // vuelos EXTERNOS (bloque `externos`) quedan fuera a propósito: su
    // dinero no se parte (no hay avión de flota que repartir).
    const otrosIngresosVuelatour = aviones.reduce(
      (acc, a) => {
        const oi = a.detalle.otros_ingresos_vuelatour;
        acc.vuelos += oi.vuelos;
        acc.cobrado_usd += a.ingresos.otros_ingresos_vuelatour_usd;
        acc.pendiente_usd += a.ingresos.otros_ingresos_vuelatour_pendiente_usd;
        acc.desglose.tuas_usd += oi.desglose.tuas_usd;
        acc.desglose.extras_usd += oi.desglose.extras_usd;
        acc.desglose.pernocta_usd += oi.desglose.pernocta_usd;
        acc.desglose.comision_usd += oi.desglose.comision_usd;
        acc.desglose.iva_usd += oi.desglose.iva_usd;
        return acc;
      },
      {
        vuelos: 0,
        cobrado_usd: 0,
        pendiente_usd: 0,
        desglose: {
          tuas_usd: 0,
          extras_usd: 0,
          pernocta_usd: 0,
          comision_usd: 0,
          iva_usd: 0,
        },
      },
    );

    // Agregado global INFORMATIVO del TC oficial (29-ago): Σ por avión
    // (cobros en el avión que reporta, gastos por avión) + pool de FIJOS +
    // externos. Los montos ya están DENTRO de las cifras del reparto; este
    // bloque solo dice cuántos se convirtieron así y con qué fuente.
    const tcOficialVuelos =
      aviones.reduce((acc, a) => acc + a.ingresos.cobros_tc_oficial_count, 0) +
      extTcOficialCount;
    const tcOficialGastos = aviones.reduce(
      (acc, a) => ({
        count: acc.count + a.gastos.gastos_tc_oficial.count,
        monto_mxn: acc.monto_mxn + a.gastos.gastos_tc_oficial.monto_mxn,
      }),
      { count: fijosTcOficialCount, monto_mxn: fijosTcOficialMxn },
    );
    // Otros ingresos de los aviones convertidos con el T.C. oficial del día
    // (13-oct-2026, invariante 67): informativo, ya DENTRO de sus saldos.
    const tcOficialIngresos = aviones.reduce(
      (acc, a) => {
        for (const l of a.detalle.otros_ingresos_avion) {
          if (!l.tc_oficial) continue;
          acc.count += 1;
          acc.monto_mxn += l.neto;
        }
        return acc;
      },
      { count: 0, monto_mxn: 0 },
    );
    const tcOficialFuentes = [
      ...new Set(
        [
          ...tcOficial.vuelo.values(),
          ...tcOficial.gasto.values(),
          ...tcOficial.ingreso.values(),
        ].map((d) => fuenteTcLegible(d.fuente)),
      ),
    ].sort();

    // CIERRE DE MES (16-oct-2026, invariante 89): bloque ADITIVO `cierre` y
    // marcas por vuelo en `detalle.vuelos[]`. SOLO con la migración (sin
    // ella las llaves no viajan: 0.0.87 byte a byte).
    const cierre = contable
      ? await this.bloqueCierreReparto({
          q,
          vuelos,
          excluidos,
          sombras: leidos.sombras,
          cobrosPorVuelo,
          tcVuelo: (v) =>
            pos(v.tc_usd_mxn) ?? tcOficial.vuelo.get(v.id)?.tc ?? null,
          clientes,
          matriculas,
          aviones,
        })
      : null;

    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): cada
      // avión trae su cascada EN PESOS (`*_mxn`, `pesos_sin_tc_usd`); con
      // esta bandera el panel pinta los pesos como lo principal. Viaja
      // SIEMPRE (también en la respuesta vacía).
      reparto_en_pesos: true as const,
      // LA CASCADA DEL BALANCE (20-oct-2026, invariante 99): INDIRECTO
      // cuenta, la provisión AFAC resta (`afac_reservado_*`) y la reserva de
      // overhaul SOLO se informa (por socio en `reparto[].reserva_*`; se
      // descuenta solo a quien lo pidió). Con esta bandera el panel y
      // pyservices pintan la cascada nueva.
      reparto_como_balance: true as const,
      ...(cierre ? { cierre } : {}),
      gastos_sin_tc: { count: sinTcCount, monto_mxn: round2(sinTcMxn) },
      // ADITIVO (29-ago): FIJOS del pool convertidos con el TC oficial del
      // día del gasto (ya dentro de otros_prorrateados; NO están en
      // gastos_sin_tc).
      gastos_tc_oficial: {
        count: fijosTcOficialCount,
        monto_mxn: round2(fijosTcOficialMxn),
      },
      tc_oficial: {
        vuelos: tcOficialVuelos,
        gastos: {
          count: tcOficialGastos.count,
          monto_mxn: round2(tcOficialGastos.monto_mxn),
        },
        fuentes: tcOficialFuentes,
        leyenda: TC_OFICIAL_LEYENDA,
        // ADITIVO (13-oct-2026, API 0.0.75, invariante 67): otros ingresos
        // de los aviones en MXN convertidos con el T.C. oficial de su día
        // (mismo shape que `gastos`; Σ neto MXN).
        ingresos: {
          count: tcOficialIngresos.count,
          monto_mxn: round2(tcOficialIngresos.monto_mxn),
        },
      },
      externos: {
        vuelos: externosVuelos.length,
        cobrado_usd: extCobradoR,
        costo_usd: extCostoR,
        // ADITIVO: pago al vendedor de los externos no cancelados (comisión
        // + IVA, `pagoVendedorUsd`); ya restado en utilidad_usd.
        comisiones_vendedor_usd: extComisionVendedorR,
        utilidad_usd: round2(extCobradoR - extCostoR - extComisionVendedorR),
        sin_costo_count: extSinCosto,
        cobros_sin_tc_mxn: round2(extSinTcMxn),
        // ADITIVO (29-ago): externos cuyos cobros MXN sin TC se convirtieron
        // con el TC oficial del día de la cotización.
        cobros_tc_oficial_count: extTcOficialCount,
      },
      otros_ingresos_vuelatour: {
        vuelos: otrosIngresosVuelatour.vuelos,
        cobrado_usd: round2(otrosIngresosVuelatour.cobrado_usd),
        pendiente_usd: round2(otrosIngresosVuelatour.pendiente_usd),
        // Desglose PRE-IVA cotizado (no cobrado) de los vuelos con precio del
        // periodo + su IVA: para entender de qué se compone el bloque.
        // comision_usd (ADITIVO, Regla A): comisión del vendedor — ingreso de
        // VuelaTour que se paga al vendedor (Otros movimientos).
        desglose: {
          tuas_usd: round2(otrosIngresosVuelatour.desglose.tuas_usd),
          extras_usd: round2(otrosIngresosVuelatour.desglose.extras_usd),
          pernocta_usd: round2(otrosIngresosVuelatour.desglose.pernocta_usd),
          comision_usd: round2(otrosIngresosVuelatour.desglose.comision_usd),
          iva_usd: round2(otrosIngresosVuelatour.desglose.iva_usd),
        },
        leyenda: OTROS_INGRESOS_LEYENDA,
      },
      aviones,
    };
  }

  /**
   * Utilidades de los socios de esos meses (en el mismo orden): fuente
   * ÚNICA de «cuánto generó cada socio cada mes» para la cuenta corriente.
   * `mesActual` (YYYY-MM, Cancún) decide qué mes está en curso. `fresco`
   * (las ESCRITURAS de entregas: el candado del adelanto) recalcula los
   * meses cerrados sin leer la memoria de 10 min, y la renueva.
   */
  async utilidadesSociosPorMes(
    meses: ReadonlyArray<string>,
    mesActual: string,
    opts: { fresco?: boolean } = {},
  ): Promise<UtilidadMesSocios[]> {
    return this.utilidadesMes.deMeses(meses, mesActual, opts);
  }

  private async utilidadMesSocios(
    mes: string,
    enCurso: boolean,
  ): Promise<UtilidadMesSocios> {
    // CIERRE DE MES (16-oct-2026, invariante 89; decisión de fondo de la
    // invariante 38 RESUELTA: congelar al cerrar): un mes CERRADO toma la
    // utilidad por socio GUARDADA al cerrarlo (`socios_snapshot`), sin
    // compute. Mes abierto (o sin la migración): en vivo, como siempre.
    const contable = await cierreMesDisponible(this.supabase.service);
    if (contable && !enCurso) {
      const snap = await this.sociosSnapshotDeMes(mes);
      if (snap) return snap;
    }
    const { desde, hasta } = rangoDeMes(mes);
    const calculo = await this.compute({ desde, hasta }, { sinPiso: true });
    const u = utilidadMesDesdeAviones(mes, calculo.aviones, enCurso);
    return contable ? { ...u, origen: 'EN_VIVO' } : u;
  }

  /**
   * `socios_snapshot` del mes si está CERRADO (null si no, o si el
   * snapshot no tiene la forma esperada — entonces se calcula en vivo y se
   * avisa en el log; jamás una cuenta con un snapshot roto).
   */
  private async sociosSnapshotDeMes(
    mes: string,
  ): Promise<UtilidadMesSocios | null> {
    const { data, error } = await this.supabase.service
      .from('cierre_mes')
      .select('socios_snapshot, cerrado_at')
      .eq('periodo', `${mes}-01`)
      .eq('estado', 'CERRADO')
      .maybeSingle();
    if (error) throw new Error(`Cierre de ${mes}: ${error.message}`);
    if (!data) return null;
    const snap = (data as { socios_snapshot?: unknown }).socios_snapshot;
    const aviones =
      snap && typeof snap === 'object'
        ? (snap as { aviones?: unknown }).aviones
        : null;
    if (!Array.isArray(aviones)) {
      this.logger.warn(
        `Cierre de ${mes}: socios_snapshot sin «aviones»; la cuenta de socios lo calcula en vivo`,
      );
      return null;
    }
    return {
      mes,
      en_curso: false,
      aviones: aviones as UtilidadMesSocios['aviones'],
      origen: 'SNAPSHOT_CIERRE',
      cerrado_at: (data as { cerrado_at?: string | null }).cerrado_at ?? null,
    };
  }

  /** Olvida la memoria de utilidades de los socios (cerrar / reabrir mes). */
  olvidarUtilidadesSocios(): void {
    this.utilidadesMes.olvidar();
  }

  /**
   * CIERRE DE MES (16-oct-2026, invariante 89): bloque ADITIVO `cierre` del
   * reparto y marcas por vuelo (`cierre_marca`, `diferido_de`, `diferido_a`
   * en `aviones[].detalle.vuelos[]`). Solo informa: el DINERO ya lo decidió
   * el universo por `fecha_contable`.
   *  - `diferidos_salen`: los que VOLARON en el periodo y un cierre pasó
   *    fuera (más los EXCLUIDOS de la simulación): no están en `aviones[]`.
   *  - `diferidos_entran`: los que un cierre trajo a este periodo (suman).
   *  - `pendientes_que_pasarian`: en un mes calendario NO cerrado, los que
   *    `decisionDiferir` pasaría hoy al mes siguiente (siguen sumando).
   *  - `coincide_con_snapshot`: mes CERRADO ⇒ saldo por avión de hoy vs el
   *    guardado al cerrar (±0.01); false = cambió un % o un T.C. después.
   * Montos de los diferidos = los de la bitácora del cierre (al corte).
   */
  private async bloqueCierreReparto(ctx: {
    q: ProfitSharingQuery;
    vuelos: VueloRow[];
    excluidos: VueloRow[];
    sombras: VueloRow[];
    cobrosPorVuelo: Map<string, CobroRow[]>;
    tcVuelo: (v: VueloRow) => number | null;
    clientes: Map<string, string>;
    matriculas: Map<string, string>;
    aviones: Array<{
      aeronave: { id: string; matricula: string };
      saldo_disponible_usd: number;
      detalle: { vuelos: Array<{ id: string }> };
    }>;
  }): Promise<CierreRepartoBloque> {
    const sb = this.supabase.service;
    const { q } = ctx;
    const mes = mesCalendarioDeRango(q.desde, q.hasta);
    const cierreFila: CierreMesLeido | null = mes
      ? ((await leerCierresMes(sb)).find((f) => f.periodo === mes) ?? null)
      : null;
    const estado = cierreFila?.estado ?? 'ABIERTO';
    const venidos = ctx.vuelos.filter(
      (v) => papelContableEnPeriodo(v, q.desde, q.hasta) === 'viene',
    );
    const bitacora = await leerDiferimientos(sb, [
      ...venidos.map((v) => v.id),
      ...ctx.sombras.map((v) => v.id),
    ]);
    const matricula = (v: VueloRow): string | null =>
      v.aeronave_id ? (ctx.matriculas.get(v.aeronave_id) ?? null) : null;
    const cliente = (v: VueloRow): string | null =>
      v.cliente_id ? (ctx.clientes.get(v.cliente_id) ?? null) : null;
    const item = (
      v: VueloRow,
      d: Pick<DecisionDiferir, 'venta_usd' | 'cobrado_usd' | 'por_cobrar_usd'> &
        Partial<
          Pick<
            DecisionDiferir,
            'motivo' | 'cobrado_posterior_usd' | 'fecha_cobro_posterior'
          >
        >,
    ) => ({
      id: v.id,
      folio: v.folio ?? null,
      cliente: cliente(v),
      matricula: matricula(v),
      venta_usd: d.venta_usd,
      cobrado_usd: d.cobrado_usd,
      por_cobrar_usd: d.por_cobrar_usd,
      fecha_vuelo: v.fecha_vuelo ?? null,
      aeronave_id: v.aeronave_id ?? null,
      cliente_id: v.cliente_id ?? null,
      ...(d.motivo
        ? {
            motivo: d.motivo,
            cobrado_posterior_usd: d.cobrado_posterior_usd ?? 0,
            ...(d.fecha_cobro_posterior
              ? { fecha_cobro_posterior: d.fecha_cobro_posterior }
              : {}),
          }
        : {}),
    });
    // Clientes internos (nada que cobrar) para la decisión de diferir.
    const necesitaDecision =
      ctx.excluidos.length > 0 || (mes != null && estado !== 'CERRADO');
    const internos = necesitaDecision
      ? await this.clientesInternosDe([
          ...ctx.vuelos.map((v) => v.cliente_id),
          ...ctx.excluidos.map((v) => v.cliente_id),
        ])
      : new Set<string>();
    const decidir = (v: VueloRow, ultimoDia: string): DecisionDiferir | null =>
      decisionDiferir(
        {
          estado: v.estado,
          monto_total_usd: v.monto_total_usd,
          tc_usd_mxn: ctx.tcVuelo(v),
          k_cotizacion: pos(v.tc_usd_mxn),
          cliente_interno: v.cliente_id ? internos.has(v.cliente_id) : false,
        },
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        ultimoDia,
      );

    const salen: CierreRepartoVuelo[] = [];
    for (const v of ctx.sombras) {
      const real = mesRealDeVuelo(v);
      const sal = real ? salidaDeVuelo(v.id, real, bitacora) : null;
      const destino = sal?.destino ?? mesContableDeVuelo(v) ?? '';
      const montos = sal ?? {
        venta_usd: round2(Number(v.monto_total_usd) || 0),
        cobrado_usd: 0,
        por_cobrar_usd: round2(Number(v.monto_total_usd) || 0),
      };
      salen.push({
        ...item(v, montos),
        destino,
        leyenda: destino ? leyendaPasaA(destino, montos) : 'Pasa a otro mes',
      });
    }
    for (const v of ctx.excluidos) {
      const base = mes ?? mesRealDeVuelo(v);
      if (!base) continue;
      const d = decidir(v, rangoDelMes(base).hasta) ?? {
        venta_usd: round2(Number(v.monto_total_usd) || 0),
        cobrado_usd: 0,
        por_cobrar_usd: round2(Number(v.monto_total_usd) || 0),
      };
      const destino = mesSiguienteDe(base);
      salen.push({ ...item(v, d), destino, leyenda: leyendaPasaA(destino, d) });
    }

    const marcas = new Map<
      string,
      {
        cierre_marca: string;
        diferido_de: string | null;
        diferido_a: string | null;
      }
    >();
    const entran: CierreRepartoVuelo[] = [];
    for (const v of venidos) {
      const contableMes = mesContableDeVuelo(v);
      const origen = contableMes
        ? origenDeVuelo(v, contableMes, bitacora)
        : null;
      const fila = bitacora.find(
        (b) => b.vuelo_id === v.id && b.destino === contableMes,
      );
      const montos = fila ?? {
        venta_usd: round2(Number(v.monto_total_usd) || 0),
        cobrado_usd: 0,
        por_cobrar_usd: round2(Number(v.monto_total_usd) || 0),
      };
      const leyenda = origen ? leyendaVieneDe(origen) : 'Viene de otro mes';
      entran.push({ ...item(v, montos), origen: origen ?? '', leyenda });
      marcas.set(v.id, {
        cierre_marca: leyenda,
        diferido_de: origen,
        diferido_a: null,
      });
    }

    const pasarian: CierreRepartoVuelo[] = [];
    if (mes != null && estado !== 'CERRADO') {
      const ultimo = rangoDelMes(mes).hasta;
      const destino = mesSiguienteDe(mes);
      for (const v of ctx.vuelos) {
        if (v.estado !== 'COMPLETADO') continue;
        const d = decidir(v, ultimo);
        if (!d) continue;
        const leyenda = leyendaPasara(destino, d);
        pasarian.push({ ...item(v, d), destino, leyenda });
        if (!marcas.has(v.id)) {
          marcas.set(v.id, {
            cierre_marca: leyenda,
            diferido_de: null,
            diferido_a: destino,
          });
        }
      }
    }

    // Marcas en el detalle de cada avión (todas las líneas llevan las llaves).
    for (const a of ctx.aviones) {
      for (const linea of a.detalle.vuelos) {
        const m = marcas.get(linea.id);
        Object.assign(linea, {
          cierre_marca: m?.cierre_marca ?? null,
          diferido_de: m?.diferido_de ?? null,
          diferido_a: m?.diferido_a ?? null,
        });
      }
    }

    let coincide: boolean | null = null;
    if (estado === 'CERRADO') {
      const porAvion = Array.isArray(cierreFila?.totales?.por_avion)
        ? (cierreFila?.totales?.por_avion as Array<Record<string, unknown>>)
        : null;
      if (porAvion) {
        const guardado = new Map(
          porAvion.map((p) => [String(p.aeronave_id), Number(p.saldo_usd)]),
        );
        coincide = ctx.aviones.every((a) => {
          const g = guardado.get(a.aeronave.id);
          return (
            g != null &&
            Number.isFinite(g) &&
            Math.abs(round2(a.saldo_disponible_usd) - round2(g)) <= 0.01
          );
        });
      }
    }

    const porFolio = (x: CierreRepartoVuelo, y: CierreRepartoVuelo) =>
      (x.folio ?? 0) - (y.folio ?? 0);
    return {
      disponible: true,
      periodo: mes,
      estado,
      cerrado_at: cierreFila?.cerrado_at ?? null,
      cerrado_por_nombre: cierreFila?.cerrado_por?.nombre ?? null,
      reabierto_at: cierreFila?.reabierto_at ?? null,
      reabierto_por_nombre: cierreFila?.reabierto_por?.nombre ?? null,
      version: cierreFila?.version ?? null,
      coincide_con_snapshot: coincide,
      diferidos_salen: salen.sort(porFolio),
      diferidos_entran: entran.sort(porFolio),
      pendientes_que_pasarian: pasarian.sort(porFolio),
    };
  }

  /** Clientes INTERNOS (es_interno) de esos ids, en una consulta. */
  private async clientesInternosDe(
    ids: ReadonlyArray<string | null | undefined>,
  ): Promise<Set<string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Set<string>();
    if (unicos.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('id')
      .in('id', unicos)
      .eq('es_interno', true);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) out.add(c.id as string);
    return out;
  }

  private computeAvion(
    a: AeronaveRow,
    ctx: {
      vuelos: VueloRow[];
      cobrosPorVuelo: Map<string, CobroRow[]>;
      horasPorAvion: Map<string, number>;
      /** Regla B: participación de cada avión en la venta de cada vuelo. */
      participacionPorVuelo: Map<string, ParticipacionAeronave>;
      /** escala.id → avión crudo del tramo (herencia en `avionDelGasto`). */
      escalaPorId: Map<string, { aeronave_id: string | null }>;
      /** vuelo.id → sus tramos (incluye cancelados; se filtran al etiquetar). */
      escalasPorVuelo: Map<string, EscalaHorasRow[]>;
      /** vuelo.id → avión principal del vuelo. */
      vueloAvion: Map<string, string | null>;
      /** aeronave.id → matrícula (toda la flota, para etiquetas). */
      matriculas: Map<string, string>;
      /** cliente.id → nombre (detalle.vuelos / PDF). */
      clientes: Map<string, string>;
      gastos: GastoRow[];
      socios: SocioRow[];
      reservas: ReservaRow[];
      nombres: Map<string, string>;
      otrosPorAvion: number;
      periodo: ProfitSharingQuery;
      /**
       * TC oficial de respaldo (29-ago): vuelo.id → detalle (solo vuelos sin
       * tc_usd_mxn con cobros MXN sin TC) y gasto.id → detalle (solo MXN sin
       * tc_gasto). Vacíos = todo capturado o sin red.
       */
      tcOficialVuelo: Map<string, TipoCambioDetalle>;
      tcOficialGasto: Map<string, TipoCambioDetalle>;
      /**
       * K de respaldo SOLO de las comisiones (revisión 13-oct-2026,
       * invariante 61): vuelo.id → T.C. oficial del día de la cotización de
       * los vuelos sin tc_usd_mxn cuyos cobros NO lo pidieron pero que traen
       * un pago «Comisión del vendedor (avión)» MXN sin tc_gasto. Solo entra
       * a `comisionesDelVuelo` (`kComisionesDeVuelo`): nunca a los cobros ni
       * a los conteos/detalle del T.C. oficial.
       */
      tcKComisionesVuelo: ReadonlyMap<string, TipoCambioDetalle>;
      /**
       * Primer día de las comisiones a cargo del avión (6-oct-2026, API
       * 0.0.65): vuelos con `fecha_vuelo` (día Cancún) desde ese día
       * descuentan la parte del avión de la comisión bancaria. Desde el
       * 0.0.74 (invariante 61) gobierna SOLO la parte bancaria: los pagos
       * «Comisión del vendedor (avión)» se descuentan en cualquier fecha
       * (`comisionesDelVuelo`).
       */
      vigenciaComisiones: string;
      /**
       * Gastos del pago al vendedor (las DOS categorías) de cada vuelo del
       * periodo (13-oct-2026, invariante 61; `fetchGastosVendedorDeVuelos`,
       * eje = VUELO, de cualquier fecha_gasto). `comisionesDelVuelo` elige el
       * lado: solo la «Comisión del vendedor (avión)» resta al avión.
       */
      gastosVendedorPorVuelo: Map<string, GastoVendedorVueloRow[]>;
      /**
       * Vuelos del reparto cuya «(avión)» la carga algún avión (GLOBAL, ver
       * `compute()`): solo decide la clave EXCLUIDO del eje fecha_gasto.
       */
      vuelosConPagoVendedorAvion: ReadonlySet<string>;
      /**
       * Ingresos de resultado ASIGNADOS a este avión (13-oct-2026, API
       * 0.0.75, invariante 67; `partirIngresosPorAvion`, mes de
       * `ingreso.fecha`): SUMAN al saldo, netos de comisión bancaria.
       * Opcional SOLO para los specs que arman el ctx a mano (sin él, []);
       * `compute()` lo manda siempre.
       */
      ingresosAvion?: ReadonlyArray<IngresoParaLibro>;
      /**
       * T.C. oficial del día de cada ingreso MXN sin T.C. propio (ingreso.id
       * → detalle; mismo lote de días que vuelos y gastos). Opcional como el
       * de arriba (sin él, ninguno).
       */
      tcOficialIngreso?: ReadonlyMap<string, TipoCambioDetalle>;
      /**
       * REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92).
       * Opcionales SOLO para los specs que arman el ctx a mano (sin ellos:
       * K = capturado ?? los mapas de siempre, pool en pesos 0, reserva sin
       * T.C.); `compute()` los manda siempre.
       *  - `tcPesosVuelo`: vuelo.id → oficial del día de la cotización de
       *    TODO vuelo sin tc_usd_mxn (el K del balance).
       *  - `tcOficialGastoUsd`: gasto.id → oficial del día de cada gasto en
       *    DÓLARES sin tc_gasto (lo pasa a pesos).
       *  - `otrosPorAvionMxn` / `otrosPorAvionSinPesosUsd`: la parte del pool
       *    de FIJOS en pesos y sus dólares sin pesos.
       *  - `tcReserva`: oficial del cierre del periodo (min(hasta, hoy)) con
       *    que la reserva de overhaul pasa a pesos.
       */
      tcPesosVuelo?: ReadonlyMap<string, TipoCambioDetalle>;
      tcOficialGastoUsd?: ReadonlyMap<string, TipoCambioDetalle>;
      otrosPorAvionMxn?: number;
      otrosPorAvionSinPesosUsd?: number;
      tcReserva?: number | null;
      /**
       * PROVISIÓN AFAC (20-oct-2026, invariante 99): gastos CRUDOS de cada
       * vuelo del reparto (vuelo.id → filas) para el T.C. de costos z con
       * que la provisión pasa a pesos (el MISMO del balance). Opcional solo
       * para los specs que arman el ctx a mano (sin él, z = K del vuelo).
       */
      gastosPorVuelo?: ReadonlyMap<string, GastoRow[]>;
      /** `detalle.gastos[]` gasto por gasto (pantalla por avión). */
      conDetalleGastos?: boolean;
    },
  ) {
    // "Solo se reparte lo cobrado" (doc 4.8) con DINERO REAL: la suma de
    // cobro_vuelo en USD (fuente canónica), no el monto cotizado del vuelo.
    // Un vuelo pagado al 90% aporta su 90% y deja el resto como pendiente.
    //
    // REGLA 6 (cliente, 28-ago-2026): del total que paga el cliente solo la
    // VENTA DEL AVIÓN (tiempo + ajuste + su IVA) es del avión y se reparte.
    // TUAS/extras/pernocta/comisión del vendedor cobrados (+ su IVA) son
    // ingreso de VuelaTour (Otros movimientos del Balance general) y quedan
    // FUERA de la cascada. La partición es la fuente única
    // `particionIngresoVuelo`; lo cobrado se PRORRATEA con `factor_avion`
    // (= avion_usd exacto con el vuelo pagado completo; parcial en
    // proporción) y se TOPA en la venta del avión: el sobrecobro es de
    // VuelaTour (cobradoParteAvion), así el bruto cobrado siempre es parte
    // avión + parte VuelaTour al centavo y nada desaparece.
    // OJO (13-oct-2026, API 0.0.75, invariante 67): lo que NO es de vuelo y
    // la oficina registró en Ingresos CON este avión (reembolso de su
    // servicio, venta de una pieza suya…) SÍ entra a la cascada: suma al
    // saldo como «otros ingresos del avión», aparte de la venta (abajo).
    //
    // REGLA B (cliente, 28-ago-2026): vuelo MULTI-AVIÓN (tramos en aviones
    // distintos) — la venta del avión y lo que deriva de ella (cobrado,
    // pendiente, retenido en cancelados) se REPARTE entre los aviones con
    // `repartirUsd` (centavos por residuo mayor: Σ partes == monto exacto).
    // La parte de VuelaTour NO se reparte: la reporta UN solo avión
    // (`avionQueReporta`, fuente única — misma regla que el balance por
    // avión y el Libro Dinero). Los gastos no se reparten: van al avión del
    // tramo al que están ligados (`avionDelGasto`).
    let cobrado = 0; // venta del avión cobrada (lo que SÍ se reparte)
    let cobradoBruto = 0; // todo lo cobrado al cliente (avión + VuelaTour)
    let pendiente = 0; // parte del avión aún no cobrada
    // Deuda COMPLETA del cliente (avión + VuelaTour): misma fórmula que el
    // pre-cierre `cobros_pendientes` — Σ max(0, total − cobrado) por vuelo
    // (en multi-avión, repartida: Σ sobre los aviones == esa fórmula).
    let pendienteBruto = 0;
    let otrosIngresosVT = 0; // parte de VuelaTour cobrada (informativa)
    let otrosIngresosVTPendiente = 0;
    let vuelosConOtrosIngresos = 0;
    // Desglose PRE-IVA cotizado (+ IVA) de la parte VuelaTour de TODOS los
    // vuelos con precio del periodo — informativo, no es lo cobrado.
    const desgloseVT = {
      tuas_usd: 0,
      extras_usd: 0,
      pernocta_usd: 0,
      comision_usd: 0,
      iva_usd: 0,
    };
    let vuelosCobrados = 0;
    let vuelosPendientes = 0;
    let cobrosSinTcMxn = 0;
    // Vuelos cuyos cobros MXN sin TC se convirtieron con el TC oficial del
    // día de la cotización (29-ago): informativo, mismo criterio de conteo
    // que cobros_sin_tc (una vez, en el avión que reporta).
    let cobrosTcOficialCount = 0;
    // REGLA A (cliente, 28-ago-2026 tarde): la comisión del vendedor
    // (Itzy/Pablo/broker) es INGRESO DE VUELATOUR, como un extra — el
    // cliente la paga sumada al precio (regla 23-jul) y VuelaTour se la paga
    // al vendedor. Ya NO viaja en la venta del avión (particionIngresoVuelo
    // la manda a vuelatour_usd).
    // COMISIONES A CARGO DEL AVIÓN (cliente, 6-oct-2026, API 0.0.65): el
    // avión SÍ absorbe la parte de la comisión BANCARIA con que su cobro se
    // prorratea (vuelos con `fecha_vuelo` desde `comisiones_al_avion_desde`)
    // y, desde el 0.0.74 (13-oct-2026, invariante 61), los pagos «Comisión
    // del vendedor (avión)» del vuelo (COMPLETADO o CANCELADO con cobros
    // retenidos, en CUALQUIER fecha, por participación; la «Comisión del
    // vendedor (VuelaTour)» nunca: la paga VuelaTour; lo cobrado al cliente
    // sigue siendo ingreso de VuelaTour). Sin pago capturado no se resta nada
    // (la provisión murió). Fuente única `comisionesDelVuelo` (la MISMA del
    // balance por avión), en USD, y se descuentan en `comisiones_venta_usd`
    // (el campo de siempre: PDF/XLSX y panel ya lo restan en la cascada).
    // Antes de la vigencia y sin «(avión)», 0 como desde el 28-ago.
    let comisionesVenta = 0;
    // Pagos «(avión)» en MXN que no llegaron a USD (sin tc_gasto ni K): la
    // parte de ESTE avión va a `gastos_sin_tc_*` (integridad de siempre).
    let vendedorSinTcN = 0;
    let vendedorSinTcMxn = 0;
    // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): la MISMA
    // cascada EN PESOS REALES, en los MISMOS loops. Venta del avión cobrada /
    // pendiente = Σ por vuelo de round2(parte del avión USD × K del vuelo)
    // (K = tc_usd_mxn ?? oficial del día de la cotización: el del balance);
    // comisiones = `comisionesDelVuelo(...).total_mxn` con ese K (la MISMA
    // fuente del balance); gastos MXN tal cual, USD × su T.C.; reserva × el
    // oficial del cierre; otros ingresos con `filaLibroDeIngreso`.
    // `pesosSinTcUsd` = dólares que SÍ entraron al saldo USD pero no llegaron
    // a pesos (sin ningún T.C.): > 0 ⇒ el saldo en pesos está incompleto. Los
    // cobros MXN sin ningún T.C. (`cobros_sin_tc_mxn`) quedan FUERA de los
    // pesos igual que de los dólares (sin K no hay parte del avión).
    let cobradoMxn = 0;
    let pendienteMxn = 0;
    let comisionesMxn = 0;
    let pesosSinTcUsd = 0;
    // PROVISIÓN AFAC (20-oct-2026, invariante 99): la MISMA columna T
    // «PERMISO AFAC (PROVISIÓN)» del balance — tarifa USD/hr del avión ×
    // horas COBRADAS de cada vuelo (la parte de este avión), en USD y en
    // pesos con el T.C. de costos z del vuelo. Resta del saldo como en el
    // balance («utilidad antes de gastos» ya la descuenta): el reparto y el
    // balance dicen la MISMA utilidad. El costo REAL del permiso lo paga
    // VuelaTour (invariante 90): el avión aporta lo reservado.
    const tarifaAfac = pos(a.permiso_afac_usd_hr);
    let afacReservado = 0;
    let afacReservadoMxn = 0;
    let horasCobradasAvion = 0;
    // Desglose por vuelo: se llena en el MISMO loop y con los MISMOS números
    // que los agregados (misma conversión cobrosEnUsd, misma partición,
    // mismo reparto multi-avión) para que la suma del detalle cuadre exacto
    // con ingresos.*. total_usd/cobrado_usd/pendiente_usd conservan su
    // sentido de siempre (total del CLIENTE y lo cobrado BRUTO — el panel
    // los suma); en multi-avión cada fila lleva SU parte del avión (+ la
    // parte VuelaTour solo en el avión que la reporta), de modo que Σ sobre
    // los aviones participantes == los totales del vuelo. Los campos
    // *_avion_* y otros_ingresos_vuelatour_* son ADITIVOS.
    // otros_ingresos_vuelatour_usd es lo COBRADO de la parte VuelaTour
    // (Σ detalle == ingresos.otros_ingresos_vuelatour_usd: el pie del detalle
    // del panel cuadra con la card); lo COTIZADO y lo PENDIENTE van en sus
    // propios campos — antes viajaba lo cotizado bajo el nombre del cobrado
    // y el pie no cuadraba con la card.
    const detalleVuelos: Array<{
      id: string;
      folio: number | null;
      /** ADITIVOS: nombre del cliente y estado (PDF/XLSX del reparto). */
      cliente: string | null;
      estado: string;
      fecha: string | null;
      ruta: string;
      es_externo: boolean;
      total_usd: number;
      cobrado_usd: number;
      pendiente_usd: number;
      venta_avion_usd: number;
      cobrado_avion_usd: number;
      pendiente_avion_usd: number;
      otros_ingresos_vuelatour_usd: number;
      otros_ingresos_vuelatour_cotizado_usd: number;
      otros_ingresos_vuelatour_pendiente_usd: number;
      cobrado_bruto_usd: number;
      particion_fuente: 'desglose' | 'columnas' | 'sin_precio';
      particion_inconsistente: boolean;
      comision_vendedor_usd: number;
      cobrado: boolean;
      cobros_sin_tc_mxn: number;
      /**
       * ADITIVO (28-ago-2026): vuelo CANCELADO con dinero real. Su cobro
       * retenido entra como venta del avión (venta_avion_usd ==
       * cobrado_avion_usd), sin partición VuelaTour ni pendiente (en
       * multi-avión, repartido entre los aviones como la venta).
       */
      cancelado: boolean;
      /**
       * ADITIVOS (Regla B, 28-ago-2026): fracción de ESTE avión en la venta
       * del vuelo (1 en vuelos de un solo avión), si el vuelo lo volaron
       * varios aviones, cuántos de sus tramos activos voló este avión
       * ("1 de 2") y la fuente del peso (cotizacion | tramos | unico).
       */
      participacion?: number;
      multi_avion?: boolean;
      tramos_avion?: string;
      /** Ruta de los tramos VENDIDOS de este avión ("CUN→MID"), solo multi. */
      tramos_ruta_avion?: string;
      participacion_fuente?: ParticipacionAeronave['fuente'];
      /**
       * ADITIVO (29-ago-2026): presente solo cuando los cobros MXN sin TC de
       * este vuelo se convirtieron con el TC oficial de referencia del día
       * de la cotización (tc, día real del dato y fuente legible).
       */
      tc_oficial?: { tc: number; fecha_dato: string; fuente: string };
      /**
       * ADITIVOS (6-oct-2026, API 0.0.65): comisiones que ESTE avión absorbe
       * del vuelo (USD; parte de la comisión bancaria —en la vigencia— + los
       * pagos «Comisión del vendedor (avión)» desde el 0.0.74, invariante
       * 61). SOLO en vuelos que llevan COMISIONES (la vigencia, o un pago
       * «(avión)» absorbido antes de ella); Σ == `ingresos.comisiones_venta_usd`.
       * `comision_vendedor_prov_usd`: SIEMPRE 0 desde el 0.0.74 (ya no hay
       * provisión; compat de forma — retirar en un lote futuro).
       * `comision_vendedor_real_usd` (ADITIVO, 0.0.74): parte de ESTE avión
       * de los gastos «Comisión del vendedor (avión)» del vuelo, en USD (la
       * «(VuelaTour)» nunca).
       */
      comisiones_avion_usd?: number;
      comision_banco_avion_usd?: number;
      comision_vendedor_prov_usd?: number;
      comision_vendedor_real_usd?: number;
      /**
       * ADITIVOS (16-oct-2026, API 0.0.88, invariante 89): solo con la
       * migración del cierre de mes — «Viene de septiembre 2026» / «Pendiente
       * de cobro: pasará a octubre 2026 al cerrar (…)»; 'YYYY-MM'.
       */
      cierre_marca?: string | null;
      diferido_de?: string | null;
      diferido_a?: string | null;
      /**
       * ADITIVOS (18/19-oct-2026, API 0.0.94, invariante 92): la parte del
       * avión cobrada / pendiente EN PESOS (round2(USD × K)) y el K usado
       * (T.C. de la cotización o el oficial del día de la cotización); null
       * = sin ningún T.C. para pasarla a pesos.
       */
      cobrado_avion_mxn: number | null;
      pendiente_avion_mxn: number | null;
      tc_pesos: number | null;
      /**
       * PROVISIÓN AFAC (20-oct-2026, invariante 99), ADITIVOS: horas
       * cobradas de este avión en el vuelo, su provisión (tarifa × horas) en
       * USD y en pesos (× z; null = sin ningún T.C. de costos) y el z usado.
       */
      horas_cobradas_avion_hr: number;
      afac_reservado_avion_usd: number;
      afac_reservado_avion_mxn: number | null;
      tc_costos: number | null;
    }> = [];
    for (const v of ctx.vuelos) {
      // Regla B: el vuelo entra al avión si voló al menos un tramo activo
      // (factor > 0), no solo si es su avión principal.
      const part = ctx.participacionPorVuelo.get(v.id);
      const factor = part ? factorDe(part, a.id) : 0;
      if (!part || factor <= 0) continue;
      const reportaVT = avionQueReporta(part) === a.id;
      const p = particionIngresoVuelo(v);
      // TC de respaldo para cobros MXN sin TC propio: el de la cotización;
      // si no lo hay, el oficial del día de la cotización (29-ago; el mapa
      // solo trae vuelos que lo necesitan). Misma cadena que el balance.
      const tcOficialVuelo = ctx.tcOficialVuelo.get(v.id);
      // PESOS PRIMERO (20-oct-2026, invariante 99): K capturado como 3.er
      // argumento — los cobros MXN cuentan al precio en pesos.
      const conv = cobrosEnUsd(
        ctx.cobrosPorVuelo.get(v.id) ?? [],
        pos(v.tc_usd_mxn) ?? tcOficialVuelo?.tc ?? null,
        pos(v.tc_usd_mxn),
      );
      // VUELO CANCELADO (regla del cliente, 28-ago-2026): lo cobrado y NO
      // reembolsado (cargo por cancelación / anticipo retenido) es ingreso
      // real del avión — entra íntegro como venta del avión, SIN partición
      // (no se vendieron TUAS/extras/pernocta/comisión: el servicio no se
      // prestó) y SIN pendiente (la cotización ya no es una cuenta por
      // cobrar). Sus gastos entran como los de cualquier vuelo (por
      // categoría, abajo).
      const esCancelado = v.estado === 'CANCELADO';
      // Cancelado sin cobros (ni USD ni MXN sin TC): no aporta ingreso ni
      // cuenta como vuelo del reparto — sus gastos, si los hay, ya entran por
      // categoría abajo (ctx.gastos por avión del tramo). Así, en el avión
      // que reporta, detalle.vuelos == vuelos_cobrados + vuelos_pendientes
      // por construcción. FUENTE ÚNICA `retieneCobros` (13-oct-2026,
      // invariante 61): el MISMO criterio con que la «Comisión del vendedor
      // (avión)» de un CANCELADO entra al universo del balance.
      if (esCancelado && !retieneCobros(conv)) continue;
      // ---- Números del VUELO completo (misma fórmula de siempre) ----
      const cobradoAvionVuelo = esCancelado
        ? conv.total_usd
        : cobradoParteAvion(conv.total_usd, p);
      const cobradoVT = esCancelado
        ? 0
        : round2(conv.total_usd - cobradoAvionVuelo);
      const ventaAvionVuelo = esCancelado ? cobradoAvionVuelo : p.avion_usd;
      const totalVuelo = esCancelado ? conv.total_usd : p.total_usd;
      const pendienteAvionVuelo = esCancelado
        ? 0
        : Math.max(0, round2(p.avion_usd - cobradoAvionVuelo));
      const pendienteBrutoVuelo = esCancelado
        ? 0
        : Math.max(0, round2(p.total_usd - conv.total_usd));
      const pendienteVT = esCancelado
        ? 0
        : Math.max(0, round2(p.vuelatour_usd - cobradoVT));
      // ---- Parte de ESTE avión (Regla B): repartirUsd, jamás monto ×
      // factor redondeado por separado (descuadra centavos). Con un solo
      // avión la parte es el monto completo. ----
      const parte = (monto: number): number =>
        repartirUsd(monto, part).get(a.id) ?? 0;
      // COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65): misma fuente
      // única y mismos insumos que la fila del balance — cobros del vuelo,
      // gastos del pago al vendedor del vuelo (13-oct-2026, invariante 61: la
      // lectura POR VUELO, de cualquier fecha_gasto — la comisión cuenta en
      // el mes del VUELO; el util elige el lado), K (capturado ?? oficial
      // del día de la cotización), la partición, el estado (CANCELADO ⇒
      // factor 1; la «(avión)» entra en COMPLETADO o CANCELADO con cobros
      // retenidos) y la parte de ESTE avión (`parte`, repartirUsd). En USD.
      // Se calcula SIEMPRE: la fila lleva COMISIONES con `lleva_comisiones`
      // (la vigencia, o un pago «(avión)» absorbido antes de ella). K =
      // `kComisionesDeVuelo` (revisión 13-oct-2026): el MISMO del balance
      // aunque los cobros no lo hayan pedido.
      const diaVuelo = diaCancun(v.fecha_vuelo);
      const kComisiones = kComisionesDeVuelo(
        v,
        ctx.tcOficialVuelo,
        ctx.tcKComisionesVuelo,
      );
      const entradaComisiones = {
        diaVuelo,
        vigenteDesde: ctx.vigenciaComisiones,
        cobros: ctx.cobrosPorVuelo.get(v.id) ?? [],
        gastos: ctx.gastosVendedorPorVuelo.get(v.id) ?? [],
        tcVenta: kComisiones,
        particion: p,
        estado: v.estado,
        parteAvion: parte,
        participacion: factor,
      };
      const calcComisiones = comisionesDelVuelo(entradaComisiones);
      const comisionesVuelo: ComisionesDelVuelo | null =
        calcComisiones.lleva_comisiones ? calcComisiones : null;
      if (comisionesVuelo != null) {
        comisionesVenta += comisionesVuelo.total_usd;
        // Pagos «(avión)» MXN sin T.C. (ni tc_gasto ni K): no restan en USD
        // — su parte de ESTE avión se grita en `gastos_sin_tc_*`.
        if (comisionesVuelo.vendedor_usd_sin_tc_mxn > 0) {
          vendedorSinTcN += comisionesVuelo.vendedor_usd_sin_tc_n;
          vendedorSinTcMxn += comisionesVuelo.vendedor_usd_sin_tc_mxn;
        }
      }
      const ventaAvion = parte(ventaAvionVuelo);
      const cobradoAvion = parte(cobradoAvionVuelo);
      const pendienteAvion = parte(pendienteAvionVuelo);
      // ---- EN PESOS (0.0.94, invariante 92): K del balance ----
      const kPesos =
        pos(v.tc_usd_mxn) ??
        ctx.tcPesosVuelo?.get(v.id)?.tc ??
        tcOficialVuelo?.tc ??
        ctx.tcKComisionesVuelo.get(v.id)?.tc ??
        null;
      const cobradoAvionMxn =
        kPesos != null ? round2(cobradoAvion * kPesos) : null;
      const pendienteAvionMxn =
        kPesos != null ? round2(pendienteAvion * kPesos) : null;
      if (cobradoAvionMxn != null) cobradoMxn += cobradoAvionMxn;
      else pesosSinTcUsd += cobradoAvion;
      if (pendienteAvionMxn != null) pendienteMxn += pendienteAvionMxn;
      // ---- PROVISIÓN AFAC del vuelo (20-oct-2026, invariante 99) ----
      // D = parte de este avión de las horas COBRADAS del viaje (un
      // cancelado no cobra horas), con el MISMO reparto por residuo mayor
      // que el dinero (`parte`); X = tarifa × z × D en pesos y tarifa × D en
      // dólares — byte a byte las fórmulas de la fila del balance. z =
      // promedio de `tc_gasto` de los gastos MXN del vuelo sin el pago al
      // vendedor; sin ninguno, el K del vuelo (capturado ?? oficial).
      const horasCobrablesVuelo = esCancelado
        ? 0
        : (pos(v.tiempo_cobrable_hr) ?? 0);
      const horasAvion =
        horasCobrablesVuelo > 0 ? parte(horasCobrablesVuelo) : 0;
      const tcsZ = (ctx.gastosPorVuelo?.get(v.id) ?? [])
        .filter(
          (g) => g.moneda === 'MXN' && !categoriaEsPagoVendedor(g.categoria),
        )
        .map((g) => pos(g.tc_gasto))
        .filter((x): x is number => x != null);
      const zVuelo = tcsZ.length
        ? tcsZ.reduce((acc, t) => acc + t, 0) / tcsZ.length
        : kPesos;
      const afacVueloUsd =
        tarifaAfac != null && horasAvion > 0
          ? round2(tarifaAfac * horasAvion)
          : 0;
      const afacVueloMxn =
        tarifaAfac != null && horasAvion > 0
          ? zVuelo != null
            ? round2(tarifaAfac * zVuelo * horasAvion)
            : null
          : 0;
      horasCobradasAvion += horasAvion;
      afacReservado += afacVueloUsd;
      if (afacVueloMxn != null) afacReservadoMxn += afacVueloMxn;
      else pesosSinTcUsd += afacVueloUsd;
      if (comisionesVuelo != null) {
        // Las comisiones EN PESOS con el K del balance: si el de los dólares
        // es el mismo, el MISMO cálculo; si no (vuelo sin tc_usd_mxn cuyos
        // cobros no lo pedían), la MISMA fuente única con ese K — así los
        // pesos coinciden con la columna COMISIONES del balance y los
        // dólares no se mueven.
        const comisionesPesos =
          kPesos === kComisiones
            ? comisionesVuelo
            : comisionesDelVuelo({ ...entradaComisiones, tcVenta: kPesos });
        if (comisionesPesos.lleva_comisiones) {
          comisionesMxn += comisionesPesos.total_mxn;
          pesosSinTcUsd +=
            (comisionesPesos.banco_sin_pesos_usd ?? 0) +
            (comisionesPesos.vendedor_sin_pesos_usd ?? 0);
        } else {
          pesosSinTcUsd += comisionesVuelo.total_usd;
        }
      }
      // Fila del avión: su parte del avión + (solo en el que reporta) la
      // parte VuelaTour, CERRADA POR DIFERENCIA contra el total del vuelo
      // (total − parte avión de los demás), así Σ filas de todos los aviones
      // == total / cobrado / pendiente del vuelo al centavo. Con un solo
      // avión se reduce a los números de siempre.
      const totalFila = reportaVT
        ? round2(totalVuelo - ventaAvionVuelo + ventaAvion)
        : ventaAvion;
      const cobradoFila = reportaVT
        ? round2(conv.total_usd - cobradoAvionVuelo + cobradoAvion)
        : cobradoAvion;
      const pendienteFila = reportaVT
        ? Math.max(
            0,
            round2(pendienteBrutoVuelo - pendienteAvionVuelo + pendienteAvion),
          )
        : pendienteAvion;
      cobrado += cobradoAvion;
      cobradoBruto += cobradoFila;
      pendiente += pendienteAvion;
      pendienteBruto += pendienteFila;
      if (reportaVT) {
        otrosIngresosVT += cobradoVT;
        otrosIngresosVTPendiente += pendienteVT;
        // Un cancelado no aporta al bloque informativo de ingreso VuelaTour
        // (ni conteo ni desglose cotizado): nada de eso se vendió.
        if (!esCancelado && p.vuelatour_usd > 0) {
          vuelosConOtrosIngresos += 1;
          desgloseVT.tuas_usd += p.tuas_usd;
          desgloseVT.extras_usd += p.extras_usd;
          desgloseVT.pernocta_usd += p.pernocta_usd;
          desgloseVT.comision_usd += p.comision_vendedor_usd;
          desgloseVT.iva_usd += p.iva_vuelatour_usd;
        }
        // MXN sin TC no se puede repartir (no convirtió): el aviso viaja
        // una sola vez, con el avión que reporta el vuelo.
        cobrosSinTcMxn += conv.sin_tc_mxn;
        if (tcOficialVuelo != null) cobrosTcOficialCount += 1;
      }
      // CONTEOS (verificación 28-ago): SOLO en el avión que reporta el
      // vuelo — el KPI de flota del panel suma vuelos_cobrados/pendientes de
      // todos los aviones y un multi-avión contado en cada participante
      // salía DOBLE. El otro avión sigue viendo el vuelo en detalle.vuelos
      // (participacion / multi_avion) con su parte del dinero. Un cancelado
      // nunca es "pendiente" (no hay saldo por cobrar); cuenta como cobrado
      // solo si de verdad retuvo dinero.
      if (reportaVT) {
        if (esCancelado) {
          vuelosCobrados += 1; // ya se filtró arriba: siempre retuvo dinero
        } else if (v.cobrado) vuelosCobrados += 1;
        else vuelosPendientes += 1;
      }
      // Etiqueta multi-avión en la ruta: porcentaje, con quién se comparte y
      // la fuente del peso.
      let etiquetaParticipacion: string | null = null;
      if (part.multi_avion) {
        const otros = [...part.factores.keys()]
          .filter((id) => id !== a.id)
          .map((id) => ctx.matriculas.get(id) ?? '?')
          .join(', ');
        const fuente = fuenteParticipacionLabel(part.fuente);
        etiquetaParticipacion = reportaVT
          ? `${pctLabel(factor)} (tramos también en ${otros}${fuente ? `; ${fuente}` : ''})`
          : `COMPARTIDO ${pctLabel(factor)} (con ${otros}${fuente ? `; ${fuente}` : ''})`;
      }
      // Tramos VENDIDOS de este avión en el vuelo ("CUN→MID"): mismo filtro
      // que la fuente única (activos, no operativos, avión con herencia).
      const tramosRutaAvion = part.multi_avion
        ? (ctx.escalasPorVuelo.get(v.id) ?? [])
            .filter(
              (e) =>
                e.cancelada_at == null &&
                e.solo_operativa !== true &&
                e.es_ferry !== true &&
                (e.aeronave_id ?? v.aeronave_id) === a.id,
            )
            .map((e) => `${e.origen_iata ?? '?'}→${e.destino_iata ?? '?'}`)
            .join(', ')
        : '';
      detalleVuelos.push({
        id: v.id,
        folio: v.folio ?? null,
        cliente: v.cliente_id ? (ctx.clientes.get(v.cliente_id) ?? null) : null,
        estado: v.estado,
        fecha: diaCancun(v.fecha_vuelo),
        ruta: `${v.origen_iata ?? '—'} → ${v.destino_iata ?? '—'}${
          etiquetaParticipacion ? ` · ${etiquetaParticipacion}` : ''
        }`,
        es_externo: v.es_externo === true,
        // Cancelado: el total del cliente es lo retenido (la cotización ya
        // no es deuda) — así el pie del panel (Σ venta) cuadra con la card.
        total_usd: totalFila,
        cobrado_usd: cobradoFila,
        pendiente_usd: pendienteFila,
        venta_avion_usd: ventaAvion,
        cobrado_avion_usd: cobradoAvion,
        pendiente_avion_usd: pendienteAvion,
        otros_ingresos_vuelatour_usd: reportaVT ? cobradoVT : 0,
        otros_ingresos_vuelatour_cotizado_usd:
          reportaVT && !esCancelado ? p.vuelatour_usd : 0,
        otros_ingresos_vuelatour_pendiente_usd: reportaVT ? pendienteVT : 0,
        cobrado_bruto_usd: cobradoFila,
        particion_fuente: p.fuente,
        particion_inconsistente: esCancelado ? false : p.inconsistente,
        // Regla A: la comisión ya no se descuenta al avión (siempre 0; el
        // monto cotizado viaja en otros_ingresos_vuelatour.desglose).
        comision_vendedor_usd: 0,
        // Cancelado con dinero retenido = cobrado (no hay saldo pendiente);
        // los cancelados sin cobros ya no llegan aquí.
        cobrado: esCancelado || v.cobrado,
        cobros_sin_tc_mxn: reportaVT ? conv.sin_tc_mxn : 0,
        cancelado: esCancelado,
        participacion: factor,
        multi_avion: part.multi_avion,
        tramos_avion: part.multi_avion
          ? `${part.tramos_por_avion.get(a.id) ?? 0} de ${part.tramos_activos}`
          : undefined,
        tramos_ruta_avion: tramosRutaAvion || undefined,
        participacion_fuente: part.fuente,
        tc_oficial: tcOficialVuelo
          ? {
              tc: tcOficialVuelo.tc,
              fecha_dato: tcOficialVuelo.fecha_dato,
              fuente: fuenteTcLegible(tcOficialVuelo.fuente),
            }
          : undefined,
        ...(comisionesVuelo != null
          ? {
              comisiones_avion_usd: comisionesVuelo.total_usd,
              comision_banco_avion_usd: comisionesVuelo.banco_usd,
              // Siempre 0 desde el 0.0.74 (invariante 61; compat de forma).
              comision_vendedor_prov_usd: 0,
              comision_vendedor_real_usd: comisionesVuelo.vendedor_usd,
            }
          : {}),
        // REPARTO EN PESOS (0.0.94, invariante 92), ADITIVOS.
        cobrado_avion_mxn: cobradoAvionMxn,
        pendiente_avion_mxn: pendienteAvionMxn,
        tc_pesos: kPesos,
        // PROVISIÓN AFAC (20-oct-2026, invariante 99), ADITIVOS.
        horas_cobradas_avion_hr: round2(horasAvion),
        afac_reservado_avion_usd: afacVueloUsd,
        afac_reservado_avion_mxn: afacVueloMxn,
        tc_costos: zVuelo,
      });
    }
    detalleVuelos.sort(
      (x, y) =>
        // Fecha asc; los sin fecha al final. Folio como desempate estable.
        (x.fecha ?? '9999-99-99').localeCompare(y.fecha ?? '9999-99-99') ||
        (x.folio ?? 0) - (y.folio ?? 0),
    );

    // Gastos acumulados POR CATEGORÍA (misma conversión toUsd, mismo filtro
    // de avión). Los agregados directos/indirectos/permisos/sin_tc se derivan
    // de ESTE acumulador, así el desglose cuadra con ellos por construcción.
    const porCategoria = new Map<string, GastoCategoriaAcc>();
    // REEMBOLSO LIGADO (14-oct-2026, API 0.0.77, revisión F3): las partes de
    // cada gasto en pesos que ESTE avión RESTA, con el divisor de `toUsd`
    // (`tc_gasto` ?? oficial del día del gasto) y el MONTO que resta (monto −
    // TUA/extensión trasladadas: revisión del 14-oct-2026), para que un
    // REEMBOLSO_DEVOLUCION ligado a ese gasto se anule EXACTO con lo que el
    // avión cargó (abajo, en los otros ingresos; fuente única
    // `gastosLigadosDelLibro`, la misma del balance). El bucle de gastos
    // corre antes que el de ingresos; un parcial del reparto comparte el id
    // del padre (sus partes se suman).
    const partesGastoCargadas: ParteGastoCargada[] = [];
    // PANTALLA POR AVIÓN (20-oct-2026, invariante 99): gasto por gasto, con
    // el MISMO grupo, la MISMA clave y los MISMOS dólares/pesos con que se
    // sumó arriba («para saber cuáles son esos permisos, gastos indirectos y
    // directos de los que habla el Excel»). Solo con `ctx.conDetalleGastos`.
    const filasGastos: FilaGastoDetalle[] = [];
    const folioPorVuelo = new Map(
      ctx.vuelos.map((v) => [v.id, v.folio ?? null] as const),
    );
    // TUA EMBEBIDO en facturas de aeródromo (regla 7): se descuenta del costo
    // del avión ANTES de convertir y se acumula para una fila informativa
    // del detalle (transparencia: el total de la categoría ya no es la suma
    // cruda de sus gastos).
    let tuaEmbebidoUsd = 0;
    let tuaEmbebidoCount = 0;
    let extensionEmbebidaUsd = 0;
    let extensionEmbebidaCount = 0;
    // Las mismas filas informativas EN PESOS (0.0.94, invariante 92).
    let tuaEmbebidoMxn = 0;
    let extensionEmbebidaMxn = 0;
    // Clave EXCLUIDO del pago al vendedor por el eje fecha_gasto (13-oct-2026,
    // invariante 61): SOLO transparencia — ninguna suma a `gastos.*`; la
    // «(avión)» ya contó (o contará) por la lectura POR VUELO. Lado EXACTO
    // (`ladoPagoVendedor`): toda «(VuelaTour)» ⇒ la de VuelaTour; la
    // «(avión)» ⇒ otro periodo / la carga un avión / ningún avión la carga
    // (`ctx.vuelosConPagoVendedorAvion`, GLOBAL: una comisión sellada a otro
    // avión —caso i5— lleva la clave correcta).
    const vuelosDelPeriodo = new Set(ctx.vuelos.map((v) => v.id));
    const clavePagoVendedor = (g: GastoRow): string =>
      ladoPagoVendedor(g.categoria) !== 'AVION'
        ? PAGO_VENDEDOR_CLAVE_DETALLE
        : g.vuelo_id == null || !vuelosDelPeriodo.has(g.vuelo_id)
          ? PAGO_VENDEDOR_AVION_OTRO_PERIODO_CLAVE_DETALLE
          : ctx.vuelosConPagoVendedorAvion.has(g.vuelo_id)
            ? PAGO_VENDEDOR_AVION_CLAVE_DETALLE
            : PAGO_VENDEDOR_AVION_VUELATOUR_CLAVE_DETALLE;
    for (const g of ctx.gastos) {
      // Avión del gasto (Regla B, misma prioridad en todos los lectores):
      // avión del TRAMO ligado (con herencia) → avión sellado en el gasto →
      // avión principal del vuelo. Un PARCIAL del reparto manual ya trae su
      // avión decidido (el reparto gana); sin vuelo manda aeronave_id.
      const avionGasto =
        g.es_reparto_parcial || !g.vuelo_id
          ? (g.aeronave_id ?? null)
          : avionDelGasto(
              g,
              ctx.escalaPorId,
              ctx.vueloAvion.get(g.vuelo_id) ?? null,
            );
      if (avionGasto !== a.id) continue;
      // Parciales del reparto MANUAL (gasto_reparto): la categoría
      // INDIRECTO repartida SÍ cuenta (grupo INDIRECTO — esta feature ES la
      // decisión que estaba pendiente; SIN reparto sigue EXCLUIDA = empresa,
      // idéntico a antes). Un FIJO repartido va al grupo FIJO manual (suma
      // en otros_prorrateados junto al pool — mismo campo de la cascada).
      const esTuas = g.categoria === TUAS_CAT;
      // LA CATEGORÍA DE EMPRESA MANDA SOBRE EL VUELO (cliente, 11-sep-2026,
      // MISMA regla del Balance por avión y del Libro Dinero — fuente única
      // `categoriaEsDeEmpresa`): OTRO, NOMINA, GASOLINA, FIJO y VISITA son
      // gasto de VuelaTour, NO costo del avión, aunque el gasto traiga vuelo
      // o avión sellado. Antes 'OTRO' vivía en DIRECTO y un comisariato
      // ligado al vuelo restaba a la utilidad del socio mientras el balance
      // ya lo mandaba a la hoja "otros gastos" del general: los dos libros
      // del cierre no cuadraban. ÚNICA excepción: las PARTES de un reparto
      // manual (`gasto_reparto`), que sí son del avión de cada parte.
      const empresaSinReparto =
        categoriaEsDeEmpresa(g.categoria) && !g.es_reparto_parcial;
      // Pago al vendedor (invariante 31; las DOS categorías por la UNIÓN,
      // invariante 61): EXCLUIDO explícito (antes de la regla ya caía al
      // default EXCLUIDO; la rama lo hace a propósito). La «(avión)» cuenta
      // por la lectura POR VUELO (`comisionesDelVuelo`); por fecha_gasto
      // JAMÁS suma (sería doble). La clave la decide `clavePagoVendedor`.
      const esPagoVendedor = categoriaEsPagoVendedor(g.categoria);
      // PAGO DE AFAC (16-oct-2026, invariante 90; decisión 4 del cliente):
      // un PERMISO marcado lo paga VuelaTour (comprobante de los costos
      // reales por vuelo del Balance general): NO resta al avión, igual que
      // en su hoja «permisos» del balance (fuente única `esPagoAfac`) — el
      // delta balance↔reparto no cambia. Clave propia en el detalle.
      const pagoAfac = esPagoAfac(g);
      const grupo: GrupoGasto =
        // TUA pagado (regla 7): jamás costo del avión, con o sin reparto.
        esTuas || esPagoVendedor || pagoAfac
          ? 'EXCLUIDO'
          : empresaSinReparto
            ? 'EXCLUIDO'
            : // Parciales del reparto MANUAL: cuentan como "otros gastos"
              // del avión (grupo INDIRECTO) — INDIRECTO, NOMINA, GASOLINA,
              // VISITA y OTRO repartidos. FIJO repartido va a su grupo.
              g.es_reparto_parcial &&
                (g.categoria === 'INDIRECTO' ||
                  (categoriaEsDeEmpresa(g.categoria) && g.categoria !== FIJO))
              ? 'INDIRECTO'
              : g.es_reparto_parcial && g.categoria === FIJO
                ? 'FIJO'
                : DIRECTO.has(g.categoria)
                  ? 'DIRECTO'
                  : INDIRECTO.has(g.categoria)
                    ? 'INDIRECTO'
                    : PERMISO.has(g.categoria)
                      ? 'PERMISO'
                      : // FIJO se prorratea aparte; otras categorias no
                        // avion-especificas SIN reparto (p. ej. la categoría
                        // INDIRECTO) se EXCLUYEN — detalle solo transparencia.
                        'EXCLUIDO';
      // Clave separada para parciales: el detalle muestra "OTRO (repartido)"
      // y un FIJO/INDIRECTO repartido no colisiona con su versión cruda.
      const clave = esTuas
        ? TUAS_CLAVE_DETALLE
        : esPagoVendedor
          ? clavePagoVendedor(g)
          : pagoAfac
            ? PAGO_AFAC_CLAVE_DETALLE
            : g.es_reparto_parcial
              ? `${g.categoria} (repartido)`
              : g.categoria;
      const acc = porCategoria.get(clave) ?? {
        grupo,
        categoria: g.categoria,
        count: 0,
        usd: 0,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
        tc_oficial_count: 0,
        tc_oficial_mxn: 0,
        mxn: 0,
        sin_pesos_usd: 0,
      };
      // Monto EFECTIVO del avión = monto − TUA embebido (en la moneda del
      // gasto), convertido con la MISMA regla/TC de siempre (tc_gasto ??
      // oficial del día del gasto). Sin TC el gasto entero sigue en sin_tc_*
      // (nada se convierte a medias).
      // Solo se descuenta de lo que SÍ resta en el avión: un gasto EXCLUIDO
      // (TUAS, categoría de EMPRESA con vuelo) no aporta costo, así que
      // "quitarle" su TUA embebido sería una deducción fantasma en la fila
      // informativa (y doble conteo contra la hoja "otros gastos", donde el
      // gasto entra ENTERO).
      // La EXTENSIÓN DE HORARIO embebida (1-oct-2026) se descuenta igual.
      const traslados =
        grupo === 'EXCLUIDO'
          ? { tua: 0, extension: 0 }
          : trasladosEmbebidosDeGasto(g);
      const tuaEmbebido = traslados.tua;
      const extensionEmbebida = traslados.extension;
      const descontado = round2(tuaEmbebido + extensionEmbebida);
      const efectivo =
        descontado > 0
          ? { ...g, monto: round2(Number(g.monto) - descontado) }
          : g;
      const conv = this.toUsd(efectivo, ctx.tcOficialGasto);
      // EN PESOS (0.0.94, invariante 92): el MISMO monto efectivo en pesos.
      // Un MXN sin T.C. SÍ cuenta (los pesos son reales); un USD sin ningún
      // T.C. no llega a pesos y, si resta, sus dólares van a
      // `pesos_sin_tc_usd`.
      const mxnGasto = this.toMxn(efectivo, ctx.tcOficialGastoUsd);
      if (mxnGasto != null) acc.mxn += mxnGasto;
      else if (grupo !== 'EXCLUIDO' && conv !== null) {
        acc.sin_pesos_usd += conv.usd;
      }
      if (grupo !== 'EXCLUIDO' && g.moneda === 'MXN' && g.id) {
        const propioGasto = pos(g.tc_gasto);
        const divisor = propioGasto ?? ctx.tcOficialGasto.get(g.id)?.tc ?? null;
        if (divisor != null && divisor > 0) {
          partesGastoCargadas.push({
            gasto_id: g.id,
            tc: divisor,
            mxn: round2(Number(g.monto) - descontado),
            fecha: diaDeFecha(g.fecha_gasto ?? null),
            lugar:
              propioGasto != null
                ? 'T.C. del gasto'
                : 'T.C. oficial del día del gasto',
          });
        }
      }
      // La «(avión)» que carga un avión (13-oct-2026, invariante 61) tiene su
      // integridad en la lectura POR VUELO (convertida con tc_gasto ?? K;
      // `vendedor_usd_sin_tc_*` ⇒ `gastos_sin_tc_*`): por fecha_gasto no se
      // cuenta OTRA vez como «sin T.C.» ni como «T.C. oficial» (un gasto, UNA
      // vez también en los avisos).
      const integridadPorVuelo = clave === PAGO_VENDEDOR_AVION_CLAVE_DETALLE;
      if (conv === null) {
        if (!integridadPorVuelo) {
          acc.sin_tc_count += 1;
          acc.sin_tc_mxn += Number(g.monto);
        }
      } else {
        acc.count += 1;
        acc.usd += conv.usd;
        if (conv.oficial && !integridadPorVuelo) {
          acc.tc_oficial_count += 1;
          acc.tc_oficial_mxn += Number(g.monto);
        }
        if (tuaEmbebido > 0) {
          tuaEmbebidoCount += 1;
          tuaEmbebidoUsd +=
            this.toUsd({ ...g, monto: tuaEmbebido }, ctx.tcOficialGasto)?.usd ??
            0;
          tuaEmbebidoMxn +=
            this.toMxn({ ...g, monto: tuaEmbebido }, ctx.tcOficialGastoUsd) ??
            0;
        }
        if (extensionEmbebida > 0) {
          extensionEmbebidaCount += 1;
          extensionEmbebidaUsd +=
            this.toUsd({ ...g, monto: extensionEmbebida }, ctx.tcOficialGasto)
              ?.usd ?? 0;
          extensionEmbebidaMxn +=
            this.toMxn(
              { ...g, monto: extensionEmbebida },
              ctx.tcOficialGastoUsd,
            ) ?? 0;
        }
      }
      porCategoria.set(clave, acc);
      if (ctx.conDetalleGastos) {
        filasGastos.push({
          id: g.id,
          fecha: diaDeFecha(g.fecha_gasto ?? null),
          categoria: g.categoria,
          etiqueta: etiquetaCategoriaGasto(g.categoria),
          clave,
          grupo,
          concepto: g.notas?.trim() || null,
          vuelo: g.vuelo_id
            ? { id: g.vuelo_id, folio: folioPorVuelo.get(g.vuelo_id) ?? null }
            : null,
          monto: round2(Number(g.monto)),
          moneda: g.moneda,
          tc: pos(g.tc_gasto),
          descontado_mxn: descontado > 0 ? descontado : 0,
          usd: conv === null ? null : round2(conv.usd),
          mxn: mxnGasto == null ? null : round2(mxnGasto),
          // Sin T.C. propio y cruzó de moneda con el oficial de SU día:
          // MXN → USD lo dice `conv.oficial`; USD → MXN, que haya pesos.
          tc_oficial:
            pos(g.tc_gasto) == null &&
            (conv?.oficial === true ||
              (g.moneda === 'USD' && mxnGasto != null)),
          es_reparto_parcial: g.es_reparto_parcial === true,
        });
      }
    }
    const tcGastoReparto = gastosLigadosDelLibro(partesGastoCargadas);
    if (tuaEmbebidoCount > 0) {
      // Fila informativa (grupo EXCLUIDO: no suma a ningún agregado): cuánto
      // TUA embebido se le quitó al costo del avión en este periodo.
      porCategoria.set(TUA_EMBEBIDO_CLAVE_DETALLE, {
        grupo: 'EXCLUIDO',
        categoria: null,
        count: tuaEmbebidoCount,
        usd: tuaEmbebidoUsd,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
        tc_oficial_count: 0,
        tc_oficial_mxn: 0,
        mxn: tuaEmbebidoMxn,
        sin_pesos_usd: 0,
      });
    }
    if (extensionEmbebidaCount > 0) {
      // Fila informativa (grupo EXCLUIDO): cuánta extensión de horario se le
      // quitó al costo del avión en este periodo (1-oct-2026).
      porCategoria.set(EXTENSION_EMBEBIDA_CLAVE_DETALLE, {
        grupo: 'EXCLUIDO',
        categoria: null,
        count: extensionEmbebidaCount,
        usd: extensionEmbebidaUsd,
        sin_tc_count: 0,
        sin_tc_mxn: 0,
        tc_oficial_count: 0,
        tc_oficial_mxn: 0,
        mxn: extensionEmbebidaMxn,
        sin_pesos_usd: 0,
      });
    }
    let directos = 0;
    let indirectos = 0;
    let permisos = 0;
    let fijoManual = 0;
    let sinTc = 0;
    let sinTcMxn = 0;
    let tcOficialCount = 0;
    let tcOficialMxn = 0;
    // EN PESOS (0.0.94, invariante 92): los MISMOS grupos.
    let directosMxn = 0;
    let indirectosMxn = 0;
    let permisosMxn = 0;
    let fijoManualMxn = 0;
    for (const acc of porCategoria.values()) {
      if (acc.grupo === 'DIRECTO') directos += acc.usd;
      else if (acc.grupo === 'INDIRECTO') indirectos += acc.usd;
      else if (acc.grupo === 'PERMISO') permisos += acc.usd;
      else if (acc.grupo === 'FIJO') fijoManual += acc.usd;
      // EXCLUIDO no suma al balance (comportamiento original del else).
      if (acc.grupo === 'DIRECTO') directosMxn += acc.mxn;
      else if (acc.grupo === 'INDIRECTO') indirectosMxn += acc.mxn;
      else if (acc.grupo === 'PERMISO') permisosMxn += acc.mxn;
      else if (acc.grupo === 'FIJO') fijoManualMxn += acc.mxn;
      if (acc.grupo !== 'EXCLUIDO') pesosSinTcUsd += acc.sin_pesos_usd;
      sinTc += acc.sin_tc_count;
      sinTcMxn += acc.sin_tc_mxn;
      tcOficialCount += acc.tc_oficial_count;
      tcOficialMxn += acc.tc_oficial_mxn;
    }
    // Pagos del vendedor en MXN que no llegaron a USD (13-oct-2026,
    // invariante 61): la parte de ESTE avión, como cualquier gasto sin T.C.
    sinTc += vendedorSinTcN;
    sinTcMxn += vendedorSinTcMxn;
    const detalleGastos = [...porCategoria.entries()]
      .map(([categoria, acc]) => ({
        categoria,
        // ADITIVO (2-sep-2026): etiqueta humana de la categoría BASE con el
        // mismo sufijo de la clave (" (repartido)", la nota de TUAS). La
        // clave `categoria` sigue siendo el código crudo — nadie la compara
        // contra esta etiqueta; la fila informativa del TUA embebido la
        // conserva tal cual.
        etiqueta:
          acc.categoria == null
            ? categoria
            : categoria.startsWith(acc.categoria)
              ? `${etiquetaCategoriaGasto(acc.categoria)}${categoria.slice(acc.categoria.length)}`
              : etiquetaCategoriaGasto(acc.categoria),
        grupo: acc.grupo,
        count: acc.count,
        usd: round2(acc.usd),
        // ADITIVO (0.0.94, invariante 92): la categoría EN PESOS.
        mxn: round2(acc.mxn),
        sin_tc_count: acc.sin_tc_count,
        sin_tc_mxn: round2(acc.sin_tc_mxn),
        // ADITIVOS (29-ago): de `count`, los convertidos con TC oficial.
        tc_oficial_count: acc.tc_oficial_count,
        tc_oficial_mxn: round2(acc.tc_oficial_mxn),
      }))
      .sort((x, y) => y.usd - x.usd);

    // Reserva de overhaul DEL PERIODO = horas voladas del periodo × tarifa por
    // hora (sumada por motor: bimotor = 2 filas). Antes se multiplicaba por el
    // acumulado DE POR VIDA, restando lo mismo (y creciente) cada mes.
    // FUENTE ÚNICA `common/reserva-overhaul.util` (19-oct-2026, API 0.0.98,
    // invariante 96): la MISMA aritmética que la fila «(−) RESERVA DE
    // OVERHAUL» del balance por avión y del general.
    const horasPeriodo = round2(ctx.horasPorAvion.get(a.id) ?? 0);
    const tarifaReserva = tarifaReservaOverhaul(
      ctx.reservas,
      a.id,
    ).usd_por_hora;
    const reservaOverhaul = reservaOverhaulPeriodoUsd(
      horasPeriodo,
      tarifaReserva,
    );
    const reservaIncompleta = reservaOverhaulIncompleta(
      horasPeriodo,
      tarifaReserva,
    );
    // EN PESOS (0.0.94, invariante 92): la reserva publicada (USD) × el T.C.
    // oficial del cierre del periodo; sin él, sus dólares no llegan a pesos.
    const tcReserva = ctx.tcReserva ?? null;

    // ===== OTROS INGRESOS DEL AVIÓN (13-oct-2026, API 0.0.75, invariante
    // 67) ===== Ingresos de RESULTADO registrados en Ingresos con ESTE avión
    // (reembolso de su servicio, venta de una pieza suya…): SUMAN al saldo,
    // netos de la comisión bancaria. USD ⇒ el neto; MXN ⇒ neto ÷ (T.C.
    // propio del ingreso ?? T.C. del gasto LIGADO ?? oficial del día de su
    // `fecha`). Sin T.C. NO suma (va a `otros_ingresos_avion_sin_tc_mxn`):
    // jamás se inventa uno. Cada usd se redondea a centavos y el total =
    // round2(Σ). Es la MISMA conversión del balance (hoja «Otros ingresos») y
    // del tablero: decisión del cliente del 14-oct-2026, fuente única
    // `usdDeIngresoAvion` (ING-4 = 2,746.70 en los dos libros); un reembolso
    // ligado a un gasto que este avión resta usa el T.C. de ese gasto para
    // anularse con él. `tc_aviso` (revisión del 14-oct-2026, AL FINAL de la
    // línea): los MISMOS avisos de la hoja del balance
    // (`avisosReembolsoGasto`: su gasto no lo carga este avión, trae T.C.
    // propio distinto o excede lo cargado), unidos con « · »; null sin aviso.
    let otrosIngresosAvion = 0;
    let otrosIngresosSinTcMxn = 0;
    let otrosIngresosTcOficialCount = 0;
    // EN PESOS (0.0.94, invariante 92): el NETO en pesos de la fila del
    // libro (`filaLibroDeIngreso`, la MISMA de la hoja «Otros ingresos» del
    // balance): MXN tal cual (con o sin T.C.), USD × su T.C. propio.
    let otrosIngresosMxn = 0;
    const detalleOtrosIngresos: Array<{
      id: string;
      clave: string;
      fecha: string;
      categoria: string;
      categoria_etiqueta: string;
      concepto: string;
      moneda: 'MXN' | 'USD';
      monto: number;
      comision: number | null;
      neto: number;
      usd: number | null;
      /** ADITIVO (0.0.94, invariante 92): neto EN PESOS; null = USD sin T.C. */
      mxn: number | null;
      tc: number | null;
      tc_oficial: boolean;
      /** ADITIVO al final (14-oct-2026, API 0.0.77): de dónde salió el T.C. */
      tc_origen: OrigenTcIngreso | null;
      /** ADITIVO al final (revisión del 14-oct-2026): por qué no se anula con su gasto. */
      tc_aviso: string | null;
    }> = [];
    for (const i of ctx.ingresosAvion ?? []) {
      if (!ingresoEsDelAvion(i)) continue;
      const monto = Number(i.monto) || 0;
      const com = Number(i.comision_monto) > 0 ? Number(i.comision_monto) : 0;
      const neto = round2(monto - com);
      const gastoLigado = i.gasto_id
        ? (tcGastoReparto.get(i.gasto_id) ?? null)
        : null;
      const conv = usdDeIngresoAvion(i, {
        oficialDelDia: ctx.tcOficialIngreso?.get(i.id) ?? null,
        gastoLigado,
      });
      const avisos = avisosReembolsoGasto(
        i,
        etiquetaIngreso(i.folio),
        conv,
        gastoLigado,
      );
      const usd = conv.usd;
      const tcOficialUsado = conv.origen === 'OFICIAL_DEL_DIA';
      if (usd == null) {
        otrosIngresosSinTcMxn += neto;
      } else {
        otrosIngresosAvion += usd;
        if (tcOficialUsado) otrosIngresosTcOficialCount += 1;
      }
      const mxnIngreso = filaLibroDeIngreso(i)?.remanente_mxn ?? null;
      if (mxnIngreso != null) otrosIngresosMxn += mxnIngreso;
      else if (usd != null) pesosSinTcUsd += usd;
      detalleOtrosIngresos.push({
        id: i.id,
        clave: etiquetaIngreso(i.folio),
        fecha: i.fecha,
        categoria: i.categoria,
        categoria_etiqueta: etiquetaCategoriaIngreso(i.categoria),
        concepto: [
          i.descripcion?.trim() || null,
          i.cliente_nombre?.trim() || i.pagador?.trim() || null,
        ]
          .filter(Boolean)
          .join(' · '),
        moneda: i.moneda,
        monto: round2(monto),
        comision: com > 0 ? round2(com) : null,
        neto,
        usd,
        mxn: mxnIngreso,
        tc: conv.tc,
        tc_oficial: tcOficialUsado,
        tc_origen: conv.origen,
        tc_aviso: avisos.length > 0 ? avisos.join(' · ') : null,
      });
    }

    // Disciplina v1.3 (redondear ANTES de sumar): el saldo se calcula con los
    // MISMOS componentes redondeados que se publican, así la cascada del PDF
    // cuadra al centavo (antes difería 1-3 ¢ por decimales largos de TC).
    const cobradoR = round2(cobrado);
    const comisionesR = round2(comisionesVenta);
    const directosR = round2(directos);
    const indirectosR = round2(indirectos);
    const permisosR = round2(permisos);
    // Pool automático + FIJO repartido a mano hacia ESTE avión: mismo campo
    // de la cascada (otros_prorrateados) — el PDF/XLSX no cambia de shape.
    const otrosR = round2(ctx.otrosPorAvion + fijoManual);
    const reservaR = round2(reservaOverhaul);
    // PROVISIÓN AFAC (20-oct-2026, invariante 99): resta como en el balance.
    const afacR = round2(afacReservado);
    // + los otros ingresos del avión (invariante 67; 0 sin ingresos).
    const otrosIngresosAvionR = round2(otrosIngresosAvion);
    // LA CASCADA DEL BALANCE (20-oct-2026, invariante 99; decisión del
    // cliente: «que cuadren»): saldo = venta cobrada − comisiones − directos
    // − indirectos − permisos − fijos prorrateados − PROVISIÓN AFAC + otros
    // ingresos. La RESERVA DE OVERHAUL YA NO RESTA AQUÍ (como en el balance
    // desde el 0.0.98): se informa, y solo al socio que lo pidió se le
    // descuenta SU parte (`descontar_reserva_overhaul`, abajo).
    const saldo = round2(
      cobradoR -
        comisionesR -
        directosR -
        indirectosR -
        permisosR -
        otrosR -
        afacR +
        otrosIngresosAvionR,
    );

    // ===== EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92) =====
    // La MISMA cascada con los MISMOS componentes redondeados que se
    // publican (disciplina v1.3): saldo en pesos = cobrado − comisiones −
    // directos − indirectos − permisos − otros − reserva + otros ingresos.
    const cobradoMxnR = round2(cobradoMxn);
    const comisionesMxnR = round2(comisionesMxn);
    const directosMxnR = round2(directosMxn);
    const indirectosMxnR = round2(indirectosMxn);
    const permisosMxnR = round2(permisosMxn);
    const otrosMxnR = round2((ctx.otrosPorAvionMxn ?? 0) + fijoManualMxn);
    const reservaMxnR = tcReserva != null ? round2(reservaR * tcReserva) : 0;
    // La reserva ya no entra al saldo: sus dólares sin T.C. solo dejan
    // incompleta la PARTE de los socios que la descuentan (abajo).
    const reservaSinPesos = tcReserva == null && reservaR > 0;
    const afacMxnR = round2(afacReservadoMxn);
    const otrosIngresosAvionMxnR = round2(otrosIngresosMxn);
    pesosSinTcUsd += ctx.otrosPorAvionSinPesosUsd ?? 0;
    const saldoMxn = round2(
      cobradoMxnR -
        comisionesMxnR -
        directosMxnR -
        indirectosMxnR -
        permisosMxnR -
        otrosMxnR -
        afacMxnR +
        otrosIngresosAvionMxnR,
    );

    // Reparto por residuo mayor (en centavos): con porcentajes que suman 100,
    // la suma de las partes da EXACTO el saldo (antes 50/50 de 100.01 daba
    // 50.01 + 50.01 = 100.02). Con ≠100% se reparte proporcional tal cual y
    // el badge/advertencia de porcentajes lo delata. EN PESOS (0.0.94) el
    // MISMO reparto sobre el saldo en pesos (`centavosPorResiduoMayor`).
    const vigentes = ctx.socios.filter(
      (s) =>
        s.aeronave_id === a.id &&
        s.vigente_desde <= ctx.periodo.hasta &&
        (s.vigente_hasta === null || s.vigente_hasta >= ctx.periodo.desde),
    );
    const pcts = vigentes.map((s) => Number(s.porcentaje));
    const repartoPct = pcts.reduce((acc, p) => acc + p, 0);
    const centsUsd = centavosPorResiduoMayor(pcts, saldo);
    const centsMxn = centavosPorResiduoMayor(pcts, saldoMxn);
    // RESERVA DE OVERHAUL POR SOCIO (20-oct-2026, invariante 99): la parte
    // de cada socio (reserva × su %, residuo mayor) se INFORMA siempre —
    // «cuánto es lo que debe guardar cada socio»— y, solo si la fila de
    // `aeronave_socio` lo pide (`descontar_reserva_overhaul`), se le
    // DESCUENTA de su utilidad: VuelaTour la retiene para el overhaul
    // (`reserva_retenida_*`). Sin la bandera, el socio recibe su parte del
    // saldo completa y el dato de lo que debe guardar.
    const centsReservaUsd = centavosPorResiduoMayor(pcts, reservaR);
    const centsReservaMxn = centavosPorResiduoMayor(pcts, reservaMxnR);
    let reservaRetenidaUsd = 0;
    let reservaRetenidaMxn = 0;
    const reparto = vigentes.map((s, i) => {
      const descuenta = s.descontar_reserva_overhaul === true;
      const utilidadUsd = centsUsd[i] / 100;
      const utilidadMxn = centsMxn[i] / 100;
      const reservaUsd = centsReservaUsd[i] / 100;
      const reservaMxn = centsReservaMxn[i] / 100;
      if (descuenta) {
        reservaRetenidaUsd += reservaUsd;
        reservaRetenidaMxn += reservaMxn;
        if (reservaSinPesos) pesosSinTcUsd += reservaUsd;
      }
      return {
        socio_id: s.socio_id,
        socio_nombre: ctx.nombres.get(s.socio_id) ?? 'Socio',
        porcentaje: pcts[i],
        // Lo que se le ENTREGA (neto de su reserva si la descuenta).
        monto_usd: round2(utilidadUsd - (descuenta ? reservaUsd : 0)),
        // ADITIVO (0.0.94, invariante 92): lo que le toca EN PESOS.
        monto_mxn: round2(utilidadMxn - (descuenta ? reservaMxn : 0)),
        // ADITIVOS (20-oct-2026, invariante 99): su parte del saldo ANTES de
        // la reserva, su parte de la reserva y si se le descuenta.
        utilidad_usd: utilidadUsd,
        utilidad_mxn: utilidadMxn,
        reserva_usd: reservaUsd,
        reserva_mxn: reservaMxn,
        descuenta_reserva: descuenta,
      };
    });
    const reservaRetenidaUsdR = round2(reservaRetenidaUsd);
    const reservaRetenidaMxnR = round2(reservaRetenidaMxn);

    return {
      aeronave: { id: a.id, matricula: a.matricula, modelo: a.modelo },
      ingresos: {
        // VENTA DEL AVIÓN cobrada (regla 6): mismo nombre de siempre — el
        // PDF/XLSX/panel no cambian y la cascada saldo = cobrado − comisiones
        // − gastos − reserva conserva su fórmula; solo cambia lo que entra.
        cobrado_usd: cobradoR,
        // ADITIVOS: bruto cobrado al cliente y la parte de VuelaTour
        // (cobrado_bruto == cobrado + otros_ingresos_vuelatour al centavo).
        cobrado_bruto_usd: round2(cobradoBruto),
        otros_ingresos_vuelatour_usd: round2(otrosIngresosVT),
        otros_ingresos_vuelatour_pendiente_usd: round2(
          otrosIngresosVTPendiente,
        ),
        // COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65): Σ de las
        // comisiones que absorbe: la parte de la bancaria (vuelos de la
        // vigencia) + los pagos «Comisión del vendedor (avión)» desde el
        // 0.0.74 (invariante 61, en cualquier fecha: puede ser ≠ 0 en un mes
        // anterior a la regla). Resta en `saldo_disponible_usd` (la cascada
        // de siempre) y por lo tanto en el reparto, las utilidades por mes y
        // la cuenta corriente.
        comisiones_venta_usd: comisionesR,
        // Parte del AVIÓN aún no cobrada (coherente con la cascada: es lo que
        // le falta al avión para repartir). El nombre se conserva (PDF/XLSX/
        // panel); la deuda COMPLETA del cliente va ADITIVA abajo.
        pendiente_cobro_usd: round2(pendiente),
        // Deuda completa del cliente (avión + TUAS/extras/pernocta/comisión
        // + IVA) = Σ detalle.vuelos[].pendiente_usd; misma fórmula que el
        // pre-cierre (en multi-avión, la parte de este avión).
        pendiente_bruto_usd: round2(pendienteBruto),
        // Conteos SOLO del avión que reporta cada vuelo (multi-avión: un
        // vuelo, un conteo — el KPI de flota los suma por avión). En el
        // otro avión participante detalle.vuelos.length puede ser mayor.
        vuelos_cobrados: vuelosCobrados,
        vuelos_pendientes: vuelosPendientes,
        cobros_sin_tc_mxn: round2(cobrosSinTcMxn),
        // ADITIVO (29-ago): vuelos (contados en el avión que reporta) cuyos
        // cobros MXN sin TC entraron con el TC oficial del día de la
        // cotización — ya DENTRO de cobrado_usd; cobros_sin_tc_mxn solo
        // conserva lo que ni así convirtió.
        cobros_tc_oficial_count: cobrosTcOficialCount,
        // ADITIVOS y SIEMPRE (13-oct-2026, API 0.0.75, invariante 67): los
        // ingresos asignados a este avión, netos de comisión, en USD — YA
        // dentro de `saldo_disponible_usd` (y de ahí el reparto, las
        // utilidades por mes y la cuenta corriente); NO se mezclan con la
        // venta (`cobrado_usd`). Los MXN sin T.C. no suman; cuántos usaron
        // el T.C. oficial de su día.
        otros_ingresos_avion_usd: otrosIngresosAvionR,
        otros_ingresos_avion_sin_tc_mxn: round2(otrosIngresosSinTcMxn),
        otros_ingresos_avion_tc_oficial_count: otrosIngresosTcOficialCount,
        // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92),
        // ADITIVOS: venta del avión cobrada, comisiones, pendiente y otros
        // ingresos del avión EN PESOS (lo que se transfiere a los socios).
        cobrado_mxn: cobradoMxnR,
        comisiones_venta_mxn: comisionesMxnR,
        pendiente_cobro_mxn: round2(pendienteMxn),
        otros_ingresos_avion_mxn: otrosIngresosAvionMxnR,
      },
      horas_voladas_hr: horasPeriodo,
      gastos: {
        directos_usd: directosR,
        indirectos_usd: indirectosR,
        permisos_usd: permisosR,
        otros_prorrateados_usd: otrosR,
        gastos_sin_tc_count: sinTc,
        gastos_sin_tc_mxn: round2(sinTcMxn),
        // ADITIVO (29-ago): gastos MXN sin tc_gasto convertidos con el TC
        // oficial del día del gasto (ya dentro de los montos de arriba; NO
        // están en gastos_sin_tc_*). Σ detalle.gastos_por_categoria.
        gastos_tc_oficial: {
          count: tcOficialCount,
          monto_mxn: round2(tcOficialMxn),
        },
        // ADITIVOS (0.0.94, invariante 92): los mismos grupos EN PESOS.
        directos_mxn: directosMxnR,
        indirectos_mxn: indirectosMxnR,
        permisos_mxn: permisosMxnR,
        otros_prorrateados_mxn: otrosMxnR,
      },
      // RESERVA DE OVERHAUL (20-oct-2026, invariante 99): INFORMATIVA — ya no
      // resta del saldo (como en el balance desde el 0.0.98); se reparte por
      // socio en `reparto[].reserva_*` y solo se descuenta a quien lo pidió.
      reserva_overhaul_usd: reservaR,
      reserva_overhaul_incompleta: reservaIncompleta,
      saldo_disponible_usd: saldo,
      // ADITIVOS (0.0.94, invariante 92): reserva y saldo EN PESOS, y los
      // dólares que SÍ entraron al saldo USD pero no llegaron a pesos (> 0 ⇒
      // el saldo en pesos está incompleto: el panel y el PDF lo avisan).
      reserva_overhaul_mxn: reservaMxnR,
      saldo_disponible_mxn: saldoMxn,
      pesos_sin_tc_usd: round2(pesosSinTcUsd),
      // ADITIVOS (20-oct-2026, invariante 99): la PROVISIÓN AFAC que resta
      // del saldo (como la columna T del balance) y la reserva que VuelaTour
      // RETIENE de los socios que la descuentan (Σ `reparto[].reserva_*` de
      // los que llevan `descuenta_reserva`).
      afac_reservado_usd: afacR,
      afac_reservado_mxn: afacMxnR,
      reserva_retenida_usd: reservaRetenidaUsdR,
      reserva_retenida_mxn: reservaRetenidaMxnR,
      reparto,
      reparto_porcentaje_total: round2(repartoPct),
      // Desglose ADITIVO del avión (vuelo por vuelo y gasto por categoría).
      // Sale de los mismos loops de arriba: sus sumas cuadran con los
      // agregados. El PDF/XLSX del reparto no lo consume (mapea campos
      // específicos en buildRepartoPayload).
      detalle: {
        vuelos: detalleVuelos,
        gastos_por_categoria: detalleGastos,
        // PANTALLA POR AVIÓN (invariante 99): solo si se pidió.
        ...(ctx.conDetalleGastos
          ? {
              gastos: [...filasGastos].sort(
                (x, y) =>
                  (x.fecha ?? '9999-99-99').localeCompare(
                    y.fecha ?? '9999-99-99',
                  ) || x.id.localeCompare(y.id),
              ),
            }
          : {}),
        reserva: {
          horas_hr: horasPeriodo,
          tarifa_hora_usd: round2(tarifaReserva),
          monto_usd: round2(reservaOverhaul),
          // ADITIVOS (0.0.94, invariante 92): la reserva EN PESOS y el T.C.
          // oficial del cierre del periodo con que se pasó (null = sin dato).
          monto_mxn: reservaMxnR,
          tc: tcReserva,
        },
        // PROVISIÓN AFAC (20-oct-2026, invariante 99): tarifa de la ficha
        // del avión × horas COBRADAS del periodo (la parte de este avión).
        afac: {
          tarifa_usd_hr: tarifaAfac,
          horas_cobradas_hr: round2(horasCobradasAvion),
          monto_usd: afacR,
          monto_mxn: afacMxnR,
        },
        // Composición de la parte VuelaTour de este avión (alimenta el
        // bloque global `otros_ingresos_vuelatour` de compute()).
        // comision_usd es ADITIVO (Regla A): comisión del vendedor cotizada.
        otros_ingresos_vuelatour: {
          vuelos: vuelosConOtrosIngresos,
          desglose: {
            tuas_usd: round2(desgloseVT.tuas_usd),
            extras_usd: round2(desgloseVT.extras_usd),
            pernocta_usd: round2(desgloseVT.pernocta_usd),
            comision_usd: round2(desgloseVT.comision_usd),
            iva_usd: round2(desgloseVT.iva_usd),
          },
        },
        // ADITIVO y SIEMPRE (13-oct-2026, API 0.0.75, invariante 67): un
        // renglón por ingreso asignado a este avión ([] sin ingresos); Σ usd
        // no nulos == `ingresos.otros_ingresos_avion_usd` (salvo el redondeo
        // final del total).
        otros_ingresos_avion: detalleOtrosIngresos,
      },
    };
  }

  /**
   * Convierte un gasto a USD. null = no se pudo (MXN sin tc_gasto NI TC
   * oficial del día del gasto). `oficial` = true cuando el TC vino del
   * respaldo oficial (regla del cliente, 29-ago-2026) — solo para contarlo
   * en gastos_tc_oficial; el monto entra igual que uno con TC capturado.
   */
  private toUsd(
    g: GastoRow,
    tcOficialGasto: Map<string, TipoCambioDetalle>,
  ): { usd: number; oficial: boolean } | null {
    if (g.moneda === 'USD') return { usd: Number(g.monto), oficial: false };
    const propio = pos(g.tc_gasto);
    if (propio != null) {
      return { usd: Number(g.monto) / propio, oficial: false };
    }
    // El mapa solo trae gastos MXN sin tc_gasto (resolverTcOficial); un
    // parcial del reparto manual comparte el id (y la fecha) del padre.
    const oficial = tcOficialGasto.get(g.id)?.tc;
    if (oficial != null && oficial > 0) {
      return { usd: Number(g.monto) / oficial, oficial: true };
    }
    return null;
  }

  /**
   * REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92): un gasto
   * EN PESOS. MXN ⇒ su monto tal cual (con o sin T.C.: los pesos son
   * reales); USD ⇒ round2(monto × (`tc_gasto` ?? T.C. oficial del día del
   * gasto)). null = USD sin ningún T.C. (sus dólares, si restan, van a
   * `pesos_sin_tc_usd`). Un parcial del reparto manual comparte el id (y la
   * fecha) del padre.
   */
  private toMxn(
    g: GastoRow,
    tcOficialGastoUsd: ReadonlyMap<string, TipoCambioDetalle> | undefined,
  ): number | null {
    const monto = Number(g.monto);
    if (!Number.isFinite(monto)) return null;
    if (g.moneda !== 'USD') return monto;
    const tc = pos(g.tc_gasto) ?? tcOficialGastoUsd?.get(g.id)?.tc ?? null;
    return tc != null && tc > 0 ? round2(monto * tc) : null;
  }

  /**
   * TC OFICIAL de respaldo (regla del cliente, 29-ago-2026): por VUELO (sin
   * tc_usd_mxn → día Cancún de la cotización: fecha_solicitud, si no
   * fecha_vuelo) y por GASTO (MXN sin tc_gasto → día del gasto, columna
   * date). Un solo lote de días para ambos: cada día se consulta UNA vez
   * (`tcOficialPorDias`). Devuelve el DETALLE (tc, fuente, día real del
   * dato) para que el reparto diga de dónde salió cada conversión.
   */
  private async resolverTcOficial(
    vuelos: ReadonlyArray<
      Pick<VueloRow, 'id' | 'tc_usd_mxn' | 'fecha_solicitud' | 'fecha_vuelo'>
    >,
    gastos: ReadonlyArray<
      Pick<GastoRow, 'id' | 'moneda' | 'tc_gasto' | 'fecha_gasto'>
    >,
    // Ingresos ASIGNADOS a un avión (13-oct-2026, invariante 67): los MXN
    // sin T.C. propio piden el oficial del día de su `fecha` (date), en el
    // MISMO lote. Los otros llamadores no los mandan (mapa vacío).
    ingresos: ReadonlyArray<
      Pick<IngresoParaLibro, 'id' | 'moneda' | 'tc_usd_mxn' | 'fecha'>
    > = [],
    // REPARTO EN PESOS (18/19-oct-2026, API 0.0.94, invariante 92),
    // OPCIONAL (los demás llamadores no lo mandan: mismos días de siempre):
    // gastos en DÓLARES sin tc_gasto (el oficial de su día los pasa a
    // pesos ⇒ `gastoUsd`) y días EXTRA (la reserva ⇒ `porDia`), en el MISMO
    // lote — un día, una consulta. Los ingresos en dólares NO piden oficial:
    // sus pesos salen de `filaLibroDeIngreso` (su T.C. propio, como el
    // balance; el CHECK de la BD exige T.C. a un USD de resultado).
    extra: {
      gastosUsd?: ReadonlyArray<
        Pick<GastoRow, 'id' | 'moneda' | 'tc_gasto' | 'fecha_gasto'>
      >;
      dias?: ReadonlyArray<string>;
    } = {},
  ): Promise<{
    vuelo: Map<string, TipoCambioDetalle>;
    gasto: Map<string, TipoCambioDetalle>;
    ingreso: Map<string, TipoCambioDetalle>;
    /** gasto.id → oficial del día de cada gasto USD sin tc_gasto (0.0.94). */
    gastoUsd: Map<string, TipoCambioDetalle>;
    /** Todos los días resueltos (incluidos los extra), con dato. */
    porDia: Map<string, TipoCambioDetalle>;
  }> {
    const diaVuelo = new Map<string, string>();
    for (const v of vuelos) {
      if (pos(v.tc_usd_mxn) != null) continue;
      const dia = diaCancun(v.fecha_solicitud ?? v.fecha_vuelo);
      if (dia) diaVuelo.set(v.id, dia);
    }
    const diaGasto = new Map<string, string>();
    for (const g of gastos) {
      if (g.moneda !== 'MXN' || pos(g.tc_gasto) != null) continue;
      const dia = diaDeFecha(g.fecha_gasto ?? null);
      if (dia) diaGasto.set(g.id, dia);
    }
    const diaIngreso = new Map<string, string>();
    for (const i of ingresos) {
      // Fuente única del día (14-oct-2026, API 0.0.77): la MISMA del balance.
      const dia = diaTcOficialIngreso(i);
      if (dia) diaIngreso.set(i.id, dia);
    }
    const diaGastoUsd = new Map<string, string>();
    for (const g of extra.gastosUsd ?? []) {
      if (g.moneda !== 'USD' || pos(g.tc_gasto) != null) continue;
      const dia = diaDeFecha(g.fecha_gasto ?? null);
      if (dia) diaGastoUsd.set(g.id, dia);
    }
    const porDia = await this.tcOficialPorDias([
      ...diaVuelo.values(),
      ...diaGasto.values(),
      ...diaIngreso.values(),
      ...diaGastoUsd.values(),
      ...(extra.dias ?? []),
    ]);
    const vuelo = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaVuelo) {
      const det = porDia.get(dia);
      if (det) vuelo.set(id, det);
    }
    const gasto = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaGasto) {
      const det = porDia.get(dia);
      if (det) gasto.set(id, det);
    }
    const ingreso = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaIngreso) {
      const det = porDia.get(dia);
      if (det) ingreso.set(id, det);
    }
    const gastoUsd = new Map<string, TipoCambioDetalle>();
    for (const [id, dia] of diaGastoUsd) {
      const det = porDia.get(dia);
      if (det) gastoUsd.set(id, det);
    }
    return { vuelo, gasto, ingreso, gastoUsd, porDia };
  }

  /**
   * TC oficial de referencia por DÍA (open.er-api diario / BCE-frankfurter
   * histórico, vía `TipoCambioService.oficialDetallePara`) — mismo patrón
   * que `tcOficialPorVuelos` del balance: todas las promesas se crean
   * primero (un día = una consulta) y se esperan con concurrencia acotada
   * (~5) para no saturar a los proveedores. `oficialDetallePara` nunca
   * lanza; el catch es defensa: un día sin dato → sin respaldo (el monto
   * sigue en sin_tc_*, jamás se inventa un número ni se rompe el reparto).
   */
  private async tcOficialPorDias(
    dias: Iterable<string>,
  ): Promise<Map<string, TipoCambioDetalle>> {
    const MAX_CONCURRENTES = 5;
    let activos = 0;
    const cola: Array<() => void> = [];
    const adquirir = (): Promise<void> =>
      new Promise<void>((res) => {
        if (activos < MAX_CONCURRENTES) {
          activos += 1;
          res();
        } else {
          cola.push(() => {
            activos += 1;
            res();
          });
        }
      });
    const liberar = (): void => {
      activos -= 1;
      const siguiente = cola.shift();
      if (siguiente) siguiente();
    };
    const promesas = new Map<string, Promise<TipoCambioDetalle | null>>();
    for (const dia of new Set(dias)) {
      promesas.set(
        dia,
        (async (): Promise<TipoCambioDetalle | null> => {
          await adquirir();
          try {
            return await this.tipoCambio.oficialDetallePara(dia);
          } catch {
            return null;
          } finally {
            liberar();
          }
        })(),
      );
    }
    const out = new Map<string, TipoCambioDetalle>();
    for (const [dia, p] of promesas) {
      const det = await p;
      if (det != null && det.tc > 0) out.set(dia, det);
    }
    return out;
  }

  /**
   * Checklist de PRE-CIERRE: todo lo que dejaría el cierre mensual incompleto
   * o mentiroso, detectado por el sistema en vez de cazado a mano. La meta es
   * que el empleado solo supervise: si `listo` es true, se puede cerrar.
   *
   * `rol` = quién pregunta (el controller lo pasa). Los items de las
   * CUENTAS DE LOS SOCIOS (nombres y montos de cada socio) solo salen para
   * `ROLES_PAGOS_SOCIOS_LECTURA`: ningún endpoint le da a un rol más de lo
   * que le dan los específicos (COORDINADOR recibe 403 en `GET socios`, en
   * `GET pagos` y en `GET /profit-sharing`). Sin `rol` ⇒ se omiten (falla
   * cerrado).
   */
  async preCierre(qPedido: ProfitSharingQuery, rol?: Rol) {
    const q = await this.periodoOficial(qPedido);
    const sb = this.supabase.service;
    const desdeTs = `${q.desde}T00:00:00-05:00`;
    const hastaTs = `${q.hasta}T23:59:59-05:00`;
    // CIERRE DE MES (16-oct-2026, invariante 89): completados y cancelados
    // (el DINERO del cierre: cobros pendientes, cobrados de más, sin gasto de
    // operaciones, facturas, inversos) por `fecha_contable`; los vuelos SIN
    // COMPLETAR y todo lo operativo (tacos, tramos, grupos) por
    // `fecha_vuelo`. Sin la migración, todo por `fecha_vuelo` (0.0.87).
    const contable = await cierreMesDisponible(sb);
    const colDinero = colPeriodoContable(contable);
    // Marca «Pago de AFAC» (invariante 90): con la migración, un PERMISO
    // marcado no es «sin avión» (lo paga VuelaTour) ni «sin T.C.».
    const afacDisponible = await afacRealDisponible(sb);

    const [
      pendRes,
      completadosRes,
      canceladosRes,
      gastosRes,
      movRes,
      revRes,
      legsRes,
      sobresRes,
      gruposRes,
      omitRes,
    ] = await Promise.all([
      // Vuelos del periodo que NO llegaron a COMPLETADO ni CANCELADO.
      sb
        .from('vuelo')
        // aeronave_id (13-oct-2026): matrícula del item
        // vuelos_cobrados_sin_factura (invariante 60).
        .select('id, folio, estado, fecha_vuelo, aeronave_id')
        .in('estado', [
          'SOLICITUD',
          'COTIZADO',
          'RESERVA',
          'CONFIRMADO',
          'EN_VUELO',
        ])
        // eje REAL a propósito (invariante 89): vuelos SIN completar (operativo: el cierre los exige completos)
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs)
        .order('fecha_vuelo', { ascending: true }),
      // Completados del periodo (para cobros pendientes/parciales y para la
      // partición venta avión / VuelaTour — aviso extras_sin_desglose).
      sb
        .from('vuelo')
        // fecha_vuelo/fecha_solicitud: día del TC oficial de respaldo
        // (29-ago) para cobros MXN sin TC de cotizaciones sin tc_usd_mxn.
        .select(
          // grupo_id (4-sep-2026): folio del grupo ADITIVO en cobros_pendientes.
          // aeronave_id/es_externo (5-oct-2026): universo de
          // vuelos_sin_gasto_operaciones (solo vuelos PROPIOS con avión).
          // cotizacion_abierta (14-oct-2026, invariante 77): «Cobrado de más»
          // no avisa en una cotización abierta.
          // pase_abordar/extras (15-oct-2026): renglones inversos
          // tua_pagada_sin_cobrar / transporte_pagado_sin_cotizar.
          `id, folio, piloto_id, cliente_id, grupo_id, aeronave_id, es_externo, monto_total_usd, tc_usd_mxn, fecha_vuelo, fecha_solicitud, cobrado, cotizacion_abierta, subtotal_vuelo_usd, ajuste_final_usd, comision_vendedor_usd, iva_usd, iva_pct, tuas_usd, extras_total_usd, viaticos_pernocta_usd, calculo_snapshot, pase_abordar, extras${colsVueloContable(contable)}`,
        )
        .eq('estado', 'COMPLETADO')
        .gte(colDinero, desdeTs)
        .lte(colDinero, hastaTs),
      // Cancelados del periodo: pueden tener dinero real (cobros retenidos y
      // gastos) que YA cuenta en el reparto (regla 28-ago) — aquí solo se
      // enumeran para que la oficina confirme que ese dinero es de verdad.
      sb
        .from('vuelo')
        .select(
          `id, folio, tc_usd_mxn, fecha_vuelo, fecha_solicitud, aeronave_id${colsVueloContable(contable)}`,
        )
        .eq('estado', 'CANCELADO')
        .gte(colDinero, desdeTs)
        .lte(colDinero, hastaTs),
      // Gastos del periodo con huecos de datos. El embed del vuelo solo
      // sirve para reconocer el GAS de un externo sin avión (abajo).
      sb
        .from('gasto')
        .select(
          // escala embebida: avión RESOLUBLE del gasto (`avionDelGasto`) para
          // el bloqueante de combustible sin avión.
          `id, vuelo_id, aeronave_id, escala_id, categoria, monto, moneda, tc_gasto, fecha_gasto, estatus_facturacion, medio_pago, conciliado, duplicado_sospechado${colPagoAfac(afacDisponible)}, matricula_ia:valor_ia_extraido->>matricula, escala:escala_id(aeronave_id), vuelo:vuelo_id(es_externo, aeronave_id)` as 'id, vuelo_id, aeronave_id, escala_id, categoria, monto, moneda, tc_gasto, fecha_gasto, estatus_facturacion, medio_pago, conciliado, duplicado_sospechado, matricula_ia:valor_ia_extraido->>matricula, escala:escala_id(aeronave_id), vuelo:vuelo_id(es_externo, aeronave_id)',
        )
        .gte('fecha_gasto', q.desde)
        .lte('fecha_gasto', q.hasta),
      // Movimientos bancarios del periodo sin conciliar.
      sb
        .from('movimiento_bancario')
        .select('id, tipo, monto')
        .eq('conciliado', false)
        .gte('fecha', q.desde)
        .lte('fecha', q.hasta),
      // Tacómetros en revisión (amarillos) de vuelos del periodo. Tramos
      // cancelados fuera (no volaron: nada que revisar/capturar).
      // 14-sep-2026 (pedido del cliente «¿podría indicar cuáles son?»): se
      // traen ruta, orden, motivo y piloto del tramo (con el del vuelo de
      // respaldo) para listar QUÉ tramos son, no solo cuántos.
      sb
        .from('escala')
        .select(
          'id, vuelo_id, orden, origen_iata, destino_iata, fecha_salida_plan, revision_motivo, piloto_id, vuelo:vuelo_id!inner(id, folio, fecha_vuelo, estado, piloto_id)',
        )
        .eq('revision_requerida', true)
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        // eje REAL a propósito (invariante 89): tacómetros en revisión (horas)
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // (15-oct-2026) La consulta de «Aterrizajes fuera de CUN» se retiró
      // con el renglón `pistas_sin_gasto` (contaba por escala_id y la
      // oficina captura la cuota por vuelo_id).
      // Fechas de tramos: detectar tramos que "salen" antes que el anterior.
      sb
        .from('escala')
        .select(
          'vuelo_id, orden, fecha_salida_plan, vuelo:vuelo_id!inner(folio, estado)',
        )
        .not('fecha_salida_plan', 'is', null)
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        // eje REAL a propósito (invariante 89): fechas de los tramos (operativo)
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs),
      // SOBRES de cobro de GRUPO del periodo (Fase 2, 4-sep-2026): el
      // invariante Σ partes == sobre se vigila aquí (aviso, no bloquea). El
      // sobre NO es dinero (cobrosEnUsd solo lee cobro_vuelo).
      sb
        .from('cobro_grupo')
        .select(
          'id, grupo_id, monto, moneda, fecha_cobro, grupo:vuelo_grupo!grupo_id(folio)',
        )
        .gte('fecha_cobro', desdeTs)
        .lte('fecha_cobro', hastaTs)
        .limit(2000),
      // Grupos VIVOS del periodo: saldo por cobrar del grupo completo.
      sb
        .from('vuelo_grupo')
        .select('id, folio, nombre, cliente_id, fecha_vuelo')
        .is('cancelado_at', null)
        // eje REAL a propósito (invariante 89): grupos por su fecha (vuelo_grupo.fecha_vuelo)
        .gte('fecha_vuelo', desdeTs)
        .lte('fecha_vuelo', hastaTs)
        .limit(500),
      // TACÓMETROS OMITIDOS (15-oct-2026, invariante 79): renglón
      // INFORMATIVO `tacometros_omitidos`. Detrás de la sonda y nunca lanza
      // (null = lectura fallida): por eso NO entra al bucle de errores.
      this.tacosOmitidosPrecierre(desdeTs, hastaTs),
    ]);
    for (const r of [
      pendRes,
      completadosRes,
      canceladosRes,
      gastosRes,
      movRes,
      revRes,
      legsRes,
      sobresRes,
      gruposRes,
    ]) {
      if (r.error) throw new Error(r.error.message);
    }
    // REVISIÓN (16-oct-2026, invariante 89): un vuelo DIFERIDO a este mes
    // que alguien regresó a EN_VUELO (borrar un tacómetro de un COMPLETADO
    // en un mes contable abierto está permitido) VOLÓ en otro mes: la
    // consulta por `fecha_vuelo` no lo ve, `compute` solo lee COMPLETADO y
    // CANCELADO y `decisionDiferir` solo difiere COMPLETADO ⇒ sin esto el mes
    // se cerraba con ese vuelo FUERA de todos los libros y su fecha contable
    // quedaba en el mes cerrado (sin poder completarlo: 409 MES_CERRADO).
    // También es «sin completar» de ESTE mes ⇒ bloquea el cierre.
    const pendientesData = [
      ...((pendRes.data ?? []) as Array<Record<string, unknown>>),
    ];
    if (contable) {
      const { data: pendDif, error: pendDifErr } = await sb
        .from('vuelo')
        .select('id, folio, estado, fecha_vuelo, aeronave_id')
        .in('estado', [
          'SOLICITUD',
          'COTIZADO',
          'RESERVA',
          'CONFIRMADO',
          'EN_VUELO',
        ])
        .not('periodo_contable', 'is', null)
        .gte('fecha_contable', desdeTs)
        .lte('fecha_contable', hastaTs);
      if (pendDifErr) throw new Error(pendDifErr.message);
      const ya = new Set(pendientesData.map((v) => v.id));
      for (const v of (pendDif ?? []) as Array<Record<string, unknown>>) {
        if (!ya.has(v.id)) pendientesData.push(v);
      }
    }

    // Tramos fuera de orden cronológico (el "regreso" sale antes que la ida):
    // casi siempre es un dedazo al capturar la fecha (caso real: folio 10).
    // No altera montos, pero sí calendario/reportes por fecha — se avisa.
    const legs = (legsRes.data ?? []) as Array<Record<string, unknown>>;
    const legsPorVuelo = new Map<
      string,
      Array<{ orden: number; fecha: string }>
    >();
    for (const e of legs) {
      const list = legsPorVuelo.get(e.vuelo_id as string) ?? [];
      list.push({
        orden: Number(e.orden),
        fecha: e.fecha_salida_plan as string,
      });
      legsPorVuelo.set(e.vuelo_id as string, list);
    }
    const fechasFueraDeOrden: Array<{ id: string; folio: number }> = [];
    for (const [vueloId, list] of legsPorVuelo) {
      list.sort((a, b) => a.orden - b.orden);
      const desorden = list.some(
        (l, i) =>
          i > 0 &&
          new Date(l.fecha).getTime() < new Date(list[i - 1].fecha).getTime(),
      );
      if (desorden) {
        const row = legs.find((e) => e.vuelo_id === vueloId);
        const vuelo = row?.vuelo as Record<string, unknown> | undefined;
        fechasFueraDeOrden.push({
          id: vueloId,
          folio: Number(vuelo?.folio ?? 0),
        });
      }
    }
    fechasFueraDeOrden.sort((a, b) => a.folio - b.folio);

    // Vuelos COMPLETADOS por piloto EXTERNO sin su honorario capturado: el
    // pago del freelance es gasto DIRECTO del vuelo — si falta, la utilidad
    // del reparto sale inflada en silencio.
    let externosSinHonorario = 0;
    let externosSinHonorarioVuelos: Array<{ id: string; folio: number }> = [];
    {
      const completadosRows = (completadosRes.data ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      // Pilotos EFECTIVOS del vuelo: nivel vuelo + rotaciones por TRAMO
      // (barrido 28-ago: un externo que cubre solo un tramo — caso #129 —
      // escapaba a esta vigilancia y la utilidad quedaba inflada).
      const pilotosPorVuelo = new Map<string, Set<string>>();
      for (const v of completadosRows) {
        const set = new Set<string>();
        if (v.piloto_id) set.add(v.piloto_id as string);
        pilotosPorVuelo.set(v.id as string, set);
      }
      if (completadosRows.length > 0) {
        const { data: legsRot, error: legsErr } = await sb
          .from('escala')
          .select('vuelo_id, piloto_id')
          .in(
            'vuelo_id',
            completadosRows.map((v) => v.id as string),
          )
          .not('piloto_id', 'is', null)
          .is('cancelada_at', null);
        if (legsErr) throw new Error(legsErr.message);
        for (const l of legsRot ?? []) {
          pilotosPorVuelo.get(l.vuelo_id as string)?.add(l.piloto_id as string);
        }
      }
      const pilotoIds = [
        ...new Set([...pilotosPorVuelo.values()].flatMap((set) => [...set])),
      ];
      if (pilotoIds.length > 0) {
        const { data: exts, error: extErr } = await sb
          .from('usuario')
          .select('id')
          .in('id', pilotoIds)
          .eq('es_piloto_externo', true);
        if (extErr) throw new Error(extErr.message);
        const externos = new Set((exts ?? []).map((u) => u.id as string));
        const vuelosExternos = completadosRows.filter((v) =>
          [...(pilotosPorVuelo.get(v.id as string) ?? [])].some((pid) =>
            externos.has(pid),
          ),
        );
        if (vuelosExternos.length > 0) {
          const { data: gastosPE, error: gpeErr } = await sb
            .from('gasto')
            .select('vuelo_id')
            .in(
              'vuelo_id',
              vuelosExternos.map((v) => v.id as string),
            )
            .eq('categoria', 'PILOTO_EXTERNO');
          if (gpeErr) throw new Error(gpeErr.message);
          const cubiertos = new Set(
            (gastosPE ?? []).map((g) => g.vuelo_id as string),
          );
          const sinHonorario = vuelosExternos.filter(
            (v) => !cubiertos.has(v.id as string),
          );
          externosSinHonorario = sinHonorario.length;
          // Folios para el checklist: sin ellos el operador llegaba a
          // Gastos sabiendo solo el conteo, sin poder identificar los
          // vuelos (era la única clave por-vuelo sin su arreglo `vuelos`).
          externosSinHonorarioVuelos = sinHonorario.map((v) => ({
            id: v.id as string,
            folio: v.folio as number,
          }));
        }
      }
    }

    // Dinero real en vuelos CANCELADOS del periodo (regla del cliente,
    // 28-ago-2026): los cobros registrados (cargo por cancelación / anticipo
    // retenido) entran al reparto al 100 % como venta del avión y los gastos
    // ligados (se voló a recoger, ferry de regreso, pistas) restan como los de
    // cualquier vuelo. Estos dos renglones son INFORMATIVOS (no bloquean):
    // la oficina confirma que un cobro no fue reembolsado y que un gasto
    // corresponde a una operación que sí ocurrió (una pista provisionada de
    // un vuelo que jamás despegó se borra). NO se listan en cobros_pendientes:
    // un cancelado no tiene saldo por cobrar.
    const cancelados = (canceladosRes.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    const completados = (completadosRes.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    const gruposPeriodo = (gruposRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    const sobresPeriodo = (sobresRes.data ?? []) as Array<
      Record<string, unknown>
    >;
    // COBROS de cancelados + completados (una consulta) y TC OFICIAL de
    // respaldo (regla del cliente, 29-ago-2026): un vuelo sin tc_usd_mxn con
    // cobros MXN sin TC se convierte con el TC oficial del día de la
    // cotización — la MISMA cadena que el reparto (`compute`) y el balance.
    // Antes esos cobros no convertían y el vuelo salía como "saldo por
    // cobrar" en falso. Lo que ni así convierte se lista en `cobros_sin_tc`.
    const cobrosPre = await this.fetchCobros(
      [...cancelados, ...completados].map((v) => v.id as string),
    );
    const cobrosPorVueloPre = new Map<string, CobroRow[]>();
    for (const c of cobrosPre) {
      const list = cobrosPorVueloPre.get(c.vuelo_id) ?? [];
      list.push(c);
      cobrosPorVueloPre.set(c.vuelo_id, list);
    }
    const tcOficialPre = await this.resolverTcOficial(
      [...cancelados, ...completados]
        .map((v) => ({
          id: v.id as string,
          tc_usd_mxn: (v.tc_usd_mxn as string | null) ?? null,
          fecha_solicitud: (v.fecha_solicitud as string | null) ?? null,
          fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
        }))
        .filter((v) =>
          cobrosNecesitanTc(cobrosPorVueloPre.get(v.id) ?? [], v.tc_usd_mxn),
        ),
      [],
    );
    /** La cadena de T.C. del pre-cierre: cotización ?? TC oficial del día. */
    const tcCadena = (v: Record<string, unknown>): number | null =>
      pos(v.tc_usd_mxn) ?? tcOficialPre.vuelo.get(v.id as string)?.tc ?? null;
    /** cobrosEnUsd con la cadena tc de cotización ?? TC oficial del día. */
    const convCobros = (v: Record<string, unknown>) =>
      cobrosEnUsd(
        cobrosPorVueloPre.get(v.id as string) ?? [],
        tcCadena(v),
        pos(v.tc_usd_mxn),
      );
    const cobrosTcOficialVuelos: Array<{ id: string; folio: number }> = [];
    const cobrosSinTcVuelos: Array<{ id: string; folio: number }> = [];
    let cobrosSinTcMxn = 0;
    for (const v of [...cancelados, ...completados]) {
      const conv = convCobros(v);
      const ref = { id: v.id as string, folio: v.folio as number };
      if (tcOficialPre.vuelo.has(ref.id)) cobrosTcOficialVuelos.push(ref);
      if (conv.sin_tc_mxn > 0) {
        cobrosSinTcVuelos.push(ref);
        cobrosSinTcMxn += conv.sin_tc_mxn;
      }
    }

    const cobrosEnCancelados: Array<{
      id: string;
      folio: number;
      cobrado_usd: number;
      /** ADITIVO (14-oct-2026, API 0.0.77): solo cuando aplica. */
      diferencia_cambiaria?: true;
    }> = [];
    let cobrosEnCanceladosUsd = 0;
    let gastosEnCanceladosCount = 0;
    const vuelosConGastoCancelado: Array<{ id: string; folio: number }> = [];
    if (cancelados.length > 0) {
      const idsCancelados = cancelados.map((v) => v.id as string);
      const gastosCancRes = await sb
        .from('gasto')
        .select('id, vuelo_id')
        .in('vuelo_id', idsCancelados);
      if (gastosCancRes.error) throw new Error(gastosCancRes.error.message);

      const vuelosConGasto = new Set(
        (gastosCancRes.data ?? []).map((g) => g.vuelo_id as string),
      );
      for (const v of cancelados) {
        const lista = cobrosPorVueloPre.get(v.id as string) ?? [];
        if (lista.length > 0) {
          // Fuente única de "cuánto se cobró en USD" (cobrosEnUsd, con el
          // TC oficial de respaldo); los MXN que ni así convierten quedan
          // fuera del monto pero el vuelo sí cuenta.
          const conv = convCobros(v);
          // Desde el 0.0.77 (14-oct-2026) SOLO los cancelados que el reparto
          // CUENTA: `retieneCobros`, el MISMO salto de `computeAvion` (antes
          // salían también los devueltos completos con $0.00). Con la marca
          // `diferencia_cambiaria` cuando el dinero ya se devolvió completo
          // (`dineroDevueltoCompleto`, definición única): lo que el reparto
          // todavía cuenta como venta es la diferencia entre el T.C. del
          // cobro y el del reembolso (decisión de dinero pendiente).
          if (retieneCobros(conv)) {
            cobrosEnCancelados.push({
              id: v.id as string,
              folio: v.folio as number,
              cobrado_usd: conv.total_usd,
              ...(dineroDevueltoCompleto(lista, conv)
                ? { diferencia_cambiaria: true as const }
                : {}),
            });
            cobrosEnCanceladosUsd += conv.total_usd;
          }
        }
        if (vuelosConGasto.has(v.id as string)) {
          vuelosConGastoCancelado.push({
            id: v.id as string,
            folio: v.folio as number,
          });
        }
      }
      gastosEnCanceladosCount = (gastosCancRes.data ?? []).length;
    }

    const vuelosSinCompletar = pendientesData.map((v) => ({
      id: v.id as string,
      folio: v.folio as number,
      estado: v.estado as string,
      fecha_vuelo: v.fecha_vuelo as string | null,
    }));

    // Cobros pendientes con SALDO real (soporta pago parcial).
    // Clientes INTERNOS (reposicionamiento/demostración/servicio): operación
    // propia sin cobro esperado — sus vuelos NO son cuentas por cobrar y se
    // excluyen del regaño de cobranza (lookup en lote cliente_id→es_interno).
    const clientesInternos = new Set<string>();
    {
      // También los clientes de los GRUPOS del periodo (grupo_con_saldo).
      const clienteIds = [
        ...new Set(
          [
            ...completados.map((v) => v.cliente_id as string | null),
            ...gruposPeriodo.map((g) => g.cliente_id as string | null),
          ].filter((c): c is string => !!c),
        ),
      ];
      if (clienteIds.length > 0) {
        const { data: internos, error: intErr } = await sb
          .from('cliente')
          .select('id')
          .in('id', clienteIds)
          .eq('es_interno', true);
        if (intErr) throw new Error(intErr.message);
        for (const c of internos ?? []) clientesInternos.add(c.id as string);
      }
    }
    // Folio del grupo del hijo (ADITIVO, presentación): el panel pinta
    // "vuelo #243 · G-12" en los cobros pendientes de un grupo.
    const grupoFolioPorId = new Map<string, number>();
    {
      const grupoIds = [
        ...new Set(
          completados
            .map((v) => v.grupo_id as string | null)
            .filter((g): g is string => !!g),
        ),
      ];
      if (grupoIds.length > 0) {
        const { data: gruposDeHijos, error: gErr } = await sb
          .from('vuelo_grupo')
          .select('id, folio')
          .in('id', grupoIds);
        if (gErr) throw new Error(gErr.message);
        for (const g of gruposDeHijos ?? []) {
          grupoFolioPorId.set(g.id as string, Number(g.folio));
        }
      }
    }
    const cobrosPendientes: Array<{
      id: string;
      folio: number;
      total_usd: number;
      cobrado_usd: number;
      saldo_usd: number;
      grupo_folio: number | null;
      /**
       * ADITIVOS (16-oct-2026, invariante 89; solo con la migración y un
       * mes calendario): a qué mes pasará al cerrar, la leyenda del API y lo
       * cobrado con fecha ≤ último día del mes (`cobradoAlCorte`).
       */
      pasara_a?: string;
      leyenda?: string;
      cobrado_al_corte_usd?: number;
    }> = [];
    // Mes del pre-cierre (solo un mes calendario) para la leyenda «pasará a».
    const mesContablePre = contable
      ? mesCalendarioDeRango(q.desde, q.hasta)
      : null;
    // «VUELOS COBRADOS DE MÁS» (14-oct-2026, API 0.0.78, invariante 77,
    // D14): MISMO universo y MISMA cadena de T.C. que `cobros_pendientes`,
    // sin lecturas nuevas y sin la causa OTRO_VUELO_DEL_CLIENTE.
    const cobradosDeMas: VueloConCobradoDeMas[] = [];
    for (const v of completados) {
      // Cliente interno: nunca aparece como "saldo por cobrar" (aunque la
      // cotización llevara monto), es operación propia.
      if (clientesInternos.has(v.cliente_id as string)) continue;
      const total = Number(v.monto_total_usd ?? 0);
      const conv = convCobros(v);
      const saldo = round2(total - conv.total_usd);
      const grupoFolio =
        typeof v.grupo_id === 'string'
          ? (grupoFolioPorId.get(v.grupo_id) ?? null)
          : null;
      if (saldo > 1) {
        // CIERRE DE MES (invariante 89): la MISMA decisión del cierre
        // (`decisionDiferir`, cobros con fecha ≤ fin de mes).
        const dif = mesContablePre
          ? decisionDiferir(
              {
                estado: 'COMPLETADO',
                monto_total_usd: v.monto_total_usd as string | number | null,
                tc_usd_mxn: tcCadena(v),
                k_cotizacion: pos(v.tc_usd_mxn),
                cliente_interno: false,
              },
              cobrosPorVueloPre.get(v.id as string) ?? [],
              rangoDelMes(mesContablePre).hasta,
            )
          : null;
        const destino = mesContablePre ? mesSiguienteDe(mesContablePre) : null;
        cobrosPendientes.push({
          id: v.id as string,
          folio: v.folio as number,
          total_usd: round2(total),
          cobrado_usd: conv.total_usd,
          saldo_usd: saldo,
          grupo_folio: grupoFolio,
          ...(dif && destino
            ? {
                pasara_a: destino,
                leyenda: leyendaPasaraPrecierre(destino, dif),
                cobrado_al_corte_usd: dif.cobrado_usd,
              }
            : {}),
        });
      }
      const cdm = cobradoDeMas(
        entradaCobradoDeMas({
          vuelo: {
            ...(v as VueloIngresoInput),
            estado: 'COMPLETADO',
            cotizacion_abierta: v.cotizacion_abierta,
          },
          cobros: cobrosPorVueloPre.get(v.id as string) ?? [],
          tcFallback: tcCadena(v),
          kCotizacion: pos(v.tc_usd_mxn),
          grupoFolio,
        }),
      );
      if (cdm) {
        cobradosDeMas.push({
          id: v.id as string,
          folio: v.folio as number,
          grupo_folio: grupoFolio,
          cobrado: cdm,
        });
      }
    }

    // ===== GRUPOS (Fase 2, 4-sep-2026) =====
    // grupo_con_saldo: grupos VIVOS del periodo cuyos hijos vivos (cualquier
    // estado salvo CANCELADO) suman saldo > 1 USD — se suma a los avisos por
    // vuelo. Dinero = cobrosEnUsd por hijo con la MISMA cadena de TC
    // (cotización ?? TC oficial del día); el sobre nunca se lee como dinero.
    const gruposConSaldo: Array<{
      grupo_id: string;
      grupo_folio: number;
      nombre: string | null;
      aviones: number;
      total_usd: number;
      cobrado_usd: number;
      saldo_usd: number;
    }> = [];
    if (gruposPeriodo.length > 0) {
      const { data: hijosG, error: hgErr } = await sb
        .from('vuelo')
        .select(
          'id, folio, grupo_id, estado, monto_total_usd, tc_usd_mxn, fecha_vuelo, fecha_solicitud',
        )
        .in(
          'grupo_id',
          gruposPeriodo.map((g) => g.id as string),
        )
        .neq('estado', 'CANCELADO');
      if (hgErr) throw new Error(hgErr.message);
      const hijosGrupo = (hijosG ?? []) as Array<Record<string, unknown>>;
      const cobrosHijos = await this.fetchCobros(
        hijosGrupo.map((h) => h.id as string),
      );
      const cobrosPorHijo = new Map<string, CobroRow[]>();
      for (const c of cobrosHijos) {
        const list = cobrosPorHijo.get(c.vuelo_id) ?? [];
        list.push(c);
        cobrosPorHijo.set(c.vuelo_id, list);
      }
      const tcOficialHijos = await this.resolverTcOficial(
        hijosGrupo
          .map((h) => ({
            id: h.id as string,
            tc_usd_mxn: (h.tc_usd_mxn as string | null) ?? null,
            fecha_solicitud: (h.fecha_solicitud as string | null) ?? null,
            fecha_vuelo: (h.fecha_vuelo as string | null) ?? null,
          }))
          .filter((h) =>
            cobrosNecesitanTc(cobrosPorHijo.get(h.id) ?? [], h.tc_usd_mxn),
          ),
        [],
      );
      for (const g of gruposPeriodo) {
        if (clientesInternos.has(g.cliente_id as string)) continue;
        const hijos = hijosGrupo.filter((h) => h.grupo_id === g.id);
        if (hijos.length === 0) continue;
        // Un grupo que nunca se confirmó (todos sus hijos COTIZADO/RESERVA)
        // no es "saldo por cobrar": lo vigila `vuelos_no_completados` por
        // vuelo. Aquí solo grupos que sí operaron (o iban a operar).
        if (
          !hijos.some((h) => h.estado !== 'COTIZADO' && h.estado !== 'RESERVA')
        )
          continue;
        let total = 0;
        let cobrado = 0;
        for (const h of hijos) {
          total += Number(h.monto_total_usd ?? 0);
          cobrado += cobrosEnUsd(
            cobrosPorHijo.get(h.id as string) ?? [],
            pos(h.tc_usd_mxn) ??
              tcOficialHijos.vuelo.get(h.id as string)?.tc ??
              null,
            pos(h.tc_usd_mxn),
          ).total_usd;
        }
        const saldo = round2(total - cobrado);
        if (saldo > 1) {
          gruposConSaldo.push({
            grupo_id: g.id as string,
            grupo_folio: Number(g.folio),
            nombre: (g.nombre as string | null) ?? null,
            aviones: hijos.length,
            total_usd: round2(total),
            cobrado_usd: round2(cobrado),
            saldo_usd: saldo,
          });
        }
      }
    }

    // sobres_descuadrados: Σ partes ≠ sobre o partes en hijos CANCELADOS —
    // misma función pura (cuadreSobre) que el detalle del grupo y la alerta.
    const unwrapOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    const sobresDescuadrados: Array<{
      sobre_id: string;
      grupo_id: string;
      grupo_folio: number | null;
      fecha_cobro: string | null;
      monto: number;
      moneda: string;
      suma_partes: number;
      partes_en_cancelados: number;
    }> = [];
    if (sobresPeriodo.length > 0) {
      const { data: partesS, error: psErr } = await sb
        .from('cobro_vuelo')
        .select('cobro_grupo_id, monto, vuelo:vuelo_id(estado)')
        .in(
          'cobro_grupo_id',
          sobresPeriodo.map((s) => s.id as string),
        )
        .limit(10000);
      if (psErr) throw new Error(psErr.message);
      const partes = (partesS ?? []) as Array<Record<string, unknown>>;
      for (const s of sobresPeriodo) {
        const propias = partes
          .filter((p) => p.cobro_grupo_id === s.id)
          .map((p) => ({
            monto: Number(p.monto) || 0,
            cancelado:
              unwrapOne(p.vuelo as { estado?: string } | null)?.estado ===
              'CANCELADO',
          }));
        const cuadre = cuadreSobre({
          monto: Number(s.monto) || 0,
          partes: propias,
        });
        if (!cuadre.descuadrado) continue;
        const grupo = unwrapOne(s.grupo as { folio?: unknown } | null);
        sobresDescuadrados.push({
          sobre_id: s.id as string,
          grupo_id: s.grupo_id as string,
          grupo_folio: grupo?.folio == null ? null : Number(grupo.folio),
          fecha_cobro: (s.fecha_cobro as string | null) ?? null,
          monto: round2(Number(s.monto) || 0),
          moneda: (s.moneda as string) ?? 'USD',
          suma_partes: cuadre.suma_partes,
          partes_en_cancelados: cuadre.partes_en_cancelados,
        });
      }
    }

    // Completados SIN precio de cliente REAL: el gate de `cobrado` exige
    // monto>0 y la alerta de cobranza los calla a propósito (Servicio/$0) —
    // este renglón es su ÚNICA vigilancia: sin cotización no hay cuenta por
    // cobrar y el ingreso del vuelo se pierde en silencio.
    const vuelosSinPrecio = completados
      .filter(
        (v) =>
          !clientesInternos.has(v.cliente_id as string) &&
          !(Number(v.monto_total_usd ?? 0) > 0),
      )
      .map((v) => ({ id: v.id as string, folio: v.folio as number }));

    // Extras SIN desglose exacto (regla 6 + Regla A): la venta del avión se
    // separa de TUAS/extras/pernocta/comisión del vendedor con el desglose
    // canónico del snapshot; si el vuelo con precio no lo tiene (fuente
    // 'columnas') y trae alguno de esos componentes, o el desglose no cuadra
    // con el total (inconsistente → todo al avión), la partición es
    // aproximada. Aviso NO bloqueante: el dinero no se pierde (cierre por
    // diferencia), solo puede quedar mal repartido entre avión y VuelaTour
    // hasta revisar la cotización.
    const extrasSinDesglose = completados
      .filter((v) => {
        if (!(Number(v.monto_total_usd ?? 0) > 0)) return false;
        const p = particionIngresoVuelo(v);
        return (
          p.inconsistente ||
          (p.fuente === 'columnas' &&
            round2(
              p.tuas_usd +
                p.extras_usd +
                p.pernocta_usd +
                p.comision_vendedor_usd,
            ) > 0)
        );
      })
      .map((v) => ({ id: v.id as string, folio: v.folio as number }));

    const gastos = (gastosRes.data ?? []) as Array<Record<string, unknown>>;
    // Repartos manuales del periodo: un gasto con filas en gasto_reparto YA
    // está asignado (misma regla que la bandeja de Gastos — simetría).
    const repartosPre = await fetchRepartos(
      this.supabase.service,
      gastos.map((g) => g.id as string),
    );
    // Categorías que NO necesitan avión (no bloquean ni ensucian el cierre)
    // — FUENTE ÚNICA `CATEGORIAS_GASTO_SIN_AVION`, la MISMA de la bandeja de
    // pendientes y de la alerta diaria (si divergen, el conteo no cuadra):
    //  - LAS DE EMPRESA (11-sep-2026: OTRO, NOMINA, GASOLINA, FIJO, VISITA):
    //    son gasto de VuelaTour, van a la hoja "otros gastos" del general
    //    CON o SIN vuelo y con o sin avión — pedirles aeronave era pedir que
    //    el dinero del avión mintiera. Antes solo se exentaba «OTRO SIN
    //    vuelo» y un OTRO ligado a un vuelo gritaba "sin avión" aunque su
    //    destino ya no fuera ningún avión.
    //  - INDIRECTO: sin avión por diseño (captura general, jul 2026).
    //  - PERSONAL_DUENO: jamás lleva avión (dinero personal del dueño).
    // SERVICIOS NO se exenta: sin avión SÍ bloquea (como REFACCION).
    // PAGO DE AFAC (invariante 90): un PERMISO marcado lo paga VuelaTour —
    // no le falta avión (ni bloquea `permisos_sin_avion`, que sale de aquí).
    const sinAvion = gastos.filter(
      (g) =>
        g.aeronave_id == null &&
        !CATEGORIAS_GASTO_SIN_AVION.includes(g.categoria as string) &&
        !repartosPre.has(g.id as string) &&
        !esPagoAfac(
          g as { categoria?: string | null; es_pago_afac?: boolean | null },
        ),
    );
    // NÓMINA SIN REPARTIR (16-oct-2026, API 0.0.90, invariante 91): las
    // NÓMINA del periodo (la MISMA lectura de gastos, ya con el inicio
    // oficial) sin ninguna fila en `gasto_reparto`. Lectura propia de
    // existencia, paginada y por lotes (`gastosConReparto`), best-effort:
    // caída ⇒ null ⇒ count 0 + `lectura_fallida`. BLOQUEA el cierre.
    const nominaSinRepartir = await this.nominaSinRepartirPrecierre(
      gastos.filter((g) => g.categoria === CATEGORIA_NOMINA),
    );
    // GASTOS POR PAGAR (19-oct-2026, invariante 93): lectura propia de los
    // por pagar vigentes (estado ≠ PAGADO), paginada y best-effort; cuentan
    // los de ESTE periodo por su MES CONTABLE (revisión P1: la regla del
    // candado de mes cerrado, no `fecha_gasto`). Caída ⇒ null ⇒ count 0 +
    // `lectura_fallida` (y `listo: false`, P3); sin la migración ⇒ [] (count
    // 0). BLOQUEA.
    const hoyPorPagar = hoyCancun(this.ahora());
    const porPagarPre = await this.gastosPorPagarPrecierre(
      q.desde,
      q.hasta,
      hoyPorPagar,
      contable,
    );
    const gastosPorPagar = porPagarPre.lista;
    // Reparto incoherente: Σ parciales > monto del gasto (p. ej. se editó el
    // monto a la baja DESPUÉS de repartir) — el sobrante restaría dinero
    // inexistente a los aviones. Aviso para corregir en Otros gastos.
    const repartosIncoherentes = gastos.filter((g) => {
      const filas = repartosPre.get(g.id as string);
      if (!filas) return false;
      const suma = filas.reduce((acc, r) => acc + r.monto, 0);
      return Math.round(suma * 100) > Math.round(Number(g.monto ?? 0) * 100);
    });
    // COMBUSTIBLE sin avión (26-ago-2026): con el modelo "gas por avión/mes"
    // el aeronave_id es la ÚNICA liga del combustible al balance y al
    // reparto — una carga sin avión es dinero invisible. BLOQUEA el cierre.
    // Excepción (verificación 28-ago): el GAS de un vuelo EXTERNO sin avión
    // de referencia vive en la hoja "combustible" del libro EXTERNOS del
    // Balance general — no es dinero invisible y no debe bloquear el cierre
    // (mismo filtro que aircraft-balance.pendienteGasSinAvion).
    const esGasDeExternoSinAvion = (g: Record<string, unknown>): boolean => {
      const raw: unknown = g.vuelo;
      const v: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
      if (!v || typeof v !== 'object') return false;
      const row = v as { es_externo?: unknown; aeronave_id?: unknown };
      return row.es_externo === true && row.aeronave_id == null;
    };
    // Avión RESOLUBLE del gasto (misma fuente única que balance/reparto,
    // `avionDelGasto`: tramo con herencia → sellado → vuelo). Un GAS con
    // vuelo/tramo resoluble NO es dinero invisible (el reparto y la hoja
    // combustible de ese avión ya lo cargan) — antes el bloqueante gritaba
    // en falso por el aeronave_id crudo. Sigue en la bandeja informativa
    // `gastos_sin_avion` hasta que se selle la aeronave.
    const avionResoluble = (g: Record<string, unknown>): string | null => {
      const rawE: unknown = g.escala;
      const esc = (Array.isArray(rawE) ? (rawE as unknown[])[0] : rawE) as {
        aeronave_id?: string | null;
      } | null;
      const rawV: unknown = g.vuelo;
      const vuelo = (Array.isArray(rawV) ? (rawV as unknown[])[0] : rawV) as {
        aeronave_id?: string | null;
      } | null;
      const mapa = new Map<string, { aeronave_id?: string | null }>();
      if (typeof g.escala_id === 'string' && esc) mapa.set(g.escala_id, esc);
      return avionDelGasto(
        {
          escala_id: (g.escala_id as string | null) ?? null,
          aeronave_id: (g.aeronave_id as string | null) ?? null,
        },
        mapa,
        vuelo?.aeronave_id ?? null,
      );
    };
    const gasSinAvion = sinAvion.filter(
      (g) =>
        g.categoria === 'GAS' &&
        !esGasDeExternoSinAvion(g) &&
        avionResoluble(g) == null,
    );
    // PERMISO sin avión (14-oct-2026, API 0.0.77, invariante 62; revisión F6):
    // el cliente decidió que «el AFAC lo cargan al Avión»; un permiso sin
    // avión RESOLUBLE caería en «otros gastos» de VuelaTour del Balance
    // general y en NINGÚN reparto — lo contrario de la decisión. BLOQUEA el
    // cierre con el MISMO criterio que el combustible (los dos helpers de
    // arriba tal cual): uno de un vuelo EXTERNO sin avión queda fuera
    // (riesgo documentado: no vive en ningún libro; sigue en
    // `gastos_sin_avion`).
    const permisosSinAvion = sinAvion.filter(
      (g) =>
        g.categoria === 'PERMISO' &&
        !esGasDeExternoSinAvion(g) &&
        avionResoluble(g) == null,
    );
    // Jamás se suman monedas: pesos y dólares por separado.
    const montoPermisosSinAvion = (moneda: 'MXN' | 'USD'): number =>
      round2(
        permisosSinAvion
          .filter((g) => (g.moneda === 'USD' ? 'USD' : 'MXN') === moneda)
          .reduce((acc, g) => acc + Number(g.monto ?? 0), 0),
      );
    const permisosSinAvionUsd = montoPermisosSinAvion('USD');
    // El caso inverso: un FIJO capturado CON avión se prorratea igual entre
    // toda la flota (el pool no mira aeronave_id) y en el detalle del avión
    // asignado aparece EXCLUIDO — doble lectura silenciosa. Aviso, no candado.
    const fijosConAvion = gastos.filter(
      // Un FIJO REPARTIDO a mano no es doble lectura: salió del pool y sus
      // parciales van al avión elegido (verificación 26-ago).
      (g) =>
        g.aeronave_id != null &&
        g.categoria === 'FIJO' &&
        !repartosPre.has(g.id as string),
    );
    const sinTc = gastos.filter(
      // PERSONAL_DUENO no entra al balance USD: su TC no bloquea el cierre.
      // Un pago de AFAC marcado (invariante 90) tampoco: no entra a ningún
      // USD de avión (su comparación del Balance general es en pesos).
      (g) =>
        g.moneda === 'MXN' &&
        !(Number(g.tc_gasto) > 0) &&
        g.categoria !== 'PERSONAL_DUENO' &&
        !esPagoAfac(
          g as { categoria?: string | null; es_pago_afac?: boolean | null },
        ),
    );
    // TC oficial del día del gasto (29-ago): los MXN sin TC que SÍ tienen
    // referencia oficial YA entran al reparto y al balance (informativo);
    // solo bloquean el cierre los que ni así convierten (sin red / sin dato).
    // EXCEPCIÓN (revisión 13-oct-2026, invariante 61): el pago «Comisión del
    // vendedor (avión)» NO se convierte con el oficial del día del GASTO sino
    // con el K de su VUELO (tc de la cotización ?? oficial del día de la
    // cotización, `kComisionesDeVuelo`) y cuenta en el MES DEL VUELO. Este
    // renglón lo da por convertido con el oficial de SU día (y solo si su
    // fecha_gasto cae en el periodo): es una aproximación informativa. Si el
    // día de la cotización no tuviera dato, quien lo grita es `gastos_sin_tc`
    // del avión en el reparto del mes del vuelo.
    const tcOficialGastosPre = await this.resolverTcOficial(
      [],
      sinTc.map((g) => ({
        id: g.id as string,
        moneda: g.moneda as string,
        tc_gasto: (g.tc_gasto as string | null) ?? null,
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
      })),
    );
    const sinTcConOficial = sinTc.filter((g) =>
      tcOficialGastosPre.gasto.has(g.id as string),
    );
    // GASTOS POR PAGAR (revisión P4, 19-oct-2026, invariante 93): con la
    // migración, un MXN sin T.C. con fecha FUTURA (por pagar por
    // construcción) que tampoco tiene oficial NO bloquea como «sin T.C.»: ya
    // lo señala `gastos_por_pagar`. El servicio de T.C. busca en [fecha − 7,
    // fecha]: hasta hoy + 7 encuentra el de hoy y el gasto se convierte
    // (sigue en el informativo `gastos_tc_oficial`, como en el reparto, que
    // lo resta); más allá todavía no hay dato. Nunca toca un mes cerrable
    // (sus días no han pasado). Sin la migración, como el 0.0.94. Segunda
    // pasada de la revisión: antes salía de `sinTc` entero y el informativo
    // dejaba de listar los de hasta hoy + 7 que el reparto sí resta.
    const esFechaFuturaPorPagar = (g: Record<string, unknown>): boolean =>
      porPagarPre.disponible &&
      typeof g.fecha_gasto === 'string' &&
      g.fecha_gasto.slice(0, 10) > hoyPorPagar;
    const sinTcSinOficial = sinTc.filter(
      (g) =>
        !tcOficialGastosPre.gasto.has(g.id as string) &&
        !esFechaFuturaPorPagar(g),
    );
    const sumaMxn = (lista: Array<Record<string, unknown>>) =>
      round2(lista.reduce((acc, g) => acc + Number(g.monto), 0));
    // Seguimiento de oficina (estatus_facturacion), NO el comprobante del
    // piloto: la app marca FACTURA con cualquier foto, aunque sea un ticket.
    // BODEGA se excluye: es cargo contable del puente de inventario y su
    // factura vive en la ENTRADA del cardex — jamás tendrá factura propia
    // (dejarlo contaría ruido eterno en el pre-cierre).
    // PERSONAL_DUENO: la factura a la empresa no aplica (gasto del dueño).
    // NO_FACTURABLE (14-sep-2026): la oficina ya dijo que ese gasto no lleva
    // factura — contarlo sería ruido eterno en el checklist.
    // Fuente única de la regla: `cuentaComoSinFacturar`.
    const sinFacturar = gastos.filter((g) => cuentaComoSinFacturar(g));
    // Posibles duplicados con el flag aún encendido: cada uno resta DOBLE al
    // reparto hasta que alguien lo resuelva (borrar el repetido o marcar
    // "No es duplicado" en Gastos → pestaña Duplicados).
    const duplicadosSinResolver = gastos.filter(
      // Los PERSONAL_DUENO duplicados no tocan el reparto: se resuelven en
      // la bandeja Gastos → Duplicados, no estorban el cierre.
      (g) =>
        g.duplicado_sospechado === true && g.categoria !== 'PERSONAL_DUENO',
    );
    // El espejo que faltaba: los MOVIMIENTOS sin conciliar ya se vigilan,
    // pero un GASTO bancario que nadie cruzó (p. ej. el sobrante de un
    // duplicado cuya pareja ya se concilió) era invisible para siempre.
    // LEE la fuente única MEDIOS_BANCARIOS de conciliación (invariante 7;
    // desde el 13-oct-2026 incluye DOMICILIADO, invariante 64): medios cuyo
    // cargo aparece en el estado de cuenta.
    const bancariosSinConciliar = gastos.filter(
      (g) =>
        typeof g.medio_pago === 'string' &&
        MEDIOS_BANCARIOS.includes(g.medio_pago) &&
        g.conciliado !== true,
    );
    // Matrícula del comprobante ≠ avión asignado (26-ago, cruce ASUR MID):
    // en cambios de avión a media jornada el recibo trae la matrícula REAL y
    // la herencia del vuelo puede colgar el gasto en el avión equivocado —
    // el costo resta en el balance que no es. Red mensual del aviso que ya
    // salta en la captura.
    const { data: flotaPre } = await sb
      .from('aeronave')
      .select('id, matricula');
    const normMat = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const avionPorMatricula = new Map(
      (flotaPre ?? []).map((a) => [
        normMat(a.matricula as string),
        a.id as string,
      ]),
    );
    const matriculaCruzada = gastos.filter((g) => {
      const mIa = g.matricula_ia;
      if (typeof mIa !== 'string' || !mIa.trim() || g.aeronave_id == null)
        return false;
      const delRecibo = avionPorMatricula.get(normMat(mIa));
      return delRecibo != null && delRecibo !== g.aeronave_id;
    });
    const movs = (movRes.data ?? []) as Array<Record<string, unknown>>;
    // El espejo de `bancariosSinConciliar` para los COBROS (9-sep-2026):
    // transferencia / HSBC link / cheque / Paywise sin liga con ningún abono
    // importado — misma lectura que GET /conciliacion/cobros-sin-banco.
    // Best-effort: un fallo aquí no tumba el pre-cierre (se avisa en 0).
    // GASTOS USD CON T.C. FUERA DE LUGAR (13-oct-2026, invariante 70): la
    // promesa ARRANCA aquí (en paralelo con cobros sin banco) y se espera al
    // armar los items: no suma latencia. Nunca lanza (null = sin verificar).
    const ligasUsdTcPromesa = this.ligasUsdTcPrecierre(q.desde, q.hasta);
    // MOVIMIENTOS OMITIDOS DE LA CONCILIACIÓN (14-oct-2026, invariante 75):
    // renglón INFORMATIVO; arranca en paralelo y nunca lanza (null = no se
    // pudo leer ⇒ lectura_fallida).
    const omitidosPromesa = this.omitidosPrecierre(q.desde, q.hasta);
    let cobrosSinBanco: Awaited<
      ReturnType<ConciliacionService['cobrosSinBanco']>
    > | null = null;
    try {
      cobrosSinBanco = await this.conciliacion.cobrosSinBanco(q.desde, q.hasta);
    } catch (err) {
      this.logger.warn(
        `pre-cierre: cobros sin banco no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const cobrosPaywiseSinBanco = (cobrosSinBanco?.data ?? []).filter(
      (c) => c.metodo_cobro === 'PAYWISE',
    );

    // SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026): vuelos del periodo con
    // ajustes PENDIENTES de reflejar en la cotización («los pax pidieron
    // transporte…»). Aviso NO bloqueante; best-effort como cobros sin banco.
    //
    // CUENTAS DE LOS SOCIOS (v2, 2-oct-2026): SOLO cuando el periodo es un
    // MES calendario. Avisos NO bloqueantes; sin la migración o con la
    // lectura caída ⇒ count 0 + `lectura_fallida`. Los dos son best-effort
    // (nunca lanzan): van en paralelo. Solo para quien puede LEER las
    // cuentas (ver arriba): para los demás ni se calcula.
    const mesCierre = mesDePeriodo(q.desde, q.hasta);
    const veeCuentasSocios =
      rol != null && ROLES_PAGOS_SOCIOS_LECTURA.includes(rol);
    //
    // VUELOS SIN GASTO DE OPERACIONES (5-oct-2026): completados PROPIOS del
    // periodo —cliente interno y servicio INCLUIDOS: su pista también resta
    // en el balance— sin ninguna pista/aterrizaje ligada; lo que la
    // conciliación no puede ver (gasto nunca capturado ni pagado con la
    // tarjeta). Aviso NO bloqueante y best-effort: lectura caída ⇒ `null` ⇒
    // lectura_fallida.
    const matriculaPorAvion = new Map(
      (flotaPre ?? []).map((a) => [a.id as string, a.matricula as string]),
    );
    //
    // VUELOS COBRADOS EN CUENTAS QUE EXIGEN FACTURA SIN FACTURA REGISTRADA
    // (13-oct-2026, invariante 60): TODOS los vuelos del periodo que ya lee
    // el pre-cierre (pendientes + completados + cancelados). Aviso NO
    // bloqueante y best-effort: lectura caída ⇒ `null` ⇒ lectura_fallida.
    //
    // RENGLONES INVERSOS (15-oct-2026, PEDIDO 4): TUA pagada por Operación
    // sin TUA cobrada y transporte pagado sin cotizar, sobre el universo
    // común `candidatosPrecierreInversos` (propios, cliente no interno,
    // total > 0) y UNA sola lectura de gastos. Avisos NO bloqueantes y
    // best-effort: lectura caída ⇒ `null` ⇒ los DOS con lectura_fallida.
    // (Sustituyen a `tua_cobrada_sin_pagada`, retirado ese día.)
    const [seguimiento, itemsCuentasSocios, sinGastoOps, sinFactura, inversos] =
      await Promise.all([
        this.seguimientoCotizacionPendiente(desdeTs, hastaTs, contable),
        mesCierre && veeCuentasSocios
          ? this.itemsCuentasSocios(mesCierre)
          : Promise.resolve([] as ItemPrecierreCuentasSocios[]),
        this.vuelosSinGastoOperaciones(
          candidatosSinGastoOperaciones(
            completados as VueloCompletadoSinGastoRow[],
          ),
          matriculaPorAvion,
        ),
        this.vuelosCobradosSinFactura(
          [
            ...(pendientesData as unknown as VueloCobradoRow[]),
            ...(completados as VueloCobradoRow[]),
            ...(cancelados as VueloCobradoRow[]),
          ],
          matriculaPorAvion,
        ),
        this.inversosPrecierre(
          candidatosPrecierreInversos(
            completados as VueloInversoRow[],
            clientesInternos,
          ),
          matriculaPorAvion,
        ),
      ]);

    // Tacómetros amarillos del periodo: QUÉ tramos son (pedido del cliente,
    // 14-sep-2026). Los nombres de piloto salen de UNA consulta en lote; si
    // alguno no resuelve, sale null (jamás un nombre inventado).
    // Tacómetros OMITIDOS (15-oct-2026, invariante 79): sus nombres (piloto
    // con herencia + quien omitió) van en la MISMA consulta a `usuario`.
    const tacosRows = (revRes.data ?? []) as EscalaEnRevisionRow[];
    const omitRows = omitRes ?? [];
    const nombresTacos = await this.fetchNombres([
      ...new Set([
        ...pilotosDeTacosEnRevision(tacosRows),
        ...usuariosDeTacosOmitidos(omitRows),
      ]),
    ]);
    const tacos = resumenTacosEnRevision(tacosRows, nombresTacos);
    const tacosOmitidos = resumenTacosOmitidos(omitRows, nombresTacos);

    const ligasUsdTc = await ligasUsdTcPromesa;
    // VUELOS QUE VIENEN (invariante 89): diferidos a este periodo por un
    // cierre anterior (informativo; solo con la migración).
    const vuelosQueVienen = contable
      ? await this.itemVuelosQueVienen(
          [...completados, ...cancelados],
          q.desde,
          q.hasta,
        )
      : null;
    const items = [
      {
        clave: 'vuelos_sin_completar',
        titulo: 'Vuelos del periodo sin completar',
        detalle:
          'Sus horas e ingresos NO entran al cierre hasta completarse (o cancelarse).',
        count: vuelosSinCompletar.length,
        vuelos: vuelosSinCompletar,
      },
      {
        clave: 'tacos_en_revision',
        titulo: 'Tacómetros en revisión (amarillos)',
        detalle: detalleTacosEnRevision(tacosRows.length, tacos.vuelos.length),
        // count = TRAMOS amarillos (no vuelos), como siempre.
        count: tacosRows.length,
        vuelos: tacos.vuelos,
        tramos: tacos.tramos,
      },
      // TACÓMETROS OMITIDOS (15-oct-2026, invariante 79): INFORMATIVO, fuera
      // de `bloqueantes`, SIN `ids` (invariante 81: ya trae `vuelos[]` y
      // `tramos[]`). count = TRAMOS, como `tacos_en_revision`. Sin la
      // migración ⇒ count 0 (verdad: no puede haber omitidos); lectura
      // fallida ⇒ count 0 + `lectura_fallida` (el panel dice «sin verificar»).
      {
        clave: 'tacometros_omitidos',
        titulo: 'Tacómetros omitidos (sin lectura, con motivo)',
        detalle: omitRes
          ? detalleTacosOmitidos(omitRows.length, tacosOmitidos.vuelos.length)
          : DETALLE_TACOS_OMITIDOS_FALLIDA,
        count: omitRows.length,
        vuelos: tacosOmitidos.vuelos,
        tramos: tacosOmitidos.tramos,
        informativo: true as const,
        ...(omitRes ? {} : { lectura_fallida: true as const }),
      },
      {
        clave: 'fechas_tramos_incoherentes',
        titulo: 'Vuelos con fechas de tramos fuera de orden',
        detalle:
          'Un tramo "sale" antes que el tramo anterior (dedazo de fecha): corrígelo en el detalle del vuelo → Asignación por tramo.',
        count: fechasFueraDeOrden.length,
        vuelos: fechasFueraDeOrden,
      },
      {
        clave: 'cobros_pendientes',
        titulo: 'Vuelos completados con saldo por cobrar',
        detalle:
          'Solo se reparte lo cobrado: la parte del avión de este saldo queda fuera del reparto (el resto —TUAS/extras/pernocta/comisión del vendedor— es ingreso de VuelaTour, tampoco cobrado).',
        count: cobrosPendientes.length,
        monto_usd: round2(
          cobrosPendientes.reduce((acc, c) => acc + c.saldo_usd, 0),
        ),
        vuelos: cobrosPendientes,
        // CIERRE DE MES (invariante 89): con la migración, la regla del cierre.
        ...(mesContablePre
          ? { detalle: DETALLE_COBROS_PENDIENTES_CIERRE }
          : {}),
      },
      // VUELOS QUE VIENEN DE MESES ANTERIORES (16-oct-2026, invariante 89):
      // INFORMATIVO, solo con la migración.
      ...(vuelosQueVienen ? [vuelosQueVienen] : []),
      // «Vuelos cobrados de más» (0.0.78, invariante 77, D14): NO bloquea;
      // count = los que requieren revisión, los explicados aparte.
      renglonVuelosCobradosDeMas(cobradosDeMas),
      // GRUPOS (Fase 2): avisos de grupo ADEMÁS de los avisos por vuelo.
      {
        clave: 'grupo_con_saldo',
        titulo: 'Grupos con saldo por cobrar',
        detalle:
          'Cotizaciones de GRUPO (varios aviones) del periodo cuyos aviones aún deben: registra el sobre del grupo (Cobros del grupo) o los cobros por avión. Se suma a los vuelos con saldo de arriba.',
        count: gruposConSaldo.length,
        monto_usd: round2(
          gruposConSaldo.reduce((acc, g) => acc + g.saldo_usd, 0),
        ),
        grupos: gruposConSaldo,
      },
      {
        clave: 'sobres_descuadrados',
        titulo: 'Sobres de cobro de grupo descuadrados',
        detalle:
          'La suma de las partes por avión no coincide con el sobre, o hay partes en aviones cancelados: re-parte el sobre desde Cobros del grupo antes de cerrar (el banco concilia contra el sobre; el reparto lee las partes).',
        count: sobresDescuadrados.length,
        sobres: sobresDescuadrados,
      },
      {
        clave: 'vuelos_sin_precio',
        titulo: 'Vuelos completados sin cotizar (precio en $0)',
        detalle:
          'Se volaron pero su cotización quedó en $0: cotízalos para poder cobrarlos — sin precio no aparecen en cobranza ni en el reparto.',
        count: vuelosSinPrecio.length,
        vuelos: vuelosSinPrecio,
      },
      {
        clave: CLAVE_PRECIERRE_SEGUIMIENTO,
        titulo: 'Vuelos con ajustes pendientes de reflejar en la cotización',
        // «N vuelo(s) con ajustes pendientes de reflejar en la cotización:
        // #a, #b…» (fuente única resumenPrecierreSeguimiento). NO bloquea:
        // es un recordatorio de cobranza, el dinero ya capturado no cambia.
        detalle: seguimiento
          ? seguimiento.detalle
          : 'No se pudo leer el seguimiento de la cotización: revisa las notas pendientes en el detalle de cada vuelo.',
        count: seguimiento?.count ?? 0,
        // count = VUELOS; notas = total de notas pendientes (un vuelo puede
        // tener varias). `vuelos[].notas` va por vuelo.
        notas: seguimiento?.notas ?? 0,
        vuelos: seguimiento?.vuelos ?? [],
        // ADITIVO: true cuando la lectura FALLÓ (el 0 no es «no hay»).
        lectura_fallida: seguimiento === null,
      },
      ...itemsCuentasSocios,
      {
        clave: 'extras_sin_desglose',
        titulo: 'Vuelos con TUAS/extras sin desglose exacto',
        detalle:
          'No se puede separar con exactitud la venta del avión de los extras (TUAS/extras/pernocta/comisión del vendedor son ingreso de VuelaTour, no del avión): revisa la cotización en el detalle del vuelo para regenerar el desglose. Mientras tanto se usan las columnas del vuelo, o todo el total va al avión si el desglose no cuadra.',
        count: extrasSinDesglose.length,
        vuelos: extrasSinDesglose,
      },
      {
        clave: 'combustible_sin_avion',
        titulo: 'Cargas de combustible sin avión',
        detalle:
          'El combustible se controla por avión/mes: sin aeronave no resta ' +
          'en ningún balance ni en el reparto. Asigna el avión en Combustibles.',
        count: gasSinAvion.length,
        monto_mxn: round2(
          gasSinAvion.reduce((acc, g) => acc + Number(g.monto ?? 0), 0),
        ),
        // PEDIDO 2 (invariante 81): ids de los gastos contados, al final.
        ...idsPrecierre(gasSinAvion),
      },
      {
        clave: 'permisos_sin_avion',
        titulo: 'Permisos sin avión',
        // Con la marca «Pago de AFAC» (invariante 90) el texto dice la salida
        // nueva; sin la migración, el de siempre.
        detalle: afacDisponible
          ? DETALLE_PERMISOS_SIN_AVION_AFAC
          : 'El permiso lo carga el avión (decisión del cliente del 14-oct-2026): sin avión no resta en ningún balance ni en el reparto y el Balance general lo pondría como gasto de VuelaTour. Asígnale el avión o el vuelo en Gastos.',
        count: permisosSinAvion.length,
        monto_mxn: montoPermisosSinAvion('MXN'),
        // Solo si hay permisos en dólares (jamás se suman monedas).
        ...(permisosSinAvionUsd > 0 ? { monto_usd: permisosSinAvionUsd } : {}),
        ...idsPrecierre(permisosSinAvion),
      },
      {
        clave: 'repartos_incoherentes',
        titulo: 'Repartos de gasto que suman MÁS que el gasto',
        detalle:
          'Se editó el monto después de repartir: corrige el reparto en Otros gastos (restaría dinero inexistente).',
        count: repartosIncoherentes.length,
        ...idsPrecierre(repartosIncoherentes),
      },
      {
        clave: 'gastos_sin_avion',
        titulo: 'Gastos sin avión asignado (bandeja)',
        detalle:
          'No se restan a ningún avión en el reparto. Meta: bandeja vacía.',
        count: sinAvion.length,
        ...idsPrecierre(sinAvion),
      },
      // Justo después de la bandeja (invariante 91): BLOQUEANTE.
      renglonNominaSinRepartir(nominaSinRepartir),
      // Justo después de la nómina (invariante 93): BLOQUEANTE.
      renglonGastosPorPagar(gastosPorPagar, hoyPorPagar),
      {
        clave: 'fijos_con_avion',
        titulo: 'Gastos FIJOS capturados con avión',
        detalle:
          'Los FIJOS se prorratean entre TODA la flota aunque tengan avión: quítales el avión o cámbiales la categoría para que resten donde corresponde.',
        count: fijosConAvion.length,
        ...idsPrecierre(fijosConAvion),
      },
      {
        clave: 'matricula_recibo_distinta',
        titulo: 'Gastos cuyo comprobante trae OTRA matrícula',
        detalle:
          'La IA leyó en el recibo una matrícula distinta al avión asignado (típico en cambios de avión a media jornada): el costo puede estar restando en el avión equivocado. Corrige el avión del gasto en Gastos.',
        count: matriculaCruzada.length,
        ...idsPrecierre(matriculaCruzada),
      },
      {
        clave: 'duplicados_sin_resolver',
        titulo: 'Posibles gastos duplicados sin resolver',
        detalle:
          'Cada duplicado resta DOBLE al reparto. Revísalos en Gastos → pestaña Duplicados: borra el repetido o marca "No es duplicado".',
        count: duplicadosSinResolver.length,
        ...idsPrecierre(duplicadosSinResolver),
      },
      {
        clave: 'gastos_bancarios_sin_conciliar',
        titulo: 'Gastos bancarios sin conciliar al corte',
        detalle:
          'Tarjeta corporativa, transferencia, PayWise o pago domiciliado sin cruzar con el banco: puede ser conciliación pendiente… o el sobrante de un pago duplicado. Revísalos en Conciliación.',
        count: bancariosSinConciliar.length,
        ...idsPrecierre(bancariosSinConciliar),
      },
      // Junto a los bancarios sin conciliar (13-oct-2026, invariante 70):
      // las ligas USD ↔ pesos a más de ±2 % del oficial del día del cargo.
      // NO bloquea.
      itemPrecierreLigasUsdTc(ligasUsdTc),
      {
        clave: 'cobros_bancarios_sin_conciliar',
        titulo: 'Cobros bancarios sin conciliar al corte',
        // UN COBRO, VARIOS ABONOS (0.0.78, invariante 77, D14): «Cobros sin
        // banco» ya cuenta los cobros PARCIALES (abonos que no los cubren);
        // con alguno, el detalle explica qué es un parcial.
        detalle:
          'Transferencia, HSBC link, cheque o Paywise sin cruzar con ningún abono importado: importa el estado de cuenta (o el de Paywise → Auditoría Paywise) y concilia. Un cobro que nunca llegó al banco es dinero que se cree cobrado.' +
          ((cobrosSinBanco?.parciales ?? 0) > 0
            ? ' Un cobro «parcial» ya tiene parte en el banco: falta vincular el resto.'
            : ''),
        count: cobrosSinBanco?.total ?? 0,
        cobros: (cobrosSinBanco?.data ?? []).map((c) => ({
          tipo: c.tipo,
          id: c.id,
          folio: c.folio ?? null,
          grupo_folio: c.grupo_folio ?? null,
          fecha_cobro: c.fecha_cobro,
          monto: c.monto,
          moneda: c.moneda,
          metodo_cobro: c.metodo_cobro ?? null,
          // ADITIVOS (0.0.78, invariante 77): lo que ya vinculó el banco y
          // lo que falta (sin abonos: su neto), de `cobrosSinBanco`.
          parcial: c.parcial === true,
          faltante: c.faltante,
          monto_vinculado: c.monto_vinculado,
        })),
        por_moneda: cobrosSinBanco?.por_moneda ?? [],
        paywise: cobrosPaywiseSinBanco.length,
        // ADITIVO (0.0.78): cuántos de `count` son cobros PARCIALES.
        parciales: cobrosSinBanco?.parciales ?? 0,
      },
      {
        // VUELO completado sin NINGÚN gasto de pista (incluye CUN→CUN y
        // gastos de cualquier fecha). Hasta el 15-oct-2026 iba junto a
        // pistas_sin_gasto (por TRAMO), retirado: contaba por escala_id y la
        // oficina captura la cuota por vuelo_id. NO bloquea.
        clave: CLAVE_PRECIERRE_VUELOS_SIN_GASTO,
        titulo: TITULO_PRECIERRE_VUELOS_SIN_GASTO,
        detalle: sinGastoOps
          ? DETALLE_PRECIERRE_VUELOS_SIN_GASTO
          : DETALLE_PRECIERRE_VUELOS_SIN_GASTO_FALLIDA,
        count: sinGastoOps?.length ?? 0,
        // {id, folio, fecha_vuelo, matricula} por fecha_vuelo.
        vuelos: sinGastoOps ?? [],
        // ADITIVO: true cuando la lectura FALLÓ (el 0 no es «no hay»).
        lectura_fallida: sinGastoOps === null,
      },
      {
        // TUA PAGADA POR OPERACIÓN SIN TUA COBRADA (15-oct-2026, PEDIDO 4):
        // en la posición del retirado `tua_cobrada_sin_pagada`, justo
        // después de vuelos_sin_gasto_operaciones. NO bloquea.
        clave: CLAVE_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
        titulo: TITULO_PRECIERRE_TUA_PAGADA_SIN_COBRAR,
        detalle: inversos
          ? DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR
          : DETALLE_PRECIERRE_TUA_PAGADA_SIN_COBRAR_FALLIDA,
        count: inversos?.tua.length ?? 0,
        // Σ TUA pagada (IVA incluido) POR MONEDA del gasto: nunca sumadas.
        monto_mxn: round2(
          (inversos?.tua ?? []).reduce((a, v) => a + v.tua_pagada_mxn, 0),
        ),
        monto_usd: round2(
          (inversos?.tua ?? []).reduce((a, v) => a + v.tua_pagada_usd, 0),
        ),
        // {id, folio, fecha_vuelo, matricula, tua_pagada_mxn/usd,
        // pase_abordar, gastos_n} por fecha.
        vuelos: inversos?.tua ?? [],
        // ADITIVO: true cuando la lectura FALLÓ (el 0 no es «no hay»).
        lectura_fallida: inversos === null,
      },
      {
        // TRANSPORTE PAGADO SIN TRANSPORTE COTIZADO (15-oct-2026, PEDIDO 4):
        // SEÑAL de texto, justo después del anterior. NO bloquea.
        clave: CLAVE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
        titulo: TITULO_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR,
        detalle: inversos
          ? DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR
          : DETALLE_PRECIERRE_TRANSPORTE_PAGADO_SIN_COTIZAR_FALLIDA,
        count: inversos?.transporte.length ?? 0,
        // Σ lo pagado POR MONEDA del gasto: nunca sumadas.
        monto_mxn: round2(
          (inversos?.transporte ?? []).reduce((a, v) => a + v.monto_mxn, 0),
        ),
        monto_usd: round2(
          (inversos?.transporte ?? []).reduce((a, v) => a + v.monto_usd, 0),
        ),
        // {id, folio, fecha_vuelo, matricula, monto_mxn/usd, gastos[]}.
        vuelos: inversos?.transporte ?? [],
        lectura_fallida: inversos === null,
      },
      {
        clave: 'externos_sin_honorario',
        titulo: 'Vuelos de piloto externo sin honorario capturado',
        detalle:
          'El pago del freelance es gasto directo del vuelo (categoría "Piloto externo"): captúralo en Gastos y lígalo al vuelo, o el reparto saldrá inflado.',
        count: externosSinHonorario,
        vuelos: externosSinHonorarioVuelos,
      },
      {
        // FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, invariante
        // 60): vuelos del periodo (cualquier estado) con algún cobro en
        // HSBC/Scotiabank (o transferencia/link HSBC/cheque sin cuenta) y
        // sin factura del servicio registrada. NO bloquea; la solicitud viva
        // solo informa (`solicitada`).
        clave: CLAVE_PRECIERRE_VUELOS_SIN_FACTURA,
        titulo: TITULO_PRECIERRE_VUELOS_SIN_FACTURA,
        detalle: sinFactura
          ? DETALLE_PRECIERRE_VUELOS_SIN_FACTURA
          : DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA,
        count: sinFactura?.length ?? 0,
        // {id, folio, fecha_vuelo, matricula, solicitada, cuentas}.
        vuelos: sinFactura ?? [],
        // ADITIVO: true cuando la lectura FALLÓ (el 0 no es «no hay»).
        lectura_fallida: sinFactura === null,
      },
      // Informativos (no bloquean): el dinero de vuelos cancelados YA cuenta
      // en el reparto; solo se pide confirmar que sea real.
      {
        clave: 'cobros_en_cancelados',
        titulo:
          'Vuelos cancelados con cobros retenidos (ya cuentan en el reparto)',
        detalle:
          'Cargo por cancelación o anticipo no reembolsado: entra íntegro como venta del avión (repartido entre los aviones si el vuelo voló en más de uno), sin saldo pendiente. Confirma que no se haya devuelto al cliente; si se devolvió, regístralo como reembolso en el detalle del vuelo (no elimines el cobro: el reembolso deja el rastro). «(diferencia cambiaria)»: el dinero ya se devolvió completo y lo que queda es la diferencia entre el T.C. del cobro y el del reembolso, que el reparto cuenta como venta; para que no cuente, captura el reembolso con el T.C. del cobro.',
        count: cobrosEnCancelados.length,
        monto_usd: round2(cobrosEnCanceladosUsd),
        vuelos: cobrosEnCancelados,
        // ADITIVO: el panel lo pinta como aviso informativo, no pendiente.
        informativo: true,
      },
      {
        clave: 'gastos_en_cancelados',
        titulo: 'Gastos ligados a vuelos cancelados (ya restan en el reparto)',
        detalle:
          'Se voló a recoger, ferry de regreso, pistas… son costo real del avión y ya se descuentan. Confirma que correspondan a algo que sí ocurrió: una pista provisionada de un vuelo que nunca despegó se borra en Gastos.',
        count: gastosEnCanceladosCount,
        vuelos: vuelosConGastoCancelado,
        informativo: true,
      },
      // Informativos (29-ago): lo que YA se convirtió con el TC oficial de
      // referencia del día (open.er-api / BCE). No bloquean: el dinero sí
      // está en el reparto y en el balance; capturar el TC lo sustituye.
      {
        clave: 'gastos_tc_oficial',
        titulo: 'Gastos MXN sin TC capturado (convertidos con el TC oficial)',
        detalle:
          'Se convierten con el TC oficial de referencia del día del gasto (open.er-api / BCE) y ya restan en el reparto y en el balance. Si quieres usar el TC real del pago, captúralo en Gastos.',
        count: sinTcConOficial.length,
        monto_mxn: sumaMxn(sinTcConOficial),
        informativo: true,
      },
      {
        clave: 'cobros_tc_oficial',
        titulo: 'Vuelos con cobros MXN sin TC (convertidos con el TC oficial)',
        detalle:
          'La cotización no trae tipo de cambio: sus cobros en pesos se convierten con el TC oficial de referencia del día de la cotización (open.er-api / BCE) y ya cuentan como cobrados. Capturar el TC en el vuelo o en el cobro lo sustituye.',
        count: cobrosTcOficialVuelos.length,
        vuelos: cobrosTcOficialVuelos,
        informativo: true,
      },
      {
        clave: 'gastos_sin_tc',
        titulo: 'Gastos MXN sin tipo de cambio',
        detalle:
          'Sin TC capturado ni TC oficial de referencia disponible para su fecha: quedan FUERA del balance USD hasta capturarles TC.',
        count: sinTcSinOficial.length,
        monto_mxn: sumaMxn(sinTcSinOficial),
        ...idsPrecierre(sinTcSinOficial),
      },
      {
        clave: 'cobros_sin_tc',
        titulo: 'Vuelos con cobros MXN sin tipo de cambio',
        detalle:
          'Cobros en pesos sin TC en el cobro, en la cotización ni TC oficial de referencia para su fecha: NO cuentan como cobrados hasta capturarles TC en el vuelo.',
        count: cobrosSinTcVuelos.length,
        monto_mxn: round2(cobrosSinTcMxn),
        vuelos: cobrosSinTcVuelos,
      },
      {
        clave: 'gastos_sin_comprobante',
        titulo: 'Gastos sin facturar (pendientes o solicitados)',
        detalle:
          'Sin factura en mano — márcalos con el semáforo en Gastos (los ' +
          'marcados "No requiere factura" ya NO cuentan aquí). El ' +
          'seguimiento arrancó en ago 2026: lo anterior nace "Pendiente".',
        count: sinFacturar.length,
        ...idsPrecierre(sinFacturar),
      },
      {
        clave: 'sin_conciliar',
        titulo: 'Movimientos bancarios sin conciliar',
        detalle: 'El estado de cuenta no cuadra contra lo capturado.',
        count: movs.length,
        monto: round2(movs.reduce((acc, m) => acc + Number(m.monto), 0)),
        // ids de MOVIMIENTO bancario (no de gasto): Conciliación → Pendientes.
        ...idsPrecierre(movs),
      },
      // OMITIDOS (14-oct-2026, invariante 75): INFORMATIVO, fuera de
      // `bloqueantes`. Los omitidos ya no cuentan en «sin conciliar»: aquí
      // se ve cuántos se marcaron «no se concilia» con su motivo.
      renglonOmitidosPreCierre(await omitidosPromesa),
    ];

    // Lo único que BLOQUEA números: vuelos sin completar, tacos amarillos,
    // gastos/cobros MXN que no convierten ni con el TC oficial (29-ago),
    // combustible sin avión (el gas del mes es por avión) y —desde el 0.0.77
    // (14-oct-2026, invariante 62)— permisos sin avión (el permiso lo carga
    // el avión) y —desde el 0.0.90 (16-oct-2026, invariante 91)— nómina sin
    // repartir. El resto es aviso (cobranza/conciliación son procesos).
    // Revisión del 19-oct-2026 (P3): un bloqueante que NO se pudo leer
    // (`lectura_fallida: true`; hoy `nomina_sin_repartir` y
    // `gastos_por_pagar`) tampoco deja cerrar: «0» sin verificar no es 0.
    const bloqueantes: readonly string[] = CLAVES_BLOQUEANTES_PRECIERRE;
    const listo = items
      .filter((i) => bloqueantes.includes(i.clave))
      .every(
        (i) =>
          i.count === 0 &&
          (i as { lectura_fallida?: unknown }).lectura_fallida !== true,
      );

    // CIERRE DE MES (invariante 89, ADITIVO): estado del mes y si se puede
    // cerrar (orden y estado; el pre-cierre decide `listo`).
    const cierre = contable
      ? await this.cierrePrecierre(mesContablePre, listo)
      : null;
    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      listo,
      ...(cierre ? { cierre } : {}),
      items,
    };
  }

  /**
   * Pre-cierre · NÓMINA SIN REPARTIR (16-oct-2026, API 0.0.90, invariante
   * 91): de las NÓMINA ya leídas del periodo, las que no tienen NINGUNA fila
   * en `gasto_reparto`. Nunca lanza: un error de lectura ⇒ null (el renglón
   * sale «No se pudo verificar…» con `lectura_fallida`).
   */
  private async nominaSinRepartirPrecierre(
    nomina: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>> | null> {
    if (nomina.length === 0) return [];
    try {
      const con = await gastosConReparto(
        this.supabase.service,
        nomina.map((g) => String(g.id)),
      );
      return nomina.filter((g) => !con.has(String(g.id)));
    } catch (err) {
      this.logger.warn(
        `pre-cierre: no se pudo verificar la nómina sin repartir: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pre-cierre · GASTOS «POR PAGAR» SIN CONFIRMAR (19-oct-2026, API 0.0.95,
   * invariante 93): los por pagar VIGENTES (`estadoPagoGasto` ≠ PAGADO:
   * `por_pagar` y sin conciliar) de ESTE periodo por su MES CONTABLE
   * (revisión P1 del 19-oct-2026: la regla del candado de mes cerrado —eje
   * vuelo ⇒ el mes contable del vuelo; eje gasto ⇒ `fecha_gasto`—; antes
   * filtraba por `fecha_gasto` y un por pagar de un vuelo de M fechado en
   * M+1 no frenaba el cierre de M). Lee TODOS los vigentes (son pocos: se
   * resuelven al marcarlos pagados) con su vuelo embebido, por páginas de
   * 1000 ordenadas por id, y decide la pertenencia en JS. `disponible` = la
   * sonda (la usa P4). Sin la migración ⇒ [] (no nombra la columna). Nunca
   * lanza: un error ⇒ `lista: null` (`lectura_fallida`).
   */
  private async gastosPorPagarPrecierre(
    desde: string,
    hasta: string,
    hoy: string,
    contable: boolean,
  ): Promise<{
    disponible: boolean;
    lista: Array<Record<string, unknown>> | null;
  }> {
    const sb = this.supabase.service;
    let disponible = false;
    try {
      disponible = await porPagarDisponible(sb);
      if (!disponible) return { disponible, lista: [] };
      const out: Array<Record<string, unknown>> = [];
      for (let pagina = 0; ; pagina += 1) {
        if (pagina >= LOTE_PAGINADO_MAX_PAGINAS) {
          throw new Error(
            `más de ${LOTE_PAGINADO_MAX_PAGINAS * PAGINA_POSTGREST} gastos por pagar`,
          );
        }
        const ini = pagina * PAGINA_POSTGREST;
        const { data, error } = await sb
          .from('gasto')
          .select(selectPorPagarPrecierre(colsVueloContable(contable)))
          .eq('por_pagar', true)
          .eq('conciliado', false)
          .order('id', { ascending: true })
          .range(ini, ini + PAGINA_POSTGREST - 1);
        if (error) throw new Error(error.message);
        const filas = (data ?? []) as unknown as Array<Record<string, unknown>>;
        out.push(...filas);
        if (filas.length < PAGINA_POSTGREST) break;
      }
      return {
        disponible,
        lista: out.filter(
          (g) =>
            porPagarVigente(g, hoy) &&
            porPagarEnPeriodoContable(g, desde, hasta),
        ),
      };
    } catch (err) {
      this.logger.warn(
        `pre-cierre: no se pudieron verificar los gastos por pagar: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { disponible, lista: null };
    }
  }

  /**
   * Pre-cierre · VUELOS QUE VIENEN DE MESES ANTERIORES (16-oct-2026,
   * invariante 89): los diferidos a este periodo por un cierre (suman aquí
   * completos). INFORMATIVO, sin `ids` (trae `vuelos[]`).
   */
  private async itemVuelosQueVienen(
    vuelos: Array<Record<string, unknown>>,
    desde: string,
    hasta: string,
  ) {
    const venidos = vuelos.filter(
      (v) =>
        papelContableEnPeriodo(
          v as {
            fecha_vuelo?: string | null;
            periodo_contable?: string | null;
          },
          desde,
          hasta,
        ) === 'viene',
    );
    const bitacora = await leerDiferimientos(
      this.supabase.service,
      venidos.map((v) => v.id as string),
    );
    const lista = venidos
      .map((v) => {
        const vv = v as {
          id: string;
          fecha_vuelo?: string | null;
          periodo_contable?: string | null;
          fecha_contable?: string | null;
        };
        const mes = mesContableDeVuelo(vv);
        const origen = mes ? origenDeVuelo(vv, mes, bitacora) : null;
        return {
          id: vv.id,
          folio: Number(v.folio),
          fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
          origen,
          leyenda: origen ? leyendaVieneDe(origen) : 'Viene de otro mes',
        };
      })
      .sort((a, b) => a.folio - b.folio);
    return {
      clave: 'vuelos_que_vienen',
      titulo: 'Vuelos que vienen de meses anteriores',
      detalle:
        'Se cerró su mes con el cobro pendiente: cuentan completos en este mes (venta, gastos y comisiones); sus horas se quedan en el mes en que volaron.',
      count: lista.length,
      vuelos: lista,
      informativo: true as const,
    };
  }

  /**
   * Pre-cierre · bloque ADITIVO `cierre` (invariante 89): estado del mes,
   * quién lo cerró y si ya se puede cerrar (orden + `listo`).
   */
  private async cierrePrecierre(mes: string | null, listo: boolean) {
    const filas = await leerCierresMes(this.supabase.service);
    const fila = mes ? (filas.find((f) => f.periodo === mes) ?? null) : null;
    const cerrados = new Set(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    const inicio = await inicioOficialDe(this.configuracion);
    const motivo = mes
      ? motivoNoCerrable({
          mes,
          mesEnCurso: hoyCancun(this.ahora()).slice(0, 7),
          mesInicio: inicio ? inicio.slice(0, 7) : null,
          cerrados,
          listo,
        })
      : null;
    return {
      disponible: true as const,
      periodo: mes,
      estado: fila?.estado ?? ('ABIERTO' as const),
      cerrado_at: fila?.cerrado_at ?? null,
      cerrado_por_nombre: fila?.cerrado_por?.nombre ?? null,
      puede_cerrar: mes != null && motivo == null,
      motivo_no_cerrable: motivo,
      roles_cierran: ['ADMIN', 'FACTURACION'],
    };
  }

  /**
   * Pre-cierre · SEGUIMIENTO DE LA COTIZACIÓN (29-sep-2026): notas PENDIENTE
   * con `afecta_cotizacion`, NO borradas, de vuelos cuya `fecha_vuelo` cae en
   * el periodo (cortes Cancún, invariante 4; TODOS los estados: una nota
   * pendiente en un vuelo cancelado también hay que cerrarla a mano).
   * Tabla ausente (migración 20260929000002 sin aplicar) ⇒ resumen vacío;
   * cualquier otro fallo ⇒ `null` + `warn` (no tumba el pre-cierre).
   */
  /**
   * Pre-cierre · GASTOS EN DÓLARES CON UN T.C. FUERA DE LUGAR (13-oct-2026,
   * invariante 70): la lectura y la regla son de conciliación
   * (`ligasUsdTcFueraDeLugar`). Un stub viejo sin el método, un null o una
   * excepción ⇒ null (el renglón sale «sin verificar»); nunca lanza.
   */
  /**
   * Pre-cierre · MOVIMIENTOS OMITIDOS (14-oct-2026, invariante 75): lo lee
   * `ConciliacionService.omitidosDelPeriodo` (nunca lanza). Sin el método
   * (stub de un spec) o con error ⇒ null ⇒ `lectura_fallida`.
   */
  private async omitidosPrecierre(
    desde: string,
    hasta: string,
  ): Promise<OmitidosPeriodo | null> {
    const conciliacion = this
      .conciliacion as Partial<ConciliacionService> | null;
    if (typeof conciliacion?.omitidosDelPeriodo !== 'function') return null;
    try {
      return await conciliacion.omitidosDelPeriodo(desde, hasta);
    } catch (err) {
      this.logger.warn(
        `pre-cierre: omitidos de la conciliación no disponibles: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pre-cierre · TACÓMETROS OMITIDOS (15-oct-2026, invariante 79): tramos
   * vivos de vuelos NO cancelados del periodo con `taco_omitido_at`. Detrás
   * de la sonda (REGLA DURA: sin la migración no se nombra la columna ⇒ `[]`,
   * que es la verdad). Best-effort: cualquier fallo ⇒ `null` + warn
   * (`lectura_fallida`), nunca tumba el pre-cierre.
   */
  private async tacosOmitidosPrecierre(
    desdeTs: string,
    hastaTs: string,
  ): Promise<EscalaOmitidaRow[] | null> {
    try {
      const sb = this.supabase.service;
      if (!(await tacoOmitidoDisponible(sb))) return [];
      const { data, error } = await sb
        .from('escala')
        .select(
          'id, vuelo_id, orden, origen_iata, destino_iata, fecha_salida_plan, piloto_id, taco_omitido_at, taco_omitido_por, taco_omitido_motivo, vuelo:vuelo_id!inner(id, folio, fecha_vuelo, estado, piloto_id)',
        )
        .not('taco_omitido_at', 'is', null)
        .is('cancelada_at', null)
        .neq('vuelo.estado', 'CANCELADO')
        // eje REAL a propósito (invariante 89): tacómetros omitidos (horas)
        .gte('vuelo.fecha_vuelo', desdeTs)
        .lte('vuelo.fecha_vuelo', hastaTs);
      if (error) throw new Error(error.message);
      return (data ?? []) as EscalaOmitidaRow[];
    } catch (err) {
      this.logger.warn(
        `pre-cierre: tacómetros omitidos no disponibles: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async ligasUsdTcPrecierre(
    desde: string,
    hasta: string,
  ): Promise<ResultadoLigasUsdTc | null> {
    const conciliacion = this
      .conciliacion as Partial<ConciliacionService> | null;
    if (typeof conciliacion?.ligasUsdTcFueraDeLugar !== 'function') return null;
    try {
      return await conciliacion.ligasUsdTcFueraDeLugar(desde, hasta);
    } catch (err) {
      this.logger.warn(
        `pre-cierre: ligas USD por T.C. no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async seguimientoCotizacionPendiente(
    desdeTs: string,
    hastaTs: string,
    contable = false,
  ): Promise<ReturnType<typeof resumenPrecierreSeguimiento> | null> {
    // CIERRE DE MES (invariante 89): las notas siguen al DINERO del vuelo
    // (mes contable); sin la migración, `fecha_vuelo`.
    const colEmbed = colPeriodoContable(contable, 'vuelo');
    try {
      // PAGINADA (revisión adversaria 29-sep-2026): PostgREST corta en
      // max-rows = 1000 SIN avisar y el `.limit(5000)` no lo evita; con más
      // notas el aviso contaría menos vuelos de los que hay. Orden TOTAL por
      // id para que las páginas no se traslapen; tope de páginas ⇒ lectura
      // fallida (jamás un conteo recortado presentado como completo).
      const filas: SeguimientoPrecierreRow[] = [];
      for (let pagina = 0; ; pagina += 1) {
        if (pagina >= SEGUIMIENTO_PRECIERRE_MAX_PAGINAS) {
          throw new Error(
            `más de ${SEGUIMIENTO_PRECIERRE_MAX_PAGINAS * SEGUIMIENTO_PRECIERRE_PAGINA} notas pendientes en el periodo`,
          );
        }
        const desde = pagina * SEGUIMIENTO_PRECIERRE_PAGINA;
        const { data, error } = await this.supabase.service
          .from('vuelo_seguimiento')
          .select(
            'id, vuelo_id, vuelo:vuelo_id!inner(id, folio, estado, fecha_vuelo)',
          )
          .eq('estado', 'PENDIENTE')
          .eq('afecta_cotizacion', true)
          .is('deleted_at', null)
          .gte(colEmbed, desdeTs)
          .lte(colEmbed, hastaTs)
          .order('id', { ascending: true })
          .range(desde, desde + SEGUIMIENTO_PRECIERRE_PAGINA - 1);
        if (error) {
          if (esTablaInexistente(error)) {
            return resumenPrecierreSeguimiento([]);
          }
          throw new Error(error.message);
        }
        const chunk = (data ?? []) as SeguimientoPrecierreRow[];
        filas.push(...chunk);
        if (chunk.length < SEGUIMIENTO_PRECIERRE_PAGINA) break;
      }
      return resumenPrecierreSeguimiento(filas);
    } catch (err) {
      this.logger.warn(
        `pre-cierre: seguimiento de la cotización no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pre-cierre · VUELOS COMPLETADOS SIN GASTO DE OPERACIONES (5-oct-2026):
   * de los `candidatos` (propios con avión, cliente interno y servicio
   * incluidos — `candidatosSinGastoOperaciones`) quita los que tienen algún
   * gasto OPERACIONES/ATERRIZAJE ligado por `vuelo_id` (de CUALQUIER fecha).
   * Lectura en lotes de ids y paginada (anti-cap-1000 de PostgREST: un vuelo
   * cuyo gasto quedara pasada la fila 1000 saldría «sin gasto» en falso).
   * Cualquier fallo ⇒ `null` + `warn` (no tumba el pre-cierre).
   */
  private async vuelosSinGastoOperaciones(
    candidatos: VueloCompletadoSinGastoRow[],
    matriculas: ReadonlyMap<string, string>,
  ): Promise<VueloSinGastoOperaciones[] | null> {
    if (candidatos.length === 0) return [];
    try {
      const ids = candidatos.map((v) => v.id as string);
      const gastosOps = await this.leerEnLotesPaginado(
        ids,
        (lote, desde, hasta) =>
          this.supabase.service
            .from('gasto')
            .select('id, vuelo_id')
            .in('vuelo_id', lote)
            .in('categoria', [...CATEGORIAS_GASTO_OPERACIONES])
            .order('id', { ascending: true })
            .range(desde, hasta),
      );
      return vuelosSinGastoOperaciones({
        candidatos,
        vuelosConGasto: new Set(
          gastosOps
            .map((g) => g.vuelo_id)
            .filter((id): id is string => typeof id === 'string'),
        ),
        matriculas,
      });
    } catch (err) {
      this.logger.warn(
        `pre-cierre: vuelos sin gasto de operaciones no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pre-cierre · RENGLONES INVERSOS (15-oct-2026, PEDIDO 4): TUA pagada sin
   * cobrar (`vuelosConTuaPagadaSinCobrar`) y transporte pagado sin cotizar
   * (`vuelosConTransportePagadoSinCotizar`) sobre los MISMOS candidatos
   * (`candidatosPrecierreInversos`). UNA lectura de gastos por `vuelo_id`
   * (lotes ≤ 200, paginada anti-cap-1000, `order id asc`), de CUALQUIER
   * fecha (la factura del aeropuerto llega días después) y SIN filtro de
   * categoría (las reglas viven en los utils; filtrar enums en la consulta
   * arriesga un 22P02). `moneda` y `lugar` solo se seleccionan; la columna
   * `tua_incluida` va detrás de la sonda (invariante 66). Hijos de GRUPO:
   * una lectura más de `vuelo_grupo.extras_grupo` (solo si hay candidatos
   * con `grupo_id`): el extra de transporte con reparto ANCLA vive solo en
   * el hijo ancla (revisión 0.0.81). Cualquier fallo ⇒ `null` + `warn` (los
   * DOS renglones salen «sin verificar»; no tumba el pre-cierre).
   */
  private async inversosPrecierre(
    candidatos: VueloCandidatoInverso[],
    matriculas: ReadonlyMap<string, string>,
  ): Promise<{
    tua: VueloTuaPagadaSinCobrar[];
    transporte: VueloTransporteSinCotizar[];
  } | null> {
    if (candidatos.length === 0) return { tua: [], transporte: [] };
    try {
      const colTua = colTuaIncluida(
        await tuaIncluidaDisponible(this.supabase.service),
      );
      const gastos = await this.leerEnLotesPaginado(
        candidatos.map((c) => c.id),
        (lote, desde, hasta) =>
          this.supabase.service
            .from('gasto')
            .select(
              `id, vuelo_id, categoria, monto, moneda, propina, lugar, notas, valor_ia_extraido${colTua}`,
            )
            .in('vuelo_id', lote)
            .order('id', { ascending: true })
            .range(desde, hasta),
      );
      const grupoIds = [
        ...new Set(
          candidatos
            .map((c) => c.grupo_id)
            .filter((g): g is string => typeof g === 'string' && g !== ''),
        ),
      ];
      const extrasGrupo = new Map<string, unknown>();
      if (grupoIds.length > 0) {
        const grupos = await this.leerEnLotesPaginado(
          grupoIds,
          (lote, desde, hasta) =>
            this.supabase.service
              .from('vuelo_grupo')
              .select('id, extras_grupo')
              .in('id', lote)
              .order('id', { ascending: true })
              .range(desde, hasta),
        );
        for (const g of grupos) {
          if (typeof g.id === 'string') extrasGrupo.set(g.id, g.extras_grupo);
        }
      }
      return {
        tua: vuelosConTuaPagadaSinCobrar({ candidatos, gastos, matriculas }),
        transporte: vuelosConTransportePagadoSinCotizar({
          candidatos,
          gastos,
          matriculas,
          extrasGrupo,
        }),
      };
    } catch (err) {
      this.logger.warn(
        `pre-cierre: renglones inversos (TUA pagada / transporte) no disponibles: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Pre-cierre · VUELOS COBRADOS EN CUENTAS QUE EXIGEN FACTURA SIN FACTURA
   * REGISTRADA (13-oct-2026, invariante 60): sobre TODOS los vuelos del
   * periodo que ya lee el pre-cierre (pendientes + completados +
   * cancelados), con el lector único `facturasDeVuelos` (4 consultas por
   * cada 200 vuelos, la de `cobro_vuelo` PAGINADA: anti-cap-1000). El
   * filtro, el shape y el orden viven en `vuelos-sin-factura.util`.
   * Cualquier fallo ⇒ `null` + `warn` (no tumba el pre-cierre).
   */
  private async vuelosCobradosSinFactura(
    vuelos: ReadonlyArray<VueloCobradoRow>,
    matriculas: ReadonlyMap<string, string>,
  ): Promise<VueloCobradoSinFactura[] | null> {
    if (vuelos.length === 0) return [];
    try {
      const ids = vuelos
        .map((v) => v.id)
        .filter((id): id is string => typeof id === 'string' && id !== '');
      const facturas = await facturasDeVuelos(this.supabase.service, ids);
      return vuelosCobradosSinFactura({ vuelos, facturas, matriculas });
    } catch (err) {
      this.logger.warn(
        `pre-cierre: vuelos cobrados sin factura no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * `in (…)` en lotes de ≤ 200 ids y cada lote PAGINADO de 1000 en 1000
   * (PostgREST corta en max-rows = 1000 sin avisar). La consulta debe
   * ordenar por una llave TOTAL (id) para que las páginas no se traslapen.
   * Más de `LOTE_PAGINADO_MAX_PAGINAS` páginas en un lote ⇒ error (jamás
   * una lectura recortada presentada como completa).
   */
  private async leerEnLotesPaginado(
    ids: ReadonlyArray<string>,
    consulta: (
      lote: string[],
      desde: number,
      hasta: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += LOTE_IDS) {
      const lote = unicos.slice(i, i + LOTE_IDS);
      for (let pagina = 0; ; pagina += 1) {
        if (pagina >= LOTE_PAGINADO_MAX_PAGINAS) {
          throw new Error(
            `más de ${LOTE_PAGINADO_MAX_PAGINAS * PAGINA_POSTGREST} filas en un lote`,
          );
        }
        const desde = pagina * PAGINA_POSTGREST;
        const { data, error } = await consulta(
          lote,
          desde,
          desde + PAGINA_POSTGREST - 1,
        );
        if (error) throw new Error(error.message);
        const filas = (data ?? []) as Array<Record<string, unknown>>;
        out.push(...filas);
        if (filas.length < PAGINA_POSTGREST) break;
      }
    }
    return out;
  }

  /**
   * Pre-cierre · CUENTAS DE LOS SOCIOS (v2, 2-oct-2026, invariante 38):
   *  - `socios_por_entregar`: socios con saldo > $1.00 contando las
   *    utilidades HASTA el mes del cierre (inclusive) y TODAS las entregas
   *    registradas hoy (una entrega de octubre por la utilidad de septiembre
   *    sí limpia septiembre). Solo socios cuya cuenta ya había arrancado.
   *  - `socios_adelantados`: socios cuyo saldo SIN el mes en curso (meses
   *    cerrados + todas las entregas; `mesHastaAdelantosPrecierre`) es
   *    < −$1.00 — el MISMO número del candado del adelanto (409), para que
   *    entregar lo que dice «por entregar» no los marque como adelantados.
   * Las utilidades salen de `utilidadesSociosPorMes` (la MISMA memoria que
   * las cuentas). NO bloquean. Sin la migración o con CUALQUIER fallo ⇒
   * count 0 con `lectura_fallida: true` y un texto que lo dice (jamás «no
   * hay pendientes» sin haber leído); con la lectura fallida no se emite el
   * de adelantados (el principal ya dice «sin verificar»).
   */
  private async itemsCuentasSocios(
    mes: string,
  ): Promise<ItemPrecierreCuentasSocios[]> {
    const base = {
      clave: CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR,
      titulo: TITULO_PRECIERRE_SOCIOS_POR_ENTREGAR,
      mes,
    };
    const fallida = (
      detalle: string,
      disponible: boolean,
    ): ItemPrecierreCuentasSocios => ({
      ...base,
      detalle,
      count: 0,
      monto_mxn: 0,
      socios: [] as ResumenPrecierreCuentas['por_entregar']['socios'],
      lectura_fallida: true,
      disponible,
    });
    try {
      const lector = lectorCuentaSocios(this.supabase.service);
      if (!(await lector.disponible())) {
        return [fallida(DETALLE_PRECIERRE_CUENTAS_NO_DISPONIBLE, false)];
      }
      const u = await lector.universo();
      if (u === SIN_MIGRACION) {
        return [fallida(DETALLE_PRECIERRE_CUENTAS_NO_DISPONIBLE, false)];
      }
      const ahora = this.ahora();
      const mesActual = mesActualCancun(ahora);
      const socios = armarSociosBase({
        sociosAeronave: u.sociosAeronave,
        cuentas: u.cuentas,
        sociosConEntregas: u.entregas.map((p) => p.socio_id),
        usuarios: u.usuarios,
        aeronaves: u.aeronaves,
        hoy: hoyCancun(ahora),
      });
      const desdeMin = socios.reduce(
        (min, s) => (s.cuenta.cuenta_desde < min ? s.cuenta.cuenta_desde : min),
        mesActual,
      );
      const utilidades =
        socios.length === 0
          ? []
          : await this.utilidadesSociosPorMes(
              mesesEntre(desdeMin, mesActual),
              mesActual,
            );
      const pagos = u.entregas.map((r) => aPagoSocio(r));
      const mesRevision = mes > mesActual ? mesActual : mes;
      const mesAdelantos = mesHastaAdelantosPrecierre(mesRevision, mesActual);
      const filas: Array<{
        socio: { id: string; nombre: string; es_empresa: boolean };
        por_entregar_hasta_mes_mxn: number;
        por_entregar_cerrado_mxn: number;
      }> = [];
      let sinCuenta = 0;
      for (const s of socios) {
        if (s.cuenta.cuenta_desde > mesRevision) {
          sinCuenta += 1;
          continue;
        }
        const entrada = {
          socioId: s.socio.id,
          cuenta: s.cuenta,
          utilidades,
          pagos,
        };
        const hastaMes = movimientosDeCuenta({
          ...entrada,
          utilidadesHasta: mesRevision,
        });
        const cerrado = movimientosDeCuenta({
          ...entrada,
          utilidadesHasta: mesAdelantos,
        });
        filas.push({
          socio: {
            id: s.socio.id,
            nombre: s.socio.nombre,
            es_empresa: s.socio.es_empresa,
          },
          por_entregar_hasta_mes_mxn: hastaMes[hastaMes.length - 1].saldo_mxn,
          por_entregar_cerrado_mxn: cerrado[cerrado.length - 1].saldo_mxn,
        });
      }
      const r = resumenPrecierreCuentas({
        mes,
        filas,
        sin_cuenta_en_mes: sinCuenta,
      });
      return [
        {
          ...base,
          detalle: r.por_entregar.detalle,
          count: r.por_entregar.count,
          monto_mxn: r.por_entregar.monto_mxn,
          socios: r.por_entregar.socios,
          lectura_fallida: false,
          disponible: true,
        },
        {
          clave: CLAVE_PRECIERRE_SOCIOS_ADELANTADOS,
          titulo: TITULO_PRECIERRE_SOCIOS_ADELANTADOS,
          mes,
          detalle: r.adelantados.detalle,
          count: r.adelantados.count,
          monto_mxn: r.adelantados.monto_mxn,
          socios: r.adelantados.socios,
          lectura_fallida: false,
          disponible: true,
        },
      ];
    } catch (err) {
      this.logger.warn(
        `pre-cierre: cuentas de los socios no disponibles: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [fallida(DETALLE_PRECIERRE_CUENTAS_LECTURA_FALLIDA, true)];
    }
  }

  // ============ fetchers ============

  // ===================================================================
  // PANTALLA POR AVIÓN (20-oct-2026, invariante 99)
  // ===================================================================

  /** Entregas VIVAS «corresponde a» este avión, como `PagoSocio` con nombres. */
  private async entregasDelAvion(
    aeronaveId: string,
    actor?: Pick<AuthenticatedUser, 'rol' | 'userId'>,
  ): Promise<PagoSocio[]> {
    const lector = lectorCuentaSocios(this.supabase.service);
    if (!(await lector.disponible())) return [];
    const vivas = await lector.entregasVivas();
    if (vivas === SIN_MIGRACION) return [];
    // SOCIO: solo las suyas (la misma regla de `GET pagos`).
    const propias = vivas.filter(
      (r) =>
        r.aeronave_id === aeronaveId &&
        (actor?.rol !== Rol.SOCIO || r.socio_id === actor.userId),
    );
    if (propias.length === 0) return [];
    const ids = [
      ...new Set(
        propias.flatMap((r) =>
          [r.entregado_por, r.created_by, r.updated_by].filter(
            (x): x is string => !!x,
          ),
        ),
      ),
    ];
    const [nombres, matriculas] = await Promise.all([
      this.fetchNombres(ids),
      this.fetchMatriculas(),
    ]);
    return propias.map((r) => aPagoSocio(r, nombres, new Map(), matriculas));
  }

  /**
   * Mes al que se ACREDITA una entrega: «corresponde a» o el de su fecha.
   * Fuente única `mesAcreditadoDeEntrega` (la comparte el balance por avión
   * y general, invariante 100).
   */
  private static mesDeEntrega(p: PagoSocio): string {
    return mesAcreditadoDeEntrega(p);
  }

  /**
   * `GET /v1/profit-sharing/aviones/:id?desde&hasta`: el reparto de UN avión
   * con el detalle gasto por gasto (`detalle.gastos[]`), las entregas que
   * «corresponden» a ese avión en los meses del periodo y, por socio, lo
   * generado / lo entregado / lo por entregar DE ESE AVIÓN (pesos). Es la
   * pantalla que sustituye a la card del reparto.
   */
  async avionDetalle(
    aeronaveId: string,
    q: ProfitSharingQuery,
    actor?: Pick<AuthenticatedUser, 'rol' | 'userId'>,
  ) {
    const r = await this.compute(
      { desde: q.desde, hasta: q.hasta, aeronave_id: aeronaveId },
      { detalleGastos: true },
    );
    const avion = r.aviones.find((a) => a.aeronave.id === aeronaveId);
    if (!avion) {
      throw new NotFoundException({
        message: 'Ese avión no existe o está dado de baja.',
        error: 'AERONAVE_NO_EXISTE',
        details: { aeronave_id: aeronaveId },
      });
    }
    const meses = new Set(
      mesesEntre(r.periodo.desde.slice(0, 7), r.periodo.hasta.slice(0, 7)),
    );
    const entregas = (await this.entregasDelAvion(aeronaveId, actor)).filter(
      (p) => meses.has(ProfitSharingService.mesDeEntrega(p)),
    );
    const entregadoPorSocio = new Map<string, number>();
    for (const p of entregas) {
      entregadoPorSocio.set(
        p.socio_id,
        round2((entregadoPorSocio.get(p.socio_id) ?? 0) + p.monto_mxn),
      );
    }
    // SOCIO: su renglón y sus entregas (como en «Pagos a socios»).
    const soloSocio = actor?.rol === Rol.SOCIO ? actor.userId : null;
    const socios = avion.reparto
      .filter((s) => soloSocio === null || s.socio_id === soloSocio)
      .map((s) => {
        const entregado = entregadoPorSocio.get(s.socio_id) ?? 0;
        return {
          socio_id: s.socio_id,
          socio_nombre: s.socio_nombre,
          porcentaje: s.porcentaje,
          utilidad_mxn: s.utilidad_mxn,
          reserva_mxn: s.reserva_mxn,
          descuenta_reserva: s.descuenta_reserva,
          monto_mxn: s.monto_mxn,
          entregado_mxn: entregado,
          por_entregar_mxn: round2(s.monto_mxn - entregado),
          // Informativos en dólares.
          monto_usd: s.monto_usd,
          reserva_usd: s.reserva_usd,
        };
      });
    return {
      periodo: r.periodo,
      reparto_en_pesos: true as const,
      reparto_como_balance: true as const,
      avion,
      socios,
      entregas: [...entregas].sort(
        (a, b) =>
          b.fecha_pago.localeCompare(a.fecha_pago) ||
          b.created_at.localeCompare(a.created_at),
      ),
      ...('cierre' in r && r.cierre ? { cierre: r.cierre } : {}),
      tc_oficial: r.tc_oficial,
      gastos_sin_tc: r.gastos_sin_tc,
    };
  }

  /** `GET …/historico` con sus defaults: del inicio oficial al mes en curso. */
  async avionHistoricoDefault(
    aeronaveId: string,
    q: { desde?: string; hasta?: string },
    actor?: Pick<AuthenticatedUser, 'rol' | 'userId'>,
  ) {
    const mesActual = mesActualCancun(this.ahora());
    const inicio = await inicioOficialDe(this.configuracion);
    const desde = q.desde ?? (inicio ? inicio.slice(0, 7) : mesActual);
    const hasta = q.hasta ?? mesActual;
    return this.avionHistorico(aeronaveId, desde, hasta, actor);
  }

  /**
   * `GET /v1/profit-sharing/aviones/:id/historico?desde=AAAA-MM&hasta=AAAA-MM`:
   * la cascada EN PESOS de ese avión mes a mes (un compute por mes, como la
   * cuenta corriente), lo que generó cada socio y lo que se le entregó de
   * ese avión en cada mes, y los acumulados del rango.
   */
  async avionHistorico(
    aeronaveId: string,
    desdeMes: string,
    hastaMes: string,
    actor?: Pick<AuthenticatedUser, 'rol' | 'userId'>,
  ) {
    const soloSocio = actor?.rol === Rol.SOCIO ? actor.userId : null;
    const meses = mesesEntre(desdeMes, hastaMes);
    if (meses.length === 0 || meses.length > 36) {
      throw new BadRequestException({
        message:
          'El rango de meses no es válido (desde ≤ hasta, máximo 36 meses).',
        error: 'RANGO_INVALIDO',
        details: { desde: desdeMes, hasta: hastaMes },
      });
    }
    const mesActual = mesActualCancun(this.ahora());
    const entregas = await this.entregasDelAvion(aeronaveId, actor);
    const porMes: Array<Record<string, unknown>> = [];
    let aeronave: { id: string; matricula: string; modelo: string } | null =
      null;
    const acumulado = new Map<
      string,
      {
        socio_nombre: string;
        generado_mxn: number;
        reserva_mxn: number;
        entregado_mxn: number;
      }
    >();
    const totales: Record<string, number> = {
      horas_voladas_hr: 0,
      vuelos: 0,
      cobrado_mxn: 0,
      pendiente_cobro_mxn: 0,
      comisiones_mxn: 0,
      directos_mxn: 0,
      indirectos_mxn: 0,
      permisos_mxn: 0,
      otros_mxn: 0,
      afac_mxn: 0,
      otros_ingresos_mxn: 0,
      saldo_mxn: 0,
      reserva_mxn: 0,
      reserva_retenida_mxn: 0,
      entregado_mxn: 0,
      pesos_sin_tc_usd: 0,
      saldo_usd: 0,
    };
    for (const mes of meses) {
      if (mes > mesActual) break;
      const { desde, hasta } = rangoDeMes(mes);
      const r = await this.compute({ desde, hasta, aeronave_id: aeronaveId });
      const a = r.aviones.find((x) => x.aeronave.id === aeronaveId);
      if (!a) continue;
      aeronave = a.aeronave;
      const entregasMes = entregas.filter(
        (p) => ProfitSharingService.mesDeEntrega(p) === mes,
      );
      const numeros: Record<string, number> = {
        horas_voladas_hr: a.horas_voladas_hr,
        vuelos: a.ingresos.vuelos_cobrados + a.ingresos.vuelos_pendientes,
        cobrado_mxn: a.ingresos.cobrado_mxn,
        pendiente_cobro_mxn: a.ingresos.pendiente_cobro_mxn,
        comisiones_mxn: a.ingresos.comisiones_venta_mxn,
        directos_mxn: a.gastos.directos_mxn,
        indirectos_mxn: a.gastos.indirectos_mxn,
        permisos_mxn: a.gastos.permisos_mxn,
        otros_mxn: a.gastos.otros_prorrateados_mxn,
        afac_mxn: a.afac_reservado_mxn,
        otros_ingresos_mxn: a.ingresos.otros_ingresos_avion_mxn,
        saldo_mxn: a.saldo_disponible_mxn,
        reserva_mxn: a.reserva_overhaul_mxn,
        reserva_retenida_mxn: a.reserva_retenida_mxn,
        entregado_mxn: round2(
          entregasMes.reduce((acc, p) => acc + p.monto_mxn, 0),
        ),
        pesos_sin_tc_usd: a.pesos_sin_tc_usd,
        saldo_usd: a.saldo_disponible_usd,
      };
      for (const k of Object.keys(totales)) {
        totales[k] = round2(totales[k] + (numeros[k] ?? 0));
      }
      const reparto = a.reparto
        .filter((s) => soloSocio === null || s.socio_id === soloSocio)
        .map((s) => ({
          socio_id: s.socio_id,
          socio_nombre: s.socio_nombre,
          porcentaje: s.porcentaje,
          utilidad_mxn: s.utilidad_mxn,
          reserva_mxn: s.reserva_mxn,
          descuenta_reserva: s.descuenta_reserva,
          monto_mxn: s.monto_mxn,
          entregado_mxn: round2(
            entregasMes
              .filter((p) => p.socio_id === s.socio_id)
              .reduce((acc, p) => acc + p.monto_mxn, 0),
          ),
        }));
      for (const sr of reparto) {
        const acc = acumulado.get(sr.socio_id) ?? {
          socio_nombre: sr.socio_nombre,
          generado_mxn: 0,
          reserva_mxn: 0,
          entregado_mxn: 0,
        };
        acc.generado_mxn = round2(acc.generado_mxn + sr.monto_mxn);
        acc.reserva_mxn = round2(acc.reserva_mxn + sr.reserva_mxn);
        acc.entregado_mxn = round2(acc.entregado_mxn + sr.entregado_mxn);
        acumulado.set(sr.socio_id, acc);
      }
      porMes.push({
        mes,
        en_curso: mes === mesActual,
        ...numeros,
        reparto,
        ...('cierre' in r && r.cierre
          ? { cierre_estado: r.cierre.estado ?? null }
          : {}),
      });
    }
    if (!aeronave) {
      const [sola] = await this.fetchAeronaves(aeronaveId);
      if (!sola) {
        throw new NotFoundException({
          message: 'Ese avión no existe o está dado de baja.',
          error: 'AERONAVE_NO_EXISTE',
          details: { aeronave_id: aeronaveId },
        });
      }
      aeronave = {
        id: sola.id,
        matricula: sola.matricula,
        modelo: sola.modelo,
      };
    }
    return {
      aeronave,
      desde: desdeMes,
      hasta: hastaMes,
      mes_actual: mesActual,
      reparto_en_pesos: true as const,
      reparto_como_balance: true as const,
      meses: porMes,
      totales,
      socios: [...acumulado.entries()]
        .map(([socio_id, s]) => ({
          socio_id,
          socio_nombre: s.socio_nombre,
          generado_mxn: s.generado_mxn,
          reserva_mxn: s.reserva_mxn,
          entregado_mxn: s.entregado_mxn,
          por_entregar_mxn: round2(s.generado_mxn - s.entregado_mxn),
        }))
        .sort((x, y) => y.generado_mxn - x.generado_mxn),
      entregas: entregas
        .filter((p) => meses.includes(ProfitSharingService.mesDeEntrega(p)))
        .sort(
          (a, b) =>
            b.fecha_pago.localeCompare(a.fecha_pago) ||
            b.created_at.localeCompare(a.created_at),
        ),
    };
  }

  private async fetchAeronaves(aeronaveId?: string): Promise<AeronaveRow[]> {
    let q = this.supabase.service
      .from('aeronave')
      .select('id, matricula, modelo, permiso_afac_usd_hr')
      .eq('activa', true)
      .order('matricula', { ascending: true });
    if (aeronaveId) q = q.eq('id', aeronaveId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async countAeronavesActivas(): Promise<number> {
    const { count, error } = await this.supabase.service
      .from('aeronave')
      .select('id', { count: 'exact', head: true })
      .eq('activa', true);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  /**
   * Vuelos COMPLETADOS (los que realmente volaron) y CANCELADOS (regla del
   * cliente 28-ago-2026: sus cobros retenidos y sus gastos son dinero real y
   * entran al reparto — ver `computeAvion`). Las cotizaciones/reservas que
   * nunca se cerraron siguen fuera: no inflan el "pendiente de cobro" de los
   * socios. Cortes en hora Cancún (UTC−5): un vuelo nocturno del día 31
   * pertenece a SU mes.
   */
  private async fetchVuelos(
    desde: string,
    hasta: string,
    contable = false,
  ): Promise<VueloRow[]> {
    // CIERRE DE MES (invariante 89): con la migración el periodo del DINERO
    // es `fecha_contable` (`colPeriodoContable`); sin ella, `fecha_vuelo`.
    const col = colPeriodoContable(contable);
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        // fecha_solicitud: día de la cotización para el TC oficial de
        // respaldo (29-ago) cuando la cotización no trae tc_usd_mxn.
        `${VUELO_REPARTO_COLS}${colsVueloContable(contable)}`,
      )
      .in('estado', ['COMPLETADO', 'CANCELADO'])
      .gte(col, `${desde}T00:00:00-05:00`)
      .lte(col, `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as VueloRow[];
  }

  /**
   * Vuelos del periodo para el reparto (16-oct-2026, invariante 89):
   * `dinero` = por `fecha_contable` (sin la migración, `fecha_vuelo`: lo de
   * siempre); `sombras` = los que VOLARON en el periodo (`fecha_vuelo`) pero
   * un cierre DIFIRIÓ fuera de él — solo aportan HORAS. Sin la migración no
   * hay sombras (ni consulta).
   */
  private async fetchVuelosPeriodo(
    desde: string,
    hasta: string,
    contable: boolean,
  ): Promise<{ dinero: VueloRow[]; sombras: VueloRow[] }> {
    const dinero = await this.fetchVuelos(desde, hasta, contable);
    if (!contable) return { dinero, sombras: [] };
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(`${VUELO_REPARTO_COLS}${colsVueloContable(true)}`)
      .in('estado', ['COMPLETADO', 'CANCELADO'])
      .not('periodo_contable', 'is', null)
      // eje REAL a propósito (invariante 89): SOMBRAS: los que VOLARON en el periodo (solo horas)
      .gte('fecha_vuelo', `${desde}T00:00:00-05:00`)
      .lte('fecha_vuelo', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    const yaEnDinero = new Set(dinero.map((v) => v.id));
    const sombras = ((data ?? []) as unknown as VueloRow[]).filter(
      (v) => !yaEnDinero.has(v.id),
    );
    return { dinero, sombras };
  }

  private async fetchCobros(vueloIds: string[]): Promise<CobroRow[]> {
    if (vueloIds.length === 0) return [];
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      // comision_banco_*/metodo_cobro (6-oct-2026, API 0.0.65): comisiones a
      // cargo del avión (`comisionesDelVuelo`). id/fecha_cobro/cobro_grupo_id
      // (14-oct-2026, invariante 77): «Vuelos cobrados de más» del pre-cierre
      // (cobro duplicado y sobre del grupo).
      .select(
        'id, vuelo_id, monto, moneda, tc_usd_mxn, comision_banco_monto, comision_banco_pct, metodo_cobro, fecha_cobro, cobro_grupo_id',
      )
      .in('vuelo_id', vueloIds);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * PAGO REAL AL VENDEDOR POR VUELO (13-oct-2026, API 0.0.74, invariante 61):
   * los gastos de los vuelos del periodo, de CUALQUIER fecha_gasto (el eje es
   * el VUELO: un pago capturado en octubre de un vuelo de septiembre cuenta
   * en septiembre). Lotes de ≤ 200 ids y páginas de 1000 ordenadas por `id`
   * (`leerEnLotesPaginado`: PostgREST corta en max-rows sin avisar). SIN
   * `.eq('categoria', …)` NI filtro de fecha a propósito (invariante 31: un
   * literal de enum que la BD no tenga revienta la LECTURA con 22P02 y
   * tumbaría el reparto completo): la categoría se filtra AQUÍ, en JS, y el
   * mapa guarda las DOS del pago al vendedor (la UNIÓN,
   * `categoriaEsPagoVendedor`); `comisionesDelVuelo` elige el lado (solo la
   * «(avión)» resta). Es la ÚNICA vía por la que el reparto cuenta la
   * comisión; `fetchGastos` (eje fecha_gasto) la sigue dejando EXCLUIDA.
   */
  private async fetchGastosVendedorDeVuelos(
    vueloIds: string[],
  ): Promise<Map<string, GastoVendedorVueloRow[]>> {
    return (await this.leerGastosDeVuelos(vueloIds, new Set())).vendedor;
  }

  /**
   * La lectura POR VUELO de arriba (UNA consulta) con dos salidas: el pago
   * al vendedor (las DOS categorías) y, de los vuelos de `externos`, TODOS
   * sus gastos — para decidir si uno ES el pago al operador (invariante 88,
   * `pagoOperadorExternoEnGastos`; desempate por `fecha_gasto` y el orden
   * por `id` de la lectura).
   */
  private async leerGastosDeVuelos(
    vueloIds: string[],
    externos: ReadonlySet<string>,
  ): Promise<{
    vendedor: Map<string, GastoVendedorVueloRow[]>;
    externos: Map<string, GastoVendedorVueloRow[]>;
  }> {
    const out = new Map<string, GastoVendedorVueloRow[]>();
    const outExternos = new Map<string, GastoVendedorVueloRow[]>();
    if (vueloIds.length === 0) return { vendedor: out, externos: outExternos };
    const filas = await this.leerEnLotesPaginado(
      vueloIds,
      (lote, desde, hasta) =>
        this.supabase.service
          .from('gasto')
          .select('vuelo_id, categoria, monto, moneda, tc_gasto, fecha_gasto')
          .in('vuelo_id', lote)
          .order('id', { ascending: true })
          .range(desde, hasta),
    );
    for (const f of filas) {
      const g = f as unknown as GastoVendedorVueloRow;
      if (typeof g.vuelo_id !== 'string') continue;
      if (externos.has(g.vuelo_id)) {
        const listaExt = outExternos.get(g.vuelo_id) ?? [];
        listaExt.push(g);
        outExternos.set(g.vuelo_id, listaExt);
      }
      if (!categoriaEsPagoVendedor(g.categoria)) continue;
      const lista = out.get(g.vuelo_id) ?? [];
      lista.push(g);
      out.set(g.vuelo_id, lista);
    }
    return { vendedor: out, externos: outExternos };
  }

  private async fetchEscalasHoras(
    vueloIds: string[],
  ): Promise<EscalaHorasRow[]> {
    if (vueloIds.length === 0) return [];
    // Se traen TAMBIÉN los tramos cancelados (cancelada_at): no suman horas
    // ni participan en el reparto (lo filtran compute() y la fuente única
    // participacionPorAeronave), pero un gasto ligado a un tramo cancelado
    // sigue siendo del avión de ese tramo (avionDelGasto). Los tramos vivos
    // de un vuelo CANCELADO sí suman horas: solo si tienen salida Y llegada,
    // y la llegada siempre es evidencia real (el sistema jamás la estima) —
    // si el avión voló a recoger y regresó ferry, esas horas movieron el
    // horómetro y cuentan en la reserva de overhaul.
    const { data, error } = await this.supabase.service
      .from('escala')
      // solo_operativa / es_ferry: la fuente única excluye los tramos
      // operativos del reparto de la venta (sin estas columnas un ferry
      // intercalado contaría como tramo vendido). origen/destino: etiqueta
      // "CUN→MID" de los tramos del avión en el PDF/XLSX.
      .select(
        'id, vuelo_id, orden, aeronave_id, cancelada_at, taco_salida, taco_llegada, solo_operativa, es_ferry, origen_iata, destino_iata',
      )
      .in('vuelo_id', vueloIds)
      // Orden DETERMINISTA (verificación 28-ago): sin ORDER BY el orden de
      // inserción en `participacionPorAeronave` (desempates de
      // `avionQueReporta`/`repartirUsd`) podía diferir del balance y del
      // Libro Dinero — mismo orden en los tres lectores.
      .order('vuelo_id', { ascending: true })
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Avión (ya con herencia del vuelo) de escalas sueltas — las referidas por
   * gastos del periodo cuyo vuelo NO es del periodo. Map escala.id → avión.
   */
  private async fetchAvionDeEscalas(
    escalaIds: string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (escalaIds.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('escala')
      .select('id, aeronave_id, vuelo:vuelo_id(aeronave_id)')
      .in('id', escalaIds);
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as Array<Record<string, unknown>>) {
      const raw: unknown = e.vuelo;
      const vuelo = (Array.isArray(raw) ? raw[0] : raw) as {
        aeronave_id?: string | null;
      } | null;
      out.set(
        e.id as string,
        (e.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null,
      );
    }
    return out;
  }

  /** aeronave.id → matrícula de TODA la flota (etiquetas multi-avión). */
  private async fetchMatriculas(): Promise<Map<string, string>> {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula');
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((a) => [a.id as string, a.matricula as string]),
    );
  }

  private async fetchGastos(
    desde: string,
    hasta: string,
    contable = false,
  ): Promise<GastoRow[]> {
    // TUA de oficina (13-oct-2026, invariante 66): detrás de la sonda.
    const colTua = colTuaIncluida(
      await tuaIncluidaDisponible(this.supabase.service),
    );
    // CIERRE DE MES (invariante 89): con la migración cada gasto trae su
    // vuelo (mes contable) y su tramo para decidir su EJE
    // (`diaContableDeGasto`, la regla de `ubicacionBalanceDeGasto`).
    const embedContable = contable ? GASTO_REPARTO_EMBED_CONTABLE : '';
    // Marca «Pago de AFAC» (invariante 90): solo con la migración.
    const colAfac = colPagoAfac(
      await afacRealDisponible(this.supabase.service),
    );
    const { data, error } = await this.supabase.service
      .from('gasto')
      // propina + valor_ia_extraido: para separar el TUA embebido en
      // facturas de aeródromo (regla 7) con la misma regla del balance;
      // notas: respaldo por texto de la extensión de horario (1-oct-2026).
      // escala_id: avión del gasto por tramo (Regla B, avionDelGasto).
      // fecha_gasto: día del TC oficial de respaldo (29-ago) en MXN sin TC.
      // tua_incluida (13-oct-2026): la TUA que fijó la oficina.
      .select(
        `id, aeronave_id, vuelo_id, escala_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido, notas, fecha_gasto${colTua}${colAfac}${embedContable}`,
      )
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta);
    if (error) throw new Error(error.message);
    // Select dinámico (con o sin `tua_incluida`): la fila se declara a mano.
    return (data ?? []) as unknown as GastoRow[];
  }

  /**
   * GASTOS DEL PERIODO CONTABLE (16-oct-2026, invariante 89; afinación 2 del
   * contrato): los gastos por `fecha_gasto` (como siempre) ∪ TODOS los de los
   * vuelos del dinero del periodo (cualquier fecha), y se queda cada uno
   * SOLO si el día en que CUENTA cae en el periodo — la MISMA regla del
   * balance (`ubicacionBalanceDeGasto`, invariante 72): eje VUELO ⇒ día
   * contable de su vuelo; eje GASTO (GAS, EMPRESA, sin vuelo) ⇒
   * `fecha_gasto`; con reparto MANUAL ⇒ la `fecha_gasto` del padre (R4: sus
   * parciales). Así un vuelo diferido se lleva sus gastos en los tres libros
   * (balance = reparto = Libro Dinero) y un gasto con fecha fuera del mes de
   * su vuelo cuenta con el vuelo (antes el reparto lo ponía en su
   * fecha_gasto y el balance en el vuelo). Los de los vuelos EXCLUIDOS de la
   * simulación del cierre (eje vuelo) salen.
   */
  private async gastosDelPeriodoContable(
    porFecha: GastoRow[],
    vueloIds: ReadonlyArray<string>,
    q: ProfitSharingQuery,
    excluir: ReadonlySet<string>,
  ): Promise<GastoRow[]> {
    const colTua = colTuaIncluida(
      await tuaIncluidaDisponible(this.supabase.service),
    );
    const colAfac = colPagoAfac(
      await afacRealDisponible(this.supabase.service),
    );
    const deVuelos = (await this.leerEnLotesPaginado(
      vueloIds,
      (lote, desde, hasta) =>
        this.supabase.service
          .from('gasto')
          .select(
            `id, aeronave_id, vuelo_id, escala_id, categoria, monto, moneda, tc_gasto, propina, valor_ia_extraido, notas, fecha_gasto${colTua}${colAfac}${GASTO_REPARTO_EMBED_CONTABLE}`,
          )
          .in('vuelo_id', lote)
          .order('id', { ascending: true })
          .range(desde, hasta),
    )) as unknown as GastoRow[];
    const porId = new Map<string, GastoRow>();
    for (const g of [...porFecha, ...deVuelos]) {
      if (g.id && !porId.has(g.id)) porId.set(g.id, g);
    }
    const todos = [...porId.values()];
    const repartos = await fetchRepartos(
      this.supabase.service,
      todos.map((g) => g.id),
    );
    return todos.filter((g) => {
      const conReparto = (repartos.get(g.id) ?? []).length > 0;
      const crudo = g as unknown as GastoParaMesContable;
      const eje = conReparto ? 'gasto' : ejeContableDeGasto(crudo);
      if (eje === 'vuelo' && g.vuelo_id && excluir.has(g.vuelo_id)) {
        return false;
      }
      const dia =
        eje === 'gasto'
          ? (g.fecha_gasto ?? '').slice(0, 10) || null
          : diaContableDeGasto(crudo);
      return dia != null && dia >= q.desde && dia <= q.hasta;
    });
  }

  private async fetchSocios(): Promise<SocioRow[]> {
    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .select(
        'aeronave_id, socio_id, porcentaje, vigente_desde, vigente_hasta, descontar_reserva_overhaul',
      );
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchReservas(): Promise<ReservaRow[]> {
    const { data, error } = await this.supabase.service
      .from('reserva_overhaul')
      .select('aeronave_id, monto_por_hora_usd, horas_acumuladas');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** cliente.id → nombre (detalle.vuelos y detalle de vuelos del PDF/XLSX). */
  private async fetchClientes(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select('id, nombre')
      .in('id', ids);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((c) => [c.id as string, c.nombre as string]),
    );
  }

  private async fetchNombres(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', ids);
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((u) => [u.id as string, u.nombre as string]),
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reparto de un saldo por porcentajes en CENTAVOS por RESIDUO MAYOR (la
 * regla de siempre del reparto a socios, extraída tal cual el 19-oct-2026
 * para usarla también EN PESOS, invariante 92): cada socio recibe el piso
 * de su parte exacta y los centavos que faltan para llegar a round(Σ% ×
 * saldo) van a los residuos más grandes (orden estable en empate). Con
 * porcentajes que suman 100, Σ partes == saldo al centavo.
 */
function centavosPorResiduoMayor(
  pcts: ReadonlyArray<number>,
  saldo: number,
): number[] {
  const saldoCents = Math.round(saldo * 100);
  const partes = pcts.map((pct) => {
    const exacto = (pct / 100) * saldoCents;
    return { cents: Math.floor(exacto), resto: exacto - Math.floor(exacto) };
  });
  const repartoPct = pcts.reduce((acc, p) => acc + p, 0);
  let faltan =
    Math.round((repartoPct / 100) * saldoCents) -
    partes.reduce((acc, p) => acc + p.cents, 0);
  for (const p of [...partes].sort((x, y) => y.resto - x.resto)) {
    if (faltan <= 0) break;
    p.cents += 1;
    faltan -= 1;
  }
  return partes.map((p) => p.cents);
}

/** Número positivo o null (TCs y divisores; numeric de PostgREST llega string). */
function pos(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Día Cancún (YYYY-MM-DD) de un timestamptz; null si el vuelo no tiene fecha. */
function diaCancun(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
}

/**
 * Día (YYYY-MM-DD) de una columna `date` (fecha de pared: se respeta tal
 * cual — pasarla por `new Date` la interpretaría en UTC y en Cancún sería el
 * día ANTERIOR) o de un timestamptz (día Cancún).
 */
function diaDeFecha(fecha: string | null): string | null {
  if (!fecha) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  return diaCancun(fecha);
}

/**
 * ¿El vuelo necesita el K oficial SOLO por sus pagos «Comisión del vendedor
 * (avión)» (revisión 13-oct-2026, invariante 61)? Sin tc_usd_mxn y con al
 * menos uno en PESOS sin tc_gasto: el único que `comisionesDelVuelo` lleva a
 * USD con K (un pago USD ya está en dólares; los cobros los cubre
 * `cobrosNecesitanTc`). Lado EXACTO por `ladoPagoVendedor` (nunca prefijo).
 */
function pagoVendedorAvionNecesitaK(
  gastos: ReadonlyArray<GastoVendedorVueloRow>,
  tcVuelo: unknown,
): boolean {
  if (pos(tcVuelo) != null) return false;
  return gastos.some(
    (g) =>
      ladoPagoVendedor(g.categoria ?? null) === 'AVION' &&
      g.moneda === 'MXN' &&
      pos(g.tc_gasto) == null,
  );
}

/**
 * K de las COMISIONES de un vuelo (`comisionesDelVuelo` y el universo de la
 * «(avión)»): el T.C. de la cotización ?? el oficial del día de la
 * cotización — el de los cobros si lo pidieron; si no, el del mapa aparte de
 * las comisiones. Es el MISMO K que el balance (`kCapturado ?? kDetalle?.tc`,
 * oficial para TODO vuelo sin tc_usd_mxn): sin él, un pago «(avión)» en
 * pesos sin tc_gasto restaba en el balance y no en el reparto.
 */
function kComisionesDeVuelo(
  v: { id: string; tc_usd_mxn?: unknown },
  tcOficialVuelo: ReadonlyMap<string, TipoCambioDetalle>,
  tcKComisionesVuelo: ReadonlyMap<string, TipoCambioDetalle>,
): number | null {
  return (
    pos(v.tc_usd_mxn) ??
    tcOficialVuelo.get(v.id)?.tc ??
    tcKComisionesVuelo.get(v.id)?.tc ??
    null
  );
}

/**
 * ¿Algún cobro MXN sin TC propio y sin TC de cotización? Solo esos vuelos
 * piden el TC oficial del día (evita consultar días que nadie usaría).
 */
function cobrosNecesitanTc(cobros: CobroRow[], tcVuelo: unknown): boolean {
  if (pos(tcVuelo) != null) return false;
  return cobros.some(
    (c) =>
      c.moneda === 'MXN' && pos(c.tc_usd_mxn) == null && Number(c.monto) > 0,
  );
}

/**
 * Renglón BLOQUEANTE `nomina_sin_repartir` del pre-cierre (16-oct-2026, API
 * 0.0.90, invariante 91): los pagos de NÓMINA del periodo sin reparto, su
 * monto por moneda (`monto_usd` solo con dólares; jamás se suman monedas) y
 * sus `ids` como ÚLTIMAS llaves (invariante 81). null (lectura caída) ⇒
 * count 0 + `lectura_fallida: true` + «No se pudo verificar…».
 */
function renglonNominaSinRepartir(
  lista: Array<Record<string, unknown>> | null,
) {
  const r = lista ? resumenNominaSinRepartir(lista) : null;
  return {
    clave: CLAVE_PRECIERRE_NOMINA_SIN_REPARTIR,
    titulo: TITULO_PRECIERRE_NOMINA_SIN_REPARTIR,
    detalle: detallePrecierreNominaSinRepartir(r),
    count: r?.n ?? 0,
    monto_mxn: r?.mxn ?? 0,
    ...(r && r.usd > 0 ? { monto_usd: r.usd } : {}),
    ...(lista ? {} : { lectura_fallida: true as const }),
    ...idsPrecierre(lista ?? []),
  };
}

/**
 * Renglón BLOQUEANTE `gastos_por_pagar` del pre-cierre (19-oct-2026, API
 * 0.0.95, invariante 93): los gastos del periodo «por pagar» sin confirmar,
 * su monto por moneda (`monto_usd` solo con dólares; jamás se suman monedas),
 * `ids_nomina` (ADITIVO, revisión P2: el subconjunto de `ids` cuya categoría
 * es NOMINA, que se resuelve en el módulo Nómina; `[]` si no hay) JUSTO antes
 * de `ids`, y `ids` / `ids_truncado` como ÚLTIMAS llaves (invariante 81).
 * null (lectura caída) ⇒ count 0 + `lectura_fallida: true` + «No se
 * pudieron verificar…».
 */
function renglonGastosPorPagar(
  lista: Array<Record<string, unknown>> | null,
  hoy: string,
) {
  const r = lista ? resumenGastosPorPagar(lista, hoy) : null;
  const ids = idsPrecierre(lista ?? []);
  return {
    clave: CLAVE_PRECIERRE_GASTOS_POR_PAGAR,
    titulo: TITULO_PRECIERRE_GASTOS_POR_PAGAR,
    detalle: detallePrecierreGastosPorPagar(r),
    count: r?.n ?? 0,
    monto_mxn: r?.mxn ?? 0,
    ...(r && r.usd > 0 ? { monto_usd: r.usd } : {}),
    ...(lista ? {} : { lectura_fallida: true as const }),
    ids_nomina: idsNominaDe(lista ?? [], ids.ids),
    ...ids,
  };
}

/**
 * Renglón INFORMATIVO `movimientos_omitidos` del pre-cierre (invariante 75):
 * NO bloquea (no está en `bloqueantes`). null ⇒ count 0 + `lectura_fallida`.
 */
function renglonOmitidosPreCierre(r: OmitidosPeriodo | null): {
  clave: string;
  titulo: string;
  detalle: string;
  count: number;
  monto_mxn: number;
  monto_usd: number;
  informativo: true;
  lectura_fallida?: true;
} {
  return {
    clave: 'movimientos_omitidos',
    titulo: 'Movimientos del banco omitidos de la conciliación',
    detalle: textoOmitidosPreCierre(r),
    count: r?.count ?? 0,
    monto_mxn: r?.monto_mxn ?? 0,
    monto_usd: r?.monto_usd ?? 0,
    informativo: true,
    ...(r ? {} : { lectura_fallida: true as const }),
  };
}
