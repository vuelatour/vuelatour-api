import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import { IaUsoService, type UsoIaPayload } from '../ia-uso/ia-uso.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import type { EnvVars } from '../../config/env.schema';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';
import {
  exigirPeriodoDesdeInicio,
  inicioOficialDe,
  pisoDia,
} from '../../common/inicio-oficial.util';
import { avionDelGasto } from '../../common/participacion-aeronave.util';
import { normalizarTc, round6 } from '../../common/tc.util';
import {
  fetchRepartos,
  type GastoRepartoFila,
} from '../../common/gasto-reparto.util';
import {
  conciliacionDeCobro,
  esParteDeSobre,
  MOV_LIGA_COLS,
  MOV_LIGA_COLS_CON_INGRESO,
  movimientosDeCobro,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import {
  etiquetaMetodoCobro,
  METODOS_COBRO_ABONO_AUTO,
  METODOS_COBRO_ABONO_MANUAL,
  METODOS_COBRO_PASARELA,
} from '../../common/metodo-cobro.util';
import {
  errorIngresosNoDisponibles,
  ingresosDisponibles,
} from '../../common/ingreso-disponible.util';
import {
  errorReversosNoDisponibles,
  reversosDisponibles,
} from '../../common/reverso-disponible.util';
import {
  errorPartesNoDisponibles,
  esPartesAusentes,
  partesDisponibles,
} from '../../common/partes-disponible.util';
import {
  cobrosLoteDisponibles,
  errorCobrosLoteNoDisponibles,
  esCobrosLoteAusente,
} from '../../common/cobros-lote-disponible.util';
import {
  alVincularSobre,
  cobroOcupadoParaAbono,
  cobroParaCruce,
  decidirCorregirComision,
  diferenciaLoteCobros,
  etiquetaConciliadoCobroUnico,
  etiquetaConciliadoCobros,
  leerErrorCobros,
  LOTE_COBROS_MAX,
  mensajeCorregirComisionNoAplica,
  mensajeErrorCobros,
  mensajeSobreNoCuadra,
  netoDeCobro,
  puedeLigarCobros,
  sugeridosParaExcedente,
  type CobroParaLote,
  type MotivoCorregirComisionNoAplica,
  type SugeridoCobro,
  type VeredictoLoteCobros,
} from './cobros-lote.util';
import {
  colsPuenteLigas,
  leerLigasDeCobros,
  leerPartesDeCobros,
  partesDeAbonos,
  partesDeFilasPuente,
  partesDeLigas,
  type ParteCobroLeida,
} from './ligas-cobro.lector';
import {
  alVincularAbono,
  cobroDeUnSoloAbono,
  coberturaCobro,
  estadoBancoCobro,
  faltanteFueraDe,
  type AlVincular,
  type EstadoBancoCobro,
  type ParteCobroBanco,
} from '../../common/cobro-banco.util';
import {
  cobrosParcialesConfirmados,
  cobrosParcialesDisponibles,
  errorCobrosParcialesNoDisponibles,
} from '../../common/cobros-parciales-disponible.util';
import { serieFolioRecibidaDisponible } from '../../common/serie-folio-recibida-disponible.util';
import {
  conFolioComprobante,
  embedFolioGasto,
  etiquetaFacturasReporte,
  folioComprobanteDeFila,
  notasReporteConFactura,
} from '../../common/folio-comprobante.util';
import { patronIlikeSeguro } from '../facturas-emitidas/facturas-emitidas.util';
import {
  CATEGORIAS_INGRESO,
  categoriaSugeridaDeDescripcion,
  esAnticipo,
  esCategoriaIngreso,
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
} from '../../common/categoria-ingreso.util';
import {
  estadoConciliacionIngreso,
  montoCuadraIngreso,
  netoIngreso,
  TOLERANCIA_INGRESO,
} from '../ingresos/ingresos.util';
import type {
  AbonoPendiente,
  AbonosPendientesRespuesta,
  CandidatoAbonoFicha,
  CandidatoIngresoAbono,
  MonedaIngreso,
  PropuestaAbono,
  SugerirAbonosRespuesta,
} from '../ingresos/ingresos.types';
import {
  AbonosPendientesQuery,
  AutoMatchDto,
  AutoReversosDto,
  ConciliacionParseDto,
  GastosCandidatosQuery,
  ImportarMovimientosDto,
  LOTE_GASTOS_MAX,
  ListConciliacionQuery,
  PaywiseAuditoriaQuery,
  SugerirAbonosDto,
  SugerirLoteDto,
  TipoMovimientoBancario,
  type ReporteConciliacionEstado,
} from './dto/conciliacion.dto';
import {
  clienteQueEmpata,
  CLASIFICACION_REVERSO,
  cuadraMontoAbono,
  elegirCandidatoAbono,
  patronReverso,
  posibleDuplicado,
  type AbonoCruce,
  type CandidatoAbonoCruce,
} from './abono-cruce.util';
import {
  comisionAEscribirEnCruce,
  cruzarPaywise,
  difDias,
  PAYWISE_VENTANA_DIAS,
  type CobroPaywise,
  type CrucePaywise,
  type MovimientoPaywise,
  type ResultadoCrucePaywise,
} from './paywise-cruce.util';
import {
  cubreGasto,
  diferenciaLote,
  etiquetaConciliadoLote,
  faltanteDe,
  afinarMotivoGastoCubierto,
  leerErrorPartes,
  MENSAJE_SOLO_CARGOS,
  mensajeCargoNoCuadra,
  mensajeErrorPartes,
  mensajeLoteInvalido,
  mensajeLoteInvalidoDeBd,
  mensajeLoteMonedaDistinta,
  mensajeMovimientoConGastos,
  mensajeMovimientoConLote,
  montoBonito,
  mensajeGastoYaCubierto,
  mensajeMonedaDistinta,
  motivoGastoCubiertoDeBd,
  normalizarUuid,
  parteCruzada,
  puedeLigar,
  puedeRepartirCargo,
  type ErrorPartesLike,
  type MotivoNoLigar,
  type PuedeRepartirResultado,
} from './conciliacion-parcial.util';
import {
  clasificarMediosVinculo,
  errorSinMonedaCuenta,
  esMedioBancario,
  interpretarBusquedaGasto,
  MEDIO_BODEGA,
  MEDIOS_BANCARIOS,
  ordenarCandidatosPorNiveles,
  rangoBandaMxnDeUsd,
  rangoBandaUsd,
  rangosUsdDeBusqueda,
  type BusquedaGasto,
} from './gastos-candidatos.util';
import {
  agregarNotaVinculo,
  JUSTIFICACION_MIN,
  limpiarJustificacion,
  lineaNotaCargo,
  lineaNotaGasto,
  mensajeGastoBodega,
  mensajeJustificacionRequerida,
  mensajeNoBancarioOtraMoneda,
  quitarNotasVinculoNoBancario,
  tieneNotasVinculoNoBancario,
  type CargoDeNota,
  type GastoDeNota,
} from '../../common/vinculo-no-bancario.util';
import {
  agruparExcluidos,
  cargosConciliadosPorGasto,
  conCargosConciliados,
  EXCLUIDOS_LECTURA_TOPE,
  GASTO_EXCLUIDO_COLS,
  gastoExcluibleDeFila,
  montoReferenciaExcluidos,
  rangoMontoExcluidos,
  ventanaExcluidos,
  type CargoConciliadoExcluido,
  type ExcluidosCandidatos,
  type GastoExcluible,
  type GrupoExcluidos,
} from './candidatos-excluidos.util';
import {
  CLASIFICACION_TRASPASO,
  competidoresCruceUsd,
  conteoVacio,
  decidirCruceUsd,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados,
  evaluarTcCruce,
  ligaUsdFueraDeLugar,
  montoCasa,
  ordenarPreviosParaDedupe,
  patronTraspaso,
  primeraLinea,
  sumarResultado,
  TC_IMPLICITO_MAX,
  TC_IMPLICITO_MIN,
  tcCruceUsdPublico,
  terminacionDeMovimiento,
  TEXTO_CRUCE_USD_RECIPROCO_ERROR,
  TEXTO_CRUCE_USD_RECIPROCO_TRUNCADO,
  TEXTO_CRUCE_USD_SIN_LECTURA_TC,
  TEXTO_CRUCE_USD_TRUNCADO,
  textoReciprocoCruceUsd,
  textoSePuedeCruzarUsd,
  TOLERANCIA_CENTAVOS,
  TOLERANCIA_TC_OFICIAL_PCT,
  TOPE_CRUCE_USD,
  ventanaDias,
  type CargoCompetidor,
  type CriterioCruce,
  type DecisionCruceUsd,
  type GastoCandidatoCruce,
  type OficialDelDia,
  type ResultadoCruce,
  type TcCruceUsd,
} from './auto-cruce.util';
import {
  descripcionGastoUsd,
  ordenarLigasUsdTc,
  textoLigaUsdTc,
  type LigaUsdTcFueraDeLugar,
  type ResultadoLigasUsdTc,
} from './ligas-usd-tc.util';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import {
  CONCEPTO_TEXTO_MAX,
  direccionDeFechas,
  ENRIQUECIMIENTO_DETALLE_MAX,
  ENRIQUECIMIENTO_OMITIDOS_MAX,
  estadoCuentaIdsParaDireccion,
  idsParaLeerFolios,
  lineasNuevasEnBucketConocido,
  NUEVOS_MISMO_DIA_DETALLE_MAX,
  planEnriquecimiento,
  VISTA_PREVIA_DETALLE_MAX,
  VISTA_PREVIA_OMITIDOS_MAX,
  type DireccionArchivo,
  type EnriquecimientoOmitido,
  type EnriquecimientoPlaneado,
  type FilaPreviaEnriquecible,
  type ReglaEnriquecimiento,
} from './enriquecer-descripcion.util';
import {
  coincideFacturaConGasto,
  estadoLigados,
  facturaConceptoParaRespuesta,
  facturaDeConcepto,
  foliosDeGastoCrudo,
  numerosDeGasto,
  REPETIDA_DIAS,
  repeticionesDeFactura,
  type FacturaConcepto,
  type FilaUniversoFactura,
  type FoliosGasto,
  type NumeroFactura,
  type TipoFacturaConcepto,
} from './factura-concepto.util';
import {
  abonosCandidatosDeCargo,
  anteponerNotaReverso,
  cargoLigadoConDinero,
  cargosCandidatosDeAbono,
  compararAntiguedad,
  elegirCargoReverso,
  emparejarReversos,
  esDevolucionDeCargo,
  etiquetaConciliadoReverso,
  gastosLigadosN,
  ligadoAGasto,
  motivoParInvalido,
  motivoTriggerReverso,
  movimientoLibreParaReverso,
  notaAbonoReverso,
  notaCargoReverso,
  pistaFechaDevolucion,
  quitarNotaReverso,
  REVERSO_VENTANA_DIAS,
  sumarDiasFecha,
  ventanaAbonoDeCargo,
  ventanaCargoDeAbono,
  type DecisionReverso,
  type MovimientoParReverso,
  type MovimientoReverso,
} from './reverso-cruce.util';
import { fechaVueloDe } from '../../common/fecha-vuelo-candidato.util';
import { ordenArchivoDisponible } from '../../common/orden-archivo-disponible.util';
import {
  errorCargosAGastoNoDisponible,
  errorOmitirNoDisponible,
  esOmisionCargosAusente,
  omisionCargosDisponible,
} from '../../common/omision-cargos-disponible.util';
import {
  CLASIFICACION_OMITIDO,
  esClasificacionOmitida,
  estadoMovimientoParaOmitir,
  etiquetaOmisionReporte,
  ESTATUS_OMITIDO,
  leerErrorOmision,
  leerOmision,
  lineaOmision,
  MENSAJE_ACEPTAR_RIESGO_INVALIDO,
  MENSAJE_CONFLICTO_CONCURRENTE,
  MENSAJE_MOVIMIENTO_CAMBIO,
  MENSAJE_USA_OMITIR,
  mensajeMovimientoOmitido,
  mensajeMovimientosNoExisten,
  mensajeNoOmitidos,
  mensajeNoPendientes,
  mensajeOmitirConRiesgo,
  OMISION_SIN_DATOS,
  omisionDeFila,
  OMITIR_MAX,
  quitarLineaOmision,
  riesgoDeOmision,
  textoConciliadosReporte,
  textoEstadoNoPendiente,
  textoRiesgoOmision,
  type EstadoParaOmitir,
  type OmitidosPeriodo,
  type RiesgoOmision,
} from './omision.util';
import {
  CARGOS_A_GASTO_MAX,
  CARGOS_A_GASTO_MIN,
  conPrefijoNoSeRegistro,
  leerErrorCargosGasto,
  MENSAJE_GASTO_NO_EXISTE,
  MENSAJE_GASTO_YA_CUBIERTO_CARRERA,
  MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA,
  MENSAJE_LOTE_CARGOS_INVALIDO,
  mensajeCargosExcedenGasto,
  mensajeCargosMonedaDistinta,
  mensajeGastoBodegaCargos,
  mensajeGastoNoBancario,
  mensajeLoteMonedaDistintaGasto,
  mensajeSoloCargos,
  ordenarCandidatosPorSuma,
  resultadoCargosSobreGasto,
  terminacionComun,
  validarCargosParaGasto,
  type CargoParaGasto,
  type ResultadoSuma,
  type ValidacionCargosGasto,
} from './cargos-a-gasto.util';
import { ordenarComoEstadoDeCuenta } from './orden-estado-cuenta.util';
import {
  estadoBancoGasto,
  etiquetaMedioSinBanco,
} from '../expenses/estado-banco.util';
import { candadoMesDelVuelo } from '../expenses/cambio-fecha-gasto.util';
import { leerUbicacionBalance } from '../../common/ubicacion-balance-lector';
import {
  aCargoDeGasto,
  alertasConciliacionGasto,
  cuentaDeFila,
  ordenarCargosDeGasto,
  type CargosDeGastoLeidos,
  type ConciliacionDeGastoRespuesta,
  type UltimoMovimientoCuenta,
} from './cargos-de-gasto.util';
import {
  aAbonoDeEntrada,
  alertasConciliacionEntrada,
  anticipoDeEntrada,
  coberturaDeEntrada,
  cruceNoCorrio,
  entradaDeCobroParaHoja,
  entradaDeIngresoParaHoja,
  estadoBancoEntradaDeCobro,
  mismoDiaCliente,
  ordenarAbonosDeEntrada,
  registroDeBitacoraIngreso,
  type AbonoDeEntrada,
  type ConciliacionDeEntradaRespuesta,
  type ConciliarDeBitacora,
  type CruceNoCorrio,
  type EntradaDeConciliacion,
  type FuenteEntrada,
  type LigaParaAbono,
  type MismoDiaCliente,
  type OrigenEntrada,
  type SinRegistroLiga,
} from './abonos-de-entrada.util';

// `cobro_grupo_id` (4-sep-2026): un ABONO concilia contra un cobro de vuelo
// (`cobro_id`) O contra el SOBRE de un grupo (`cobro_grupo_id`), excluyentes.
// monto_bruto / comision_monto (9-sep-2026): solo los abonos de una cuenta
// PASARELA (Paywise) los traen; `monto` sigue siendo lo DEPOSITADO (neto).
const MOV_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, monto_bruto, comision_monto, descripcion, referencia, conciliado, gasto_id, cobro_id, cobro_grupo_id, clasificacion_id, origen, notas, created_at';
const MATCH_DAYS = 3;
/**
 * Columnas del gasto que necesita el auto-cruce (fuente única: el desempate
 * por tarjeta/descripción y el camino inverso leen EXACTAMENTE lo mismo).
 */
const GASTO_CRUCE_COLS =
  'id, monto, moneda, fecha_gasto, medio_pago, tarjeta_terminacion, lugar, notas, categoria, vuelo_id, proveedor:proveedor!proveedor_id(nombre)';
/**
 * Métodos de cobro que llegan al banco como ABONO y se cruzan SOLOS
 * (auto-match): misma lista para cobro_vuelo y para los sobres de grupo.
 * Fuente única `common/metodo-cobro.util` (+ PAYWISE desde 9-sep-2026).
 */
const METODOS_ABONO_AUTO = [...METODOS_COBRO_ABONO_AUTO];
/**
 * Candidatos MANUALES: + BILLPOCKET (el depósito de la terminal también
 * aparece en el estado de cuenta; el panel ya lo ofrecía a mano).
 */
const METODOS_ABONO_MANUAL = [...METODOS_COBRO_ABONO_MANUAL];
/** Tipo de cuenta_bancaria cuyos abonos traen bruto/comisión (Paywise). */
const TIPO_CUENTA_PASARELA = 'PASARELA';
/** Ventana default (±días) de candidatos manuales: la misma que usaba el panel. */
const CANDIDATOS_DIAS_DEFAULT = 60;
const CANDIDATOS_MAX = 60;
/** Embed del sobre de grupo en movimiento_bancario (lista y reporte). */
const SOBRE_EMBED =
  'cobro_grupo:cobro_grupo!cobro_grupo_id(id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre))';

/**
 * Sobre de cobro de GRUPO tal como lo expone conciliación (lista de
 * movimientos y candidatos): forma ADITIVA junto a los cobros normales.
 */
export interface SobreConciliacion {
  tipo: 'SOBRE_GRUPO';
  cobro_grupo_id: string;
  grupo_id: string;
  grupo_folio: number | null;
  grupo_nombre: string | null;
  /** BRUTO (moneda nativa). */
  monto: number;
  moneda: string;
  metodo: string;
  /** Alias de `metodo` (paridad con cobro_vuelo). */
  metodo_cobro: string;
  fecha: string;
  /** Alias de `fecha` (paridad con cobro_vuelo). */
  fecha_cobro: string;
  referencia: string | null;
  comision_banco_monto: number | null;
  /** Lo que depositó el banco: monto − comisión. */
  neto: number;
  /** Partes (aviones) en las que se partió el sobre. */
  aviones_n: number;
}

/** Cobro de vuelo candidato a conciliar un ABONO a mano. */
export interface CandidatoCobroVuelo {
  tipo: 'COBRO_VUELO';
  /** = cobro_id (lo que se manda a PATCH movimientos/:id/cobro). */
  id: string;
  cobro_id: string;
  vuelo_id: string;
  folio: number | null;
  /** ADITIVO (12-oct-2026, invariante 54): día del vuelo, junto al del cobro. */
  fecha_vuelo: string | null;
  cliente: string | null;
  fecha_cobro: string;
  monto: number;
  moneda: string;
  metodo_cobro: string;
  referencia: string | null;
  comision_banco_monto: number | null;
  neto: number;
  /**
   * |neto − monto del abono| (0 = cuadra exacto). Un cobro PARCIAL (0.0.78,
   * invariante 77) se compara contra lo que le FALTA fuera de este abono.
   */
  dif_monto: number;
  /**
   * ADITIVOS (14-oct-2026, API 0.0.78, invariante 77), siempre relativos a
   * los OTROS abonos del cobro (no a este): `parcial` = ya tiene abonos
   * que no lo cubren; `monto_vinculado` = Σ de esos abonos en su moneda;
   * `faltante` = lo que le falta fuera de este abono (sin abonos = neto);
   * `abonos` = los primeros 5 por antigüedad.
   */
  parcial?: boolean;
  monto_vinculado?: number;
  faltante?: number;
  abonos_n?: number;
  abonos?: AbonoDeCobroCorto[];
  /**
   * ADITIVO (0.0.78, D18): qué pasaría al vincular ESTE abono a este cobro
   * (`alVincularAbono`, el espejo del trigger A + el ±2 % del T.C.). Un
   * EXCEDE trae `sugeridos[]` (≤ 3): cobros libres a los que les falta ≈ lo
   * que sobra.
   */
  al_vincular?: AlVincular & { sugeridos?: SugeridoCobro[] };
}

/** Ficha corta de un cobro de vuelo (lotes y estado de la bandeja). */
interface FichaCobroEnLote {
  vuelo_id: string | null;
  folio: number | null;
  cliente: string | null;
  fecha_cobro: string | null;
  monto: number;
  moneda: string | null;
  metodo_cobro: string | null;
  comision_banco_monto: number | null;
  neto: number;
}

/** Un abono ya ligado a un cobro, en corto (invariante 77). */
export interface AbonoDeCobroCorto {
  movimiento_id: string;
  fecha: string | null;
  monto_parte: number;
}

/** Sobre de grupo candidato (se manda `cobro_grupo_id` al PATCH). */
export interface CandidatoSobreGrupo extends SobreConciliacion {
  /** = cobro_grupo_id. */
  id: string;
  cliente: string | null;
  dif_monto: number;
  /** ADITIVO (12-oct-2026, invariante 54): fecha del vuelo del grupo. */
  fecha_vuelo?: string | null;
  /**
   * ADITIVO (0.0.78, D8/D18): el abono de una cuenta de banco en la moneda
   * del sobre debe ser su neto ± $1.00 (SOBRE_NO_CUADRA); `diferencia` =
   * |abono| − neto.
   */
  al_vincular?: {
    estado: 'CONCILIADO' | 'SOBRE_NO_CUADRA';
    diferencia: number;
  };
}

export type CandidatoCobro = CandidatoCobroVuelo | CandidatoSobreGrupo;

/** Entrada de linkCobro: cobro de vuelo O sobre de grupo (excluyentes); ambos null = desvincular. */
export interface LigaCobroInput {
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
  /**
   * 1 ABONO ↔ N COBROS (12-oct-2026, invariante 56): los cobros de vuelo
   * que paga este abono (1..50). Excluyente con `cobro_id` /
   * `cobro_grupo_id`. Con la puente aplicada va por la RPC
   * `conciliacion_ligar_abono_cobros`; con UN elemento y sin la migración
   * es la liga de siempre.
   */
  cobro_ids?: string[] | null;
  /**
   * «Corregir la comisión y vincular» (0.0.78, D6): solo con UN cobro de
   * vuelo sin abonos cuyo veredicto SIN corregir es COMISION_NO_CUADRA
   * (revisión del 15-oct-2026); antes de ligar escribe la comisión real
   * (monto − depósito). 400 CORREGIR_COMISION_NO_APLICA si no aplica (o el
   * 409/400 de siempre, sin escribir, si la liga se rechaza por otra cosa).
   */
  corregir_comision?: boolean;
}

/**
 * Cargo del banco ligado a un gasto (pagos parciales, 14-sep-2026):
 * `monto` en POSITIVO (|monto| del movimiento) y `moneda` = la de su
 * cuenta bancaria — con ella se decide si suma contra el gasto o si es el
 * caso cruzado USD↔MXN (1 ↔ 1).
 */
export interface CargoDeGasto {
  id: string;
  fecha: string | null;
  monto: number;
  moneda: string | null;
}

/**
 * Respuesta de `GET movimientos/:id/gastos-candidatos`. `excluidos` y
 * `excluidos_monto` (ADITIVOS, 6-oct-2026, API 0.0.63) viajan SOLO cuando
 * `candidatos` queda vacío (y no viajan si su lectura falló).
 * `no_bancario` (ADITIVO, mismo 0.0.63): SIEMPRE en cada candidato; `true`
 * solo con `incluir_no_bancarios` (efectivo / PERSONAL_*). Orden por
 * niveles (`ordenarCandidatosPorNiveles`): bancarios que cuadran, no
 * bancarios que cuadran, resto de bancarios, resto de no bancarios.
 */
export interface GastosCandidatosRespuesta {
  movimiento: { id: string; fecha: string; monto: number; moneda: string };
  ventana: { desde: string; hasta: string };
  candidatos: Array<
    SugerenciaConciliacion['candidatos'][number] & {
      cruzado?: true;
      no_bancario: boolean;
    }
  >;
  truncado: boolean;
  /**
   * ADITIVO (0.0.75, invariante 70): T.C. oficial (de tabla) del día del
   * cargo, SIEMPRE presente; null en cuenta no MXN, sin dato o con la
   * lectura fallida. El panel lo usa como capacidad (`'tc_oficial' in r`).
   */
  tc_oficial?: { tc: number; fecha_dato: string; fuente: string } | null;
  /**
   * ADITIVO (revisión del lote 2, 14-oct-2026): SOLO cuando la LECTURA del
   * T.C. oficial del día del cargo FALLÓ (≠ «no hay dato»). Entonces
   * `tc_oficial` va null, cada cruzado lleva `tc_cruce.lectura_fallida` con
   * su propio texto y las compras en USD no se pudieron buscar por su monto
   * en pesos: el panel lo dice en ámbar y no promete esa búsqueda.
   */
  tc_oficial_lectura_fallida?: true;
  excluidos?: ExcluidosCandidatos['excluidos'];
  excluidos_monto?: ExcluidosCandidatos['excluidos_monto'];
  /**
   * ADITIVO (0.0.75, invariante 69): SOLO cuando el concepto del cargo cita
   * una factura. `otros_gastos` = gastos a ±120 días que tienen ESA factura
   * y no salen como candidatos (forma de `excluidos`; `conciliado_con` en
   * YA_CONCILIADO); null = no se pudo leer.
   */
  factura_concepto?: {
    tipo: TipoFacturaConcepto;
    numeros: string[];
    texto: string;
    pista: string | null;
    otros_gastos: GrupoExcluidos[] | null;
  };
}

/**
 * GASTO NO BANCARIO CON JUSTIFICACIÓN (6-oct-2026, API 0.0.63): lo que el
 * controller pasa al PATCH `movimientos/:id` además de los ids.
 */
export interface OpcionesVinculo {
  /** Por qué se liga un gasto en efectivo / PERSONAL_* a este cargo. */
  justificacion?: string | null;
  /** Nombre de quien liga (firma de las notas; vacío ⇒ «Oficina»). */
  usuarioNombre?: string | null;
}

/**
 * ADITIVO de la respuesta del PATCH cuando ENTRÓ al menos un gasto no
 * bancario: cuáles y si sus notas quedaron escritas (la liga ya quedó
 * aunque `notas_anotadas` sea false: el panel avisa y la oficina las pone a
 * mano).
 */
export interface VinculoNoBancarioRespuesta {
  gasto_ids: string[];
  notas_anotadas: boolean;
}

/** Fila mínima para reescribir `notas` con CAS (`updated_at`). */
interface FilaNotas {
  id: string;
  notas: string | null;
  updated_at: string | null;
}

function filaNotas(f: Record<string, unknown>): FilaNotas {
  return {
    id: f.id as string,
    notas: typeof f.notas === 'string' ? f.notas : null,
    updated_at: typeof f.updated_at === 'string' ? f.updated_at : null,
  };
}

/** Columnas del gasto para sus notas del vínculo no bancario. */
const GASTO_NOTA_COLS =
  'id, fecha_gasto, monto, moneda, medio_pago, categoria, notas, updated_at, vuelo:vuelo!vuelo_id(folio)';

/** Fila `GASTO_NOTA_COLS` ⇒ lo que la nota del cargo dice del gasto. */
function gastoDeNota(g: Record<string, unknown>): GastoDeNota {
  const vuelo = unwrapOne(
    g.vuelo as { folio?: unknown } | { folio?: unknown }[] | null | undefined,
  );
  const folio = vuelo?.folio == null ? null : Number(vuelo.folio);
  return {
    id: typeof g.id === 'string' ? g.id : '',
    fecha_gasto:
      typeof g.fecha_gasto === 'string' ? g.fecha_gasto.slice(0, 10) : null,
    monto: Number(g.monto) || 0,
    moneda: typeof g.moneda === 'string' ? g.moneda : null,
    medio_pago: typeof g.medio_pago === 'string' ? g.medio_pago : null,
    categoria: typeof g.categoria === 'string' ? g.categoria : null,
    vuelo_folio: folio != null && Number.isFinite(folio) ? folio : null,
  };
}

function unwrapOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

// =====================================================================
// UN COBRO, VARIOS ABONOS — vincular (0.0.78, invariante 77)
// =====================================================================

/** La comisión que «Corregir la comisión y vincular» dejó en el cobro. */
export interface ComisionCorregida {
  cobro_id: string;
  antes: number | null;
  despues: number | null;
}

/** Un cobro que soltó el abono al desvincularlo, con su estado DESPUÉS (D22). */
export interface CobroLiberado {
  cobro_id: string;
  folio: number | null;
  estado: EstadoBancoCobro;
  faltante: number;
  abonos_n: number;
}

/** Lo que hace falta para leer el universo de los sugeridos de un 409. */
interface ContextoSugeridos {
  /** DATE del abono. */
  fecha: string;
  cuenta_bancaria_id: string;
  /** Moneda y tipo de la cuenta ya leídos (ausentes ⇒ se leen). */
  moneda?: string | null;
  tipoCuenta?: string | null;
  /** Cobros que no se sugieren (los que se intentaron ligar). */
  excluir: ReadonlyArray<string>;
}

/** 400 CORREGIR_COMISION_NO_APLICA (D6) con su motivo. */
function errorCorregirComisionNoAplica(
  motivo: MotivoCorregirComisionNoAplica,
): BadRequestException {
  return new BadRequestException({
    message: mensajeCorregirComisionNoAplica(motivo),
    error: 'CORREGIR_COMISION_NO_APLICA',
    details: { motivo },
  });
}

/** 503 CUENTA_SIN_MONEDA: sin la moneda de la cuenta no se cruza de oídas. */
function errorCuentaSinMonedaCobros(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'No se pudo leer la moneda de la cuenta del abono: vuelve a intentarlo en unos segundos.',
    error: 'CUENTA_SIN_MONEDA',
  });
}

/**
 * El error de una liga que falló DESPUÉS de corregir la comisión: la
 * comisión QUEDA (es la verdad del banco) y el texto lo dice; `details`
 * gana `comision_corregida`. Lo que no es un HttpException pasa igual.
 */
function conNotaComisionCorregida(err: unknown, c: ComisionCorregida): unknown {
  if (!(err instanceof HttpException)) return err;
  const r = err.getResponse();
  const cuerpo: Record<string, unknown> =
    typeof r === 'string' ? { message: r } : { ...r };
  const dinero = (n: number | null) => (n == null ? '$0.00' : montoBonito(n));
  const nota =
    c.antes === c.despues
      ? ''
      : ` La comisión del cobro ya quedó corregida a ${dinero(c.despues)} (antes ${dinero(c.antes)}).`;
  cuerpo.message = `${typeof cuerpo.message === 'string' ? cuerpo.message : err.message}${nota}`;
  cuerpo.details = {
    ...(cuerpo.details && typeof cuerpo.details === 'object'
      ? cuerpo.details
      : {}),
    comision_corregida: c,
  };
  // La MISMA clase (ConflictException, ServiceUnavailableException…) y el
  // MISMO status; si no se puede, un HttpException con ese status.
  const status = err.getStatus();
  const Clase = err.constructor as new (body: object) => HttpException;
  if (err.constructor !== HttpException) {
    try {
      const nuevo = new Clase(cuerpo);
      if (nuevo.getStatus() === status) return nuevo;
    } catch {
      // cae al genérico
    }
  }
  return new HttpException(cuerpo, status);
}

/**
 * Fila de `cobro_vuelo` (+ `vuelo` embebido con folio y T.C.) ⇒ lo que ve
 * `puedeLigarCobros`, con las partes de los OTROS abonos.
 */
function cobroParaLoteDeFila(
  c: Record<string, unknown>,
  otras: ParteCobroBanco[],
): CobroParaLote {
  const vuelo = unwrapOne(
    c.vuelo as
      | { folio?: unknown; tc_usd_mxn?: unknown }
      | { folio?: unknown; tc_usd_mxn?: unknown }[]
      | null,
  );
  return {
    id: String(c.id),
    monto: Number(c.monto) || 0,
    moneda: typeof c.moneda === 'string' ? c.moneda : null,
    comision_banco_monto: (c.comision_banco_monto as number | null) ?? null,
    folio: vuelo?.folio == null ? null : Number(vuelo.folio),
    cobro_grupo_id: c.cobro_grupo_id,
    ingreso_anticipo_id: c.ingreso_anticipo_id,
    tc_usd_mxn: (c.tc_usd_mxn as number | string | null) ?? null,
    tc_vuelo: (vuelo?.tc_usd_mxn as number | string | null) ?? null,
    otras,
  };
}

/** Fila del universo de «Vincular» ⇒ sugerido (con lo que le FALTA). */
function sugeridoDeFila(
  c: Record<string, unknown>,
  faltante: number,
): SugeridoCobro {
  const vuelo = unwrapOne(
    c.vuelo as {
      folio?: unknown;
      cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
    } | null,
  );
  const cliente = unwrapOne(vuelo?.cliente);
  return {
    cobro_id: String(c.id),
    vuelo_id: typeof c.vuelo_id === 'string' ? c.vuelo_id : null,
    folio: vuelo?.folio == null ? null : Number(vuelo.folio),
    cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
    fecha_cobro: typeof c.fecha_cobro === 'string' ? c.fecha_cobro : null,
    monto: r2(Number(c.monto) || 0),
    moneda: typeof c.moneda === 'string' ? c.moneda : null,
    faltante: r2(faltante),
  };
}

/** Candidato de «Vincular» ⇒ sugerido (misma forma que `sugeridoDeFila`). */
function sugeridoDeCandidato(c: CandidatoCobroVuelo): SugeridoCobro {
  return {
    cobro_id: c.cobro_id,
    vuelo_id: c.vuelo_id ?? null,
    folio: c.folio,
    cliente: c.cliente,
    fecha_cobro: c.fecha_cobro,
    monto: c.monto,
    moneda: c.moneda,
    faltante: c.faltante ?? c.neto,
  };
}

// Compras EN DÓLARES pagadas con tarjeta: el banco carga PESOS. La banda
// plausible del T.C. implícito (TC_IMPLICITO_MIN/MAX, 15–25) y la regla del
// T.C. OFICIAL del día del cargo (invariante 70) viven en `auto-cruce.util`
// desde el 0.0.75: aquí solo se importan.

export interface ParsedStatement {
  movimientos: Array<{
    fecha: string | null;
    descripcion: string | null;
    monto: number;
    tipo: 'CARGO' | 'ABONO';
    referencia: string | null;
    /** Paywise (aditivo): bruto/comisión/estatus por movimiento. */
    monto_bruto?: number | null;
    comision?: number | null;
    estatus?: string | null;
  }>;
  total: number;
  /** csv | excel | pdf | paywise */
  formato: string;
  notas: string;
  modelo: string | null;
  /** Consumo de tokens (solo PDF; CSV/Excel no usan IA). */
  uso_ia?: UsoIaPayload | null;
  /** Encabezados del archivo (tabular): para el mapeo manual del panel. */
  columnas?: string[];
  /**
   * Avisos del parse (ya llegaban de pyservices; tipados desde el 0.0.75):
   * p. ej. «N transferencia(s) o pago(s) se leyeron SIN su concepto…».
   */
  advertencias?: string[];
}

export interface SugerenciaConciliacion {
  disponible: boolean;
  gasto_id_sugerido: string | null;
  confianza: number;
  razon: string;
  /**
   * ADITIVOS 15-sep-2026. `evidencias` = los hechos que la IA dice haber
   * usado («terminación 0577 == tarjeta del gasto», «monto exacto»): sin
   * evidencias la propuesta se lee con pinzas. `alternativas` = 2.ª y 3.ª
   * opción para el panel. `terminacion_detectada` la calcula el API (no la
   * IA) a partir de la referencia del banco.
   */
  evidencias?: string[];
  alternativas?: Array<{
    gasto_id: string;
    confianza: number;
    razon: string;
  }>;
  terminacion_detectada?: string | null;
  /**
   * Por qué NINGÚN candidato encaja (solo cuando `gasto_id_sugerido` es
   * null). Lo redacta pyservices y el panel lo pinta tal cual: sin él, «no
   * hay propuesta» no dice nada al operador.
   */
  motivo_sin_match?: string | null;
  /** Gastos candidatos considerados (para que el front muestre opciones). */
  candidatos: Array<{
    /** USD = compra en dólares cuyo cargo llegó en pesos (TC implícito). */
    moneda?: string;
    tc_implicito?: number | null;
    id: string;
    fecha: string | null;
    monto: number;
    proveedor: string | null;
    /** Aditivos (14-sep-2026, pagos parciales): lo ya cruzado y lo que falta. */
    monto_vinculado?: number;
    faltante?: number;
    /** Aditivos (15-sep-2026): contexto para desempatar (IA y panel). */
    medio_pago?: string | null;
    tarjeta_terminacion?: string | null;
    categoria?: string | null;
    lugar?: string | null;
    /** Primera línea de `gasto.notas` (la que describe el gasto). */
    nota?: string | null;
    matricula?: string | null;
    vuelo_folio?: number | null;
    capturado_por?: string | null;
    /**
     * ADITIVO (5-oct-2026, API 0.0.57): número de la factura del gasto
     * («FEACZM-72128», «CFDI <uuid>»; null = sin folio). Fuente única
     * `common/folio-comprobante.util`.
     */
    folio_comprobante?: string | null;
    /**
     * ADITIVO (0.0.75, invariante 69): SOLO en «Vincular gasto» y solo
     * cuando el concepto del cargo cita una factura: el folio del gasto
     * (factura recibida, ticket, IA o «fact NNNN» en la 1.ª línea de las
     * notas) es esa factura. Ordena dentro de su nivel; jamás liga.
     */
    coincide_factura?: boolean;
    /**
     * ADITIVO (0.0.75, invariante 70): SOLO en los cruzados (USD contra
     * cuenta MXN): T.C. implícito contra el oficial del día del cargo, con
     * su nivel, su marca y sus textos (`tcCruceUsdPublico`).
     */
    tc_cruce?: TcCruceUsd;
    /**
     * ADITIVO (0.0.76, revisión del 14-oct-2026, invariante 74): el
     * CANDADO DEL MES DEL VUELO del gasto (`candadoMesDelVuelo`, la misma
     * regla del 409 FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO): su fecha solo se
     * mueve dentro del mes que ya tiene o al mes de ese vuelo. Ausente =
     * sin candado (sin vuelo, fecha ilegible o categoría que no lo lleva).
     * El panel no invita a corregir la fecha a un mes que el API rechaza.
     */
    candado_mes_vuelo?: {
      /** Día Cancún del vuelo (YYYY-MM-DD). */
      vuelo_dia: string;
      vuelo_folio: number | null;
    } | null;
  }>;
}

/**
 * Resultado del auto-cruce de UN movimiento (import y re-cruce hablan el
 * mismo idioma). `motivo` es el texto que el panel muestra para explicar
 * POR QUÉ un movimiento sigue pendiente — la pregunta literal del cliente.
 */
export interface ResultadoMovimiento {
  movimiento_id: string;
  resultado: ResultadoCruce;
  criterio: CriterioCruce | null;
  motivo: string | null;
  candidatos_n: number;
  gasto_id?: string | null;
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
  /** ADITIVO (24-sep-2026): el abono se ligó a un INGRESO registrado. */
  ingreso_id?: string | null;
  /**
   * ADITIVO (30-sep-2026): resultado REVERSO. En el ABONO = el cargo que
   * devuelve; en el CARGO = el abono que lo devolvió (`reverso_par_id`).
   */
  reverso_de_id?: string | null;
  reverso_par_id?: string | null;
}

/**
 * Cobro cargado por `cargarCobrosPorMetodo` (forma pura del cruce Paywise)
 * + la liga a su ANTICIPO cuando se pide con `anticipos: 'INCLUIR'` (solo
 * `cobrosSinBanco`, y solo con la migración de ingresos).
 */
type CobroCargado = CobroPaywise & { ingreso_anticipo_id?: string | null };

/** Ingreso vivo leído como candidato de un abono (auto-cruce / diálogos / IA). */
interface IngresoCandidatoRow {
  id: string;
  folio: number;
  categoria: string;
  fecha: string;
  monto: number;
  comision_monto: number | null;
  moneda: string;
  cuenta_bancaria_id: string | null;
  cliente: string | null;
  descripcion: string;
  referencia: string | null;
}

/** Columnas del ingreso candidato (embed del cliente por la columna FK). */
const INGRESO_CANDIDATO_COLS =
  'id, folio, categoria, fecha, monto, comision_monto, moneda, cuenta_bancaria_id, pagador, descripcion, referencia, cliente:cliente_id(nombre)';

/** Tope de filas por universo en las lecturas en lote (paginadas de 1000). */
const TOPE_UNIVERSO = 3000;
/** Página de PostgREST (corta en 1000 aunque se pida más). */
const PAGINA_BD = 1000;
/** Ventana ±días de los candidatos MANUALES e IA de un abono. */
const VENTANA_MANUAL_DIAS = 30;
/** Abonos por llamada a la IA y llamadas máximas por request. */
const IA_ABONOS_POR_LOTE = 10;
const IA_LOTES_MAX = 3;
/** Candidatos por abono enviados a la IA (y tope del pool por llamada). */
const IA_CANDIDATOS_POR_ABONO = 12;
const IA_CANDIDATOS_POR_ABONO_RECORTE = 8;
const IA_POOL_MAX = 120;
/** Timeout de cada llamada a pyservices (la IA tarda con 10 abonos). */
const IA_TIMEOUT_MS = 130_000;
/** Categoría del consumo de IA (Configuración → Consumo de IA). */
const IA_CATEGORIA_ABONOS = 'CONCILIACION_ABONOS_SUGERIR';

/**
 * Candidato de un abono leído EN LOTE para «Por conciliar» y la IA: cobro
 * de vuelo, sobre de grupo o ingreso registrado, con todo lo que la ficha,
 * la decisión y la IA necesitan. `libre` = ningún movimiento lo concilia.
 */
interface CandidatoAbonoLeido {
  tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO' | 'INGRESO';
  id: string;
  /** BRUTO. */
  monto: number;
  comision: number | null;
  neto: number;
  moneda: string;
  /** Día Cancún (YYYY-MM-DD). */
  dia: string;
  /** ISO del cobro (o la fecha del ingreso). */
  fecha_cobro: string;
  /** ADITIVO (12-oct-2026, invariante 54): día del vuelo (cobro o sobre); null en ingresos. */
  fecha_vuelo?: string | null;
  metodo: string | null;
  cliente: string | null;
  /** Folio del vuelo, del grupo (G-n) o del ingreso (ING-n). */
  folio: number | null;
  referencia: string | null;
  vuelo_id: string | null;
  grupo_id: string | null;
  cuenta_bancaria_id: string | null;
  /** Alias de la cuenta del INGRESO (null en cobros/sobres). */
  cuenta_alias: string | null;
  categoria: string | null;
  es_anticipo: boolean;
  descripcion: string | null;
  libre: boolean;
  /**
   * Solo COBRO_VUELO PARCIAL (0.0.78, invariante 77, con la sonda de
   * 20261014000003): lo que le FALTA (sus abonos no lo cubren). Libre SOLO
   * por ese monto exacto (`montoExactoAbono`, la decisión del auto); un
   * abono de la PASARELA no lo ve y la IA no lo recibe (v1). Ausente = sin
   * abonos.
   */
  faltante?: number | null;
  /**
   * INTERNO (revisión del 15-oct-2026, invariante 77). Solo COBRO_VUELO con
   * la sonda de 20261014000003: cómo lo ven los FRENOS anti doble conteo
   * (`cobroParaCruce(…, {freno: true})`, la regla del trigger A sin el
   * método PAYWISE), igual que `cobrosExactosLibresDeAbono` del AUTO.
   * `libre`/`faltante` siguen con la regla de LIGAR (lo que la IA y el auto
   * pueden ligar). Ausente = igual que `libre`/`faltante`. Nunca viaja.
   */
  freno?: { libre: boolean; faltante: number | null };
}

/**
 * Vista de FRENO de un candidato (revisión del 15-oct-2026): la ocupación y
 * el faltante con la regla del trigger A sin el método PAYWISE. Un cobro
 * PAYWISE sin comisión con un SPEI de banco ES un parcial que la BD deja
 * completar: los frenos (el espejo del auto en «Por conciliar» y la guarda
 * D12 de la IA) lo cuentan aunque el auto no lo ligue.
 */
function vistaFrenoCandidato(c: CandidatoAbonoLeido): CandidatoAbonoLeido {
  if (!c.freno) return c;
  const { freno, faltante: _faltante, ...resto } = c;
  void _faltante;
  return {
    ...resto,
    libre: freno.libre,
    ...(freno.faltante != null ? { faltante: freno.faltante } : {}),
  };
}

/** Acciones que la IA puede proponer para un abono. */
const ACCIONES_PROPUESTA = [
  'LIGAR',
  'REGISTRAR_INGRESO',
  'CLASIFICAR_TRASPASO',
  'CLASIFICAR_REVERSO',
  'REVISAR',
] as const;

/** Contexto compartido del auto-cruce (se carga UNA vez por corrida). */
interface CruceCtx {
  /** Terminaciones de `tarjeta_corporativa` activas (desempate por tarjeta). */
  terminaciones: string[];
  /** Id de la clasificación «Traspaso entre cuentas» (perezoso). */
  clasificacionTraspaso?: string | null;
  /**
   * CRUCE USD (0.0.75, invariante 70): T.C. oficial por DÍA, memorizado por
   * corrida (se guarda la PROMESA: dos cargos del mismo día comparten la
   * lectura). `fallo` = la lectura no se pudo hacer (≠ «no hay dato»).
   */
  tcOficial: Map<
    string,
    Promise<{ oficial: OficialDelDia | null; fallo: boolean }>
  >;
  /** ¿Puede descargar el T.C. que falte? (solo la importación, job asíncrono). */
  descargarTc: boolean;
  /** Ids de las cuentas en pesos (recíproco), memorizado; null = lectura fallida. */
  cuentasMxn?: Promise<string[] | null>;
}

/**
 * Columnas de un movimiento para el emparejado cargo ↔ devolución
 * (30-sep-2026). Solo se piden con la migración 20260930000001 aplicada
 * (`reversosOn`); `ingreso_id` se agrega detrás de su propia sonda.
 */
const MOV_REVERSO_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, notas, conciliado, gasto_id, cobro_id, cobro_grupo_id, clasificacion_id, reverso_de_id, created_at';

/** Fila de `movimiento_bancario` leída con `MOV_REVERSO_COLS`. */
export interface MovReversoRow extends MovimientoReverso, MovimientoParReverso {
  tipo: string;
  monto: number;
  notas: string | null;
  conciliado: boolean;
}

/** Tope de devoluciones/cargos que lee una corrida del emparejado. */
const REVERSO_TOPE = 3000;

/** Tope de filas del detalle que devuelve el re-cruce (respuesta acotada). */
const DETALLE_MAX = 300;

/** Tope de movimientos por corrida del re-cruce (evita respuestas eternas). */
const RECRUCE_MAX = 2000;

/**
 * 409 CONFLICTO_CONCURRENTE del emparejado de reverso (revisión del
 * 14-oct-2026): Postgres resolvió un interbloqueo (40P01) abortando ESTA
 * operación —p. ej. contra «Omitir» de un lote con el abono y el cargo—.
 * Mismo código y texto que `errorRpcOmision` / `errorRpcCargosGasto`.
 */
function conflictoConcurrenteReverso(): ConflictException {
  return new ConflictException({
    message: MENSAJE_CONFLICTO_CONCURRENTE,
    error: 'CONFLICTO_CONCURRENTE',
  });
}

/** Banda de tolerancia de monto (±5%) para juntar gastos candidatos. */
const MATCH_MONTO_PCT = 0.05;

/**
 * Tope de gastos que lee el cálculo del «por qué sigue pendiente» de la
 * lista. Si la ventana trae MÁS que esto, la foto está incompleta y NO se
 * anota ningún motivo (un «sin candidato» falso sería peor que no decir nada).
 */
const MOTIVO_GASTOS_MAX = 4000;

/**
 * OMITIR / VARIOS CARGOS (14-oct-2026, invariantes 75 y 76): ids por lote en
 * las lecturas `.in('id', …)` de movimientos (URL de PostgREST acotada).
 */
const LOTE_IDS_OMISION = 150;
/** Memo POSITIVO del id de la canónica «Omitido de la conciliación». */
const OMITIDO_MEMO_MS = 10 * 60_000;
/** Tope de omitidos que lee el renglón del pre-cierre (paginado). */
const OMITIDOS_PRECIERRE_TOPE = 20_000;

/** Rango de monto de la búsqueda de «Vincular gasto» (`interpretarBusquedaGasto`). */
interface RangoMontoGasto {
  min: number;
  max: number;
  maxExclusivo: boolean;
}

/**
 * Parte de la puente `movimiento_bancario_gasto` (2-oct-2026, migración
 * 20261002000002): lo que UN cargo aporta a UN gasto, en la moneda de la
 * CUENTA del cargo.
 */
interface ParteCargoGasto {
  movimiento_id: string;
  gasto_id: string;
  monto_parte: number;
  moneda: string | null;
  created_at: string | null;
  /**
   * Quién registró la liga (`created_by` de la puente). Solo viene cuando
   * se leyó con `{conAutor: true}` (conciliación al revés, invariante 71).
   */
  ligada_por?: string | null;
}

/** Estado de un gasto según `v_gasto_conciliacion` (fuente única en BD). */
interface EstadoVistaGasto {
  n_partes: number;
  cruzado: boolean;
  suma: number;
  monto_vinculado: number;
  faltante: number;
  cubierto: boolean;
}

/** Columnas de `v_gasto_conciliacion`. */
const VISTA_CONCILIACION_COLS =
  'gasto_id, n_partes, cruzado, suma, monto_vinculado, faltante, cubierto';

/** Columnas de la puente que leen los lectores. */
const PARTE_COLS = 'movimiento_id, gasto_id, monto_parte, moneda, created_at';

/**
 * CONCILIACIÓN AL REVÉS (13-oct-2026, API 0.0.75, invariante 71): quién
 * registró la liga (FK `movimiento_bancario_gasto_created_by_fkey`).
 */
const PARTE_AUTOR_EMBED = 'ligador:usuario!created_by(nombre)';

/**
 * El cargo de un gasto con su cuenta, su estado de cuenta (y quién lo
 * importó) y quién lo creó. JAMÁS `numero_cuenta`, `clabe` ni
 * `storage_path` (la descarga es POST estados-cuenta/:id/url). FK
 * verificadas en prod: movimiento_bancario_cuenta_bancaria_id_fkey,
 * movimiento_bancario_estado_cuenta_id_fkey,
 * estado_cuenta_archivo_created_by_fkey y
 * movimiento_bancario_created_by_fkey. `gastos_n` y `orden_archivo` se
 * agregan detrás de sus sondas.
 */
const MOV_DETALLE_GASTO_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, conciliado, gasto_id, origen, notas, created_at, estado_cuenta_id, cuenta:cuenta_bancaria!cuenta_bancaria_id(id, alias, banco, moneda, tipo), estado_cuenta:estado_cuenta_archivo!estado_cuenta_id(id, filename, formato, movimientos_importados, created_at, importo:usuario!created_by(nombre)), creo:usuario!created_by(nombre)';

/**
 * CONCILIACIÓN AL REVÉS DE UNA ENTRADA (14-oct-2026, API 0.0.78, invariante
 * 78): el ABONO de un cobro o de un ingreso = lo de un cargo de gasto
 * (`MOV_DETALLE_GASTO_COLS`, cuya constante NO cambia) + lo de la pasarela y
 * sus ligas. `cobros_n`, `ingreso_id` y `orden_archivo` se agregan detrás de
 * sus sondas. JAMÁS `numero_cuenta`, `clabe` ni `storage_path`.
 */
const MOV_DETALLE_ABONO_COLS = `${MOV_DETALLE_GASTO_COLS}, monto_bruto, comision_monto, cobro_id, cobro_grupo_id`;

/**
 * El COBRO de la hoja con su vuelo + cliente y su sobre (FK verificadas en
 * prod: cobro_vuelo_vuelo_id_fkey, vuelo_cliente_id_fkey,
 * cobro_vuelo_cobro_grupo_id_fkey). Las notas crudas NO viajan (solo
 * `conceptoDeCobro`); jamás `foto_voucher_url`.
 */
const COBRO_HOJA_COLS =
  'id, vuelo_id, monto, moneda, metodo_cobro, comision_banco_monto, tc_usd_mxn, fecha_cobro, referencia, notas, cuenta_destino, registrado_por, created_at, cobro_grupo_id, vuelo:vuelo!vuelo_id(folio, cliente_id, cliente:cliente_id(nombre)), sobre:cobro_grupo!cobro_grupo_id(id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre))';

/** + el anticipo del cobro, SOLO con la sonda de ingresos (FK cobro_vuelo_ingreso_anticipo_id_fkey). */
const COBRO_HOJA_ANTICIPO_COLS =
  ', ingreso_anticipo_id, anticipo:ingreso!ingreso_anticipo_id(id, folio, monto, moneda, fecha, cuenta_bancaria_id)';

/**
 * El INGRESO de la hoja, vivo o de baja (FK ingreso_cliente_id_fkey,
 * ingreso_vuelo_id_fkey, ingreso_cuenta_bancaria_id_fkey). Nunca
 * `archivo_path`, `notas` ni la bitácora cruda.
 */
const INGRESO_HOJA_COLS =
  'id, folio, categoria, fecha, descripcion, monto, comision_monto, moneda, tc_usd_mxn, metodo, cuenta_bancaria_id, pagador, created_by, created_at, deleted_at, vuelo_id, cliente:cliente_id(nombre), vuelo:vuelo_id(folio), cuenta:cuenta_bancaria!cuenta_bancaria_id(id, alias, banco, moneda, tipo)';

/** Ids por consulta `in (…)` de la conciliación al revés de una entrada (URL de PostgREST: 200 uuids ⇒ 414). */
const LOTE_IDS_ENTRADA = 150;

/** Tope de vuelos de UN cliente para «mismo día» (paginado de 1000 en 1000; el mayor de prod tiene decenas). */
const TOPE_VUELOS_CLIENTE = 10_000;

/** El gasto de la conciliación al revés (+ `embedFolio()` para su factura). */
const GASTO_CONCILIACION_COLS =
  'id, monto, moneda, tc_gasto, conciliado, medio_pago, tarjeta_terminacion, categoria, fecha_gasto, vuelo_id, lugar, notas, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)';

/**
 * Gasto de cada parte en la lista de movimientos (forma de `MovimientoGasto`).
 * `medio_pago` (ADITIVO 6-oct-2026): el panel marca «Efectivo» en un gasto
 * no bancario ligado con justificación.
 */
const GASTO_PARTE_LISTA_COLS =
  'id, monto, moneda, categoria, fecha_gasto, vuelo_id, lugar, notas, medio_pago, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)';

/** Gasto de cada parte en el Excel (categoría, matrícula, vuelo). */
const GASTO_PARTE_REPORTE_COLS =
  'id, categoria, vuelo_id, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id)';

/**
 * Gasto candidato con TODO el contexto (IA, selector del panel). Se pide
 * SIEMPRE junto con `embedFolioGasto(…)` (`gastoRicoCols()`): el número de
 * factura depende de la sonda de la migración 20261005000002. La
 * `fecha_vuelo` del embed alimenta `candado_mes_vuelo` (revisión del
 * 14-oct-2026).
 */
const GASTO_RICO_COLS = `${GASTO_CRUCE_COLS}, aeronave:aeronave!aeronave_id(matricula), vuelo:vuelo!vuelo_id(folio, fecha_vuelo), captura:usuario!usuario_captura_id(nombre)`;

/** Lo que la traducción de errores de partes necesita saber del intento. */
interface CtxErrorPartes {
  movId: string;
  ids: string[];
  cuentaMoneda: string | null;
  /** |monto| del cargo. */
  montoCargo: number;
  gastos: Map<
    string,
    { id: string; monto: number; moneda: string | null; conciliado?: boolean }
  >;
  /** Veredicto TS del lote (null con UN gasto o al desligar). */
  lote: PuedeRepartirResultado | null;
}

/** Tope de gastos que lee el endpoint de candidatos de un cargo (una página). */
const CANDIDATOS_GASTO_TOPE = 1000;

/**
 * CONCEPTO DEL SPEI (13-oct-2026, API 0.0.75, invariante 69): filas previas
 * que lee el dedupe de una importación (paginadas; con más ⇒ 400 «impórtalo
 * por partes») y archivos cuya dirección se lee para ORDEN_ARCHIVO.
 */
const PREVIOS_DEDUPE_TOPE = 20_000;
const DIRECCIONES_ARCHIVO_MAX = 5;
/** Tope de `no_encontrados_detalle` (modo `solo_enriquecer`). */
const NO_ENCONTRADOS_DETALLE_MAX = 50;
/** Universo de `repetida_en`: UNA página de PostgREST; llegar a ella ⇒ null. */
const REPETIDAS_UNIVERSO_TOPE = 1000;

/** Gastos USD conciliados que revisa el aviso del pre-cierre (más ⇒ null). */
const LIGAS_USD_GASTOS_TOPE = 5000;

/**
 * Movimientos que lee `resumen()` (tarjetas por cuenta de Conciliación),
 * PAGINADOS por la PK (14-oct-2026): con más ⇒ 400 `RESUMEN_MUY_GRANDE`
 * (jamás un total recortado).
 */
const RESUMEN_MOVIMIENTOS_TOPE = 20_000;
export const MENSAJE_RESUMEN_MUY_GRANDE =
  'El periodo trae más de 20,000 movimientos del banco: elige un rango de fechas más corto para ver el resumen por cuenta.';

/** Una fila completada, tal como viaja en el rastro y en la vista previa. */
export interface DetalleEnriquecido {
  movimiento_id: string;
  fecha: string;
  tipo: string;
  monto: number;
  antes: string;
  despues: string;
  regla: ReglaEnriquecimiento;
}

function detalleEnriquecido(e: EnriquecimientoPlaneado): DetalleEnriquecido {
  return {
    movimiento_id: e.previo_id,
    fecha: e.fecha,
    tipo: e.tipo,
    monto: e.monto,
    antes: e.antes,
    despues: e.despues,
    regla: e.regla,
  };
}

/** Σ de los movimientos que se quedaron sin concepto (todos los omitidos). */
function movimientosOmitidos(
  omitidos: readonly EnriquecimientoOmitido[],
): number {
  return omitidos.reduce((acc, o) => acc + o.movimiento_ids.length, 0);
}

/**
 * Respuesta de `importar` / `importar-async` (resultados del job). Los
 * campos del 0.0.75 son ADITIVOS: `enriquecidos`, `enriquecimiento_omitidos`
 * y `enriquecimiento` siempre; `nuevos_mismo_dia_y_monto(_detalle)` solo en
 * el modo normal; `solo_enriquecer`, `no_encontrados(_detalle)` solo con
 * `solo_enriquecer`.
 */
// `type` (no `interface`): los specs la leen como `Record<string, unknown>`.
export type ResultadoImportacion = {
  importados: number;
  conciliados_auto: number;
  duplicados_omitidos: number;
  conciliados: number;
  traspasos: number;
  reversos: number;
  reversos_emparejados: number;
  ambiguos: number;
  sin_candidato: number;
  rechazados: number;
  errores: number;
  por_criterio: Record<string, number>;
  detalle: ResultadoMovimiento[];
  enriquecidos?: number;
  enriquecimiento_omitidos?: number;
  enriquecimiento?: {
    estado_cuenta_id: string | null;
    detalle: DetalleEnriquecido[];
    omitidos: EnriquecimientoOmitido[];
  };
  nuevos_mismo_dia_y_monto?: number;
  nuevos_mismo_dia_y_monto_detalle?: Array<{
    orden_archivo: number;
    fecha: string;
    tipo: string;
    monto: number;
    moneda: string | null;
    descripcion: string | null;
  }>;
  solo_enriquecer?: true;
  no_encontrados?: number;
  no_encontrados_detalle?: Array<{
    orden_archivo: number;
    fecha: string;
    tipo: string;
    monto: number;
    moneda: string | null;
    descripcion: string | null;
    referencia: string | null;
    factura: string | null;
  }>;
};

// =====================================================================
// OMITIR LA CONCILIACIÓN y VARIOS CARGOS → UN GASTO (14-oct-2026, API
// 0.0.77, invariantes 75 y 76): formas de las respuestas nuevas.
// =====================================================================

/** Un movimiento revisado antes de omitirlo (`POST movimientos/omitir/revisar`). */
export interface MovimientoRevisadoOmision {
  id: string;
  fecha: string | null;
  /** 'CARGO' | 'ABONO' (texto de la BD). */
  tipo: string;
  monto: number;
  moneda: string | null;
  descripcion: string | null;
  cuenta_alias: string | null;
  estado: EstadoParaOmitir;
  texto_estado: string | null;
  riesgo: RiesgoOmision | null;
  texto_riesgo: string | null;
  candidatos_n: number | null;
}

export interface RevisionOmisionRespuesta {
  movimientos: MovimientoRevisadoOmision[];
  no_existen: string[];
  resumen: {
    n: number;
    pendientes: number;
    no_pendientes: number;
    con_riesgo: number;
  };
}

/** Candidato de «Vincular a un gasto» con la cuenta de la suma. */
export type CandidatoGastoPorSuma =
  SugerenciaConciliacion['candidatos'][number] & {
    no_bancario: boolean;
    resultado: ResultadoSuma;
    faltante_tras: number;
    excedente: number;
  };

/** `POST cargos/gastos-candidatos`. */
export interface CargosGastosCandidatosRespuesta {
  cargos: {
    ids: string[];
    n: number;
    suma: number;
    moneda: string;
    fecha_min: string;
    fecha_max: string;
    cuentas: Array<{ id: string; alias: string | null }>;
    terminacion_comun: string | null;
  };
  ventana: { desde: string; hasta: string };
  candidatos: CandidatoGastoPorSuma[];
  truncado: boolean;
  /** Cargos que tienen SU propio gasto que cuadra (null = no se pudo revisar). */
  cargos_con_candidato_propio: Array<{
    id: string;
    motivo: 'SE_PUEDE_CRUZAR' | 'AMBIGUO';
    candidatos_n: number | null;
  }> | null;
  excluidos?: ExcluidosCandidatos['excluidos'];
  excluidos_monto?: ExcluidosCandidatos['excluidos_monto'];
}

/** Lo que devuelve la RPC `conciliacion_ligar_cargos_a_gasto`. */
export interface LigaCargosAGasto {
  gasto_id: string;
  idempotente: boolean;
  nuevos: string[];
  partes: Array<{ movimiento_id: string; monto_parte: number; moneda: string }>;
  gasto_estado: {
    monto: number;
    moneda: string;
    n_partes: number;
    monto_vinculado: number;
    faltante: number;
    cubierto: boolean;
  };
}

/** `POST gastos/:id/cargos` (= la RPC + los movimientos RELEÍDOS). */
export interface LigarCargosAGastoRespuesta extends LigaCargosAGasto {
  movimientos: Array<Record<string, unknown>>;
}

/** Gasto contra el que se prevalida el alta por la suma. */
export interface GastoNuevoParaCargos {
  moneda: string;
  monto: number;
  medio_pago: string;
  fecha_gasto?: string | null;
}

@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly iaUso: IaUsoService,
    // Modelo de IA configurado (2-oct-2026) ⇒ header `X-IA-Modelo` en las
    // llamadas DIRECTAS a pyservices (parse / sugerir / sugerir-abonos).
    // @Optional: los specs construyen el service sin él.
    @Optional() private readonly configuracion?: ConfiguracionService,
    // T.C. OFICIAL del día del cargo (13-oct-2026, invariante 70): sin él no
    // hay oficial ⇒ el cruce USD ↔ MXN queda AMBIGUO y
    // `ligasUsdTcFueraDeLugar` responde null. @Optional: los specs
    // construyen el service sin él.
    @Optional() private readonly tipoCambio?: TipoCambioService,
  ) {}

  /**
   * INICIO OFICIAL (16-oct-2026, invariante 86): `desde` con piso para las
   * LISTAS y bandejas (anclas). JAMÁS en candidatos ni ventanas ±N días: un
   * cargo del 2-sep sigue viendo gastos del 30-ago.
   */
  private async pisoDesde(desde: string): Promise<string> {
    return pisoDia(desde, await inicioOficialDe(this.configuracion)) ?? desde;
  }

  /** `{ 'X-IA-Modelo': id }` con modelo configurado; `{}` si no. Nunca lanza. */
  private async headersModeloIa(): Promise<Record<string, string>> {
    return this.configuracion ? this.configuracion.headersModeloIa() : {};
  }

  // =====================================================================
  // INGRESOS (24-sep-2026): sonda ÚNICA de la migración 20260924000004.
  // Todo lo que nombre `ingreso_id`, `ingreso_anticipo_id` o la tabla
  // `ingreso` va detrás de ella: sin la migración, conciliación responde
  // EXACTAMENTE como hoy.
  // =====================================================================

  /** ¿Está aplicada la migración de ingresos? (memorizado, re-sondeo ≤ 10 min). */
  private ingresosOn(): Promise<boolean> {
    return ingresosDisponibles(this.supabase.service);
  }

  /**
   * NÚMERO DE FACTURA DEL GASTO (5-oct-2026, API 0.0.57): columnas del gasto
   * para calcular su `folio_comprobante` (`common/folio-comprobante.util`).
   * `serie`/`folio` de la factura recibida solo con la migración
   * 20261005000002 (sonda ÚNICA); sin ella, la factura aporta su UUID.
   */
  private async embedFolio(): Promise<string> {
    return embedFolioGasto(
      await serieFolioRecibidaDisponible(this.supabase.service),
    );
  }

  /** `GASTO_RICO_COLS` + las columnas del número de factura. */
  private async gastoRicoCols(): Promise<string> {
    return `${GASTO_RICO_COLS}, ${await this.embedFolio()}`;
  }

  /**
   * `MOV_COLS` + `ingreso_id` con la migración de ingresos y + `gastos_n`
   * con la de partes (si no, las de siempre).
   */
  private async movCols(): Promise<string> {
    const [ingresos, partes, cobros] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
      this.cobrosLoteOn(),
    ]);
    return `${MOV_COLS}${ingresos ? ', ingreso_id' : ''}${partes ? ', gastos_n' : ''}${cobros ? ', cobros_n' : ''}`;
  }

  // =====================================================================
  // 1 CARGO ↔ N GASTOS (2-oct-2026, API 0.0.52): sonda ÚNICA de la
  // migración 20261002000002. Todo lo que nombre `gastos_n`, la puente
  // `movimiento_bancario_gasto` o la vista `v_gasto_conciliacion` va
  // detrás de ella: sin la migración, conciliación responde EXACTAMENTE
  // como el 0.0.51 (espejo `gasto_id` y |monto| del movimiento).
  // =====================================================================

  /** ¿Está aplicada la migración de partes? (memorizado, re-sondeo ≤ 10 min). */
  /** ¿Existe `movimiento_bancario.orden_archivo`? (invariante 55; memorizado). */
  private ordenArchivoOn(): Promise<boolean> {
    return ordenArchivoDisponible(this.supabase.service);
  }

  private partesOn(): Promise<boolean> {
    return partesDisponibles(this.supabase.service);
  }

  /** ¿Puente abono ↔ cobros aplicada? (12-oct-2026, invariante 56). */
  private cobrosLoteOn(): Promise<boolean> {
    return cobrosLoteDisponibles(this.supabase.service);
  }

  /**
   * ¿Un cobro ya acepta VARIOS abonos? (14-oct-2026, invariante 77, sonda
   * de 20261014000003). Gatea lo que ESCRIBE o propone el segundo abono; las
   * lecturas de estado no.
   */
  private cobrosParcialesOn(): Promise<boolean> {
    return cobrosParcialesDisponibles(this.supabase.service);
  }

  /** Fila cruda de la puente ⇒ parte (tipos normalizados). */
  private aParte(f: Record<string, unknown>): ParteCargoGasto {
    const parte: ParteCargoGasto = {
      movimiento_id: f.movimiento_id as string,
      gasto_id: f.gasto_id as string,
      monto_parte: r2(Math.abs(Number(f.monto_parte) || 0)),
      moneda: typeof f.moneda === 'string' ? f.moneda : null,
      created_at: typeof f.created_at === 'string' ? f.created_at : null,
    };
    // Solo si se pidió el autor (`{conAutor: true}`): sin él, la parte sale
    // byte a byte como siempre.
    if ('ligador' in f) {
      const autor = unwrapOne(
        f.ligador as { nombre?: unknown } | { nombre?: unknown }[] | null,
      );
      parte.ligada_por =
        typeof autor?.nombre === 'string' ? autor.nombre : null;
    }
    return parte;
  }

  /**
   * Partes de estos movimientos (lotes de ≤ 200 ids, cada lote PAGINADO por
   * la PK de la puente: 200 cargos × hasta 50 partes son 10,000 filas y
   * PostgREST corta en 1000 sin avisar; un error se LANZA).
   */
  private async partesDeMovimientos(
    movIds: ReadonlyArray<string>,
  ): Promise<ParteCargoGasto[]> {
    const filas = await this.leerPorLotesPaginado(
      movIds,
      (lote, desde, hasta) =>
        this.supabase.service
          .from('movimiento_bancario_gasto')
          .select(PARTE_COLS)
          .in('movimiento_id', lote)
          .order('movimiento_id', { ascending: true })
          .order('gasto_id', { ascending: true })
          .range(desde, hasta),
    );
    return filas
      .map((f) => this.aParte(f))
      .sort((a, b) =>
        (a.created_at ?? '') !== (b.created_at ?? '')
          ? (a.created_at ?? '') < (b.created_at ?? '')
            ? -1
            : 1
          : a.gasto_id < b.gasto_id
            ? -1
            : a.gasto_id > b.gasto_id
              ? 1
              : 0,
      );
  }

  /**
   * Partes de estos gastos (todas sus ligas, de cualquier cargo), en lotes
   * de ≤ 200 ids PAGINADOS por la PK de la puente (anti-tope de 1000).
   * `conAutor` (conciliación al revés, invariante 71) agrega quién registró
   * cada liga (`ligada_por`) en la MISMA lectura; sin la opción, la
   * consulta es byte a byte la de siempre.
   */
  private async partesDeGastos(
    gastoIds: ReadonlyArray<string>,
    opts: { conAutor?: boolean } = {},
  ): Promise<ParteCargoGasto[]> {
    const cols: string = opts.conAutor
      ? `${PARTE_COLS}, ${PARTE_AUTOR_EMBED}`
      : PARTE_COLS;
    const filas = await this.leerPorLotesPaginado(
      gastoIds,
      (lote, desde, hasta) =>
        this.supabase.service
          .from('movimiento_bancario_gasto')
          .select(cols)
          .in('gasto_id', lote)
          .order('gasto_id', { ascending: true })
          .order('movimiento_id', { ascending: true })
          .range(desde, hasta),
    );
    return filas.map((f) => this.aParte(f));
  }

  /**
   * Estado de conciliación por gasto desde `v_gasto_conciliacion` (la MISMA
   * expresión que `recalcular_gasto_conciliado`: una parte cruzada ⇒
   * vinculado = monto y faltante 0; si no, Σ partes no cruzadas). Un gasto
   * que no aparezca en la vista no tiene partes.
   */
  private async estadosVistaDe(
    gastoIds: ReadonlyArray<string>,
  ): Promise<Map<string, EstadoVistaGasto>> {
    const filas = await this.leerPorLotes(gastoIds, (lote) =>
      this.supabase.service
        .from('v_gasto_conciliacion')
        .select(VISTA_CONCILIACION_COLS)
        .in('gasto_id', lote),
    );
    const out = new Map<string, EstadoVistaGasto>();
    for (const f of filas) {
      if (typeof f.gasto_id !== 'string') continue;
      out.set(f.gasto_id, {
        n_partes: Math.trunc(Number(f.n_partes) || 0),
        cruzado: f.cruzado === true,
        suma: r2(Number(f.suma) || 0),
        monto_vinculado: r2(Number(f.monto_vinculado) || 0),
        faltante: r2(Number(f.faltante) || 0),
        cubierto: f.cubierto === true,
      });
    }
    return out;
  }

  /**
   * 409 `MOVIMIENTO_YA_LIGADO` para un movimiento conciliado con un
   * INGRESO: ni otra liga, ni clasificar, ni desvincular por estos caminos
   * (el de ingresos es `PATCH movimientos/:id/ingreso`). Sin este pre-check,
   * `conciliado=false` con `ingreso_id` puesto chocaría con el CHECK y
   * saldría un 23514 con un texto equivocado.
   */
  private async conflictoMovimientoConIngreso(
    ingresoId: string,
  ): Promise<ConflictException> {
    let folio: number | null = null;
    try {
      const { data } = await this.supabase.service
        .from('ingreso')
        .select('folio')
        .eq('id', ingresoId)
        .maybeSingle();
      const f = (data as { folio?: unknown } | null)?.folio;
      folio = f == null ? null : Number(f);
    } catch {
      folio = null;
    }
    return new ConflictException({
      message: `Este abono ya está conciliado con el ingreso ${etiquetaIngreso(folio)}: desvincúlalo antes.`,
      error: 'MOVIMIENTO_YA_LIGADO',
      details: { liga: 'INGRESO', ingreso_id: ingresoId },
    });
  }

  /** Fila de la bitácora del ingreso (best-effort: jamás tumba la liga). */
  private async bitacoraIngreso(
    ingresoId: string,
    accion: 'CONCILIAR' | 'DESCONCILIAR',
    userId: string,
    diff: Record<string, unknown>,
    nota: string | null,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.service
        .from('ingreso_bitacora')
        .insert({
          ingreso_id: ingresoId,
          accion,
          actor_id: userId,
          diff,
          nota,
        });
      if (error) throw new Error(error.message);
    } catch (err) {
      this.logger.warn(
        `Bitácora ${accion} del ingreso ${ingresoId} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lectura PAGINADA (PostgREST corta en 1000 sin avisar aunque se pida
   * más). `tope` = máximo de filas: si se alcanza, `truncado` (el llamador
   * decide; nunca se da por completa una foto recortada).
   */
  private async leerPaginado(
    pagina: (
      desde: number,
      hasta: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
    tope: number,
  ): Promise<{ filas: Array<Record<string, unknown>>; truncado: boolean }> {
    const filas: Array<Record<string, unknown>> = [];
    for (let i = 0; i < tope; i += PAGINA_BD) {
      const { data, error } = await pagina(
        i,
        Math.min(i + PAGINA_BD, tope) - 1,
      );
      if (error) throw new Error(error.message);
      const lote = (data ?? []) as Array<Record<string, unknown>>;
      filas.push(...lote);
      if (lote.length < PAGINA_BD) return { filas, truncado: false };
    }
    return { filas, truncado: filas.length >= tope };
  }

  /**
   * Lecturas `in (…)` en lotes de ≤ 200 ids (o `tamLote`); un error se
   * LANZA.
   */
  private async leerPorLotes(
    ids: ReadonlyArray<string>,
    consulta: (lote: string[]) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
    tamLote = 200,
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += tamLote) {
      const { data, error } = await consulta(unicos.slice(i, i + tamLote));
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    return out;
  }

  /**
   * `leerPorLotes` + PAGINADO de cada lote (revisión 2-oct-2026, regla
   * anti-tope de 1000): pide páginas de `PAGINA_BD` hasta recibir una
   * incompleta. La consulta DEBE ordenar por una llave ÚNICA (la PK) para
   * que las páginas no se pisen ni se salten filas. Un error se LANZA.
   */
  private async leerPorLotesPaginado(
    ids: ReadonlyArray<string>,
    consulta: (
      lote: string[],
      desde: number,
      hasta: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
    tamLote = 200,
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += tamLote) {
      const lote = unicos.slice(i, i + tamLote);
      for (let desde = 0; ; desde += PAGINA_BD) {
        const { data, error } = await consulta(
          lote,
          desde,
          desde + PAGINA_BD - 1,
        );
        if (error) throw new Error(error.message);
        const pagina = (data ?? []) as Array<Record<string, unknown>>;
        out.push(...pagina);
        if (pagina.length < PAGINA_BD) break;
      }
    }
    return out;
  }

  /** Fila cruda de `ingreso` (INGRESO_CANDIDATO_COLS) ⇒ candidato. */
  private aIngresoCandidato(f: Record<string, unknown>): IngresoCandidatoRow {
    const cliente = unwrapOne(f.cliente as { nombre?: unknown } | null);
    const nombre =
      typeof cliente?.nombre === 'string' && cliente.nombre.trim()
        ? cliente.nombre
        : ((f.pagador as string | null) ?? null);
    return {
      id: f.id as string,
      folio: Number(f.folio),
      categoria: f.categoria as string,
      fecha: f.fecha as string,
      monto: r2(Number(f.monto) || 0),
      comision_monto:
        f.comision_monto == null ? null : r2(Number(f.comision_monto)),
      moneda: (f.moneda as string) ?? 'MXN',
      cuenta_bancaria_id: (f.cuenta_bancaria_id as string | null) ?? null,
      cliente: nombre,
      descripcion: (f.descripcion as string) ?? '',
      referencia: (f.referencia as string | null) ?? null,
    };
  }

  /** Ids de ingresos YA ligados a algún movimiento (lotes de ≤ 200). */
  private async ingresosConMovimiento(
    ingresoIds: ReadonlyArray<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const filas = await this.leerPorLotes(ingresoIds, (lote) =>
      this.supabase.service
        .from('movimiento_bancario')
        .select('id, ingreso_id')
        .in('ingreso_id', lote),
    );
    for (const m of filas) {
      if (typeof m.ingreso_id === 'string') {
        out.set(m.ingreso_id, m.id as string);
      }
    }
    return out;
  }

  /** Parsea el estado de cuenta en pyservices (sin persistir). */
  async parse(
    dto: ConciliacionParseDto,
    userId?: string,
  ): Promise<ParsedStatement> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'Conciliación no configurada (pyservices).',
      );
    }
    const controller = new AbortController();
    // Un PDF con cientos de movimientos tarda varios minutos en extraerse con
    // IA: 60s abortaba a media lectura. La importación es manual (el operador
    // espera) y CSV/Excel siguen siendo instantáneos.
    const timer = setTimeout(() => controller.abort(), 270_000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
          ...(await this.headersModeloIa()),
        },
        body: JSON.stringify({
          filename: dto.filename,
          file_base64: dto.file_base64,
          // Mapeo manual de columnas Paywise (respaldo del panel).
          mapeo: dto.mapeo ?? null,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al parsear: ${detail.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as ParsedStatement;
      // SOLO el camino PDF gasta IA (CSV/Excel son pandas): sin uso_ia no hay
      // nada que registrar.
      if (body.uso_ia) {
        this.iaUso.registrar('ESTADO_CUENTA_PDF', body.uso_ia, {
          usuarioId: userId ?? null,
          contexto: { filename: dto.filename },
        });
      }
      return body;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`parse estado de cuenta falló: ${msg}`);
      throw new ServiceUnavailableException(
        `No se pudo parsear el estado de cuenta: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persiste los movimientos y auto-concilia los CARGO con gastos del mismo monto/fecha. */
  async importar(dto: ImportarMovimientosDto, userId: string) {
    // Compat: importación síncrona (sin progreso). El panel usa importarAsync.
    return this.ejecutarImport(dto, userId, async () => {});
  }

  /**
   * Importación como JOB del servidor: responde de inmediato con job_id y el
   * proceso (dedupe, archivo, insert y auto-conciliación) sigue en el backend
   * aunque el navegador se cierre. El panel consulta el avance con
   * importStatus (barra de porcentaje).
   */
  async importarAsync(dto: ImportarMovimientosDto, userId: string) {
    const total = dto.movimientos.filter((m) => m.fecha).length;
    if (total === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    const { data: job, error } = await this.supabase.service
      .from('conciliacion_import_job')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        total_movimientos: total,
        paso: 'Preparando importación…',
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }
    void this.correrImportJob(job!.id as string, dto, userId);
    return { job_id: job!.id as string };
  }

  private async correrImportJob(
    jobId: string,
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<void> {
    const setJob = async (
      patch: Record<string, unknown>,
      // Columnas del desglose (migración 20260916000001). Mientras no esté
      // aplicada se reintenta SIN ellas: el job nunca se queda sin cerrar
      // por una columna que todavía no existe.
      extras: Record<string, unknown> = {},
    ) => {
      const base = { ...patch, updated_at: new Date().toISOString() };
      const { error } = await this.supabase.service
        .from('conciliacion_import_job')
        .update({ ...base, ...extras })
        .eq('id', jobId);
      if (!error) return;
      if (Object.keys(extras).length > 0) {
        this.logger.warn(
          `import job ${jobId}: sin columnas de desglose (${error.message}); se guarda el resumen básico.`,
        );
        const { error: err2 } = await this.supabase.service
          .from('conciliacion_import_job')
          .update(base)
          .eq('id', jobId);
        if (err2) this.logger.warn(`import job ${jobId}: ${err2.message}`);
        return;
      }
      this.logger.warn(`import job ${jobId}: ${error.message}`);
    };
    try {
      const res = await this.ejecutarImport(
        dto,
        userId,
        // CONCEPTO DEL SPEI (0.0.75): `parcial` es el rastro del
        // enriquecimiento; se guarda en `resultados` A MEDIO JOB para que
        // sobreviva si después algo truena (el catch no toca `resultados`).
        async (progreso, paso, parcial) =>
          setJob({ progreso, paso }, parcial ? { resultados: parcial } : {}),
      );
      // Solo las llaves DEFINIDAS (un modo no trae las del otro).
      const nuevos: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({
        enriquecidos: res.enriquecidos,
        enriquecimiento_omitidos: res.enriquecimiento_omitidos,
        enriquecimiento: res.enriquecimiento,
        nuevos_mismo_dia_y_monto: res.nuevos_mismo_dia_y_monto,
        nuevos_mismo_dia_y_monto_detalle: res.nuevos_mismo_dia_y_monto_detalle,
        solo_enriquecer: res.solo_enriquecer,
        no_encontrados: res.no_encontrados,
        no_encontrados_detalle: res.no_encontrados_detalle,
      })) {
        if (v !== undefined) nuevos[k] = v;
      }
      await setJob(
        {
          estado: 'LISTO',
          progreso: 100,
          paso: 'Terminado',
          importados: res.importados,
          conciliados_auto: res.conciliados_auto,
          duplicados_omitidos: res.duplicados_omitidos,
        },
        {
          errores: res.errores,
          resultados: {
            conciliados: res.conciliados,
            traspasos: res.traspasos,
            reversos: res.reversos,
            reversos_emparejados: res.reversos_emparejados,
            ambiguos: res.ambiguos,
            sin_candidato: res.sin_candidato,
            rechazados: res.rechazados,
            errores: res.errores,
            por_criterio: res.por_criterio,
            ...nuevos,
          },
          errores_detalle: res.detalle.slice(0, 100),
        },
      );
    } catch (err) {
      // El job jamás queda colgado en PROCESANDO: el error se muestra tal
      // cual en el panel para corregir (cuenta equivocada, archivo, etc.).
      await setJob({
        estado: 'ERROR',
        paso: 'Error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Estado de un job de importación (polling del panel). Expone el desglose
   * por resultado (`resultados`, `errores`, `errores_detalle`) cuando la
   * migración 20260916000001 está aplicada; si no, el mismo shape de antes.
   */
  async importStatus(jobId: string) {
    const BASE =
      'id, estado, progreso, paso, total_movimientos, importados, conciliados_auto, duplicados_omitidos, error, created_at';
    const leer = async (cols: string) =>
      this.supabase.service
        .from('conciliacion_import_job')
        .select(cols)
        .eq('id', jobId)
        .maybeSingle();
    let { data, error } = await leer(
      `${BASE}, errores, errores_detalle, resultados`,
    );
    if (error) {
      ({ data, error } = await leer(BASE));
    }
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Job ${jobId} not found`);
    // El desglose se guarda ANIDADO en `resultados` (una sola columna jsonb)
    // pero el panel —y cualquier consumidor— lo lee PLANO, igual que en la
    // respuesta de `importar`. Se devuelven las dos formas: sin esto, el
    // resumen del job salía en ceros aunque el cruce hubiera funcionado.
    const fila = data as unknown as Record<string, unknown>;
    const r = fila.resultados;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { ...fila, ...(r as Record<string, unknown>) };
    }
    return fila;
  }

  /**
   * Líneas del archivo listas para insertar (y para el dedupe). ORDEN DEL
   * ARCHIVO (12-oct-2026, invariante 55): cada línea guarda su posición en
   * el estado de cuenta (1 = la primera del archivo, contando también las
   * que se descartan por no traer fecha) para que el reporte salga en el
   * mismo orden que el archivo del banco. Sin líneas con fecha ⇒ 400.
   */
  private lineasDeImportacion(
    dto: ImportarMovimientosDto,
    userId: string | null,
  ) {
    const base = dto.movimientos
      .map((m, i) => ({ m, orden_archivo: i + 1 }))
      .filter(({ m }) => m.fecha)
      .map(({ m, orden_archivo }) => ({
        orden_archivo,
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        fecha: m.fecha,
        tipo: m.tipo,
        monto: m.monto,
        descripcion: m.descripcion ?? null,
        referencia: m.referencia ?? null,
        // Pasarela (Paywise): bruto y comisión del movimiento; null en bancos.
        monto_bruto: m.monto_bruto != null ? r2(Number(m.monto_bruto)) : null,
        comision_monto:
          m.comision_monto != null ? r2(Number(m.comision_monto)) : null,
        origen: 'IMPORTADO',
        created_by: userId,
        updated_by: userId,
      }));
    if (base.length === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    return base;
  }

  /**
   * Filas YA importadas de la cuenta en el periodo del archivo (dedupe y
   * concepto del SPEI). PAGINADAS por la PK (0.0.75): el `.limit(20000)` de
   * antes lo cortaba PostgREST en max-rows (1000) SIN avisar y el
   * multiconjunto salía incompleto. Con más de `PREVIOS_DEDUPE_TOPE` ⇒ 400
   * (jamás se deduplica contra una foto recortada). Devuelve el orden
   * determinista de `ordenarPreviosParaDedupe`. `orden_archivo` y
   * `reverso_de_id` solo detrás de sus sondas.
   */
  private async leerPreviosDedupe(
    cuentaId: string,
    desde: string,
    hasta: string,
  ): Promise<FilaPreviaEnriquecible[]> {
    const [conOrden, conReversos] = await Promise.all([
      this.ordenArchivoOn(),
      this.reversosOn(),
    ]);
    const cols = `${await this.movCols()}, estado_cuenta_id${conOrden ? ', orden_archivo' : ''}${conReversos ? ', reverso_de_id' : ''}`;
    const { filas, truncado } = await this.leerPaginado(
      (d, h) =>
        this.supabase.service
          .from('movimiento_bancario')
          .select(cols)
          .eq('cuenta_bancaria_id', cuentaId)
          .gte('fecha', desde)
          .lte('fecha', hasta)
          .order('id', { ascending: true })
          .range(d, h),
      PREVIOS_DEDUPE_TOPE,
    );
    if (truncado) {
      throw new BadRequestException(
        'El periodo del archivo trae más de 20,000 movimientos previos en la cuenta: impórtalo por partes.',
      );
    }
    return ordenarPreviosParaDedupe(
      filas as unknown as FilaPreviaEnriquecible[],
    );
  }

  /**
   * Lo que comparten la importación, `solo_enriquecer` y la vista previa
   * (0.0.75), SIN escribir nada: previos paginados, dedupe (con `parejas`),
   * las lecturas best-effort que el plan necesita (folios de los gemelos
   * ligados y dirección de los archivos previos) y el PLAN del concepto del
   * SPEI (`planEnriquecimiento`, puro).
   */
  private async prepararImportacion(
    dto: ImportarMovimientosDto,
    base: ReturnType<ConciliacionService['lineasDeImportacion']>,
  ) {
    // CANDADO DE RE-IMPORTACIÓN: el mismo estado de cuenta subido dos veces
    // duplicaría los movimientos e inflaría los pendientes para siempre (los
    // gastos ya conciliados no se vuelven a cruzar). Dedup MULTICONJUNTO por
    // (fecha, tipo, monto) + leyenda TOLERANTE contra lo ya importado en la
    // cuenta: dos cargos legítimos idénticos del mismo día solo se omiten si
    // ya existen exactamente esas repeticiones en la base.
    const fechas = base.map((r) => r.fecha).sort();
    const [previos, cuentaInfo] = await Promise.all([
      this.leerPreviosDedupe(
        dto.cuenta_bancaria_id,
        fechas[0],
        fechas[fechas.length - 1],
      ),
      this.infoCuenta(dto.cuenta_bancaria_id),
    ]);
    // Fuente única del candado: `emparejarDuplicados` (auto-cruce.util). La
    // referencia que la IA lee del PDF NO es estable entre lecturas (29-sep-
    // 2026: el mismo cargo llegó con tres referencias distintas y se insertó
    // tres veces), así que NUNCA veta un duplicado: manda la leyenda
    // tolerante (truncado, redacción) y la referencia solo suma.
    const { aInsertar, duplicados, parejas } = emparejarDuplicados(
      base,
      previos,
    );
    // CONCEPTO DEL SPEI (0.0.75, invariante 69): lecturas SOLO cuando hacen
    // falta (gemelos ligados ⇒ folios; gemelos de un mismo archivo ⇒ su
    // dirección). Best-effort: si fallan, esos gemelos quedan GEMELOS.
    const idsFolios = idsParaLeerFolios(base, previos, parejas);
    const foliosPorPrevia =
      idsFolios.length > 0
        ? await this.foliosParaGemelos(idsFolios, previos)
        : new Map<string, NumeroFactura[]>();
    const idsDireccion = estadoCuentaIdsParaDireccion(base, previos, parejas);
    const direccionPorEstadoCuenta =
      idsDireccion.length > 0 && (await this.ordenArchivoOn())
        ? await this.direccionesDeArchivos(idsDireccion)
        : new Map<string, DireccionArchivo | null>();
    const plan = planEnriquecimiento(base, previos, parejas, {
      foliosPorPrevia,
      // `base` ya va en el orden del archivo (orden_archivo ascendente).
      direccionArchivoNuevo: direccionDeFechas(base.map((b) => b.fecha)),
      direccionPorEstadoCuenta,
      moneda: cuentaInfo.moneda,
    });
    const nuevosMismoDia = lineasNuevasEnBucketConocido(aInsertar, previos);
    return {
      aInsertar,
      duplicados,
      plan,
      nuevosMismoDia,
      cuentaInfo,
    };
  }

  /**
   * previa → números de factura de su(s) gasto(s) ligado(s) (regla FOLIO).
   * Partes por la puente (con la sonda) o, sin ella, el espejo `gasto_id`;
   * folios con `numerosDeGasto` (factura recibida, ticket, IA y «fact NNNN»
   * en la primera línea de las notas). BEST-EFFORT: si algo falla, mapa
   * vacío + warn (los gemelos quedan GEMELOS, jamás se adivina).
   */
  private async foliosParaGemelos(
    previoIds: string[],
    previos: readonly FilaPreviaEnriquecible[],
  ): Promise<Map<string, NumeroFactura[]>> {
    try {
      let pares: Array<{ movimiento_id: string; gasto_id: string }>;
      if (await this.partesOn()) {
        pares = (await this.partesDeMovimientos(previoIds)).map((p) => ({
          movimiento_id: p.movimiento_id,
          gasto_id: p.gasto_id,
        }));
      } else {
        const ids = new Set(previoIds);
        pares = previos
          .filter((p) => ids.has(p.id) && typeof p.gasto_id === 'string')
          .map((p) => ({
            movimiento_id: p.id,
            gasto_id: p.gasto_id as string,
          }));
      }
      if (pares.length === 0) return new Map();
      const embed = await this.embedFolio();
      const gastos = await this.leerPorLotes(
        pares.map((p) => p.gasto_id),
        (lote) =>
          this.supabase.service
            .from('gasto')
            .select(`id, notas, ${embed}`)
            .in('id', lote),
      );
      const numerosDe = new Map(
        gastos.map((g) => [
          g.id as string,
          numerosDeGasto(foliosDeGastoCrudo(g)),
        ]),
      );
      const out = new Map<string, NumeroFactura[]>();
      for (const p of pares) {
        const lista = out.get(p.movimiento_id) ?? [];
        lista.push(...(numerosDe.get(p.gasto_id) ?? []));
        out.set(p.movimiento_id, lista);
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `importación: no se pudieron leer los folios de los gemelos (${previoIds.length}): ${err instanceof Error ? err.message : String(err)}; quedan como GEMELOS.`,
      );
      return new Map();
    }
  }

  /**
   * Dirección (ASC/DESC por fecha) de los archivos con los que se
   * importaron unos gemelos (regla ORDEN_ARCHIVO), ≤ 5 archivos. Se lee en
   * el orden del archivo (`orden_archivo` ≥ 1; `gte` y no `.not()`).
   * BEST-EFFORT: un archivo que no se pudo leer queda null.
   */
  private async direccionesDeArchivos(
    ids: string[],
  ): Promise<Map<string, DireccionArchivo | null>> {
    const out = new Map<string, DireccionArchivo | null>();
    for (const id of ids.slice(0, DIRECCIONES_ARCHIVO_MAX)) {
      try {
        const { filas, truncado } = await this.leerPaginado(
          (d, h) =>
            this.supabase.service
              .from('movimiento_bancario')
              .select('fecha, orden_archivo')
              .eq('estado_cuenta_id', id)
              .gte('orden_archivo', 1)
              .order('orden_archivo', { ascending: true })
              .order('id', { ascending: true })
              .range(d, h),
          PREVIOS_DEDUPE_TOPE,
        );
        out.set(
          id,
          truncado
            ? null
            : direccionDeFechas(filas.map((f) => f.fecha as string | null)),
        );
      } catch (err) {
        this.logger.warn(
          `importación: no se pudo leer el orden del estado de cuenta ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        out.set(id, null);
      }
    }
    return out;
  }

  /**
   * Escribe el concepto planeado, UNA fila a la vez: SOLO `descripcion` y
   * `updated_by` (el trigger mueve `updated_at`), con CAS sobre el texto
   * leído y `origen = IMPORTADO`. 0 filas ⇒ CAMBIO_CONCURRENTE; un error ⇒
   * ERROR con su texto (≤ 200). Jamás lanza ni toca otra columna.
   */
  private async aplicarEnriquecimiento(
    lista: readonly EnriquecimientoPlaneado[],
    userId: string,
    moneda: string | null,
  ): Promise<{
    enriquecidos: EnriquecimientoPlaneado[];
    omitidos: EnriquecimientoOmitido[];
  }> {
    const enriquecidos: EnriquecimientoPlaneado[] = [];
    const omitidos: EnriquecimientoOmitido[] = [];
    const omitido = (
      e: EnriquecimientoPlaneado,
      motivo: 'CAMBIO_CONCURRENTE' | 'ERROR',
      detalle?: string,
    ): EnriquecimientoOmitido => {
      const fc = facturaDeConcepto(e.despues);
      return {
        motivo,
        fecha: e.fecha,
        tipo: e.tipo,
        monto: e.monto,
        moneda,
        movimiento_ids: [e.previo_id],
        conceptos: [e.despues.slice(0, CONCEPTO_TEXTO_MAX)],
        facturas: fc ? [fc.texto] : [],
        ...(detalle !== undefined ? { detalle: detalle.slice(0, 200) } : {}),
      };
    };
    for (const e of lista) {
      try {
        const { data, error } = await this.supabase.service
          .from('movimiento_bancario')
          .update({ descripcion: e.despues, updated_by: userId })
          .eq('id', e.previo_id)
          .eq('descripcion', e.antes)
          .eq('origen', 'IMPORTADO')
          .select('id');
        if (error) throw new Error(error.message);
        if (((data ?? []) as unknown[]).length >= 1) enriquecidos.push(e);
        else omitidos.push(omitido(e, 'CAMBIO_CONCURRENTE'));
      } catch (err) {
        omitidos.push(
          omitido(e, 'ERROR', err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return { enriquecidos, omitidos };
  }

  /**
   * VISTA PREVIA de la importación (0.0.75): la MISMA preparación que
   * `importar` SIN archivar ni escribir nada. El panel la pide antes de
   * importar para decir «N ya estaban · a M se les agregará el concepto ·
   * K nuevas» y ofrecer «Solo completar conceptos».
   */
  async vistaPreviaImport(dto: ImportarMovimientosDto) {
    const base = this.lineasDeImportacion(dto, null);
    const prep = await this.prepararImportacion(dto, base);
    const mismoDia = new Set(prep.nuevosMismoDia.map((n) => n.orden_archivo));
    return {
      total: base.length,
      ya_estaban: prep.duplicados,
      nuevos: prep.aInsertar.length,
      nuevos_mismo_dia_y_monto: prep.nuevosMismoDia.length,
      se_enriquecen: prep.plan.enriquecer.length,
      enriquecimiento_omitidos: movimientosOmitidos(prep.plan.omitidos),
      moneda: prep.cuentaInfo.moneda,
      omitidos: prep.plan.omitidos.slice(0, VISTA_PREVIA_OMITIDOS_MAX),
      nuevos_detalle: prep.aInsertar
        .slice(0, VISTA_PREVIA_DETALLE_MAX)
        .map((n) => ({
          orden_archivo: n.orden_archivo,
          fecha: n.fecha,
          tipo: n.tipo,
          monto: Number(n.monto),
          descripcion: n.descripcion,
          mismo_dia_y_monto: mismoDia.has(n.orden_archivo),
        })),
      enriquecibles_detalle: prep.plan.enriquecer
        .slice(0, VISTA_PREVIA_DETALLE_MAX)
        .map(detalleEnriquecido),
    };
  }

  private async ejecutarImport(
    dto: ImportarMovimientosDto,
    userId: string,
    onProgress: (
      progreso: number,
      paso: string,
      parcial?: Record<string, unknown>,
    ) => Promise<void>,
  ): Promise<ResultadoImportacion> {
    const base = this.lineasDeImportacion(dto, userId);
    await onProgress(5, 'Buscando duplicados…');
    const prep = await this.prepararImportacion(dto, base);
    const nuevos = prep.aInsertar;
    const duplicadosOmitidos = prep.duplicados;
    const cuentaInfo = prep.cuentaInfo;

    await onProgress(18, 'Archivando el estado de cuenta…');
    // El archivo original se archiva DESPUÉS de validar y ANTES de insertar:
    // cada movimiento queda ligado a su estado de cuenta. Se archiva aunque
    // todo resulte duplicado (re-subir un estado de cuenta viejo solo para
    // conservar el archivo es un caso legítimo), y también con
    // `solo_enriquecer`.
    const estadoCuentaId = await this.archivarEstadoCuenta(dto, userId);

    // CONCEPTO DEL SPEI (0.0.75, invariante 69): completar la descripción
    // de las filas YA importadas que eran solo la leyenda del banco. Solo
    // `descripcion` + `updated_by`, con CAS; las filas completadas NO se
    // vuelven a cruzar (para eso está «Cruzar pendientes»).
    let enriquecidos: EnriquecimientoPlaneado[] = [];
    let omitidosEnr: EnriquecimientoOmitido[] = [...prep.plan.omitidos];
    if (prep.plan.enriquecer.length > 0) {
      await onProgress(
        20,
        `Completando el concepto de ${prep.plan.enriquecer.length} movimientos…`,
      );
      const r = await this.aplicarEnriquecimiento(
        prep.plan.enriquecer,
        userId,
        cuentaInfo.moneda,
      );
      enriquecidos = r.enriquecidos;
      omitidosEnr = [...omitidosEnr, ...r.omitidos];
    }
    const camposEnr = {
      enriquecidos: enriquecidos.length,
      enriquecimiento_omitidos: movimientosOmitidos(omitidosEnr),
      enriquecimiento: {
        estado_cuenta_id: estadoCuentaId,
        detalle: enriquecidos
          .slice(0, ENRIQUECIMIENTO_DETALLE_MAX)
          .map(detalleEnriquecido),
        omitidos: omitidosEnr.slice(0, ENRIQUECIMIENTO_OMITIDOS_MAX),
      },
    };
    if (prep.plan.enriquecer.length > 0) {
      // El rastro que sobrevive aunque después algo truene.
      await onProgress(24, 'Conceptos completados', camposEnr);
      this.logger.log(
        `importación cuenta ${dto.cuenta_bancaria_id} (estado de cuenta ${estadoCuentaId ?? 'sin archivo'}, ${dto.filename ?? 'sin nombre'}): concepto completado en ${enriquecidos.length} de ${prep.plan.enriquecer.length}; ${camposEnr.enriquecimiento_omitidos} sin completar.`,
      );
    }

    const sinCruce = {
      importados: 0,
      conciliados_auto: 0,
      duplicados_omitidos: duplicadosOmitidos,
      conciliados: 0,
      traspasos: 0,
      reversos: 0,
      reversos_emparejados: 0,
      ambiguos: 0,
      sin_candidato: 0,
      rechazados: 0,
      errores: 0,
      por_criterio: {} as Record<string, number>,
      detalle: [] as ResultadoMovimiento[],
    };

    // SOLO COMPLETAR CONCEPTOS: no inserta, no cruza ni empareja reversos;
    // lo que no encontró se LISTA (jamás se agrega).
    if (dto.solo_enriquecer === true) {
      if (estadoCuentaId) {
        await this.supabase.service
          .from('estado_cuenta_archivo')
          .update({ movimientos_importados: 0 })
          .eq('id', estadoCuentaId);
      }
      return {
        ...sinCruce,
        ...camposEnr,
        solo_enriquecer: true,
        no_encontrados: nuevos.length,
        no_encontrados_detalle: nuevos
          .slice(0, NO_ENCONTRADOS_DETALLE_MAX)
          .map((n) => ({
            orden_archivo: n.orden_archivo,
            fecha: n.fecha,
            tipo: n.tipo,
            monto: Number(n.monto),
            moneda: cuentaInfo.moneda,
            descripcion: n.descripcion,
            referencia: n.referencia,
            factura: facturaDeConcepto(n.descripcion)?.texto ?? null,
          })),
      };
    }

    const camposMismoDia = {
      nuevos_mismo_dia_y_monto: prep.nuevosMismoDia.length,
      nuevos_mismo_dia_y_monto_detalle: prep.nuevosMismoDia
        .slice(0, NUEVOS_MISMO_DIA_DETALLE_MAX)
        .map((n) => ({
          orden_archivo: n.orden_archivo,
          fecha: n.fecha,
          tipo: n.tipo,
          monto: Number(n.monto),
          moneda: cuentaInfo.moneda,
          descripcion: n.descripcion,
        })),
    };

    if (nuevos.length === 0) {
      if (estadoCuentaId) {
        await this.supabase.service
          .from('estado_cuenta_archivo')
          .update({ movimientos_importados: 0 })
          .eq('id', estadoCuentaId);
      }
      return { ...sinCruce, ...camposEnr, ...camposMismoDia };
    }
    // La posición solo se escribe con la columna aplicada (sonda); sin ella
    // la fila es la de siempre.
    const conOrdenArchivo = await this.ordenArchivoOn();
    const rows = nuevos.map(({ orden_archivo, ...r }) => ({
      ...r,
      estado_cuenta_id: estadoCuentaId,
      ...(conOrdenArchivo ? { orden_archivo } : {}),
    }));

    await onProgress(30, `Guardando ${rows.length} movimientos…`);
    const { data: inserted, error } = await this.supabase.service
      .from('movimiento_bancario')
      .insert(rows)
      .select(
        'id, fecha, monto, tipo, monto_bruto, comision_monto, referencia, descripcion',
      );
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }

    // La moneda de la cuenta define contra qué se cruza: un cargo de 3,000 en
    // la cuenta USD jamás debe conciliar un gasto de $3,000 MXN. El TIPO
    // decide el cruce de abonos: PASARELA (Paywise) coteja bruto/neto/
    // referencia a ±5 días; BANCO, neto/bruto a ±3. (Se leyó en la
    // preparación, 0.0.75.)
    const monedaCuenta = cuentaInfo.moneda;

    // Auto-conciliación: la parte lenta (una consulta por movimiento). El
    // progreso avanza de 35 a 95, reportado por lotes para no duplicar el
    // costo con updates del job en cada vuelta.
    //
    // RESILIENCIA (15-sep-2026): NINGÚN movimiento puede tumbar la
    // importación. El 15-sep el trigger `tg_mov_bancario_gasto_suma` lanzaba
    // «operator does not exist: public.moneda = text» en cada liga y el job
    // 4f9545e3 murió al 37 % con 101 movimientos YA insertados y 0
    // conciliados. Ahora cada movimiento va en su propio try/catch: el fallo
    // se cuenta con su motivo y el job termina LISTO diciendo cuántos.
    // La importación es un job asíncrono: puede descargar el T.C. oficial
    // que falte para el cruce USD (invariante 70).
    const ctx = await this.cargarCtxCruce({ descargarTc: true });
    const resultados: ResultadoMovimiento[] = [];
    const lista = inserted ?? [];
    if (lista.length !== rows.length) {
      // PostgREST puede devolver menos filas de las insertadas (max-rows): los
      // que no vuelven quedan SIN cruzar. Se dice en el log y «Cruzar
      // pendientes» los recupera — nunca se da por cruzado lo que no se miró.
      this.logger.warn(
        `Importación: se insertaron ${rows.length} movimientos y la BD devolvió ${lista.length}; los ${rows.length - lista.length} restantes quedan pendientes hasta correr auto-match.`,
      );
    }
    const pasoLote = Math.max(1, Math.ceil(lista.length / 25));
    for (let i = 0; i < lista.length; i++) {
      const m = lista[i];
      const r = await this.cruzarMovimiento(
        {
          id: m.id as string,
          cuenta_bancaria_id: dto.cuenta_bancaria_id,
          fecha: m.fecha as string,
          tipo: m.tipo as string,
          monto: Number(m.monto),
          monto_bruto: m.monto_bruto == null ? null : Number(m.monto_bruto),
          comision_monto:
            m.comision_monto == null ? null : Number(m.comision_monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          notas: null,
        },
        { moneda: monedaCuenta, tipo: cuentaInfo.tipo },
        ctx,
        userId,
      );
      resultados.push(r);
      if (i % pasoLote === 0 || i === lista.length - 1) {
        await onProgress(
          35 + Math.round(((i + 1) / lista.length) * 60),
          `Conciliando ${i + 1} de ${lista.length}…`,
        );
      }
    }
    // REVERSOS (30-sep-2026): el mismo estado de cuenta suele traer el cargo
    // y su devolución («CARGO INDEBIDO 21 SEP …»): se emparejan aquí mismo,
    // DESPUÉS del cruce contra gastos/cobros (que tiene prioridad).
    const reversosEmparejados = await this.aplicarReversosEnCorrida(
      lista.map((m) => ({ id: m.id as string, tipo: m.tipo as string })),
      resultados,
      userId,
    );
    const conteo = conteoVacio();
    const porCriterio: Record<string, number> = {};
    const detalle: ResultadoMovimiento[] = [];
    for (const r of resultados) {
      sumarResultado(conteo, r.resultado);
      if (r.criterio)
        porCriterio[r.criterio] = (porCriterio[r.criterio] ?? 0) + 1;
      if (r.resultado !== 'CONCILIADO' && detalle.length < DETALLE_MAX) {
        detalle.push(r);
      }
    }
    const conciliadosAuto =
      conteo.conciliados + conteo.traspasos + conteo.reversos;

    if (estadoCuentaId) {
      await this.supabase.service
        .from('estado_cuenta_archivo')
        .update({ movimientos_importados: rows.length })
        .eq('id', estadoCuentaId);
    }

    return {
      importados: rows.length,
      conciliados_auto: conciliadosAuto,
      duplicados_omitidos: duplicadosOmitidos,
      // ADITIVOS (15-sep-2026): el operador ve POR QUÉ quedó lo que quedó.
      conciliados: conteo.conciliados,
      traspasos: conteo.traspasos,
      // ADITIVOS (30-sep-2026): movimientos conciliados como reverso y pares.
      reversos: conteo.reversos,
      reversos_emparejados: reversosEmparejados,
      ambiguos: conteo.ambiguos,
      sin_candidato: conteo.sin_candidato,
      rechazados: conteo.rechazados,
      errores: conteo.errores,
      por_criterio: porCriterio,
      detalle,
      // ADITIVOS (0.0.75, invariante 69): concepto del SPEI y líneas nuevas
      // con la misma fecha y monto que una fila ya importada.
      ...camposEnr,
      ...camposMismoDia,
    };
  }

  /**
   * Guarda el archivo original del estado de cuenta en el bucket privado
   * `estados-cuenta` y registra la importación. Sin archivo (panel viejo) la
   * importación sigue funcionando; CON archivo, un fallo al archivar tumba
   * la importación a propósito (fail-loud): importar sin respaldo en
   * silencio dejaría la auditoría incompleta, y como aún no se insertó
   * ningún movimiento, reintentar es seguro.
   */
  private async archivarEstadoCuenta(
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<string | null> {
    if (!dto.file_base64 || !dto.filename) return null;
    const limpio = dto.filename.replace(/[^\w.-]+/g, '_').slice(-120);
    const path = `${dto.cuenta_bancaria_id}/${Date.now()}-${limpio}`;
    const { error: upErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .upload(path, Buffer.from(dto.file_base64, 'base64'), {
        contentType: 'application/octet-stream',
      });
    if (upErr) {
      throw new InternalServerErrorException(
        `No se pudo archivar el estado de cuenta (${upErr.message}). Reintenta la importación.`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        filename: dto.filename,
        storage_path: path,
        formato: limpio.split('.').pop()?.toLowerCase() ?? null,
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.id as string) ?? null;
  }

  /** Estados de cuenta importados (para consultarlos/descargarlos después). */
  async listEstadosCuenta(cuentaBancariaId?: string) {
    let q = this.supabase.service
      .from('estado_cuenta_archivo')
      .select(
        'id, cuenta_bancaria_id, filename, formato, movimientos_importados, created_at, cuenta:cuenta_bancaria(banco, alias, moneda)',
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (cuentaBancariaId) q = q.eq('cuenta_bancaria_id', cuentaBancariaId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [] };
  }

  /** URL firmada (1 h) para descargar un estado de cuenta archivado. */
  async estadoCuentaUrl(id: string) {
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .select('storage_path, filename')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Estado de cuenta ${id} not found`);
    const { data: signed, error: signErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .createSignedUrl(data.storage_path as string, 3600, {
        download: data.filename as string,
      });
    if (signErr || !signed?.signedUrl) {
      throw new Error(signErr?.message ?? 'No se pudo firmar la URL');
    }
    return { url: signed.signedUrl, filename: data.filename as string };
  }

  private async monedaCuenta(cuentaId: string): Promise<string | null> {
    return (await this.infoCuenta(cuentaId)).moneda;
  }

  /**
   * Moneda y tipo (BANCO | PASARELA) de la cuenta; null si no existe o si la
   * consulta falló. `cuenta_bancaria.moneda` es NOT NULL, así que un null
   * aquí SIEMPRE es un problema de lectura: se registra, y el auto-cruce lo
   * trata como ERROR (nunca cruza de oídas — sin moneda no se puede
   * garantizar que el gasto sea de la misma divisa).
   */
  private async infoCuenta(
    cuentaId: string,
  ): Promise<{ moneda: string | null; tipo: string | null }> {
    const { data, error } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('moneda, tipo')
      .eq('id', cuentaId)
      .maybeSingle();
    if (error || !data) {
      this.logger.warn(
        `No se pudo leer la cuenta ${cuentaId}: ${error?.message ?? 'no existe'}.`,
      );
    }
    return {
      moneda: (data?.moneda as string | null) ?? null,
      tipo: (data?.tipo as string | null) ?? null,
    };
  }

  /**
   * AUTO-CRUCE de un CARGO contra los gastos bancarios sin conciliar.
   *
   * Orden de desempate (fuente única `auto-cruce.util`, pura y probada):
   *  1. monto ±1 centavo + ventana ±MATCH_DAYS + moneda de la cuenta;
   *  2. si hay ≥2 candidatos, la TERMINACIÓN de tarjeta del movimiento
   *     (últimos 4 dígitos de `referencia`, validados contra
   *     `tarjeta_corporativa`) contra `gasto.tarjeta_terminacion`;
   *  3. si siguen ≥2, la DESCRIPCIÓN del banco contra `lugar` / primera
   *     línea de `notas` / proveedor del gasto (sinónimos del giro);
   *  4. si nada desempata ⇒ AMBIGUO (pendiente, JAMÁS se liga a la brava);
   *  5. sin candidato por monto: se prueba contra el FALTANTE de un gasto
   *     mayor con pagos parciales y, en cuenta MXN, la compra en USD por TC
   *     implícito.
   */
  private async autoMatchCargo(
    mov: {
      id: string;
      monto: number;
      fecha: string;
      descripcion: string | null;
      referencia: string | null;
    },
    moneda: string | null,
    userId: string,
    ctx: CruceCtx,
  ): Promise<ResultadoMovimiento> {
    const { desde, hasta } = ventanaDias(mov.fecha, MATCH_DAYS);
    const monto = Math.abs(Number(mov.monto)) || 0;
    const base = {
      movimiento_id: mov.id,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };

    // CANDADO DE MONEDA (invariante: jamás se cruzan divisas distintas sin
    // la regla del TC). `cuenta_bancaria.moneda` es NOT NULL: si aquí llega
    // null es que la cuenta no se pudo leer, y sin moneda la consulta de
    // candidatos NO filtraría divisa — un gasto de 125.82 USD cuadraría con
    // un cargo de 125.82 MXN. Se prefiere dejarlo pendiente.
    if (!moneda) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo:
          'No se pudo leer la moneda de la cuenta bancaria: el cruce no se intenta para no mezclar divisas.',
      };
    }

    // 1) Candidatos por monto (banda de centavos: la terminal redondea).
    const { data, error } = await this.gastosCandidatos({
      moneda,
      desde,
      hasta,
      montoMin: monto - TOLERANCIA_CENTAVOS,
      montoMax: monto + TOLERANCIA_CENTAVOS,
      limite: 25,
    });
    if (error) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo: `No se pudieron leer los gastos candidatos: ${error.message}`,
      };
    }
    const candidatos = (data ?? []).map((g) => this.aCandidatoCruce(g));
    if (candidatos.length > 0) {
      const eleccion = elegirCandidato(mov, candidatos, ctx.terminaciones);
      if (eleccion.gasto_id) {
        return this.ligarCargo(mov.id, eleccion.gasto_id, userId, {
          ...base,
          criterio: eleccion.criterio,
          candidatos_n: eleccion.candidatos_n,
        });
      }
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: eleccion.detalle,
      };
    }

    // 2) PAGO PARCIAL: el cargo puede cubrir lo que FALTA de un gasto mayor
    //    (una factura de ASUR pagada en dos cargos). Misma regla que
    //    `candidatosCercanos`, ahora también en automático.
    const parcial = await this.candidatoPorFaltante(
      monto,
      moneda,
      desde,
      hasta,
    );
    if (parcial.length > 0) {
      const eleccion = elegirCandidato(mov, parcial, ctx.terminaciones, {
        criterioBase: 'FALTANTE',
      });
      if (eleccion.gasto_id) {
        return this.ligarCargo(mov.id, eleccion.gasto_id, userId, {
          ...base,
          criterio: eleccion.criterio,
          candidatos_n: eleccion.candidatos_n,
        });
      }
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: eleccion.detalle,
      };
    }

    // 3) Cuenta MXN: compra EN DÓLARES cuyo cargo llegó en pesos (Aircraft
    //    Spruce). Desde el 0.0.75 (invariante 70) SOLO con el T.C. OFICIAL
    //    del día del cargo a ±2 %, una leyenda que COINCIDE con el gasto y
    //    ningún otro cargo que cuadre igual (recíproco). Antes bastaba la
    //    banda 15–25 y candidato único: así el tubo de 422.86 USD se ligó a
    //    «ASA CANCUN» $8,939.38 (+24.3 % sobre el oficial).
    let detalleUsd: string | null = null;
    if (moneda === 'MXN' && monto > 0) {
      const usd = await this.cruceUsdDeCargo(
        mov,
        monto,
        base,
        desde,
        hasta,
        ctx,
      );
      if (usd.resultado) {
        if (usd.resultado.ligar) {
          return this.ligarCargo(mov.id, usd.resultado.ligar, userId, {
            ...base,
            criterio: 'TC_IMPLICITO',
            candidatos_n: 1,
          });
        }
        return usd.resultado.pendiente;
      }
      detalleUsd = usd.detalle;
    }
    return {
      ...base,
      motivo: `Ningún gasto bancario sin conciliar de ${montoBonito(monto)} ${moneda ?? ''} entre ${desde} y ${hasta}.${detalleUsd ? ` ${detalleUsd}` : ''}`,
    };
  }

  /**
   * Paso 3 del auto-cruce de un CARGO en una cuenta en pesos (0.0.75,
   * invariante 70): gastos USD bancarios sin conciliar EN BANDA del cargo
   * (`rangoBandaUsd`, ±MATCH_DAYS, tope `TOPE_CRUCE_USD`: llegar a él ⇒
   * AMBIGUO), sin los que ya tienen partes, decididos por `decidirCruceUsd`
   * con el T.C. oficial del día del cargo (lectura fallida ⇒ ERROR) y, si
   * diría LIGAR, el RECÍPROCO antes de escribir. `resultado.ligar` = el
   * gasto a ligar; `resultado.pendiente` = el ResultadoMovimiento que queda;
   * sin `resultado` ⇒ SIN_CANDIDATO con `detalle` (o null).
   */
  private async cruceUsdDeCargo(
    mov: { id: string; fecha: string; descripcion: string | null },
    monto: number,
    base: ResultadoMovimiento,
    desde: string,
    hasta: string,
    ctx: CruceCtx,
  ): Promise<{
    resultado?: { ligar?: string; pendiente: ResultadoMovimiento };
    detalle: string | null;
  }> {
    const pendiente = (
      resultado: ResultadoCruce,
      motivo: string,
      candidatos_n = 0,
    ) => ({
      resultado: { pendiente: { ...base, resultado, motivo, candidatos_n } },
      detalle: null,
    });
    const banda = rangoBandaUsd(monto);
    const { data: usd, error: usdErr } = await this.gastosCandidatos({
      moneda: 'USD',
      desde,
      hasta,
      montoMin: banda.min,
      montoMax: banda.max,
      limite: TOPE_CRUCE_USD,
    });
    if (usdErr) {
      return pendiente(
        'ERROR',
        `No se pudieron leer los gastos en USD: ${usdErr.message}`,
      );
    }
    const filas = usd ?? [];
    if (filas.length >= TOPE_CRUCE_USD) {
      return pendiente('AMBIGUO', TEXTO_CRUCE_USD_TRUNCADO, filas.length);
    }
    if (filas.length === 0) return { detalle: null };
    // Un USD con partes ya está (parcialmente) pagado: un cruzado es 1 ↔ 1.
    const ligados = await this.sumasLigadasDe(filas.map((g) => g.id as string));
    const libres = filas.filter(
      (g) => !((ligados.get(g.id as string) ?? 0) > 0),
    );
    // Solo los que caen EXACTO en la banda 15–25 (la lectura usa la banda
    // redondeada): sin ninguno no hace falta ni el oficial.
    const enBanda = libres.filter(
      (g) => evaluarTcCruce(monto, Number(g.monto), null)?.en_banda === true,
    );
    if (enBanda.length === 0) return { detalle: null };
    const of = await this.oficialDelDia(ctx, mov.fecha);
    if (of.fallo) return pendiente('ERROR', TEXTO_CRUCE_USD_SIN_LECTURA_TC);
    const decision = decidirCruceUsd(
      { fecha: mov.fecha, monto, descripcion: mov.descripcion },
      enBanda.map((g) => ({
        id: g.id as string,
        usd: Number(g.monto) || 0,
        gasto: this.aCandidatoCruce(g),
      })),
      of.oficial,
    );
    if (decision.resultado === 'SIN_CANDIDATOS') {
      return { detalle: decision.detalle };
    }
    if (decision.resultado === 'AMBIGUO' || !decision.elegido_id) {
      return pendiente(
        'AMBIGUO',
        decision.detalle ?? '',
        decision.candidatos_n,
      );
    }
    const elegido = enBanda.find((g) => g.id === decision.elegido_id);
    const reciproco = await this.reciprocoCruceUsd(
      mov.id,
      decision,
      typeof elegido?.fecha_gasto === 'string'
        ? elegido.fecha_gasto
        : mov.fecha,
      ctx,
    );
    if (reciproco) {
      return pendiente(
        reciproco.resultado,
        reciproco.motivo,
        reciproco.candidatos_n,
      );
    }
    return {
      resultado: {
        ligar: decision.elegido_id,
        pendiente: { ...base, candidatos_n: 1 },
      },
      detalle: null,
    };
  }

  /**
   * RECÍPROCO del cruce USD (conservador, límite conocido): ¿otro CARGO
   * pendiente de una cuenta en pesos, a ±MATCH_DAYS de la fecha del GASTO y
   * con |monto| en banda de ese gasto, quedaría también CERCA (o SIN
   * oficial para descartarlo)? Entonces no se liga (AMBIGUO, candidatos 1 +
   * n). Lectura fallida o el oficial de un competidor ilegible ⇒ ERROR;
   * llegar al tope ⇒ AMBIGUO. null = sin competidores: se liga.
   */
  private async reciprocoCruceUsd(
    cargoId: string,
    decision: DecisionCruceUsd,
    fechaGasto: string,
    ctx: CruceCtx,
  ): Promise<{
    resultado: ResultadoCruce;
    motivo: string;
    candidatos_n: number;
  } | null> {
    const usd = Number(decision.elegido_usd) || 0;
    const error = {
      resultado: 'ERROR' as ResultadoCruce,
      motivo: TEXTO_CRUCE_USD_RECIPROCO_ERROR,
      candidatos_n: 1,
    };
    const cuentas = await this.cuentasMxnDe(ctx);
    if (cuentas === null) return error;
    if (cuentas.length === 0) return null;
    const { desde, hasta } = ventanaDias(fechaGasto, MATCH_DAYS);
    const { data, error: errLectura } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, fecha, monto, descripcion')
      .eq('tipo', TipoMovimientoBancario.CARGO)
      .eq('conciliado', false)
      .in('cuenta_bancaria_id', cuentas)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .gte('monto', rangoBandaMxnDeUsd(usd).min)
      .lte('monto', rangoBandaMxnDeUsd(usd).max)
      .neq('id', cargoId)
      .limit(TOPE_CRUCE_USD);
    if (errLectura) return error;
    const otros = (data ?? []) as Array<Record<string, unknown>>;
    if (otros.length >= TOPE_CRUCE_USD) {
      return {
        resultado: 'AMBIGUO',
        motivo: TEXTO_CRUCE_USD_RECIPROCO_TRUNCADO,
        candidatos_n: 1 + otros.length,
      };
    }
    const cargos: CargoCompetidor[] = [];
    for (const o of otros) {
      const fecha = typeof o.fecha === 'string' ? o.fecha.slice(0, 10) : '';
      const of = await this.oficialDelDia(ctx, fecha);
      if (of.fallo) return error;
      cargos.push({
        id: o.id as string,
        fecha,
        monto: Math.abs(Number(o.monto) || 0),
        descripcion: typeof o.descripcion === 'string' ? o.descripcion : null,
        oficial: of.oficial,
      });
    }
    const competidores = competidoresCruceUsd(cargoId, usd, cargos);
    if (competidores.length === 0) return null;
    return {
      resultado: 'AMBIGUO',
      motivo: textoReciprocoCruceUsd(usd, competidores) ?? '',
      candidatos_n: 1 + competidores.length,
    };
  }

  /**
   * Gastos SIN conciliar, de medio bancario, en la ventana y (si se indica)
   * en esa moneda, con todo lo que el desempate necesita. Fuente única del
   * select para que el auto-cruce y el camino inverso no diverjan.
   */
  private async gastosCandidatos(opts: {
    moneda: string | null;
    desde: string;
    hasta: string;
    /** Banda [min, max] de monto (centavos). */
    montoMin?: number;
    montoMax?: number;
    /** Solo gastos MAYORES que esto (camino de pago parcial). */
    mayorQue?: number;
    limite: number;
  }): Promise<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }> {
    let q = this.supabase.service
      .from('gasto')
      .select(GASTO_CRUCE_COLS)
      .eq('conciliado', false)
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', opts.desde)
      .lte('fecha_gasto', opts.hasta);
    if (opts.moneda) q = q.eq('moneda', opts.moneda);
    if (opts.montoMin != null) q = q.gte('monto', opts.montoMin);
    if (opts.montoMax != null) q = q.lte('monto', opts.montoMax);
    if (opts.mayorQue != null) q = q.gt('monto', opts.mayorQue);
    const { data, error } = await q.limit(opts.limite);
    return {
      data: (data ?? null) as Array<Record<string, unknown>> | null,
      error: error ? { message: error.message } : null,
    };
  }

  /** Fila cruda de `gasto` → candidato del auto-cruce (util puro). */
  private aCandidatoCruce(g: Record<string, unknown>): GastoCandidatoCruce {
    const prov = unwrapOne(
      g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
    );
    return {
      id: g.id as string,
      monto: Number(g.monto) || 0,
      tarjeta_terminacion: (g.tarjeta_terminacion as string | null) ?? null,
      lugar: (g.lugar as string | null) ?? null,
      notas: (g.notas as string | null) ?? null,
      proveedor: typeof prov?.nombre === 'string' ? prov.nombre : null,
    };
  }

  /**
   * Gastos MAYORES que el cargo cuyo FALTANTE (monto − lo ya ligado) cuadra
   * con él: el segundo pago de una factura partida en dos cargos.
   */
  private async candidatoPorFaltante(
    monto: number,
    moneda: string | null,
    desde: string,
    hasta: string,
  ): Promise<GastoCandidatoCruce[]> {
    if (!(monto > 0)) return [];
    const { data, error } = await this.gastosCandidatos({
      moneda,
      desde,
      hasta,
      mayorQue: monto + TOLERANCIA_CENTAVOS,
      limite: 40,
    });
    if (error || !data || data.length === 0) return [];
    const ligado = await this.sumasLigadasDe(data.map((g) => g.id as string));
    return data
      .filter((g) => {
        const suma = ligado.get(g.id as string) ?? 0;
        if (!(suma > 0)) return false;
        return montoCasa(faltanteDe(Number(g.monto), suma), monto);
      })
      .map((g) => ({
        ...this.aCandidatoCruce(g),
        // Lo que se compara contra el cargo es el FALTANTE (desfase 0.00
        // gana al ±0.01: `separarPorDesfase`, 2-oct-2026).
        monto_cruce: faltanteDe(
          Number(g.monto),
          ligado.get(g.id as string) ?? 0,
        ),
      }));
  }

  /** Aplica la liga del auto-cruce y traduce el desenlace a ResultadoMovimiento. */
  private async ligarCargo(
    movId: string,
    gastoId: string,
    userId: string,
    base: Omit<ResultadoMovimiento, 'resultado' | 'motivo'> & {
      motivo?: string | null;
    },
  ): Promise<ResultadoMovimiento> {
    const liga = await this.ligarAuto(movId, gastoId, userId);
    if (liga.ok) {
      return {
        ...base,
        resultado: 'CONCILIADO',
        gasto_id: gastoId,
        motivo: null,
      };
    }
    return {
      ...base,
      resultado: liga.rechazado ? 'RECHAZADO' : 'ERROR',
      criterio: null,
      motivo: liga.motivo,
    };
  }

  /**
   * Liga del auto-match. NADA que salga de aquí puede tumbar la importación
   * (15-sep-2026): un 409 (gasto ya cubierto, carrera con otra liga) deja el
   * movimiento pendiente, y CUALQUIER otro error (el 23514 del trigger, un
   * 5xx de PostgREST, una desconexión) se registra y se sigue con el
   * siguiente movimiento. Antes solo se atrapaba ConflictException y un
   * error del trigger mataba el job entero con todo a medias.
   */
  private async ligarAuto(
    movId: string,
    gastoId: string,
    userId: string,
  ): Promise<{ ok: boolean; rechazado: boolean; motivo: string | null }> {
    try {
      await this.link(movId, gastoId, userId);
      return { ok: true, rechazado: false, motivo: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictException) {
        this.logger.warn(
          `auto-match: el gasto ${gastoId} no admite el cargo ${movId} (${msg}); queda pendiente.`,
        );
        return {
          ok: false,
          rechazado: true,
          motivo: `El gasto candidato no admite este cargo (${msg}).`,
        };
      }
      this.logger.error(
        `auto-match: fallo al ligar el cargo ${movId} con el gasto ${gastoId}: ${msg}`,
      );
      return { ok: false, rechazado: false, motivo: msg };
    }
  }

  /**
   * Gemelo de `ligarAuto` para los ABONOS: `linkCobro` puede lanzar 409
   * (el cobro ya lo tomó otro movimiento) o cualquier error de BD, y ni uno
   * ni otro pueden tumbar la importación.
   */
  private async ligarCobroAuto(
    movId: string,
    liga: LigaCobroInput,
    userId: string,
  ): Promise<{ ok: boolean; rechazado: boolean; motivo: string | null }> {
    try {
      await this.linkCobro(movId, liga, userId, { respuesta: false });
      return { ok: true, rechazado: false, motivo: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictException) {
        this.logger.warn(`auto-match abono ${movId}: ${msg}; queda pendiente.`);
        return {
          ok: false,
          rechazado: true,
          motivo: `El cobro candidato ya no admite este abono (${msg}).`,
        };
      }
      this.logger.error(`auto-match abono ${movId}: ${msg}`);
      return { ok: false, rechazado: false, motivo: msg };
    }
  }

  // =====================================================================
  // RE-CRUCE (15-sep-2026): el auto-cruce ya no vive SOLO dentro del import
  // =====================================================================

  /**
   * Contexto del auto-cruce: se carga UNA vez por corrida, no por fila.
   * `descargarTc` (0.0.75): SOLO la importación (job asíncrono) puede bajar
   * el T.C. oficial que falte (≤ `DESCARGAS_TC_MAX` días); «Cruzar
   * pendientes», la lista y la IA solo leen la tabla (sin latencia).
   */
  private async cargarCtxCruce(
    opts: { descargarTc?: boolean } = {},
  ): Promise<CruceCtx> {
    const base = {
      tcOficial: new Map<
        string,
        Promise<{ oficial: OficialDelDia | null; fallo: boolean }>
      >(),
      descargarTc: opts.descargarTc === true,
    };
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .select('terminacion, activa')
      .limit(200);
    if (error) {
      // Sin catálogo no hay desempate por tarjeta, pero el cruce sigue.
      this.logger.warn(`No se pudo leer tarjeta_corporativa: ${error.message}`);
      return { ...base, terminaciones: [] };
    }
    return {
      ...base,
      terminaciones: (data ?? [])
        .map((t) => (t as { terminacion: unknown }).terminacion)
        .filter((t): t is string => typeof t === 'string'),
    };
  }

  /**
   * T.C. oficial del DÍA del cargo para el auto-cruce (memorizado por
   * corrida). Sin `TipoCambioService` ⇒ sin oficial (no es un fallo: el
   * cruce USD queda AMBIGUO); lectura fallida ⇒ `fallo: true` (el cruce USD
   * de ese cargo es ERROR y se reintenta con «Cruzar pendientes»).
   */
  private oficialDelDia(
    ctx: CruceCtx,
    fecha: string,
  ): Promise<{ oficial: OficialDelDia | null; fallo: boolean }> {
    const dia = String(fecha).slice(0, 10);
    const memo = ctx.tcOficial.get(dia);
    if (memo) return memo;
    const lectura = (async () => {
      if (!this.tipoCambio) return { oficial: null, fallo: false };
      try {
        const mapa = await this.tipoCambio.oficialesPorDias([dia], {
          descargar: ctx.descargarTc,
        });
        if (mapa === null) return { oficial: null, fallo: true };
        return { oficial: mapa.get(dia) ?? null, fallo: false };
      } catch {
        return { oficial: null, fallo: true };
      }
    })();
    ctx.tcOficial.set(dia, lectura);
    return lectura;
  }

  /**
   * T.C. oficial de TABLA (sin descargar) para varios días: lista, «Vincular
   * gasto» e IA. null = lectura fallida (quien llama no afirma nada); sin
   * `TipoCambioService`, mapa vacío (= sin oficial).
   */
  private async oficialesTabla(
    fechas: readonly string[],
  ): Promise<Map<string, OficialDelDia> | null> {
    if (!this.tipoCambio) return new Map();
    try {
      return await this.tipoCambio.oficialesPorDias(
        fechas.map((f) => String(f).slice(0, 10)),
        { descargar: false },
      );
    } catch {
      return null;
    }
  }

  /**
   * PRE-CIERRE «Gastos en dólares conciliados con un tipo de cambio fuera de
   * lugar» (13-oct-2026, invariante 70): las ligas CRUZADAS (gasto USD ↔
   * cargo en pesos) cuyo T.C. implícito queda a más de ±2 % del oficial del
   * día del CARGO o fuera de la banda 15–25. El periodo se filtra por
   * `fecha_gasto` (DATE, día Cancún). Gastos USD conciliados (paginados, ≤
   * 5,000) → sus partes cruzadas (puente) → sus cargos → T.C. oficial de
   * esos días (aquí SÍ se descarga lo que falte: ≤ `DESCARGAS_TC_MAX`) →
   * `evaluarTcCruce`. Una liga en banda SIN oficial cuenta en `sin_verificar`.
   * NUNCA lanza: sin la sonda de partes, sin `TipoCambioService`, con la
   * lectura truncada o fallida ⇒ null (el pre-cierre lo dice). El sistema
   * NO corrige nada: la oficina desvincula y vincula el cargo correcto.
   */
  async ligasUsdTcFueraDeLugar(
    desde: string,
    hasta: string,
  ): Promise<ResultadoLigasUsdTc | null> {
    try {
      if (!this.tipoCambio || !(await this.partesOn())) return null;
      const d = String(desde).slice(0, 10);
      const h = String(hasta).slice(0, 10);
      const { filas: gastos, truncado } = await this.leerPaginado(
        (a, b) =>
          this.supabase.service
            .from('gasto')
            .select(
              'id, fecha_gasto, monto, moneda, tc_gasto, categoria, lugar, notas, vuelo_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)',
            )
            .eq('moneda', 'USD')
            .eq('conciliado', true)
            .gte('fecha_gasto', d)
            .lte('fecha_gasto', h)
            .order('id', { ascending: true })
            .range(a, b),
        LIGAS_USD_GASTOS_TOPE,
      );
      if (truncado) {
        this.logger.warn(
          `pre-cierre: más de ${LIGAS_USD_GASTOS_TOPE} gastos USD conciliados entre ${d} y ${h}: las ligas por T.C. no se revisan.`,
        );
        return null;
      }
      if (gastos.length === 0) return { ligas: [], sin_verificar: 0 };
      const gastoDe = new Map(gastos.map((g) => [g.id as string, g]));
      const partes = (await this.partesDeGastos([...gastoDe.keys()])).filter(
        (p) => {
          const g = gastoDe.get(p.gasto_id);
          return parteCruzada(
            p.moneda,
            typeof g?.moneda === 'string' ? g.moneda : null,
          );
        },
      );
      if (partes.length === 0) return { ligas: [], sin_verificar: 0 };
      const movs = await this.leerPorLotes(
        partes.map((p) => p.movimiento_id),
        (lote) =>
          this.supabase.service
            .from('movimiento_bancario')
            .select(
              'id, fecha, monto, descripcion, cuenta_bancaria_id, cuenta:cuenta_bancaria(alias)',
            )
            .in('id', lote),
      );
      const movDe = new Map(movs.map((m) => [m.id as string, m]));
      const oficiales = await this.tipoCambio.oficialesPorDias(
        [...new Set(movs.map((m) => String(m.fecha).slice(0, 10)))],
        { descargar: true },
      );
      if (oficiales === null) return null;
      const ligas: LigaUsdTcFueraDeLugar[] = [];
      let sinVerificar = 0;
      for (const p of partes) {
        const g = gastoDe.get(p.gasto_id);
        const m = movDe.get(p.movimiento_id);
        if (!g || !m) continue;
        const fechaCargo = String(m.fecha).slice(0, 10);
        const montoCargo = r2(Math.abs(Number(m.monto) || 0));
        const ev = evaluarTcCruce(
          montoCargo,
          Number(g.monto),
          oficiales.get(fechaCargo) ?? null,
        );
        if (!ev) continue;
        if (!ligaUsdFueraDeLugar(ev)) {
          if (ev.nivel === 'SIN_OFICIAL') sinVerificar += 1;
          continue;
        }
        const prov = unwrapOne(
          g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
        );
        const vuelo = unwrapOne(
          g.vuelo as { folio?: unknown } | { folio?: unknown }[] | null,
        );
        const cuenta = unwrapOne(
          m.cuenta as { alias?: unknown } | { alias?: unknown }[] | null,
        );
        const folio = vuelo?.folio == null ? null : Number(vuelo.folio);
        const liga: Omit<LigaUsdTcFueraDeLugar, 'texto'> = {
          gasto_id: p.gasto_id,
          fecha_gasto:
            typeof g.fecha_gasto === 'string'
              ? g.fecha_gasto.slice(0, 10)
              : null,
          monto_usd: r2(Math.abs(Number(g.monto) || 0)),
          tc_gasto: g.tc_gasto == null ? null : Number(g.tc_gasto),
          categoria: typeof g.categoria === 'string' ? g.categoria : null,
          descripcion_gasto: descripcionGastoUsd({
            notas: typeof g.notas === 'string' ? g.notas : null,
            lugar: typeof g.lugar === 'string' ? g.lugar : null,
            proveedor: typeof prov?.nombre === 'string' ? prov.nombre : null,
          }),
          vuelo_id: typeof g.vuelo_id === 'string' ? g.vuelo_id : null,
          vuelo_folio: folio != null && Number.isFinite(folio) ? folio : null,
          movimiento_id: p.movimiento_id,
          fecha_cargo: fechaCargo,
          monto_cargo: montoCargo,
          cuenta_bancaria_id:
            typeof m.cuenta_bancaria_id === 'string'
              ? m.cuenta_bancaria_id
              : null,
          cuenta: typeof cuenta?.alias === 'string' ? cuenta.alias : null,
          descripcion_cargo:
            typeof m.descripcion === 'string' ? m.descripcion : null,
          tc_cruce: tcCruceUsdPublico(ev),
        };
        ligas.push({ ...liga, texto: textoLigaUsdTc(liga) });
      }
      return { ligas: ordenarLigasUsdTc(ligas), sin_verificar: sinVerificar };
    } catch (err) {
      this.logger.warn(
        `pre-cierre: no se pudieron revisar las ligas USD por T.C.: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Ids de las cuentas en PESOS (memorizado por corrida; null = lectura fallida). */
  private cuentasMxnDe(ctx: CruceCtx): Promise<string[] | null> {
    ctx.cuentasMxn ??= (async () => {
      const { data, error } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, moneda')
        .eq('moneda', 'MXN')
        .limit(200);
      if (error) {
        this.logger.warn(
          `No se pudieron leer las cuentas en pesos: ${error.message}`,
        );
        return null;
      }
      return ((data ?? []) as Array<{ id?: unknown }>)
        .map((c) => c.id)
        .filter((id): id is string => typeof id === 'string');
    })();
    return ctx.cuentasMxn;
  }

  /**
   * Id de la clasificación «Traspaso entre cuentas» (se crea la primera vez
   * que hace falta; `crearClasificacion` ya es idempotente por nombre).
   */
  private async idClasificacionTraspaso(
    ctx: CruceCtx,
    userId: string,
  ): Promise<string | null> {
    if (ctx.clasificacionTraspaso !== undefined)
      return ctx.clasificacionTraspaso;
    try {
      const clasif = await this.crearClasificacion(
        CLASIFICACION_TRASPASO,
        userId,
      );
      ctx.clasificacionTraspaso = (clasif as { id: string }).id;
    } catch (err) {
      this.logger.warn(
        `No se pudo preparar la clasificación «${CLASIFICACION_TRASPASO}»: ${err instanceof Error ? err.message : String(err)}`,
      );
      ctx.clasificacionTraspaso = null;
    }
    return ctx.clasificacionTraspaso;
  }

  /**
   * TRASPASOS INTERNOS (regla por descripción): «SEL TRASPASO ENTRE
   * CUENTAS» y compañía no tienen gasto ni cobro detrás — el dinero solo
   * cambió de cuenta. Sin esta regla quedaban pendientes para siempre e
   * inflaban el «faltan N por conciliar» del cierre. Se clasifican con la
   * clasificación canónica y una nota que dice de dónde salió.
   */
  private async aplicarTraspaso(
    mov: { id: string; descripcion: string | null; notas?: string | null },
    ctx: CruceCtx,
    userId: string,
  ): Promise<ResultadoMovimiento | null> {
    const patron = patronTraspaso(mov.descripcion);
    if (!patron) return null;
    const clasifId = await this.idClasificacionTraspaso(ctx, userId);
    if (!clasifId) return null;
    const nota = `Regla: ${patron}`;
    await this.clasificarMovimiento(
      mov.id,
      clasifId,
      // Nunca se pisa lo que escribió la oficina.
      mov.notas ? undefined : nota,
      userId,
    );
    return {
      movimiento_id: mov.id,
      resultado: 'TRASPASO',
      criterio: 'REGLA',
      motivo: `Traspaso entre cuentas (regla «${patron}»).`,
      candidatos_n: 0,
    };
  }

  /**
   * Cruza UN movimiento pendiente (regla de traspaso → gasto si es CARGO →
   * cobro si es ABONO). Nunca lanza: el fallo se devuelve como resultado
   * ERROR con su motivo para que el job lo cuente y siga.
   */
  private async cruzarMovimiento(
    mov: {
      id: string;
      cuenta_bancaria_id: string;
      fecha: string;
      tipo: string;
      monto: number;
      monto_bruto?: number | null;
      comision_monto?: number | null;
      descripcion: string | null;
      referencia: string | null;
      notas?: string | null;
    },
    cuenta: { moneda: string | null; tipo: string | null },
    ctx: CruceCtx,
    userId: string,
  ): Promise<ResultadoMovimiento> {
    try {
      const traspaso = await this.aplicarTraspaso(mov, ctx, userId);
      if (traspaso) return traspaso;
      // Sin la moneda de la cuenta ninguna consulta de candidatos filtra
      // divisa: un cobro/gasto de 125.82 USD cuadraría con 125.82 MXN. La
      // columna es NOT NULL, así que esto solo pasa si la cuenta no se pudo
      // leer — se cuenta como ERROR y el movimiento queda pendiente.
      if (!cuenta.moneda) {
        return {
          movimiento_id: mov.id,
          resultado: 'ERROR',
          criterio: null,
          motivo:
            'No se pudo leer la moneda de la cuenta bancaria: el cruce no se intenta para no mezclar divisas.',
          candidatos_n: 0,
        };
      }
      if (mov.tipo === (TipoMovimientoBancario.CARGO as string)) {
        return await this.autoMatchCargo(
          {
            id: mov.id,
            monto: mov.monto,
            fecha: mov.fecha,
            descripcion: mov.descripcion,
            referencia: mov.referencia,
          },
          cuenta.moneda,
          userId,
          ctx,
        );
      }
      if (cuenta.tipo === TIPO_CUENTA_PASARELA) {
        return await this.autoMatchAbonoPasarela(
          {
            id: mov.id,
            fecha: mov.fecha,
            monto: Number(mov.monto),
            monto_bruto: mov.monto_bruto ?? null,
            comision_monto: mov.comision_monto ?? null,
            referencia: mov.referencia,
            descripcion: mov.descripcion,
            moneda: cuenta.moneda,
          },
          userId,
          mov.cuenta_bancaria_id,
        );
      }
      // DEVOLUCIÓN DEL BANCO (revisión adversaria 30-sep-2026): un abono
      // con leyenda «CARGO INDEBIDO / DEVOLUCION / REV …» NO es el pago de un
      // cliente: jamás se liga por monto a un cobro, sobre o ingreso (antes
      // un cobro de $X ±días se quedaba con la devolución de un cargo de $X).
      // Queda SIN_CANDIDATO aquí y el paso de reversos de la MISMA corrida
      // (`aplicarReversosEnCorrida`) lo empareja con su cargo o dice por qué
      // no. Solo con la migración de reversos: sin ella, como el 0.0.43.
      if (esDevolucionDeCargo(mov.descripcion) && (await this.reversosOn())) {
        return {
          movimiento_id: mov.id,
          resultado: 'SIN_CANDIDATO',
          criterio: null,
          motivo:
            'Devolución de un cargo del banco: se empareja con su cargo, no con un cobro.',
          candidatos_n: 0,
        };
      }
      return await this.autoMatchAbono(
        {
          id: mov.id,
          monto: Number(mov.monto),
          monto_bruto: mov.monto_bruto ?? null,
          fecha: mov.fecha,
          descripcion: mov.descripcion,
          cuenta_bancaria_id: mov.cuenta_bancaria_id,
        },
        cuenta.moneda,
        userId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`auto-cruce del movimiento ${mov.id}: ${msg}`);
      return {
        movimiento_id: mov.id,
        resultado: 'ERROR',
        criterio: null,
        motivo: msg,
        candidatos_n: 0,
      };
    }
  }

  /**
   * RE-CRUCE de los movimientos PENDIENTES de una ventana (15-sep-2026).
   *
   * Hasta hoy el auto-cruce corría SOLO dentro del bucle de importación: si
   * fallaba (el 15-sep, el trigger con el ENUM de moneda) los movimientos ya
   * insertados se quedaban pendientes PARA SIEMPRE — re-importar respondía
   * «101 duplicados» y no reintentaba el cruce de nadie. Este método vuelve
   * a correr EXACTAMENTE la misma lógica (reglas + cargos + abonos) sobre lo
   * que sigue sin conciliar, y cuenta por qué quedó cada uno.
   */
  async autoMatchPendientes(dto: AutoMatchDto, userId: string) {
    // Re-cruce DIRIGIDO: con ids explícitos la ventana de fechas no aplica
    // (el operador señaló exactamente qué filas reintentar).
    const ids = dto.movimiento_ids?.length ? dto.movimiento_ids : null;
    const hasta = dto.hasta ?? hoyCancun();
    const desdePedido =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (!ids && desdePedido > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    // INICIO OFICIAL (invariante 86): piso SOLO sin ids (con ids el
    // operador eligió las filas); rango que queda antes ⇒ nada que cruzar.
    const desde = ids ? desdePedido : await this.pisoDesde(desdePedido);
    const limite = Math.min(dto.limite ?? 500, RECRUCE_MAX);

    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, cuenta_bancaria_id, fecha, tipo, monto, monto_bruto, comision_monto, descripcion, referencia, notas',
      )
      .eq('conciliado', false)
      .order('fecha', { ascending: true })
      .limit(limite);
    if (ids) q = q.in('id', ids);
    else q = q.gte('fecha', desde).lte('fecha', hasta);
    if (dto.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
    // ADITIVO (24-sep-2026): «Cruzar pendientes» desde Ingresos → Por
    // conciliar corre SOLO los abonos.
    if (dto.tipo) q = q.eq('tipo', dto.tipo);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const movs = (data ?? []) as Array<Record<string, unknown>>;

    const ctx = await this.cargarCtxCruce();
    const cuentas = new Map<
      string,
      { moneda: string | null; tipo: string | null }
    >();
    const resultados: ResultadoMovimiento[] = [];

    for (const m of movs) {
      const cuentaId = m.cuenta_bancaria_id as string;
      if (!cuentas.has(cuentaId)) {
        cuentas.set(cuentaId, await this.infoCuenta(cuentaId));
      }
      const r = await this.cruzarMovimiento(
        {
          id: m.id as string,
          cuenta_bancaria_id: cuentaId,
          fecha: m.fecha as string,
          tipo: m.tipo as string,
          monto: Number(m.monto),
          monto_bruto: m.monto_bruto == null ? null : Number(m.monto_bruto),
          comision_monto:
            m.comision_monto == null ? null : Number(m.comision_monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          notas: (m.notas as string | null) ?? null,
        },
        cuentas.get(cuentaId)!,
        ctx,
        userId,
      );
      resultados.push(r);
    }

    // REVERSOS (30-sep-2026): las devoluciones del banco que el cruce dejó
    // pendientes se emparejan con su cargo (misma función que «Emparejar
    // devoluciones»). Va DESPUÉS: gastos y cobros tienen prioridad.
    const reversosEmparejados = await this.aplicarReversosEnCorrida(
      movs.map((m) => ({ id: m.id as string, tipo: m.tipo as string })),
      resultados,
      userId,
    );
    const conteo = conteoVacio();
    const porCriterio: Record<string, number> = {};
    for (const r of resultados) {
      sumarResultado(conteo, r.resultado);
      if (r.criterio)
        porCriterio[r.criterio] = (porCriterio[r.criterio] ?? 0) + 1;
    }
    const detalle = resultados.slice(0, DETALLE_MAX);

    return {
      revisados: movs.length,
      conciliados: conteo.conciliados,
      traspasos: conteo.traspasos,
      // ADITIVOS (30-sep-2026): movimientos conciliados como reverso
      // (cargo devuelto + su devolución: un par suma 2) y PARES emparejados
      // (un par cuyo cargo cae fuera de la ventana cuenta 1 en `reversos`).
      reversos: conteo.reversos,
      reversos_emparejados: reversosEmparejados,
      ambiguos: conteo.ambiguos,
      sin_candidato: conteo.sin_candidato,
      rechazados: conteo.rechazados,
      errores: conteo.errores,
      por_criterio: porCriterio,
      desde,
      hasta,
      cuenta_bancaria_id: dto.cuenta_bancaria_id ?? null,
      limite,
      truncado: movs.length >= limite,
      detalle_truncado: movs.length > detalle.length,
      detalle,
    };
  }

  /**
   * CAMINO INVERSO (15-sep-2026): un gasto capturado DESPUÉS de importar el
   * estado de cuenta jamás se cruzaba solo — el auto-cruce solo corría al
   * importar y el operador tenía que acordarse de volver a la pestaña.
   *
   * Se llama best-effort desde `expenses.service` al crear/editar un gasto
   * bancario: NUNCA lanza (un fallo aquí no puede tumbar el alta del gasto)
   * y liga solo si hay UN cargo pendiente inequívoco (misma disciplina que
   * el auto-cruce: tarjeta y descripción desempatan, el empate no liga).
   */
  async intentarCruzarGasto(
    gastoId: string,
    userId: string,
  ): Promise<{
    ligado: boolean;
    movimiento_id: string | null;
    motivo: string;
  }> {
    const nada = (motivo: string) => ({
      ligado: false,
      movimiento_id: null,
      motivo,
    });
    try {
      const { data: gasto, error } = await this.supabase.service
        .from('gasto')
        .select(`${GASTO_CRUCE_COLS}, conciliado`)
        .eq('id', gastoId)
        .maybeSingle();
      if (error) return nada(error.message);
      if (!gasto) return nada('El gasto ya no existe.');
      const g = gasto as unknown as Record<string, unknown>;
      if (g.conciliado === true) return nada('El gasto ya está conciliado.');
      const medio = (g.medio_pago as string | null) ?? '';
      if (!MEDIOS_BANCARIOS.includes(medio)) {
        return nada(`El medio ${medio || '(vacío)'} no toca el banco.`);
      }
      const fecha = (g.fecha_gasto as string | null) ?? null;
      const monto = Math.abs(Number(g.monto)) || 0;
      const moneda = (g.moneda as string | null) ?? null;
      if (!fecha || !(monto > 0)) return nada('Gasto sin fecha o sin monto.');
      // `gasto.moneda` es NOT NULL: sin ella no se puede garantizar que el
      // cargo sea de la misma divisa (el filtro de cuentas quedaría abierto).
      if (!moneda) return nada('El gasto no tiene moneda: no se cruza solo.');

      // Pagos parciales: lo que este gasto todavía espera del banco.
      const ligado = (await this.sumasLigadasDe([gastoId])).get(gastoId) ?? 0;
      const objetivo = ligado > 0 ? faltanteDe(monto, ligado) : monto;
      if (!(objetivo > 0)) return nada('El gasto ya está cubierto.');

      // Cuentas de la MISMA moneda del gasto (un cargo de otra moneda es el
      // caso cruzado USD↔MXN: 1 ↔ 1, se deja al operador). Invariante 70
      // (13-oct-2026): el camino inverso del cruce USD ↔ pesos queda
      // DIFERIDO a propósito; ese gasto se liga con «Cruzar pendientes» (que
      // aplica la regla del T.C. oficial) o a mano.
      const { data: cuentas, error: ctaErr } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, moneda')
        .limit(100);
      if (ctaErr) return nada(ctaErr.message);
      const ids = (cuentas ?? [])
        .filter((c) => (c as { moneda: string }).moneda === moneda)
        .map((c) => (c as { id: string }).id);
      if (ids.length === 0) return nada('No hay cuentas de esa moneda.');

      const { desde, hasta } = ventanaDias(fecha, MATCH_DAYS);
      const { data: movs, error: movErr } = await this.supabase.service
        .from('movimiento_bancario')
        .select('id, monto, descripcion, referencia')
        .eq('conciliado', false)
        .eq('tipo', TipoMovimientoBancario.CARGO)
        .in('cuenta_bancaria_id', ids)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .gte('monto', objetivo - TOLERANCIA_CENTAVOS)
        .lte('monto', objetivo + TOLERANCIA_CENTAVOS)
        .limit(15);
      if (movErr) return nada(movErr.message);
      const candidatos = (movs ?? []).map((m) => ({
        id: (m as { id: string }).id,
        monto: Number((m as { monto: unknown }).monto) || 0,
        descripcion: (m as { descripcion?: string | null }).descripcion ?? null,
        referencia: (m as { referencia?: string | null }).referencia ?? null,
      }));
      if (candidatos.length === 0) {
        return nada('Ningún cargo pendiente del banco cuadra con el gasto.');
      }
      const ctx = await this.cargarCtxCruce();
      const eleccion = elegirMovimiento(
        // Se compara contra lo que el gasto todavía espera del banco.
        { ...this.aCandidatoCruce(g), monto_cruce: objetivo },
        candidatos,
        ctx.terminaciones,
      );
      if (!eleccion.movimiento_id) {
        return nada(
          eleccion.detalle ??
            `${candidatos.length} cargos del banco cuadran con el gasto: vincúlalo a mano.`,
        );
      }
      const liga = await this.ligarAuto(
        eleccion.movimiento_id,
        gastoId,
        userId,
      );
      if (!liga.ok) return nada(liga.motivo ?? 'No se pudo ligar.');
      this.logger.log(
        `auto-cruce inverso: el gasto ${gastoId} se ligó con el cargo ${eleccion.movimiento_id} (${eleccion.criterio}).`,
      );
      return {
        ligado: true,
        movimiento_id: eleccion.movimiento_id,
        motivo: `Ligado por ${eleccion.criterio}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`auto-cruce inverso del gasto ${gastoId}: ${msg}`);
      return nada(msg);
    }
  }

  /**
   * Ventana [fecha − días, fecha + días] en hora CANCÚN (invariante 4). La
   * `fecha` del banco es un DATE y `cobro_vuelo.fecha_cobro` es timestamptz:
   * con cortes en UTC la ventana real iba de las 19:00 Cancún del día
   * −(N+1) a las 18:59 del día +N y un cobro capturado a las 20:00 del
   * último día quedaba fuera. Mismos cortes que `cobrosSinBanco`.
   */
  private ventanaAbono(
    fecha: string,
    dias: number,
  ): { lo: string; hi: string } {
    const { desde, hasta } = ventanaDias(fecha, dias);
    return { lo: `${desde}T00:00:00-05:00`, hi: `${hasta}T23:59:59-05:00` };
  }

  /**
   * ABONO = entrada de dinero. Se cruza contra los COBROS de vuelos (HSBC
   * link, transferencia) del mismo monto/moneda ±N días que aún no estén
   * enlazados a otro movimiento. Con esto la mitad "ingresos" del estado de
   * cuenta también se concilia sola.
   *
   * SOBRES de grupo (4-sep-2026): el pago único de un grupo es UN abono del
   * banco → el candidato es el `cobro_grupo` (bruto o neto), nunca sus
   * partes (`cobro_vuelo.cobro_grupo_id`, excluidas de la consulta: una
   * parte de $2,060.16 cuadraría en falso con un depósito ajeno del mismo
   * monto). Candidato ÚNICO entre cobros y sobres: si empatan un cobro y un
   * sobre, es ambiguo y no se cruza.
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77, D11): con la sonda de
   * 20261014000003 el universo es UNO: los cobros SIN abonos por neto/bruto
   * (lo de siempre) MÁS los cobros PARCIALES por su FALTANTE exacto (el
   * segundo SPEI de un pago en partes). La cobertura de los cobros de la
   * ventana se lee ANTES del filtro de monto (el faltante no es el monto del
   * cobro) con el lector único y la MISMA regla de «ocupado» que los
   * candidatos (`cobroParaCruce`: cubierto, cruzado o «de un solo abono» ⇒
   * fuera). Un parcial que gana solo ⇒ criterio FALTANTE; empate ⇒ nombre
   * del ordenante o AMBIGUO, como siempre. Nunca crea un parcial: solo liga
   * un abono que COMPLETA el cobro. Sin la sonda: cualquier liga ocupa (como
   * el 0.0.77).
   */
  private async autoMatchAbono(
    mov: {
      id: string;
      monto: number;
      monto_bruto: number | null;
      fecha: string;
      descripcion: string | null;
      cuenta_bancaria_id: string;
    },
    moneda: string | null,
    userId: string,
  ): Promise<ResultadoMovimiento> {
    const movId = mov.id;
    const monto = mov.monto;
    const { lo, hi } = this.ventanaAbono(mov.fecha, MATCH_DAYS);
    const base = {
      movimiento_id: movId,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };
    // INGRESOS (24-sep-2026): con la migración, los ingresos registrados de
    // ESTA cuenta compiten en el MISMO universo que cobros y sobres, y los
    // cobros nacidos de un anticipo NUNCA son candidatos (su dinero se
    // concilia UNA vez, como anticipo). Sin la migración: lo de siempre.
    const conIngresos = await this.ingresosOn();
    // UN COBRO, VARIOS ABONOS (invariante 77): los PARCIALES compiten por su
    // faltante solo con la puente Y la sonda de 20261014000003.
    const conPuente = await this.cobrosLoteOn();
    const conParciales = conPuente && (await this.cobrosParcialesOn());

    // El banco deposita monto − comisión bancaria: el abono real es el NETO.
    // Se matchea por bruto (cobros sin comisión) O por neto (con comisión) —
    // antes solo por bruto y los cobros con comisión jamás conciliaban.
    // El cliente (vuelo/grupo) viaja para desempatar por NOMBRE del
    // ordenante (transferencias SPEI) cuando ≥ 2 candidatos cuadran. Con
    // parciales, también la moneda y el método (cobertura y «de un solo
    // abono»).
    let q = this.supabase.service
      .from('cobro_vuelo')
      .select(
        conParciales
          ? 'id, monto, moneda, metodo_cobro, comision_banco_monto, fecha_cobro, vuelo:vuelo!vuelo_id(cliente:cliente_id(nombre))'
          : 'id, monto, comision_banco_monto, fecha_cobro, vuelo:vuelo!vuelo_id(cliente:cliente_id(nombre))',
      )
      // Solo cobros POSITIVOS: un REEMBOLSO (monto negativo, 29-ago) sale
      // como CARGO en el banco, no como abono — queda FUERA de la
      // conciliación automática en v1 (se cruza a mano si hace falta).
      .gt('monto', 0)
      // Las PARTES de un sobre nunca son candidatas: se concilia el sobre.
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', METODOS_ABONO_AUTO)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      // Orden estable: si la ventana excede el tope, el corte es determinista.
      .order('fecha_cobro', { ascending: true })
      .limit(50);
    if (conIngresos) q = q.is('ingreso_anticipo_id', null);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, monto, comision_banco_monto, fecha_cobro, grupo:vuelo_grupo!grupo_id(cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', METODOS_ABONO_AUTO)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(50);
    if (moneda) {
      q = q.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const ventanaIng = ventanaDias(mov.fecha, MATCH_DAYS);
    const [cobrosRes, sobresRes, ingresosRes] = await Promise.all([
      q,
      qs,
      conIngresos && moneda
        ? this.supabase.service
            .from('ingreso')
            .select(INGRESO_CANDIDATO_COLS)
            .is('deleted_at', null)
            .eq('cuenta_bancaria_id', mov.cuenta_bancaria_id)
            .eq('moneda', moneda)
            .gte('fecha', ventanaIng.desde)
            .lte('fecha', ventanaIng.hasta)
            .order('fecha', { ascending: true })
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (cobrosRes.error || sobresRes.error || ingresosRes.error) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo: `No se pudieron leer los cobros candidatos: ${cobrosRes.error?.message ?? sobresRes.error?.message ?? ingresosRes.error?.message ?? ''}`,
      };
    }

    const abono: AbonoCruce = {
      monto,
      monto_bruto: mov.monto_bruto,
      descripcion: mov.descripcion,
      cuenta_bancaria_id: mov.cuenta_bancaria_id,
    };
    // Nombre del cliente del vuelo/grupo embebido (desempate por nombre).
    const nombreDe = (rel: unknown): string | null => {
      const padre = unwrapOne(
        rel as {
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(padre?.cliente);
      return typeof cliente?.nombre === 'string' ? cliente.nombre : null;
    };
    const filasCobro = (cobrosRes.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    // D11: la cobertura de TODOS los cobros de la ventana (≤ 50) ANTES del
    // filtro de monto, con las partes de la PUENTE (lector único; con la
    // sonda la puente ya existe y es la fuente): ocupados (cubiertos,
    // cruzados, «de un solo abono») fuera; parciales de banco por su
    // FALTANTE. Una lectura caída ⇒ ERROR (el abono queda pendiente: jamás
    // «libre» a ciegas).
    const ocupadosCobro = new Set<string>();
    const faltantes = new Map<string, number>();
    if (conParciales && filasCobro.length > 0) {
      let partes: Map<string, ParteCobroBanco[]>;
      try {
        partes = await leerPartesDeCobros(
          this.supabase.service,
          filasCobro.map((c) => c.id as string),
        );
      } catch (err) {
        return {
          ...base,
          resultado: 'ERROR',
          motivo: `No se pudieron leer los abonos de los cobros candidatos: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      for (const c of filasCobro) {
        const id = c.id as string;
        const v = cobroParaCruce(c, partes.get(id) ?? [], movId, {
          conParciales: true,
          pasarela: false,
        });
        if (!v.libre) ocupadosCobro.add(id);
        else if (v.faltante != null) faltantes.set(id, v.faltante);
      }
    }
    const candidatos: CandidatoAbonoCruce[] = [
      ...filasCobro.map(
        (c): CandidatoAbonoCruce => ({
          tipo: 'COBRO_VUELO',
          id: c.id as string,
          monto: Number(c.monto) || 0,
          comision: Number(c.comision_banco_monto) || null,
          fecha: (c.fecha_cobro as string) ?? '',
          cliente: nombreDe(c.vuelo),
          cuenta_bancaria_id: null,
          // Solo un PARCIAL lleva faltante (cuadra SOLO por él).
          ...(faltantes.has(c.id as string)
            ? { faltante: faltantes.get(c.id as string) }
            : {}),
        }),
      ),
      ...((sobresRes.data ?? []) as Array<Record<string, unknown>>).map(
        (s): CandidatoAbonoCruce => ({
          tipo: 'SOBRE_GRUPO',
          id: s.id as string,
          monto: Number(s.monto) || 0,
          comision: Number(s.comision_banco_monto) || null,
          fecha: (s.fecha_cobro as string) ?? '',
          cliente: nombreDe(s.grupo),
          cuenta_bancaria_id: null,
        }),
      ),
      ...((ingresosRes.data ?? []) as Array<Record<string, unknown>>).map(
        (f): CandidatoAbonoCruce => {
          const i = this.aIngresoCandidato(f);
          return {
            tipo: 'INGRESO',
            id: i.id,
            monto: i.monto,
            comision: i.comision_monto,
            fecha: i.fecha,
            cliente: i.cliente,
            cuenta_bancaria_id: i.cuenta_bancaria_id,
          };
        },
      ),
    ];
    // Primero el MONTO (misma regla de siempre; un PARCIAL, por su faltante):
    // los ids que cuadran.
    const cuadraCand = (c: CandidatoAbonoCruce) =>
      cuadraMontoAbono(abono, c, false) &&
      (c.tipo !== 'INGRESO' ||
        c.cuenta_bancaria_id === abono.cuenta_bancaria_id);
    const cuadran = candidatos.filter(cuadraCand);
    if (cuadran.length === 0) {
      // Un PARCIAL cuyo monto completo es el abono ya está tomado (le falta
      // otra cifra): el motivo dice «libre», como el de un cobro ligado.
      const tomado = candidatos.some(
        (c) => c.faltante != null && cuadraCand({ ...c, faltante: null }),
      );
      return {
        ...base,
        motivo: `Ningún cobro bancario ${tomado ? 'libre ' : ''}de ${montoBonito(monto)} ${moneda ?? ''} entre ${lo.slice(0, 10)} y ${hi.slice(0, 10)}.`,
      };
    }

    // Descarta cobros/sobres/ingresos ya enlazados a otro movimiento; exige
    // candidato único ENTRE LOS UNIVERSOS (o el nombre del ordenante). Con
    // parciales los cobros ya se decidieron por su cobertura (arriba).
    const cobroIds = conParciales
      ? []
      : cuadran.filter((c) => c.tipo === 'COBRO_VUELO').map((c) => c.id);
    const sobreIds = cuadran
      .filter((c) => c.tipo === 'SOBRE_GRUPO')
      .map((c) => c.id);
    const ingresoIds = cuadran
      .filter((c) => c.tipo === 'INGRESO')
      .map((c) => c.id);
    const ocupados = new Set<string>(
      [...ocupadosCobro].map((id) => `COBRO_VUELO:${id}`),
    );
    if (
      cobroIds.length > 0 ||
      sobreIds.length > 0 ||
      (conIngresos && ingresoIds.length > 0)
    ) {
      // Ligas del espejo + de la PUENTE de cobros (12-oct-2026): un cobro
      // dentro del lote de otro abono también está ocupado.
      const yaEnlazados = await leerLigasDeCobros(this.supabase.service, {
        cobroIds,
        sobreIds,
        anticipoIds: conIngresos ? ingresoIds : [],
        cols: conIngresos ? MOV_LIGA_COLS_CON_INGRESO : MOV_LIGA_COLS,
        conPuente,
      });
      for (const m of (yaEnlazados ?? []) as Array<
        MovimientoLiga & { ingreso_id?: unknown }
      >) {
        if (typeof m.cobro_id === 'string')
          ocupados.add(`COBRO_VUELO:${m.cobro_id}`);
        if (typeof m.cobro_grupo_id === 'string')
          ocupados.add(`SOBRE_GRUPO:${m.cobro_grupo_id}`);
        if (typeof m.ingreso_id === 'string')
          ocupados.add(`INGRESO:${m.ingreso_id}`);
      }
    }
    const libres = cuadran.filter((c) => !ocupados.has(`${c.tipo}:${c.id}`));
    const eleccion = elegirCandidatoAbono(abono, libres, false);
    if (eleccion.motivo === 'SIN_CANDIDATOS') {
      return {
        ...base,
        motivo: `Ningún cobro bancario libre de ${montoBonito(monto)} ${moneda ?? ''} entre ${lo.slice(0, 10)} y ${hi.slice(0, 10)}.`,
      };
    }
    if (!eleccion.elegido) {
      const hayIngreso = libres.some((c) => c.tipo === 'INGRESO');
      const parcialesN = libres.filter((c) => c.faltante != null).length;
      const porFaltante =
        parcialesN > 0
          ? ` (${parcialesN === 1 ? 'uno' : parcialesN} por lo que le falta a un pago parcial)`
          : '';
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: hayIngreso
          ? `${eleccion.candidatos_n} cobros/sobres/ingresos cuadran con este abono${porFaltante}: vincúlalo a mano.`
          : `${eleccion.candidatos_n} cobros/sobres cuadran con este abono${porFaltante}: vincúlalo a mano.`,
      };
    }

    const elegido = eleccion.elegido;
    const criterio = eleccion.criterio ?? 'MONTO_EXACTO';
    if (elegido.tipo === 'INGRESO') {
      // Un cobro de vuelo libre con el monto exacto fuera de la ventana del
      // auto (±30 días, métodos manuales) ⇒ la persona decide (anti doble
      // conteo, espejo de ABONO_TIENE_COBRO_CANDIDATO).
      const exactos = moneda
        ? await this.cobrosExactosLibresDeAbono(abono, mov.fecha, moneda, false)
        : null;
      if (exactos !== 0) {
        return {
          ...base,
          resultado: exactos == null ? 'ERROR' : 'AMBIGUO',
          candidatos_n: eleccion.candidatos_n + (exactos ?? 0),
          motivo:
            exactos == null
              ? 'No se pudo verificar si un cobro de vuelo cuadra con este abono: no se liga al ingreso.'
              : 'El abono cuadra con un ingreso registrado y también con un cobro de vuelo: vincúlalo a mano (si es el pago del vuelo, contaría dos veces).',
        };
      }
      const r = await this.ligarIngresoAuto(movId, elegido.id, userId);
      if (r.ok) {
        return {
          ...base,
          resultado: 'CONCILIADO',
          criterio,
          candidatos_n: eleccion.candidatos_n,
          ingreso_id: elegido.id,
        };
      }
      return {
        ...base,
        resultado: r.rechazado ? 'RECHAZADO' : 'ERROR',
        candidatos_n: eleccion.candidatos_n,
        motivo: r.motivo,
      };
    }
    const liga: LigaCobroInput =
      elegido.tipo === 'COBRO_VUELO'
        ? { cobro_id: elegido.id }
        : { cobro_grupo_id: elegido.id };
    const r = await this.ligarCobroAuto(movId, liga, userId);
    if (r.ok) {
      return {
        ...base,
        resultado: 'CONCILIADO',
        criterio,
        candidatos_n: eleccion.candidatos_n,
        cobro_id: liga.cobro_id ?? null,
        cobro_grupo_id: liga.cobro_grupo_id ?? null,
      };
    }
    return {
      ...base,
      resultado: r.rechazado ? 'RECHAZADO' : 'ERROR',
      candidatos_n: eleccion.candidatos_n,
      motivo: r.motivo,
    };
  }

  /**
   * Gemelo de `ligarCobroAuto` para los INGRESOS: `linkIngreso` puede lanzar
   * 409 (el ingreso ya lo tomó otro abono, monto distinto por carrera) o
   * cualquier error de BD, y ni uno ni otro pueden tumbar la importación.
   */
  private async ligarIngresoAuto(
    movId: string,
    ingresoId: string,
    userId: string,
  ): Promise<{ ok: boolean; rechazado: boolean; motivo: string | null }> {
    try {
      await this.linkIngreso(movId, ingresoId, userId);
      return { ok: true, rechazado: false, motivo: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictException) {
        this.logger.warn(`auto-match abono ${movId} ↔ ingreso: ${msg}`);
        return {
          ok: false,
          rechazado: true,
          motivo: `El ingreso candidato ya no admite este abono (${msg}).`,
        };
      }
      this.logger.error(`auto-match abono ${movId} ↔ ingreso: ${msg}`);
      return { ok: false, rechazado: false, motivo: msg };
    }
  }

  /**
   * ANTI DOBLE CONTEO del auto-cruce (revisión adversaria 24-sep-2026): antes
   * de ligar SOLO un abono a un INGRESO registrado, ¿hay un cobro de vuelo o
   * un sobre LIBRE (métodos MANUALES, positivo, sin anticipo, ±30 días
   * Cancún, misma moneda) con el monto EXACTO (neto, o bruto en pasarela)?
   * Si lo hay, ese dinero probablemente ES el pago del vuelo y el ingreso
   * sería contarlo dos veces: el auto NO decide (queda AMBIGUO para la
   * persona). Es el espejo automático de `ABONO_TIENE_COBRO_CANDIDATO`.
   * Caso real #235 en la cuenta Paywise: el cruce de pasarela solo mira
   * cobros PAYWISE, así que un «otro ingreso» de 19,380 tecleado a mano se
   * habría llevado el abono de Cristy y el cobro #235 (TRANSFERENCIA 20,400 −
   * 1,020) se quedaba para siempre en «cobros sin banco». Devuelve cuántos
   * hay; null si no se pudo leer (el llamador NO liga). PAGINADO por la PK
   * (revisión del 14-oct-2026): con `.limit(1000)` un cobro exacto después
   * de la fila 1000 daba 0 en vez de null —omitir o ligar al ingreso sin
   * aviso—; hoy, más de `TOPE_UNIVERSO` candidatos ⇒ null (falla CERRADO).
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77, D12): con la sonda de
   * 20261014000003 un cobro PARCIAL cuyo FALTANTE es el abono al centavo
   * cuenta como «libre exacto» (todavía espera ese dinero: es su pago, no
   * otro ingreso), con la regla de ocupado del auto-cruce
   * (`cobroParaCruce`) en modo FRENO: «de un solo abono» por la regla del
   * trigger A, sin el método PAYWISE (un freno solo avisa y debe ver todo
   * parcial que la BD sí dejaría completar). Un abono de la PASARELA no
   * completa parciales. La ventana sigue siendo ±30 días por `fecha_cobro`
   * (heredada del 0.0.77): un parcial registrado antes no frena.
   */
  private async cobrosExactosLibresDeAbono(
    abono: AbonoCruce,
    fecha: string,
    moneda: string,
    pasarela: boolean,
  ): Promise<number | null> {
    const sb = this.supabase.service;
    const { lo, hi } = this.ventanaAbono(fecha, VENTANA_MANUAL_DIAS);
    let cobros: Array<Record<string, unknown>>;
    let sobres: Array<Record<string, unknown>>;
    try {
      const [cobrosRes, sobresRes] = await Promise.all([
        this.leerPaginado(
          (a, b) =>
            sb
              .from('cobro_vuelo')
              .select('id, monto, metodo_cobro, comision_banco_monto')
              .gt('monto', 0)
              .is('cobro_grupo_id', null)
              .is('ingreso_anticipo_id', null)
              .in('metodo_cobro', METODOS_ABONO_MANUAL)
              .eq('moneda', moneda)
              .gte('fecha_cobro', lo)
              .lte('fecha_cobro', hi)
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO,
        ),
        this.leerPaginado(
          (a, b) =>
            sb
              .from('cobro_grupo')
              .select('id, monto, comision_banco_monto')
              .gt('monto', 0)
              .in('metodo_cobro', METODOS_ABONO_MANUAL)
              .eq('moneda', moneda)
              .gte('fecha_cobro', lo)
              .lte('fecha_cobro', hi)
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO,
        ),
      ]);
      if (cobrosRes.truncado || sobresRes.truncado) {
        this.logger.warn(
          `Cobros exactos del abono: más de ${TOPE_UNIVERSO} candidatos en ±${VENTANA_MANUAL_DIAS} días (${moneda}); no se pudo verificar.`,
        );
        return null;
      }
      cobros = cobrosRes.filas;
      sobres = sobresRes.filas;
    } catch {
      return null;
    }
    const exacto = (
      tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO',
      c: Record<string, unknown>,
    ) =>
      cuadraMontoAbono(
        abono,
        {
          tipo,
          id: c.id as string,
          monto: Number(c.monto) || 0,
          comision: Number(c.comision_banco_monto) || null,
          fecha: '',
          cliente: null,
          cuenta_bancaria_id: null,
        },
        pasarela,
      );
    const cobroIds = cobros
      .filter((c) => exacto('COBRO_VUELO', c))
      .map((c) => c.id as string);
    const sobreIds = sobres
      .filter((s) => exacto('SOBRE_GRUPO', s))
      .map((s) => s.id as string);
    // D12: solo un cobro cuyo neto REBASA el abono puede ser un parcial al
    // que le falte exactamente el abono (sus otros abonos suman > 0). Las
    // sondas solo se consultan si hay alguno (sin ellos, lo de siempre).
    const montoAbono = r2(Number(abono.monto) || 0);
    const exactosIds = new Set(cobroIds);
    const posiblesParciales = pasarela
      ? []
      : cobros.filter(
          (c) =>
            !exactosIds.has(c.id as string) &&
            netoDeCobro(
              c.monto as number | string | null,
              c.comision_banco_monto as number | string | null,
            ) > montoAbono,
        );
    let conPuente: boolean | null = null;
    let conParciales = false;
    if (posiblesParciales.length > 0) {
      conPuente = await this.cobrosLoteOn();
      conParciales = conPuente && (await this.cobrosParcialesOn());
    }
    const parcialIds = conParciales
      ? posiblesParciales.map((c) => c.id as string)
      : [];
    if (
      cobroIds.length === 0 &&
      sobreIds.length === 0 &&
      parcialIds.length === 0
    )
      return 0;
    let ligados: MovimientoLiga[];
    try {
      ligados = await leerLigasDeCobros(sb, {
        cobroIds: [...cobroIds, ...parcialIds],
        sobreIds,
        conPuente: conPuente ?? (await this.cobrosLoteOn()),
      });
    } catch {
      return null;
    }
    const ocupados = new Set<string>();
    for (const m of ligados) {
      if (typeof m.cobro_grupo_id === 'string') ocupados.add(m.cobro_grupo_id);
      // Sin la sonda de parciales, cualquier liga ocupa el cobro (0.0.77).
      if (!conParciales && typeof m.cobro_id === 'string') {
        ocupados.add(m.cobro_id);
      }
    }
    if (!conParciales) {
      return [...cobroIds, ...sobreIds].filter((id) => !ocupados.has(id))
        .length;
    }
    // Con la sonda: la cobertura de cada cobro decide (`cobroParaCruce`):
    // sin otros abonos cuenta si cuadra por neto/bruto; un parcial de banco,
    // si lo que le falta es el abono al centavo. Es un FRENO (solo avisa):
    // «de un solo abono» por la regla del trigger A, sin el método PAYWISE
    // (un parcial que la BD sí deja completar todavía espera ese dinero;
    // revisión del 15-oct-2026).
    const partes = partesDeLigas(ligados);
    const porId = new Map(cobros.map((c) => [c.id as string, c]));
    let libresCobro = 0;
    for (const id of [...cobroIds, ...parcialIds]) {
      const c = porId.get(id);
      if (!c) continue;
      const v = cobroParaCruce({ ...c, moneda }, partes.get(id) ?? [], null, {
        conParciales: true,
        pasarela: false,
        freno: true,
      });
      if (!v.libre) continue;
      const cuadra =
        v.faltante == null
          ? exacto('COBRO_VUELO', c)
          : cuadraMontoAbono(
              abono,
              {
                tipo: 'COBRO_VUELO',
                id,
                monto: Number(c.monto) || 0,
                comision: Number(c.comision_banco_monto) || null,
                fecha: '',
                cliente: null,
                cuenta_bancaria_id: null,
                faltante: v.faltante,
              },
              false,
            );
      if (cuadra) libresCobro += 1;
    }
    return libresCobro + sobreIds.filter((id) => !ocupados.has(id)).length;
  }

  /**
   * Vincula un ABONO con un cobro de vuelo (`cobro_id`) O con el SOBRE de un
   * grupo (`cobro_grupo_id`) — excluyentes (CHECK
   * movimiento_bancario_cobro_excluyente). Ambos null = desvincular (limpia
   * las dos ligas). Una PARTE de sobre jamás se enlaza: 409 COBRO_DE_GRUPO
   * («concilia contra el sobre del grupo G-n»).
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77):
   * - un `cobro_id` suelto se PRE-VALIDA con el espejo TS del trigger A
   *   (`prevalidarCobroUnico`: la cobertura de sus OTROS abonos +
   *   `puedeLigarCobros` con UN cobro), con el MISMO código y `details` que
   *   la BD: abono MENOR ⇒ el cobro queda PARCIAL (sin bandera, D3); de más
   *   ⇒ 409 ABONO_EXCEDE_COBRO con `sugeridos[]`; comisión o pasarela que no
   *   cuadra con el neto ⇒ 409 COMISION_NO_CUADRA; otra moneda fuera de la
   *   banda o a más de ±2 % del T.C. del cobro/vuelo ⇒ 409
   *   COBRO_MONEDA_DISTINTA; cubierto o «de un solo abono» con otro ⇒ 409
   *   COBRO_YA_CONCILIADO. Sin la migración 20261014000003 el 2.º abono de
   *   un cobro PARCIAL ⇒ 503 CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE;
   * - un SOBRE en una cuenta de banco de su moneda ⇒ |abono| = neto del
   *   sobre ± $1.00 o 409 SOBRE_NO_CUADRA (solo API, D8);
   * - `corregir_comision` (UN cobro de vuelo sin abonos y SOLO si el
   *   veredicto sin corregir es COMISION_NO_CUADRA: `decidirCorregirComision`
   *   decide ANTES de escribir; PARCIAL / NO_HACE_FALTA ⇒ 400 y cualquier
   *   otro rechazo ⇒ su 409/400, sin escribir): escribe la comisión REAL
   *   (monto − depósito) con `escribirComisionReal` y liga por el camino
   *   normal; si la liga falla después, la comisión QUEDA (es la verdad del
   *   banco) y el error lo dice (`details.comision_corregida`);
   * - con la puente, la respuesta es SIEMPRE la de `respuestaCobros` (fila
   *   releída + `cobros_estado[]`, también con un `cobro_id` suelto) y, al
   *   desvincular, `cobros_liberados[]` con el estado de cada cobro DESPUÉS.
   * `opts.respuesta: false` (INTERNO: auto-cruce y Paywise, que la tiran)
   * devuelve la fila del UPDATE sin releer.
   */
  async linkCobro(
    movId: string,
    liga: LigaCobroInput,
    userId: string,
    opts: { respuesta?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let cobroId = liga.cobro_id ?? null;
    const sobreId = liga.cobro_grupo_id ?? null;
    const corregir = liga.corregir_comision === true;
    if (cobroId && sobreId) {
      throw new BadRequestException(
        'Indica un cobro de vuelo O un sobre de grupo, no los dos.',
      );
    }
    // 1 ABONO ↔ N COBROS (12-oct-2026, invariante 56): `cobro_ids`. Con la
    // puente aplicada SIEMPRE va por la RPC (también con un solo cobro: así
    // reemplaza un lote por un cobro o al revés en una transacción); sin
    // ella, UN cobro es la liga de siempre y 2+ responde 503.
    if (Array.isArray(liga.cobro_ids)) {
      if (cobroId || sobreId) {
        throw new BadRequestException({
          message: 'Manda cobro_ids O cobro_id / cobro_grupo_id, no los dos.',
          error: 'LOTE_INVALIDO',
        });
      }
      const ids = [
        ...new Set(
          liga.cobro_ids
            .filter((x) => typeof x === 'string' && x)
            .map((x) => normalizarUuid(x)),
        ),
      ];
      if (ids.length === 0 || ids.length > LOTE_COBROS_MAX) {
        throw new BadRequestException({
          message:
            ids.length === 0
              ? 'Elige al menos un cobro.'
              : `Un abono paga a lo más ${LOTE_COBROS_MAX} cobros.`,
          error: 'LOTE_INVALIDO',
        });
      }
      // «Corregir la comisión y vincular» (invariante 77): solo con UN cobro.
      if (corregir && ids.length !== 1) {
        throw errorCorregirComisionNoAplica('VARIOS_COBROS');
      }
      if (await this.cobrosLoteOn()) {
        return this.ligarCobrosPorRpc(movId, ids, userId, {
          corregirComision: corregir,
          respuesta: opts.respuesta !== false,
        });
      }
      if (ids.length >= 2) throw errorCobrosLoteNoDisponibles();
      cobroId = ids[0];
    }
    if (corregir && !cobroId) {
      throw errorCorregirComisionNoAplica(sobreId ? 'SOBRE' : 'SIN_COBRO');
    }
    // Emparejado como devolución de un cargo (30-sep-2026): 409 antes de
    // tocar nada (el trigger también lo rechazaría, con peor mensaje).
    await this.bloquearSiEnReverso(movId);
    const [conIngresos, conPartes, conCobros] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
      this.cobrosLoteOn(),
    ]);
    const colsMov = `id, tipo, fecha, monto, cuenta_bancaria_id, gasto_id, clasificacion_id, notas, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)${conIngresos ? ', ingreso_id' : ''}${conPartes ? ', gastos_n' : ''}${conCobros ? ', cobros_n' : ''}`;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as {
      id: string;
      tipo: string;
      fecha: string;
      monto: number | string;
      cuenta_bancaria_id: string;
      gasto_id: string | null;
      clasificacion_id?: string | null;
      clasificacion?: { nombre?: unknown } | { nombre?: unknown }[] | null;
      notas?: string | null;
      gastos_n?: number | null;
      ingreso_id?: string | null;
      cobros_n?: number | null;
    };
    const ligar = cobroId !== null || sobreId !== null;
    // OMITIDO (14-oct-2026, invariante 75): ni se liga ni se «desliga» — el
    // UPDATE de abajo pone `clasificacion_id = null` y borraría la omisión
    // en silencio. 409 sin escribir (una clasificación NO canónica se sigue
    // pisando al ligar un cobro, como siempre). Por el NOMBRE embebido; en
    // una carrera, el trigger de la BD (23514 ⇒ 409 por `leerErrorCobros`).
    await this.bloquearSiOmitido(
      movId,
      mov.clasificacion_id,
      mov.notas,
      unwrapOne(mov.clasificacion ?? null)?.nombre,
    );
    // Un abono conciliado con un INGRESO no se liga ni se desvincula por
    // aquí (su camino es PATCH movimientos/:id/ingreso).
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    // DESVINCULAR (0.0.78, invariante 77): los cobros que suelta ESTE abono,
    // leídos ANTES de soltar (`cobros_liberados` de la respuesta;
    // best-effort: null = no se pudieron leer y la llave no viaja).
    const liberados =
      !ligar && conCobros && opts.respuesta !== false
        ? await this.cobrosDelAbono(movId, Number(mov.cobros_n) || 0)
        : null;
    // Un LOTE de cobros (2+, 12-oct-2026) solo se cambia con `cobro_ids`
    // (RPC): el espejo `cobro_id` ya es NULL y el trigger legado rechazaría
    // tocarlo. Desvincular (ambos null) sí: se sueltan las partes ANTES y
    // el camino de siempre termina de dejarlo pendiente.
    if (conCobros && Number(mov.cobros_n) >= 2) {
      if (ligar) {
        throw new ConflictException({
          message: mensajeErrorCobros(
            'LOTE_SOLO_API_NUEVO',
            { cobros_n: mov.cobros_n },
            '',
          ),
          error: 'MOVIMIENTO_CON_LOTE',
          details: { movimiento_id: movId, cobros_n: mov.cobros_n },
        });
      }
      await this.desligarCobrosPorRpc(movId, userId);
    }
    // Un movimiento que ya paga gasto(s) NO admite además un cobro (revisión
    // 2-oct-2026): su dinero se contaría dos veces. El trigger A custodia el
    // sentido contrario (partes en un movimiento con cobro); este, el que
    // no tiene CHECK en la BD. Desvincular (ambos null) sí pasa.
    if (ligar && ligadoAGasto(mov)) {
      throw new ConflictException({
        message: mensajeMovimientoConGastos(
          Math.max(gastosLigadosN(mov), mov.gasto_id ? 1 : 0),
        ),
        error: 'MOVIMIENTO_YA_LIGADO',
        details: {
          liga: 'GASTO',
          movimiento_id: movId,
          gasto_id: mov.gasto_id,
          gastos_n: Math.max(gastosLigadosN(mov), mov.gasto_id ? 1 : 0),
        },
      });
    }
    // Solo un ABONO (entrada de dinero) paga un cobro o un sobre (0.0.78: la
    // regla del cobro se mide contra |abono|; el trigger A de la puente ya lo
    // exigía al cobro con SOLO_ABONOS). Después de los 409 de siempre.
    if (ligar && mov.tipo !== (TipoMovimientoBancario.ABONO as string)) {
      throw new BadRequestException({
        message: mensajeErrorCobros('SOLO_ABONOS', null, ''),
        error: 'SOLO_ABONOS',
      });
    }

    let corregida: ComisionCorregida | null = null;
    if (cobroId) {
      const colsCobro: string = conIngresos
        ? 'id, vuelo_id, monto, moneda, comision_banco_monto, tc_usd_mxn, cobro_grupo_id, ingreso_anticipo_id, sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio)), vuelo:vuelo!vuelo_id(folio, tc_usd_mxn)'
        : 'id, vuelo_id, monto, moneda, comision_banco_monto, tc_usd_mxn, cobro_grupo_id, sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio)), vuelo:vuelo!vuelo_id(folio, tc_usd_mxn)';
      const { data: cobroRaw, error: cobroErr } = await this.supabase.service
        .from('cobro_vuelo')
        .select(colsCobro)
        .eq('id', cobroId)
        .maybeSingle();
      if (cobroErr) throw new Error(cobroErr.message);
      if (!cobroRaw) throw new BadRequestException('Cobro no encontrado.');
      const cobro = cobroRaw as unknown as Record<string, unknown> & {
        id: string;
        cobro_grupo_id?: unknown;
      };
      // Un cobro nacido de un ANTICIPO nunca se liga a un abono: su dinero
      // se concilia UNA vez, como anticipo (cubre también Paywise y el
      // diálogo manual).
      if (
        typeof cobro.ingreso_anticipo_id === 'string' &&
        cobro.ingreso_anticipo_id
      ) {
        throw await this.conflictoCobroDeAnticipo(cobro.ingreso_anticipo_id);
      }
      if (esParteDeSobre(cobro)) {
        const sobre = unwrapOne(
          cobro.sobre as {
            grupo?: { folio?: unknown } | { folio?: unknown }[] | null;
          } | null,
        );
        const folioRaw = unwrapOne(sobre?.grupo)?.folio;
        const grupoFolio = folioRaw == null ? null : Number(folioRaw);
        const g = `G-${grupoFolio ?? '?'}`;
        throw new ConflictException({
          message: `Este cobro es parte del sobre del grupo ${g}: concilia el abono contra el sobre del grupo ${g}, no contra sus partes.`,
          error: 'COBRO_DE_GRUPO',
          details: {
            cobro_id: cobroId,
            cobro_grupo_id: cobro.cobro_grupo_id as string,
            grupo_folio: grupoFolio,
          },
        });
      }
      // UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): la pre-validación
      // del trigger A (cobertura de sus OTROS abonos + `alVincularAbono`)
      // reemplaza los dos chequeos de «ya enlazado a OTRO movimiento» del
      // 0.0.77 (espejo y puente): un cobro PARCIAL sí admite este abono.
      corregida = await this.prevalidarCobroUnico(movId, mov, cobro, {
        conCobros,
        corregir,
        userId,
      });
    }

    if (sobreId) {
      const { data: sobreRaw, error: sobreErr } = await this.supabase.service
        .from('cobro_grupo')
        .select(
          'id, monto, moneda, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio)',
        )
        .eq('id', sobreId)
        .maybeSingle();
      if (sobreErr) throw new Error(sobreErr.message);
      if (!sobreRaw) {
        throw new BadRequestException('Cobro de grupo (sobre) no encontrado.');
      }
      const { data: yaEnlazado, error: ocupadoErr } =
        await this.supabase.service
          .from('movimiento_bancario')
          .select('id')
          .eq('cobro_grupo_id', sobreId)
          .neq('id', movId)
          .limit(1)
          .maybeSingle();
      if (ocupadoErr) throw new Error(ocupadoErr.message);
      if (yaEnlazado) {
        throw new ConflictException(
          'Ese sobre de grupo ya está conciliado con otro movimiento bancario.',
        );
      }
      // SOBRE_NO_CUADRA (0.0.78, D8): el abono de banco es el neto del sobre.
      await this.prevalidarSobre(movId, mov, sobreRaw);
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        cobro_id: cobroId,
        cobro_grupo_id: sobreId,
        conciliado: ligar || mov.gasto_id !== null || gastosLigadosN(mov) > 0,
        // Vincular un cobro real pisa la clasificación "sin vuelo".
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(await this.movCols())
      .maybeSingle();
    if (error) {
      let e = this.errorLigaDirectaCobro(error, sobreId);
      if (cobroId) {
        e = await this.conSugeridosSiExcede(e, movId, {
          fecha: mov.fecha,
          cuenta_bancaria_id: mov.cuenta_bancaria_id,
          excluir: [cobroId],
        });
      }
      throw corregida ? conNotaComisionCorregida(e, corregida) : e;
    }
    const extra: Record<string, unknown> = corregida
      ? { comision_corregida: corregida }
      : {};
    const fila = data as unknown as Record<string, unknown>;
    if (!conCobros || opts.respuesta === false) return { ...fila, ...extra };
    // Con la puente: la fila RELEÍDA (los espejos `cobros_n`/`cobro_id` los
    // recalcula la BD después del UPDATE) + `cobros_estado[]`. La liga YA
    // quedó escrita: si la relectura falla, la fila del UPDATE (sin 5xx).
    let resp: Record<string, unknown>;
    try {
      resp = await this.respuestaCobros(movId);
    } catch (err) {
      this.logger.warn(
        `Conciliación del abono ${movId}: la liga quedó escrita pero no se pudo releer (${err instanceof Error ? err.message : String(err)}).`,
      );
      resp = fila;
    }
    const cobrosLiberados = liberados
      ? await this.cobrosLiberados(liberados)
      : null;
    return {
      ...resp,
      ...(cobrosLiberados ? { cobros_liberados: cobrosLiberados } : {}),
      ...extra,
    };
  }

  /**
   * Pre-validación del camino DIRECTO (un `cobro_id` suelto; 0.0.78,
   * invariante 77): el espejo TS del trigger A para UN cobro, con la
   * cobertura de sus OTROS abonos (lector único) y la cuenta del abono, y el
   * MISMO código y `details` que la BD (409 sin escribir). Sin la sonda de
   * 20261014000003 un cobro con otros abonos no admite otro (la BD vieja lo
   * rechaza por su índice único): si la regla nueva lo aceptaría ⇒ 503
   * CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE (un cobro CUBIERTO ya salió
   * con 409 COBRO_YA_CONCILIADO). Con `corregir`, valida y escribe la
   * comisión real ANTES de la regla y la devuelve; un error posterior lleva
   * la nota de la comisión corregida.
   */
  private async prevalidarCobroUnico(
    movId: string,
    mov: { fecha: string; monto: number | string; cuenta_bancaria_id: string },
    cobro: Record<string, unknown> & { id: string },
    opts: { conCobros: boolean; corregir: boolean; userId: string },
  ): Promise<ComisionCorregida | null> {
    const [ligas, cuenta] = await Promise.all([
      leerLigasDeCobros(this.supabase.service, {
        cobroIds: [cobro.id],
        conPuente: opts.conCobros,
      }),
      this.infoCuenta(mov.cuenta_bancaria_id),
    ]);
    if (!cuenta.moneda) throw errorCuentaSinMonedaCobros();
    const partes = partesDeLigas(ligas).get(cobro.id) ?? [];
    const c = cobroParaLoteDeFila(
      cobro,
      partes.filter((p) => p.movimiento_id !== movId),
    );
    const ctx: ContextoSugeridos = {
      fecha: mov.fecha,
      cuenta_bancaria_id: mov.cuenta_bancaria_id,
      moneda: cuenta.moneda,
      tipoCuenta: cuenta.tipo,
      excluir: [cobro.id],
    };
    let corregida: ComisionCorregida | null = null;
    if (opts.corregir) {
      corregida = await this.corregirComisionAntesDeLigar(
        c,
        partes,
        mov.monto,
        { moneda: cuenta.moneda, tipo: cuenta.tipo },
        opts.userId,
        movId,
        ctx,
      );
      c.comision_banco_monto = corregida.despues;
    }
    try {
      const veredicto = puedeLigarCobros({
        montoAbono: mov.monto,
        monedaCuenta: cuenta.moneda,
        tipoCuenta: cuenta.tipo,
        toleranciaTcPct: TOLERANCIA_TC_OFICIAL_PCT,
        cobros: [c],
      });
      if (!veredicto.ok) {
        throw await this.errorVeredictoCobros(veredicto, movId, ctx);
      }
      if ((c.otras?.length ?? 0) > 0 && !(await this.cobrosParcialesOn())) {
        throw errorCobrosParcialesNoDisponibles();
      }
    } catch (err) {
      throw corregida ? conNotaComisionCorregida(err, corregida) : err;
    }
    return corregida;
  }

  /**
   * SOBRE_NO_CUADRA (0.0.78, D8; solo en el API: el neto del sobre vive en
   * `cobro_grupo` y el API es su único escritor): un abono de una cuenta de
   * BANCO en la moneda del sobre debe ser su neto ± $1.00. Pasarela u otra
   * moneda, como siempre.
   */
  private async prevalidarSobre(
    movId: string,
    mov: { monto: number | string; cuenta_bancaria_id: string },
    sobre: Record<string, unknown>,
  ): Promise<void> {
    const cuenta = await this.infoCuenta(mov.cuenta_bancaria_id);
    if (!cuenta.moneda) throw errorCuentaSinMonedaCobros();
    const v = alVincularSobre({
      montoAbono: mov.monto,
      monedaCuenta: cuenta.moneda,
      tipoCuenta: cuenta.tipo,
      sobre,
    });
    if (v.estado !== 'SOBRE_NO_CUADRA') return;
    const folioRaw = unwrapOne(
      sobre.grupo as { folio?: unknown } | { folio?: unknown }[] | null,
    )?.folio;
    const grupoFolio = folioRaw == null ? null : Number(folioRaw);
    const montoAbono = r2(Math.abs(Number(mov.monto) || 0));
    throw new ConflictException({
      message: mensajeSobreNoCuadra({
        grupo_folio: grupoFolio,
        monto_abono: montoAbono,
        neto_sobre: v.neto,
        diferencia: v.diferencia,
        moneda: cuenta.moneda,
        con_comision: v.neto < r2(Number(sobre.monto) || 0),
      }),
      error: 'SOBRE_NO_CUADRA',
      details: {
        movimiento_id: movId,
        cobro_grupo_id: sobre.id,
        grupo_folio: grupoFolio,
        monto_abono: montoAbono,
        neto_sobre: v.neto,
        diferencia: v.diferencia,
        moneda: cuenta.moneda,
      },
    });
  }

  /**
   * «Corregir la comisión y vincular» (0.0.78, D6; endurecida en la revisión
   * del 15-oct-2026). Decide `decidirCorregirComision` ANTES de escribir:
   * solo si el veredicto SIN corregir (el de la liga, con la comisión
   * vigente) es COMISION_NO_CUADRA y la comisión real vale; con abonos,
   * otra moneda, PARCIAL o NO_HACE_FALTA ⇒ 400 CORREGIR_COMISION_NO_APLICA;
   * cualquier otro rechazo (parte de un sobre, anticipo, reembolso, de más…)
   * ⇒ el MISMO 409/400 que sin la bandera. Nada se escribe en esos casos.
   * Escribe la comisión real con `escribirComisionReal` (la misma escritura
   * del cruce Paywise) y devuelve {cobro_id, antes, despues}; si ya era
   * esa, no escribe.
   */
  private async corregirComisionAntesDeLigar(
    c: CobroParaLote,
    partes: ReadonlyArray<ParteCobroBanco>,
    montoAbono: number | string,
    cuenta: { moneda: string; tipo: string | null },
    userId: string,
    movId: string,
    ctx: ContextoSugeridos,
  ): Promise<ComisionCorregida> {
    const d = decidirCorregirComision({
      cobro: c,
      nPartes: partes.length,
      montoAbono,
      monedaCuenta: cuenta.moneda,
      tipoCuenta: cuenta.tipo,
      toleranciaTcPct: TOLERANCIA_TC_OFICIAL_PCT,
    });
    if (!d.aplica) {
      if ('rechazo' in d) {
        throw await this.errorVeredictoCobros(d.rechazo, movId, ctx);
      }
      throw errorCorregirComisionNoAplica(d.motivo);
    }
    const monto = r2(Number(c.monto) || 0);
    const antes =
      (Number(c.comision_banco_monto) || 0) > 0
        ? r2(Number(c.comision_banco_monto))
        : null;
    const nueva = d.comision > 0.01 ? r2(d.comision) : null;
    if ((antes ?? 0) === (nueva ?? 0)) {
      return { cobro_id: c.id, antes, despues: antes };
    }
    const despues = await this.escribirComisionReal(
      c.id,
      monto,
      d.comision,
      userId,
    );
    this.logger.log(
      `Comisión real ${despues ?? 0} escrita en el cobro ${c.id} (antes ${antes ?? 0}) al vincular («Corregir la comisión y vincular»).`,
    );
    return { cobro_id: c.id, antes, despues };
  }

  /**
   * Escribe en el COBRO DE VUELO la comisión REAL del banco o de la pasarela
   * (fuente única de esta escritura: el cruce Paywise y «Corregir la comisión
   * y vincular», 0.0.78): `comision_banco_monto` = la comisión (null si ≤
   * 0.01) y `comision_banco_pct` recalculado a 4 decimales. Un 23514
   * COBRO_CONCILIADO del trigger E (el cobro ya tiene abonos) ⇒ 409 con su
   * texto. Devuelve la comisión que quedó.
   */
  private async escribirComisionReal(
    cobroId: string,
    monto: number,
    comision: number,
    userId: string,
  ): Promise<number | null> {
    const cm = comision > 0.01 ? r2(comision) : null;
    const { error } = await this.supabase.service
      .from('cobro_vuelo')
      .update({
        comision_banco_monto: cm,
        comision_banco_pct:
          cm != null && monto > 0
            ? Math.round((cm / monto) * 100 * 10000) / 10000
            : null,
        updated_by: userId,
      })
      .eq('id', cobroId);
    if (error) {
      const e = error.code === '23514' ? leerErrorCobros(error) : null;
      if (e?.codigo === 'COBRO_CONCILIADO') {
        throw new ConflictException({
          message: mensajeErrorCobros('COBRO_CONCILIADO', e.details, e.texto),
          error: 'COBRO_CONCILIADO',
          details: e.details ?? undefined,
        });
      }
      throw new Error(error.message);
    }
    return cm;
  }

  /**
   * 400/409 de un veredicto de `puedeLigarCobros` (mismo código y `details`
   * que la BD, + `movimiento_id`). ABONO_EXCEDE_COBRO lleva `sugeridos[]`
   * (best-effort).
   */
  private async errorVeredictoCobros(
    v: Extract<VeredictoLoteCobros, { ok: false }>,
    movId: string,
    ctx: ContextoSugeridos,
  ): Promise<BadRequestException | ConflictException> {
    const details: Record<string, unknown> = {
      movimiento_id: movId,
      ...v.details,
    };
    if (v.codigo === 'ABONO_EXCEDE_COBRO') {
      details.sugeridos = await this.sugeridosDeExcedente(
        movId,
        ctx,
        Number(v.details.excedente),
      );
    }
    const cuerpo = { message: v.mensaje, error: v.codigo, details };
    return v.codigo === 'LOTE_INVALIDO'
      ? new BadRequestException(cuerpo)
      : new ConflictException(cuerpo);
  }

  /**
   * Un 409 ABONO_EXCEDE_COBRO que viene de la BD (carrera con otra liga)
   * gana sus `sugeridos[]` (best-effort); cualquier otro error pasa igual.
   */
  private async conSugeridosSiExcede(
    err: Error,
    movId: string,
    ctx: ContextoSugeridos,
  ): Promise<Error> {
    if (!(err instanceof ConflictException)) return err;
    const r = err.getResponse() as Record<string, unknown> | string;
    if (typeof r !== 'object' || r.error !== 'ABONO_EXCEDE_COBRO') return err;
    const details =
      r.details && typeof r.details === 'object'
        ? (r.details as Record<string, unknown>)
        : {};
    if (Array.isArray(details.sugeridos)) return err;
    const sugeridos = await this.sugeridosDeExcedente(
      movId,
      ctx,
      Number(details.excedente),
    );
    return new ConflictException({ ...r, details: { ...details, sugeridos } });
  }

  /**
   * Sugeridos de un ABONO_EXCEDE_COBRO (D4, best-effort ⇒ [] y warn si
   * algo falla): del MISMO universo de «Vincular» (`consultaCobrosDeAbono`,
   * ±60 días, la moneda de la cuenta; ocupados fuera con
   * `cobroOcupadoParaAbono`), los cobros a los que les FALTA ≈ el excedente
   * (±0.02), por cercanía de fecha; ≤ 3.
   */
  private async sugeridosDeExcedente(
    movId: string,
    ctx: ContextoSugeridos,
    excedente: number,
  ): Promise<SugeridoCobro[]> {
    if (!(excedente > 0)) return [];
    try {
      const cuenta =
        ctx.moneda !== undefined
          ? { moneda: ctx.moneda, tipo: ctx.tipoCuenta ?? null }
          : await this.infoCuenta(ctx.cuenta_bancaria_id);
      if (!cuenta.moneda) return [];
      const [conIngresos, conCobrosLote] = await Promise.all([
        this.ingresosOn(),
        this.cobrosLoteOn(),
      ]);
      const { lo, hi } = this.ventanaAbono(ctx.fecha, CANDIDATOS_DIAS_DEFAULT);
      const res = await this.consultaCobrosDeAbono(
        lo,
        hi,
        cuenta.moneda,
        conIngresos,
      );
      if (res.error) throw new Error(res.error.message);
      const cobros = (res.data ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      if (cobros.length === 0) return [];
      const conParciales = conCobrosLote && (await this.cobrosParcialesOn());
      const ligas = await leerLigasDeCobros(this.supabase.service, {
        cobroIds: cobros.map((c) => c.id as string),
        conPuente: conCobrosLote,
      });
      const partes = partesDeLigas(ligas);
      const pasarela = cuenta.tipo === 'PASARELA';
      const universo = cobros
        .filter(
          (c) =>
            !cobroOcupadoParaAbono(c, partes.get(c.id as string) ?? [], movId, {
              conParciales,
              pasarela,
            }),
        )
        .map((c) =>
          sugeridoDeFila(
            c,
            faltanteFueraDe(c, partes.get(c.id as string) ?? [], movId)
              .faltante,
          ),
        );
      return sugeridosParaExcedente(
        universo,
        excedente,
        ctx.fecha,
        ctx.excluir,
      );
    } catch (err) {
      this.logger.warn(
        `No se pudieron armar los cobros sugeridos del abono ${movId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Error del UPDATE del camino directo (`cobro_id` / `cobro_grupo_id`) ⇒
   * 409/400 con su código y texto es-MX (nunca el 400 genérico ni un 500).
   */
  private errorLigaDirectaCobro(
    error: {
      code?: string | null;
      message?: string | null;
      hint?: string | null;
      details?: string | null;
    },
    sobreId: string | null,
  ): Error {
    // Índices únicos uq_mov_bancario_cobro / uq_mov_bancario_cobro_grupo:
    // dos vínculos simultáneos al mismo cobro/sobre pasan el check previo
    // (TOCTOU) pero solo uno gana en la BD (desde 20261014000003 solo el del
    // sobre; el de cobros lo custodia el trigger A con el cobro bloqueado).
    if (error.code === '23505' || error.message?.includes('23505')) {
      return new ConflictException(
        sobreId
          ? 'Ese sobre de grupo ya está vinculado a otro movimiento bancario.'
          : 'Ese cobro ya está vinculado a otro movimiento bancario.',
      );
    }
    if (error.code === '23503') {
      return new BadRequestException(
        sobreId ? 'Cobro de grupo no encontrado.' : 'Cobro no encontrado.',
      );
    }
    if (error.code === '23514') {
      // Por NOMBRE del constraint (24-sep-2026): antes cualquier 23514
      // decía «cobro y sobre a la vez».
      const msg = error.message ?? '';
      if (msg.includes('movimiento_bancario_ingreso')) {
        return new ConflictException({
          message:
            'Ese movimiento ya está conciliado con un ingreso: desvincúlalo antes.',
          error: 'MOVIMIENTO_YA_LIGADO',
          details: { liga: 'INGRESO' },
        });
      }
      // Puente de cobros (12-oct-2026): el trigger legado rechaza tocar un
      // lote y A un cobro que no admite este abono — 409 con su código y
      // texto en es-MX (sin la marca « [ABONO_NO_CUADRA]»), nunca el 400
      // genérico.
      const deCobros = leerErrorCobros(error);
      if (deCobros.codigo && deCobros.codigo !== 'LOTE_INVALIDO') {
        return new ConflictException({
          message: mensajeErrorCobros(
            deCobros.codigo,
            deCobros.details,
            deCobros.texto,
          ),
          error: deCobros.codigo,
          details: deCobros.details ?? undefined,
        });
      }
      if (msg.includes('cobro_excluyente') || !msg) {
        return new BadRequestException(
          'Un movimiento no puede ligar un cobro de vuelo y un sobre de grupo a la vez.',
        );
      }
      return new BadRequestException(
        `El movimiento no admite esa liga (${msg.slice(0, 200)}).`,
      );
    }
    return new Error(error.message ?? 'Error de la base de datos');
  }

  /**
   * Los cobros que paga HOY este abono (antes de desvincularlo), para
   * `cobros_liberados`. Best-effort: null si no se pudieron leer.
   */
  private async cobrosDelAbono(
    movId: string,
    cobrosN: number,
  ): Promise<string[] | null> {
    if (cobrosN <= 0) return [];
    try {
      const partes = await partesDeAbonos(this.supabase.service, [movId]);
      return [...new Set(partes.map((p) => p.cobro_id))];
    } catch (err) {
      this.logger.warn(
        `No se pudieron leer los cobros del abono ${movId} antes de desvincularlo: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * `cobros_liberados[]` de un desvincular (D22): cada cobro que soltó el
   * abono con su estado DESPUÉS (con los OTROS abonos que le quedan:
   * PARCIAL, o SIN_CONCILIAR si no le queda ninguno). Best-effort: null si
   * no se pudo leer (la llave no viaja).
   */
  private async cobrosLiberados(
    cobroIds: ReadonlyArray<string>,
  ): Promise<CobroLiberado[] | null> {
    if (cobroIds.length === 0) return [];
    try {
      const [fichas, partes] = await Promise.all([
        this.fichasDeCobrosEnLote(cobroIds.map((id) => ({ cobro_id: id }))),
        leerPartesDeCobros(this.supabase.service, cobroIds),
      ]);
      const out: CobroLiberado[] = [];
      for (const id of cobroIds) {
        const f = fichas.get(id);
        if (!f) continue;
        const ps = partes.get(id) ?? [];
        const cob = coberturaCobro(f, ps);
        out.push({
          cobro_id: id,
          folio: f.folio,
          estado: estadoBancoCobro({
            monto: f.monto,
            metodo: f.metodo_cobro,
            via: ps.length > 0 ? 'DIRECTO' : null,
            cobertura: cob,
          }),
          faltante: cob.faltante,
          abonos_n: cob.n_partes,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el estado de los cobros liberados: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // =====================================================================
  // 1 ABONO ↔ N COBROS (12-oct-2026, API 0.0.71, invariante 56)
  // =====================================================================

  /**
   * Liga el abono con 1..N cobros por la RPC `conciliacion_ligar_abono_cobros`
   * (UNA transacción en BD: valida, escribe la puente como DIFF y recalcula
   * los espejos). Antes, en TS y con los MISMOS textos, se pre-valida para
   * responder 409 claros sin tocar nada (`puedeLigarCobros` con la cobertura
   * de los OTROS abonos de cada cobro —lector único—, la moneda y el TIPO de
   * la cuenta y el ±2 % del T.C.; 0.0.78, invariante 77: con UN cobro el
   * espejo del trigger A, en un lote cada cobro por lo que le FALTA). Sin la
   * sonda de 20261014000003 un cobro con otros abonos no admite otro: 503
   * si la regla nueva lo aceptaría (uno CUBIERTO ya salió con 409). La BD es
   * el candado real (carreras): su error se traduce con `errorRpcCobros`.
   * `corregirComision` (UN cobro, validado en `linkCobro`) escribe antes la
   * comisión real.
   */
  private async ligarCobrosPorRpc(
    movId: string,
    ids: string[],
    userId: string,
    opts: { corregirComision?: boolean; respuesta?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const sb = this.supabase.service;
    await this.bloquearSiEnReverso(movId);
    const [conIngresos, conPartes] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
    ]);
    const colsMov = `id, tipo, fecha, monto, cuenta_bancaria_id, gasto_id, cobro_grupo_id, cobros_n, clasificacion_id, notas, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)${conPartes ? ', gastos_n' : ''}${conIngresos ? ', ingreso_id' : ''}`;
    const { data: movRaw, error: movErr } = await sb
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as {
      id: string;
      tipo: string;
      fecha: string;
      monto: number | string;
      cuenta_bancaria_id: string;
      gasto_id: string | null;
      gastos_n: number | null;
      cobro_grupo_id: string | null;
      cobros_n: number | null;
      clasificacion_id?: string | null;
      clasificacion?: { nombre?: unknown } | { nombre?: unknown }[] | null;
      notas?: string | null;
      ingreso_id?: string | null;
    };
    if (mov.tipo !== (TipoMovimientoBancario.ABONO as string)) {
      throw new BadRequestException({
        message: mensajeErrorCobros('SOLO_ABONOS', null, ''),
        error: 'SOLO_ABONOS',
      });
    }
    // OMITIDO (invariante 75): 409 sin llamar la RPC.
    await this.bloquearSiOmitido(
      movId,
      mov.clasificacion_id,
      mov.notas,
      unwrapOne(mov.clasificacion ?? null)?.nombre,
    );
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    if (ligadoAGasto(mov)) {
      throw new ConflictException({
        message: mensajeMovimientoConGastos(
          Math.max(gastosLigadosN(mov), mov.gasto_id ? 1 : 0),
        ),
        error: 'MOVIMIENTO_YA_LIGADO',
        details: {
          liga: 'GASTO',
          movimiento_id: movId,
          gasto_id: mov.gasto_id,
          gastos_n: Math.max(gastosLigadosN(mov), mov.gasto_id ? 1 : 0),
        },
      });
    }
    if (mov.cobro_grupo_id) {
      throw new ConflictException({
        message:
          'Este abono ya está conciliado con el sobre de un grupo: desvincúlalo antes de ligarle cobros de vuelo.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: {
          liga: 'SOBRE',
          movimiento_id: movId,
          cobro_grupo_id: mov.cobro_grupo_id,
        },
      });
    }
    // Moneda y TIPO de la cuenta (0.0.78: también con UN cobro — la regla del
    // trigger A depende de los dos; sin moneda no se cruza de oídas).
    const cuenta = await this.infoCuenta(mov.cuenta_bancaria_id);
    if (!cuenta.moneda) throw errorCuentaSinMonedaCobros();
    const colsCobro = conIngresos
      ? 'id, vuelo_id, monto, moneda, comision_banco_monto, tc_usd_mxn, cobro_grupo_id, ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio, tc_usd_mxn)'
      : 'id, vuelo_id, monto, moneda, comision_banco_monto, tc_usd_mxn, cobro_grupo_id, vuelo:vuelo!vuelo_id(folio, tc_usd_mxn)';
    const filas = await this.leerPorLotes(ids, (lote) =>
      sb.from('cobro_vuelo').select(colsCobro).in('id', lote),
    );
    const porId = new Map(filas.map((c) => [String(c.id), c]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length > 0) {
      throw new BadRequestException({
        message: mensajeErrorCobros('COBRO_NO_EXISTE', null, ''),
        error: 'COBRO_NO_EXISTE',
        details: { cobro_ids: faltan },
      });
    }
    // Un cobro de anticipo: 409 con el folio ING-n, como en la liga simple.
    for (const id of ids) {
      const anticipo = porId.get(id)!.ingreso_anticipo_id;
      if (typeof anticipo === 'string' && anticipo) {
        throw await this.conflictoCobroDeAnticipo(anticipo);
      }
    }
    // Las partes de TODOS los abonos de cada cobro (lector único, paginado;
    // esta ruta solo corre con la puente de 20261012000002). Las de ESTE
    // abono no cuentan como «otras» (la G escribe como DIFF).
    const partesPorCobro = await leerPartesDeCobros(sb, ids);
    const cobros: CobroParaLote[] = ids.map((id) =>
      cobroParaLoteDeFila(
        porId.get(id)!,
        (partesPorCobro.get(id) ?? []).filter((p) => p.movimiento_id !== movId),
      ),
    );
    const ctx: ContextoSugeridos = {
      fecha: mov.fecha,
      cuenta_bancaria_id: mov.cuenta_bancaria_id,
      moneda: cuenta.moneda,
      tipoCuenta: cuenta.tipo,
      excluir: ids,
    };
    let corregida: ComisionCorregida | null = null;
    if (opts.corregirComision === true && cobros.length === 1) {
      // Decide con el veredicto SIN corregir (revisión del 15-oct-2026): la
      // PARTE de un sobre, un reembolso o cualquier otro rechazo responden
      // su 409/400 SIN escribir la comisión.
      corregida = await this.corregirComisionAntesDeLigar(
        cobros[0],
        partesPorCobro.get(ids[0]) ?? [],
        mov.monto,
        { moneda: cuenta.moneda, tipo: cuenta.tipo },
        userId,
        movId,
        ctx,
      );
      cobros[0].comision_banco_monto = corregida.despues;
    }
    try {
      const veredicto = puedeLigarCobros({
        montoAbono: mov.monto,
        monedaCuenta: cuenta.moneda,
        tipoCuenta: cuenta.tipo,
        toleranciaTcPct: TOLERANCIA_TC_OFICIAL_PCT,
        cobros,
      });
      if (!veredicto.ok) {
        throw await this.errorVeredictoCobros(veredicto, movId, ctx);
      }
      // Sin 20261014000003 (índice único + la G de netos) un cobro con OTROS
      // abonos no admite este: 503 claro (nada se escribe).
      if (
        cobros.some((c) => (c.otras?.length ?? 0) > 0) &&
        !(await this.cobrosParcialesOn())
      ) {
        throw errorCobrosParcialesNoDisponibles();
      }
      const { error } = await sb.rpc('conciliacion_ligar_abono_cobros', {
        p_movimiento_id: movId,
        p_cobro_ids: ids,
        p_actor: userId,
      });
      if (error) {
        throw await this.conSugeridosSiExcede(
          this.errorRpcCobros(error, movId),
          movId,
          ctx,
        );
      }
    } catch (err) {
      throw corregida ? conNotaComisionCorregida(err, corregida) : err;
    }
    const extra: Record<string, unknown> = corregida
      ? { comision_corregida: corregida }
      : {};
    if (opts.respuesta === false) return { id: movId, ...extra };
    // La liga YA quedó escrita: si la relectura falla, sin 5xx (el panel
    // recarga la bandeja; un 500 aquí invitaría a reintentar algo hecho).
    try {
      return { ...(await this.respuestaCobros(movId)), ...extra };
    } catch (err) {
      this.logger.warn(
        `Conciliación del abono ${movId}: los cobros quedaron ligados pero no se pudo releer (${err instanceof Error ? err.message : String(err)}).`,
      );
      return { id: movId, ...extra };
    }
  }

  /** Suelta TODAS las partes de cobros del abono (RPC H). */
  private async desligarCobrosPorRpc(
    movId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabase.service.rpc(
      'conciliacion_desligar_abono_cobros',
      { p_movimiento_id: movId, p_actor: userId },
    );
    if (error) throw this.errorRpcCobros(error, movId);
  }

  /** Error de la RPC/puente de cobros ⇒ 409/400/503 con `code` y texto es-MX. */
  private errorRpcCobros(
    error: {
      code?: string | null;
      message?: string | null;
      hint?: string | null;
      details?: string | null;
    },
    movId: string,
  ): Error {
    const { codigo, texto, details } = leerErrorCobros(error);
    const msg = error.message ?? '';
    if (!codigo) {
      this.logger.error(
        `Conciliación del abono ${movId}: la base respondió ${error.code ?? 'sin código'}: ${msg}`,
      );
      if (esCobrosLoteAusente(error)) return errorCobrosLoteNoDisponibles();
      return new Error(msg);
    }
    this.logger.warn(
      `Conciliación del abono ${movId}: la base rechazó la liga (${codigo}): ${msg}`,
    );
    const cuerpo = {
      message: mensajeErrorCobros(codigo, details, texto),
      error: codigo,
      details: details ?? undefined,
    };
    return codigo === 'LOTE_INVALIDO'
      ? new BadRequestException(cuerpo)
      : new ConflictException(cuerpo);
  }

  /**
   * Respuesta tras ligar cobros: la fila RELEÍDA (`movCols` + `cobros_n`) +
   * `cobros_estado[]` (cada parte con su vuelo), ADITIVOS. Con UNA parte el
   * espejo `cobro_id` viaja como siempre. Desde el 0.0.78 (invariante 77)
   * cada `cobros_estado[i]` gana el estado del COBRO con TODOS sus abonos
   * después de ligar (`cobro_estado`, `cobro_neto`, `cobro_monto_vinculado`,
   * `cobro_faltante`, `cobro_abonos_n`; best-effort: si esa lectura falla,
   * esas llaves no viajan).
   */
  private async respuestaCobros(movId: string) {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(await this.movCols())
      .eq('id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const partes = await partesDeAbonos(this.supabase.service, [movId]);
    const fichas = await this.fichasDeCobrosEnLote(partes);
    const estados = new Map<string, Record<string, unknown>>();
    if (partes.length > 0) {
      try {
        const porCobro = await leerPartesDeCobros(
          this.supabase.service,
          partes.map((p) => p.cobro_id),
        );
        for (const p of partes) {
          const f = fichas.get(p.cobro_id);
          if (!f) continue;
          const ps = porCobro.get(p.cobro_id) ?? [];
          const cob = coberturaCobro(f, ps);
          estados.set(p.cobro_id, {
            cobro_estado: estadoBancoCobro({
              monto: f.monto,
              metodo: f.metodo_cobro,
              via: ps.length > 0 ? 'DIRECTO' : null,
              cobertura: cob,
            }),
            cobro_neto: cob.neto,
            cobro_monto_vinculado: cob.monto_vinculado,
            cobro_faltante: cob.faltante,
            cobro_abonos_n: cob.n_partes,
          });
        }
      } catch (err) {
        this.logger.warn(
          `No se pudo leer el estado de los cobros del abono ${movId} tras ligarlo: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      ...((data as unknown as Record<string, unknown> | null) ?? {
        id: movId,
      }),
      cobros_estado: partes.map((p) => ({
        cobro_id: p.cobro_id,
        monto_parte: p.monto_parte,
        ...(fichas.get(p.cobro_id) ?? {}),
        ...(estados.get(p.cobro_id) ?? {}),
      })),
    };
  }

  /** Ficha corta de cada cobro (vuelo, folio, cliente, montos), por id. */
  private async fichasDeCobrosEnLote(
    partes: ReadonlyArray<Pick<ParteCobroLeida, 'cobro_id'>>,
  ): Promise<Map<string, FichaCobroEnLote>> {
    const out = new Map<string, FichaCobroEnLote>();
    const ids = [...new Set(partes.map((p) => p.cobro_id))];
    if (ids.length === 0) return out;
    const filas = await this.leerPorLotes(ids, (lote) =>
      this.supabase.service
        .from('cobro_vuelo')
        .select(
          'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
        )
        .in('id', lote),
    );
    for (const c of filas) {
      const vuelo = unwrapOne(
        c.vuelo as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(vuelo?.cliente);
      const comision = Number(c.comision_banco_monto) || 0;
      out.set(String(c.id), {
        vuelo_id: typeof c.vuelo_id === 'string' ? c.vuelo_id : null,
        folio: vuelo?.folio == null ? null : Number(vuelo.folio),
        cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
        fecha_cobro: typeof c.fecha_cobro === 'string' ? c.fecha_cobro : null,
        monto: r2(Number(c.monto) || 0),
        moneda: typeof c.moneda === 'string' ? c.moneda : null,
        metodo_cobro:
          typeof c.metodo_cobro === 'string' ? c.metodo_cobro : null,
        comision_banco_monto: comision > 0 ? r2(comision) : null,
        neto: netoDeCobro(c.monto as number, c.comision_banco_monto as number),
      });
    }
    return out;
  }

  /**
   * Lector de la bandeja (GET movimientos) para los abonos con COBROS
   * (12-oct-2026, invariante 56; UN COBRO, VARIOS ABONOS desde el 0.0.78,
   * invariante 77 —antes `anotarCobrosLote`—). Dos fases best-effort:
   * 1) a cada ABONO con 2+ partes de la página le pega `cobros[]` (cada
   *    parte con vuelo, folio, cliente, montos), `cobros_suma` y
   *    `cobros_diferencia` (= |monto| − Σ partes), como siempre; si una
   *    lectura falla no se anota NADA (el panel dice «detalle no
   *    disponible»);
   * 2) el ESTADO de cada cobro con TODOS sus abonos (UNA lectura de la
   *    puente, paginada, de los cobros tocados): en un lote, cada `cobros[i]`
   *    gana `cobro_estado`, `cobro_neto`, `cobro_faltante`, `cobro_abonos_n`;
   *    un abono con UN cobro gana `cobro_conciliacion` {cobro_id, folio,
   *    estado, neto, monto_vinculado, faltante, sobrante, abonos_n,
   *    faltante_sin_este (lo que faltaría sin ESTE abono), abonos[]}. Si
   *    falla, no se anota el estado (warn) y lo de la fase 1 se queda.
   */
  private async anotarCobrosDeAbonos(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    const conCobros = filas.filter((m) => Number(m.cobros_n) >= 1);
    if (conCobros.length === 0) return;
    const conLote = conCobros.filter((m) => Number(m.cobros_n) >= 2);
    const unicos = conCobros.filter(
      (m) =>
        Number(m.cobros_n) === 1 &&
        typeof m.cobro_id === 'string' &&
        m.cobro_id.length > 0,
    );
    let partesLote: ParteCobroLeida[] = [];
    let fichas = new Map<string, FichaCobroEnLote>();
    try {
      partesLote =
        conLote.length > 0
          ? await partesDeAbonos(
              this.supabase.service,
              conLote.map((m) => m.id as string),
            )
          : [];
      fichas = await this.fichasDeCobrosEnLote([
        ...partesLote,
        ...unicos.map((m) => ({ cobro_id: m.cobro_id as string })),
      ]);
      const porMov = new Map<string, ParteCobroLeida[]>();
      for (const p of partesLote) {
        const l = porMov.get(p.movimiento_id) ?? [];
        l.push(p);
        porMov.set(p.movimiento_id, l);
      }
      for (const m of conLote) {
        const ps = porMov.get(m.id as string) ?? [];
        m.cobros = ps.map((p) => ({
          cobro_id: p.cobro_id,
          monto_parte: p.monto_parte,
          ...(fichas.get(p.cobro_id) ?? {}),
        }));
        m.cobros_suma =
          ps.length > 0
            ? r2(ps.reduce((acc, p) => acc + p.monto_parte, 0))
            : null;
        m.cobros_diferencia = diferenciaLoteCobros(Number(m.monto) || 0, ps);
      }
    } catch (err) {
      this.logger.warn(
        `No se pudieron leer los cobros de cada abono (lote): ${err instanceof Error ? err.message : String(err)}`,
      );
      for (const m of conLote) {
        delete m.cobros;
        delete m.cobros_suma;
        delete m.cobros_diferencia;
      }
      return;
    }
    // (2) Estado de cada cobro con TODOS sus abonos.
    try {
      const cobroIds = [
        ...new Set([
          ...partesLote.map((p) => p.cobro_id),
          ...unicos.map((m) => m.cobro_id as string),
        ]),
      ];
      const partesPorCobro = await leerPartesDeCobros(
        this.supabase.service,
        cobroIds,
      );
      const estadoDe = (cobroId: string, movId: string) => {
        const ficha = fichas.get(cobroId);
        if (!ficha) return null;
        const partes = partesPorCobro.get(cobroId) ?? [];
        const cob = coberturaCobro(ficha, partes);
        const estado: EstadoBancoCobro = estadoBancoCobro({
          monto: ficha.monto,
          metodo: ficha.metodo_cobro,
          via: partes.length > 0 ? 'DIRECTO' : null,
          cobertura: cob,
        });
        return {
          ficha,
          partes,
          cob,
          estado,
          faltanteSinEste: faltanteFueraDe(ficha, partes, movId).faltante,
        };
      };
      // Todo se calcula ANTES de escribir: si algo truena, nada queda a medias.
      const anotLote = conLote.map((m) =>
        ((m.cobros ?? []) as Array<Record<string, unknown>>).map((item) => {
          const e = estadoDe(item.cobro_id as string, m.id as string);
          return e
            ? {
                ...item,
                cobro_estado: e.estado,
                cobro_neto: e.cob.neto,
                cobro_faltante: e.cob.faltante,
                cobro_abonos_n: e.cob.n_partes,
              }
            : item;
        }),
      );
      const anotUnicos = unicos.map((m) => {
        const e = estadoDe(m.cobro_id as string, m.id as string);
        return e
          ? {
              cobro_id: m.cobro_id as string,
              folio: e.ficha.folio,
              estado: e.estado,
              neto: e.cob.neto,
              monto_vinculado: e.cob.monto_vinculado,
              faltante: e.cob.faltante,
              sobrante: e.cob.sobrante,
              abonos_n: e.cob.n_partes,
              faltante_sin_este: e.faltanteSinEste,
              abonos: e.partes.map((p) => ({
                movimiento_id: p.movimiento_id,
                fecha: p.fecha,
                monto_parte: p.monto_parte,
              })),
            }
          : null;
      });
      conLote.forEach((m, i) => {
        m.cobros = anotLote[i];
      });
      unicos.forEach((m, i) => {
        if (anotUnicos[i]) m.cobro_conciliacion = anotUnicos[i];
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el estado de los cobros de cada abono: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 409 `COBRO_DE_ANTICIPO` al CONCILIAR (24-sep-2026): el cobro salió de un
   * anticipo y su dinero se concilia UNA vez, contra el anticipo.
   */
  private async conflictoCobroDeAnticipo(
    anticipoId: string,
  ): Promise<ConflictException> {
    let folio: number | null = null;
    try {
      const { data } = await this.supabase.service
        .from('ingreso')
        .select('folio')
        .eq('id', anticipoId)
        .maybeSingle();
      const f = (data as { folio?: unknown } | null)?.folio;
      folio = f == null ? null : Number(f);
    } catch {
      folio = null;
    }
    const etiqueta = etiquetaIngreso(folio);
    return new ConflictException({
      message: `Este cobro salió del anticipo ${etiqueta}: concilia el abono contra el anticipo, en Ingresos → Por conciliar.`,
      error: 'COBRO_DE_ANTICIPO',
      details: { ingreso_id: anticipoId, etiqueta },
    });
  }

  /** Partes (cobro_vuelo) por sobre: cuántos aviones recibieron parte. */
  private async contarPartesPorSobre(
    sobreIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(sobreIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select('cobro_grupo_id')
      .in('cobro_grupo_id', ids)
      .limit(10000);
    if (error) throw new Error(error.message);
    for (const p of data ?? []) {
      const sid = p.cobro_grupo_id as string;
      out.set(sid, (out.get(sid) ?? 0) + 1);
    }
    return out;
  }

  /** Fila cruda de cobro_grupo (+ grupo embebido) → forma pública SOBRE_GRUPO. */
  private normalizarSobre(
    raw: Record<string, unknown>,
    avionesN: number,
  ): SobreConciliacion {
    const grupo = unwrapOne(
      raw.grupo as { folio?: unknown; nombre?: unknown } | null,
    );
    const monto = Number(raw.monto) || 0;
    const comision = Number(raw.comision_banco_monto) || 0;
    const metodo = (raw.metodo_cobro as string) ?? '';
    const fecha = (raw.fecha_cobro as string) ?? '';
    return {
      tipo: 'SOBRE_GRUPO',
      cobro_grupo_id: raw.id as string,
      grupo_id: raw.grupo_id as string,
      grupo_folio: grupo?.folio == null ? null : Number(grupo.folio),
      grupo_nombre: typeof grupo?.nombre === 'string' ? grupo.nombre : null,
      monto: r2(monto),
      moneda: (raw.moneda as string) ?? 'USD',
      metodo,
      metodo_cobro: metodo,
      fecha,
      fecha_cobro: fecha,
      referencia: (raw.referencia as string | null) ?? null,
      comision_banco_monto: comision > 0 ? r2(comision) : null,
      neto: r2(monto - (comision > 0 ? comision : 0)),
      aviones_n: avionesN,
    };
  }

  /**
   * Movimientos con el embed `cobro_grupo` (SOBRE_EMBED) → cada fila gana
   * `cobro_grupo: SobreConciliacion | null` (aditivo; `cobro` y `gasto`
   * siguen igual).
   */
  private async normalizarSobresEnMovs(
    movs: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const crudos = new Map<string, Record<string, unknown>>();
    for (const m of movs) {
      const raw = unwrapOne<Record<string, unknown>>(
        m.cobro_grupo as Record<string, unknown> | null,
      );
      if (raw && typeof raw.id === 'string') crudos.set(raw.id, raw);
    }
    if (crudos.size === 0) {
      return movs.map((m) => ({ ...m, cobro_grupo: null }));
    }
    const partes = await this.contarPartesPorSobre([...crudos.keys()]);
    return movs.map((m) => {
      const raw = unwrapOne<Record<string, unknown>>(
        m.cobro_grupo as Record<string, unknown> | null,
      );
      return {
        ...m,
        cobro_grupo:
          raw && typeof raw.id === 'string'
            ? this.normalizarSobre(raw, partes.get(raw.id) ?? 0)
            : null,
      };
    });
  }

  /**
   * Cobros de vuelo candidatos de un ABONO: el UNIVERSO de «Vincular» (y de
   * los sugeridos de un 409 ABONO_EXCEDE_COBRO, D4): positivos, sin sobre ni
   * anticipo, métodos que llegan al banco, en ±días, en la moneda de la
   * cuenta (si se conoce); tope 300 por fecha.
   */
  private consultaCobrosDeAbono(
    lo: string,
    hi: string,
    moneda: string | null,
    conIngresos: boolean,
  ) {
    let qc = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, tc_usd_mxn, vuelo:vuelo!vuelo_id(folio, fecha_vuelo, tc_usd_mxn, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(300);
    if (conIngresos) qc = qc.is('ingreso_anticipo_id', null);
    if (moneda) qc = qc.eq('moneda', moneda);
    return qc;
  }

  /**
   * Candidatos para conciliar un ABONO a mano: cobros de vuelo Y sobres de
   * grupo (misma moneda que la cuenta, métodos que llegan al banco, sin
   * conciliar con OTRO movimiento) en ±`dias`, ordenados por cercanía del
   * NETO al monto del abono y luego por fecha. Las PARTES de un sobre nunca
   * se ofrecen (se concilia el sobre, que es lo que depositó el cliente).
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): con la sonda de
   * 20261014000003 «ocupado» = CUBIERTO por OTROS abonos (o ligado a uno en
   * otra moneda); un cobro PARCIAL sigue siendo candidato con sus aditivos y
   * su `dif_monto` contra lo que le FALTA (el ★ «cuadra exacto» del panel
   * sigue sirviendo). Un abono de la PASARELA no recibe parciales. Sin la
   * sonda, «tiene liga» = ocupado, como siempre.
   */
  async candidatosCobro(
    movId: string,
    dias: number = CANDIDATOS_DIAS_DEFAULT,
  ): Promise<{
    movimiento: {
      id: string;
      fecha: string;
      monto: number;
      tipo: string;
      moneda: string | null;
      cobro_id: string | null;
      cobro_grupo_id: string | null;
      /** ADITIVOS (12-oct-2026, con la puente). */
      cobros_n?: number;
      cobro_ids?: string[];
      /**
       * ADITIVOS (0.0.78, invariante 77): ¿un cobro ya acepta varios abonos
       * (sonda de 20261014000003)?, el tipo de la cuenta del abono y la
       * capacidad de «Corregir la comisión y vincular» (`corregir_comision`
       * en el PATCH; un API previo no la tiene y respondería 400).
       */
      cobros_parciales?: boolean;
      tipo_cuenta?: string | null;
      corregir_comision?: true;
    };
    candidatos: CandidatoCobro[];
    exactos: number;
    /** ADITIVO (24-sep-2026, solo con la migración de ingresos). */
    ingresos?: CandidatoIngresoAbono[];
  }> {
    // 1 abono ↔ N cobros (12-oct-2026): `cobros_n` y los cobros que YA paga
    // (para que el panel los marque al editar el lote), con la sonda.
    const conCobrosLote = await this.cobrosLoteOn();
    const colsMovCand: string = `id, fecha, monto, tipo, cuenta_bancaria_id, cobro_id, cobro_grupo_id${conCobrosLote ? ', cobros_n' : ''}`;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMovCand)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as {
      id: string;
      fecha: string;
      monto: number | string;
      tipo: string;
      cuenta_bancaria_id: string;
      cobro_id: string | null;
      cobro_grupo_id: string | null;
      cobros_n?: number | null;
    };
    if (mov.tipo !== (TipoMovimientoBancario.ABONO as string)) {
      throw new BadRequestException(
        'Solo un ABONO (entrada de dinero) se concilia contra cobros de vuelo o sobres de grupo.',
      );
    }
    // Moneda y TIPO de la cuenta en la MISMA lectura de siempre (el tipo
    // decide si el abono recibe cobros parciales: la pasarela no).
    const cuentaAbono = await this.infoCuenta(mov.cuenta_bancaria_id);
    const moneda = cuentaAbono.moneda;
    const { lo, hi } = this.ventanaAbono(mov.fecha, dias);
    // INGRESOS (24-sep-2026): los cobros nacidos de un anticipo NUNCA son
    // candidatos (su dinero se concilia como anticipo) y los ingresos
    // registrados se ofrecen aparte (`ingresos`). Sin la migración: lo de
    // siempre.
    const conIngresos = await this.ingresosOn();

    const qc = this.consultaCobrosDeAbono(lo, hi, moneda, conIngresos);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, fecha_vuelo, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(100);
    if (moneda) qs = qs.eq('moneda', moneda);
    const [cobrosRes, sobresRes] = await Promise.all([qc, qs]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (sobresRes.error) throw new Error(sobresRes.error.message);
    const cobros = (cobrosRes.data ?? []) as Array<Record<string, unknown>>;
    const sobres = (sobresRes.data ?? []) as Array<Record<string, unknown>>;

    // Ya conciliados con OTRO movimiento (fuente única: lector de ligas =
    // puente de cobros + espejo). Los que YA paga ESTE abono siguen siendo
    // candidatos (el panel los marca al editar el lote). Con la sonda de
    // 20261014000003 (invariante 77) un cobro con OTROS abonos solo está
    // ocupado si ya lo CUBREN (o uno es de otra moneda: 1↔1); si no, es
    // PARCIAL y entra por lo que le falta (salvo que este abono sea de la
    // PASARELA: un cobro de la pasarela es «de un solo abono»).
    const conParciales = conCobrosLote && (await this.cobrosParcialesOn());
    const pasarela = cuentaAbono.tipo === 'PASARELA';
    const ocupadosCobro = new Set<string>();
    const ocupadosSobre = new Set<string>();
    let partesPorCobro = new Map<string, ParteCobroBanco[]>();
    {
      const ligas = await leerLigasDeCobros(this.supabase.service, {
        cobroIds: cobros.map((c) => c.id as string),
        sobreIds: sobres.map((s) => s.id as string),
        conPuente: conCobrosLote,
      });
      partesPorCobro = partesDeLigas(ligas);
      for (const m of ligas) {
        if (m.id === movId) continue;
        if (typeof m.cobro_grupo_id === 'string')
          ocupadosSobre.add(m.cobro_grupo_id);
      }
      // La MISMA regla que los sugeridos del 409 (`cobroOcupadoParaAbono`).
      for (const c of cobros) {
        const id = c.id as string;
        if (
          cobroOcupadoParaAbono(c, partesPorCobro.get(id) ?? [], movId, {
            conParciales,
            pasarela,
          })
        ) {
          ocupadosCobro.add(id);
        }
      }
    }
    const yaLigados: string[] =
      conCobrosLote && Number(mov.cobros_n) > 0
        ? (await partesDeAbonos(this.supabase.service, [movId])).map(
            (p) => p.cobro_id,
          )
        : [];
    const partesN = await this.contarPartesPorSobre(
      sobres.map((s) => s.id as string),
    );

    const montoMov = Number(mov.monto) || 0;
    const refMs = Date.parse(`${mov.fecha}T00:00:00Z`);
    const todos: CandidatoCobro[] = [
      ...cobros
        .filter((c) => !ocupadosCobro.has(c.id as string))
        .map((c): CandidatoCobroVuelo => {
          const vuelo = unwrapOne(
            c.vuelo as {
              folio?: unknown;
              fecha_vuelo?: unknown;
              tc_usd_mxn?: unknown;
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(vuelo?.cliente);
          const bruto = Number(c.monto) || 0;
          const comision = Number(c.comision_banco_monto) || 0;
          const neto = netoDeCobro(bruto, comision);
          // Lo que le falta FUERA de este abono (invariante 77): sin otros
          // abonos es el neto (lo de siempre).
          const f = faltanteFueraDe(
            c,
            partesPorCobro.get(c.id as string) ?? [],
            movId,
          );
          const parcial = f.n_otras > 0;
          return {
            tipo: 'COBRO_VUELO',
            id: c.id as string,
            cobro_id: c.id as string,
            vuelo_id: c.vuelo_id as string,
            folio: vuelo?.folio == null ? null : Number(vuelo.folio),
            fecha_vuelo: fechaVueloDe(vuelo?.fecha_vuelo),
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            fecha_cobro: c.fecha_cobro as string,
            monto: r2(bruto),
            moneda: c.moneda as string,
            metodo_cobro: c.metodo_cobro as string,
            referencia: (c.referencia as string | null) ?? null,
            comision_banco_monto: comision > 0 ? r2(comision) : null,
            neto,
            dif_monto: r2(Math.abs((parcial ? f.faltante : neto) - montoMov)),
            parcial,
            monto_vinculado: f.suma_otras,
            faltante: f.faltante,
            abonos_n: f.n_otras,
            abonos: f.otras.slice(0, 5).map((p) => ({
              movimiento_id: p.movimiento_id,
              fecha: p.fecha,
              monto_parte: p.monto_parte,
            })),
            // Qué pasaría al vincular ESTE abono a este cobro (el espejo del
            // trigger A + el ±2 % del T.C.; D18). Los sugeridos de un EXCEDE
            // se agregan abajo, con el universo completo.
            al_vincular: alVincularAbono({
              cobro: c,
              tcVuelo: normalizarTc(vuelo?.tc_usd_mxn ?? null),
              otras: f.otras,
              abono: { monto: montoMov, moneda_cuenta: moneda, pasarela },
              toleranciaTcPct: TOLERANCIA_TC_OFICIAL_PCT,
            }),
          };
        }),
      ...sobres
        .filter((s) => !ocupadosSobre.has(s.id as string))
        .map((s): CandidatoSobreGrupo => {
          const norm = this.normalizarSobre(
            s,
            partesN.get(s.id as string) ?? 0,
          );
          const grupo = unwrapOne(
            s.grupo as {
              fecha_vuelo?: unknown;
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(grupo?.cliente);
          const regla = alVincularSobre({
            montoAbono: montoMov,
            monedaCuenta: moneda,
            tipoCuenta: cuentaAbono.tipo,
            sobre: s,
          });
          return {
            ...norm,
            id: norm.cobro_grupo_id,
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            dif_monto: r2(Math.abs(norm.neto - montoMov)),
            fecha_vuelo: fechaVueloDe(grupo?.fecha_vuelo),
            al_vincular: { estado: regla.estado, diferencia: regla.diferencia },
          };
        }),
    ].sort(
      (a, b) =>
        a.dif_monto - b.dif_monto ||
        Math.abs(Date.parse(a.fecha_cobro) - refMs) -
          Math.abs(Date.parse(b.fecha_cobro) - refMs),
    );
    // SUGERIDOS de un EXCEDE (D4): del universo completo (los cobros libres
    // ANTES del tope), los que les falta ≈ lo que sobra; si alguno no entró
    // en los primeros CANDIDATOS_MAX, va al final para que el panel lo marque.
    const cobrosLibres = todos.filter(
      (c): c is CandidatoCobroVuelo => c.tipo === 'COBRO_VUELO',
    );
    const universo = cobrosLibres.map(sugeridoDeCandidato);
    for (const c of cobrosLibres) {
      if (c.al_vincular?.estado !== 'EXCEDE') continue;
      c.al_vincular.sugeridos = sugeridosParaExcedente(
        universo,
        c.al_vincular.sobrante,
        mov.fecha,
        [c.id],
      );
    }
    const top = todos.slice(0, CANDIDATOS_MAX);
    const enLista = new Set(top.map((c) => `${c.tipo}:${c.id}`));
    const porId = new Map(cobrosLibres.map((c) => [c.id, c]));
    const sugeridosFuera: CandidatoCobroVuelo[] = [];
    for (const c of top) {
      if (c.tipo !== 'COBRO_VUELO') continue;
      for (const s of c.al_vincular?.sugeridos ?? []) {
        const k = `COBRO_VUELO:${s.cobro_id}`;
        const cand = porId.get(s.cobro_id);
        if (enLista.has(k) || !cand) continue;
        enLista.add(k);
        sugeridosFuera.push(cand);
      }
    }
    const candidatos: CandidatoCobro[] = [...top, ...sugeridosFuera];
    const salida = {
      movimiento: {
        id: mov.id,
        fecha: mov.fecha,
        monto: r2(montoMov),
        tipo: mov.tipo,
        moneda,
        cobro_id: mov.cobro_id ?? null,
        cobro_grupo_id: mov.cobro_grupo_id ?? null,
        // ADITIVOS (12-oct-2026): cuántos cobros paga ya y cuáles.
        ...(conCobrosLote
          ? {
              cobros_n: Number(mov.cobros_n) || 0,
              cobro_ids: yaLigados,
            }
          : {}),
        // ADITIVOS (0.0.78, invariante 77): capacidad de varios abonos por
        // cobro, tipo de la cuenta (la pasarela no recibe parciales) y
        // «Corregir la comisión y vincular» (`corregir_comision` del PATCH).
        cobros_parciales: conParciales,
        tipo_cuenta: cuentaAbono.tipo,
        corregir_comision: true as const,
      },
      candidatos,
      exactos: candidatos.filter((c) => c.dif_monto === 0).length,
    };
    if (!conIngresos) return salida;
    return {
      ...salida,
      ingresos: await this.ingresosCandidatosDeAbono(
        movId,
        mov.cuenta_bancaria_id,
        mov.fecha,
        montoMov,
        moneda,
        dias,
      ),
    };
  }

  /**
   * Ingresos candidatos para conciliar un ABONO a mano (24-sep-2026): vivos,
   * con cuenta, sin movimiento, en la moneda de la cuenta del abono y con
   * fecha en ±`dias`. Los de OTRA cuenta viajan con `otra_cuenta` (el panel
   * los deshabilita: «corrige la cuenta del ingreso»). Orden: diferencia de
   * monto y cercanía de fecha; tope 30.
   */
  private async ingresosCandidatosDeAbono(
    movId: string,
    cuentaId: string,
    fecha: string,
    montoMov: number,
    moneda: string | null,
    dias: number,
  ): Promise<CandidatoIngresoAbono[]> {
    if (!moneda) return [];
    const [{ data: extra }, info] = await Promise.all([
      this.supabase.service
        .from('movimiento_bancario')
        .select('monto_bruto')
        .eq('id', movId)
        .maybeSingle(),
      this.infoCuenta(cuentaId),
    ]);
    const montoBruto =
      (extra as { monto_bruto?: unknown } | null)?.monto_bruto == null
        ? null
        : Number((extra as { monto_bruto?: unknown }).monto_bruto);
    const pasarela = info.tipo === TIPO_CUENTA_PASARELA;
    const { desde, hasta } = ventanaDias(fecha, dias);
    const [{ data, error }, cuentasRes] = await Promise.all([
      this.supabase.service
        .from('ingreso')
        .select(INGRESO_CANDIDATO_COLS)
        .is('deleted_at', null)
        .not('cuenta_bancaria_id', 'is', null)
        .eq('moneda', moneda)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .order('fecha', { ascending: true })
        .limit(300),
      this.supabase.service.from('cuenta_bancaria').select('id, alias'),
    ]);
    if (error) throw new Error(error.message);
    const filas = ((data ?? []) as Array<Record<string, unknown>>).map((f) =>
      this.aIngresoCandidato(f),
    );
    const ocupados = await this.ingresosConMovimiento(filas.map((f) => f.id));
    const alias = new Map(
      ((cuentasRes.data ?? []) as Array<{ id: string; alias: string }>).map(
        (c) => [c.id, c.alias],
      ),
    );
    const refMs = Date.parse(`${fecha}T00:00:00Z`);
    return filas
      .filter((f) => !ocupados.has(f.id) && f.cuenta_bancaria_id)
      .map((f): CandidatoIngresoAbono => {
        const neto = netoIngreso(f.monto, f.comision_monto);
        let dif = r2(Math.abs(neto - montoMov));
        if (pasarela && montoBruto != null) {
          dif = Math.min(dif, r2(Math.abs(f.monto - montoBruto)));
        }
        const categoria = esCategoriaIngreso(f.categoria)
          ? f.categoria
          : 'OTRO_INGRESO';
        return {
          tipo: 'INGRESO',
          id: f.id,
          etiqueta: etiquetaIngreso(f.folio),
          categoria,
          categoria_etiqueta: etiquetaCategoriaIngreso(f.categoria),
          es_anticipo: esAnticipo(f.categoria),
          fecha: f.fecha,
          monto: f.monto,
          comision_monto: f.comision_monto,
          neto,
          moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
          cliente: f.cliente,
          descripcion: f.descripcion,
          cuenta_bancaria_id: f.cuenta_bancaria_id as string,
          cuenta_alias: alias.get(f.cuenta_bancaria_id as string) ?? null,
          otra_cuenta: f.cuenta_bancaria_id !== cuentaId,
          dif_monto: dif,
        };
      })
      .sort(
        (a, b) =>
          a.dif_monto - b.dif_monto ||
          Math.abs(Date.parse(`${a.fecha}T00:00:00Z`) - refMs) -
            Math.abs(Date.parse(`${b.fecha}T00:00:00Z`) - refMs),
      )
      .slice(0, 30);
  }

  // =====================================================================
  // PAYWISE (9-sep-2026): universo de cobros por método, cruce y auditoría
  // =====================================================================

  /**
   * Cobros del sistema (cobro_vuelo positivos que NO son parte de sobre +
   * sobres cobro_grupo) con método en `metodos` y fecha_cobro en [lo, hi]
   * (ISO con offset Cancún), normalizados a la forma pura del cruce.
   */
  private async cargarCobrosPorMetodo(
    metodos: readonly string[],
    lo: string,
    hi: string,
    moneda?: string | null,
    // ANTICIPOS (24-sep-2026, solo con la migración de ingresos): EXCLUIR
    // (default: auto-cruce Paywise, auditoría, candidatos — un cobro de
    // anticipo nunca es candidato de un abono) o INCLUIR (SOLO
    // `cobrosSinBanco`, que decide con su anticipo). Sin la migración no se
    // filtra nada: la columna no existe y no hay anticipos.
    opts: { anticipos: 'EXCLUIR' | 'INCLUIR' } = { anticipos: 'EXCLUIR' },
  ): Promise<CobroCargado[]> {
    const conIngresos = await this.ingresosOn();
    const incluir = conIngresos && opts.anticipos === 'INCLUIR';
    const colsCobro: string = incluir
      ? 'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio, fecha_vuelo, cliente:cliente_id(nombre))'
      : 'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, fecha_vuelo, cliente:cliente_id(nombre))';
    let qc = this.supabase.service
      .from('cobro_vuelo')
      .select(colsCobro)
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', [...metodos])
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(2000);
    if (conIngresos && opts.anticipos === 'EXCLUIR') {
      qc = qc.is('ingreso_anticipo_id', null);
    }
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, fecha_vuelo, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', [...metodos])
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(500);
    if (moneda) {
      qc = qc.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const [cobrosRes, sobresRes] = await Promise.all([qc, qs]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (sobresRes.error) throw new Error(sobresRes.error.message);
    const out: CobroCargado[] = [];
    for (const c of (cobrosRes.data ?? []) as unknown as Array<
      Record<string, unknown>
    >) {
      const vuelo = unwrapOne(
        c.vuelo as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(vuelo?.cliente);
      out.push({
        tipo: 'COBRO_VUELO',
        id: c.id as string,
        fecha_cobro: c.fecha_cobro as string,
        monto: r2(Number(c.monto) || 0),
        moneda: (c.moneda as string) ?? 'USD',
        metodo_cobro: (c.metodo_cobro as string | null) ?? null,
        comision_banco_monto:
          Number(c.comision_banco_monto) > 0
            ? r2(Number(c.comision_banco_monto))
            : null,
        referencia: (c.referencia as string | null) ?? null,
        vuelo_id: c.vuelo_id as string,
        folio: vuelo?.folio == null ? null : Number(vuelo.folio),
        grupo_id: null,
        grupo_folio: null,
        cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
        ...(incluir
          ? {
              ingreso_anticipo_id:
                typeof c.ingreso_anticipo_id === 'string'
                  ? c.ingreso_anticipo_id
                  : null,
            }
          : {}),
      });
    }
    for (const s of (sobresRes.data ?? []) as Array<Record<string, unknown>>) {
      const grupo = unwrapOne(
        s.grupo as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(grupo?.cliente);
      out.push({
        tipo: 'SOBRE_GRUPO',
        id: s.id as string,
        fecha_cobro: s.fecha_cobro as string,
        monto: r2(Number(s.monto) || 0),
        moneda: (s.moneda as string) ?? 'USD',
        metodo_cobro: (s.metodo_cobro as string | null) ?? null,
        comision_banco_monto:
          Number(s.comision_banco_monto) > 0
            ? r2(Number(s.comision_banco_monto))
            : null,
        referencia: (s.referencia as string | null) ?? null,
        vuelo_id: null,
        folio: null,
        grupo_id: s.grupo_id as string,
        grupo_folio: grupo?.folio == null ? null : Number(grupo.folio),
        cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
      });
    }
    return out;
  }

  /**
   * Ligas banco↔cobro de estos cobros/sobres (fuente única MOV_LIGA_COLS):
   * mapa cobro (`${tipo}:${id}`) → id del movimiento que lo concilia.
   * «Cualquier liga = ocupado»: lo usan el cruce y la auditoría de Paywise
   * (un cobro de la pasarela es «de un solo abono», invariante 77).
   */
  private async ligasDeCobros(
    cobros: ReadonlyArray<CobroPaywise>,
  ): Promise<Map<string, string>> {
    return this.mapaDeLigasCobros(await this.leerLigasDeCobrosCargados(cobros));
  }

  /** Las ligas crudas (lector único) de estos cobros/sobres. */
  private async leerLigasDeCobrosCargados(
    cobros: ReadonlyArray<CobroPaywise>,
  ): Promise<MovimientoLiga[]> {
    // Puente de cobros + espejo (12-oct-2026): un cobro de un lote también
    // está ligado.
    return leerLigasDeCobros(this.supabase.service, {
      cobroIds: cobros.filter((c) => c.tipo === 'COBRO_VUELO').map((c) => c.id),
      sobreIds: cobros.filter((c) => c.tipo === 'SOBRE_GRUPO').map((c) => c.id),
      conPuente: await this.cobrosLoteOn(),
    });
  }

  /** Ligas ⇒ mapa `${tipo}:${id}` → movimiento. */
  private mapaDeLigasCobros(
    ligas: ReadonlyArray<MovimientoLiga>,
  ): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of ligas) {
      if (typeof m.cobro_id === 'string')
        out.set(`COBRO_VUELO:${m.cobro_id}`, m.id as string);
      if (typeof m.cobro_grupo_id === 'string')
        out.set(`SOBRE_GRUPO:${m.cobro_grupo_id}`, m.id as string);
    }
    return out;
  }

  /**
   * Auto-cruce de UN abono de una cuenta PASARELA (Paywise) recién
   * importado: cobros PAYWISE libres a ±5 días de la MISMA moneda, cotejo
   * NETO → BRUTO (fuente única cruzarPaywise). Liga solo si cuadra el
   * dinero; misma referencia con montos distintos NO se liga sola.
   */
  private async autoMatchAbonoPasarela(
    mov: MovimientoPaywise,
    userId: string,
    cuentaId?: string,
  ): Promise<ResultadoMovimiento> {
    const base = {
      movimiento_id: mov.id,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };
    const { lo, hi } = this.ventanaAbono(mov.fecha, PAYWISE_VENTANA_DIAS);
    const cobros = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_PASARELA,
      lo,
      hi,
      mov.moneda,
    );
    const ligas = await this.ligasDeCobros(cobros);
    const libres = cobros.filter((c) => !ligas.has(`${c.tipo}:${c.id}`));
    const r = cruzarPaywise([mov], libres, { dias: PAYWISE_VENTANA_DIAS });
    const cruce = r.coinciden[0];
    if (!cruce) {
      const ambiguos = r.ambiguos?.length ?? 0;
      // INGRESOS (24-sep-2026): sin cobro Paywise que cuadre (y SIN
      // ambigüedad), se prueban los ingresos registrados en ESTA cuenta con
      // la decisión única de abonos (pasarela: neto o bruto). El cruce
      // Paywise de siempre no cambia; NO se amplía aquí a cobros por
      // transferencia (decisión del cliente 14.13).
      if (ambiguos === 0 && cuentaId) {
        const porIngreso = await this.autoMatchAbonoIngresoPasarela(
          mov,
          cuentaId,
          userId,
        );
        if (porIngreso) return porIngreso;
      }
      return {
        ...base,
        resultado: ambiguos > 0 ? 'AMBIGUO' : 'SIN_CANDIDATO',
        candidatos_n: ambiguos,
        motivo:
          ambiguos > 0
            ? `${ambiguos} cobros Paywise cuadran con este depósito: revísalo en la auditoría Paywise.`
            : 'Ningún cobro Paywise libre cuadra con este depósito (neto/bruto/referencia).',
      };
    }
    // La comisión REAL del archivo se escribe ANTES de ligar; un fallo aquí
    // tampoco puede tumbar la importación (se cuenta y se sigue).
    try {
      await this.aplicarCrucePaywise(cruce, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`auto-match Paywise ${mov.id}: ${msg}`);
      return {
        ...base,
        resultado: err instanceof ConflictException ? 'RECHAZADO' : 'ERROR',
        candidatos_n: 1,
        motivo: msg,
      };
    }
    return {
      ...base,
      resultado: 'CONCILIADO',
      criterio: 'MONTO_EXACTO',
      candidatos_n: 1,
      cobro_id: cruce.cobro.tipo === 'COBRO_VUELO' ? cruce.cobro.id : null,
      cobro_grupo_id:
        cruce.cobro.tipo === 'SOBRE_GRUPO' ? cruce.cobro.id : null,
    };
  }

  /**
   * Ingresos de la cuenta PASARELA que cuadran con un abono sin cobro Paywise
   * (±5 días). null = no hay ingresos que probar (se responde lo de
   * siempre); si hay, el resultado del cruce por ingreso.
   */
  private async autoMatchAbonoIngresoPasarela(
    mov: MovimientoPaywise,
    cuentaId: string,
    userId: string,
  ): Promise<ResultadoMovimiento | null> {
    if (!(await this.ingresosOn()) || !mov.moneda) return null;
    const { desde, hasta } = ventanaDias(mov.fecha, PAYWISE_VENTANA_DIAS);
    const { data, error } = await this.supabase.service
      .from('ingreso')
      .select(INGRESO_CANDIDATO_COLS)
      .is('deleted_at', null)
      .eq('cuenta_bancaria_id', cuentaId)
      .eq('moneda', mov.moneda)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .limit(50);
    if (error) {
      this.logger.warn(
        `auto-match Paywise ${mov.id}: ingresos: ${error.message}`,
      );
      return null;
    }
    const filas = ((data ?? []) as Array<Record<string, unknown>>).map((f) =>
      this.aIngresoCandidato(f),
    );
    if (filas.length === 0) return null;
    const ocupados = await this.ingresosConMovimiento(filas.map((f) => f.id));
    const abono: AbonoCruce = {
      monto: mov.monto,
      monto_bruto: mov.monto_bruto ?? null,
      descripcion: mov.descripcion ?? null,
      cuenta_bancaria_id: cuentaId,
    };
    const eleccion = elegirCandidatoAbono(
      abono,
      filas
        .filter((f) => !ocupados.has(f.id))
        .map((f) => ({
          tipo: 'INGRESO' as const,
          id: f.id,
          monto: f.monto,
          comision: f.comision_monto,
          fecha: f.fecha,
          cliente: f.cliente,
          cuenta_bancaria_id: f.cuenta_bancaria_id,
        })),
      true,
    );
    const base = {
      movimiento_id: mov.id,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
    };
    if (eleccion.motivo === 'SIN_CANDIDATOS') return null;
    if (!eleccion.elegido) {
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: `${eleccion.candidatos_n} ingresos registrados cuadran con este depósito: vincúlalo a mano.`,
      };
    }
    // El cruce de pasarela solo mira cobros PAYWISE: un SPEI directo a la
    // CLABE de la pasarela (caso real #235, cobro por TRANSFERENCIA) no
    // compite arriba. Si un cobro libre cuadra exacto, NO se liga al ingreso
    // (anti doble conteo): la persona decide.
    const exactos = await this.cobrosExactosLibresDeAbono(
      abono,
      mov.fecha,
      mov.moneda,
      true,
    );
    if (exactos !== 0) {
      return {
        ...base,
        resultado: exactos == null ? 'ERROR' : 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n + (exactos ?? 0),
        motivo:
          exactos == null
            ? 'No se pudo verificar si un cobro de vuelo cuadra con este depósito: no se liga al ingreso.'
            : 'El depósito cuadra con un ingreso registrado y también con un cobro de vuelo: vincúlalo a mano (si es el pago del vuelo, contaría dos veces).',
      };
    }
    const r = await this.ligarIngresoAuto(mov.id, eleccion.elegido.id, userId);
    if (r.ok) {
      return {
        ...base,
        resultado: 'CONCILIADO',
        criterio: eleccion.criterio ?? 'MONTO_EXACTO',
        candidatos_n: eleccion.candidatos_n,
        ingreso_id: eleccion.elegido.id,
      };
    }
    return {
      ...base,
      resultado: r.rechazado ? 'RECHAZADO' : 'ERROR',
      candidatos_n: eleccion.candidatos_n,
      motivo: r.motivo,
    };
  }

  /**
   * Aplica un cruce: escribe en el cobro de vuelo la comisión REAL (si
   * difiere — mismo espíritu que `tc_gasto` al ligar gastos; ANTES de ligar,
   * porque un cobro conciliado ya no se toca) y liga el movimiento
   * (`linkCobro`, con sus candados). Un SOBRE no se reescribe (su comisión se
   * parte entre los hijos): solo se liga y se reporta. La comisión real es la
   * del archivo o, por criterio BRUTO sin datos del archivo, la inferida =
   * bruto del cobro − abono (`comisionRealDeCruce`; 0.0.78, D6: el cobro de
   * la pasarela se concilia con UN abono = su neto ± $1.00 y sin la
   * inferencia el auto-cruce rebotaría con COMISION_NO_CUADRA). La escribe
   * `escribirComisionReal` (la misma de «Corregir la comisión y vincular»)
   * SOLO si con ella el abono cuadra (`comisionAEscribirEnCruce`, revisión
   * del 15-oct-2026): si no, NO se escribe y se liga con la vigente (la
   * diferencia queda en la auditoría, `comision_distinta`); si tampoco
   * cuadra, `linkCobro` rechaza SIN que nada se haya escrito.
   */
  private async aplicarCrucePaywise(
    cruce: CrucePaywise,
    userId: string,
  ): Promise<void> {
    const { cobro, movimiento } = cruce;
    const comision = comisionAEscribirEnCruce(cruce);
    const origen =
      cruce.comision_paywise != null ? 'del archivo' : 'inferida por BRUTO';
    if (comision.escribir != null) {
      await this.escribirComisionReal(
        cobro.id,
        cobro.monto,
        comision.escribir,
        userId,
      );
      this.logger.log(
        `Paywise: comisión real ${comision.escribir} escrita en cobro ${cobro.id} (antes ${cruce.comision_sistema}; ${origen}).`,
      );
    } else if (comision.descartada != null) {
      this.logger.warn(
        `Paywise: la comisión ${comision.descartada} (${origen}) NO se escribe en el cobro ${cobro.id}: con ella el depósito de ${movimiento.monto} no cuadraría. Se liga con la comisión del sistema (${cruce.comision_sistema}); la diferencia queda en la auditoría Paywise.`,
      );
    }
    await this.linkCobro(
      movimiento.id,
      cobro.tipo === 'COBRO_VUELO'
        ? { cobro_id: cobro.id }
        : { cobro_grupo_id: cobro.id },
      userId,
      { respuesta: false },
    );
  }

  /** Cuentas PASARELA (o la indicada, validando que lo sea). */
  private async cuentasPasarela(cuentaId?: string) {
    let q = this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda, tipo');
    q = cuentaId ? q.eq('id', cuentaId) : q.eq('tipo', TIPO_CUENTA_PASARELA);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const cuentas = (data ?? []) as Array<{
      id: string;
      alias: string;
      banco: string;
      moneda: string;
      tipo: string;
    }>;
    if (cuentaId && cuentas.length === 0)
      throw new NotFoundException(`Cuenta ${cuentaId} not found`);
    if (cuentaId && cuentas[0].tipo !== TIPO_CUENTA_PASARELA) {
      throw new BadRequestException(
        `La cuenta «${cuentas[0].alias}» no es de tipo PASARELA (Paywise).`,
      );
    }
    if (cuentas.length === 0) {
      throw new BadRequestException(
        'No hay ninguna cuenta de tipo PASARELA (Paywise): dala de alta en Cuentas bancarias con tipo PASARELA e importa ahí el estado de cuenta de Paywise.',
      );
    }
    return cuentas;
  }

  /** Suma días a un YYYY-MM-DD (UTC, sin hora). */
  private sumarDias(fecha: string, dias: number): string {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Universo de la auditoría: ABONOS de las cuentas PASARELA en el periodo
   * + cobros PAYWISE del sistema en [desde − días, hasta + días] (cortes
   * Cancún). Los cobros ligados a un movimiento FUERA del universo se
   * excluyen (ya conciliaron en otro periodo) y se cuentan aparte.
   */
  private async universoPaywise(q: PaywiseAuditoriaQuery) {
    const cuentas = await this.cuentasPasarela(q.cuenta_bancaria_id);
    const monedaPorCuenta = new Map(cuentas.map((c) => [c.id, c.moneda]));
    const conIngresos = await this.ingresosOn();
    const { data: movsTodos, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(await this.movCols())
      .in(
        'cuenta_bancaria_id',
        cuentas.map((c) => c.id),
      )
      .eq('tipo', TipoMovimientoBancario.ABONO)
      .gte('fecha', q.desde)
      .lte('fecha', q.hasta)
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    // Un abono conciliado con un INGRESO (SPEI directo a la CLABE de la
    // pasarela, anticipo, reembolso…) no es de la pasarela: fuera de la
    // auditoría, contado aparte (aditivo `movimientos_con_ingreso`).
    const movsLeidos = (movsTodos ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    const movsSinIngreso = conIngresos
      ? movsLeidos.filter(
          (m) => !(typeof m.ingreso_id === 'string' && m.ingreso_id),
        )
      : movsLeidos;
    const movimientosConIngreso = movsLeidos.length - movsSinIngreso.length;
    // OMITIDOS (0.0.77, invariante 75): un abono omitido no es de la
    // auditoría (ni «Conciliar los que cuadran» lo toca); contado aparte. Si
    // no se puede leer la canónica, no se filtra y el conteo va null.
    const omitidoPw = await this.leerIdClasificacionOmitido();
    const movsRaw = omitidoPw.id
      ? movsSinIngreso.filter((m) => m.clasificacion_id !== omitidoPw.id)
      : movsSinIngreso;
    const movimientosOmitidos = omitidoPw.fallo
      ? null
      : movsSinIngreso.length - movsRaw.length;
    // UN COBRO, VARIOS ABONOS (0.0.78, D6): un abono que paga 2+ cobros
    // (lote) NO es «libre» aunque su espejo `cobro_id` sea NULL: fuera del
    // cruce, contado aparte (aditivo `movimientos_en_lote`). Sin la puente
    // no hay lotes (`cobros_n` no viaja ⇒ 0).
    const movsSinLote = movsRaw.filter((m) => !(Number(m.cobros_n) >= 2));
    const movimientosEnLote = movsRaw.length - movsSinLote.length;
    const movimientos: MovimientoPaywise[] = movsSinLote.map((m) => ({
      id: m.id as string,
      fecha: m.fecha as string,
      monto: r2(Number(m.monto) || 0),
      monto_bruto: m.monto_bruto == null ? null : r2(Number(m.monto_bruto)),
      comision_monto:
        m.comision_monto == null ? null : r2(Number(m.comision_monto)),
      referencia: (m.referencia as string | null) ?? null,
      descripcion: (m.descripcion as string | null) ?? null,
      moneda: monedaPorCuenta.get(m.cuenta_bancaria_id as string) ?? null,
      cobro_id: (m.cobro_id as string | null) ?? null,
      cobro_grupo_id: (m.cobro_grupo_id as string | null) ?? null,
    }));
    const lo = `${this.sumarDias(q.desde, -q.dias)}T00:00:00-05:00`;
    const hi = `${this.sumarDias(q.hasta, q.dias)}T23:59:59-05:00`;
    const todos = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_PASARELA,
      lo,
      hi,
    );
    const ligas = await this.ligasDeCobros(todos);
    const movIds = new Set(movimientos.map((m) => m.id));
    let cobrosConciliadosFuera = 0;
    const cobros = todos.filter((c) => {
      const movId = ligas.get(`${c.tipo}:${c.id}`);
      if (movId && !movIds.has(movId)) {
        cobrosConciliadosFuera += 1;
        return false;
      }
      return true;
    });
    return {
      cuentas,
      movimientos,
      cobros,
      cobrosConciliadosFuera,
      movimientosConIngreso: conIngresos ? movimientosConIngreso : null,
      movimientosOmitidos,
      movimientosEnLote,
    };
  }

  private armarSalidaAuditoria(
    q: PaywiseAuditoriaQuery,
    cuentas: Array<{ id: string; alias: string; moneda: string }>,
    movimientos: MovimientoPaywise[],
    cobros: CobroPaywise[],
    cobrosConciliadosFuera: number,
    r: ResultadoCrucePaywise,
    extra: {
      conciliados_ahora?: number;
      errores?: unknown[];
      movimientos_con_ingreso?: number | null;
      movimientos_omitidos?: number | null;
      movimientos_en_lote?: number | null;
    } = {},
  ) {
    const ya = r.coinciden.filter((c) => c.criterio === 'YA_CONCILIADO');
    const suma = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      dias: q.dias,
      cuentas: cuentas.map((c) => ({
        id: c.id,
        alias: c.alias,
        moneda: c.moneda,
      })),
      resumen: {
        movimientos_paywise: movimientos.length,
        cobros_sistema: cobros.length,
        coinciden: r.coinciden.length,
        ya_conciliados: ya.length,
        conciliables: r.coinciden.length - ya.length,
        comision_distinta: r.comision_distinta.length,
        referencia_monto_distinto: r.referencia_monto_distinto.length,
        solo_paywise: r.solo_paywise.length,
        solo_sistema: r.solo_sistema.length,
        ambiguos: r.ambiguos.length,
        movimientos_conciliados_fuera: r.ya_conciliados_fuera,
        cobros_conciliados_fuera: cobrosConciliadosFuera,
        // Dinero (moneda nativa de la pasarela: MXN).
        neto_paywise: suma(movimientos.map((m) => m.monto)),
        neto_solo_paywise: suma(r.solo_paywise.map((m) => m.monto)),
        bruto_solo_sistema: suma(r.solo_sistema.map((c) => c.monto)),
        dif_comision_total: suma(
          r.comision_distinta.map((c) => c.dif_comision ?? 0),
        ),
        conciliados_ahora: extra.conciliados_ahora ?? 0,
        errores: (extra.errores ?? []).length,
        // ADITIVO (24-sep-2026, solo con la migración de ingresos).
        ...(extra.movimientos_con_ingreso != null
          ? { movimientos_con_ingreso: extra.movimientos_con_ingreso }
          : {}),
        // ADITIVO (0.0.77, invariante 75): abonos omitidos fuera del
        // universo (null = no se pudo leer la canónica).
        ...('movimientos_omitidos' in extra
          ? { movimientos_omitidos: extra.movimientos_omitidos ?? null }
          : {}),
        // ADITIVO (0.0.78, invariante 77): abonos de la pasarela que pagan
        // 2+ cobros (lote), fuera del cruce.
        ...('movimientos_en_lote' in extra
          ? { movimientos_en_lote: extra.movimientos_en_lote ?? 0 }
          : {}),
      },
      coinciden: r.coinciden,
      comision_distinta: r.comision_distinta,
      referencia_monto_distinto: r.referencia_monto_distinto,
      solo_paywise: r.solo_paywise,
      solo_sistema: r.solo_sistema,
      ambiguos: r.ambiguos,
      errores: extra.errores ?? [],
    };
  }

  /**
   * GET /conciliacion/paywise/auditoria — SOLO LECTURA. Cruza los abonos
   * importados de Paywise contra los cobros PAYWISE (fecha ±días, NETO →
   * BRUTO → referencia) y devuelve: coinciden (con diferencia de comisión),
   * en Paywise sin cobro, cobros sin Paywise, referencia con monto distinto
   * y ambiguos.
   */
  /**
   * INICIO OFICIAL (invariante 86): el periodo de la auditoría Paywise (y de
   * su «conciliar» y su Excel) sube al inicio; uno anterior ⇒ 400
   * `PERIODO_ANTES_DEL_INICIO`.
   */
  private async periodoPaywise(
    q: PaywiseAuditoriaQuery,
  ): Promise<PaywiseAuditoriaQuery> {
    if (q.desde > q.hasta)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    const p = exigirPeriodoDesdeInicio(
      q.desde,
      q.hasta,
      await inicioOficialDe(this.configuracion),
    );
    return p.desde === q.desde ? q : { ...q, desde: p.desde };
  }

  async auditoriaPaywise(qPedido: PaywiseAuditoriaQuery) {
    const q = await this.periodoPaywise(qPedido);
    const u = await this.universoPaywise(q);
    const r = cruzarPaywise(u.movimientos, u.cobros, { dias: q.dias });
    return this.armarSalidaAuditoria(
      q,
      u.cuentas,
      u.movimientos,
      u.cobros,
      u.cobrosConciliadosFuera,
      r,
      {
        movimientos_con_ingreso: u.movimientosConIngreso,
        movimientos_omitidos: u.movimientosOmitidos,
        movimientos_en_lote: u.movimientosEnLote,
      },
    );
  }

  /**
   * POST /conciliacion/paywise/auditoria/conciliar — liga automáticamente
   * los cruces que CUADRAN (NETO/BRUTO), escribiendo la comisión real en los
   * cobros de vuelo, y devuelve la auditoría recalculada. Cada liga es
   * independiente: un fallo (carrera, cobro ya ligado) se reporta en
   * `errores` sin tumbar el resto.
   */
  async conciliarPaywise(qPedido: PaywiseAuditoriaQuery, userId: string) {
    const q = await this.periodoPaywise(qPedido);
    const u = await this.universoPaywise(q);
    const r = cruzarPaywise(u.movimientos, u.cobros, { dias: q.dias });
    let conciliados = 0;
    const errores: Array<{
      movimiento_id: string;
      cobro_id: string;
      tipo: string;
      error: string;
    }> = [];
    for (const cruce of r.coinciden) {
      if (cruce.criterio === 'YA_CONCILIADO') continue;
      try {
        await this.aplicarCrucePaywise(cruce, userId);
        conciliados += 1;
      } catch (err) {
        errores.push({
          movimiento_id: cruce.movimiento.id,
          cobro_id: cruce.cobro.id,
          tipo: cruce.cobro.tipo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const u2 = await this.universoPaywise(q);
    const r2x = cruzarPaywise(u2.movimientos, u2.cobros, { dias: q.dias });
    return this.armarSalidaAuditoria(
      q,
      u2.cuentas,
      u2.movimientos,
      u2.cobros,
      u2.cobrosConciliadosFuera,
      r2x,
      {
        conciliados_ahora: conciliados,
        errores,
        movimientos_con_ingreso: u2.movimientosConIngreso,
        movimientos_omitidos: u2.movimientosOmitidos,
        movimientos_en_lote: u2.movimientosEnLote,
      },
    );
  }

  /**
   * GET /conciliacion/paywise/auditoria.xlsx — 3 hojas: «Cotejo» (todo lo
   * cruzado con bruto/comisión/neto sistema vs Paywise y la diferencia en
   * naranja), «Paywise sin cobro» y «Cobros sin Paywise».
   */
  async auditoriaPaywiseXlsx(
    qPedido: PaywiseAuditoriaQuery,
  ): Promise<{ buffer: Buffer; etiqueta: string; desde: string }> {
    // Periodo con piso (invariante 86) también en los subtítulos.
    const q = await this.periodoPaywise(qPedido);
    const a = await this.auditoriaPaywise(q);
    const quien = (c: CobroPaywise) =>
      c.tipo === 'SOBRE_GRUPO'
        ? `Grupo G-${c.grupo_folio ?? '?'}`
        : `Vuelo #${c.folio ?? '?'}`;
    const criterioLabel: Record<string, string> = {
      YA_CONCILIADO: 'Ya conciliado',
      NETO: 'Neto exacto',
      BRUTO: 'Bruto exacto',
      REFERENCIA: 'Referencia (monto distinto)',
    };
    // Cotejo: coinciden + referencia con monto distinto + ambiguos.
    const cotejoFilas: (string | number | null)[][] = [];
    const cotejoResaltes: { fila: number; col: number }[] = [];
    const filaCruce = (c: CrucePaywise, estatus: string) => {
      const i = cotejoFilas.length;
      cotejoFilas.push([
        c.movimiento.fecha,
        c.movimiento.referencia ?? '',
        quien(c.cobro),
        c.cobro.cliente ?? '',
        diaCancun(c.cobro.fecha_cobro),
        c.cobro.monto,
        c.movimiento.monto_bruto ?? null,
        c.comision_sistema,
        c.comision_paywise,
        c.neto_sistema,
        c.movimiento.monto,
        c.dif_comision,
        criterioLabel[c.criterio] ?? c.criterio,
        estatus,
      ]);
      if (c.comision_distinta) {
        cotejoResaltes.push({ fila: i, col: 11 });
        cotejoResaltes.push({ fila: i, col: 8 });
      }
      if (c.criterio === 'REFERENCIA') {
        cotejoResaltes.push({ fila: i, col: 10 });
        cotejoResaltes.push({ fila: i, col: 13 });
      }
    };
    for (const c of a.coinciden) {
      filaCruce(
        c,
        c.criterio === 'YA_CONCILIADO'
          ? c.comision_distinta
            ? 'Conciliado · comisión distinta'
            : 'Conciliado'
          : c.comision_distinta
            ? 'Cuadra · comisión distinta'
            : 'Cuadra',
      );
    }
    for (const c of a.referencia_monto_distinto) {
      filaCruce(c, 'REVISAR: misma referencia, monto distinto');
    }
    for (const amb of a.ambiguos) {
      const i = cotejoFilas.length;
      cotejoFilas.push([
        amb.movimiento.fecha,
        amb.movimiento.referencia ?? '',
        amb.candidatos.map(quien).join(' / '),
        '',
        '',
        null,
        amb.movimiento.monto_bruto ?? null,
        null,
        amb.movimiento.comision_monto ?? null,
        null,
        amb.movimiento.monto,
        null,
        criterioLabel[amb.criterio] ?? amb.criterio,
        `AMBIGUO: ${amb.candidatos.length} cobros iguales — concilia a mano`,
      ]);
      cotejoResaltes.push({ fila: i, col: 13 });
    }
    const money = (label: string) => ({ label, tipo: 'money' as const });
    const texto = (label: string) => ({ label, tipo: 'texto' as const });
    const moneda = a.cuentas[0]?.moneda ?? 'MXN';
    const sinCobroFilas = a.solo_paywise.map((m) => [
      m.fecha,
      m.referencia ?? '',
      m.descripcion ?? '',
      m.monto_bruto ?? null,
      m.comision_monto ?? null,
      m.monto,
    ]);
    const sinPaywiseFilas = a.solo_sistema.map((c) => [
      diaCancun(c.fecha_cobro),
      quien(c),
      c.cliente ?? '',
      c.referencia ?? '',
      c.monto,
      c.comision_banco_monto ?? 0,
      r2(c.monto - (c.comision_banco_monto ?? 0)),
      c.moneda,
    ]);
    const s = a.resumen;
    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: 'Auditoría Paywise',
      subtitulo: `${q.desde} a ${q.hasta}`,
      columnas: [texto('Resumen')],
      filas: [],
      hojas: [
        {
          titulo: 'Cotejo',
          subtitulo: `${s.movimientos_paywise} abonos Paywise · ${s.cobros_sistema} cobros Paywise en el sistema · ${s.coinciden} coinciden (${s.ya_conciliados} ya conciliados) · ${s.comision_distinta} con comisión distinta · ${s.referencia_monto_distinto} referencia/monto · ${s.ambiguos} ambiguos · ±${q.dias} días · ${q.desde} a ${q.hasta}`,
          columnas: [
            texto('Fecha Paywise'),
            texto('Referencia'),
            texto('Vuelo / Grupo'),
            texto('Cliente'),
            texto('Fecha cobro'),
            money(`Bruto sistema (${moneda})`),
            money('Bruto Paywise'),
            money('Comisión sistema'),
            money('Comisión Paywise'),
            money('Neto sistema'),
            money('Neto Paywise (abono)'),
            money('Dif. comisión'),
            texto('Criterio'),
            texto('Estatus'),
          ],
          filas: cotejoFilas,
          resaltes: cotejoResaltes,
          totales: [
            'Totales',
            null,
            null,
            null,
            null,
            r2(a.coinciden.reduce((x, c) => x + c.cobro.monto, 0)),
            r2(
              a.coinciden.reduce(
                (x, c) => x + (c.movimiento.monto_bruto ?? 0),
                0,
              ),
            ),
            r2(a.coinciden.reduce((x, c) => x + c.comision_sistema, 0)),
            r2(a.coinciden.reduce((x, c) => x + (c.comision_paywise ?? 0), 0)),
            r2(a.coinciden.reduce((x, c) => x + c.neto_sistema, 0)),
            r2(a.coinciden.reduce((x, c) => x + c.movimiento.monto, 0)),
            s.dif_comision_total,
            null,
            null,
          ],
        },
        {
          titulo: 'Paywise sin cobro',
          subtitulo: `${s.solo_paywise} abonos de Paywise sin cobro registrado en el sistema (neto ${s.neto_solo_paywise} ${moneda}) · ${q.desde} a ${q.hasta}`,
          columnas: [
            texto('Fecha'),
            texto('Referencia'),
            texto('Descripción'),
            money('Bruto'),
            money('Comisión'),
            money(`Neto (${moneda})`),
          ],
          filas: sinCobroFilas,
          resaltes: sinCobroFilas.map((_, i) => ({ fila: i, col: 5 })),
          totales: [
            'Totales',
            null,
            null,
            r2(a.solo_paywise.reduce((x, m) => x + (m.monto_bruto ?? 0), 0)),
            r2(a.solo_paywise.reduce((x, m) => x + (m.comision_monto ?? 0), 0)),
            s.neto_solo_paywise,
          ],
        },
        {
          titulo: 'Cobros sin Paywise',
          subtitulo: `${s.solo_sistema} cobros con método Paywise sin abono en el estado de cuenta (bruto ${s.bruto_solo_sistema}) · cobros de ${this.sumarDias(q.desde, -q.dias)} a ${this.sumarDias(q.hasta, q.dias)}`,
          columnas: [
            texto('Fecha cobro'),
            texto('Vuelo / Grupo'),
            texto('Cliente'),
            texto('Referencia'),
            money('Bruto'),
            money('Comisión registrada'),
            money('Neto esperado'),
            texto('Moneda'),
          ],
          filas: sinPaywiseFilas,
          resaltes: sinPaywiseFilas.map((_, i) => ({ fila: i, col: 4 })),
          totales: [
            'Totales',
            null,
            null,
            null,
            s.bruto_solo_sistema,
            r2(
              a.solo_sistema.reduce(
                (x, c) => x + (c.comision_banco_monto ?? 0),
                0,
              ),
            ),
            r2(
              a.solo_sistema.reduce(
                (x, c) => x + c.monto - (c.comision_banco_monto ?? 0),
                0,
              ),
            ),
            null,
          ],
        },
      ],
    });
    return { buffer, etiqueta: 'paywise', desde: q.desde };
  }

  /**
   * GET /conciliacion/cobros-sin-banco — el espejo de `gastosSinBanco` para
   * los COBROS (9-sep-2026): cobros de vuelo (no partes de sobre) y sobres
   * con método bancario (transferencia / HSBC link / cheque / Paywise) sin
   * liga con ningún abono importado. Lo usa el pre-cierre como aviso.
   * Default: últimos 90 días por fecha_cobro (cortes Cancún).
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): el universo son los
   * cobros NO CUBIERTOS: sin liga (como hoy) o con abonos directos que no lo
   * completan (PARCIAL; la cobertura sale de las MISMAS ligas que ya lee el
   * lector único, sin otra consulta; si la lectura falla, se lanza). Cada
   * fila gana `parcial`, `monto_vinculado`, `faltante` (sin abonos = neto),
   * `abonos_n` y `abonos[]`; la raíz, `parciales`; `por_moneda[i]`, la Σ de
   * `faltante` (`monto` sigue siendo Σ bruto). No depende de la migración
   * 20261014000003 (sale de la puente de 20261012000002 o del espejo).
   */
  async cobrosSinBanco(desde?: string, hasta?: string) {
    // Defaults en día CANCÚN (no UTC): a las 20:00 de Cancún el UTC ya es
    // mañana y el corte se corría un día.
    const dPedido =
      desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    const h = hasta ?? hoyCancun();
    if (dPedido > h)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    // INICIO OFICIAL (invariante 86): eje `fecha_cobro` con piso (los 9
    // cobros del 31-ago de vuelos de septiembre salen; decisión del
    // contrato). Rango entero antes ⇒ lista vacía, nunca 400.
    const d = await this.pisoDesde(dPedido);
    // ANTICIPOS (24-sep-2026, regla 1.3): un cobro nacido de un anticipo
    // sale aquí MIENTRAS su anticipo NO esté conciliado (un anticipo
    // tecleado a mano y jamás visto en el banco no esconde sus cobros del
    // aviso del pre-cierre), marcado «del anticipo ING-n»; en cuanto el
    // anticipo se liga a su abono, desaparece. Sin la migración: lo de
    // siempre.
    const conIngresos = await this.ingresosOn();
    const cobros = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_ABONO_AUTO,
      `${d}T00:00:00-05:00`,
      `${h}T23:59:59-05:00`,
      undefined,
      { anticipos: 'INCLUIR' },
    );
    const ligasLeidas = await this.leerLigasDeCobrosCargados(cobros);
    const ligas = this.mapaDeLigasCobros(ligasLeidas);
    const partesPorCobro = partesDeLigas(ligasLeidas);
    /** Cobertura de un COBRO de vuelo con abonos directos (null = sin abonos directos). */
    const coberturaDe = (c: (typeof cobros)[number]) => {
      if (c.tipo !== 'COBRO_VUELO') return null;
      const partes = partesPorCobro.get(c.id) ?? [];
      return partes.length > 0
        ? { partes, cob: coberturaCobro(c, partes) }
        : null;
    };
    const anticipoIds = [
      ...new Set(
        cobros
          .map((c) => c.ingreso_anticipo_id)
          .filter((x): x is string => typeof x === 'string' && !!x),
      ),
    ];
    const anticiposConciliados =
      conIngresos && anticipoIds.length > 0
        ? await this.ingresosConMovimiento(anticipoIds)
        : new Map<string, string>();
    const folioAnticipo = new Map<string, number>();
    if (conIngresos && anticipoIds.length > 0) {
      const folios = await this.leerPorLotes(anticipoIds, (lote) =>
        this.supabase.service
          .from('ingreso')
          .select('id, folio')
          .in('id', lote),
      );
      for (const f of folios)
        folioAnticipo.set(f.id as string, Number(f.folio));
    }
    const libres = cobros.filter((c) => {
      if (ligas.has(`${c.tipo}:${c.id}`)) {
        // Ligado: solo sigue aquí si es un cobro PARCIAL (sus abonos directos
        // no lo cubren). Un sobre ligado está conciliado (1 ↔ 1).
        const banco = coberturaDe(c);
        return banco !== null && !banco.cob.cubierto;
      }
      const ant = c.ingreso_anticipo_id;
      return !(typeof ant === 'string' && ant && anticiposConciliados.has(ant));
    });
    const porMoneda = new Map<string, { monto: number; faltante: number }>();
    let parciales = 0;
    const data = libres.map((c) => {
      const neto = netoDeCobro(c.monto, c.comision_banco_monto);
      const banco = coberturaDe(c);
      const parcial = banco !== null && !banco.cob.cubierto;
      if (parcial) parciales += 1;
      const faltante = banco ? banco.cob.faltante : neto;
      const acum = porMoneda.get(c.moneda) ?? { monto: 0, faltante: 0 };
      acum.monto += c.monto;
      acum.faltante += faltante;
      porMoneda.set(c.moneda, acum);
      const { ingreso_anticipo_id: ant, ...resto } = c;
      const fila = {
        ...resto,
        metodo_label: etiquetaMetodoCobro(c.metodo_cobro),
        neto,
        // ADITIVOS (0.0.78, invariante 77).
        parcial,
        monto_vinculado: banco ? banco.cob.monto_vinculado : 0,
        faltante,
        abonos_n: banco ? banco.cob.n_partes : 0,
        abonos: (banco ? banco.partes : []).map((p) => ({
          movimiento_id: p.movimiento_id,
          fecha: p.fecha,
          monto_parte: p.monto_parte,
        })),
      };
      if (!conIngresos) return fila;
      return {
        ...fila,
        anticipo:
          typeof ant === 'string' && ant
            ? {
                ingreso_id: ant,
                etiqueta: etiquetaIngreso(folioAnticipo.get(ant) ?? null),
              }
            : null,
      };
    });
    return {
      data,
      total: data.length,
      desde: d,
      hasta: h,
      por_moneda: [...porMoneda.entries()].map(([moneda, x]) => ({
        moneda,
        monto: r2(x.monto),
        // ADITIVO (0.0.78): Σ de lo que FALTA (los sin abonos, su neto).
        faltante: r2(x.faltante),
      })),
      // ADITIVO (0.0.78): cuántos de `total` son cobros PARCIALES.
      parciales,
    };
  }

  /**
   * Catálogo de clasificaciones "sin vuelo" (activas, orden alfabético).
   * SIN la canónica «Omitido de la conciliación» (14-oct-2026, invariante
   * 75): omitir exige motivo firmado y se hace con «Omitir la conciliación».
   */
  async listClasificaciones() {
    const { data, error } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .select('id, nombre, activo')
      .eq('activo', true)
      .order('nombre', { ascending: true });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ nombre?: unknown }>).filter(
      (c) =>
        !esClasificacionOmitida(typeof c.nombre === 'string' ? c.nombre : null),
    );
  }

  /**
   * Crea una clasificación (o devuelve la existente si el nombre ya está,
   * sin distinguir mayúsculas): el diálogo del panel crea "en el mismo
   * espacio" y no debe fallar por un duplicado de dedo.
   */
  async crearClasificacion(nombre: string, userId: string) {
    const limpio = nombre.trim().replace(/\s+/g, ' ');
    if (limpio.length < 2) {
      throw new BadRequestException(
        'El nombre de la clasificación es muy corto.',
      );
    }
    // La canónica (invariante 75) no se crea a mano: la crea la RPC de
    // omitir, con su motivo firmado.
    if (esClasificacionOmitida(limpio)) {
      throw new BadRequestException({
        message: MENSAJE_USA_OMITIR,
        error: 'USA_OMITIR',
      });
    }
    const { data: existente, error: exErr } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .select('id, nombre, activo')
      .ilike('nombre', limpio)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (existente) return existente;
    const { data, error } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .insert({ nombre: limpio, created_by: userId })
      .select('id, nombre, activo')
      .maybeSingle();
    if (error) {
      // Carrera con el índice único lower(nombre): devuelve la ganadora.
      if (error.code === '23505') {
        const { data: otra } = await this.supabase.service
          .from('conciliacion_clasificacion')
          .select('id, nombre, activo')
          .ilike('nombre', limpio)
          .maybeSingle();
        if (otra) return otra;
      }
      throw new Error(error.message);
    }
    return data!;
  }

  /**
   * Concilia un movimiento por CLASIFICACIÓN (no corresponde a ningún
   * gasto/cobro de vuelo: comisión del banco, impuestos, personal…), con
   * notas opcionales. clasificacion_id null la quita y el movimiento vuelve
   * a Pendiente. Excluyente con gasto/cobro vinculado.
   */
  async clasificarMovimiento(
    movId: string,
    clasificacionId: string | null,
    notas: string | undefined,
    userId: string,
    // ENDURECIDO (14-oct-2026, invariante 75): `esperado` = la clasificación
    // que el panel VIO (presente = !== undefined; null = «estaba pendiente»).
    opts: { esperado?: string | null; usuarioNombre?: string | null } = {},
  ) {
    // (0) La canónica «Omitido de la conciliación» NO se pone por aquí:
    // omitir exige motivo firmado (400 USA_OMITIR antes de leer nada más).
    const idOmitido = await this.idClasificacionOmitido();
    if (
      clasificacionId &&
      idOmitido &&
      normalizarUuid(clasificacionId) === idOmitido
    ) {
      throw new BadRequestException({
        message: MENSAJE_USA_OMITIR,
        error: 'USA_OMITIR',
      });
    }
    // (1) Lo VIGENTE del movimiento (clasificación, conciliado, notas y,
    // con sus sondas, ingreso / gastos_n / cobros_n).
    const [conIngresosCl, conPartesCl, conCobrosCl] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
      this.cobrosLoteOn(),
    ]);
    const colsMov = `id, gasto_id, cobro_id, cobro_grupo_id, clasificacion_id, conciliado, notas, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)${conIngresosCl ? ', ingreso_id' : ''}${conPartesCl ? ', gastos_n' : ''}${conCobrosCl ? ', cobros_n' : ''}`;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as Record<string, unknown>;
    const clasifActual =
      typeof mov.clasificacion_id === 'string' && mov.clasificacion_id
        ? mov.clasificacion_id
        : null;
    const conciliadoActual = mov.conciliado === true;
    // (2) Lo que el panel vio ya no es lo vigente (otro lo vinculó, lo
    // clasificó o lo omitió) ⇒ 409 ANTES de la rama del reverso: con un par
    // emparejado NO se desempareja a ciegas.
    if (opts.esperado !== undefined) {
      const esperado =
        opts.esperado === null ? null : normalizarUuid(opts.esperado);
      const cambio =
        esperado === null
          ? clasifActual !== null || conciliadoActual
          : clasifActual !== esperado;
      if (cambio) throw this.conflictoMovimientoCambio(mov);
    }
    // (3) REVERSOS (30-sep-2026): un movimiento emparejado como cargo
    // devuelto / devolución. «Quitar clasificación» (null) en CUALQUIERA de
    // los dos deja AMBOS pendientes; cambiarle la clasificación rompería el
    // par en silencio ⇒ 409 (se quita primero); la MISMA clasificación
    // (editar notas) sí se permite.
    const par = await this.parDeReverso(movId);
    if (par) {
      if (clasificacionId === null) {
        const r = await this.desemparejarReverso(movId, userId);
        const propio = par.rol === 'ABONO' ? r.abono : r.cargo;
        return {
          ...(propio ?? { id: movId }),
          desemparejado_con: par.rol === 'ABONO' ? par.cargo_id : par.abono_id,
        } as Record<string, unknown>;
      }
      const actual = await this.leerMovReverso(movId);
      if (clasificacionId !== actual.clasificacion_id) {
        throw this.conflictoEnReverso(par);
      }
    }
    // (4) OMITIDO (invariante 75): «Quitar clasificación» = deshacer la
    // omisión por la RPC (quita su línea de las notas); cualquier otra
    // clasificación ⇒ 409 MOVIMIENTO_OMITIDO. Por el id de la canónica O por
    // el NOMBRE embebido en la misma lectura (revisión del 14-oct-2026: sin
    // depender del memo ni de otra consulta que pueda fallar).
    const nombreActual = unwrapOne(
      (mov.clasificacion as
        | { nombre?: unknown }
        | { nombre?: unknown }[]
        | null
        | undefined) ?? null,
    )?.nombre;
    if (
      clasifActual &&
      ((idOmitido && clasifActual === idOmitido) ||
        esClasificacionOmitida(
          typeof nombreActual === 'string' ? nombreActual : null,
        ))
    ) {
      if (clasificacionId === null) {
        const r = await this.quitarOmision([movId], userId);
        return r.movimientos[0] ?? { id: movId, omision: null };
      }
      throw this.conflictoMovimientoOmitido(movId, mov.notas);
    }
    // Ligado a gasto(s) = `gasto_id` (espejo) o `gastos_n > 0` (lote).
    const conGasto = ligadoAGasto(mov);
    // Conciliado con un INGRESO: ni se clasifica ni se «des-clasifica» por
    // aquí (24-sep-2026): el camino es PATCH movimientos/:id/ingreso.
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    // (5) Un lote de COBROS (`cobros_n > 0`, 12-oct-2026) cuenta como un
    // cobro: no se clasifica encima.
    if (
      clasificacionId &&
      (conGasto ||
        mov.cobro_id ||
        mov.cobro_grupo_id ||
        Number(mov.cobros_n) > 0)
    ) {
      throw new ConflictException(
        'El movimiento ya está conciliado con un gasto/cobro: desvincúlalo antes de clasificarlo.',
      );
    }
    if (clasificacionId) {
      const { data: clasif, error: clErr } = await this.supabase.service
        .from('conciliacion_clasificacion')
        .select('id, nombre')
        .eq('id', clasificacionId)
        .maybeSingle();
      if (clErr) throw new Error(clErr.message);
      if (!clasif)
        throw new BadRequestException('Clasificación no encontrada.');
      // La canónica por NOMBRE (revisión del 14-oct-2026): si la lectura del
      // id de la canónica falló en (0), aquí no se cuela una omisión sin
      // motivo firmado.
      const nombreDestino = (clasif as { nombre?: unknown }).nombre;
      if (
        esClasificacionOmitida(
          typeof nombreDestino === 'string' ? nombreDestino : null,
        )
      ) {
        throw new BadRequestException({
          message: MENSAJE_USA_OMITIR,
          error: 'USA_OMITIR',
        });
      }
    }
    const patch: Record<string, unknown> = {
      clasificacion_id: clasificacionId,
      // Clasificar CONCILIA (deja de estar Pendiente); quitarla lo regresa —
      // salvo que el cargo pague gasto(s): seguiría conciliado por ellos
      // (con `conciliado = false` y partes la BD rechaza el UPDATE).
      conciliado: clasificacionId !== null || conGasto,
      updated_by: userId,
    };
    if (notas !== undefined) patch.notas = notas.trim() || null;
    // (6) CAS sobre lo LEÍDO (conciliado + clasificación): si alguien lo
    // vinculó, lo clasificó o lo omitió entre la lectura y la escritura, 0
    // filas ⇒ 409 MOVIMIENTO_CAMBIO (jamás se pisa).
    let upd = this.supabase.service
      .from('movimiento_bancario')
      .update(patch)
      .eq('id', movId)
      .eq('conciliado', conciliadoActual);
    upd =
      clasifActual === null
        ? upd.is('clasificacion_id', null)
        : upd.eq('clasificacion_id', clasifActual);
    const { data, error } = await upd
      .select(await this.movCols())
      .maybeSingle();
    if (error) {
      // El trigger de la omisión (invariante 75, revisión del 14-oct-2026):
      // un omitido no se reclasifica ni se regresa a pendiente por aquí
      // (solo `conciliacion_quitar_omision`) ⇒ 409, jamás un 500.
      if (
        `${error.message ?? ''} ${(error as { hint?: string | null }).hint ?? ''}`.includes(
          'MOVIMIENTO_OMITIDO',
        )
      ) {
        throw this.conflictoMovimientoOmitido(movId, mov.notas);
      }
      throw new Error(error.message);
    }
    if (!data) {
      let actual: Record<string, unknown> | null = null;
      try {
        const { data: rel } = await this.supabase.service
          .from('movimiento_bancario')
          .select(
            'id, conciliado, clasificacion_id, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)',
          )
          .eq('id', movId)
          .maybeSingle();
        actual = rel ?? null;
      } catch {
        actual = null;
      }
      throw this.conflictoMovimientoCambio(actual);
    }
    return {
      ...(data as unknown as Record<string, unknown>),
      omision: null,
    };
  }

  // =====================================================================
  // OMITIR LA CONCILIACIÓN (invariante 75) y VARIOS CARGOS → UN GASTO
  // (invariante 76) — 14-oct-2026, API 0.0.77, migración 20261014000002.
  // Sonda ÚNICA `omisionCargosDisponible` (las RPC y el trigger entran
  // juntos). Reglas y textos PUROS en `omision.util.ts` y
  // `cargos-a-gasto.util.ts`; el candado real son las RPC atómicas
  // (FOR UPDATE, todo o nada) y el trigger `trg_mov_bancario_omitido_sin_ligas`
  // (ningún camino liga un omitido). Sin la migración, lo nuevo responde 503
  // con código estable y lo demás como el 0.0.76.
  // =====================================================================

  /** ¿Migración 20261014000002 aplicada? (sonda única; el «sí» se memoriza). */
  async omitirDisponible(): Promise<boolean> {
    return omisionCargosDisponible(this.supabase.service);
  }

  /** La MISMA sonda: la migración trae las RPC de omitir y la de cargos. */
  async cargosAGastoDisponible(): Promise<boolean> {
    return omisionCargosDisponible(this.supabase.service);
  }

  /** Memo POSITIVO (≤ 10 min) del id de la canónica; el «no hay» no se memoriza. */
  private omitidoMemo: { id: string; hasta: number } | null = null;

  /**
   * Id de la clasificación canónica «Omitido de la conciliación» por NOMBRE
   * (ilike + `esClasificacionOmitida`). El API nunca la crea: lo hace la RPC
   * en la primera omisión. `fallo` = la lectura falló (≠ «no existe»).
   */
  private async leerIdClasificacionOmitido(): Promise<{
    id: string | null;
    fallo: boolean;
  }> {
    const ahora = Date.now();
    if (this.omitidoMemo && this.omitidoMemo.hasta > ahora) {
      return { id: this.omitidoMemo.id, fallo: false };
    }
    try {
      const { data, error } = await this.supabase.service
        .from('conciliacion_clasificacion')
        .select('id, nombre')
        .ilike('nombre', CLASIFICACION_OMITIDO)
        .limit(5);
      if (error) throw new Error(error.message);
      const fila = ((data ?? []) as Array<{ id?: unknown; nombre?: unknown }>)
        .filter((c) => typeof c.id === 'string')
        .find((c) =>
          esClasificacionOmitida(
            typeof c.nombre === 'string' ? c.nombre : null,
          ),
        );
      const id = typeof fila?.id === 'string' ? fila.id : null;
      if (id) this.omitidoMemo = { id, hasta: ahora + OMITIDO_MEMO_MS };
      return { id, fallo: false };
    } catch (err) {
      this.logger.warn(
        `No se pudo leer la clasificación «${CLASIFICACION_OMITIDO}»: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { id: null, fallo: true };
    }
  }

  /** Id de la canónica o null (no existe o la lectura falló, con warn). */
  private async idClasificacionOmitido(): Promise<string | null> {
    return (await this.leerIdClasificacionOmitido()).id;
  }

  /** 409 MOVIMIENTO_OMITIDO con el motivo leído de las notas. */
  private conflictoMovimientoOmitido(
    movId: string,
    notas: unknown,
  ): ConflictException {
    const omision = leerOmision(typeof notas === 'string' ? notas : null) ?? {
      ...OMISION_SIN_DATOS,
    };
    return new ConflictException({
      message: mensajeMovimientoOmitido(omision),
      error: 'MOVIMIENTO_OMITIDO',
      details: { movimiento_id: movId, omision },
    });
  }

  /**
   * CANDADO TS (invariante 75): un movimiento OMITIDO no se liga ni se
   * desliga por los caminos viejos (gasto, cobro, sobre): 409 sin tocar
   * nada. Decide primero por el NOMBRE de su clasificación leído en la MISMA
   * consulta (`nombreClasificacion`, revisión del 14-oct-2026: sin otra
   * lectura que pueda fallar) y si no viene, por el id de la canónica
   * (memo). Si nada de eso se pudo saber, el trigger de la BD es el candado
   * real: rechaza ligar un omitido Y quitarle la omisión por fuera de
   * `conciliacion_quitar_omision` (desvincular, reclasificar o dejarlo
   * pendiente) con 23514 MOVIMIENTO_OMITIDO, que cada camino traduce a 409.
   */
  private async bloquearSiOmitido(
    movId: string,
    clasificacionId: unknown,
    notas: unknown,
    nombreClasificacion?: unknown,
  ): Promise<void> {
    if (typeof clasificacionId !== 'string' || !clasificacionId) return;
    if (
      esClasificacionOmitida(
        typeof nombreClasificacion === 'string' ? nombreClasificacion : null,
      )
    ) {
      throw this.conflictoMovimientoOmitido(movId, notas);
    }
    const idOmitido = await this.idClasificacionOmitido();
    if (!idOmitido || idOmitido !== clasificacionId) return;
    throw this.conflictoMovimientoOmitido(movId, notas);
  }

  /** 409 MOVIMIENTO_CAMBIO con lo vigente (`clasificar` con `esperado` / CAS). */
  private conflictoMovimientoCambio(
    actual: Record<string, unknown> | null,
  ): ConflictException {
    const clasif = unwrapOne(
      (actual?.clasificacion as { nombre?: unknown } | null) ?? null,
    );
    return new ConflictException({
      message: MENSAJE_MOVIMIENTO_CAMBIO,
      error: 'MOVIMIENTO_CAMBIO',
      details: {
        actual: actual
          ? {
              conciliado: actual.conciliado === true,
              clasificacion_id:
                typeof actual.clasificacion_id === 'string'
                  ? actual.clasificacion_id
                  : null,
              clasificacion:
                typeof clasif?.nombre === 'string' ? clasif.nombre : null,
            }
          : null,
      },
    });
  }

  /**
   * Movimientos por id (lotes de ≤ 150) con `movCols()` + `reverso_de_id`
   * (con su sonda) + la clasificación y la cuenta embebidas. Un error se
   * LANZA (jamás «no existe» por una lectura caída).
   */
  private async leerMovimientosPorIds(
    ids: ReadonlyArray<string>,
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (unicos.length === 0) return [];
    const [cols, conReversos] = await Promise.all([
      this.movCols(),
      this.reversosOn(),
    ]);
    const select = `${cols}${conReversos ? ', reverso_de_id' : ''}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre), cuenta:cuenta_bancaria!cuenta_bancaria_id(alias, moneda, tipo)`;
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += LOTE_IDS_OMISION) {
      const { data, error } = await this.supabase.service
        .from('movimiento_bancario')
        .select(select)
        .in('id', unicos.slice(i, i + LOTE_IDS_OMISION));
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
    }
    return out;
  }

  /** Cargos que YA tienen una devolución apuntándoles (par de reverso). */
  private async devolucionesDe(
    ids: ReadonlyArray<string>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (ids.length === 0 || !(await this.reversosOn())) return out;
    const filas = await this.leerPorLotes(ids, (lote) =>
      this.supabase.service
        .from('movimiento_bancario')
        .select('id, reverso_de_id')
        .in('reverso_de_id', lote),
    );
    for (const f of filas) {
      if (typeof f.reverso_de_id === 'string') out.add(f.reverso_de_id);
    }
    return out;
  }

  /** Moneda de la CUENTA del movimiento (embed `cuenta`), null si no vino. */
  private monedaDeFila(m: Record<string, unknown>): string | null {
    const c = unwrapOne(
      m.cuenta as { moneda?: unknown } | { moneda?: unknown }[] | null,
    );
    return typeof c?.moneda === 'string' && c.moneda ? c.moneda : null;
  }

  /** Fila de un 409 (id, fecha, tipo, monto, moneda, descripción y estado). */
  private filaMensajeOmision(
    m: Record<string, unknown>,
    estado: string | null,
  ): {
    id: string;
    fecha: string | null;
    tipo: string | null;
    monto: number;
    moneda: string | null;
    descripcion: string | null;
    estado: string | null;
  } {
    return {
      id: String(m.id),
      fecha: typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : null,
      tipo: typeof m.tipo === 'string' ? m.tipo : null,
      monto: r2(Math.abs(Number(m.monto)) || 0),
      moneda: this.monedaDeFila(m),
      descripcion:
        typeof m.descripcion === 'string' ? m.descripcion.slice(0, 80) : null,
      estado,
    };
  }

  /**
   * Riesgo de omitir cada PENDIENTE (falla CERRADO: lo que no se pudo
   * revisar es SIN_VERIFICAR). CARGO ⇒ `anotarMotivoPendiente` sobre COPIAS
   * (las MISMAS reglas del auto-cruce y del badge de la lista); ABONO ⇒
   * `cobrosExactosLibresDeAbono` (≤ 5 en paralelo); los dos ⇒
   * `patronTraspaso`; ABONO ⇒ `esDevolucionDeCargo`.
   */
  private async riesgosDeOmision(
    pendientes: Array<Record<string, unknown>>,
  ): Promise<
    Map<string, { riesgo: RiesgoOmision | null; candidatos_n: number | null }>
  > {
    const out = new Map<
      string,
      { riesgo: RiesgoOmision | null; candidatos_n: number | null }
    >();
    const copias: Array<Record<string, unknown>> = pendientes
      .filter((m) => m.tipo === TipoMovimientoBancario.CARGO)
      .map((m) => ({ ...m, conciliado: false }));
    if (copias.length > 0) await this.anotarMotivoPendiente(copias);
    const copiaDe = new Map(copias.map((c) => [String(c.id), c]));
    const abonos = pendientes.filter(
      (m) => m.tipo === (TipoMovimientoBancario.ABONO as string),
    );
    const cobrosDe = new Map<string, number | null>();
    for (let i = 0; i < abonos.length; i += 5) {
      await Promise.all(
        abonos.slice(i, i + 5).map(async (a) => {
          const moneda = this.monedaDeFila(a);
          const cuenta = unwrapOne(
            a.cuenta as { tipo?: unknown } | { tipo?: unknown }[] | null,
          );
          if (!moneda || typeof a.fecha !== 'string') {
            cobrosDe.set(String(a.id), null);
            return;
          }
          try {
            const n = await this.cobrosExactosLibresDeAbono(
              {
                monto: r2(Math.abs(Number(a.monto)) || 0),
                monto_bruto:
                  a.monto_bruto == null ? null : r2(Number(a.monto_bruto)),
                descripcion:
                  typeof a.descripcion === 'string' ? a.descripcion : null,
                cuenta_bancaria_id: String(a.cuenta_bancaria_id),
              },
              a.fecha.slice(0, 10),
              moneda,
              cuenta?.tipo === TIPO_CUENTA_PASARELA,
            );
            cobrosDe.set(String(a.id), n);
          } catch {
            cobrosDe.set(String(a.id), null);
          }
        }),
      );
    }
    for (const m of pendientes) {
      const id = String(m.id);
      const desc = typeof m.descripcion === 'string' ? m.descripcion : null;
      const copia = copiaDe.get(id);
      const riesgo = riesgoDeOmision({
        tipo: typeof m.tipo === 'string' ? m.tipo : null,
        motivoCargo:
          copia && typeof copia.motivo_pendiente === 'string'
            ? copia.motivo_pendiente
            : null,
        cobrosExactos: cobrosDe.has(id) ? (cobrosDe.get(id) ?? null) : null,
        traspaso: patronTraspaso(desc) !== null,
        devolucion: esDevolucionDeCargo(desc),
      });
      const n = copia?.candidatos_n;
      out.set(id, {
        riesgo,
        candidatos_n: typeof n === 'number' && Number.isFinite(n) ? n : null,
      });
    }
    return out;
  }

  /**
   * `POST movimientos/omitir/revisar` — SOLO LECTURA (funciona aun sin la
   * migración): por cada movimiento, si sigue PENDIENTE y LIBRE (o el estado
   * que lo ocupa, espejo del CASE de la RPC) y, si está pendiente, el
   * riesgo de omitirlo (un gasto o cobro que cuadra, traspaso, devolución o
   * no verificado).
   */
  async revisarOmision(idsRaw: string[]): Promise<RevisionOmisionRespuesta> {
    const ids = [...new Set(idsRaw.map((x) => normalizarUuid(x)))];
    const [filas, idOmitido, devueltos] = await Promise.all([
      this.leerMovimientosPorIds(ids),
      this.idClasificacionOmitido(),
      this.devolucionesDe(ids),
    ]);
    const porId = new Map(filas.map((f) => [String(f.id), f]));
    const vivos = ids
      .map((id) => porId.get(id))
      .filter((m): m is Record<string, unknown> => !!m);
    const estados = new Map(
      vivos.map((m) => [
        String(m.id),
        estadoMovimientoParaOmitir(m, {
          idOmitido,
          tieneDevolucion: devueltos.has(String(m.id)),
        }),
      ]),
    );
    const pendientes = vivos.filter(
      (m) => estados.get(String(m.id)) === 'PENDIENTE',
    );
    const riesgos = await this.riesgosDeOmision(pendientes);
    const movimientos: MovimientoRevisadoOmision[] = vivos.map((m) => {
      const id = String(m.id);
      const estado = estados.get(id) ?? 'PENDIENTE';
      const r = riesgos.get(id) ?? null;
      const cuenta = unwrapOne(
        m.cuenta as { alias?: unknown } | { alias?: unknown }[] | null,
      );
      return {
        id,
        fecha: typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : null,
        tipo: typeof m.tipo === 'string' ? m.tipo : '',
        monto: r2(Math.abs(Number(m.monto)) || 0),
        moneda: this.monedaDeFila(m),
        descripcion: typeof m.descripcion === 'string' ? m.descripcion : null,
        cuenta_alias: typeof cuenta?.alias === 'string' ? cuenta.alias : null,
        estado,
        texto_estado:
          estado === 'PENDIENTE' ? null : textoEstadoNoPendiente(estado),
        riesgo: r?.riesgo ?? null,
        texto_riesgo: r?.riesgo
          ? textoRiesgoOmision(r.riesgo, r.candidatos_n)
          : null,
        candidatos_n: r?.candidatos_n ?? null,
      };
    });
    return {
      movimientos,
      no_existen: ids.filter((id) => !porId.has(id)),
      resumen: {
        n: vivos.length,
        pendientes: pendientes.length,
        no_pendientes: vivos.length - pendientes.length,
        con_riesgo: movimientos.filter((m) => m.riesgo !== null).length,
      },
    };
  }

  /** `omision` en cada fila (de la clasificación embebida y las notas). */
  private anotarOmision(filas: Array<Record<string, unknown>>): void {
    for (const m of filas) m.omision = omisionDeFila(m);
  }

  /** Relee los movimientos (orden de la petición) con su `omision`. */
  private async releerMovimientosConOmision(
    ids: ReadonlyArray<string>,
  ): Promise<Array<Record<string, unknown>>> {
    const filas = await this.leerMovimientosPorIds(ids);
    const porId = new Map(filas.map((f) => [String(f.id), f]));
    const out = ids
      .map((id) => porId.get(id))
      .filter((m): m is Record<string, unknown> => !!m);
    for (const m of out) {
      m.omision = omisionDeFila(m);
      delete m.cuenta;
    }
    return out;
  }

  /**
   * Error de las RPC de omitir / deshacer ⇒ 400/404/409/503 con código y
   * texto es-MX (`omision.util`), NUNCA el texto de la BD (trae uuids).
   */
  private errorRpcOmision(
    error: {
      code?: string | null;
      message?: string | null;
      hint?: string | null;
      details?: string | null;
    },
    ctx: {
      accion: 'omitir' | 'quitar';
      total: number;
      porId: Map<string, Record<string, unknown>>;
    },
  ): Error {
    if (error.code === '40P01') {
      return new ConflictException({
        message: MENSAJE_CONFLICTO_CONCURRENTE,
        error: 'CONFLICTO_CONCURRENTE',
      });
    }
    const { codigo, details } = leerErrorOmision(error);
    if (!codigo) {
      this.logger.error(
        `Omisión (${ctx.accion}): la base respondió ${error.code ?? 'sin código'}: ${error.message ?? ''}`,
      );
      if (esOmisionCargosAusente(error)) return errorOmitirNoDisponible();
      return new Error(error.message ?? 'Error de la base de datos');
    }
    this.logger.warn(
      `Omisión (${ctx.accion}): la base rechazó la operación (${codigo}): ${error.message ?? ''}`,
    );
    const movsBd = Array.isArray(details?.movimientos)
      ? (details.movimientos as Array<Record<string, unknown>>)
      : [];
    const conMoneda = movsBd.map((x) => {
      const leido = ctx.porId.get(String(x.id));
      return {
        id: String(x.id),
        fecha: typeof x.fecha === 'string' ? x.fecha.slice(0, 10) : null,
        tipo: typeof x.tipo === 'string' ? x.tipo : null,
        monto: r2(Math.abs(Number(x.monto)) || 0),
        moneda: leido ? this.monedaDeFila(leido) : null,
        descripcion: typeof x.descripcion === 'string' ? x.descripcion : null,
        estado: typeof x.estado === 'string' ? x.estado : null,
      };
    });
    switch (codigo) {
      case 'MOVIMIENTO_NO_EXISTE': {
        const faltan = Array.isArray(details?.ids)
          ? (details.ids as unknown[]).map(String)
          : [];
        return new NotFoundException({
          message: mensajeMovimientosNoExisten(Math.max(1, faltan.length)),
          error: 'MOVIMIENTO_NO_EXISTE',
          details: { faltan },
        });
      }
      case 'MOVIMIENTO_NO_PENDIENTE':
        return new ConflictException({
          message: mensajeNoPendientes(conMoneda, ctx.total, 'omitir'),
          error: 'MOVIMIENTO_NO_PENDIENTE',
          details: { movimientos: conMoneda },
        });
      case 'MOVIMIENTO_NO_OMITIDO':
        return new ConflictException({
          message: mensajeNoOmitidos(conMoneda, ctx.total),
          error: 'MOVIMIENTO_NO_OMITIDO',
          details: { movimientos: conMoneda },
        });
      case 'MOVIMIENTO_OMITIDO':
        return new ConflictException({
          message: mensajeMovimientoOmitido(null),
          error: 'MOVIMIENTO_OMITIDO',
          details: details ?? undefined,
        });
      case 'LOTE_INVALIDO':
      case 'OMISION_INVALIDA':
      default:
        return new BadRequestException({
          message:
            codigo === 'OMISION_INVALIDA'
              ? 'El motivo de la omisión no es válido: escríbelo en una sola línea (10 a 300 caracteres).'
              : `Elige de 1 a ${OMITIR_MAX} movimientos sin repetir.`,
          error: codigo,
          details: details ?? undefined,
        });
    }
  }

  /**
   * `POST movimientos/omitir` (invariante 75). Orden: sonda ⇒ filas (404 si
   * falta alguna) ⇒ todas PENDIENTES y LIBRES (409 sin llamar la RPC) ⇒
   * `aceptar_riesgo_ids` ⊆ la selección (400) ⇒ riesgos aceptados uno por
   * uno (409 OMITIR_CON_RIESGO) ⇒ la línea firmada (usuario, día Cancún) ⇒
   * la RPC todo-o-nada (re-exige el pendiente bajo FOR UPDATE: una carrera
   * es su 409 traducido) ⇒ relectura con `omision`.
   */
  async omitirMovimientos(
    dto: {
      movimiento_ids: string[];
      motivo: string;
      aceptar_riesgo_ids?: string[] | null;
    },
    userId: string,
    usuarioNombre?: string | null,
  ): Promise<{
    omitidos: number;
    clasificacion_id: string;
    movimientos: Array<Record<string, unknown>>;
  }> {
    if (!(await this.omitirDisponible())) throw errorOmitirNoDisponible();
    const ids = [...new Set(dto.movimiento_ids.map((x) => normalizarUuid(x)))];
    const [filas, idOmitido, devueltos] = await Promise.all([
      this.leerMovimientosPorIds(ids),
      this.idClasificacionOmitido(),
      this.devolucionesDe(ids),
    ]);
    const porId = new Map(filas.map((f) => [String(f.id), f]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length > 0) {
      throw new NotFoundException({
        message: mensajeMovimientosNoExisten(faltan.length),
        error: 'MOVIMIENTO_NO_EXISTE',
        details: { faltan },
      });
    }
    const vivos = ids.map((id) => porId.get(id)!);
    const noPendientes = vivos
      .map((m) => ({
        m,
        estado: estadoMovimientoParaOmitir(m, {
          idOmitido,
          tieneDevolucion: devueltos.has(String(m.id)),
        }),
      }))
      .filter((x) => x.estado !== 'PENDIENTE')
      .map((x) => this.filaMensajeOmision(x.m, x.estado));
    if (noPendientes.length > 0) {
      throw new ConflictException({
        message: mensajeNoPendientes(noPendientes, ids.length, 'omitir'),
        error: 'MOVIMIENTO_NO_PENDIENTE',
        details: { movimientos: noPendientes },
      });
    }
    const aceptados = new Set(
      (dto.aceptar_riesgo_ids ?? []).map((x) => normalizarUuid(x)),
    );
    if ([...aceptados].some((id) => !porId.has(id))) {
      throw new BadRequestException({
        message: MENSAJE_ACEPTAR_RIESGO_INVALIDO,
        error: 'ACEPTAR_RIESGO_INVALIDO',
      });
    }
    const riesgos = await this.riesgosDeOmision(vivos);
    const conRiesgo = vivos
      .map((m) => ({ m, r: riesgos.get(String(m.id)) }))
      .filter((x) => x.r?.riesgo && !aceptados.has(String(x.m.id)))
      .map((x) => ({
        ...this.filaMensajeOmision(x.m, null),
        riesgo: x.r!.riesgo as RiesgoOmision,
        candidatos_n: x.r!.candidatos_n,
        texto: textoRiesgoOmision(
          x.r!.riesgo as RiesgoOmision,
          x.r!.candidatos_n,
        ),
      }));
    if (conRiesgo.length > 0) {
      throw new ConflictException({
        message: mensajeOmitirConRiesgo(conRiesgo, ids.length),
        error: 'OMITIR_CON_RIESGO',
        details: {
          movimientos: conRiesgo.map((x) => ({
            id: x.id,
            fecha: x.fecha,
            tipo: x.tipo,
            monto: x.monto,
            moneda: x.moneda,
            descripcion: x.descripcion,
            riesgo: x.riesgo,
            texto: x.texto,
          })),
        },
      });
    }
    const linea = lineaOmision({
      motivo: dto.motivo,
      usuario: usuarioNombre ?? null,
      hoy: hoyCancun(),
    });
    const res = await this.supabase.service.rpc(
      'conciliacion_omitir_movimientos',
      { p_movimiento_ids: ids, p_linea: linea, p_actor: userId },
    );
    const { error } = res;
    const data: unknown = res.data;
    if (error) {
      throw this.errorRpcOmision(error, {
        accion: 'omitir',
        total: ids.length,
        porId,
      });
    }
    const r = (data ?? {}) as {
      omitidos?: unknown;
      clasificacion_id?: unknown;
    };
    const clasificacionId =
      typeof r.clasificacion_id === 'string' ? r.clasificacion_id : idOmitido;
    if (clasificacionId) {
      this.omitidoMemo = {
        id: clasificacionId,
        hasta: Date.now() + OMITIDO_MEMO_MS,
      };
    }
    this.logger.log(
      `Omisión: ${usuarioNombre ?? userId} omitió ${ids.length} movimiento(s) de la conciliación — motivo: ${limpiarJustificacion(dto.motivo)}`,
    );
    return {
      omitidos: Number(r.omitidos) || ids.length,
      clasificacion_id: clasificacionId ?? '',
      movimientos: await this.releerMovimientosConOmision(ids),
    };
  }

  /**
   * `POST movimientos/quitar-omision` (invariante 75): 1..200 OMITIDOS
   * vuelven a Pendientes (todo o nada); de sus notas se quita SOLO la
   * primera línea canónica.
   */
  async quitarOmision(
    idsRaw: string[],
    userId: string,
  ): Promise<{
    restaurados: number;
    movimientos: Array<Record<string, unknown>>;
  }> {
    if (!(await this.omitirDisponible())) throw errorOmitirNoDisponible();
    const ids = [...new Set(idsRaw.map((x) => normalizarUuid(x)))];
    const [filas, omitido] = await Promise.all([
      this.leerMovimientosPorIds(ids),
      this.leerIdClasificacionOmitido(),
    ]);
    const idOmitido = omitido.id;
    const porId = new Map(filas.map((f) => [String(f.id), f]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length > 0) {
      throw new NotFoundException({
        message: mensajeMovimientosNoExisten(faltan.length),
        error: 'MOVIMIENTO_NO_EXISTE',
        details: { faltan },
      });
    }
    // Sin poder leer la canónica no se adivina «no está omitido»: la RPC lo
    // decide bajo FOR UPDATE (y su 409 se traduce igual).
    const noOmitidos = (omitido.fallo ? [] : ids)
      .map((id) => porId.get(id)!)
      .filter((m) => !idOmitido || m.clasificacion_id !== idOmitido)
      .map((m) =>
        this.filaMensajeOmision(
          m,
          m.conciliado !== true
            ? 'PENDIENTE'
            : typeof m.clasificacion_id === 'string' && m.clasificacion_id
              ? 'CLASIFICADO'
              : 'CONCILIADO',
        ),
      );
    if (noOmitidos.length > 0) {
      throw new ConflictException({
        message: mensajeNoOmitidos(noOmitidos, ids.length),
        error: 'MOVIMIENTO_NO_OMITIDO',
        details: { movimientos: noOmitidos },
      });
    }
    const res = await this.supabase.service.rpc('conciliacion_quitar_omision', {
      p_movimiento_ids: ids,
      p_actor: userId,
    });
    const { error } = res;
    const data: unknown = res.data;
    if (error) {
      throw this.errorRpcOmision(error, {
        accion: 'quitar',
        total: ids.length,
        porId,
      });
    }
    const r = (data ?? {}) as { restaurados?: unknown };
    this.logger.log(
      `Omisión deshecha: ${ids.length} movimiento(s) vuelven a Pendientes (usuario ${userId}).`,
    );
    return {
      restaurados: Number(r.restaurados) || ids.length,
      movimientos: await this.releerMovimientosConOmision(ids),
    };
  }

  /**
   * Cargos de «Vincular a un gasto» / del alta por la suma (lectura común):
   * 404 si falta alguno; el estado (espejo de la RPC) y la moneda de su
   * cuenta (503 CUENTA_SIN_MONEDA si no se pudo leer).
   */
  private async cargosParaGasto(ids: string[]): Promise<{
    filas: Array<Record<string, unknown>>;
    porId: Map<string, Record<string, unknown>>;
    cargos: CargoParaGasto[];
  }> {
    const [filas, idOmitido, devueltos] = await Promise.all([
      this.leerMovimientosPorIds(ids),
      this.idClasificacionOmitido(),
      this.devolucionesDe(ids),
    ]);
    const porId = new Map(filas.map((f) => [String(f.id), f]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length > 0) {
      throw new NotFoundException({
        message: mensajeMovimientosNoExisten(faltan.length),
        error: 'MOVIMIENTO_NO_EXISTE',
        details: { faltan },
      });
    }
    const cargos: CargoParaGasto[] = ids.map((id) => {
      const m = porId.get(id)!;
      return {
        id,
        tipo: typeof m.tipo === 'string' ? m.tipo : null,
        monto: r2(Math.abs(Number(m.monto)) || 0),
        moneda: this.monedaDeFila(m),
        estado: estadoMovimientoParaOmitir(m, {
          idOmitido,
          tieneDevolucion: devueltos.has(id),
        }),
        fecha: typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : null,
        descripcion:
          typeof m.descripcion === 'string' ? m.descripcion.slice(0, 80) : null,
      };
    });
    // La moneda de la cuenta es NOT NULL: null = lectura caída ⇒ 503 (jamás
    // un CARGOS_MONEDA_DISTINTA que culpa al operador).
    if (
      cargos.some(
        (c) => c.tipo === (TipoMovimientoBancario.CARGO as string) && !c.moneda,
      )
    ) {
      throw errorSinMonedaCuenta();
    }
    return { filas, porId, cargos };
  }

  /**
   * Traduce el veredicto del espejo PURO (`validarCargosParaGasto`) a la
   * excepción del endpoint (con el prefijo del alta por la suma si aplica).
   */
  private errorValidacionCargos(
    v: Exclude<ValidacionCargosGasto, { ok: true }>,
    ctx: {
      total: number;
      accion: 'vincular' | 'crear';
      fechaGasto?: string | null;
    },
  ): Error {
    const pref = (msg: string) =>
      ctx.accion === 'crear' ? conPrefijoNoSeRegistro(msg) : msg;
    const d = v.details;
    switch (v.codigo) {
      case 'LOTE_INVALIDO':
        return new BadRequestException({
          message: pref(MENSAJE_LOTE_CARGOS_INVALIDO),
          error: 'LOTE_INVALIDO',
          details: d,
        });
      case 'SOLO_CARGOS': {
        const n = Array.isArray(d.abonos) ? d.abonos.length : 1;
        return new BadRequestException({
          message: pref(mensajeSoloCargos(n)),
          error: 'SOLO_CARGOS',
          details: d,
        });
      }
      case 'MOVIMIENTO_NO_PENDIENTE': {
        const movs = (
          Array.isArray(d.movimientos) ? d.movimientos : []
        ) as Array<Record<string, unknown>>;
        return new ConflictException({
          message: mensajeNoPendientes(
            movs.map((x) => ({
              fecha: (x.fecha as string | null) ?? null,
              descripcion: (x.descripcion as string | null) ?? null,
              monto: Number(x.monto) || 0,
              moneda: (x.moneda as string | null) ?? null,
              estado: (x.estado as string | null) ?? null,
            })),
            ctx.total,
            ctx.accion,
          ),
          error: 'MOVIMIENTO_NO_PENDIENTE',
          details: d,
        });
      }
      case 'CARGOS_MONEDA_DISTINTA':
        return new ConflictException({
          message: pref(
            mensajeCargosMonedaDistinta(
              (Array.isArray(d.monedas) ? d.monedas : []) as string[],
            ),
          ),
          error: 'CARGOS_MONEDA_DISTINTA',
          details: d,
        });
      case 'LOTE_MONEDA_DISTINTA':
        return new ConflictException({
          message: pref(
            mensajeLoteMonedaDistintaGasto({
              monedaGasto: (d.moneda_gasto as string | null) ?? null,
              monedaCuenta: (d.moneda_cuenta as string | null) ?? null,
            }),
          ),
          error: 'LOTE_MONEDA_DISTINTA',
          details: d,
        });
      case 'GASTO_BODEGA':
        return new ConflictException({
          message: pref(mensajeGastoBodegaCargos(ctx.fechaGasto ?? null)),
          error: 'GASTO_BODEGA',
          details: d,
        });
      case 'GASTO_NO_BANCARIO':
        return new ConflictException({
          message: pref(
            mensajeGastoNoBancario((d.medio_pago as string | null) ?? null),
          ),
          error: 'GASTO_NO_BANCARIO',
          details: d,
        });
      case 'GASTO_YA_CUBIERTO':
        return new ConflictException({
          message: pref(MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA),
          error: 'GASTO_YA_CUBIERTO',
          details: d,
        });
      case 'CARGOS_EXCEDEN_GASTO':
      default:
        return new ConflictException({
          message: pref(
            mensajeCargosExcedenGasto({
              n: ctx.total,
              moneda: (d.moneda as string | null) ?? null,
              monto_gasto: Number(d.monto_gasto) || 0,
              suma_ligada: Number(d.suma_ligada) || 0,
              suma_cargos: Number(d.suma_cargos) || 0,
              tolerancia:
                d.tolerancia == null ? null : Number(d.tolerancia) || null,
            }),
          ),
          error: 'CARGOS_EXCEDEN_GASTO',
          details: d,
        });
    }
  }

  /**
   * Prevalidación del ALTA POR LA SUMA (`POST /v1/expenses` con
   * `conciliar_con_movimientos`): lee los cargos y aplica el espejo PURO de
   * la RPC contra el gasto que se VA a crear. 4xx con el prefijo «No se
   * registró el gasto: » y SIN crear nada. La RPC vuelve a validar todo
   * bajo FOR UPDATE (una carrera ⇒ compensación en expenses).
   */
  async prevalidarCargosParaGastoNuevo(
    idsRaw: string[],
    gasto: GastoNuevoParaCargos,
  ): Promise<{ moneda: string; suma: number }> {
    if (!(await this.partesOn())) throw errorPartesNoDisponibles();
    const ids = [...new Set(idsRaw.map((x) => normalizarUuid(x)))];
    const { cargos } = await this.cargosParaGasto(ids);
    const v = validarCargosParaGasto(cargos, {
      moneda: gasto.moneda,
      monto: gasto.monto,
      medio_pago: gasto.medio_pago,
      vinculado: 0,
      cruzadas: 0,
      fecha_gasto: gasto.fecha_gasto ?? null,
    });
    if (!v.ok) {
      throw this.errorValidacionCargos(v, {
        total: ids.length,
        accion: 'crear',
        fechaGasto: gasto.fecha_gasto ?? null,
      });
    }
    return { moneda: v.moneda, suma: v.suma };
  }

  /**
   * Error de la RPC `conciliacion_ligar_cargos_a_gasto` (y de los triggers
   * A/K que dispara) ⇒ 400/404/409/503 con los textos de
   * `cargos-a-gasto.util`.
   */
  private async errorRpcCargosGasto(
    error: {
      code?: string | null;
      message?: string | null;
      hint?: string | null;
      details?: string | null;
    },
    ctx: { gastoId: string; ids: string[]; accion: 'vincular' | 'crear' },
  ): Promise<Error> {
    if (error.code === '40P01') {
      return new ConflictException({
        message: MENSAJE_CONFLICTO_CONCURRENTE,
        error: 'CONFLICTO_CONCURRENTE',
      });
    }
    const { codigo, details } = leerErrorCargosGasto(error);
    if (!codigo) {
      this.logger.error(
        `Varios cargos → gasto ${ctx.gastoId}: la base respondió ${error.code ?? 'sin código'}: ${error.message ?? ''}`,
      );
      if (esOmisionCargosAusente(error)) return errorCargosAGastoNoDisponible();
      if (esPartesAusentes(error)) return errorPartesNoDisponibles();
      return new Error(error.message ?? 'Error de la base de datos');
    }
    this.logger.warn(
      `Varios cargos → gasto ${ctx.gastoId}: la base rechazó la liga (${codigo}): ${error.message ?? ''}`,
    );
    const d = details ?? {};
    switch (codigo) {
      case 'MOVIMIENTO_NO_EXISTE': {
        const faltan = Array.isArray(d.ids)
          ? (d.ids as unknown[]).map(String)
          : [];
        return new NotFoundException({
          message: mensajeMovimientosNoExisten(Math.max(1, faltan.length)),
          error: 'MOVIMIENTO_NO_EXISTE',
          details: { faltan },
        });
      }
      case 'GASTO_NO_EXISTE':
        return new NotFoundException({
          message: MENSAJE_GASTO_NO_EXISTE,
          error: 'GASTO_NO_EXISTE',
          details: { gasto_id: ctx.gastoId },
        });
      case 'GASTO_NO_BANCARIO': {
        const medio = (d.medio_pago as string | null) ?? null;
        if (medio === MEDIO_BODEGA) {
          let fecha: string | null = null;
          try {
            const { data } = await this.supabase.service
              .from('gasto')
              .select('fecha_gasto')
              .eq('id', ctx.gastoId)
              .maybeSingle();
            fecha =
              (data as { fecha_gasto?: string | null } | null)?.fecha_gasto ??
              null;
          } catch {
            fecha = null;
          }
          return new ConflictException({
            message: mensajeGastoBodegaCargos(fecha),
            error: 'GASTO_BODEGA',
            details: { gasto_id: ctx.gastoId, medio_pago: medio },
          });
        }
        return new ConflictException({
          message: mensajeGastoNoBancario(medio),
          error: 'GASTO_NO_BANCARIO',
          details: d,
        });
      }
      case 'LOTE_INVALIDO':
      case 'SOLO_CARGOS':
      case 'MOVIMIENTO_NO_PENDIENTE':
      case 'CARGOS_MONEDA_DISTINTA':
      case 'LOTE_MONEDA_DISTINTA':
      case 'CARGOS_EXCEDEN_GASTO': {
        let det: Record<string, unknown> = d;
        if (
          codigo === 'MOVIMIENTO_NO_PENDIENTE' &&
          Array.isArray(d.movimientos)
        ) {
          // La BD no manda la moneda de la cuenta: se relee (best-effort;
          // sin ella el texto va en pesos).
          const monedaDe = new Map<string, string | null>();
          try {
            for (const m of await this.leerMovimientosPorIds(ctx.ids)) {
              monedaDe.set(String(m.id), this.monedaDeFila(m));
            }
          } catch {
            monedaDe.clear();
          }
          det = {
            ...d,
            gasto_id: ctx.gastoId,
            movimientos: (d.movimientos as Array<Record<string, unknown>>).map(
              (x) => ({ ...x, moneda: monedaDe.get(String(x.id)) ?? null }),
            ),
          };
        }
        return this.errorValidacionCargos(
          { ok: false, codigo, details: det },
          { total: ctx.ids.length, accion: ctx.accion },
        );
      }
      case 'GASTO_YA_CUBIERTO':
        return new ConflictException({
          message:
            d.motivo === 'MONEDA_DISTINTA' ||
            String(error.message ?? '').includes('MONEDA')
              ? MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA
              : MENSAJE_GASTO_YA_CUBIERTO_CARRERA,
          error: 'GASTO_YA_CUBIERTO',
          details: { gasto_id: ctx.gastoId, ...d },
        });
      case 'MOVIMIENTO_OMITIDO':
        return new ConflictException({
          message: mensajeMovimientoOmitido(null),
          error: 'MOVIMIENTO_OMITIDO',
          details: d,
        });
      case 'CARGO_NO_CUADRA':
      case 'CARGO_EXCEDIDO':
      case 'PARTES_INCOHERENTES':
      case 'CARGO_LIGADO':
      case 'REVERSO_INVALIDO':
      case 'MOVIMIENTO_YA_LIGADO':
      default:
        return new ConflictException({
          message: mensajeErrorPartes(
            codigo === 'CARGO_NO_CUADRA' ? 'CARGO_LIGADO' : codigo,
            d,
          ),
          error: codigo,
          details: { gasto_id: ctx.gastoId, ...d },
        });
    }
  }

  /**
   * VARIOS CARGOS → UN GASTO (`POST gastos/:id/cargos`; también el alta por
   * la suma de expenses). SOLO la RPC atómica: valida TODO bajo FOR UPDATE
   * y escribe UNA parte por cargo; `gasto.conciliado` lo sigue escribiendo
   * solo la BD. Re-envío idéntico ⇒ `idempotente: true`. Jamás se encadena
   * la RPC G de un cargo.
   */
  async ligarCargosAGasto(
    gastoIdRaw: string,
    idsRaw: string[],
    userId: string,
    // 'crear' = el alta por la suma de expenses: los textos de validación
    // dicen «No se registró el gasto: …» (el gasto se retira).
    opts: { accion?: 'vincular' | 'crear' } = {},
  ): Promise<LigarCargosAGastoRespuesta> {
    if (!(await this.partesOn())) throw errorPartesNoDisponibles();
    if (!(await this.cargosAGastoDisponible())) {
      throw errorCargosAGastoNoDisponible();
    }
    const gastoId = normalizarUuid(gastoIdRaw);
    const ids = [...new Set(idsRaw.map((x) => normalizarUuid(x)))];
    if (ids.length < CARGOS_A_GASTO_MIN || ids.length > CARGOS_A_GASTO_MAX) {
      throw new BadRequestException({
        message: MENSAJE_LOTE_CARGOS_INVALIDO,
        error: 'LOTE_INVALIDO',
      });
    }
    const res = await this.supabase.service.rpc(
      'conciliacion_ligar_cargos_a_gasto',
      { p_gasto_id: gastoId, p_movimiento_ids: ids, p_actor: userId },
    );
    const { error } = res;
    const data: unknown = res.data;
    if (error) {
      throw await this.errorRpcCargosGasto(error, {
        gastoId,
        ids,
        accion: opts.accion ?? 'vincular',
      });
    }
    const r = (data ?? {}) as Partial<LigaCargosAGasto>;
    const estado = (r.gasto_estado ?? {}) as Partial<
      LigaCargosAGasto['gasto_estado']
    >;
    const liga: LigaCargosAGasto = {
      gasto_id: typeof r.gasto_id === 'string' ? r.gasto_id : gastoId,
      idempotente: r.idempotente === true,
      nuevos: Array.isArray(r.nuevos) ? r.nuevos.map(String) : [],
      partes: Array.isArray(r.partes)
        ? r.partes.map((p) => ({
            movimiento_id: String(p.movimiento_id),
            monto_parte: r2(Number(p.monto_parte) || 0),
            moneda: String(p.moneda ?? ''),
          }))
        : [],
      gasto_estado: {
        monto: r2(Number(estado.monto) || 0),
        moneda: String(estado.moneda ?? ''),
        n_partes: Math.trunc(Number(estado.n_partes) || 0),
        monto_vinculado: r2(Number(estado.monto_vinculado) || 0),
        faltante: r2(Number(estado.faltante) || 0),
        cubierto: estado.cubierto === true,
      },
    };
    this.logger.log(
      `Varios cargos → gasto ${gastoId}: ${liga.idempotente ? 're-envío idempotente' : `${liga.nuevos.length} cargo(s) vinculado(s)`} (usuario ${userId}); cubierto=${liga.gasto_estado.cubierto}`,
    );
    return {
      ...liga,
      movimientos: await this.releerMovimientosConOmision(ids),
    };
  }

  /**
   * `POST cargos/gastos-candidatos` (invariante 76) — SOLO LECTURA: los
   * gastos que podrían pagar JUNTOS estos 2..50 cargos. Valida como la RPC
   * (404, SOLO_CARGOS, MOVIMIENTO_NO_PENDIENTE, CARGOS_MONEDA_DISTINTA; cuenta
   * sin moneda ⇒ 503). Universo = el de «Vincular gasto» de un cargo
   * (bancarios, sin conciliar, moneda de las cuentas; nunca cruzados) en
   * [fecha_min − dias, fecha_max + dias], con la MISMA búsqueda. Cada
   * candidato con `resultado` (CUBRE/PARCIAL/EXCEDE), `faltante_tras` y
   * `excedente` (lo calcula el API; el panel solo pinta). `excluidos` +
   * `excluidos_monto` viajan SIEMPRE (revisión del 14-oct-2026; con
   * candidatos también): los gastos del monto de la suma (o del de `q`) que
   * NO son del universo —en efectivo u otro medio, ya conciliados con otro
   * cargo, en otra moneda o fuera de la ventana— son justo los que «Créalo
   * por la suma» duplicaría; con la lista llena (otro gasto bancario del
   * mismo monto) no se veían.
   */
  async gastosCandidatosDeCargos(dto: {
    movimiento_ids: string[];
    q?: string;
    dias?: number;
    limite?: number;
  }): Promise<CargosGastosCandidatosRespuesta> {
    if (!(await this.partesOn())) throw errorPartesNoDisponibles();
    const dias = Math.min(180, Math.max(1, Math.trunc(dto.dias ?? 30)));
    const limite = Math.min(300, Math.max(1, Math.trunc(dto.limite ?? 100)));
    const ids = [...new Set(dto.movimiento_ids.map((x) => normalizarUuid(x)))];
    if (ids.length < CARGOS_A_GASTO_MIN || ids.length > CARGOS_A_GASTO_MAX) {
      throw new BadRequestException({
        message: MENSAJE_LOTE_CARGOS_INVALIDO,
        error: 'LOTE_INVALIDO',
      });
    }
    const { porId, cargos } = await this.cargosParaGasto(ids);
    // Mismo orden que la RPC hasta la moneda (el gasto aún no se elige).
    const abonos = cargos.filter(
      (c) => c.tipo !== (TipoMovimientoBancario.CARGO as string),
    );
    if (abonos.length > 0) {
      throw this.errorValidacionCargos(
        {
          ok: false,
          codigo: 'SOLO_CARGOS',
          details: {
            abonos: abonos.map((c) => ({
              id: c.id,
              fecha: c.fecha,
              monto: c.monto,
              descripcion: c.descripcion,
            })),
          },
        },
        { total: ids.length, accion: 'vincular' },
      );
    }
    const ocupados = cargos.filter((c) => c.estado !== 'PENDIENTE');
    if (ocupados.length > 0) {
      throw this.errorValidacionCargos(
        {
          ok: false,
          codigo: 'MOVIMIENTO_NO_PENDIENTE',
          details: {
            movimientos: ocupados.map((c) => ({
              id: c.id,
              fecha: c.fecha,
              tipo: c.tipo,
              monto: c.monto,
              moneda: c.moneda,
              descripcion: c.descripcion,
              estado: c.estado,
            })),
          },
        },
        { total: ids.length, accion: 'vincular' },
      );
    }
    const monedas = [...new Set(cargos.map((c) => c.moneda ?? '?'))].sort();
    if (monedas.length !== 1) {
      throw this.errorValidacionCargos(
        { ok: false, codigo: 'CARGOS_MONEDA_DISTINTA', details: { monedas } },
        { total: ids.length, accion: 'vincular' },
      );
    }
    const moneda = monedas[0];
    const sumaCent = cargos.reduce(
      (a, c) => a + Math.round(Math.abs(c.monto) * 100),
      0,
    );
    const suma = sumaCent / 100;
    const fechas = cargos
      .map((c) => c.fecha)
      .filter((f): f is string => typeof f === 'string')
      .sort();
    const fechaMin = fechas[0] ?? hoyCancun();
    const fechaMax = fechas[fechas.length - 1] ?? fechaMin;
    const ventana = {
      desde: ventanaDias(fechaMin, dias).desde,
      hasta: ventanaDias(fechaMax, dias).hasta,
    };
    // Cuentas (alias) y terminación común de tarjeta (catálogo del cruce).
    const cuentas = new Map<string, string | null>();
    for (const id of ids) {
      const m = porId.get(id)!;
      const c = unwrapOne(
        m.cuenta as { alias?: unknown } | { alias?: unknown }[] | null,
      );
      cuentas.set(
        String(m.cuenta_bancaria_id),
        typeof c?.alias === 'string' ? c.alias : null,
      );
    }
    const ctxCruce = await this.cargarCtxCruce();
    const terminacion = terminacionComun(
      ids.map((id) => {
        const m = porId.get(id)!;
        return terminacionDeMovimiento(
          typeof m.referencia === 'string' ? m.referencia : null,
          typeof m.descripcion === 'string' ? m.descripcion : null,
          ctxCruce.terminaciones,
        );
      }),
    );
    // Universo y búsqueda: el MISMO lector de «Vincular gasto» de un cargo.
    const busqueda = interpretarBusquedaGasto(dto.q);
    const orTexto = await this.orTextoBusquedaGasto(busqueda);
    const filas = await this.leerUniversoGastos({
      cols: await this.gastoRicoCols(),
      moneda,
      conNoBancarios: false,
      ventana,
      montos:
        busqueda.tipo === 'monto'
          ? {
              min: busqueda.min,
              max: busqueda.max,
              maxExclusivo: busqueda.maxExclusivo,
            }
          : null,
      orTexto,
    });
    const vinculado = await this.sumasLigadasDe(
      filas.map((g) => g.id as string),
    );
    const candidatos = filas.map((g) => {
      const ligado = vinculado.get(g.id as string) ?? 0;
      const base = this.aCandidatoGasto(g, null, ligado);
      const r = resultadoCargosSobreGasto({
        montoGasto: Number(g.monto) || 0,
        vinculado: ligado,
        sumaCargos: suma,
      });
      const candidato: CandidatoGastoPorSuma = {
        ...base,
        no_bancario: !esMedioBancario(base.medio_pago),
        resultado: r.resultado,
        faltante_tras: r.faltante_tras,
        excedente: r.excedente,
      };
      return candidato;
    });
    const ordenados: CandidatoGastoPorSuma[] = ordenarCandidatosPorSuma(
      candidatos.map((c) => ({ ...c, fecha: c.fecha ?? null })),
      { suma, fechaMin, fechaMax },
    );
    // ¿Algún cargo tiene SU propio gasto que cuadra? (aviso ámbar del panel;
    // null = no se pudo revisar: jamás un «ninguno» falso).
    const copias: Array<Record<string, unknown>> = ids.map((id) => ({
      ...porId.get(id)!,
      conciliado: false,
    }));
    await this.anotarMotivoPendiente(copias);
    const cargosConPropio = copias.some(
      (c) => typeof c.motivo_pendiente !== 'string',
    )
      ? null
      : copias
          .filter(
            (c) =>
              c.motivo_pendiente === 'SE_PUEDE_CRUZAR' ||
              c.motivo_pendiente === 'AMBIGUO',
          )
          .map((c) => ({
            id: String(c.id),
            motivo: c.motivo_pendiente as 'SE_PUEDE_CRUZAR' | 'AMBIGUO',
            candidatos_n:
              typeof c.candidatos_n === 'number' ? c.candidatos_n : null,
          }));
    const respuesta: CargosGastosCandidatosRespuesta = {
      cargos: {
        ids,
        n: ids.length,
        suma,
        moneda,
        fecha_min: fechaMin,
        fecha_max: fechaMax,
        cuentas: [...cuentas.entries()].map(([id, alias]) => ({ id, alias })),
        terminacion_comun: terminacion,
      },
      ventana,
      candidatos: ordenados.slice(0, limite),
      truncado:
        ordenados.length > limite || filas.length >= CANDIDATOS_GASTO_TOPE,
      cargos_con_candidato_propio: cargosConPropio,
    };
    // SIEMPRE (revisión del 14-oct-2026), no solo con la lista vacía: el
    // paso de duplicados antes de «Créalo por la suma» (`q` = la suma) debe
    // ver el gasto en EFECTIVO o ya conciliado del mismo monto aunque otro
    // gasto bancario de ese monto llene la lista. UNA consulta acotada por
    // monto y fechas; si falla, la respuesta sale sin la llave (warn).
    const excluidos = await this.excluidosDeCandidatos({
      movId: ids[0],
      q: dto.q,
      montoCargo: suma,
      monedaCuenta: moneda,
      fecha: fechaMax,
      dias,
      ventana,
    });
    return excluidos ? { ...respuesta, ...excluidos } : respuesta;
  }

  /**
   * Pre-cierre (renglón INFORMATIVO `movimientos_omitidos`): omitidos del
   * periodo por la fecha DATE del movimiento, con su monto por moneda de la
   * cuenta. Paginado; NUNCA lanza (null = no se pudo leer). Sin la canónica
   * no hay omitidos (0).
   */
  async omitidosDelPeriodo(
    desde: string,
    hasta: string,
  ): Promise<OmitidosPeriodo | null> {
    try {
      const r = await this.leerIdClasificacionOmitido();
      if (r.fallo) return null;
      if (!r.id) return { count: 0, monto_mxn: 0, monto_usd: 0 };
      const idOmitido = r.id;
      const { filas, truncado } = await this.leerPaginado(
        (a, b) =>
          this.supabase.service
            .from('movimiento_bancario')
            .select(
              'id, monto, cuenta:cuenta_bancaria!cuenta_bancaria_id(moneda)',
            )
            .eq('clasificacion_id', idOmitido)
            .gte('fecha', desde.slice(0, 10))
            .lte('fecha', hasta.slice(0, 10))
            .order('id', { ascending: true })
            .range(a, b),
        OMITIDOS_PRECIERRE_TOPE,
      );
      if (truncado) return null;
      let mxn = 0;
      let usd = 0;
      for (const f of filas) {
        const c = unwrapOne(
          f.cuenta as { moneda?: unknown } | { moneda?: unknown }[] | null,
        );
        const cent = Math.round(Math.abs(Number(f.monto) || 0) * 100);
        // Sin la moneda de la cuenta (lectura fallida: es NOT NULL) no se
        // adivina: jamás se suman dólares como pesos.
        if (c?.moneda === 'USD') usd += cent;
        else if (c?.moneda === 'MXN') mxn += cent;
        else return null;
      }
      return {
        count: filas.length,
        monto_mxn: mxn / 100,
        monto_usd: usd / 100,
      };
    } catch (err) {
      this.logger.warn(
        `pre-cierre: omitidos de la conciliación no disponibles: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // =====================================================================
  // REVERSOS (30-sep-2026): CARGO devuelto por el banco ↔ su DEVOLUCIÓN.
  // Pregunta del cliente: «¿Cómo puedo conciliar los cargos reembolsados?».
  // Decisión PURA en `reverso-cruce.util.ts`; candado de verdad en la BD
  // (trigger `tg_mov_bancario_reverso`, migración 20260930000001). Todo lo
  // que nombre `reverso_de_id` va detrás de `reversosOn()`.
  // =====================================================================

  /** ¿Está aplicada la migración 20260930000001? (sonda única). */
  private reversosOn(): Promise<boolean> {
    return reversosDisponibles(this.supabase.service);
  }

  /** 503 `REVERSOS_NO_DISPONIBLE` si falta la migración. */
  private async assertReversos(): Promise<void> {
    if (!(await this.reversosOn())) throw errorReversosNoDisponibles();
  }

  /**
   * Columnas del par (+ `ingreso_id` y `gastos_n` detrás de SUS sondas: un
   * cargo que paga varios gastos tiene `gasto_id` null y `gastos_n ≥ 2`).
   */
  private async colsReverso(): Promise<string> {
    const [ingresos, partes] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
    ]);
    return `${MOV_REVERSO_COLS}${ingresos ? ', ingreso_id' : ''}${partes ? ', gastos_n' : ''}`;
  }

  /** Fila cruda ⇒ movimiento del par (tipos normalizados). */
  private aMovReverso(f: Record<string, unknown>): MovReversoRow {
    const s = (v: unknown): string | null =>
      typeof v === 'string' && v ? v : null;
    return {
      id: f.id as string,
      cuenta_bancaria_id: f.cuenta_bancaria_id as string,
      fecha: (s(f.fecha) ?? '').slice(0, 10),
      tipo: s(f.tipo) ?? '',
      monto: Number(f.monto) || 0,
      descripcion: s(f.descripcion),
      referencia: s(f.referencia),
      notas: s(f.notas),
      conciliado: f.conciliado === true,
      gasto_id: s(f.gasto_id),
      // Solo con la columna (sonda de partes): sin ella la fila es la de 0.0.51.
      ...(f.gastos_n !== undefined
        ? { gastos_n: Math.max(0, Math.trunc(Number(f.gastos_n) || 0)) }
        : {}),
      cobro_id: s(f.cobro_id),
      cobro_grupo_id: s(f.cobro_grupo_id),
      ingreso_id: s(f.ingreso_id),
      clasificacion_id: s(f.clasificacion_id),
      reverso_de_id: s(f.reverso_de_id),
      created_at: s(f.created_at),
    };
  }

  /** Lee un movimiento para el par; 404 estructurado si ya no existe. */
  private async leerMovReverso(id: string): Promise<MovReversoRow> {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(await this.colsReverso())
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese movimiento del banco ya no existe.',
        error: 'MOVIMIENTO_NO_EXISTE',
        details: { movimiento_id: id },
      });
    }
    return this.aMovReverso(data as unknown as Record<string, unknown>);
  }

  /** El abono que YA devuelve este cargo (null si ninguno). */
  private async abonoQueDevuelve(
    cargoId: string,
  ): Promise<MovReversoRow | null> {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(await this.colsReverso())
      .eq('reverso_de_id', cargoId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data
      ? this.aMovReverso(data as unknown as Record<string, unknown>)
      : null;
  }

  /**
   * El par cargo ↔ devolución al que pertenece un movimiento, o null. Sin la
   * migración responde null SIN consultar nada (la columna no existe).
   */
  private async parDeReverso(movId: string): Promise<{
    abono_id: string;
    cargo_id: string;
    rol: 'ABONO' | 'CARGO';
  } | null> {
    if (!(await this.reversosOn())) return null;
    const { data: propio, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, reverso_de_id')
      .eq('id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const cargoId = (propio as { reverso_de_id?: unknown } | null)
      ?.reverso_de_id;
    if (typeof cargoId === 'string' && cargoId) {
      return { abono_id: movId, cargo_id: cargoId, rol: 'ABONO' };
    }
    const { data: hijo, error: hijoErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id')
      .eq('reverso_de_id', movId)
      .limit(1)
      .maybeSingle();
    if (hijoErr) throw new Error(hijoErr.message);
    const abonoId = (hijo as { id?: unknown } | null)?.id;
    return typeof abonoId === 'string' && abonoId
      ? { abono_id: abonoId, cargo_id: movId, rol: 'CARGO' }
      : null;
  }

  /**
   * 409 `MOVIMIENTO_EN_REVERSO`: un movimiento emparejado como cargo
   * devuelto / devolución no se liga ni se desliga por los caminos de
   * gasto/cobro/clasificación — se quita el emparejamiento primero (los dos
   * vuelven a pendiente juntos).
   */
  private conflictoEnReverso(par: {
    abono_id: string;
    cargo_id: string;
    rol: 'ABONO' | 'CARGO';
  }): ConflictException {
    return new ConflictException({
      message:
        par.rol === 'ABONO'
          ? 'Este abono está conciliado como la devolución de un cargo: quita el emparejamiento («Quitar») antes de conciliarlo con otra cosa.'
          : 'Este cargo está conciliado con su devolución del banco: quita el emparejamiento («Quitar») antes de conciliarlo con otra cosa.',
      error: 'MOVIMIENTO_EN_REVERSO',
      details: { abono_id: par.abono_id, cargo_id: par.cargo_id },
    });
  }

  /** Pre-check de `link`/`linkCobro`: 409 si el movimiento está en un par. */
  private async bloquearSiEnReverso(movId: string): Promise<void> {
    const par = await this.parDeReverso(movId);
    if (par) throw this.conflictoEnReverso(par);
  }

  /** 409 `REVERSO_INVALIDO` con el motivo legible. */
  private reversoInvalido(
    motivo: string,
    details: Record<string, unknown> = {},
  ): ConflictException {
    return new ConflictException({
      message: motivo,
      error: 'REVERSO_INVALIDO',
      details: { motivo, ...details },
    });
  }

  /**
   * Id de la clasificación canónica «Reverso de un cargo»: la busca por
   * nombre (sin distinguir mayúsculas), la crea si falta y la REACTIVA si
   * alguien la dio de baja — el par SIEMPRE la lleva.
   */
  async asegurarClasificacionReverso(userId: string): Promise<string> {
    const clasif = (await this.crearClasificacion(
      CLASIFICACION_REVERSO,
      userId,
    )) as { id: string; activo?: boolean | null };
    if (clasif.activo === false) {
      const { error } = await this.supabase.service
        .from('conciliacion_clasificacion')
        .update({ activo: true })
        .eq('id', clasif.id);
      if (error) throw new Error(error.message);
    }
    return clasif.id;
  }

  /**
   * Movimientos PENDIENTES y LIBRES (sin gasto, cobro, sobre, ingreso,
   * clasificación ni devolución) de un tipo, en las cuentas, montos y
   * ventana dados. Paginado (PostgREST corta en 1000 sin avisar) con tope
   * `REVERSO_TOPE`: `truncado` lo dice y el llamador decide.
   * `conLigados` (solo CARGOS): también devuelve en `ligados` los cargos de
   * esas cuentas/montos/ventana YA explicados con dinero (gasto, cobro,
   * sobre, ingreso): nunca se emparejan, pero frenan al automático
   * (`elegirCargoReverso`, revisión adversaria 30-sep-2026).
   */
  private async movimientosLibresParaReverso(opts: {
    tipo: 'CARGO' | 'ABONO';
    cuentas: ReadonlyArray<string>;
    montos: ReadonlyArray<number>;
    desde: string;
    hasta: string;
    conLigados?: boolean;
  }): Promise<{
    filas: MovReversoRow[];
    ligados: MovReversoRow[];
    truncado: boolean;
  }> {
    const cuentas = [...new Set(opts.cuentas.filter(Boolean))];
    const montos = [
      ...new Set(opts.montos.map((m) => r2(Math.abs(Number(m) || 0)))),
    ].filter((m) => m > 0);
    if (cuentas.length === 0 || montos.length === 0) {
      return { filas: [], ligados: [], truncado: false };
    }
    const conLigados = opts.conLigados === true && opts.tipo === 'CARGO';
    const cols = await this.colsReverso();
    const { filas, truncado } = await this.leerPaginado((a, b) => {
      let q = this.supabase.service
        .from('movimiento_bancario')
        .select(cols)
        .eq('tipo', opts.tipo);
      if (!conLigados) q = q.eq('conciliado', false);
      q = q
        .gte('fecha', opts.desde)
        .lte('fecha', opts.hasta)
        .in('monto', montos);
      q =
        cuentas.length === 1
          ? q.eq('cuenta_bancaria_id', cuentas[0])
          : q.in('cuenta_bancaria_id', cuentas);
      return q
        .order('fecha', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b);
    }, REVERSO_TOPE);
    const todas = filas
      .map((f) => this.aMovReverso(f))
      .filter((m) => m.tipo === opts.tipo);
    return {
      filas: todas.filter((m) => movimientoLibreParaReverso(m)),
      ligados: conLigados ? todas.filter((m) => cargoLigadoConDinero(m)) : [],
      truncado,
    };
  }

  /**
   * Escribe el par como UNA transacción lógica: primero el ABONO (el
   * trigger valida el cargo con `for update` y el índice único lo reserva:
   * dos devoluciones no se llevan el mismo cargo), luego el CARGO. Si el
   * segundo update falla, el abono se REGRESA a como estaba (compensación).
   * Los dos llevan CAS: siguen pendientes y libres.
   */
  private async escribirParReverso(
    abono: MovReversoRow,
    cargo: MovReversoRow,
    clasifId: string,
    userId: string,
  ): Promise<{ abono: MovReversoRow; cargo: MovReversoRow }> {
    const sb = this.supabase.service;
    const cols = await this.colsReverso();
    const detalles = { abono_id: abono.id, cargo_id: cargo.id };
    const patchAbono: Record<string, unknown> = {
      reverso_de_id: cargo.id,
      clasificacion_id: clasifId,
      conciliado: true,
      gasto_id: null,
      cobro_id: null,
      cobro_grupo_id: null,
      notas: anteponerNotaReverso(abono.notas, notaAbonoReverso(cargo)),
      updated_by: userId,
    };
    const conIngresos = await this.ingresosOn();
    if (conIngresos) patchAbono.ingreso_id = null;
    // 1 cargo ↔ N gastos (2-oct-2026): «libre» también es SIN partes.
    const conPartes = await this.partesOn();
    // CAS COMPLETO (revisión adversaria 30-sep-2026): el patch pone en null
    // gasto/cobro/sobre/ingreso, así que el trigger ya no vería una liga
    // que alguien escribiera entre la lectura y este update — se exige aquí
    // que el abono SIGA libre; si no, 0 filas ⇒ 409 «cambió».
    let qAbono = sb
      .from('movimiento_bancario')
      .update(patchAbono)
      .eq('id', abono.id)
      .eq('conciliado', false)
      .is('reverso_de_id', null)
      .is('gasto_id', null)
      .is('cobro_id', null)
      .is('cobro_grupo_id', null)
      .is('clasificacion_id', null);
    if (conIngresos) qAbono = qAbono.is('ingreso_id', null);
    if (conPartes) qAbono = qAbono.eq('gastos_n', 0);
    const { data: abonoUpd, error: abErr } = await qAbono
      .select(cols)
      .maybeSingle();
    if (abErr) {
      // INTERBLOQUEO (revisión del 14-oct-2026): «Omitir» bloquea su lote
      // por id y este UPDATE bloquea el abono y luego (su trigger) el cargo;
      // si Postgres aborta ESTA operación, 409 con código estable y texto
      // es-MX (como `errorRpcOmision`), jamás el 500 de «deadlock detected».
      // Nada quedó escrito: la sentencia se revierte entera.
      if (abErr.code === '40P01') throw conflictoConcurrenteReverso();
      const motivo = motivoTriggerReverso(abErr);
      if (motivo) throw this.reversoInvalido(motivo, detalles);
      throw new Error(abErr.message);
    }
    if (!abonoUpd) {
      throw this.reversoInvalido(
        'El abono cambió mientras lo emparejabas (alguien más lo concilió): recarga la lista.',
        detalles,
      );
    }
    let qCargo = sb
      .from('movimiento_bancario')
      .update({
        clasificacion_id: clasifId,
        conciliado: true,
        notas: anteponerNotaReverso(cargo.notas, notaCargoReverso(abono)),
        updated_by: userId,
      })
      .eq('id', cargo.id)
      .eq('conciliado', false)
      .is('gasto_id', null)
      .is('clasificacion_id', null);
    if (conPartes) qCargo = qCargo.eq('gastos_n', 0);
    const { data: cargoUpd, error: cgErr } = await qCargo
      .select(cols)
      .maybeSingle();
    if (cgErr || !cargoUpd) {
      // COMPENSACIÓN: el abono vuelve a como estaba (pendiente y libre).
      const { error: rbErr } = await sb
        .from('movimiento_bancario')
        .update({
          reverso_de_id: null,
          clasificacion_id: abono.clasificacion_id ?? null,
          conciliado: abono.conciliado,
          notas: abono.notas,
          updated_by: userId,
        })
        .eq('id', abono.id)
        .eq('reverso_de_id', cargo.id);
      if (rbErr) {
        this.logger.error(
          `reverso: el cargo ${cargo.id} no se pudo conciliar y el abono ${abono.id} NO se pudo regresar a pendiente: ${rbErr.message}`,
        );
        throw new InternalServerErrorException({
          message:
            'El emparejado quedó a medias (el abono quedó conciliado y el cargo no): vuelve a intentarlo (se completa) o usa «Quitar» en el abono.',
          error: 'REVERSO_A_MEDIAS',
          details: detalles,
        });
      }
      if (cgErr) {
        if (cgErr.code === '40P01') throw conflictoConcurrenteReverso();
        const motivo = motivoTriggerReverso(cgErr);
        if (motivo) throw this.reversoInvalido(motivo, detalles);
        throw new Error(cgErr.message);
      }
      throw this.reversoInvalido(
        'El cargo cambió mientras lo emparejabas (alguien más lo concilió): recarga la lista.',
        detalles,
      );
    }
    return {
      abono: this.aMovReverso(abonoUpd as unknown as Record<string, unknown>),
      cargo: this.aMovReverso(cargoUpd as unknown as Record<string, unknown>),
    };
  }

  /**
   * Escribe SOLO el lado CARGO de un par cuyo abono ya apunta a él (par a
   * medias). CAS: el cargo sigue pendiente y libre; si no, 409.
   */
  private async completarCargoReverso(
    abono: MovReversoRow,
    cargo: MovReversoRow,
    clasifId: string,
    userId: string,
  ): Promise<MovReversoRow> {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .update({
        clasificacion_id: clasifId,
        conciliado: true,
        notas: anteponerNotaReverso(cargo.notas, notaCargoReverso(abono)),
        updated_by: userId,
      })
      .eq('id', cargo.id)
      .eq('conciliado', false)
      .is('gasto_id', null)
      .is('clasificacion_id', null);
    // 1 cargo ↔ N gastos (2-oct-2026): «libre» también es SIN partes.
    if (await this.partesOn()) q = q.eq('gastos_n', 0);
    const { data, error } = await q
      .select(await this.colsReverso())
      .maybeSingle();
    const detalles = { abono_id: abono.id, cargo_id: cargo.id };
    if (error) {
      if (error.code === '40P01') throw conflictoConcurrenteReverso();
      const motivo = motivoTriggerReverso(error);
      if (motivo) throw this.reversoInvalido(motivo, detalles);
      throw new Error(error.message);
    }
    if (!data) {
      throw this.reversoInvalido(
        'El cargo cambió mientras lo emparejabas (alguien más lo concilió): recarga la lista.',
        detalles,
      );
    }
    return this.aMovReverso(data as unknown as Record<string, unknown>);
  }

  /** Respuesta del par: filas + los aditivos `reverso_de`/`revertido_por`. */
  private respuestaPar(
    abono: MovReversoRow,
    cargo: MovReversoRow | null,
  ): {
    abono: MovReversoRow & {
      reverso_de: {
        id: string;
        fecha: string;
        descripcion: string | null;
      } | null;
    };
    cargo:
      | (MovReversoRow & {
          revertido_por: {
            id: string;
            fecha: string;
            descripcion: string | null;
          } | null;
        })
      | null;
  } {
    const emparejado = !!cargo && abono.reverso_de_id === cargo.id;
    return {
      abono: {
        ...abono,
        reverso_de: emparejado
          ? {
              id: cargo.id,
              fecha: cargo.fecha,
              descripcion: cargo.descripcion ?? null,
            }
          : null,
      },
      cargo: cargo
        ? {
            ...cargo,
            revertido_por: emparejado
              ? {
                  id: abono.id,
                  fecha: abono.fecha,
                  descripcion: abono.descripcion ?? null,
                }
              : null,
          }
        : null,
    };
  }

  /**
   * `GET movimientos/:id/reverso-candidatos` (30-sep-2026).
   * - `:id` = ABONO pendiente ⇒ CARGOS pendientes y libres de la misma
   *   cuenta y el mismo monto entre `fecha − 60 días` y `fecha`, del más
   *   reciente al más antiguo.
   * - `:id` = CARGO pendiente («Lo devolvió el banco») ⇒ ABONOS pendientes y
   *   libres de la misma cuenta y monto entre `fecha` y `fecha + 60 días`,
   *   los que traen leyenda de devolución primero.
   * `sugerido` (a lo más UNO) = el que elegiría el emparejado automático.
   */
  async candidatosReverso(movId: string): Promise<
    Array<{
      id: string;
      fecha: string;
      descripcion: string | null;
      referencia: string | null;
      monto: number;
      tipo: 'CARGO' | 'ABONO';
      es_devolucion: boolean;
      sugerido: boolean;
    }>
  > {
    await this.assertReversos();
    const mov = await this.leerMovReverso(movId);
    if (!movimientoLibreParaReverso(mov)) {
      throw new ConflictException({
        message:
          'Ese movimiento ya está conciliado: quítale la conciliación antes de emparejarlo.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: { movimiento_id: movId },
      });
    }
    const esAbono = mov.tipo === 'ABONO';
    const ventana = esAbono
      ? ventanaCargoDeAbono(mov.fecha)
      : ventanaAbonoDeCargo(mov.fecha);
    const { filas, ligados, truncado } =
      await this.movimientosLibresParaReverso({
        tipo: esAbono ? 'CARGO' : 'ABONO',
        cuentas: [mov.cuenta_bancaria_id],
        montos: [mov.monto],
        desde: ventana.desde,
        hasta: ventana.hasta,
        conLigados: esAbono,
      });
    if (truncado) {
      this.logger.warn(
        `reverso-candidatos ${movId}: la lectura llegó al tope (${REVERSO_TOPE}); la lista puede estar incompleta.`,
      );
    }
    const ficha = (m: MovReversoRow) => ({
      id: m.id,
      fecha: m.fecha,
      descripcion: m.descripcion ?? null,
      referencia: m.referencia ?? null,
      monto: r2(m.monto),
    });
    if (esAbono) {
      const candidatos = cargosCandidatosDeAbono(mov, filas).sort(
        (a, b) => -compararAntiguedad(a, b),
      );
      // `sugerido` = lo que haría el automático, con el MISMO freno de los
      // cargos ya ligados a un gasto/cobro (nunca salen en la lista).
      const decision = elegirCargoReverso(mov, candidatos, ligados);
      return candidatos.map((c) => ({
        ...ficha(c),
        tipo: 'CARGO' as const,
        es_devolucion: false,
        sugerido: decision.cargo_id === c.id,
      }));
    }
    const candidatos = abonosCandidatosDeCargo(mov, filas);
    const devoluciones = candidatos.filter((a) =>
      esDevolucionDeCargo(a.descripcion),
    );
    const sugerido =
      devoluciones.find(
        (a) => pistaFechaDevolucion(a.descripcion, a.fecha) === mov.fecha,
      ) ??
      (devoluciones.length === 1 &&
      pistaFechaDevolucion(
        devoluciones[0].descripcion,
        devoluciones[0].fecha,
      ) === null
        ? devoluciones[0]
        : null);
    return candidatos.map((a) => ({
      ...ficha(a),
      tipo: 'ABONO' as const,
      es_devolucion: esDevolucionDeCargo(a.descripcion),
      sugerido: sugerido?.id === a.id,
    }));
  }

  /**
   * `POST movimientos/:id/reverso` (30-sep-2026): empareja un CARGO con el
   * ABONO que lo devuelve. Contrato: `:id` = abono, `otroId` = cargo; se
   * acepta también al revés (el rol sale del TIPO de cada uno). Los dos
   * quedan conciliados con «Reverso de un cargo» y una nota que nombra al
   * otro. Reintento del mismo par ⇒ 200 `idempotente`. 409
   * `REVERSO_INVALIDO` (+ `details.motivo`) si no es un par válido; 404 si
   * alguno no existe; 503 sin la migración.
   */
  async emparejarReverso(
    movId: string,
    otroId: string | null | undefined,
    userId: string,
  ) {
    await this.assertReversos();
    if (!otroId) {
      throw new BadRequestException({
        message: 'Indica el cargo (cargo_id) que devuelve este abono.',
        error: 'REVERSO_SIN_PAR',
      });
    }
    if (otroId === movId) {
      throw this.reversoInvalido(
        'Un movimiento no puede ser su propia devolución.',
      );
    }
    const [a, b] = await Promise.all([
      this.leerMovReverso(movId),
      this.leerMovReverso(otroId),
    ]);
    if (a.tipo === b.tipo) {
      throw this.reversoInvalido(
        `Se empareja un CARGO con el ABONO que lo devuelve (los dos son ${a.tipo}).`,
        { movimiento_id: movId, otro_id: otroId },
      );
    }
    const abono = a.tipo === 'ABONO' ? a : b;
    const cargo = a.tipo === 'ABONO' ? b : a;
    if (abono.reverso_de_id === cargo.id) {
      if (
        !cargo.conciliado &&
        !cargo.clasificacion_id &&
        !ligadoAGasto(cargo) &&
        !cargo.cobro_id &&
        !cargo.cobro_grupo_id &&
        !cargo.ingreso_id
      ) {
        // Par A MEDIAS (el cargo no se escribió y la compensación también
        // falló, REVERSO_A_MEDIAS): el reintento lo COMPLETA en vez de
        // responder «idempotente» con el cargo todavía pendiente.
        const completo = await this.completarCargoReverso(
          abono,
          cargo,
          await this.asegurarClasificacionReverso(userId),
          userId,
        );
        return {
          ...this.respuestaPar(abono, completo),
          idempotente: false,
        };
      }
      // «Idempotente» SOLO si el cargo quedó como SU devolución (revisión
      // del 14-oct-2026): conciliado con «Reverso de un cargo» y sin otra
      // liga. Un cargo que se omitió, se clasificó con otra cosa o se ligó
      // con el abono apuntándole es un par ROTO: 409, jamás «ya estaba».
      const idReverso = await this.asegurarClasificacionReverso(userId);
      if (
        cargo.conciliado &&
        cargo.clasificacion_id === idReverso &&
        !ligadoAGasto(cargo) &&
        !cargo.cobro_id &&
        !cargo.cobro_grupo_id &&
        !cargo.ingreso_id
      ) {
        return { ...this.respuestaPar(abono, cargo), idempotente: true };
      }
      throw this.reversoInvalido(
        'El abono ya apunta a este cargo, pero el cargo ya no está como su devolución (se omitió, se clasificó o se ligó a otra cosa): quita el emparejamiento del abono y vuelve a emparejarlos.',
        { abono_id: abono.id, cargo_id: cargo.id },
      );
    }
    const devueltoPor = await this.abonoQueDevuelve(cargo.id);
    const motivo = motivoParInvalido(abono, cargo, devueltoPor?.id ?? null);
    if (motivo) {
      throw this.reversoInvalido(motivo, {
        abono_id: abono.id,
        cargo_id: cargo.id,
      });
    }
    const clasifId = await this.asegurarClasificacionReverso(userId);
    const par = await this.escribirParReverso(abono, cargo, clasifId, userId);
    return { ...this.respuestaPar(par.abono, par.cargo), idempotente: false };
  }

  /**
   * `DELETE movimientos/:id/reverso` (30-sep-2026): `:id` = el abono O el
   * cargo del par. Los DOS vuelven a PENDIENTE (sin liga, sin
   * clasificación) y se quitan de sus notas los renglones que escribió el
   * emparejado (lo de la oficina se queda). 404 `SIN_REVERSO` si el
   * movimiento no está emparejado.
   */
  async desemparejarReverso(movId: string, userId: string) {
    await this.assertReversos();
    const mov = await this.leerMovReverso(movId);
    let abono: MovReversoRow | null;
    let cargo: MovReversoRow | null;
    if (mov.reverso_de_id) {
      abono = mov;
      cargo = await this.leerMovReverso(mov.reverso_de_id).catch((e) => {
        if (e instanceof NotFoundException) return null;
        throw e;
      });
    } else {
      abono = await this.abonoQueDevuelve(mov.id);
      cargo = abono ? mov : null;
    }
    if (!abono || !abono.reverso_de_id) {
      throw new NotFoundException({
        message: 'Ese movimiento no está emparejado con ninguna devolución.',
        error: 'SIN_REVERSO',
        details: { movimiento_id: movId },
      });
    }
    const sb = this.supabase.service;
    const cols = await this.colsReverso();
    const cargoIdPrevio = abono.reverso_de_id;
    const { data: abonoUpd, error } = await sb
      .from('movimiento_bancario')
      .update({
        reverso_de_id: null,
        clasificacion_id: null,
        conciliado: false,
        notas: quitarNotaReverso(abono.notas),
        updated_by: userId,
      })
      .eq('id', abono.id)
      .eq('reverso_de_id', cargoIdPrevio)
      .select(cols)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!abonoUpd) {
      throw new ConflictException({
        message:
          'El emparejamiento cambió mientras lo quitabas: recarga la lista.',
        error: 'REVERSO_CAMBIO',
        details: { abono_id: abono.id, cargo_id: cargoIdPrevio },
      });
    }
    let cargoUpd: Record<string, unknown> | null = null;
    if (cargo) {
      let qCargo = sb
        .from('movimiento_bancario')
        .update({
          clasificacion_id: null,
          conciliado: false,
          notas: quitarNotaReverso(cargo.notas),
          updated_by: userId,
        })
        .eq('id', cargo.id)
        .is('gasto_id', null);
      // 1 cargo ↔ N gastos (2-oct-2026): jamás desconciliar un cargo con partes.
      if (await this.partesOn()) qCargo = qCargo.eq('gastos_n', 0);
      const { data, error: cgErr } = await qCargo.select(cols).maybeSingle();
      if (cgErr) {
        // COMPENSACIÓN: el abono vuelve a apuntar a su cargo.
        const { error: rbErr } = await sb
          .from('movimiento_bancario')
          .update({
            reverso_de_id: cargoIdPrevio,
            clasificacion_id: abono.clasificacion_id,
            conciliado: abono.conciliado,
            notas: abono.notas,
            updated_by: userId,
          })
          .eq('id', abono.id)
          .is('reverso_de_id', null);
        if (rbErr) {
          this.logger.error(
            `reverso: al quitar el par ${abono.id}/${cargoIdPrevio} el cargo falló y el abono no se pudo re-emparejar: ${rbErr.message}`,
          );
        }
        throw new Error(cgErr.message);
      }
      if (!data) {
        this.logger.warn(
          `reverso: al quitar el par, el cargo ${cargo.id} ya no estaba libre (¿borrado o ligado?); el abono ${abono.id} quedó pendiente.`,
        );
      }
      cargoUpd = (data as unknown as Record<string, unknown> | null) ?? null;
    }
    return {
      abono: {
        ...this.aMovReverso(abonoUpd as unknown as Record<string, unknown>),
        reverso_de: null,
      },
      cargo: cargoUpd
        ? { ...this.aMovReverso(cargoUpd), revertido_por: null }
        : null,
    };
  }

  /**
   * EMPAREJADO AUTOMÁTICO de devoluciones — fuente única de «Emparejar
   * devoluciones», del re-cruce («Cruzar pendientes») y de la importación.
   * Recibe ids de ABONOS; se RELEEN y solo siguen los que están pendientes,
   * libres y con leyenda de devolución. Lee los CARGOS pendientes y libres
   * de sus cuentas y montos en la ventana, decide `emparejarReversos`
   * (PURA) y escribe cada par con `escribirParReverso`; un par que falla se
   * cuenta como ERROR y se sigue. JAMÁS toca un cargo ligado a un gasto.
   */
  private async emparejarDevoluciones(
    abonoIds: ReadonlyArray<string>,
    userId: string,
  ): Promise<
    Array<
      DecisionReverso & {
        abono?: MovReversoRow;
        cargo?: MovReversoRow;
      }
    >
  > {
    const ids = [...new Set(abonoIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const cols = await this.colsReverso();
    const leidos = await this.leerPorLotes(ids, (lote) =>
      this.supabase.service
        .from('movimiento_bancario')
        .select(cols)
        .in('id', lote),
    );
    const abonos = leidos
      .map((f) => this.aMovReverso(f))
      .filter(
        (m) =>
          m.tipo === 'ABONO' &&
          movimientoLibreParaReverso(m) &&
          esDevolucionDeCargo(m.descripcion),
      );
    if (abonos.length === 0) return [];
    const fechas = abonos.map((a) => a.fecha).sort();
    const {
      filas: cargos,
      ligados,
      truncado,
    } = await this.movimientosLibresParaReverso({
      tipo: 'CARGO',
      cuentas: abonos.map((a) => a.cuenta_bancaria_id),
      montos: abonos.map((a) => a.monto),
      desde: sumarDiasFecha(fechas[0], -REVERSO_VENTANA_DIAS),
      hasta: fechas[fechas.length - 1],
      conLigados: true,
    });
    const porAbono = new Map(abonos.map((a) => [a.id, a]));
    if (truncado) {
      // Una foto recortada podría convertir un AMBIGUO en «único»: no se
      // empareja nada con una lectura incompleta.
      return abonos.map((a) => ({
        abono_id: a.id,
        cargo_id: null,
        resultado: 'ERROR' as const,
        motivo: `Hay más de ${REVERSO_TOPE} cargos pendientes en la ventana: acota el rango (cuenta o fechas) y vuelve a intentarlo.`,
        pista_fecha: null,
        candidatos_n: 0,
        abono: a,
      }));
    }
    const porCargo = new Map(cargos.map((c) => [c.id, c]));
    const decisiones = emparejarReversos(abonos, cargos, ligados);
    let clasifId: string | null = null;
    const out: Array<
      DecisionReverso & { abono?: MovReversoRow; cargo?: MovReversoRow }
    > = [];
    for (const d of decisiones) {
      const abono = porAbono.get(d.abono_id)!;
      const cargo = d.cargo_id ? porCargo.get(d.cargo_id) : undefined;
      if (d.resultado !== 'EMPAREJADO' || !cargo) {
        out.push({ ...d, abono });
        continue;
      }
      try {
        clasifId ??= await this.asegurarClasificacionReverso(userId);
        const par = await this.escribirParReverso(
          abono,
          cargo,
          clasifId,
          userId,
        );
        out.push({ ...d, abono: par.abono, cargo: par.cargo });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `reverso automático ${abono.id} → ${cargo.id}: ${msg}`,
        );
        out.push({
          ...d,
          cargo_id: null,
          resultado: 'ERROR',
          motivo: msg,
          abono,
        });
      }
    }
    return out;
  }

  /**
   * `POST reversos/auto` (30-sep-2026, botón «Emparejar devoluciones»):
   * empareja SOLAS las devoluciones del banco (abonos pendientes con
   * leyenda CARGO INDEBIDO / DEVOLUCION / REVERSO / CONTRACARGO / ABONO POR
   * ACLARACION / RECLAMACION / «REV …») con su cargo. Default: abonos de
   * los últimos 90 días (hora Cancún) de todas las cuentas.
   */
  async autoReversos(dto: AutoReversosDto, userId: string) {
    await this.assertReversos();
    const hasta = dto.hasta ?? hoyCancun();
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const { filas, truncado } = await this.leerPaginado((a, b) => {
      let q = this.supabase.service
        .from('movimiento_bancario')
        .select('id, descripcion')
        .eq('tipo', TipoMovimientoBancario.ABONO)
        .eq('conciliado', false)
        .gte('fecha', desde)
        .lte('fecha', hasta);
      if (dto.cuenta_bancaria_id)
        q = q.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
      return q
        .order('fecha', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b);
    }, REVERSO_TOPE);
    if (truncado) {
      throw new BadRequestException({
        message: `Hay más de ${REVERSO_TOPE} abonos pendientes en el rango: acótalo (cuenta o fechas).`,
        error: 'PERIODO_MUY_GRANDE',
      });
    }
    const ids = filas
      .filter((f) => esDevolucionDeCargo(f.descripcion as string | null))
      .map((f) => f.id as string);
    const decisiones = await this.emparejarDevoluciones(ids, userId);
    const cuenta = (r: DecisionReverso['resultado']) =>
      decisiones.filter((d) => d.resultado === r).length;
    return {
      revisados: decisiones.length,
      emparejados: cuenta('EMPAREJADO'),
      sin_candidato: cuenta('SIN_CANDIDATO'),
      ambiguos: cuenta('AMBIGUO'),
      errores: cuenta('ERROR'),
      desde,
      hasta,
      cuenta_bancaria_id: dto.cuenta_bancaria_id ?? null,
      detalle: decisiones.slice(0, DETALLE_MAX).map((d) => ({
        abono_id: d.abono_id,
        cargo_id: d.resultado === 'EMPAREJADO' ? d.cargo_id : null,
        resultado: d.resultado,
        motivo: d.motivo,
        pista_fecha: d.pista_fecha,
        candidatos_n: d.candidatos_n,
        abono_fecha: d.abono?.fecha ?? null,
        abono_descripcion: d.abono?.descripcion ?? null,
        cargo_fecha:
          d.resultado === 'EMPAREJADO' ? (d.cargo?.fecha ?? null) : null,
        cargo_descripcion:
          d.resultado === 'EMPAREJADO' ? (d.cargo?.descripcion ?? null) : null,
      })),
      detalle_truncado: decisiones.length > DETALLE_MAX,
    };
  }

  /**
   * Emparejado de devoluciones DENTRO de una corrida del auto-cruce
   * (importación y «Cruzar pendientes»). Corre DESPUÉS del cruce contra
   * gastos/cobros —esos tienen prioridad; el reverso solo toma lo que nadie
   * explicó— y REEMPLAZA el resultado de los movimientos emparejados por
   * `REVERSO` (criterio `REVERSO`). Para una devolución que no se pudo
   * emparejar y que el cruce dejó SIN_CANDIDATO, el motivo pasa a ser el
   * del reverso (dice por qué: sin cargo o ambiguo). Best-effort: un fallo
   * aquí NUNCA tumba la corrida (se registra y se sigue con lo de antes).
   * Devuelve cuántos PARES se emparejaron.
   */
  private async aplicarReversosEnCorrida(
    movs: ReadonlyArray<{ id: string; tipo: string }>,
    resultados: ResultadoMovimiento[],
    userId: string,
  ): Promise<number> {
    try {
      if (!(await this.reversosOn())) return 0;
      const indice = new Map(resultados.map((r, i) => [r.movimiento_id, i]));
      const yaConciliado = new Set<ResultadoCruce>(['CONCILIADO', 'TRASPASO']);
      const abonoIds = movs
        .filter((m) => {
          if (m.tipo !== (TipoMovimientoBancario.ABONO as string)) return false;
          const i = indice.get(m.id);
          return i === undefined || !yaConciliado.has(resultados[i].resultado);
        })
        .map((m) => m.id);
      if (abonoIds.length === 0) return 0;
      const decisiones = await this.emparejarDevoluciones(abonoIds, userId);
      let pares = 0;
      for (const d of decisiones) {
        const iA = indice.get(d.abono_id);
        if (d.resultado === 'EMPAREJADO' && d.cargo_id && d.cargo) {
          pares += 1;
          const cargo = d.cargo;
          const abono = d.abono;
          if (iA !== undefined) {
            resultados[iA] = {
              movimiento_id: d.abono_id,
              resultado: 'REVERSO',
              criterio: 'REVERSO',
              motivo: `${notaAbonoReverso(cargo)}.`,
              candidatos_n: d.candidatos_n,
              reverso_de_id: cargo.id,
            };
          }
          const iC = indice.get(cargo.id);
          if (iC !== undefined && abono) {
            resultados[iC] = {
              movimiento_id: cargo.id,
              resultado: 'REVERSO',
              criterio: 'REVERSO',
              motivo: `${notaCargoReverso(abono)}.`,
              candidatos_n: 0,
              reverso_par_id: abono.id,
            };
          }
          continue;
        }
        if (
          iA !== undefined &&
          (d.resultado === 'SIN_CANDIDATO' || d.resultado === 'AMBIGUO') &&
          resultados[iA].resultado === 'SIN_CANDIDATO'
        ) {
          resultados[iA] = {
            ...resultados[iA],
            resultado: d.resultado,
            criterio: null,
            motivo: `Devolución de un cargo: ${d.motivo}`,
            candidatos_n: d.candidatos_n,
          };
        }
      }
      return pares;
    } catch (err) {
      this.logger.error(
        `emparejado de devoluciones en la corrida: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * ADITIVOS de la lista y el reporte (30-sep-2026): `reverso_de` en el
   * ABONO (el cargo que devuelve) y `revertido_por` en el CARGO (su
   * devolución), `{id, fecha, descripcion}` o null. DOS lecturas en lote
   * por página (≤ 200 ids por consulta), nunca una por fila. Si fallan se
   * quedan en null y el «Conciliado con» cae a la clasificación, que dice
   * lo mismo sin la otra fecha.
   */
  private async anotarReversos(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    for (const f of filas) {
      f.reverso_de = null;
      f.revertido_por = null;
    }
    if (!(await this.reversosOn())) return;
    const abonos = filas.filter(
      (f) => typeof f.reverso_de_id === 'string' && f.reverso_de_id,
    );
    const cargos = filas.filter(
      (f) =>
        f.tipo === (TipoMovimientoBancario.CARGO as string) &&
        f.conciliado === true &&
        !!f.clasificacion_id,
    );
    if (abonos.length === 0 && cargos.length === 0) return;
    const sb = this.supabase.service;
    const ficha = (m: Record<string, unknown>) => ({
      id: m.id as string,
      fecha: (typeof m.fecha === 'string' ? m.fecha : '').slice(0, 10),
      descripcion: (m.descripcion as string | null) ?? null,
    });
    try {
      const [deCargos, deAbonos] = await Promise.all([
        this.leerPorLotes(
          abonos.map((f) => f.reverso_de_id as string),
          (lote) =>
            sb
              .from('movimiento_bancario')
              .select('id, fecha, descripcion')
              .in('id', lote),
        ),
        this.leerPorLotes(
          cargos.map((f) => f.id as string),
          (lote) =>
            sb
              .from('movimiento_bancario')
              .select('id, fecha, descripcion, reverso_de_id')
              .in('reverso_de_id', lote),
        ),
      ]);
      const cargoPorId = new Map(deCargos.map((c) => [c.id as string, c]));
      const abonoPorCargo = new Map(
        deAbonos
          .filter((a) => typeof a.reverso_de_id === 'string')
          .map((a) => [a.reverso_de_id as string, a]),
      );
      for (const f of abonos) {
        const c = cargoPorId.get(f.reverso_de_id as string);
        if (c) f.reverso_de = ficha(c);
      }
      for (const f of cargos) {
        const a = abonoPorCargo.get(f.id as string);
        if (a) f.revertido_por = ficha(a);
      }
    } catch (err) {
      this.logger.warn(
        `No se pudieron anotar los reversos de la página: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Resumen por cuenta para el cierre: cuántos movimientos hay, cuántos están
   * conciliados y cuánto dinero sigue pendiente. "Faltan N por conciliar" deja
   * de descubrirse revisando la lista a mano.
   */
  /**
   * El INVERSO de la bandeja de movimientos (28-ago, pedido del cliente):
   * gastos pagados por BANCO (tarjeta corporativa / transferencia / PayWise)
   * que no
   * cruzaron con ninguna línea de los estados de cuenta importados. Motivos
   * típicos: el periodo del banco aún no se importa, la fecha/monto del
   * gasto no coincide, o el cargo nunca llegó al banco. Default: últimos
   * 90 días por fecha_gasto (DATE, sin componente horaria).
   */
  /**
   * Suma de |monto| de los cargos del banco ligados a cada gasto (pagos
   * parciales, 14-sep-2026). Devuelve solo los gastos CON algún cargo; los
   * demás valen 0. Se consulta por lotes (`in`) para no disparar una
   * consulta por fila.
   */
  private async sumasLigadasDe(
    gastoIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(gastoIds.filter(Boolean))];
    // 1 cargo ↔ N gastos (2-oct-2026): con la puente, lo vinculado sale de
    // `v_gasto_conciliacion` (Σ `monto_parte` no cruzadas; una parte
    // cruzada ⇒ el monto del gasto) — NUNCA el |monto| del movimiento: un
    // SPEI de $8,404.20 que paga tres gastos aporta $2,801.40 a cada uno.
    if (await this.partesOn()) {
      const estados = await this.estadosVistaDe(ids);
      for (const [gid, e] of estados) {
        if (e.n_partes > 0 || e.monto_vinculado > 0) {
          out.set(gid, e.monto_vinculado);
        }
      }
      return out;
    }
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await this.supabase.service
        .from('movimiento_bancario')
        .select('gasto_id, monto')
        .in('gasto_id', ids.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const m of data ?? []) {
        const gid = m.gasto_id as string | null;
        if (!gid) continue;
        out.set(
          gid,
          r2((out.get(gid) ?? 0) + (Math.abs(Number(m.monto)) || 0)),
        );
      }
    }
    return out;
  }

  async gastosSinBanco(desde?: string, hasta?: string) {
    // Default en día CANCÚN (no UTC), igual que `cobrosSinBanco`: a las
    // 20:00 de Cancún el UTC ya es mañana y el corte se corría un día
    // (invariante 4).
    // INICIO OFICIAL (invariante 86): el default (hoy − 90 d) y un `desde`
    // explícito suben al inicio.
    const d = await this.pisoDesde(
      desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000)),
    );
    let q = this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, categoria, monto, moneda, tc_gasto, medio_pago, tarjeta_terminacion, lugar, conciliado, proveedor:proveedor!proveedor_id(nombre), captura:usuario!usuario_captura_id(nombre), vuelo:vuelo!vuelo_id(folio)',
        { count: 'exact' },
      )
      .in('medio_pago', MEDIOS_BANCARIOS)
      .eq('conciliado', false)
      .gte('fecha_gasto', d)
      .order('fecha_gasto', { ascending: false })
      .limit(500);
    if (hasta) q = q.lte('fecha_gasto', hasta);
    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    // Pagos PARCIALES (14-sep-2026): un gasto sigue aquí mientras la suma de
    // sus cargos no lo cubra — con lo ya vinculado y lo que falta, para que
    // la oficina no lo lea como "sin nada del banco".
    const vinculado = await this.sumasLigadasDe(
      rows.map((g) => g.id as string),
    );
    // Totales por moneda NATIVA (jamás convertir aquí: es un listado de
    // faltantes, no un balance).
    const porMoneda = new Map<string, number>();
    for (const g of rows) {
      const mon = (g.moneda as string) ?? 'MXN';
      porMoneda.set(mon, (porMoneda.get(mon) ?? 0) + Number(g.monto));
      const suma = vinculado.get(g.id as string) ?? 0;
      g.monto_vinculado = suma;
      g.faltante = faltanteDe(Number(g.monto), suma);
      g.parcial = suma > 0;
    }
    return {
      data: rows,
      total: count ?? rows.length,
      desde: d,
      hasta: hasta ?? null,
      por_moneda: [...porMoneda.entries()].map(([moneda, monto]) => ({
        moneda,
        monto: Math.round(monto * 100) / 100,
      })),
    };
  }

  async resumen(desde?: string, hasta?: string) {
    // 1 cargo ↔ N gastos (2-oct-2026): con la migración, `gastos_n` para el
    // ADITIVO `diferencia_lotes` por cuenta.
    const conPartes = await this.partesOn();
    // OMITIDOS (14-oct-2026, invariante 75): `clasificacion_id` para contar
    // los omitidos por cuenta (ADITIVOS `omitidos` / `monto_omitido`).
    const colsResumen: string = conPartes
      ? 'id, cuenta_bancaria_id, tipo, monto, conciliado, clasificacion_id, gastos_n'
      : 'id, cuenta_bancaria_id, tipo, monto, conciliado, clasificacion_id';
    // PAGINADO por la PK (revisión del lote 2, 14-oct-2026): la vista por
    // default de Conciliación (sin ?desde/?hasta) lee TODA la tabla y
    // PostgREST corta en max-rows = 1000 SIN avisar — con la fila 1,001 las
    // tarjetas por cuenta (total, pendientes, monto pendiente,
    // `diferencia_lotes`) salían de un subconjunto arbitrario y la oficina
    // creía la conciliación más avanzada (prod: 999 movimientos el 14-oct).
    // Llegar al tope ⇒ 400 explícito, jamás un total recortado.
    // INICIO OFICIAL (invariante 86): conteos por periodo, con piso.
    const desdeResumen = pisoDia(
      desde,
      await inicioOficialDe(this.configuracion),
    );
    const { filas: data, truncado } = await this.leerPaginado((a, b) => {
      let q = this.supabase.service
        .from('movimiento_bancario')
        .select(colsResumen);
      if (desdeResumen) q = q.gte('fecha', desdeResumen);
      if (hasta) q = q.lte('fecha', hasta);
      return q.order('id', { ascending: true }).range(a, b);
    }, RESUMEN_MOVIMIENTOS_TOPE);
    if (truncado) {
      throw new BadRequestException({
        message: MENSAJE_RESUMEN_MUY_GRANDE,
        error: 'RESUMEN_MUY_GRANDE',
      });
    }
    const difLotes = conPartes
      ? await this.diferenciaLotesPorCuenta(data)
      : null;
    // Sin la canónica ⇒ 0; si su lectura falla ⇒ null (jamás un 0 inventado).
    const omitidoResumen = await this.leerIdClasificacionOmitido();

    const { data: cuentas } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda');
    const cuentaInfo = new Map(
      (cuentas ?? []).map((c) => [
        c.id as string,
        c as Record<string, unknown>,
      ]),
    );

    const porCuenta = new Map<
      string,
      {
        total: number;
        conciliados: number;
        pendientes: number;
        monto_pendiente: number;
        omitidos: number;
        monto_omitido_cent: number;
      }
    >();
    for (const m of data) {
      const key = m.cuenta_bancaria_id as string;
      const cur = porCuenta.get(key) ?? {
        total: 0,
        conciliados: 0,
        pendientes: 0,
        monto_pendiente: 0,
        omitidos: 0,
        monto_omitido_cent: 0,
      };
      cur.total += 1;
      if (m.conciliado === true) cur.conciliados += 1;
      else {
        cur.pendientes += 1;
        cur.monto_pendiente += Number(m.monto);
      }
      if (omitidoResumen.id && m.clasificacion_id === omitidoResumen.id) {
        cur.omitidos += 1;
        cur.monto_omitido_cent += Math.round(
          Math.abs(Number(m.monto) || 0) * 100,
        );
      }
      porCuenta.set(key, cur);
    }

    return [...porCuenta.entries()].map(([id, v]) => {
      const info = cuentaInfo.get(id);
      return {
        cuenta_bancaria_id: id,
        alias: (info?.alias as string) ?? null,
        banco: (info?.banco as string) ?? null,
        moneda: (info?.moneda as string) ?? null,
        total: v.total,
        conciliados: v.conciliados,
        pendientes: v.pendientes,
        monto_pendiente: Math.round(v.monto_pendiente * 100) / 100,
        // ADITIVO (2-oct-2026, solo con la migración de partes): Σ de
        // `gastos_diferencia` de los cargos con ≥ 2 gastos (el centavo de
        // SAESA). null = no se pudo leer; jamás se ajusta un gasto.
        ...(difLotes
          ? { diferencia_lotes: difLotes.has(id) ? difLotes.get(id) : 0 }
          : {}),
        // ADITIVOS (0.0.77, invariante 75): los «conciliados» INCLUYEN a los
        // omitidos y la tarjeta lo dice. null = no se pudo leer la canónica.
        omitidos: omitidoResumen.fallo ? null : v.omitidos,
        monto_omitido: omitidoResumen.fallo ? null : v.monto_omitido_cent / 100,
      };
    });
  }

  /**
   * Σ `gastos_diferencia` por cuenta de los cargos con ≥ 2 gastos (lote).
   * Una lectura de partes en lote; si falla, `diferencia_lotes: null` en
   * todas las cuentas (no se inventa un 0).
   */
  private async diferenciaLotesPorCuenta(
    movs: Array<Record<string, unknown>>,
  ): Promise<Map<string, number | null>> {
    const lotes = movs.filter((m) => Number(m.gastos_n) >= 2);
    const out = new Map<string, number | null>();
    try {
      const partes = await this.partesDeMovimientos(
        lotes.map((m) => m.id as string),
      );
      const porMov = new Map<string, ParteCargoGasto[]>();
      for (const p of partes) {
        const l = porMov.get(p.movimiento_id) ?? [];
        l.push(p);
        porMov.set(p.movimiento_id, l);
      }
      for (const m of lotes) {
        const dif = diferenciaLote(
          Number(m.monto) || 0,
          (porMov.get(m.id as string) ?? []).map((p) => ({
            monto_parte: p.monto_parte,
          })),
        );
        if (dif == null) continue;
        const cta = m.cuenta_bancaria_id as string;
        out.set(cta, r2((out.get(cta) ?? 0) + dif));
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo calcular la diferencia de los lotes: ${err instanceof Error ? err.message : String(err)}`,
      );
      for (const m of movs) out.set(m.cuenta_bancaria_id as string, null);
    }
    return out;
  }

  /**
   * Reporte de conciliación en Excel: réplica del estado de cuenta (una fila
   * por movimiento, cargos y abonos en columnas) con el ESTATUS de cada línea
   * (Conciliado/PENDIENTE), la MATRÍCULA del avión de la línea y con qué se
   * cruzó (gasto o cobro, con su vuelo). Los montos SIN conciliar van
   * resaltados en naranja. `estado` refleja las 4 pestañas de la página;
   * `sin_banco` cambia de universo (gastos bancarios que no aparecen en el
   * banco) y ahí la cuenta bancaria se IGNORA.
   */
  /**
   * INICIO OFICIAL (invariante 86, forma R): periodo subido en consulta,
   * título y nombre de archivo (`desde` devuelto, ADITIVO); uno anterior ⇒
   * 400 PERIODO_ANTES_DEL_INICIO.
   */
  async reporteXlsx(
    cuentaBancariaId: string | undefined,
    desdePedido: string,
    hasta: string,
    estado: ReporteConciliacionEstado = 'todos',
  ): Promise<{ buffer: Buffer; etiqueta: string; desde: string }> {
    const { desde } = exigirPeriodoDesdeInicio(
      desdePedido,
      hasta,
      await inicioOficialDe(this.configuracion),
    );
    const r = await this.reporteXlsxPeriodo(
      cuentaBancariaId,
      desde,
      hasta,
      estado,
    );
    return { ...r, desde };
  }

  private async reporteXlsxPeriodo(
    cuentaBancariaId: string | undefined,
    desde: string,
    hasta: string,
    estado: ReporteConciliacionEstado,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    if (estado === 'sin_banco') {
      return this.reporteGastosSinBancoXlsx(desde, hasta);
    }
    if (!cuentaBancariaId) {
      throw new BadRequestException(
        'cuenta_bancaria_id es requerida (salvo estado=sin_banco).',
      );
    }
    const { data: cuenta, error: ctaErr } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda')
      .eq('id', cuentaBancariaId)
      .maybeSingle();
    if (ctaErr) throw new Error(ctaErr.message);
    if (!cuenta)
      throw new NotFoundException(`Cuenta ${cuentaBancariaId} not found`);

    // INGRESOS (24-sep-2026): con la migración, la liga a un ingreso
    // también dice «con qué se cruzó».
    const embedIngresoReporte: string = (await this.ingresosOn())
      ? ', ingreso_id, ingreso:ingreso!ingreso_id(folio, categoria, descripcion)'
      : '';
    // REVERSOS (30-sep-2026): «Conciliado con» nombra al otro del par.
    const colReversoReporte: string = (await this.reversosOn())
      ? ', reverso_de_id'
      : '';
    // 1 cargo ↔ N gastos (2-oct-2026): «Conciliado con» y «Matrícula» de un
    // cargo que paga VARIOS gastos salen de la puente.
    const conPartesReporte = await this.partesOn();
    const colPartesReporte: string = conPartesReporte ? ', gastos_n' : '';
    // 1 abono ↔ N cobros (12-oct-2026): «Conciliado con» y «Matrícula» de un
    // abono que paga VARIOS cobros salen de la puente.
    const conCobrosReporte = await this.cobrosLoteOn();
    const colCobrosReporte: string = conCobrosReporte ? ', cobros_n' : '';
    // NÚMERO DE FACTURA (5-oct-2026): «Notas» lleva la factura del gasto.
    const embedFolioReporte = await this.embedFolio();
    // ORDEN DEL ARCHIVO (12-oct-2026, invariante 55): de qué estado de
    // cuenta salió cada línea y en qué posición (la columna, con la sonda).
    const colOrdenReporte: string = (await this.ordenArchivoOn())
      ? ', estado_cuenta_id, orden_archivo'
      : ', estado_cuenta_id';
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // escala_id/aeronave_id del gasto y aeronave_id de los vuelos: para
        // resolver la MATRÍCULA de la línea (avionDelGasto, fuente única).
        `${MOV_COLS}${embedIngresoReporte}${colReversoReporte}${colPartesReporte}${colCobrosReporte}${colOrdenReporte}, gasto:gasto!gasto_id(categoria, vuelo_id, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id), ${embedFolioReporte}), cobro:cobro_vuelo!cobro_id(metodo_cobro, vuelo:vuelo!vuelo_id(folio, aeronave_id)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
      )
      .eq('cuenta_bancaria_id', cuentaBancariaId)
      // `fecha` es DATE-only: se compara con YYYY-MM-DD a secas.
      .gte('fecha', desde)
      .lte('fecha', hasta)
      // Orden del estado de cuenta impreso: cronológico ascendente.
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000);
    // Filtro de estado (mismas pestañas del panel). En movimiento_bancario
    // "pendiente" y "no conciliado" son el MISMO booleano.
    if (estado === 'pendientes') q = q.eq('conciliado', false);
    if (estado === 'conciliados') q = q.eq('conciliado', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    // Sobres de grupo normalizados (SOBRE_GRUPO con aviones_n). Y en el
    // ORDEN DEL ESTADO DE CUENTA (12-oct-2026, invariante 55): el del archivo
    // cuando todas las líneas salieron del mismo; si no, cronológico.
    const movs = ordenarComoEstadoDeCuenta(
      await this.normalizarSobresEnMovs(
        (data ?? []) as unknown as Array<Record<string, unknown>>,
      ),
    );
    // Par cargo devuelto ↔ devolución (30-sep-2026): la otra fecha y leyenda.
    await this.anotarReversos(movs);

    // Lotes (2-oct-2026): partes y gastos de los cargos con ≥ 2 gastos, en
    // lote. Un fallo TUMBA el reporte (un «Conciliado con» vacío diría que
    // el cargo no se explicó).
    type GastoReporte = {
      id: string;
      categoria?: string | null;
      escala_id?: string | null;
      aeronave_id?: string | null;
      proveedor?: { nombre?: string } | { nombre?: string }[] | null;
      vuelo?:
        | { folio?: number; aeronave_id?: string | null }
        | { folio?: number; aeronave_id?: string | null }[]
        | null;
      /** Número de factura (`embedFolioGasto`, 5-oct-2026). */
      folio_ticket?: string | null;
      ia_folio?: string | null;
      factura?: unknown;
    };
    const lotes = new Map<
      string,
      Array<{ parte: ParteCargoGasto; gasto: GastoReporte | null }>
    >();
    if (conPartesReporte) {
      const movsLote = movs.filter((m) => Number(m.gastos_n) >= 2);
      if (movsLote.length > 0) {
        const partes = await this.partesDeMovimientos(
          movsLote.map((m) => m.id as string),
        );
        const gastos = await this.leerPorLotes(
          [...new Set(partes.map((p) => p.gasto_id))],
          (lote) =>
            this.supabase.service
              .from('gasto')
              .select(`${GASTO_PARTE_REPORTE_COLS}, ${embedFolioReporte}`)
              .in('id', lote),
        );
        const gastoDe = new Map(
          gastos.map((g) => [g.id as string, g as unknown as GastoReporte]),
        );
        for (const p of partes) {
          const l = lotes.get(p.movimiento_id) ?? [];
          l.push({ parte: p, gasto: gastoDe.get(p.gasto_id) ?? null });
          lotes.set(p.movimiento_id, l);
        }
      }
    }
    const gastosDeLotes = [...lotes.values()].flat();

    // Lotes de COBROS (12-oct-2026): partes y vuelos de los abonos con 2+
    // cobros, en lote. Un fallo TUMBA el reporte (como con los gastos).
    // UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): + la COBERTURA de
    // TODOS los cobros del reporte (los de un lote y los de un abono con UN
    // cobro) en UNA lectura del lector único: «Conciliado con» dice si el
    // abono deja el cobro parcial, lo completa o trae de más. Si falla, el
    // reporte también se TUMBA (un «Conciliado con» incompleto diría que el
    // abono explica el cobro entero).
    const lotesCobros = new Map<
      string,
      Array<{
        cobro_id: string;
        monto_parte: number;
        folio: number | null;
        cliente: string | null;
        aeronave_id: string | null;
        neto: number | null;
        completa: boolean | null;
      }>
    >();
    const cobroDeReporte = new Map<string, Record<string, unknown>>();
    let partesDeCobrosReporte = new Map<string, ParteCobroBanco[]>();
    {
      const movsLoteCobros = conCobrosReporte
        ? movs.filter((m) => Number(m.cobros_n) >= 2)
        : [];
      const partes =
        movsLoteCobros.length > 0
          ? await partesDeAbonos(
              this.supabase.service,
              movsLoteCobros.map((m) => m.id as string),
            )
          : [];
      const cobroIds = [
        ...new Set([
          ...partes.map((p) => p.cobro_id),
          ...movs
            .map((m) => m.cobro_id)
            .filter((x): x is string => typeof x === 'string' && !!x),
        ]),
      ];
      if (cobroIds.length > 0) {
        const [filasCobro, partesCobro] = await Promise.all([
          this.leerPorLotes(cobroIds, (lote) =>
            this.supabase.service
              .from('cobro_vuelo')
              .select(
                'id, monto, moneda, comision_banco_monto, metodo_cobro, vuelo:vuelo!vuelo_id(folio, aeronave_id, cliente:cliente_id(nombre))',
              )
              .in('id', lote),
          ),
          // Con la puente: SOLO la puente (todas las partes de esos cobros);
          // sin ella, el espejo (parte = |abono|). Una lectura en cada caso.
          conCobrosReporte
            ? leerPartesDeCobros(this.supabase.service, cobroIds)
            : leerLigasDeCobros(this.supabase.service, {
                cobroIds,
                conPuente: false,
              }).then((ligas) => partesDeLigas(ligas)),
        ]);
        for (const c of filasCobro) cobroDeReporte.set(String(c.id), c);
        partesDeCobrosReporte = partesCobro;
      }
      for (const p of partes) {
        const c = cobroDeReporte.get(p.cobro_id);
        const vuelo = unwrapOne(
          c?.vuelo as {
            folio?: unknown;
            aeronave_id?: unknown;
            cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
          } | null,
        );
        const cliente = unwrapOne(vuelo?.cliente);
        const cob = c
          ? coberturaCobro(c, partesDeCobrosReporte.get(p.cobro_id) ?? [])
          : null;
        const l = lotesCobros.get(p.movimiento_id) ?? [];
        l.push({
          cobro_id: p.cobro_id,
          monto_parte: p.monto_parte,
          folio: vuelo?.folio == null ? null : Number(vuelo.folio),
          cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
          aeronave_id:
            typeof vuelo?.aeronave_id === 'string' ? vuelo.aeronave_id : null,
          neto: cob ? cob.neto : null,
          completa: cob ? cob.cubierto : null,
        });
        lotesCobros.set(p.movimiento_id, l);
      }
    }

    // Mapas para la matrícula: repartos manuales de los gastos ligados y
    // aeronave/escala (patrón del Libro Dinero; la herencia escala→vuelo la
    // aplica avionDelGasto).
    const [repartos, mapas] = await Promise.all([
      fetchRepartos(this.supabase.service, [
        ...movs
          .map((m) => m.gasto_id as string | null)
          .filter((id): id is string => !!id),
        ...gastosDeLotes.map((x) => x.parte.gasto_id),
      ]),
      this.cargarMapasAvion([
        ...movs
          .map(
            (m) =>
              unwrapOne(m.gasto as { escala_id?: string | null } | null)
                ?.escala_id ?? null,
          )
          .filter((id): id is string => !!id),
        ...gastosDeLotes
          .map((x) => x.gasto?.escala_id ?? null)
          .filter((id): id is string => !!id),
      ]),
    ]);

    /** «Matrícula» de un lote: unión de las de sus gastos con «+». */
    const matriculaDeLote = (
      partes: Array<{ parte: ParteCargoGasto; gasto: GastoReporte | null }>,
    ): string => {
      const mats = new Set<string>();
      for (const { parte, gasto } of partes) {
        if (!gasto) continue;
        const m = this.matriculaDeGasto(
          parte.gasto_id,
          gasto,
          unwrapOne(gasto.vuelo)?.aeronave_id ?? null,
          repartos,
          mapas,
        );
        for (const x of m.split(' + ')) if (x) mats.add(x);
      }
      return [...mats].join(' + ');
    };

    const matriculaDeMov = (m: Record<string, unknown>): string => {
      const lote = lotes.get(m.id as string);
      if (lote && lote.length >= 2) return matriculaDeLote(lote);
      // Lote de COBROS: unión de las matrículas de sus vuelos con «+».
      const loteCobros = lotesCobros.get(m.id as string);
      if (loteCobros && loteCobros.length >= 2) {
        const mats = new Set<string>();
        for (const c of loteCobros) {
          const mat = c.aeronave_id
            ? (mapas.matriculas.get(c.aeronave_id) ?? '')
            : '';
          if (mat) mats.add(mat);
        }
        return [...mats].join(' + ');
      }
      const gasto = unwrapOne(
        m.gasto as {
          escala_id?: string | null;
          aeronave_id?: string | null;
          vuelo?:
            | { aeronave_id?: string | null }
            | { aeronave_id?: string | null }[]
            | null;
        } | null,
      );
      if (gasto) {
        return this.matriculaDeGasto(
          m.gasto_id as string | null,
          gasto,
          unwrapOne(gasto.vuelo)?.aeronave_id ?? null,
          repartos,
          mapas,
        );
      }
      // SOBRE de grupo: el pago cubre N aviones (no hay UNA matrícula).
      const sobre = m.cobro_grupo as SobreConciliacion | null;
      if (sobre) {
        return sobre.aviones_n > 0
          ? `${sobre.aviones_n} avión${sobre.aviones_n === 1 ? '' : 'es'}`
          : '';
      }
      // Línea de COBRO: el avión (principal) de su vuelo.
      const cobro = unwrapOne(
        m.cobro as {
          vuelo?:
            | { aeronave_id?: string | null }
            | { aeronave_id?: string | null }[]
            | null;
        } | null,
      );
      const avionId = unwrapOne(cobro?.vuelo)?.aeronave_id ?? null;
      return avionId ? (mapas.matriculas.get(avionId) ?? '') : '';
    };

    const conQue = (m: Record<string, unknown>): string => {
      // LOTE de COBROS (12-oct-2026): «2 cobros: vuelo #379 ($1,000.00) · …».
      const loteCobros = lotesCobros.get(m.id as string);
      if (loteCobros && loteCobros.length >= 2) {
        return etiquetaConciliadoCobros(
          loteCobros,
          diferenciaLoteCobros(Number(m.monto) || 0, loteCobros),
        );
      }
      // LOTE: «3 gastos: Operaciones · vuelo #315 ($2,801.40) · …».
      const lote = lotes.get(m.id as string);
      if (lote && lote.length >= 2) {
        return etiquetaConciliadoLote(
          lote.map(({ parte, gasto }) => ({
            categoria: etiquetaCategoriaGasto(gasto?.categoria ?? null),
            proveedor: unwrapOne(gasto?.proveedor ?? null)?.nombre ?? null,
            vuelo_folio: unwrapOne(gasto?.vuelo ?? null)?.folio ?? null,
            monto_parte: parte.monto_parte,
          })),
          diferenciaLote(
            Number(m.monto) || 0,
            lote.map(({ parte }) => ({ monto_parte: parte.monto_parte })),
          ),
        );
      }
      const gasto = unwrapOne(
        m.gasto as {
          categoria?: string;
          proveedor?: { nombre?: string } | { nombre?: string }[] | null;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (gasto) {
        const prov = unwrapOne(gasto.proveedor)?.nombre;
        const folio = unwrapOne(gasto.vuelo)?.folio;
        // "Gasto Comida"; una etiqueta que ya empieza con "Gasto…" no se
        // duplica (fuente única categoria-gasto.util).
        const etiquetaCat = etiquetaCategoriaGasto(gasto.categoria);
        return [
          /^gasto/i.test(etiquetaCat)
            ? etiquetaCat
            : `Gasto ${etiquetaCat}`.trim(),
          prov ?? null,
          folio != null ? `vuelo #${folio}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      const sobre = m.cobro_grupo as SobreConciliacion | null;
      if (sobre) {
        return `Cobro grupo G-${sobre.grupo_folio ?? '?'} · ${etiquetaMetodoCobro(sobre.metodo)}`;
      }
      const cobro = unwrapOne(
        m.cobro as {
          metodo_cobro?: string;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (cobro) {
        const folio = unwrapOne(cobro.vuelo)?.folio;
        // UN COBRO, VARIOS ABONOS (0.0.78): parcial / N de N / de más.
        const cobroId = typeof m.cobro_id === 'string' ? m.cobro_id : null;
        const ficha = cobroId ? cobroDeReporte.get(cobroId) : undefined;
        const partesCobro = cobroId
          ? (partesDeCobrosReporte.get(cobroId) ?? [])
          : [];
        if (ficha && partesCobro.length > 0) {
          const cob = coberturaCobro(ficha, partesCobro);
          const propia = partesCobro.find((p) => p.movimiento_id === m.id);
          const pos = cob.movimiento_ids.indexOf(m.id as string);
          return etiquetaConciliadoCobroUnico({
            folio: folio ?? null,
            metodo_cobro: cobro.metodo_cobro ?? null,
            monto_parte:
              propia?.monto_parte ?? r2(Math.abs(Number(m.monto) || 0)),
            neto: cob.neto,
            faltante: cob.faltante,
            sobrante: cob.sobrante,
            cubierto: cob.cubierto,
            abonos_n: cob.n_partes,
            posicion: pos >= 0 ? pos + 1 : null,
          });
        }
        return [
          'Cobro',
          folio != null ? `vuelo #${folio}` : null,
          cobro.metodo_cobro ? etiquetaMetodoCobro(cobro.metodo_cobro) : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      // INGRESO (24-sep-2026): «Ingreso ING-12 · Otros ingresos · …».
      const ingreso = unwrapOne(
        m.ingreso as {
          folio?: number | null;
          categoria?: string | null;
          descripcion?: string | null;
        } | null,
      );
      if (ingreso) {
        return [
          `Ingreso ${etiquetaIngreso(ingreso.folio ?? null)}`,
          etiquetaCategoriaIngreso(ingreso.categoria ?? null) || null,
          ingreso.descripcion ?? null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      const clasif = unwrapOne(m.clasificacion as { nombre?: string } | null);
      // REVERSO (30-sep-2026): «Reverso de un cargo · devuelve el cargo del
      // 21-09 · ASUR CANCUN» / «… · devuelto el 23-09 · CARGO INDEBIDO …».
      const reversoDe = m.reverso_de as {
        fecha: string;
        descripcion: string | null;
      } | null;
      if (reversoDe) {
        return etiquetaConciliadoReverso(
          'ABONO',
          reversoDe,
          clasif?.nombre ?? CLASIFICACION_REVERSO,
        );
      }
      const revertidoPor = m.revertido_por as {
        fecha: string;
        descripcion: string | null;
      } | null;
      if (revertidoPor) {
        return etiquetaConciliadoReverso(
          'CARGO',
          revertidoPor,
          clasif?.nombre ?? CLASIFICACION_REVERSO,
        );
      }
      if (clasif?.nombre) return `Clasificación: ${clasif.nombre}`;
      return '';
    };

    /**
     * Números de factura de los gastos que paga la línea: los de cada gasto
     * del LOTE (en el orden de sus partes) o el del gasto 1 ↔ 1. La etiqueta
     * quita vacíos y duplicados (`etiquetaFacturasReporte`).
     */
    const foliosDeMov = (m: Record<string, unknown>): Array<string | null> => {
      const lote = lotes.get(m.id as string);
      if (lote && lote.length >= 2) {
        return lote.map(({ gasto }) =>
          folioComprobanteDeFila(gasto as Record<string, unknown> | null),
        );
      }
      const gasto = unwrapOne<Record<string, unknown>>(
        m.gasto as Record<string, unknown> | null,
      );
      return gasto ? [folioComprobanteDeFila(gasto)] : [];
    };

    let totalCargos = 0;
    let totalAbonos = 0;
    let conciliados = 0;
    // OMITIDOS (0.0.77, invariante 75): Estatus «Omitido», «Conciliado con»
    // = el motivo firmado y Notas SIN la línea canónica. Sin omitidos, el
    // libro sale byte a byte igual.
    let omitidos = 0;
    // Montos SIN conciliar en NARANJA: celda de Cargo o Abono según cuál
    // tenga valor (índices 0-based NUEVOS tras insertar Matrícula: Cargo=4,
    // Abono=5).
    const resaltes: { fila: number; col: number }[] = [];
    const filas = movs.map((m, i) => {
      const monto = Number(m.monto) || 0;
      const esCargo = m.tipo === 'CARGO';
      if (esCargo) totalCargos += monto;
      else totalAbonos += monto;
      const ok = m.conciliado === true;
      if (ok) conciliados += 1;
      else resaltes.push({ fila: i, col: esCargo ? 4 : 5 });
      const omision = ok ? omisionDeFila(m) : null;
      if (omision) omitidos += 1;
      return [
        (m.fecha as string) ?? '',
        (m.descripcion as string | null) ?? '',
        (m.referencia as string | null) ?? '',
        matriculaDeMov(m),
        esCargo ? monto : null,
        esCargo ? null : monto,
        omision ? ESTATUS_OMITIDO : ok ? 'Conciliado' : 'PENDIENTE',
        omision ? etiquetaOmisionReporte(omision) : ok ? conQue(m) : '',
        // «Notas» = número de la(s) factura(s) del/los gasto(s) ligado(s) +
        // la nota del banco (5-oct-2026, pedido del cliente). Sin gasto con
        // folio (cobros, ingresos, clasificaciones, reversos, gastos sin
        // número) queda la nota del banco como hasta el 0.0.56. Un omitido:
        // la nota SIN su línea canónica (el motivo ya va en «Conciliado con»).
        notasReporteConFactura(
          etiquetaFacturasReporte(foliosDeMov(m)),
          omision
            ? quitarLineaOmision(m.notas as string | null)
            : (m.notas as string | null),
        ),
      ];
    });

    const pendientes = movs.length - conciliados;
    const etiquetaCuenta = `${cuenta.alias as string} · ${cuenta.banco as string} (${cuenta.moneda as string})`;
    const etiquetaEstado = {
      todos: 'todos',
      pendientes: 'solo pendientes',
      conciliados: 'solo conciliados',
    }[estado];
    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: `Conciliación · ${etiquetaCuenta}`,
      subtitulo: `${movs.length} movimientos (${etiquetaEstado}) · ${textoConciliadosReporte(conciliados, omitidos)} · ${pendientes} pendientes · ${desde} a ${hasta}`,
      columnas: [
        { label: 'Fecha', tipo: 'texto' },
        { label: 'Descripción', tipo: 'texto' },
        { label: 'Referencia', tipo: 'texto' },
        { label: 'Matrícula', tipo: 'texto' },
        { label: `Cargo (${cuenta.moneda as string})`, tipo: 'money' },
        { label: `Abono (${cuenta.moneda as string})`, tipo: 'money' },
        { label: 'Estatus', tipo: 'texto' },
        { label: 'Conciliado con', tipo: 'texto' },
        { label: 'Notas', tipo: 'texto' },
      ],
      filas,
      totales: [
        'Totales',
        null,
        null,
        null,
        Number(totalCargos.toFixed(2)),
        Number(totalAbonos.toFixed(2)),
        `${conciliados} conciliados`,
        `${pendientes} pendientes`,
        null,
      ],
      resaltes,
    });
    return { buffer, etiqueta: (cuenta.alias as string) ?? 'cuenta' };
  }

  /**
   * Rama estado=sin_banco del reporte (los "no conciliados" del cliente):
   * gastos BANCARIOS (tarjeta corporativa / transferencia / PayWise) que NO
   * cruzaron
   * con ninguna línea del banco — MISMO criterio que gastosSinBanco, pero
   * con el rango desde/hasta obligatorio sobre fecha_gasto (sin el cap de
   * 90 días). Aquí TODO está sin conciliar: todos los montos van en naranja.
   */
  private async reporteGastosSinBancoXlsx(
    desde: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    // + número de factura (5-oct-2026): columna «Factura» al final. String
    // plano: el parser TIPADO de supabase-js no digiere columnas
    // condicionales (mismo caso que `recibidaPorId`).
    const cols: string = `id, fecha_gasto, categoria, monto, moneda, medio_pago, tarjeta_terminacion, lugar, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), captura:usuario!usuario_captura_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id), ${await this.embedFolio()}`;
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(cols)
      .in('medio_pago', MEDIOS_BANCARIOS)
      .eq('conciliado', false)
      // fecha_gasto es DATE: comparación de días, sin componente horaria.
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta)
      .order('fecha_gasto', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

    const unwrapOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

    const [repartos, mapas, vinculado] = await Promise.all([
      fetchRepartos(
        this.supabase.service,
        rows.map((g) => g.id as string),
      ),
      this.cargarMapasAvion(
        rows
          .map((g) => g.escala_id as string | null)
          .filter((id): id is string => !!id),
      ),
      // Pagos PARCIALES (14-sep-2026): cuánto del gasto ya cruzó con el banco.
      this.sumasLigadasDe(rows.map((g) => g.id as string)),
    ]);

    // Totales por moneda NATIVA (jamás convertir aquí: es un listado de
    // faltantes, no un balance — misma regla que la pestaña del panel).
    const porMoneda = new Map<string, number>();
    const filas = rows.map((g) => {
      const monto = Number(g.monto) || 0;
      const mon = (g.moneda as string | null) ?? 'MXN';
      porMoneda.set(mon, (porMoneda.get(mon) ?? 0) + monto);
      const vuelo = unwrapOne(
        g.vuelo as { folio?: number; aeronave_id?: string | null } | null,
      );
      return [
        (g.fecha_gasto as string) ?? '',
        (g.categoria as string | null) ?? '',
        unwrapOne(g.proveedor as { nombre?: string } | null)?.nombre ??
          (g.lugar as string | null) ??
          '',
        // Columna «Medio»: fuente única `etiquetaMedioSinBanco` (13-oct-2026,
        // invariante 64: «Pago domiciliado» ya no sale como «Transferencia»;
        // los demás textos, byte a byte).
        etiquetaMedioSinBanco(
          g.medio_pago as string | null,
          g.tarjeta_terminacion as string | null,
        ),
        unwrapOne(g.captura as { nombre?: string } | null)?.nombre ?? '',
        vuelo?.folio != null ? `#${vuelo.folio}` : '',
        this.matriculaDeGasto(
          g.id as string,
          {
            escala_id: (g.escala_id as string | null) ?? null,
            aeronave_id: (g.aeronave_id as string | null) ?? null,
          },
          vuelo?.aeronave_id ?? null,
          repartos,
          mapas,
        ),
        monto,
        mon,
        // «Parcial»: el gasto ya trae cargos del banco pero no lo cubren.
        (() => {
          const ligado = vinculado.get(g.id as string) ?? 0;
          if (!(ligado > 0)) return '';
          return `parcial · faltan ${montoBonito(faltanteDe(monto, ligado))} de ${montoBonito(monto)}`;
        })(),
        // «Factura» (5-oct-2026): el número de la factura del gasto.
        folioComprobanteDeFila(g) ?? '',
      ];
    });

    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: 'Conciliación · Gastos sin banco',
      subtitulo: `${rows.length} gastos bancarios (tarjeta/transferencia/PayWise) sin cruzar con el banco · ${desde} a ${hasta}`,
      columnas: [
        { label: 'Fecha', tipo: 'texto' },
        { label: 'Categoría', tipo: 'texto' },
        { label: 'Proveedor', tipo: 'texto' },
        { label: 'Medio', tipo: 'texto' },
        { label: 'Capturó', tipo: 'texto' },
        { label: 'Vuelo', tipo: 'texto' },
        { label: 'Matrícula', tipo: 'texto' },
        { label: 'Monto', tipo: 'money' },
        { label: 'Moneda', tipo: 'texto' },
        // Aditiva y AL FINAL: el resalte naranja apunta a la col 7 (Monto).
        { label: 'Parcial', tipo: 'texto' },
        // Aditiva y AL FINAL del todo (5-oct-2026): número de factura.
        { label: 'Factura', tipo: 'texto' },
      ],
      filas,
      // Nada de esta pestaña está conciliado: TODOS los montos en naranja
      // (col 7 = Monto, 0-based).
      resaltes: filas.map((_, i) => ({ fila: i, col: 7 })),
      resumen_titulo: 'Total sin conciliar por moneda',
      resumen: [...porMoneda.entries()].map(([moneda, monto]) => [
        moneda,
        Math.round(monto * 100) / 100,
      ]),
    });
    // El controller añade "-sin-banco": el archivo queda
    // "conciliacion-gastos-sin-banco-<desde>-a-<hasta>.xlsx".
    return { buffer, etiqueta: 'gastos' };
  }

  /**
   * Matrícula de un GASTO para reportes: si tiene reparto manual, el reparto
   * GANA (unión de matrículas con «+»; el remanente es de la empresa, sin
   * matrícula); si no, avionDelGasto (fuente única: escala CON herencia →
   * gasto → vuelo).
   */
  private matriculaDeGasto(
    gastoId: string | null | undefined,
    gasto: { escala_id?: string | null; aeronave_id?: string | null },
    vueloAeronaveId: string | null | undefined,
    repartos: Map<string, GastoRepartoFila[]>,
    mapas: {
      matriculas: Map<string, string>;
      escalaPorId: Map<string, { aeronave_id: string | null }>;
    },
  ): string {
    const filasReparto = gastoId ? repartos.get(gastoId) : undefined;
    if (filasReparto && filasReparto.length > 0) {
      const mats = [
        ...new Set(
          filasReparto
            .map((f) => mapas.matriculas.get(f.aeronave_id))
            .filter((x): x is string => !!x),
        ),
      ];
      return mats.join(' + ');
    }
    const avionId = avionDelGasto(gasto, mapas.escalaPorId, vueloAeronaveId);
    return avionId ? (mapas.matriculas.get(avionId) ?? '') : '';
  }

  /**
   * Mapas para resolver matrículas: aeronave id→matrícula (toda la flota) y
   * escala id→avión CRUDO. El mapa de escalas incluye TAMBIÉN las canceladas
   * (un gasto de un tramo cancelado sigue siendo de ese avión); la herencia
   * escala→vuelo la aplica avionDelGasto, no este loader.
   */
  private async cargarMapasAvion(escalaIds: string[]): Promise<{
    matriculas: Map<string, string>;
    escalaPorId: Map<string, { aeronave_id: string | null }>;
  }> {
    const { data: aviones, error: avErr } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula');
    if (avErr) throw new Error(avErr.message);
    const matriculas = new Map(
      (aviones ?? []).map((a) => [a.id as string, a.matricula as string]),
    );
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    const unicos = [...new Set(escalaIds)];
    const CHUNK = 200;
    for (let i = 0; i < unicos.length; i += CHUNK) {
      const { data, error } = await this.supabase.service
        .from('escala')
        .select('id, aeronave_id')
        .in('id', unicos.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const e of data ?? []) {
        escalaPorId.set(e.id as string, {
          aeronave_id: (e.aeronave_id as string | null) ?? null,
        });
      }
    }
    return { matriculas, escalaPorId };
  }

  async list(filters: ListConciliacionQuery) {
    // INGRESOS (24-sep-2026): con la migración, cada fila trae su liga a un
    // ingreso (`ingreso_id` + `ingreso {id, folio, categoria, monto, moneda,
    // descripcion}`, ADITIVOS). Sin ella, la consulta de siempre.
    const embedIngresoLista: string = (await this.ingresosOn())
      ? ', ingreso_id, ingreso:ingreso!ingreso_id(id, folio, categoria, monto, moneda, descripcion)'
      : '';
    // REVERSOS (30-sep-2026): con la migración, la liga del abono a su cargo.
    const colReverso: string = (await this.reversosOn())
      ? ', reverso_de_id'
      : '';
    // 1 cargo ↔ N gastos (2-oct-2026): con la migración, cuántos gastos paga.
    const conPartes = await this.partesOn();
    const colPartes: string = conPartes ? ', gastos_n' : '';
    // 1 abono ↔ N cobros (12-oct-2026): con la migración, cuántos cobros paga.
    const conCobrosLote = await this.cobrosLoteOn();
    const colCobros: string = conCobrosLote ? ', cobros_n' : '';
    // NÚMERO DE FACTURA (5-oct-2026): `gasto.folio_comprobante` y el de cada
    // `gastos[]` del lote (ADITIVOS; los campos crudos no viajan).
    const embedFolioLista = await this.embedFolio();
    // OMITIDOS (14-oct-2026, invariante 75): la pestaña «Omitidos» filtra en
    // el API (no un filtro del panel sobre la lista recortada). Sin la
    // canónica no hay omitidos (sin consultar movimientos); si su lectura
    // falla, error (la pestaña lo dice): jamás un vacío falso.
    let idOmitidoLista: string | null = null;
    if (filters.solo_omitidos === true) {
      const r = await this.leerIdClasificacionOmitido();
      if (r.fallo) {
        throw new ServiceUnavailableException({
          message:
            'No se pudo consultar la lista de omitidos: recarga la página.',
          error: 'OMITIDOS_NO_DISPONIBLE',
        });
      }
      if (!r.id) {
        return {
          data: [],
          count: 0,
          limit: filters.limit,
          offset: filters.offset,
        };
      }
      idOmitidoLista = r.id;
    }
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // El gasto/cobro conciliado trae su detalle y su vuelo (folio) para
        // que la fila sea verificable de un clic desde el panel.
        // `gasto.medio_pago` (ADITIVO 6-oct-2026): «Efectivo» en la celda.
        // `notas_fc` (0.0.75): solo para la coherencia de `factura_concepto`
        // («fact NNNN» en la 1.ª línea); se RETIRA de la respuesta.
        `${MOV_COLS}${embedIngresoLista}${colReverso}${colPartes}${colCobros}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto, vuelo_id, medio_pago, notas_fc:notas, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio), ${embedFolioLista}), cobro:cobro_vuelo!cobro_id(monto, moneda, metodo_cobro, fecha_cobro, vuelo_id, vuelo:vuelo!vuelo_id(folio)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (typeof filters.conciliado === 'boolean')
      q = q.eq('conciliado', filters.conciliado);
    // ADITIVOS (24-sep-2026): tipo y ventana de fechas (DATE, día Cancún).
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    // INICIO OFICIAL (invariante 86): piso AND; un rango anterior ⇒ vacío.
    const desdeLista = pisoDia(
      filters.desde,
      await inicioOficialDe(this.configuracion),
    );
    if (desdeLista) q = q.gte('fecha', desdeLista);
    if (filters.hasta) q = q.lte('fecha', filters.hasta);
    if (idOmitidoLista) q = q.eq('clasificacion_id', idOmitidoLista);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const filas = await this.normalizarSobresEnMovs(
      (data ?? []) as unknown as Array<Record<string, unknown>>,
    );
    // ADITIVO (5-oct-2026): `gasto.folio_comprobante` (número de factura).
    // CONCEPTO DEL SPEI (0.0.75): ANTES de quitar los campos crudos se
    // guardan los folios del gasto 1 ↔ 1 para la coherencia del chip
    // «Factura NNNN»; la copia que viaja NO lleva `notas_fc` (la respuesta
    // del gasto no crece).
    const foliosPorMov = new Map<string, FoliosGasto[]>();
    for (const m of filas) {
      const gasto = unwrapOne<Record<string, unknown>>(
        m.gasto as Record<string, unknown> | null,
      );
      if (!gasto) continue;
      foliosPorMov.set(m.id as string, [foliosDeGastoCrudo(gasto)]);
      const copia: Record<string, unknown> = { ...gasto };
      delete copia.notas_fc;
      m.gasto = conFolioComprobante(copia);
    }
    await this.anotarMotivoPendiente(filas);
    // ADITIVOS (30-sep-2026): `reverso_de` (abono) / `revertido_por` (cargo).
    await this.anotarReversos(filas);
    // ADITIVOS (2-oct-2026): `gastos[]`, `gastos_suma`, `gastos_diferencia`.
    if (conPartes)
      await this.anotarPartes(filas, embedFolioLista, foliosPorMov);
    // ADITIVOS (12-oct-2026): `cobros[]`, `cobros_suma`, `cobros_diferencia`.
    // UN COBRO, VARIOS ABONOS (0.0.78): + `cobro_conciliacion` (UN cobro) y
    // el estado de cada cobro del lote.
    if (conCobrosLote) await this.anotarCobrosDeAbonos(filas);
    // ADITIVO (0.0.75, invariante 72): `balance` en `gasto` y en cada
    // `gastos[]` (enlaces «Ver en balance…»). Best-effort, lectura propia.
    await this.anotarUbicacionBalance(filas);
    // ADITIVO (0.0.75, invariante 69): `factura_concepto` («Factura 7360»).
    await this.anotarFacturaConcepto(filas, foliosPorMov);
    // ADITIVO (0.0.77, invariante 75): `omision {motivo, por, fecha} | null`
    // SIEMPRE presente (de la clasificación embebida y las notas: cero
    // consultas). El panel detecta el API nuevo por la LLAVE.
    this.anotarOmision(filas);
    return {
      // `cobro_grupo` (aditivo): sobre de grupo conciliado, forma SOBRE_GRUPO.
      data: filas,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * 1 cargo ↔ N gastos (2-oct-2026): a cada fila de la página le pega los
   * gastos que paga (de la PUENTE, en lote: una lectura de partes, una de
   * gastos y una de la vista por página — jamás una por fila). Campos
   * ADITIVOS: `gastos: MovimientoGasto[]` (cada uno con `monto_parte`,
   * `moneda_parte`, `monto_vinculado`, `faltante`, `lugar`,
   * `notas_primera_linea`), `gastos_suma` y `gastos_diferencia` (= |monto| −
   * Σ partes; null sin partes o con una parte cruzada). `gasto`/`gasto_id`
   * siguen siendo el ESPEJO. Best-effort: si una lectura falla no se anota
   * NADA (el panel dice «detalle no disponible»), jamás una lista a medias.
   * Después, `list()` pone en cada `gastos[]` (y en el `gasto` 1 ↔ 1) el
   * ADITIVO `balance` (invariante 72, `anotarUbicacionBalance`; ausente =
   * lectura fallida, null = no vive en ningún balance).
   */
  private async anotarPartes(
    filas: Array<Record<string, unknown>>,
    embedFolioLista: string,
    /**
     * ADITIVO (0.0.75): folios CRUDOS de los gastos de cada cargo para la
     * coherencia de `factura_concepto`; los de las partes pisan los del
     * espejo 1 ↔ 1.
     */
    foliosPorMov?: Map<string, FoliosGasto[]>,
  ): Promise<void> {
    const conPartes = filas.filter((m) => Number(m.gastos_n) > 0);
    // CRUCE USD (0.0.75, invariante 70): cargos con EXACTAMENTE UNA parte
    // cruzada (USD contra pesos) ⇒ `tc_cruce` a nivel de FILA.
    const cruzadas: Array<{ m: Record<string, unknown>; usd: number }> = [];
    try {
      const partes = await this.partesDeMovimientos(
        conPartes.map((m) => m.id as string),
      );
      const gastoIds = [...new Set(partes.map((p) => p.gasto_id))];
      const [gastos, estados] = await Promise.all([
        this.leerPorLotes(gastoIds, (lote) =>
          this.supabase.service
            .from('gasto')
            .select(`${GASTO_PARTE_LISTA_COLS}, ${embedFolioLista}`)
            .in('id', lote),
        ),
        this.estadosVistaDe(gastoIds),
      ]);
      const gastoDe = new Map(gastos.map((g) => [g.id as string, g]));
      const porMov = new Map<string, ParteCargoGasto[]>();
      for (const p of partes) {
        const l = porMov.get(p.movimiento_id) ?? [];
        l.push(p);
        porMov.set(p.movimiento_id, l);
      }
      for (const m of filas) {
        const ps = porMov.get(m.id as string) ?? [];
        if (
          ps.length === 1 &&
          m.tipo === (TipoMovimientoBancario.CARGO as string)
        ) {
          const g = gastoDe.get(ps[0].gasto_id);
          const monedaGasto = typeof g?.moneda === 'string' ? g.moneda : null;
          if (g && parteCruzada(ps[0].moneda, monedaGasto)) {
            cruzadas.push({ m, usd: Math.abs(Number(g.monto) || 0) });
          }
        }
        if (foliosPorMov && ps.length > 0) {
          foliosPorMov.set(
            m.id as string,
            ps.map((p) => foliosDeGastoCrudo(gastoDe.get(p.gasto_id) ?? null)),
          );
        }
        const items = ps.map((p) => {
          // + `folio_comprobante` (5-oct-2026), sin los campos crudos.
          const g: Record<string, unknown> = conFolioComprobante(
            gastoDe.get(p.gasto_id) ?? { id: p.gasto_id },
          );
          const e = estados.get(p.gasto_id);
          const { notas, ...resto } = g;
          const monedaGasto = typeof g.moneda === 'string' ? g.moneda : null;
          return {
            ...resto,
            id: p.gasto_id,
            fecha_gasto:
              typeof g.fecha_gasto === 'string' ? g.fecha_gasto : null,
            lugar: typeof g.lugar === 'string' ? g.lugar : null,
            notas_primera_linea:
              primeraLinea(typeof notas === 'string' ? notas : null) || null,
            monto_parte: p.monto_parte,
            moneda_parte: p.moneda,
            monto_vinculado: e ? e.monto_vinculado : p.monto_parte,
            faltante: e
              ? e.faltante
              : faltanteDe(Number(g.monto) || 0, p.monto_parte),
            _cruzada: parteCruzada(p.moneda, monedaGasto),
          };
        });
        items.sort((a, b) => {
          const fa = a.fecha_gasto ?? '';
          const fb = b.fecha_gasto ?? '';
          if (fa !== fb) return fa < fb ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        m.gastos = items.map(({ _cruzada, ...it }) => {
          void _cruzada;
          return it;
        });
        m.gastos_suma =
          items.length > 0
            ? r2(items.reduce((acc, it) => acc + it.monto_parte, 0))
            : null;
        m.gastos_diferencia = diferenciaLote(
          Number(m.monto) || 0,
          items.map((it) => ({
            monto_parte: it.monto_parte,
            cruzada: it._cruzada,
          })),
        );
      }
    } catch (err) {
      this.logger.warn(
        `No se pudieron leer los gastos de cada cargo (lote): ${err instanceof Error ? err.message : String(err)}`,
      );
      for (const m of filas) {
        delete m.gastos;
        delete m.gastos_suma;
        delete m.gastos_diferencia;
        // Un lote sin sus gastos no tiene folios que comparar (el 1 ↔ 1
        // conserva los de su espejo).
        if (Number(m.gastos_n) >= 2) foliosPorMov?.delete(m.id as string);
      }
      return;
    }
    // `tc_cruce` en su PROPIO try: si el T.C. oficial no se puede leer,
    // ninguna fila lo lleva y lo demás sale igual (jamás uno a medias).
    if (cruzadas.length === 0) return;
    try {
      const oficiales = await this.oficialesTabla(
        cruzadas.map(({ m }) => String(m.fecha).slice(0, 10)),
      );
      if (oficiales === null) {
        throw new Error('no se pudo leer el T.C. oficial');
      }
      for (const { m, usd } of cruzadas) {
        const ev = evaluarTcCruce(
          Math.abs(Number(m.monto) || 0),
          usd,
          oficiales.get(String(m.fecha).slice(0, 10)) ?? null,
        );
        if (ev) m.tc_cruce = tcCruceUsdPublico(ev);
      }
    } catch (err) {
      this.logger.warn(
        `Ligas USD ↔ MXN de la lista sin tc_cruce: ${err instanceof Error ? err.message : String(err)}`,
      );
      for (const { m } of cruzadas) delete m.tc_cruce;
    }
  }

  /**
   * VÍNCULO GASTO → BALANCE (13-oct-2026, API 0.0.75, invariante 72): a
   * cada gasto ligado de la página (`gasto` 1 ↔ 1 y cada `gastos[]` del
   * lote) le pone `balance` = en qué libro y en qué mes vive, de la FUENTE
   * ÚNICA `ubicacionBalanceDeGasto` (espejo de los libros):
   * `{periodo: {desde, hasta}, eje, aviones: [{id, matricula}] (por
   * matrícula, null al final), general, hoja_avion, hoja_general}` o null
   * (no vive en ningún libro: sin enlace). Lecturas PROPIAS, en lote, del
   * LECTOR COMPARTIDO `common/ubicacion-balance-lector.ts`
   * (`leerUbicacionBalance`, también de Caja chica — invariante 82): los
   * gastos (`GASTO_UBICACION_COLS`) y sus repartos; las escalas vivas solo
   * de los gastos sellados a otro avión sin tramo (`necesitaTramosVivos`;
   * si falla, no se verifica); las matrículas son cosméticas (si fallan,
   * null). BEST-EFFORT: si falla la lectura de gastos o de repartos no se
   * anota NADA (sin la llave = el panel no pinta enlaces); un gasto que no
   * volvió en la lectura queda sin la llave. Nunca lanza.
   */
  private async anotarUbicacionBalance(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    const destinos: Array<Record<string, unknown>> = [];
    for (const m of filas) {
      const g = unwrapOne(
        m.gasto as Record<string, unknown> | Record<string, unknown>[] | null,
      );
      if (g && typeof g.id === 'string') destinos.push(g);
      if (Array.isArray(m.gastos)) {
        for (const it of m.gastos as unknown[]) {
          if (
            it &&
            typeof it === 'object' &&
            typeof (it as Record<string, unknown>).id === 'string'
          ) {
            destinos.push(it as Record<string, unknown>);
          }
        }
      }
    }
    if (destinos.length === 0) return;
    // Lector COMPARTIDO con Caja chica (invariante 82): misma lectura en
    // lote y mismos warns; null = lectura principal caída ⇒ no se anota.
    const ubicacion = await leerUbicacionBalance(
      this.supabase.service,
      destinos.map((d) => d.id as string),
      this.logger,
    );
    if (!ubicacion) return;
    for (const d of destinos) {
      const id = d.id as string;
      if (!ubicacion.has(id)) continue;
      const u = ubicacion.get(id) ?? null;
      // Copia por destino (el mismo gasto puede salir en varias filas).
      d.balance = u
        ? {
            ...u,
            periodo: { ...u.periodo },
            aviones: u.aviones.map((a) => ({ ...a })),
          }
        : null;
    }
  }

  /**
   * CONCEPTO DEL SPEI (13-oct-2026, API 0.0.75, invariante 69): a cada fila
   * cuya descripción cita una factura le pone `factura_concepto` (chip
   * «Factura 7360»): `ligados` = coherencia contra los folios de sus gastos
   * (solo CARGOS con gastos; null si no) y `repetida_en` = la MISMA factura
   * en otro movimiento del mismo tipo, en CUALQUIER cuenta a ±120 días, con
   * UNA consulta por página (`ilike '%fac%'`). Si esa consulta falla o llega
   * al tope de PostgREST (1000), `repetida_en` = null: «no verificado»,
   * jamás «no se repite». Sin ninguna fila con factura, cero consultas y la
   * página sale byte a byte igual. BEST-EFFORT: nunca lanza.
   */
  private async anotarFacturaConcepto(
    filas: Array<Record<string, unknown>>,
    foliosPorMov: Map<string, FoliosGasto[]>,
  ): Promise<void> {
    const conFactura: Array<{
      m: Record<string, unknown>;
      fc: FacturaConcepto;
    }> = [];
    for (const m of filas) {
      const fc = facturaDeConcepto(
        typeof m.descripcion === 'string' ? m.descripcion : null,
      );
      if (fc) conFactura.push({ m, fc });
    }
    if (conFactura.length === 0) return;
    let universo: FilaUniversoFactura[] | null = null;
    const fechas = conFactura
      .map(({ m }) => (typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : ''))
      .filter(Boolean)
      .sort();
    if (fechas.length > 0) {
      try {
        const { data, error } = await this.supabase.service
          .from('movimiento_bancario')
          .select(
            'id, fecha, tipo, monto, descripcion, conciliado, cuenta:cuenta_bancaria(alias)',
          )
          .ilike('descripcion', '%fac%')
          .gte('fecha', ventanaDias(fechas[0], REPETIDA_DIAS).desde)
          .lte(
            'fecha',
            ventanaDias(fechas[fechas.length - 1], REPETIDA_DIAS).hasta,
          )
          .order('fecha', { ascending: true })
          .order('id', { ascending: true })
          .range(0, REPETIDAS_UNIVERSO_TOPE - 1);
        if (error) throw new Error(error.message);
        const leidas = (data ?? []) as unknown as Array<
          Record<string, unknown>
        >;
        if (leidas.length >= REPETIDAS_UNIVERSO_TOPE) {
          this.logger.warn(
            `factura_concepto: ${leidas.length} movimientos citan facturas en ±${REPETIDA_DIAS} días (tope de PostgREST): «también en otro pago» queda sin verificar.`,
          );
        } else {
          universo = leidas.map((u) => {
            const cuenta = unwrapOne(
              u.cuenta as { alias?: unknown } | { alias?: unknown }[] | null,
            );
            return {
              id: u.id as string,
              fecha: typeof u.fecha === 'string' ? u.fecha.slice(0, 10) : null,
              tipo: typeof u.tipo === 'string' ? u.tipo : null,
              monto: r2(Number(u.monto) || 0),
              descripcion:
                typeof u.descripcion === 'string' ? u.descripcion : null,
              conciliado: u.conciliado === true,
              cuenta: typeof cuenta?.alias === 'string' ? cuenta.alias : null,
            };
          });
        }
      } catch (err) {
        this.logger.warn(
          `factura_concepto: no se pudo verificar si las facturas se repiten: ${err instanceof Error ? err.message : String(err)}`,
        );
        universo = null;
      }
    }
    for (const { m, fc } of conFactura) {
      const id = m.id as string;
      const folios = foliosPorMov.get(id);
      const ligados =
        m.tipo === (TipoMovimientoBancario.CARGO as string) && folios
          ? estadoLigados(fc, folios)
          : null;
      const fecha = typeof m.fecha === 'string' ? m.fecha.slice(0, 10) : '';
      const repetida =
        universo === null || !fecha
          ? null
          : repeticionesDeFactura(
              { id, fecha, tipo: typeof m.tipo === 'string' ? m.tipo : '', fc },
              universo,
            );
      m.factura_concepto = facturaConceptoParaRespuesta(fc, ligados, repetida);
    }
  }

  /**
   * POR QUÉ sigue pendiente cada CARGO de la página (15-sep-2026). Es la
   * pregunta literal del cliente («salen como pendiente»): el badge ámbar a
   * secas no dice nada y obligaba a abrir uno por uno.
   *
   * Campos ADITIVOS `motivo_pendiente` ∈ {SIN_CANDIDATOS, AMBIGUO,
   * SE_PUEDE_CRUZAR} y `candidatos_n`, calculados con las MISMAS reglas del
   * auto-cruce (`elegirCandidato`) en DOS consultas en lote para toda la
   * página — nunca una por fila.
   *
   * HONESTIDAD ANTES QUE COBERTURA: si algo falla o la consulta de gastos se
   * trunca, NO se anota nada (la UI vuelve al badge «Pendiente» de siempre).
   * Un «Sin candidato» falso sería peor que no decir nada. Los ABONOS no se
   * anotan: su universo son cobros y sobres, y ahí no hay consulta en lote.
   */
  private async anotarMotivoPendiente(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    const pendientes = filas.filter(
      (m) =>
        m.conciliado === false &&
        m.tipo === (TipoMovimientoBancario.CARGO as string) &&
        typeof m.fecha === 'string',
    );
    if (pendientes.length === 0) return;
    try {
      const cuentaIds = [
        ...new Set(
          pendientes
            .map((m) => m.cuenta_bancaria_id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const { data: cuentas } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, moneda')
        .in('id', cuentaIds);
      const monedaDe = new Map<string, string>();
      for (const c of (cuentas ?? []) as Array<{
        id: string;
        moneda: string;
      }>) {
        monedaDe.set(c.id, c.moneda);
      }

      const fechas = pendientes.map((m) => m.fecha as string).sort();
      const desde = ventanaDias(fechas[0], MATCH_DAYS).desde;
      const hasta = ventanaDias(fechas[fechas.length - 1], MATCH_DAYS).hasta;
      // PAGINADA por la PK (14-oct-2026): PostgREST corta en max-rows = 1000
      // SIN avisar y el `.limit(MOTIVO_GASTOS_MAX)` de antes nunca veía el
      // corte (con 1,050 gastos en la ventana anotaba con una foto recortada).
      // La moneda se filtra por cuenta, fila por fila. Un error se LANZA (el
      // catch de abajo no anota nada).
      const { filas: gastos, truncado } = await this.leerPaginado(
        (a, b) =>
          this.supabase.service
            .from('gasto')
            .select(GASTO_CRUCE_COLS)
            .eq('conciliado', false)
            .in('medio_pago', MEDIOS_BANCARIOS)
            .gte('fecha_gasto', desde)
            .lte('fecha_gasto', hasta)
            .order('id', { ascending: true })
            .range(a, b),
        MOTIVO_GASTOS_MAX,
      );
      // Truncado = foto incompleta: mejor no decir nada que decir «sin
      // candidato» de un gasto que sí existe.
      if (truncado) return;

      // Índice por monto (centavos) para no comparar N×M.
      const porMonto = new Map<string, Array<Record<string, unknown>>>();
      for (const g of gastos) {
        const k = (Number(g.monto) || 0).toFixed(2);
        const lista = porMonto.get(k) ?? [];
        lista.push(g);
        porMonto.set(k, lista);
      }
      const ctx = await this.cargarCtxCruce();

      for (const m of pendientes) {
        const moneda = monedaDe.get(m.cuenta_bancaria_id as string) ?? null;
        if (!moneda) continue;
        const fecha = m.fecha as string;
        const { desde: lo, hasta: hi } = ventanaDias(fecha, MATCH_DAYS);
        const monto = Math.abs(Number(m.monto)) || 0;
        const claves = new Set([
          monto.toFixed(2),
          (monto - TOLERANCIA_CENTAVOS).toFixed(2),
          (monto + TOLERANCIA_CENTAVOS).toFixed(2),
        ]);
        const candidatos: GastoCandidatoCruce[] = [];
        for (const k of claves) {
          for (const g of porMonto.get(k) ?? []) {
            const f = g.fecha_gasto as string | null;
            if (!f || f < lo || f > hi) continue;
            if ((g.moneda as string | null) !== moneda) continue;
            if (!montoCasa(monto, Number(g.monto))) continue;
            if (candidatos.some((c) => c.id === (g.id as string))) continue;
            candidatos.push(this.aCandidatoCruce(g));
          }
        }
        const eleccion = elegirCandidato(
          {
            monto,
            descripcion: (m.descripcion as string | null) ?? null,
            referencia: (m.referencia as string | null) ?? null,
          },
          candidatos,
          ctx.terminaciones,
        );
        m.candidatos_n = eleccion.candidatos_n;
        m.motivo_pendiente = eleccion.gasto_id
          ? // Cuadra y nadie lo ligó: el auto-cruce no ha corrido sobre él
            // (importación vieja o fallida). «Cruzar pendientes» lo resuelve.
            'SE_PUEDE_CRUZAR'
          : (eleccion.motivo ?? 'SIN_CANDIDATOS');
      }
      // CRUCE USD (0.0.75, invariante 70): los cargos de cuentas en PESOS que
      // con la regla de siempre quedan SIN_CANDIDATOS se revisan contra los
      // gastos en dólares en banda, con la MISMA regla del auto-cruce (sin
      // el recíproco: «Cruzar pendientes» lo corre al ligar).
      const sinCandidatoMxn = pendientes.filter(
        (m) =>
          m.motivo_pendiente === 'SIN_CANDIDATOS' &&
          monedaDe.get(m.cuenta_bancaria_id as string) === 'MXN' &&
          Math.abs(Number(m.monto)) > 0,
      );
      if (sinCandidatoMxn.length > 0)
        await this.anotarMotivoUsd(sinCandidatoMxn);
    } catch (err) {
      this.logger.warn(
        `No se pudo calcular el motivo de los pendientes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Motivo de los cargos en PESOS sin candidato que podrían ser una compra
   * en DÓLARES (0.0.75, invariante 70): UNA lectura en lote de gastos USD en
   * banda para toda la página (mismo filtro que el paso 3 del auto-cruce,
   * paginada) + el T.C. oficial de TABLA de sus fechas + `decidirCruceUsd`
   * SIN recíproco. LIGAR ⇒ SE_PUEDE_CRUZAR con `motivo_detalle`; AMBIGUO ⇒
   * AMBIGUO con el porqué; SIN_CANDIDATOS con descartados ⇒ solo el
   * `motivo_detalle`. HONESTIDAD: si una lectura falla o se trunca, esos
   * cargos quedan SIN anotar (un «sin candidato» falso es peor que el badge
   * mudo).
   */
  private async anotarMotivoUsd(
    cargos: Array<Record<string, unknown>>,
  ): Promise<void> {
    const olvidar = () => {
      for (const m of cargos) {
        delete m.motivo_pendiente;
        delete m.candidatos_n;
        delete m.motivo_detalle;
      }
    };
    try {
      const fechas = cargos.map((m) => String(m.fecha).slice(0, 10)).sort();
      const desde = ventanaDias(fechas[0], MATCH_DAYS).desde;
      const hasta = ventanaDias(fechas[fechas.length - 1], MATCH_DAYS).hasta;
      const bandas = cargos.map((m) =>
        rangoBandaUsd(Math.abs(Number(m.monto))),
      );
      const min = Math.min(...bandas.map((b) => b.min));
      const max = Math.max(...bandas.map((b) => b.max));
      const { filas, truncado } = await this.leerPaginado(
        (d, h) =>
          this.supabase.service
            .from('gasto')
            .select(GASTO_CRUCE_COLS)
            .eq('conciliado', false)
            .in('medio_pago', MEDIOS_BANCARIOS)
            .eq('moneda', 'USD')
            .gte('fecha_gasto', desde)
            .lte('fecha_gasto', hasta)
            .gte('monto', min)
            .lte('monto', max)
            .order('id', { ascending: true })
            .range(d, h),
        MOTIVO_GASTOS_MAX,
      );
      if (truncado) {
        olvidar();
        return;
      }
      const ligados =
        filas.length > 0
          ? await this.sumasLigadasDe(filas.map((g) => g.id as string))
          : new Map<string, number>();
      const libres = filas.filter(
        (g) => !((ligados.get(g.id as string) ?? 0) > 0),
      );
      const oficiales = await this.oficialesTabla(fechas);
      if (oficiales === null) {
        olvidar();
        return;
      }
      for (const m of cargos) {
        const fecha = String(m.fecha).slice(0, 10);
        const { desde: lo, hasta: hi } = ventanaDias(fecha, MATCH_DAYS);
        const decision = decidirCruceUsd(
          {
            fecha,
            monto: Math.abs(Number(m.monto)),
            descripcion:
              typeof m.descripcion === 'string' ? m.descripcion : null,
          },
          libres
            .filter((g) => {
              const f = g.fecha_gasto as string | null;
              return !!f && f >= lo && f <= hi;
            })
            .map((g) => ({
              id: g.id as string,
              usd: Number(g.monto) || 0,
              gasto: this.aCandidatoCruce(g),
            })),
          oficiales.get(fecha) ?? null,
        );
        if (decision.resultado === 'LIGAR' && decision.evaluacion) {
          m.motivo_pendiente = 'SE_PUEDE_CRUZAR';
          m.candidatos_n = 1;
          m.motivo_detalle = textoSePuedeCruzarUsd(
            decision.elegido_usd ?? 0,
            decision.evaluacion,
          );
        } else if (decision.resultado === 'AMBIGUO') {
          m.motivo_pendiente = 'AMBIGUO';
          m.candidatos_n = decision.candidatos_n;
          m.motivo_detalle = decision.detalle;
        } else if (decision.detalle) {
          m.motivo_detalle = decision.detalle;
        }
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo revisar el cruce en dólares de los pendientes: ${err instanceof Error ? err.message : String(err)}`,
      );
      olvidar();
    }
  }

  // =====================================================================
  // CONCILIACIÓN AL REVÉS (13-oct-2026, API 0.0.75, invariante 71): desde
  // un GASTO, sus cargos del banco, la cuenta, el estado de cuenta y quién
  // registró la liga. Solo LECTURAS; ningún número se recalcula.
  // =====================================================================

  /**
   * LECTOR ÚNICO de los cargos de estos gastos: lo usan la hoja del panel
   * (`conciliacionDeGasto`) y el Excel de gastos (pestaña «Cargos del
   * banco»), así que los dos dicen lo mismo. El Map trae TODOS los ids
   * pedidos (normalizados); un gasto sin cargos va con `cargos: []`.
   *
   * Con la sonda de partes: la puente por PK con su autor
   * (`partesDeGastos({conAutor})`), la vista (salvo `{vista: false}`), los
   * movimientos por id en lotes de 200 (con sus embeds y `gastos_n`;
   * `orden_archivo` solo con su sonda) y el detalle de los lotes con
   * `anotarPartes` —el MISMO lector de GET movimientos, best-effort: si
   * falla, `lote.gastos` = null—. Sin la sonda (REGLA DURA de la invariante
   * 40): el espejo `gasto_id` con una parte SINTÉTICA (|monto|, moneda de la
   * cuenta, sin registro), `vista` y `lote` null; ningún select nombra
   * `gastos_n`, la puente ni la vista. Nunca se nombra `cobros_n`. Un error
   * de la puente, de los movimientos o de la vista se LANZA (jamás «sin
   * cargos» por una lectura caída): quien llama decide.
   */
  async leerCargosDeGastos(
    gastos: ReadonlyArray<{ id: string; moneda: string | null }>,
    opts: { vista?: boolean } = {},
  ): Promise<Map<string, CargosDeGastoLeidos>> {
    const monedaDe = new Map<string, string | null>();
    for (const g of gastos) {
      if (!g.id) continue;
      monedaDe.set(normalizarUuid(g.id), g.moneda ?? null);
    }
    const ids = [...monedaDe.keys()];
    const out = new Map<string, CargosDeGastoLeidos>();
    if (ids.length === 0) return out;
    const conOrden = await this.ordenArchivoOn();
    const colOrden = conOrden ? ', orden_archivo' : '';

    if (!(await this.partesOn())) {
      // ESPEJO (sin la migración 20261002000002): el gasto del cargo es
      // `movimiento_bancario.gasto_id` y lo que aporta es su |monto|.
      const movs = await this.leerPorLotesPaginado(ids, (lote, desde, hasta) =>
        this.supabase.service
          .from('movimiento_bancario')
          .select(`${MOV_DETALLE_GASTO_COLS}${colOrden}`)
          .in('gasto_id', lote)
          .order('id', { ascending: true })
          .range(desde, hasta),
      );
      for (const id of ids) {
        out.set(id, { fuente: 'ESPEJO', vista: null, cargos: [] });
      }
      for (const m of movs) {
        const gid =
          typeof m.gasto_id === 'string' ? normalizarUuid(m.gasto_id) : null;
        const destino = gid ? out.get(gid) : undefined;
        if (!gid || !destino) continue;
        const cuenta = unwrapOne(
          m.cuenta as { moneda?: unknown } | { moneda?: unknown }[] | null,
        );
        destino.cargos.push(
          aCargoDeGasto({
            parte: {
              movimiento_id: m.id as string,
              monto_parte: r2(Math.abs(Number(m.monto) || 0)),
              moneda: typeof cuenta?.moneda === 'string' ? cuenta.moneda : null,
              created_at: null,
            },
            mov: m,
            gasto: { id: gid, moneda: monedaDe.get(gid) ?? null },
          }),
        );
      }
      for (const v of out.values()) v.cargos = ordenarCargosDeGasto(v.cargos);
      return out;
    }

    const partes = await this.partesDeGastos(ids, { conAutor: true });
    const vistas = opts.vista === false ? null : await this.estadosVistaDe(ids);
    const movs = await this.leerPorLotes(
      partes.map((p) => p.movimiento_id),
      (lote) =>
        this.supabase.service
          .from('movimiento_bancario')
          .select(`${MOV_DETALLE_GASTO_COLS}, gastos_n${colOrden}`)
          .in('id', lote),
    );
    // Detalle de los LOTES (≥ 2 gastos) con el lector de GET movimientos:
    // `gastos[]`, `gastos_suma` y `gastos_diferencia` tal cual. Un cargo de
    // UN gasto no lo necesita (no lleva `lote`).
    const lotes = movs.filter((m) => Number(m.gastos_n) >= 2);
    if (lotes.length > 0) {
      await this.anotarPartes(lotes, await this.embedFolio());
    }
    const movDe = new Map(movs.map((m) => [m.id as string, m]));
    for (const id of ids) {
      out.set(id, {
        fuente: 'PUENTE',
        vista: vistas?.get(id) ?? null,
        cargos: [],
      });
    }
    for (const p of partes) {
      const destino = out.get(p.gasto_id);
      if (!destino) continue;
      const mov = movDe.get(p.movimiento_id);
      if (!mov) {
        // Carrera (el cargo se borró entre las dos lecturas): se OMITE,
        // jamás se inventa.
        this.logger.warn(
          `Conciliación al revés: el cargo ${p.movimiento_id} del gasto ${p.gasto_id} ya no se pudo leer`,
        );
        continue;
      }
      destino.cargos.push(
        aCargoDeGasto({
          parte: p,
          mov,
          gasto: { id: p.gasto_id, moneda: monedaDe.get(p.gasto_id) ?? null },
        }),
      );
    }
    for (const v of out.values()) v.cargos = ordenarCargosDeGasto(v.cargos);
    return out;
  }

  /**
   * Último día con movimientos de cada cuenta ACTIVA (por alias): «hasta qué
   * día hay estado de cuenta importado». No garantiza que el periodo esté
   * completo (un PDF puede empezar a media jornada). Best-effort: cualquier
   * error ⇒ null (la hoja simplemente no lo pinta).
   *
   * `{ conPrimera: true }` (conciliación al revés de una ENTRADA, invariante
   * 78): una consulta más por cuenta, en paralelo, con el PRIMER día
   * (`primera_fecha`, null sin movimientos). Sin la opción, idéntica (Gastos
   * la llama así y responde byte a byte igual).
   */
  private async ultimosMovimientosPorCuenta(
    opts: { conPrimera?: boolean } = {},
  ): Promise<UltimoMovimientoCuenta[] | null> {
    try {
      const { data, error } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, alias, banco, moneda, tipo')
        .eq('activa', true)
        .order('alias', { ascending: true });
      if (error) throw new Error(error.message);
      const cuentas = (data ?? []) as Array<Record<string, unknown>>;
      const fechaExtrema = async (
        cuentaId: string,
        ascendente: boolean,
      ): Promise<string | null> => {
        const { data: filas, error: err } = await this.supabase.service
          .from('movimiento_bancario')
          .select('fecha')
          .eq('cuenta_bancaria_id', cuentaId)
          .order('fecha', { ascending: ascendente })
          .limit(1);
        if (err) throw new Error(err.message);
        const fila = ((filas ?? []) as Array<{ fecha?: unknown }>)[0];
        return typeof fila?.fecha === 'string' ? fila.fecha : null;
      };
      return await Promise.all(
        cuentas.map(async (c) => {
          if (opts.conPrimera !== true) {
            return {
              cuenta: cuentaDeFila(c),
              ultima_fecha: await fechaExtrema(c.id as string, false),
            };
          }
          const [primera, ultima] = await Promise.all([
            fechaExtrema(c.id as string, true),
            fechaExtrema(c.id as string, false),
          ]);
          return {
            cuenta: cuentaDeFila(c),
            primera_fecha: primera,
            ultima_fecha: ultima,
          };
        }),
      );
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el último movimiento por cuenta: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * `GET /v1/conciliacion/gastos/:id` — la conciliación AL REVÉS de UN
   * gasto: su estado con el banco (`estadoBancoGasto`, la fuente única de
   * la columna «Banco»), sus cargos (`leerCargosDeGastos`), las alertas y,
   * si sigue pendiente, el último día importado por cuenta. CERO
   * escrituras. Las notas crudas no viajan (solo la primera línea). 404
   * `GASTO_NO_EXISTE`; una lectura principal caída ⇒ 500.
   */
  async conciliacionDeGasto(
    gastoIdRaw: string,
  ): Promise<ConciliacionDeGastoRespuesta> {
    const id = normalizarUuid(gastoIdRaw);
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(`${GASTO_CONCILIACION_COLS}, ${await this.embedFolio()}`)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese gasto ya no existe: recarga la página.',
        error: 'GASTO_NO_EXISTE',
      });
    }
    const g = data as unknown as Record<string, unknown>;
    const moneda = typeof g.moneda === 'string' ? g.moneda : null;
    const leidos = (await this.leerCargosDeGastos([{ id, moneda }])).get(
      id,
    ) ?? { fuente: 'PUENTE' as const, vista: null, cargos: [] };
    const conciliado = g.conciliado === true;
    const montoVinculado =
      leidos.vista?.monto_vinculado ??
      (leidos.fuente === 'ESPEJO'
        ? r2(leidos.cargos.reduce((acc, c) => acc + c.parte.monto_parte, 0))
        : 0);
    const estado = estadoBancoGasto({
      conciliado,
      medio_pago: typeof g.medio_pago === 'string' ? g.medio_pago : null,
      monto_vinculado: montoVinculado,
    });
    const tc = normalizarTc(g.tc_gasto);
    const alertas = alertasConciliacionGasto({
      conciliado,
      vista: leidos.vista,
      cargos: leidos.cargos,
      tcGasto: tc,
    });
    const ultimos =
      estado === 'SIN_CONCILIAR' || estado === 'PARCIAL'
        ? await this.ultimosMovimientosPorCuenta()
        : null;
    const vuelo = unwrapOne(
      g.vuelo as { folio?: unknown } | { folio?: unknown }[] | null,
    );
    const folioVuelo = vuelo?.folio == null ? null : Number(vuelo.folio);
    const proveedor = unwrapOne(
      g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
    );
    const folioComprobante = conFolioComprobante(g).folio_comprobante;
    return {
      gasto: {
        id,
        fecha_gasto: typeof g.fecha_gasto === 'string' ? g.fecha_gasto : null,
        categoria: typeof g.categoria === 'string' ? g.categoria : '',
        monto: Number(g.monto) || 0,
        moneda: moneda ?? '',
        medio_pago: typeof g.medio_pago === 'string' ? g.medio_pago : null,
        tarjeta_terminacion:
          typeof g.tarjeta_terminacion === 'string'
            ? g.tarjeta_terminacion
            : null,
        tc_gasto: tc,
        conciliado,
        vuelo_id: typeof g.vuelo_id === 'string' ? g.vuelo_id : null,
        vuelo_folio:
          folioVuelo != null && Number.isFinite(folioVuelo) ? folioVuelo : null,
        proveedor:
          typeof proveedor?.nombre === 'string' ? proveedor.nombre : null,
        lugar: typeof g.lugar === 'string' ? g.lugar : null,
        notas_primera_linea:
          primeraLinea(typeof g.notas === 'string' ? g.notas : null) || null,
        folio_comprobante:
          typeof folioComprobante === 'string' ? folioComprobante : null,
      },
      estado,
      fuente: leidos.fuente,
      vista: leidos.vista,
      cargos: leidos.cargos,
      alertas,
      ultimos_movimientos: ultimos,
    };
  }

  // =====================================================================
  // CONCILIACIÓN AL REVÉS DE UNA ENTRADA (14-oct-2026, API 0.0.78,
  // invariante 78): desde un COBRO de vuelo (o la parte de un sobre, o un
  // cobro de un anticipo) o desde un INGRESO, sus ABONOS del banco. Gemela de
  // `conciliacionDeGasto`. Solo LECTURAS; ningún número se recalcula: el
  // modelo PURO vive en `abonos-de-entrada.util.ts`.
  // =====================================================================

  /**
   * `GET /v1/conciliacion/cobros/:id` (origen COBRO_VUELO) y `GET
   * /v1/conciliacion/ingresos/:id` (INGRESO): UN método, UNA respuesta
   * (`ConciliacionDeEntradaRespuesta`), CERO escrituras. 404
   * `COBRO_NO_EXISTE` / `INGRESO_NO_EXISTE`; 503 `INGRESOS_NO_DISPONIBLE`
   * solo en `ingresos/:id` sin la migración 20260924000004; una lectura
   * PRINCIPAL caída (la entrada, las ligas o los movimientos) ⇒ 500, JAMÁS
   * «sin abonos». Lo demás es best-effort (detalle del lote, aviones del
   * sobre, bitácora, nombres, `ultimos_movimientos`, `mismo_dia_cliente`,
   * `cruce_no_corrio`, la sonda del 0.0.78).
   */
  async conciliacionDeEntrada(
    origen: OrigenEntrada,
    idRaw: string,
  ): Promise<ConciliacionDeEntradaRespuesta> {
    const id = normalizarUuid(idRaw);
    return origen === 'INGRESO'
      ? this.conciliacionDeIngresoEntrada(id)
      : this.conciliacionDeCobroEntrada(id);
  }

  /**
   * La sonda del 0.0.78 (20261014000003) en modo ESTRICTO y sin tumbar la
   * hoja: «sí» solo con la migración CONFIRMADA (`cobrosParcialesConfirmados`);
   * una respuesta dudosa de la sonda (red, timeout, 5xx, `data` ≠ true) o
   * una excepción ⇒ false (revisión del 15-oct-2026: antes la sonda asumía
   * «sí» ante un error raro y la hoja afirmaba `varios_abonos_por_cobro`
   * sin haberlo comprobado).
   */
  private async cobrosParcialesOnSeguro(): Promise<boolean> {
    try {
      return await cobrosParcialesConfirmados(this.supabase.service);
    } catch (err) {
      this.logger.warn(
        `Conciliación al revés: no se pudo sondear 20261014000003: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** La hoja de un COBRO de vuelo (también la parte de un sobre o el cobro de un anticipo). */
  private async conciliacionDeCobroEntrada(
    id: string,
  ): Promise<ConciliacionDeEntradaRespuesta> {
    const sb = this.supabase.service;
    const [conIngresos, conPuente, conOrden, conParciales] = await Promise.all([
      this.ingresosOn(),
      this.cobrosLoteOn(),
      this.ordenArchivoOn(),
      this.cobrosParcialesOnSeguro(),
    ]);
    // (1) PRINCIPAL — el cobro (con su vuelo + cliente, su sobre y, con la
    // sonda de ingresos, su anticipo).
    const { data, error } = await sb
      .from('cobro_vuelo')
      .select(
        `${COBRO_HOJA_COLS}${conIngresos ? COBRO_HOJA_ANTICIPO_COLS : ''}`,
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese cobro ya no existe: recarga la página.',
        error: 'COBRO_NO_EXISTE',
      });
    }
    const c = data as unknown as Record<string, unknown>;
    const sobreId =
      typeof c.cobro_grupo_id === 'string' && c.cobro_grupo_id
        ? c.cobro_grupo_id
        : null;
    const anticipoId =
      conIngresos &&
      typeof c.ingreso_anticipo_id === 'string' &&
      c.ingreso_anticipo_id
        ? c.ingreso_anticipo_id
        : null;
    // (2) PRINCIPAL — sus ligas con el LECTOR ÚNICO (puente primero, con
    // quién creó cada parte; su sobre y su anticipo por el espejo).
    const ligas = await leerLigasDeCobros<
      MovimientoLiga & { ingreso_id?: unknown }
    >(sb, {
      cobroIds: [id],
      sobreIds: sobreId ? [sobreId] : [],
      anticipoIds: anticipoId ? [anticipoId] : [],
      cols: conIngresos ? MOV_LIGA_COLS_CON_INGRESO : MOV_LIGA_COLS,
      conPuente,
      conAutor: true,
    });
    // (3) PURO — estado, vía y cobertura: la cadena EXACTA de
    // `flights.adjuntarSobres` (invariante 77).
    const conc = conciliacionDeCobro(
      { id, cobro_grupo_id: sobreId, ingreso_anticipo_id: anticipoId },
      ligas,
    );
    const via = conc?.via ?? null;
    const partes = partesDeLigas(ligas).get(id) ?? [];
    const cob = coberturaCobro(c, partes);
    const estado = estadoBancoEntradaDeCobro(
      estadoBancoCobro({
        monto: c.monto as number | string | null | undefined,
        metodo: typeof c.metodo_cobro === 'string' ? c.metodo_cobro : null,
        via,
        cobertura: via === 'DIRECTO' && partes.length > 0 ? cob : null,
      }),
    );
    const positivo = (Number(c.monto) || 0) > 0;
    const cobertura =
      positivo && !sobreId && !anticipoId && estado !== 'NO_BANCARIO'
        ? coberturaDeEntrada(cob)
        : null;
    // Las ligas de la VÍA: todas las directas (M:N) o la del sobre / anticipo.
    const ligasDeVia: Array<MovimientoLiga & { ingreso_id?: unknown }> =
      via === 'DIRECTO'
        ? movimientosDeCobro({ id }, ligas)
        : conc
          ? [conc.mov]
          : [];
    // (4) PRINCIPAL — los abonos de esas ligas, por id.
    const colsMov = `${MOV_DETALLE_ABONO_COLS}${conPuente ? ', cobros_n' : ''}${conIngresos ? ', ingreso_id' : ''}${conOrden ? ', orden_archivo' : ''}`;
    const movIds = ligasDeVia
      .map((l) => (typeof l.id === 'string' ? l.id : ''))
      .filter(Boolean);
    const movs =
      movIds.length > 0
        ? await this.leerPorLotes(
            movIds,
            (lote) =>
              sb.from('movimiento_bancario').select(colsMov).in('id', lote),
            LOTE_IDS_ENTRADA,
          )
        : [];
    // (5) BEST-EFFORT en paralelo.
    const sinConciliar = estado === 'SIN_CONCILIAR';
    const libre = sinConciliar && !sobreId && !anticipoId;
    const lotes = conPuente ? movs.filter((m) => Number(m.cobros_n) >= 2) : [];
    const vuelo = unwrapOne(
      c.vuelo as { cliente_id?: unknown } | { cliente_id?: unknown }[] | null,
    );
    const entradaBase = entradaDeCobroParaHoja(c, new Map());
    const [avionesN, bitacora, ultimos, mismoDia, cruce] = await Promise.all([
      sobreId
        ? this.contarPartesPorSobre([sobreId])
            .then((m) => m.get(sobreId) ?? 0)
            .catch((err: unknown) => {
              this.logger.warn(
                `Conciliación al revés: no se pudieron contar los aviones del sobre ${sobreId}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return 0;
            })
        : Promise.resolve(0),
      via === 'ANTICIPO' &&
      anticipoId &&
      conc &&
      typeof conc.mov.id === 'string'
        ? this.conciliarDeBitacoraIngreso(anticipoId, conc.mov.id)
        : Promise.resolve(null),
      sinConciliar || estado === 'PARCIAL'
        ? this.ultimosMovimientosPorCuenta({ conPrimera: true })
        : Promise.resolve(null),
      libre
        ? this.mismoDiaClienteDeCobro({
            cobroId: id,
            clienteId:
              typeof vuelo?.cliente_id === 'string' ? vuelo.cliente_id : null,
            entrada: entradaBase,
            conIngresos,
            conPuente,
          })
        : Promise.resolve(null),
      libre
        ? this.cruceNoCorrioDeCobro({
            cobroId: id,
            dia: entradaBase.dia,
            moneda: entradaBase.moneda,
            metodo: entradaBase.metodo,
            registradoAt: entradaBase.registrado_at,
          })
        : Promise.resolve(null),
      // El lote de GET movimientos (`cobros[]`, `cobros_suma`,
      // `cobros_diferencia`) pegado a cada abono de 2+ cobros; si falla,
      // borra sus llaves ⇒ `lote.cobros` null + LOTE_SIN_DETALLE.
      lotes.length > 0
        ? this.anotarCobrosDeAbonos(lotes).catch((err: unknown) => {
            this.logger.warn(
              `Conciliación al revés: no se pudo leer el lote de los abonos del cobro ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
            for (const m of lotes) {
              delete m.cobros;
              delete m.cobros_suma;
              delete m.cobros_diferencia;
            }
          })
        : Promise.resolve(),
    ]);
    const nombres = await fetchNombresUsuarios(sb, [
      typeof c.registrado_por === 'string' ? c.registrado_por : null,
      bitacora?.conciliar?.actor_id ?? null,
    ]);
    const entrada = entradaDeCobroParaHoja(c, nombres);
    // (6) PURO — cada abono con su liga; una liga cuyo abono ya no se lee
    // (carrera) se OMITE con un warn, jamás se inventa.
    const movDe = new Map(movs.map((m) => [String(m.id), m]));
    const parteDe = new Map(partes.map((p) => [p.movimiento_id, p]));
    const abonos: AbonoDeEntrada[] = [];
    for (const l of ligasDeVia) {
      const movId = typeof l.id === 'string' ? l.id : '';
      const mov = movDe.get(movId);
      if (!mov) {
        this.logger.warn(
          `Conciliación al revés: el abono ${movId} del cobro ${id} ya no se pudo leer`,
        );
        continue;
      }
      let liga: LigaParaAbono;
      if (via === 'DIRECTO') {
        liga = {
          via,
          movimiento_id: movId,
          monto_parte: parteDe.get(movId)?.monto_parte ?? null,
          ...(l.parte_created_at !== undefined
            ? {
                parte_created_at: l.parte_created_at,
                ligada_por: l.ligada_por ?? null,
              }
            : {}),
        };
      } else if (via === 'ANTICIPO') {
        liga = {
          via,
          movimiento_id: movId,
          bitacora: this.bitacoraConNombre(bitacora, nombres),
        };
      } else {
        liga = { via: 'SOBRE', movimiento_id: movId };
      }
      abonos.push(aAbonoDeEntrada({ mov, liga, entrada }));
    }
    const ordenados = ordenarAbonosDeEntrada(abonos);
    const sobreRaw = unwrapOne<Record<string, unknown>>(
      c.sobre as Record<string, unknown> | Record<string, unknown>[] | null,
    );
    const anticipoRaw = anticipoId
      ? unwrapOne<Record<string, unknown>>(
          c.anticipo as
            | Record<string, unknown>
            | Record<string, unknown>[]
            | null,
        )
      : null;
    const fuente: FuenteEntrada =
      via === 'SOBRE' || via === 'ANTICIPO'
        ? 'COLUMNA'
        : conPuente
          ? 'PUENTE'
          : 'ESPEJO';
    return {
      entrada,
      estado,
      via,
      fuente,
      cobertura,
      abonos: ordenados,
      sobre:
        sobreRaw && typeof sobreRaw.id === 'string'
          ? this.normalizarSobre(sobreRaw, avionesN)
          : null,
      anticipo: anticipoRaw
        ? anticipoDeEntrada(
            anticipoRaw,
            ligas.some((l) => l.ingreso_id === anticipoId),
          )
        : null,
      alertas: alertasConciliacionEntrada({
        estado,
        via,
        cobertura,
        abonos: ordenados,
      }),
      ultimos_movimientos: ultimos,
      mismo_dia_cliente: mismoDia,
      cruce_no_corrio: cruce,
      // R9/D15: un cobro con comisión, de pasarela o cruzado se concilia con
      // UN solo abono; uno de sobre / anticipo / reembolso no acepta ninguno
      // directo (trigger A).
      varios_abonos_por_cobro:
        conParciales &&
        positivo &&
        !sobreId &&
        !anticipoId &&
        !cobroDeUnSoloAbono(c, partes),
    };
  }

  /** La hoja de un INGRESO (vivo o de baja; un anticipo como fila de Ingresos entra por aquí). */
  private async conciliacionDeIngresoEntrada(
    id: string,
  ): Promise<ConciliacionDeEntradaRespuesta> {
    if (!(await this.ingresosOn())) throw errorIngresosNoDisponibles();
    const sb = this.supabase.service;
    const conOrden = await this.ordenArchivoOn();
    // (1) PRINCIPAL — el ingreso.
    const { data, error } = await sb
      .from('ingreso')
      .select(INGRESO_HOJA_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese ingreso ya no existe: recarga la página.',
        error: 'INGRESO_NO_EXISTE',
      });
    }
    const i = data as unknown as Record<string, unknown>;
    // (2) PRINCIPAL — su abono (1 ↔ 1 por `uq_mov_bancario_ingreso`).
    const { data: movRaw, error: movErr } = await sb
      .from('movimiento_bancario')
      .select(
        `${MOV_DETALLE_ABONO_COLS}, ingreso_id${conOrden ? ', orden_archivo' : ''}`,
      )
      .eq('ingreso_id', id)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    const mov = (movRaw as unknown as Record<string, unknown> | null) ?? null;
    const movId = mov && typeof mov.id === 'string' ? mov.id : null;
    const estado = estadoConciliacionIngreso(
      {
        cuenta_bancaria_id:
          typeof i.cuenta_bancaria_id === 'string'
            ? i.cuenta_bancaria_id
            : null,
      },
      movId,
    );
    // (3) BEST-EFFORT — quién ligó (bitácora) y, si sigue pendiente, qué hay
    // importado por cuenta.
    const [bitacora, ultimos] = await Promise.all([
      movId
        ? this.conciliarDeBitacoraIngreso(id, movId)
        : Promise.resolve(null),
      estado === 'SIN_CONCILIAR'
        ? this.ultimosMovimientosPorCuenta({ conPrimera: true })
        : Promise.resolve(null),
    ]);
    const nombres = await fetchNombresUsuarios(sb, [
      typeof i.created_by === 'string' ? i.created_by : null,
      bitacora?.conciliar?.actor_id ?? null,
    ]);
    const entrada = entradaDeIngresoParaHoja(i, nombres);
    const abonos =
      mov && movId
        ? [
            aAbonoDeEntrada({
              mov,
              liga: {
                via: 'INGRESO',
                movimiento_id: movId,
                bitacora: this.bitacoraConNombre(bitacora, nombres),
              },
              entrada,
            }),
          ]
        : [];
    return {
      entrada,
      estado,
      via: movId ? 'INGRESO' : null,
      fuente: 'COLUMNA',
      cobertura: null,
      abonos,
      sobre: null,
      anticipo: null,
      alertas: alertasConciliacionEntrada({
        estado,
        via: movId ? 'INGRESO' : null,
        cobertura: null,
        abonos,
      }),
      ultimos_movimientos: ultimos,
      // Los ingresos SÍ tienen cruce «al revés» (`intentarCruzarIngreso`).
      mismo_dia_cliente: null,
      cruce_no_corrio: null,
      varios_abonos_por_cobro: false,
    };
  }

  /**
   * El CONCILIAR más reciente de la bitácora de un ingreso / anticipo para
   * ESTE abono (best-effort): `leido: false` si la lectura falló.
   */
  private async conciliarDeBitacoraIngreso(
    ingresoId: string,
    movimientoId: string,
  ): Promise<{ leido: boolean; conciliar: ConciliarDeBitacora | null }> {
    try {
      const { data, error } = await this.supabase.service
        .from('ingreso_bitacora')
        .select('actor_id, created_at, diff')
        .eq('ingreso_id', ingresoId)
        .eq('accion', 'CONCILIAR')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return {
        leido: true,
        conciliar: registroDeBitacoraIngreso(data ?? [], movimientoId),
      };
    } catch (err) {
      this.logger.warn(
        `Conciliación al revés: no se pudo leer la bitácora del ingreso ${ingresoId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { leido: false, conciliar: null };
    }
  }

  /** La bitácora leída + los nombres ⇒ el registro de la liga (o por qué no hay). */
  private bitacoraConNombre(
    b: { leido: boolean; conciliar: ConciliarDeBitacora | null } | null,
    nombres: ReadonlyMap<string, string>,
  ): {
    registro: { por: string | null; at: string } | null;
    sin_registro: SinRegistroLiga | null;
  } {
    if (!b || !b.leido) return { registro: null, sin_registro: 'NO_LEIDO' };
    if (!b.conciliar) return { registro: null, sin_registro: 'SIN_BITACORA' };
    return {
      registro: {
        por: b.conciliar.actor_id
          ? (nombres.get(b.conciliar.actor_id) ?? null)
          : null,
        at: b.conciliar.at,
      },
      sin_registro: null,
    };
  }

  /**
   * «Mismo cliente, mismo día» de un cobro SIN conciliar (D13, best-effort):
   * los vuelos del cliente (paginados por la PK) ⇒ sus cobros del MISMO día
   * Cancún y moneda, positivos, bancarios, sin sobre (ni anticipo, SOLO con
   * la sonda de ingresos), ≠ este (lotes de ≤ 150 ids, paginados) ⇒ el
   * lector único descarta los que tienen liga ⇒ `mismoDiaCliente` (PURO).
   * Cualquier falla (o un universo truncado) ⇒ null con un warn.
   */
  private async mismoDiaClienteDeCobro(a: {
    cobroId: string;
    clienteId: string | null;
    entrada: EntradaDeConciliacion;
    conIngresos: boolean;
    conPuente: boolean;
  }): Promise<MismoDiaCliente | null> {
    if (!a.clienteId) return null;
    const clienteId = a.clienteId;
    try {
      const sb = this.supabase.service;
      const { filas: vuelos, truncado } = await this.leerPaginado(
        (desde, hasta) =>
          sb
            .from('vuelo')
            .select('id, folio')
            .eq('cliente_id', clienteId)
            .order('id', { ascending: true })
            .range(desde, hasta),
        TOPE_VUELOS_CLIENTE,
      );
      if (truncado) {
        this.logger.warn(
          `Conciliación al revés: el cliente ${clienteId} tiene ${TOPE_VUELOS_CLIENTE}+ vuelos; «mismo día» no se afirma`,
        );
        return null;
      }
      const folioDe = new Map<string, unknown>(
        vuelos.map((v) => [String(v.id), v.folio]),
      );
      const dia = a.entrada.dia;
      const cols = `id, vuelo_id, monto, moneda, metodo_cobro, comision_banco_monto, fecha_cobro, cobro_grupo_id${a.conIngresos ? ', ingreso_anticipo_id' : ''}`;
      const filas = await this.leerPorLotesPaginado(
        [...folioDe.keys()],
        (lote, desde, hasta) => {
          let q = sb
            .from('cobro_vuelo')
            .select(cols)
            .in('vuelo_id', lote)
            .gte('fecha_cobro', `${dia}T00:00:00-05:00`)
            .lte('fecha_cobro', `${dia}T23:59:59-05:00`)
            .eq('moneda', a.entrada.moneda)
            .gt('monto', 0)
            .in('metodo_cobro', METODOS_ABONO_AUTO)
            .is('cobro_grupo_id', null)
            .neq('id', a.cobroId);
          if (a.conIngresos) q = q.is('ingreso_anticipo_id', null);
          return q.order('id', { ascending: true }).range(desde, hasta);
        },
        LOTE_IDS_ENTRADA,
      );
      if (filas.length === 0) return null;
      const ligas = await leerLigasDeCobros(sb, {
        cobroIds: filas.map((f) => String(f.id)),
        cols: MOV_LIGA_COLS,
        conPuente: a.conPuente,
      });
      return mismoDiaCliente(
        filas.map((f) => ({ ...f, folio: folioDe.get(String(f.vuelo_id)) })),
        ligas,
        a.entrada,
      );
    } catch (err) {
      this.logger.warn(
        `Conciliación al revés: no se pudieron leer los cobros del mismo día del cobro ${a.cobroId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * «El cruce no corrió» de un cobro SIN conciliar (D14, best-effort): los
   * cobros NO tienen cruce «al revés» (solo `intentarCruzarGasto` e
   * `intentarCruzarIngreso`), así que un cobro registrado DESPUÉS de importar
   * no se vuelve a intentar. UN `count` (head, cero filas) de abonos
   * PENDIENTES de las cuentas ACTIVAS de su moneda (BANCO; PAYWISE ⇒
   * PASARELA) con fecha en su ventana de cruce (±MATCH_DAYS; Paywise
   * ±PAYWISE_VENTANA_DIAS) importados ANTES de registrar el cobro. 0 o
   * cualquier falla ⇒ null.
   */
  private async cruceNoCorrioDeCobro(a: {
    cobroId: string;
    dia: string;
    moneda: string;
    metodo: string;
    registradoAt: string | null;
  }): Promise<CruceNoCorrio | null> {
    if (!a.registradoAt) return null;
    const registradoAt = a.registradoAt;
    try {
      const sb = this.supabase.service;
      const pasarela = METODOS_COBRO_PASARELA.includes(a.metodo);
      const { desde, hasta } = ventanaDias(
        a.dia,
        pasarela ? PAYWISE_VENTANA_DIAS : MATCH_DAYS,
      );
      const { data, error } = await sb
        .from('cuenta_bancaria')
        .select('id, moneda, tipo')
        .eq('activa', true);
      if (error) throw new Error(error.message);
      const tipo = pasarela ? TIPO_CUENTA_PASARELA : 'BANCO';
      const cuentas = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((k) => k.moneda === a.moneda && k.tipo === tipo)
        .map((k) => String(k.id));
      if (cuentas.length === 0) return null;
      const { count, error: errN } = await sb
        .from('movimiento_bancario')
        .select('id', { count: 'exact', head: true })
        .eq('tipo', TipoMovimientoBancario.ABONO)
        .eq('conciliado', false)
        .in('cuenta_bancaria_id', cuentas)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .lt('created_at', registradoAt);
      if (errN) throw new Error(errN.message);
      return cruceNoCorrio(count ?? null, desde, hasta);
    } catch (err) {
      this.logger.warn(
        `Conciliación al revés: no se pudo revisar si el cruce corrió para el cobro ${a.cobroId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Cargos del banco YA ligados a un gasto, con la MONEDA de su cuenta
   * (14-sep-2026: un gasto admite N cargos de su misma moneda). `excepto`
   * saca de la lista al movimiento que se está ligando/desligando.
   */
  private async cargosDeGasto(
    gastoId: string,
    excepto?: string | null,
  ): Promise<CargoDeGasto[]> {
    // Con la puente (2-oct-2026): cada PARTE del gasto, con lo que ESE cargo
    // le aporta (`monto_parte`) y la moneda de SU cuenta (`moneda` de la
    // parte). La fecha sale del movimiento (segunda lectura, sin embed).
    if (await this.partesOn()) {
      const partes = (await this.partesDeGastos([gastoId])).filter(
        (p) => !excepto || p.movimiento_id !== excepto,
      );
      if (partes.length === 0) return [];
      const movs = await this.leerPorLotes(
        partes.map((p) => p.movimiento_id),
        (lote) =>
          this.supabase.service
            .from('movimiento_bancario')
            .select('id, fecha')
            .in('id', lote),
      );
      const fechaDe = new Map(
        movs.map((m) => [
          m.id as string,
          typeof m.fecha === 'string' ? m.fecha : null,
        ]),
      );
      return partes
        .map((p) => ({
          id: p.movimiento_id,
          fecha: fechaDe.get(p.movimiento_id) ?? null,
          monto: p.monto_parte,
          moneda: p.moneda,
        }))
        .sort((a, b) => (a.fecha ?? '').localeCompare(b.fecha ?? ''));
    }
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, cuenta_bancaria_id, cuenta:cuenta_bancaria(moneda)',
      )
      .eq('gasto_id', gastoId)
      .order('fecha', { ascending: true });
    if (excepto) q = q.neq('id', excepto);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map((m) => ({
      id: m.id as string,
      fecha: (m.fecha as string | null) ?? null,
      monto: Math.abs(Number(m.monto)) || 0,
      moneda:
        unwrapOne(
          m.cuenta as { moneda?: string } | { moneda?: string }[] | null,
        )?.moneda ?? null,
    }));
  }

  /**
   * Estado de conciliación de un gasto a partir de SUS cargos ligados:
   * cuánto suma, cuánto falta y si está CUBIERTO (= `gasto.conciliado`,
   * fuente única `cubreGasto`). Un cargo de OTRA moneda (gasto USD contra
   * cuenta MXN) es 1 ↔ 1 y se da por cubierto: de él se deriva el `tc_gasto`
   * (invariante 7) y su monto no es comparable con el del gasto.
   */
  private estadoConciliacion(
    gasto: { monto: unknown; moneda?: string | null },
    cargos: CargoDeGasto[],
  ): {
    suma: number;
    faltante: number;
    cubierto: boolean;
    cruzado: boolean;
  } {
    const monto = Math.abs(Number(gasto.monto)) || 0;
    const moneda = (gasto.moneda as string | null) ?? null;
    const cruzados = cargos.filter(
      (c) => c.moneda != null && moneda != null && c.moneda !== moneda,
    );
    if (cruzados.length > 0) {
      return { suma: monto, faltante: 0, cubierto: true, cruzado: true };
    }
    const suma = r2(cargos.reduce((acc, c) => acc + c.monto, 0));
    return {
      suma,
      faltante: faltanteDe(monto, suma),
      cubierto: cargos.length > 0 && cubreGasto(monto, suma),
      cruzado: false,
    };
  }

  /**
   * 409 explicado (GASTO_YA_CUBIERTO) con los cargos que ya lo cubren.
   * `montoNuevo` = el cargo que se intentó ligar: sin cargos previos (el
   * PRIMER cargo ya rebasa el ticket) el texto tiene que hablar de ÉL, no
   * decir «ya está cubierto: $0.00 de $277.79».
   */
  private conflictoGastoCubierto(
    gasto: { monto: unknown; moneda?: string | null },
    cargos: CargoDeGasto[],
    motivo: MotivoNoLigar,
    monedaCuenta?: string | null,
    montoNuevo?: number,
  ): ConflictException {
    const montoGasto = Math.abs(Number(gasto.monto)) || 0;
    const sumaLigada = r2(cargos.reduce((acc, c) => acc + c.monto, 0));
    return new ConflictException({
      message:
        motivo === 'MONEDA_DISTINTA'
          ? mensajeMonedaDistinta({
              monedaGasto: (gasto.moneda as string | null) ?? null,
              monedaCuenta: monedaCuenta ?? cargos[0]?.moneda ?? null,
              cargos,
            })
          : mensajeGastoYaCubierto({
              montoGasto,
              sumaLigada,
              cargos,
              montoNuevo,
            }),
      error: 'GASTO_YA_CUBIERTO',
      details: {
        motivo,
        monto_gasto: r2(montoGasto),
        // Moneda del GASTO (aditivo): el panel imprime el sufijo USD en los
        // textos del 409 sin adivinarla.
        moneda: (gasto.moneda as string | null) ?? null,
        suma_ligada: sumaLigada,
        faltante: faltanteDe(montoGasto, sumaLigada),
        monto_nuevo: montoNuevo != null ? r2(Math.abs(montoNuevo)) : null,
        // ADITIVO (2-oct-2026): QUÉ gasto (en un lote son varios) y lo que
        // cada cargo le aporta (`monto_parte`; = `monto`, que desde la
        // puente ya es la parte y no el |monto| del movimiento).
        gasto_id: (gasto as { id?: unknown }).id ?? null,
        movimientos: cargos.map((c) => ({
          id: c.id,
          fecha: c.fecha,
          monto: c.monto,
          monto_parte: c.monto,
        })),
      },
    });
  }

  /**
   * Recalcula `gasto.conciliado` desde SUS cargos ligados (fuente única
   * `cubreGasto`): cubierto ⇒ true, parcial o sin cargos ⇒ false. Se llama
   * SIEMPRE después de mover una liga (al ligar y al desligar): antes se
   * ponía `false` a ciegas y un gasto pagado en dos cargos se "des-conciliaba"
   * al soltar uno solo de ellos.
   *
   * `montoDesligado` (monto del cargo que se acaba de soltar) limpia el
   * `tc_gasto` DERIVADO de ese cargo cuando ya no queda ninguno;
   * `tcDerivado` lo escribe al ligar una compra USD contra un cargo MXN.
   * Un fallo aquí LANZA (fail-loud): un gasto con la bandera equivocada
   * desaparece de la bandeja o se vuelve a cruzar con otro cargo.
   */
  private async recalcularGasto(
    gastoId: string,
    userId: string,
    opts: { tcDerivado?: number | null; montoDesligado?: number } = {},
  ): Promise<{ suma: number; faltante: number; cubierto: boolean }> {
    const { data: gasto, error } = await this.supabase.service
      .from('gasto')
      .select('id, monto, moneda, tc_gasto, conciliado')
      .eq('id', gastoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!gasto) return { suma: 0, faltante: 0, cubierto: false };
    const cargos = await this.cargosDeGasto(gastoId);
    const est = this.estadoConciliacion(gasto, cargos);
    const limpiarTc =
      opts.montoDesligado != null &&
      cargos.length === 0 &&
      gasto.moneda === 'USD' &&
      gasto.tc_gasto != null &&
      Number(gasto.monto) > 0 &&
      Math.abs(
        Number(gasto.tc_gasto) - opts.montoDesligado / Number(gasto.monto),
      ) < 0.001;
    const patch: Record<string, unknown> = {
      conciliado: est.cubierto,
      updated_by: userId,
    };
    if (limpiarTc) patch.tc_gasto = null;
    if (opts.tcDerivado != null) patch.tc_gasto = opts.tcDerivado;
    const { error: upErr } = await this.supabase.service
      .from('gasto')
      .update(patch)
      .eq('id', gastoId);
    if (upErr) {
      throw new Error(
        `El movimiento quedó guardado pero no se pudo recalcular la conciliación del gasto: ${upErr.message}`,
      );
    }
    return { suma: est.suma, faltante: est.faltante, cubierto: est.cubierto };
  }

  /**
   * Vincula (o desvincula si gastoId es null) un movimiento con un gasto.
   *
   * PAGOS PARCIALES (14-sep-2026, caso real: UNA factura de ASUR cobrada en
   * DOS cargos de tarjeta). Un gasto admite VARIOS cargos siempre que:
   *  - todos sean de la MISMA moneda que el gasto (si el cargo es de otra
   *    moneda sigue siendo 1 ↔ 1: de ese cargo sale el `tc_gasto`), y
   *  - la suma de |monto| no rebase `gasto.monto + TOLERANCIA_CONCILIACION`
   *    (si de verdad son dos pagos de la misma factura, el gasto debe valer
   *    la suma de los dos ⇒ 409 `GASTO_YA_CUBIERTO` explicado).
   * `gasto.conciliado` se recalcula SIEMPRE con la suma (`cubreGasto`): un
   * pago parcial deja el gasto en la bandeja con `monto_vinculado`/`faltante`.
   * Campos ADITIVOS de la respuesta: `gasto_conciliado`, `monto_vinculado`,
   * `faltante` (null al desvincular).
   *
   * 1 CARGO ↔ N GASTOS (2-oct-2026, API 0.0.52): con la migración
   * 20261002000002 la liga vive en la puente `movimiento_bancario_gasto` y
   * se escribe SOLO por las RPC de BD (`ligarPartes` / `desligarPartes`);
   * `gasto.conciliado` y `tc_gasto` los escribe la BD
   * (`recalcular_gasto_conciliado`), jamás este servicio. Sin la migración,
   * el camino directo de siempre (`linkDirecto`).
   *
   * GASTO NO BANCARIO (6-oct-2026, API 0.0.63; caso real: el cargo de
   * $212.00 del 07-sep de ASUR que «ningún piloto subió», ligado al
   * estacionamiento facturado del 28-sep en EFECTIVO): un gasto en efectivo
   * o PERSONAL_* que ENTRA a la liga exige `opts.justificacion`
   * (`validarMediosVinculo`: 400 `JUSTIFICACION_REQUERIDA`; BODEGA ⇒ 409
   * `GASTO_BODEGA`). Con ella la liga es la de siempre —NO cambia
   * `medio_pago`, ni `verificado_*`, ni `requiere_visto_bueno`; caja chica no
   * lee `conciliado`— y DESPUÉS se anotan los dos lados
   * (`sincronizarNotasVinculo`); desvincular retira esas líneas.
   */
  async link(
    movIdRaw: string,
    gastoIdRaw: string | null,
    userId: string,
    opts: OpcionesVinculo = {},
  ) {
    // uuid en minúsculas, como los devuelve la BD (`normalizarUuid`).
    const movId = normalizarUuid(movIdRaw);
    const gastoId = gastoIdRaw === null ? null : normalizarUuid(gastoIdRaw);
    if (!(await this.partesOn())) {
      return this.linkDirecto(movId, gastoId, userId, opts);
    }
    return gastoId === null
      ? this.desligarPartes(movId, userId)
      : this.ligarPartes(movId, [gastoId], userId, opts);
  }

  /**
   * `PATCH movimientos/:id {gasto_ids}` (2-oct-2026): UN cargo paga VARIOS
   * gastos («lote»; caso real: el SPEI de SAESA de $8,404.20 = 3 × $2,801.40).
   * Con UN id es la misma liga que `gasto_id`. Sin la migración ⇒ 503.
   */
  async linkGastos(
    movIdRaw: string,
    gastoIds: string[],
    userId: string,
    opts: OpcionesVinculo = {},
  ) {
    // uuid en minúsculas ANTES de buscar repetidos y de pre-validar.
    const movId = normalizarUuid(movIdRaw);
    const ids = gastoIds
      .filter((x) => typeof x === 'string' && x)
      .map((x) => normalizarUuid(x));
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException({
        message: mensajeLoteInvalido('REPETIDOS'),
        error: 'LOTE_INVALIDO',
      });
    }
    if (ids.length === 0 || ids.length > LOTE_GASTOS_MAX) {
      throw new BadRequestException({
        message: mensajeLoteInvalido('TAMANO'),
        error: 'LOTE_INVALIDO',
      });
    }
    if (ids.length === 1) return this.link(movId, ids[0], userId, opts);
    if (!(await this.partesOn())) throw errorPartesNoDisponibles();
    return this.ligarPartes(movId, ids, userId, opts);
  }

  /** Movimiento para ligar/desligar partes (404 si no existe). */
  private async leerMovimientoPartes(movId: string): Promise<{
    id: string;
    tipo: string | null;
    monto: number;
    cuenta_bancaria_id: string;
    gasto_id: string | null;
    gastos_n: number;
    ingreso_id: string | null;
    clasificacion_id: string | null;
    /** Nombre de su clasificación (misma lectura; candado de la omisión). */
    clasificacion_nombre: string | null;
    notas: string | null;
  }> {
    const cols: string = (await this.ingresosOn())
      ? 'id, tipo, gasto_id, gastos_n, monto, cuenta_bancaria_id, clasificacion_id, notas, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre), ingreso_id'
      : 'id, tipo, gasto_id, gastos_n, monto, cuenta_bancaria_id, clasificacion_id, notas, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)';
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(cols)
      .eq('id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Movimiento ${movId} not found`);
    const m = data as unknown as Record<string, unknown>;
    return {
      id: movId,
      tipo: typeof m.tipo === 'string' ? m.tipo : null,
      monto: Math.abs(Number(m.monto)) || 0,
      cuenta_bancaria_id: m.cuenta_bancaria_id as string,
      gasto_id: typeof m.gasto_id === 'string' ? m.gasto_id : null,
      gastos_n: Math.max(0, Math.trunc(Number(m.gastos_n) || 0)),
      ingreso_id:
        typeof m.ingreso_id === 'string' && m.ingreso_id ? m.ingreso_id : null,
      clasificacion_id:
        typeof m.clasificacion_id === 'string' && m.clasificacion_id
          ? m.clasificacion_id
          : null,
      clasificacion_nombre: ((): string | null => {
        const c = unwrapOne(
          m.clasificacion as
            | { nombre?: unknown }
            | { nombre?: unknown }[]
            | null
            | undefined,
        );
        return typeof c?.nombre === 'string' ? c.nombre : null;
      })(),
      notas: typeof m.notas === 'string' ? m.notas : null,
    };
  }

  /**
   * Liga el cargo con 1..N gastos por la RPC `conciliacion_ligar_cargo_gastos`
   * (UNA transacción en BD: valida, escribe la puente como DIFF y recalcula
   * cada gasto). Antes, en TS y con los MISMOS textos de siempre, se
   * pre-valida para responder un 409 claro sin tocar nada: `puedeLigar`
   * para UN gasto, `puedeRepartirCargo` para el lote. La BD es el candado
   * real (carreras): su error se traduce con `errorRpcPartes`.
   *
   * Gasto no bancario (6-oct-2026): al final de la pre-validación,
   * `validarMediosVinculo` (BODEGA / justificación); tras la RPC,
   * `sincronizarNotasVinculo` anota los no bancarios que entraron y retira
   * las líneas de los gastos que la RPC soltó (la puente se escribe como
   * DIFF: un reemplazo suelta los que ya no vienen).
   */
  private async ligarPartes(
    movId: string,
    ids: string[],
    userId: string,
    opts: OpcionesVinculo = {},
  ) {
    // Emparejado como cargo devuelto / devolución (30-sep-2026).
    await this.bloquearSiEnReverso(movId);
    const mov = await this.leerMovimientoPartes(movId);
    if (mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    // OMITIDO (14-oct-2026, invariante 75): 409 sin llamar la RPC (el
    // trigger de la BD lo rechazaría igual). Desligar sigue siendo un no-op.
    await this.bloquearSiOmitido(
      movId,
      mov.clasificacion_id,
      mov.notas,
      mov.clasificacion_nombre,
    );
    if (mov.tipo !== (TipoMovimientoBancario.CARGO as string)) {
      throw new BadRequestException({
        message: MENSAJE_SOLO_CARGOS,
        error: 'SOLO_CARGOS',
      });
    }
    const actuales = await this.partesDeMovimientos([movId]);
    const nActual = Math.max(mov.gastos_n, actuales.length);
    // Un panel VIEJO ofrece «Vincular gasto» sobre un lote (lo pinta como
    // pendiente): cambiar 3 gastos por 1 sin decirlo destruiría el lote.
    if (ids.length === 1 && nActual >= 2) {
      throw new ConflictException({
        message: mensajeMovimientoConLote(nActual),
        error: 'MOVIMIENTO_CON_LOTE',
        details: {
          movimiento_id: movId,
          gastos_n: nActual,
          gasto_ids: actuales.map((p) => p.gasto_id),
        },
      });
    }
    const cuentaMoneda = await this.monedaCuenta(mov.cuenta_bancaria_id);
    // Lote sin la moneda de la cuenta (lectura caída: `cuenta_bancaria.moneda`
    // es NOT NULL): el MISMO error legible que el endpoint de candidatos, no
    // un 409 LOTE_MONEDA_DISTINTA que culpa al operador de su elección.
    if (ids.length >= 2 && !cuentaMoneda) throw errorSinMonedaCuenta();
    type GastoLink = {
      id: string;
      conciliado: boolean;
      moneda: string | null;
      monto: number;
      tc_gasto: number | null;
      /** NOT NULL en BD; null solo si la lectura no lo trajo. */
      medio_pago: string | null;
      fecha_gasto: string | null;
    };
    const { data: gastosRaw, error: gErr } = await this.supabase.service
      .from('gasto')
      .select(
        'id, conciliado, moneda, monto, tc_gasto, medio_pago, fecha_gasto',
      )
      .in('id', ids);
    if (gErr) throw new Error(gErr.message);
    const gastos = new Map(
      ((gastosRaw ?? []) as GastoLink[]).map((g) => [
        g.id,
        { ...g, medio_pago: g.medio_pago ?? null },
      ]),
    );
    const ctx: CtxErrorPartes = {
      movId,
      ids,
      cuentaMoneda,
      montoCargo: mov.monto,
      gastos,
      lote: null,
    };

    if (ids.length === 1) {
      const gasto = gastos.get(ids[0]);
      if (!gasto) throw new BadRequestException('Gasto no encontrado.');
      const yaEsLaParte =
        actuales.length === 1 && actuales[0].gasto_id === gasto.id;
      // Solo al ENTRAR una liga nueva: re-ligar el mismo gasto es idempotente.
      if (!yaEsLaParte) {
        const monedaGasto = gasto.moneda ?? null;
        const otros = await this.cargosDeGasto(gasto.id, movId);
        const cruzados = otros.filter((c) =>
          parteCruzada(c.moneda, monedaGasto),
        );
        if (cruzados.length > 0) {
          throw this.conflictoGastoCubierto(
            gasto,
            otros,
            'MONEDA_DISTINTA',
            cruzados[0].moneda,
            mov.monto,
          );
        }
        const mismaMoneda =
          cuentaMoneda == null ||
          monedaGasto == null ||
          cuentaMoneda === monedaGasto;
        const veredicto = puedeLigar({
          montoGasto: Number(gasto.monto),
          sumaLigada: r2(otros.reduce((acc, c) => acc + c.monto, 0)),
          montoNuevo: mov.monto,
          mismaMoneda,
          yaHayLigados: otros.length > 0,
        });
        if (!veredicto.ok) {
          throw this.conflictoGastoCubierto(
            gasto,
            otros,
            veredicto.motivo ?? 'GASTO_YA_CUBIERTO',
            cuentaMoneda,
            mov.monto,
          );
        }
      }
    } else {
      if (gastos.size !== ids.length) {
        throw new BadRequestException({
          message: mensajeLoteInvalido('NO_EXISTE'),
          error: 'LOTE_INVALIDO',
          details: { faltan: ids.filter((id) => !gastos.has(id)) },
        });
      }
      const otras = (await this.partesDeGastos(ids)).filter(
        (p) => p.movimiento_id !== movId,
      );
      const veredicto = puedeRepartirCargo({
        montoCargo: mov.monto,
        monedaCuenta: cuentaMoneda,
        gastos: ids.map((id) => {
          const g = gastos.get(id)!;
          return {
            id,
            monto: Number(g.monto) || 0,
            moneda: g.moneda ?? null,
            otras: otras
              .filter((p) => p.gasto_id === id)
              .map((p) => ({ monto_parte: p.monto_parte, moneda: p.moneda })),
          };
        }),
      });
      ctx.lote = veredicto;
      if (!veredicto.ok) throw await this.errorLote(veredicto, ctx);
    }

    // Gasto no bancario (6-oct-2026): ANTES de escribir nada.
    const vinculo = this.validarMediosVinculo(
      ids.map((id) => gastos.get(id)).filter((g): g is GastoLink => !!g),
      new Set(actuales.map((p) => p.gasto_id)),
      opts.justificacion,
      cuentaMoneda,
    );

    const { error } = await this.supabase.service.rpc(
      'conciliacion_ligar_cargo_gastos',
      { p_movimiento_id: movId, p_gasto_ids: ids, p_actor: userId },
    );
    if (error) throw await this.errorRpcPartes(error, ctx);

    // La liga YA quedó: las notas solo documentan (best-effort, jamás la
    // deshacen). Los que la RPC soltó pierden su línea de ESTE cargo.
    const soltados = [
      ...new Set(
        actuales.map((p) => p.gasto_id).filter((id) => !ids.includes(id)),
      ),
    ];
    let notasAnotadas = true;
    if (vinculo.agregar.length > 0 || soltados.length > 0) {
      notasAnotadas = await this.sincronizarNotasVinculo({
        movId,
        agregar: vinculo.agregar,
        soltar: soltados,
        todoElCargo: false,
        justificacion: vinculo.justificacion,
        usuarioNombre: opts.usuarioNombre,
        userId,
        cuentaMoneda,
      });
    }
    return this.respuestaPartes(movId, {
      medios: new Map(
        [...gastos.values()].map((g) => [g.id, g.medio_pago ?? null]),
      ),
      vinculo:
        vinculo.agregar.length > 0
          ? { gasto_ids: vinculo.agregar, notas_anotadas: notasAnotadas }
          : null,
    });
  }

  /**
   * Medios del vínculo (6-oct-2026, API 0.0.63), ANTES de escribir nada:
   * - BODEGA (salida de inventario) ⇒ 409 `GASTO_BODEGA`, siempre: jamás
   *   tocó el banco, ni con justificación.
   * - Un gasto NO bancario que ENTRA en otra moneda que la de la cuenta ⇒
   *   409 `NO_BANCARIO_OTRA_MONEDA` (revisión 6-oct-2026), ni con razón:
   *   cruzado (dólares contra pesos), `recalcular_gasto_conciliado` le
   *   derivaría `tc_gasto` de este cargo, que no lo pagó. Sin la moneda de
   *   la cuenta (lectura caída) ⇒ 503 `CUENTA_SIN_MONEDA`: no se adivina.
   * - Un gasto NO bancario (efectivo, PERSONAL_*) que ENTRA a la liga sin
   *   justificación válida (≥ `JUSTIFICACION_MIN` ya limpia) ⇒ 400
   *   `JUSTIFICACION_REQUERIDA` con `details.gastos_no_bancarios[{id,
   *   medio_pago, fecha_gasto, monto}]`. Los que este cargo YA pagaba no la
   *   piden otra vez (la re-liga idéntica sigue siendo un no-op).
   * Devuelve los no bancarios que entran (se anotan tras la liga) y la
   * razón en UNA línea.
   */
  private validarMediosVinculo(
    gastos: ReadonlyArray<{
      id: string;
      medio_pago: string | null;
      moneda?: string | null;
      fecha_gasto?: string | null;
      monto?: unknown;
    }>,
    yaLigados: ReadonlySet<string>,
    justificacion: string | null | undefined,
    cuentaMoneda: string | null,
  ): { agregar: string[]; justificacion: string } {
    const ficha = (g: (typeof gastos)[number]) => ({
      id: g.id,
      medio_pago: g.medio_pago ?? null,
      fecha_gasto:
        typeof g.fecha_gasto === 'string' ? g.fecha_gasto.slice(0, 10) : null,
      monto: r2(Number(g.monto) || 0),
    });
    const cronologico = (
      a: ReturnType<typeof ficha>,
      b: ReturnType<typeof ficha>,
    ) =>
      (a.fecha_gasto ?? '').localeCompare(b.fecha_gasto ?? '') ||
      a.id.localeCompare(b.id);
    const { bodega, noBancariosNuevos } = clasificarMediosVinculo(
      gastos,
      yaLigados,
    );
    if (bodega.length > 0) {
      const fichas = bodega.map(ficha).sort(cronologico);
      throw new ConflictException({
        message: mensajeGastoBodega(fichas),
        error: 'GASTO_BODEGA',
        details: {
          gastos_bodega: fichas.map(({ id, fecha_gasto, monto }) => ({
            id,
            fecha_gasto,
            monto,
          })),
        },
      });
    }
    if (noBancariosNuevos.length > 0) {
      if (!cuentaMoneda) throw errorSinMonedaCuenta();
      const otraMoneda = noBancariosNuevos
        .filter((g) => (g.moneda ?? '') !== cuentaMoneda)
        .map((g) => ({ ...ficha(g), moneda: g.moneda ?? null }))
        .sort(cronologico);
      if (otraMoneda.length > 0) {
        throw new ConflictException({
          message: mensajeNoBancarioOtraMoneda(otraMoneda, cuentaMoneda),
          error: 'NO_BANCARIO_OTRA_MONEDA',
          details: {
            moneda_cuenta: cuentaMoneda,
            gastos_otra_moneda: otraMoneda.map(
              ({ id, moneda, fecha_gasto, monto }) => ({
                id,
                moneda,
                fecha_gasto,
                monto,
              }),
            ),
          },
        });
      }
    }
    const razon = limpiarJustificacion(justificacion);
    if (noBancariosNuevos.length > 0 && razon.length < JUSTIFICACION_MIN) {
      const fichas = noBancariosNuevos.map(ficha).sort(cronologico);
      throw new BadRequestException({
        message: mensajeJustificacionRequerida(fichas),
        error: 'JUSTIFICACION_REQUERIDA',
        details: { gastos_no_bancarios: fichas },
      });
    }
    return {
      agregar: noBancariosNuevos.map((g) => g.id),
      justificacion: razon,
    };
  }

  /**
   * NOTAS DEL VÍNCULO NO BANCARIO (6-oct-2026, API 0.0.63), DESPUÉS de
   * ligar/desligar: la liga ya quedó y esto solo la documenta.
   * - Cargo: con `todoElCargo` (desvincular TODO) pierde todas sus líneas;
   *   pierde la de cada gasto de `soltar` y gana la de cada gasto de
   *   `agregar` («Vinculado a gasto en EFECTIVO del …»).
   * - Gastos de `soltar`: pierden la línea de ESTE cargo.
   * - Gastos de `agregar`: ganan «⚠ Conciliado con el cargo bancario del …
   *   sin cambiar el medio de pago (EFECTIVO): …».
   * Textos y regex en `common/vinculo-no-bancario.util` (idempotentes). Cada
   * escritura toca SOLO `notas` + `updated_by`, con CAS (`reescribirNotas`).
   * Si algo falla, la liga se queda (jamás una liga a medias): warn y
   * `false` (el PATCH lo dice en `vinculo_no_bancario.notas_anotadas`).
   */
  private async sincronizarNotasVinculo(args: {
    movId: string;
    agregar: readonly string[];
    soltar: readonly string[];
    todoElCargo: boolean;
    justificacion: string;
    usuarioNombre: string | null | undefined;
    userId: string;
    /** Moneda de la cuenta si ya se leyó (si no, se lee). */
    cuentaMoneda?: string | null;
  }): Promise<boolean> {
    const sb = this.supabase.service;
    try {
      const { data: movRaw, error: movErr } = await sb
        .from('movimiento_bancario')
        .select(
          'id, fecha, monto, descripcion, notas, updated_at, cuenta_bancaria_id',
        )
        .eq('id', args.movId)
        .maybeSingle();
      if (movErr) throw new Error(movErr.message);
      if (!movRaw) throw new Error('el movimiento ya no existe');
      const mov = movRaw as unknown as Record<string, unknown>;
      const ids = [...new Set([...args.agregar, ...args.soltar])];
      const gastos =
        ids.length === 0
          ? []
          : await this.leerPorLotes(ids, (lote) =>
              sb.from('gasto').select(GASTO_NOTA_COLS).in('id', lote),
            );
      const gastoDe = new Map(gastos.map((g) => [g.id as string, g]));
      for (const id of args.agregar) {
        if (!gastoDe.has(id)) throw new Error(`el gasto ${id} ya no existe`);
      }
      // Solo los soltados que SÍ traen una línea del vínculo se reescriben
      // (desligar un cargo de tarjeta no escribe ni lee nada más).
      const soltarConLinea = args.soltar.filter((id) =>
        tieneNotasVinculoNoBancario(
          gastoDe.get(id)?.notas as string | null | undefined,
        ),
      );
      // El cargo como lo nombra la nota del gasto (con la moneda de SU
      // cuenta): solo hace falta si un gasto gana o pierde su línea.
      const cargo: CargoDeNota | null =
        args.agregar.length > 0 || soltarConLinea.length > 0
          ? {
              fecha:
                typeof mov.fecha === 'string' ? mov.fecha.slice(0, 10) : null,
              monto: Math.abs(Number(mov.monto)) || 0,
              moneda:
                args.cuentaMoneda ??
                (await this.monedaCuenta(mov.cuenta_bancaria_id as string)),
              descripcion:
                typeof mov.descripcion === 'string' ? mov.descripcion : null,
            }
          : null;
      const firma = {
        justificacion: args.justificacion,
        usuario: args.usuarioNombre,
        hoy: hoyCancun(),
      };
      // 1) El CARGO: una línea por gasto no bancario que paga. La de cada
      // soltado se reconoce por su id («gasto 3f9a1c2e»), aunque al gasto le
      // hayan cambiado la categoría o el vuelo después de ligarlo.
      await this.reescribirNotas(
        'movimiento_bancario',
        filaNotas(mov),
        (notas) => {
          let n = args.todoElCargo
            ? quitarNotasVinculoNoBancario(notas)
            : notas;
          for (const id of args.soltar) {
            n = quitarNotasVinculoNoBancario(n, { gastoId: id });
          }
          for (const id of args.agregar) {
            n = agregarNotaVinculo(
              n,
              lineaNotaCargo(gastoDeNota(gastoDe.get(id)!), firma),
            );
          }
          return n;
        },
        args.userId,
      );
      if (!cargo) return true;
      // 2) Los que se soltaron: fuera la línea de ESTE cargo.
      for (const id of soltarConLinea) {
        await this.reescribirNotas(
          'gasto',
          filaNotas(gastoDe.get(id)!),
          (n) => quitarNotasVinculoNoBancario(n, { cargo }),
          args.userId,
        );
      }
      // 3) Los no bancarios que entraron: su línea, SIN tocar el medio.
      for (const id of args.agregar) {
        const g = gastoDe.get(id)!;
        const medio = typeof g.medio_pago === 'string' ? g.medio_pago : null;
        await this.reescribirNotas(
          'gasto',
          filaNotas(g),
          (n) => agregarNotaVinculo(n, lineaNotaGasto(cargo, medio, firma)),
          args.userId,
        );
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Conciliación del movimiento ${args.movId}: la liga quedó, pero no se pudieron ${args.agregar.length > 0 ? 'anotar' : 'limpiar'} las notas del vínculo con un gasto no bancario: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Reescribe `notas` de UNA fila con CAS sobre `updated_at`: si alguien la
   * escribió entre la lectura y el update (0 filas), se relee y se
   * reintenta UNA vez; si vuelve a pasar, LANZA. Sin cambio ⇒ ni una
   * escritura. Solo toca `notas` y `updated_by` (la bitácora del gasto
   * registra quién): JAMÁS `medio_pago`, `verificado_*` ni
   * `requiere_visto_bueno`.
   */
  private async reescribirNotas(
    tabla: 'gasto' | 'movimiento_bancario',
    fila: FilaNotas,
    transformar: (notas: string | null) => string | null,
    userId: string,
  ): Promise<void> {
    const sb = this.supabase.service;
    let actual = fila;
    for (let intento = 0; intento < 2; intento += 1) {
      const nuevo = transformar(actual.notas);
      if ((nuevo ?? null) === (actual.notas ?? null)) return;
      let q = sb
        .from(tabla)
        .update({ notas: nuevo, updated_by: userId })
        .eq('id', actual.id);
      if (actual.updated_at) q = q.eq('updated_at', actual.updated_at);
      const { data, error } = await q.select('id');
      if (error) throw new Error(error.message);
      if (Array.isArray(data) && data.length > 0) return;
      const { data: fresca, error: lecturaErr } = await sb
        .from(tabla)
        .select('id, notas, updated_at')
        .eq('id', actual.id)
        .maybeSingle();
      if (lecturaErr) throw new Error(lecturaErr.message);
      if (!fresca) throw new Error(`${tabla} ${actual.id} ya no existe`);
      actual = filaNotas(fresca);
    }
    throw new Error(
      `las notas de ${tabla} ${fila.id} cambiaron mientras se anotaban`,
    );
  }

  /**
   * Desliga TODO el cargo (también un lote) por la RPC
   * `conciliacion_desligar_cargo_gastos`: borra sus partes y la BD
   * recalcula cada gasto que pierde su parte (el que conserva otros cargos
   * se queda como pago parcial). Un movimiento sin partes es un no-op: ya
   * no se le quita la clasificación como hacía el camino directo.
   */
  private async desligarPartes(movId: string, userId: string) {
    await this.bloquearSiEnReverso(movId);
    const mov = await this.leerMovimientoPartes(movId);
    if (mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    // Gasto no bancario (6-oct-2026): quiénes pierden su línea de este
    // cargo. Si la lectura falla, el cargo igual se limpia (warn).
    const previas = await this.partesDeMovimientos([movId]).catch(
      (err: unknown) => {
        this.logger.warn(
          `Conciliación del movimiento ${movId}: no se leyeron sus gastos antes de desvincular (sus notas del vínculo no se limpian): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as ParteCargoGasto[];
      },
    );
    const { error } = await this.supabase.service.rpc(
      'conciliacion_desligar_cargo_gastos',
      { p_movimiento_id: movId, p_actor: userId },
    );
    if (error) {
      throw await this.errorRpcPartes(error, {
        movId,
        ids: [],
        cuentaMoneda: null,
        montoCargo: mov.monto,
        gastos: new Map(),
        lote: null,
      });
    }
    await this.sincronizarNotasVinculo({
      movId,
      agregar: [],
      soltar: [...new Set(previas.map((p) => p.gasto_id))],
      todoElCargo: true,
      justificacion: '',
      usuarioNombre: null,
      userId,
    });
    return this.respuestaPartes(movId);
  }

  /**
   * Respuesta del PATCH con la puente: la fila (`movCols()`) RELEÍDA + el
   * estado de cada gasto ligado leído de `v_gasto_conciliacion` (lo escribió
   * la BD). `gastos_estado` SIEMPRE; con exactamente UNA parte, además los
   * tres campos planos de siempre (`gasto_conciliado`, `monto_vinculado`,
   * `faltante`); con 0 o ≥ 2, null.
   *
   * ADITIVOS (6-oct-2026, API 0.0.63): `gastos_estado[].medio_pago` (el
   * panel marca «Efectivo») y, solo si ENTRÓ un gasto no bancario,
   * `vinculo_no_bancario {gasto_ids, notas_anotadas}`. La fila se lee
   * DESPUÉS de anotar: sus `notas` ya traen la línea.
   */
  private async respuestaPartes(
    movId: string,
    extra: {
      /** Medios ya leídos (id ⇒ medio); los que falten se leen. */
      medios?: ReadonlyMap<string, string | null>;
      vinculo?: VinculoNoBancarioRespuesta | null;
    } = {},
  ) {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(await this.movCols())
      .eq('id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const partes = await this.partesDeMovimientos([movId]);
    const estados = await this.estadosVistaDe(partes.map((p) => p.gasto_id));
    const medios = await this.mediosDeGastos(
      partes.map((p) => p.gasto_id),
      extra.medios,
    );
    const gastos_estado = partes.map((p) => {
      const e = estados.get(p.gasto_id);
      return {
        gasto_id: p.gasto_id,
        monto_parte: p.monto_parte,
        moneda: p.moneda,
        gasto_conciliado: e ? e.cubierto : false,
        monto_vinculado: e ? e.monto_vinculado : p.monto_parte,
        faltante: e ? e.faltante : null,
        medio_pago: medios.get(p.gasto_id) ?? null,
      };
    });
    const una = gastos_estado.length === 1 ? gastos_estado[0] : null;
    return {
      ...((data as unknown as Record<string, unknown> | null) ?? {
        id: movId,
      }),
      gastos_estado,
      gasto_conciliado: una ? una.gasto_conciliado : null,
      monto_vinculado: una ? una.monto_vinculado : null,
      faltante: una ? una.faltante : null,
      ...(extra.vinculo ? { vinculo_no_bancario: extra.vinculo } : {}),
    };
  }

  /**
   * id ⇒ `medio_pago` de estos gastos: los `conocidos` y, los que falten,
   * en UNA lectura. Best-effort: si falla, esos salen `null` (un medio no
   * vale tumbar la respuesta de una liga que ya quedó).
   */
  private async mediosDeGastos(
    ids: readonly string[],
    conocidos?: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const faltan: string[] = [];
    for (const id of ids) {
      if (conocidos?.has(id)) out.set(id, conocidos.get(id) ?? null);
      else faltan.push(id);
    }
    if (faltan.length === 0) return out;
    try {
      const filas = await this.leerPorLotes(faltan, (lote) =>
        this.supabase.service
          .from('gasto')
          .select('id, medio_pago')
          .in('id', lote),
      );
      for (const f of filas) {
        out.set(
          f.id as string,
          typeof f.medio_pago === 'string' ? f.medio_pago : null,
        );
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el medio de pago de ${faltan.length} gasto(s) de la respuesta: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return out;
  }

  /** 409/400 del lote que la pre-validación TS ya sabe que no entra. */
  private async errorLote(
    v: PuedeRepartirResultado,
    ctx: CtxErrorPartes,
  ): Promise<Error> {
    switch (v.motivo) {
      case 'LOTE_MONEDA_DISTINTA':
        return new ConflictException({
          message: mensajeLoteMonedaDistinta({
            monedaGasto: v.moneda_gasto,
            monedaCuenta: v.moneda,
          }),
          error: 'LOTE_MONEDA_DISTINTA',
          details: {
            gasto_id: v.gasto_id,
            moneda_gasto: v.moneda_gasto,
            moneda_cuenta: v.moneda,
          },
        });
      case 'GASTO_YA_CUBIERTO':
        return this.conflictoGastoCubiertoDe(
          v.gasto_id,
          v.motivo_gasto ?? 'GASTO_YA_CUBIERTO',
          ctx,
        );
      case 'CARGO_NO_CUADRA':
        return new ConflictException({
          message: mensajeCargoNoCuadra({
            n: v.n,
            suma: v.suma,
            montoCargo: v.monto_cargo,
            tolerancia: v.tolerancia,
          }),
          error: 'CARGO_NO_CUADRA',
          details: this.detallesCuadre(v),
        });
      default:
        return new BadRequestException({
          message: mensajeLoteInvalido('TAMANO'),
          error: 'LOTE_INVALIDO',
        });
    }
  }

  /** `details` del 409 `CARGO_NO_CUADRA` (contrato v2). */
  private detallesCuadre(v: PuedeRepartirResultado): Record<string, unknown> {
    return {
      monto_cargo: v.monto_cargo,
      suma_gastos: v.suma,
      diferencia: v.diferencia,
      tolerancia: v.tolerancia,
      moneda: v.moneda,
      gastos: v.gastos,
    };
  }

  /** 409 GASTO_YA_CUBIERTO de UN gasto del lote, con SUS cargos. */
  private async conflictoGastoCubiertoDe(
    gastoId: string | null,
    motivo: MotivoNoLigar,
    ctx: CtxErrorPartes,
  ): Promise<ConflictException> {
    const gasto = (gastoId ? ctx.gastos.get(gastoId) : null) ?? {
      id: gastoId,
      monto: 0,
      moneda: null,
    };
    const cargos = gastoId
      ? await this.cargosDeGasto(gastoId, ctx.movId).catch(
          () => [] as CargoDeGasto[],
        )
      : [];
    return this.conflictoGastoCubierto(
      gasto,
      cargos,
      // Cubierto por un cargo en OTRA moneda (1 ↔ 1) ⇒ MONEDA_DISTINTA,
      // aunque la BD (G) lo mande como GASTO_YA_CUBIERTO.
      afinarMotivoGastoCubierto(
        motivo,
        gasto.moneda ?? null,
        cargos.map((c) => c.moneda),
      ),
      ctx.cuentaMoneda,
      ctx.ids.length === 1 ? ctx.montoCargo : undefined,
    );
  }

  /**
   * Traduce el error de la RPC / triggers de partes (2-oct-2026): `code =
   * hint ?? prefijo «CODIGO:»`, `details` = el JSON de `detail` de la BD
   * sobre los de la pre-validación TS. Un error que NO es de esta regla se
   * REGISTRA tal cual (código y mensaje de Postgres) antes de traducirlo:
   * solo «la RPC/puente/vista no está» (`esPartesAusentes`) es 503; todo lo
   * demás —p. ej. un 42883 «operator does not exist» de un cuerpo plpgsql,
   * el incidente del 15-sep— SUBE como 500 con su texto real.
   */
  private async errorRpcPartes(
    error: ErrorPartesLike,
    ctx: CtxErrorPartes,
  ): Promise<Error> {
    const { codigo, texto, details } = leerErrorPartes(error);
    const msg = error.message ?? '';
    if (!codigo) {
      this.logger.error(
        `Conciliación del movimiento ${ctx.movId}: la base respondió ${error.code ?? 'sin código'}: ${msg}`,
      );
      if (esPartesAusentes(error)) return errorPartesNoDisponibles();
      return new Error(msg);
    }
    // Regla de negocio que la pre-validación TS no vio (carrera): se anota.
    this.logger.warn(
      `Conciliación del movimiento ${ctx.movId}: la base rechazó la liga (${codigo}): ${msg}`,
    );
    switch (codigo) {
      case 'GASTO_YA_CUBIERTO': {
        // Forma de SIEMPRE (`details.motivo`): el motivo que manda la BD
        // gana; el `includes('MONEDA')` queda de respaldo. Gana
        // `details.gasto_id`.
        const gastoId =
          (typeof details?.gasto_id === 'string' ? details.gasto_id : null) ??
          ctx.lote?.gasto_id ??
          (ctx.ids.length === 1 ? ctx.ids[0] : null);
        return this.conflictoGastoCubiertoDe(
          gastoId,
          motivoGastoCubiertoDeBd(msg, details),
          ctx,
        );
      }
      case 'LOTE_INVALIDO':
        return new BadRequestException({
          message: mensajeLoteInvalidoDeBd(msg, details),
          error: 'LOTE_INVALIDO',
          details: details ?? undefined,
        });
      case 'CARGO_NO_CUADRA': {
        const d = {
          ...(ctx.lote ? this.detallesCuadre(ctx.lote) : {}),
          ...(details ?? {}),
        };
        const num = (k: string) =>
          typeof d[k] === 'number' ? d[k] : Number.NaN;
        const legible =
          Number.isFinite(num('suma_gastos')) &&
          Number.isFinite(num('monto_cargo')) &&
          Number.isFinite(num('tolerancia'));
        return new ConflictException({
          message: legible
            ? mensajeCargoNoCuadra({
                n: ctx.ids.length,
                suma: num('suma_gastos'),
                montoCargo: num('monto_cargo'),
                tolerancia: num('tolerancia'),
              })
            : texto,
          error: 'CARGO_NO_CUADRA',
          details: d,
        });
      }
      case 'LOTE_MONEDA_DISTINTA': {
        const d: Record<string, unknown> = {
          ...(ctx.lote
            ? {
                gasto_id: ctx.lote.gasto_id,
                moneda_gasto: ctx.lote.moneda_gasto,
                moneda_cuenta: ctx.cuentaMoneda,
              }
            : { moneda_cuenta: ctx.cuentaMoneda }),
          ...(details ?? {}),
        };
        return new ConflictException({
          message: mensajeLoteMonedaDistinta({
            monedaGasto:
              typeof d.moneda_gasto === 'string' ? d.moneda_gasto : null,
            monedaCuenta:
              typeof d.moneda_cuenta === 'string' ? d.moneda_cuenta : null,
          }),
          error: 'LOTE_MONEDA_DISTINTA',
          details: d,
        });
      }
      case 'MOVIMIENTO_CON_LOTE': {
        const n = Number(details?.gastos_n) || 2;
        return new ConflictException({
          message: mensajeMovimientoConLote(n),
          error: 'MOVIMIENTO_CON_LOTE',
          details: { movimiento_id: ctx.movId, ...(details ?? {}) },
        });
      }
      // PARTES_INCOHERENTES (constraint diferido: cargo «a medias») y
      // CARGO_LIGADO (candado de monto / cuenta): el cargo cambió entre la
      // lectura y la escritura ⇒ 409, ya no un 500 técnico. MOVIMIENTO_OMITIDO
      // (14-oct-2026, invariante 75): el trigger rechaza ligar un omitido
      // (carrera con la pre-validación TS) ⇒ 409, jamás el 500 de un código
      // desconocido.
      case 'CARGO_EXCEDIDO':
      case 'MOVIMIENTO_YA_LIGADO':
      case 'REVERSO_INVALIDO':
      case 'LOTE_SOLO_API_NUEVO':
      case 'PARTES_INCOHERENTES':
      case 'CARGO_LIGADO':
      case 'MOVIMIENTO_OMITIDO':
        return new ConflictException({
          message: mensajeErrorPartes(codigo, details),
          error: codigo,
          details: { movimiento_id: ctx.movId, ...(details ?? {}) },
        });
      default:
        return new Error(msg);
    }
  }

  /**
   * Camino DIRECTO (hasta el 0.0.51; hoy solo sin la migración
   * 20261002000002): escribe `movimiento_bancario.gasto_id` y recalcula el
   * gasto en TS. Intacto a propósito, salvo la regla del gasto no bancario
   * (6-oct-2026), que es la MISMA del camino con la puente.
   */
  private async linkDirecto(
    movId: string,
    gastoId: string | null,
    userId: string,
    opts: OpcionesVinculo = {},
  ) {
    // Emparejado como cargo devuelto / devolución (30-sep-2026): ni se liga
    // ni se desvincula por aquí — el camino es DELETE movimientos/:id/reverso.
    await this.bloquearSiEnReverso(movId);
    const colsMov: string = (await this.ingresosOn())
      ? 'id, gasto_id, monto, cuenta_bancaria_id, ingreso_id'
      : 'id, gasto_id, monto, cuenta_bancaria_id';
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as {
      gasto_id: string | null;
      monto: unknown;
      cuenta_bancaria_id: string;
      ingreso_id?: string | null;
    };
    // Conciliado con un INGRESO (24-sep-2026): ni se liga a un gasto ni se
    // desvincula por aquí — también al desvincular (sin el pre-check,
    // conciliado=false con ingreso_id puesto choca con el CHECK).
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }

    const prevGasto = (mov as { gasto_id: string | null }).gasto_id;
    const movMonto = Math.abs(Number((mov as { monto: unknown }).monto)) || 0;

    type GastoLink = {
      id: string;
      conciliado: boolean;
      moneda: string | null;
      monto: number;
      tc_gasto: number | null;
      medio_pago: string | null;
      fecha_gasto: string | null;
    };
    let gastoVinculado: GastoLink | null = null;
    let cuentaMoneda: string | null = null;
    // Gasto no bancario (6-oct-2026): los que entran y la razón limpia.
    let vinculo: { agregar: string[]; justificacion: string } = {
      agregar: [],
      justificacion: '',
    };
    if (gastoId) {
      const { data: gasto, error: gastoErr } = await this.supabase.service
        .from('gasto')
        .select(
          'id, conciliado, moneda, monto, tc_gasto, medio_pago, fecha_gasto',
        )
        .eq('id', gastoId)
        .maybeSingle();
      if (gastoErr) throw new Error(gastoErr.message);
      if (!gasto) throw new BadRequestException('Gasto no encontrado.');
      gastoVinculado = gasto;
      cuentaMoneda = await this.monedaCuenta(
        (mov as { cuenta_bancaria_id: string }).cuenta_bancaria_id,
      );
      // Solo al ENTRAR una liga nueva: re-ligar el mismo gasto es idempotente.
      if (gastoId !== prevGasto) {
        const monedaGasto = gastoVinculado.moneda ?? null;
        const otros = await this.cargosDeGasto(gastoId, movId);
        const cruzados = otros.filter(
          (c) =>
            c.moneda != null && monedaGasto != null && c.moneda !== monedaGasto,
        );
        // Ya conciliado contra otra moneda (1 ↔ 1): ningún cargo más.
        if (cruzados.length > 0) {
          throw this.conflictoGastoCubierto(
            gastoVinculado,
            otros,
            'MONEDA_DISTINTA',
            cruzados[0].moneda,
            movMonto,
          );
        }
        const mismaMoneda =
          cuentaMoneda == null ||
          monedaGasto == null ||
          cuentaMoneda === monedaGasto;
        const sumaLigada = r2(otros.reduce((acc, c) => acc + c.monto, 0));
        const veredicto = puedeLigar({
          montoGasto: Number(gastoVinculado.monto),
          sumaLigada,
          montoNuevo: movMonto,
          mismaMoneda,
          yaHayLigados: otros.length > 0,
        });
        if (!veredicto.ok) {
          throw this.conflictoGastoCubierto(
            gastoVinculado,
            otros,
            veredicto.motivo ?? 'GASTO_YA_CUBIERTO',
            cuentaMoneda,
            movMonto,
          );
        }
      }
      vinculo = this.validarMediosVinculo(
        [{ ...gastoVinculado, medio_pago: gastoVinculado.medio_pago ?? null }],
        new Set(prevGasto ? [prevGasto] : []),
        opts.justificacion,
        cuentaMoneda,
      );
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        gasto_id: gastoId,
        conciliado: gastoId !== null,
        // Vincular un gasto real pisa la clasificación "sin vuelo" (son
        // excluyentes); al desvincular, el movimiento vuelve a pendiente.
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(await this.movCols())
      .maybeSingle();
    if (error) {
      const msg = error.message ?? '';
      // Trigger tg_mov_bancario_gasto_suma (migración 20260914000001): cierra
      // el TOCTOU que antes cerraba el índice único uq_mov_bancario_gasto —
      // dos ligas simultáneas al mismo gasto pasan el check previo, pero en
      // la BD solo cabe la que no rebasa el monto.
      if (
        (error.code === '23514' || msg.includes('23514')) &&
        msg.includes('GASTO_YA_CUBIERTO')
      ) {
        const gasto = gastoVinculado ?? { monto: 0, moneda: null };
        const cargos = gastoId
          ? await this.cargosDeGasto(gastoId, movId).catch(
              () => [] as CargoDeGasto[],
            )
          : [];
        throw this.conflictoGastoCubierto(
          gasto,
          cargos,
          msg.includes('MONEDA') ? 'MONEDA_DISTINTA' : 'GASTO_YA_CUBIERTO',
          cuentaMoneda,
          movMonto,
        );
      }
      // (El 23505 del índice único `uq_mov_bancario_gasto` se retiró: la
      // migración 20260914000001 lo quitó y está aplicada.)
      if (error.code === '23503')
        throw new BadRequestException('Gasto no encontrado.');
      // Ventana de la sonda (≤ 10 min tras aplicar 20261002000002): el
      // trigger de compatibilidad de la puente puede rechazar este UPDATE
      // directo (p. ej. LOTE_SOLO_API_NUEVO sobre un lote): mismo 409.
      if (leerErrorPartes(error).codigo) {
        throw await this.errorRpcPartes(error, {
          movId,
          ids: gastoId ? [gastoId] : [],
          cuentaMoneda,
          montoCargo: movMonto,
          gastos: new Map(
            gastoVinculado ? [[gastoVinculado.id, gastoVinculado]] : [],
          ),
          lote: null,
        });
      }
      throw new Error(msg);
    }

    // El gasto ANTERIOR se recalcula con los cargos que le QUEDAN (puede
    // seguir cubierto por otro pago del mismo ticket): ya no se pone
    // conciliado=false a ciegas.
    if (prevGasto && prevGasto !== gastoId) {
      await this.recalcularGasto(prevGasto, userId, {
        montoDesligado: movMonto,
      });
    }

    let estado: { suma: number; faltante: number; cubierto: boolean } | null =
      null;
    if (gastoId) {
      // Compra en DÓLARES conciliada contra un cargo en PESOS: el estado de
      // cuenta REVELA el tipo de cambio real del banco (cargo MXN ÷ gasto
      // USD). Se guarda como tc_gasto para que el balance por avión y los
      // reportes usen los pesos exactos que se pagaron — sin capturas extra.
      let tcDerivado: number | null = null;
      if (
        gastoVinculado?.moneda === 'USD' &&
        gastoVinculado.tc_gasto == null &&
        Number(gastoVinculado.monto) > 0 &&
        movMonto > 0
      ) {
        const tc = movMonto / Number(gastoVinculado.monto);
        if (
          cuentaMoneda === 'MXN' &&
          tc >= TC_IMPLICITO_MIN &&
          tc <= TC_IMPLICITO_MAX
        ) {
          // 6 decimales (17-sep-2026, fuente única tc.util): con 4, un gasto
          // de 722.90 USD × 17.2244 ya no reproducía los 12,451.49 MXN que
          // el banco cobró — el TC derivado tiene que cerrar al centavo.
          tcDerivado = round6(tc);
        }
      }
      estado = await this.recalcularGasto(gastoId, userId, { tcDerivado });
    }
    // Gasto no bancario (6-oct-2026): la liga ya quedó; las notas la
    // documentan (best-effort) y el que se soltó pierde su línea.
    const soltados = prevGasto && prevGasto !== gastoId ? [prevGasto] : [];
    let fila = data as unknown as Record<string, unknown>;
    let notasAnotadas = true;
    if (vinculo.agregar.length > 0 || soltados.length > 0) {
      notasAnotadas = await this.sincronizarNotasVinculo({
        movId,
        agregar: vinculo.agregar,
        soltar: soltados,
        todoElCargo: gastoId === null,
        justificacion: vinculo.justificacion,
        usuarioNombre: opts.usuarioNombre,
        userId,
        cuentaMoneda,
      });
      // Las notas del cargo cambiaron después del UPDATE: se releen.
      const { data: releida } = await this.supabase.service
        .from('movimiento_bancario')
        .select('notas')
        .eq('id', movId)
        .maybeSingle();
      if (releida) {
        fila = {
          ...fila,
          notas: (releida as { notas?: unknown }).notas ?? null,
        };
      }
    }
    // Aditivos (14-sep-2026): el panel decide el toast «Gasto cubierto» vs
    // «Pago parcial: faltan $X» con la respuesta, sin recalcular nada.
    return {
      ...fila,
      gasto_conciliado: estado ? estado.cubierto : null,
      monto_vinculado: estado ? estado.suma : null,
      faltante: estado ? estado.faltante : null,
      ...(vinculo.agregar.length > 0
        ? {
            vinculo_no_bancario: {
              gasto_ids: vinculo.agregar,
              notas_anotadas: notasAnotadas,
            } satisfies VinculoNoBancarioRespuesta,
          }
        : {}),
    };
  }

  /**
   * Sugiere (vía Claude en pyservices) el gasto más probable para un
   * movimiento bancario sin conciliar y ambiguo.
   *
   * CONTEXTO RICO (15-sep-2026): antes al modelo solo le llegaban
   * {fecha, monto, descripcion} del movimiento y {id, fecha, monto,
   * proveedor} de cada candidato — estaba CIEGO justo a lo que desempata:
   * la referencia (donde va la terminación de la tarjeta), la moneda de la
   * cuenta, el lugar / la primera línea de las notas del gasto, su tarjeta,
   * su categoría, su matrícula y su faltante. Ahora viaja todo eso y la
   * respuesta admite `evidencias` y `alternativas`.
   *
   * La IA PROPONE y NUNCA liga: esto es solo-lectura.
   * Best-effort: si pyservices no está configurado o falla, devuelve
   * disponible=false con los candidatos para que el operador elija a mano.
   */
  async sugerir(
    movId: string,
    userId?: string,
  ): Promise<SugerenciaConciliacion> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, descripcion, referencia, conciliado, cuenta_bancaria_id, cuenta:cuenta_bancaria(alias, banco, moneda)',
      )
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const m = mov as Record<string, unknown>;
    if (m.conciliado) {
      throw new BadRequestException('El movimiento ya está conciliado.');
    }
    return this.sugerirDeMovimiento(m, userId);
  }

  /**
   * Núcleo de la sugerencia (lo comparten `sugerir` y `sugerir-lote`): arma
   * el contexto, llama a pyservices y filtra la respuesta contra los
   * candidatos REALES (la IA jamás puede inventar un id).
   */
  private async sugerirDeMovimiento(
    m: Record<string, unknown>,
    userId?: string,
  ): Promise<SugerenciaConciliacion> {
    const movId = m.id as string;
    const cuenta = unwrapOne(
      m.cuenta as { alias?: unknown; banco?: unknown; moneda?: unknown } | null,
    );
    const moneda = (cuenta?.moneda as string | null) ?? null;
    const candidatos = await this.candidatosCercanos(
      Number(m.monto),
      m.fecha as string,
      moneda,
    );
    const ctx = await this.cargarCtxCruce();
    const terminacion = terminacionDeMovimiento(
      (m.referencia as string | null) ?? null,
      (m.descripcion as string | null) ?? null,
      ctx.terminaciones,
    );
    const vacia = (razon: string, disponible = true) => ({
      disponible,
      gasto_id_sugerido: null,
      confianza: 0,
      razon,
      evidencias: [] as string[],
      alternativas: [] as SugerenciaConciliacion['alternativas'],
      terminacion_detectada: terminacion,
      motivo_sin_match: razon,
      candidatos,
    });
    if (candidatos.length === 0) {
      return vacia(
        'No hay gastos candidatos cercanos (±3 días y ±5% de monto) sin conciliar.',
      );
    }

    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      return vacia(
        'Asistente de conciliación no configurado (pyservices).',
        false,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/sugerir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
          ...(await this.headersModeloIa()),
        },
        body: JSON.stringify({
          movimiento: {
            fecha: m.fecha,
            monto: Number(m.monto),
            descripcion: (m.descripcion as string | null) ?? null,
            referencia: (m.referencia as string | null) ?? null,
            tipo: (m.tipo as string | null) ?? null,
            cuenta_alias:
              (cuenta?.alias as string | null) ??
              (cuenta?.banco as string | null) ??
              null,
            cuenta_moneda: moneda,
            terminacion_tarjeta_detectada: terminacion,
          },
          candidatos,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `pyservices /conciliacion/sugerir respondió ${res.status}`,
        );
        return vacia(`pyservices respondió ${res.status}.`, false);
      }
      const data = (await res.json()) as {
        gasto_id_sugerido: string | null;
        confianza: number;
        razon: string;
        evidencias?: unknown;
        alternativas?: unknown;
        motivo_sin_match?: unknown;
        uso_ia?: UsoIaPayload | null;
      };
      this.iaUso.registrar('CONCILIACION_SUGERIR', data.uso_ia, {
        usuarioId: userId ?? null,
        contexto: { movimiento_id: movId },
      });
      // Solo aceptamos ids que estén realmente entre los candidatos.
      const validos = new Set(candidatos.map((c) => c.id));
      const sugerido = validos.has(data.gasto_id_sugerido as string)
        ? (data.gasto_id_sugerido as string)
        : null;
      const evidencias = Array.isArray(data.evidencias)
        ? data.evidencias
            .filter((e): e is string => typeof e === 'string')
            .slice(0, 8)
        : [];
      const alternativas = Array.isArray(data.alternativas)
        ? data.alternativas
            .map((a) => a as Record<string, unknown>)
            .filter(
              (a) =>
                typeof a?.gasto_id === 'string' &&
                validos.has(a.gasto_id) &&
                a.gasto_id !== sugerido,
            )
            .map((a) => ({
              gasto_id: a.gasto_id as string,
              confianza: Number(a.confianza) || 0,
              razon: typeof a.razon === 'string' ? a.razon : '',
            }))
            .slice(0, 5)
        : [];
      return {
        disponible: true,
        gasto_id_sugerido: sugerido,
        confianza: sugerido ? data.confianza : 0,
        razon: data.razon ?? '',
        evidencias,
        alternativas,
        terminacion_detectada: terminacion,
        motivo_sin_match: sugerido
          ? null
          : typeof data.motivo_sin_match === 'string'
            ? data.motivo_sin_match.slice(0, 300)
            : null,
        candidatos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sugerir conciliación falló: ${msg}`);
      return vacia(
        `No se pudo contactar al asistente de conciliación: ${msg}`,
        false,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sugerencias EN LOTE para los pendientes de una ventana (15-sep-2026).
   * Corre la MISMA sugerencia individual sobre los movimientos que todavía
   * tienen candidatos y devuelve PROPUESTAS: no liga nada — el operador las
   * confirma en el panel. Cada llamada consume créditos de IA, por eso el
   * tope es bajo y explícito.
   */
  async sugerirLote(dto: SugerirLoteDto, userId: string) {
    const hasta = dto.hasta ?? hoyCancun();
    const desdePedido =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desdePedido > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    // INICIO OFICIAL (invariante 86): anclas con piso.
    const desde = await this.pisoDesde(desdePedido);
    const limite = Math.min(dto.limite ?? 15, 40);
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, descripcion, referencia, conciliado, cuenta_bancaria_id, cuenta:cuenta_bancaria(alias, banco, moneda)',
      )
      .eq('conciliado', false)
      .eq('tipo', TipoMovimientoBancario.CARGO)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true })
      .limit(limite);
    if (dto.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const propuestas: Array<{
      movimiento_id: string;
      fecha: string;
      monto: number;
      descripcion: string | null;
      referencia: string | null;
      gasto_id_sugerido: string | null;
      confianza: number;
      razon: string;
      evidencias: string[];
      alternativas: SugerenciaConciliacion['alternativas'];
      motivo_sin_match: string | null;
      /** Ficha del gasto propuesto (null si la IA no propuso ninguno). */
      gasto: SugerenciaConciliacion['candidatos'][number] | null;
      candidatos: SugerenciaConciliacion['candidatos'];
      candidatos_n: number;
    }> = [];
    let errores = 0;
    let sinCandidatos = 0;
    // ¿El asistente contestó ALGUNA vez? Si pyservices no está configurado o
    // no responde, todas vuelven `disponible:false` y decir «la IA no
    // encontró propuestas» sería mentir: nunca se le preguntó.
    let consultados = 0;
    let disponibles = 0;
    let notaNoDisponible: string | null = null;
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      try {
        const s = await this.sugerirDeMovimiento(m, userId);
        if (s.candidatos.length === 0) {
          sinCandidatos += 1;
          continue;
        }
        consultados += 1;
        if (s.disponible) disponibles += 1;
        else notaNoDisponible ??= s.razon || null;
        propuestas.push({
          movimiento_id: m.id as string,
          fecha: m.fecha as string,
          monto: Number(m.monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          gasto_id_sugerido: s.gasto_id_sugerido,
          confianza: s.confianza,
          razon: s.razon,
          evidencias: s.evidencias ?? [],
          alternativas: s.alternativas ?? [],
          motivo_sin_match: s.motivo_sin_match ?? null,
          // Ficha del gasto propuesto y lista de candidatos: sin ellas el
          // panel solo podría pintar un uuid y el operador no tendría con
          // qué confirmar (la IA propone, la persona decide).
          gasto: s.candidatos.find((c) => c.id === s.gasto_id_sugerido) ?? null,
          candidatos: s.candidatos,
          candidatos_n: s.candidatos.length,
        });
      } catch (err) {
        errores += 1;
        this.logger.warn(
          `sugerir-lote: movimiento ${m.id as string}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const conPropuesta = propuestas.filter((p) => p.gasto_id_sugerido).length;
    return {
      revisados: (data ?? []).length,
      con_propuesta: conPropuesta,
      sin_candidatos: sinCandidatos,
      // Alias del contrato del panel (mismo dato, su nombre): cuántos
      // pendientes se quedaron sin una propuesta que confirmar.
      sin_propuesta: (data ?? []).length - conPropuesta,
      errores,
      desde,
      hasta,
      limite,
      // `false` SOLO si se preguntó y NADIE contestó: el panel lo dice tal
      // cual («el asistente no está configurado») en vez de «no encontró
      // nada».
      disponible: consultados === 0 ? true : disponibles > 0,
      nota: consultados > 0 && disponibles === 0 ? notaNoDisponible : null,
      propuestas,
    };
  }

  /** Gastos sin conciliar dentro de ±MATCH_DAYS días y ±MATCH_MONTO_PCT de monto. */
  private async candidatosCercanos(
    monto: number,
    fecha: string,
    moneda: string | null,
  ): Promise<SugerenciaConciliacion['candidatos']> {
    const { desde: lo, hasta: hi } = ventanaDias(fecha, MATCH_DAYS);

    const delta = Math.abs(monto) * MATCH_MONTO_PCT;
    const montoLo = monto - delta;
    const montoHi = monto + delta;

    const traer = async (opts: {
      moneda: string | null;
      montoMin?: number;
      montoMax?: number;
      mayorQue?: number;
      limite: number;
      /** Un fallo aquí no debe tumbar la sugerencia completa. */
      tolerante?: boolean;
    }) => {
      const { data, error } = await this.gastosCandidatosRicos({
        desde: lo,
        hasta: hi,
        ...opts,
      });
      if (error) {
        if (opts.tolerante) return [];
        throw new Error(error.message);
      }
      return data ?? [];
    };

    const propiosRaw = await traer({
      moneda,
      montoMin: montoLo,
      montoMax: montoHi,
      limite: 15,
    });

    // PAGOS PARCIALES (14-sep-2026): una factura pagada en dos cargos tiene
    // `monto` MAYOR que este cargo — no cae en la banda de monto. Se buscan
    // aparte los gastos más caros de la ventana y se comparan contra su
    // FALTANTE (monto − lo ya vinculado), que es lo que este cargo cubriría.
    let masCaros: Array<Record<string, unknown>> = [];
    if (montoHi > 0) {
      masCaros = await traer({
        moneda,
        mayorQue: montoHi,
        limite: 40,
        tolerante: true,
      });
    }

    const vinculado = await this.sumasLigadasDe([
      ...propiosRaw.map((g) => g.id as string),
      ...masCaros.map((g) => g.id as string),
    ]);

    const aCandidato = (
      g: Record<string, unknown>,
      tcImplicito: number | null,
    ) =>
      this.aCandidatoGasto(g, tcImplicito, vinculado.get(g.id as string) ?? 0);
    const propios = propiosRaw.map((g) => aCandidato(g, null));
    const parciales = masCaros
      .filter((g) => {
        const ligado = vinculado.get(g.id as string) ?? 0;
        if (!(ligado > 0)) return false;
        const falta = faltanteDe(Number(g.monto), ligado);
        return falta >= montoLo && falta <= montoHi;
      })
      .map((g) => aCandidato(g, null));

    // Cuenta en PESOS: una compra EN DÓLARES cuyo cargo llegó en MXN no cae
    // en la banda del monto — se ofrece aparte si su TC implícito (cargo ÷
    // gasto USD) es plausible, con el TC visible para que el operador decida.
    // Desde el 0.0.75 (invariante 70): se leen EN BANDA, con el T.C. oficial
    // de TABLA del día del cargo; los LEJOS del oficial ya NO se mandan a la
    // IA y los que van llevan `tc_cruce` (pyservices ignora el campo extra).
    if (moneda !== 'MXN' || !(monto > 0)) return [...propios, ...parciales];
    const banda = rangoBandaUsd(monto);
    const usd = await traer({
      moneda: 'USD',
      montoMin: banda.min,
      montoMax: banda.max,
      limite: 15,
      tolerante: true,
    });
    if (usd.length === 0) return [...propios, ...parciales];
    const [ligadosUsd, oficiales] = await Promise.all([
      this.sumasLigadasDe(usd.map((g) => g.id as string)),
      this.oficialesTabla([fecha]),
    ]);
    // Revisión del lote 2 (14-oct-2026): con la LECTURA del oficial fallida
    // no se puede saber cuáles quedan LEJOS (+24.3 % del caso Aircraft
    // Spruce): los cruzados NO se mandan a la IA (antes iban todos como
    // «sin oficial», los LEJOS incluidos). Los de la moneda de la cuenta sí.
    if (oficiales === null) {
      this.logger.warn(
        `Sugerir: no se pudo leer el T.C. oficial del ${String(fecha).slice(0, 10)}; las compras en USD no se mandan a la IA.`,
      );
      return [...propios, ...parciales];
    }
    const oficial = oficiales.get(String(fecha).slice(0, 10)) ?? null;
    const cruzados = usd
      .filter((g) => !((ligadosUsd.get(g.id as string) ?? 0) > 0))
      .map((g) => {
        const ev = evaluarTcCruce(monto, Number(g.monto), oficial);
        if (!ev || !ev.en_banda || ev.nivel === 'LEJOS') return null;
        return this.aCandidatoGasto(g, ev.tc_implicito, 0, {
          tcCruce: tcCruceUsdPublico(ev),
        });
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return [...propios, ...parciales, ...cruzados];
  }

  /**
   * Ficha de un gasto candidato (FUENTE ÚNICA: la IA, «Vincular gasto» y
   * `GET …/gastos-candidatos` pintan exactamente esto). `ligado` = lo ya
   * vinculado del banco (pagos parciales).
   */
  private aCandidatoGasto(
    g: Record<string, unknown>,
    tcImplicito: number | null,
    ligado: number,
    /**
     * ADITIVO (0.0.75): con la factura que cita el concepto del cargo, el
     * candidato lleva `coincide_factura` (de la fila CRUDA: `gastoRicoCols`
     * ya trae folio, IA, factura y notas). Sin ella, la ficha de siempre.
     */
    opts: {
      factura?: FacturaConcepto | null;
      /**
       * ADITIVO (0.0.75, invariante 70): SOLO en los cruzados (USD contra
       * cuenta MXN), su T.C. contra el oficial del día del cargo.
       */
      tcCruce?: TcCruceUsd | null;
    } = {},
  ): SugerenciaConciliacion['candidatos'][number] {
    const prov = unwrapOne(
      g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
    );
    const vuelo = unwrapOne(g.vuelo as { folio?: unknown } | null);
    const avion = unwrapOne(g.aeronave as { matricula?: unknown } | null);
    const captura = unwrapOne(g.captura as { nombre?: unknown } | null);
    const candado = candadoMesDelVuelo(g);
    return {
      id: g.id as string,
      fecha: (g.fecha_gasto as string | null) ?? null,
      monto: Number(g.monto),
      moneda: (g.moneda as string | null) ?? undefined,
      tc_implicito: tcImplicito,
      proveedor: typeof prov?.nombre === 'string' ? prov.nombre : null,
      // Aditivos (14-sep-2026): con pagos parciales el candidato se juzga
      // por lo que FALTA, no por su monto total.
      monto_vinculado: ligado,
      faltante: faltanteDe(Number(g.monto), ligado),
      // Aditivos (15-sep-2026): el contexto que la IA no tenía y que el
      // panel también pinta en el selector de «Vincular gasto».
      medio_pago: (g.medio_pago as string | null) ?? null,
      tarjeta_terminacion: (g.tarjeta_terminacion as string | null) ?? null,
      categoria: (g.categoria as string | null) ?? null,
      lugar: (g.lugar as string | null) ?? null,
      nota: primeraLinea(g.notas as string | null) || null,
      matricula: typeof avion?.matricula === 'string' ? avion.matricula : null,
      vuelo_folio: vuelo?.folio == null ? null : Number(vuelo.folio),
      capturado_por:
        typeof captura?.nombre === 'string' ? captura.nombre : null,
      // ADITIVO (5-oct-2026): número de la factura del gasto.
      folio_comprobante: folioComprobanteDeFila(g),
      ...(opts.factura
        ? {
            coincide_factura: coincideFacturaConGasto(
              opts.factura,
              foliosDeGastoCrudo(g),
            ),
          }
        : {}),
      ...(opts.tcCruce ? { tc_cruce: opts.tcCruce } : {}),
      // ADITIVO (0.0.76): la regla del 409 FUERA_DEL_MES_DEL_VUELO. Solo
      // viaja con candado (como `tc_cruce`): ausente = sin candado.
      ...(candado
        ? {
            candado_mes_vuelo: {
              vuelo_dia: candado.dia,
              vuelo_folio: candado.folio,
            },
          }
        : {}),
    };
  }

  /**
   * `GET movimientos/:id/gastos-candidatos` (2-oct-2026, API 0.0.52): los
   * gastos que podrían pagar ESTE cargo, para elegir uno o VARIOS («lote»).
   * Caso real: 29 «Pago VIP SAESA» casi iguales; la lista precargada del
   * panel (200 gastos, ±3 días en el selector) dejaba fuera el del 14-sep.
   *
   * Universo: medio bancario, `conciliado = false` (los de pago parcial
   * entran con su `faltante`), moneda de la cuenta y `fecha_gasto` en
   * ±`dias` de la fecha del cargo; en cuenta MXN y sin búsqueda, también
   * los USD con T.C. implícito 15–25 (`cruzado: true`, solo 1 a 1).
   * Búsqueda (`interpretarBusquedaGasto`): monto entero ⇒ [q, q+1),
   * con decimales ⇒ ±0.01; texto ⇒ proveedor (consulta aparte, ≤ 50 ids) o
   * nota/lugar/folio del ticket (`patronIlikeSeguro`). Orden
   * `ordenarCandidatosGasto`; `truncado` = había más de los que caben.
   *
   * EXCLUIDOS (6-oct-2026, API 0.0.63): SOLO con la lista VACÍA viajan
   * `excluidos` + `excluidos_monto` (`excluidosDeCandidatos`): los gastos
   * del mismo monto que NO entraron y por qué. Con candidatos la respuesta
   * es la del 0.0.62 y no se hace ninguna consulta extra.
   *
   * NO BANCARIOS (6-oct-2026, API 0.0.63): con `incluir_no_bancarios` el
   * universo es todo medio MENOS BODEGA (efectivo y PERSONAL_* entran con
   * las mismas reglas: sin conciliar, moneda de la cuenta, ventana,
   * búsqueda) y cada candidato lleva `no_bancario`. Los cruzados (USD contra
   * cuenta MXN) siguen siendo SOLO bancarios: la BD le derivaría `tc_gasto`
   * del cargo a un gasto en efectivo que ese cargo no pagó. Orden por
   * NIVELES (`ordenarCandidatosPorNiveles`, revisión 6-oct-2026): bancarios
   * que cuadran, no bancarios que cuadran, resto de bancarios, resto de no
   * bancarios — con «todos los bancarios primero», el corte a `limite` dejaba
   * fuera el efectivo que SÍ cuadraba. Ligarlos exige `justificacion` en el
   * PATCH.
   */
  /**
   * Búsqueda de TEXTO de «Vincular gasto» ⇒ el `.or()` de PostgREST:
   * proveedores que se llaman así (≤ 50 ids, consulta aparte) o
   * nota / lugar / folio del ticket (`patronIlikeSeguro`). Otra búsqueda ⇒ null.
   */
  private async orTextoBusquedaGasto(
    busqueda: BusquedaGasto,
  ): Promise<string | null> {
    if (busqueda.tipo !== 'texto') return null;
    const patron = patronIlikeSeguro(busqueda.texto);
    const { data: provs, error: provErr } = await this.supabase.service
      .from('proveedor')
      .select('id')
      .ilike('nombre', `%${patron}%`)
      .limit(50);
    if (provErr) throw new Error(provErr.message);
    const provIds = ((provs ?? []) as Array<{ id: unknown }>)
      .map((p) => p.id)
      .filter((id): id is string => typeof id === 'string');
    return [
      `notas.ilike.*${patron}*`,
      `lugar.ilike.*${patron}*`,
      `folio_ticket.ilike.*${patron}*`,
      ...(provIds.length > 0 ? [`proveedor_id.in.(${provIds.join(',')})`] : []),
    ].join(',');
  }

  /**
   * UNIVERSO de «Vincular gasto» (lector ÚNICO: un cargo y varios cargos):
   * sin conciliar, medio bancario (o, con `conNoBancarios`, todo menos
   * BODEGA — `medio_pago` es NOT NULL: el `neq` no pierde nulos), en la
   * moneda dada y la ventana, con el rango de monto y el texto de la
   * búsqueda; tope `CANDIDATOS_GASTO_TOPE`. Un error se LANZA.
   */
  private async leerUniversoGastos(opts: {
    cols: string;
    moneda: string;
    conNoBancarios: boolean;
    ventana: { desde: string; hasta: string };
    montos: RangoMontoGasto | null;
    orTexto: string | null;
  }): Promise<Array<Record<string, unknown>>> {
    let qb = this.supabase.service
      .from('gasto')
      .select(opts.cols)
      .eq('conciliado', false);
    qb = opts.conNoBancarios
      ? qb.neq('medio_pago', MEDIO_BODEGA)
      : qb.in('medio_pago', MEDIOS_BANCARIOS);
    qb = qb
      .eq('moneda', opts.moneda)
      .gte('fecha_gasto', opts.ventana.desde)
      .lte('fecha_gasto', opts.ventana.hasta);
    if (opts.montos) {
      qb = qb.gte('monto', opts.montos.min);
      qb = opts.montos.maxExclusivo
        ? qb.lt('monto', opts.montos.max)
        : qb.lte('monto', opts.montos.max);
    }
    if (opts.orTexto) qb = qb.or(opts.orTexto);
    const { data, error } = await qb
      .order('fecha_gasto', { ascending: false })
      .order('id', { ascending: true })
      .limit(CANDIDATOS_GASTO_TOPE);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Array<Record<string, unknown>>;
  }

  async gastosCandidatosDeMovimiento(
    movId: string,
    query: Partial<
      Pick<
        GastosCandidatosQuery,
        'q' | 'dias' | 'limite' | 'incluir_no_bancarios'
      >
    >,
  ): Promise<GastosCandidatosRespuesta> {
    if (!(await this.partesOn())) throw errorPartesNoDisponibles();
    const dias = Math.min(180, Math.max(1, Math.trunc(query.dias ?? 30)));
    const limite = Math.min(300, Math.max(1, Math.trunc(query.limite ?? 100)));
    const incluirNoBancarios = query.incluir_no_bancarios === true;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, fecha, monto, tipo, cuenta_bancaria_id, descripcion')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as Record<string, unknown>;
    if (mov.tipo !== (TipoMovimientoBancario.CARGO as string)) {
      throw new BadRequestException({
        message: MENSAJE_SOLO_CARGOS,
        error: 'SOLO_CARGOS',
      });
    }
    // CONCEPTO DEL SPEI (0.0.75): la factura que cita el cargo («fact vip
    // 7360») marca ★ el candidato con ese folio (dentro de su nivel).
    const fc = facturaDeConcepto(
      typeof mov.descripcion === 'string' ? mov.descripcion : null,
    );
    const moneda = await this.monedaCuenta(mov.cuenta_bancaria_id as string);
    if (!moneda) throw errorSinMonedaCuenta();
    const fecha = typeof mov.fecha === 'string' ? mov.fecha.slice(0, 10) : '';
    const montoCargo = r2(Math.abs(Number(mov.monto)) || 0);
    const ventana = ventanaDias(fecha, dias);
    const busqueda = interpretarBusquedaGasto(query.q);

    // Texto: proveedores que se llaman así (≤ 50), en una consulta aparte.
    const orTexto = await this.orTextoBusquedaGasto(busqueda);

    const colsRicas = await this.gastoRicoCols();
    type RangoMonto = RangoMontoGasto;
    const rangoBusqueda: RangoMonto | null =
      busqueda.tipo === 'monto'
        ? {
            min: busqueda.min,
            max: busqueda.max,
            maxExclusivo: busqueda.maxExclusivo,
          }
        : null;
    // Lector COMPARTIDO con «Vincular a un gasto» de varios cargos
    // (14-oct-2026): la MISMA consulta de siempre, extraída sin cambios.
    const leer = (
      monedaQ: string,
      conNoBancarios: boolean,
      montos: RangoMonto | null,
    ) =>
      this.leerUniversoGastos({
        cols: colsRicas,
        moneda: monedaQ,
        conNoBancarios,
        ventana,
        montos,
        orTexto,
      });

    const propios = await leer(moneda, incluirNoBancarios, rangoBusqueda);
    // CRUCE USD (0.0.75, invariante 70): en una cuenta en PESOS los gastos
    // USD BANCARIOS sin conciliar en banda del cargo entran SIEMPRE (también
    // al buscar), cada uno con su `tc_cruce` contra el T.C. oficial de TABLA
    // del día del cargo (lectura fallida ⇒ SIN_OFICIAL y sin el rango
    // equivalente). Cruzados SOLO bancarios, también con la bandera
    // (revisión 6-oct-2026): ligar 1 ↔ 1 un gasto en efectivo en dólares
    // haría que `recalcular_gasto_conciliado` le derive `tc_gasto` de ESTE
    // cargo. La raíz `tc_oficial` viaja SIEMPRE (capacidad del panel).
    // Revisión del lote 2 (14-oct-2026): la lectura FALLIDA ya no se
    // disfraza de «sin T.C. oficial del día» — `tc_cruce` dice que no se
    // pudo leer (`lectura_fallida`) y la raíz `tc_oficial_lectura_fallida`
    // (como el auto-cruce, que ya daba ERROR `TEXTO_CRUCE_USD_SIN_LECTURA_TC`).
    let tcOficial: OficialDelDia | null = null;
    let tcLecturaFallida = false;
    let cruzados: Array<{ g: Record<string, unknown>; ev: TcCruceUsd }> = [];
    let leidosUsd = 0;
    if (moneda === 'MXN' && montoCargo > 0) {
      const oficiales = await this.oficialesTabla([fecha]);
      tcLecturaFallida = oficiales === null;
      tcOficial = oficiales?.get(fecha) ?? null;
      // Búsqueda de monto ⇒ DOS lecturas (dólares tal cual y, con oficial,
      // el equivalente en pesos ÷ oficial ±3 %); vacía o texto ⇒ la banda.
      // Nunca `.or(and(…))`: se unen por id y se filtra EXACTO en banda.
      const rangos: RangoMonto[] =
        busqueda.tipo === 'monto'
          ? rangosUsdDeBusqueda(busqueda, tcOficial?.tc ?? null)
          : [{ ...rangoBandaUsd(montoCargo), maxExclusivo: false }];
      const porId = new Map<string, Record<string, unknown>>();
      for (const r of rangos) {
        const leidos = await leer('USD', false, r);
        leidosUsd = Math.max(leidosUsd, leidos.length);
        for (const g of leidos) {
          if (typeof g.id === 'string' && !porId.has(g.id)) porId.set(g.id, g);
        }
      }
      const usd = [...porId.values()];
      const conPartes =
        usd.length > 0
          ? await this.sumasLigadasDe(usd.map((g) => g.id as string))
          : new Map<string, number>();
      cruzados = usd
        .filter((g) => !((conPartes.get(g.id as string) ?? 0) > 0))
        .map((g) => {
          const ev = evaluarTcCruce(montoCargo, Number(g.monto), tcOficial);
          return ev && ev.en_banda
            ? {
                g,
                ev: tcCruceUsdPublico(ev, { lecturaFallida: tcLecturaFallida }),
              }
            : null;
        })
        .filter(
          (x): x is { g: Record<string, unknown>; ev: TcCruceUsd } =>
            x !== null,
        );
    }
    const vinculado = await this.sumasLigadasDe(
      propios.map((g) => g.id as string),
    );
    const conMedio = <T extends { medio_pago?: string | null }>(c: T) => ({
      ...c,
      no_bancario: !esMedioBancario(c.medio_pago),
    });
    const candidatos = [
      ...propios.map((g) =>
        conMedio(
          this.aCandidatoGasto(g, null, vinculado.get(g.id as string) ?? 0, {
            factura: fc,
          }),
        ),
      ),
      ...cruzados.map((x) =>
        conMedio({
          ...this.aCandidatoGasto(x.g, x.ev.tc_implicito, 0, {
            factura: fc,
            tcCruce: x.ev,
          }),
          cruzado: true as const,
        }),
      ),
    ];
    // Por NIVELES: lo que cuadra con el cargo (bancario y luego no
    // bancario) antes que el resto, para que el corte a `limite` no deje
    // fuera el efectivo exacto. Sin la bandera es el orden del 0.0.62.
    const ordenados = ordenarCandidatosPorNiveles(candidatos, {
      montoCargo,
      fecha,
    });
    const respuesta: GastosCandidatosRespuesta = {
      movimiento: { id: movId, fecha, monto: montoCargo, moneda },
      ventana,
      candidatos: ordenados.slice(0, limite),
      truncado:
        ordenados.length > limite ||
        propios.length >= CANDIDATOS_GASTO_TOPE ||
        leidosUsd >= CANDIDATOS_GASTO_TOPE,
      // ADITIVO (0.0.75, invariante 70): SIEMPRE presente (capacidad del
      // panel); null en cuenta no MXN, sin dato o con la lectura fallida.
      tc_oficial: tcOficial
        ? {
            tc: tcOficial.tc,
            fecha_dato: tcOficial.fecha_dato,
            fuente: tcOficial.fuente,
          }
        : null,
      ...(tcLecturaFallida
        ? { tc_oficial_lectura_fallida: true as const }
        : {}),
    };
    if (fc) {
      // ADITIVO (0.0.75): la factura del concepto y los OTROS gastos que la
      // tienen (sin `fc`, la respuesta es byte a byte la de siempre).
      respuesta.factura_concepto = {
        tipo: fc.tipo,
        numeros: fc.numeros.map((n) => n.texto),
        texto: fc.texto,
        pista: fc.pista,
        otros_gastos: await this.otrosGastosConFactura(fc, {
          movId,
          fecha,
          dias,
          ventana,
          monedaCuenta: moneda,
          incluirNoBancarios,
          candidatoIds: new Set(ordenados.map((c) => c.id)),
        }),
      };
    }
    if (ordenados.length > 0) return respuesta;
    const excluidos = await this.excluidosDeCandidatos({
      movId,
      q: query.q,
      montoCargo,
      monedaCuenta: moneda,
      fecha,
      dias,
      ventana,
      incluirNoBancarios,
      // CRUCE USD (0.0.75): en cuenta MXN un USD bancario en banda es del
      // universo (ya no OTRA_MONEDA).
      cruzadosUsd: moneda === 'MXN',
    });
    return excluidos ? { ...respuesta, ...excluidos } : respuesta;
  }

  /**
   * `excluidos` de «Vincular gasto» (6-oct-2026, API 0.0.63; caso real: el
   * cargo de $212.00 del 07-sep y sus tres gastos de $212.00 en EFECTIVO).
   * Gastos del MISMO monto (el de `q` si es numérico —entero ⇒ su mismo
   * rango [q, q+1), `rangoMontoExcluidos`—; si no, el del cargo; ±0.01) a
   * ±max(120, dias) del cargo que NO entraron a los candidatos,
   * agrupados por motivo (`candidatos-excluidos.util`, puro). UNA consulta
   * extra filtrada por monto y fechas (el tope de 1000 no aplica) y, SOLO
   * si hay `YA_CONCILIADO`, la puente de esos ≤ 5 gastos para decir con qué
   * cargo (detrás de la sonda: el endpoint ya respondió 503 sin ella).
   * BEST-EFFORT: si la consulta falla devuelve null y la respuesta sale
   * SIN `excluidos`, como el 0.0.62 (el panel pinta el vacío de siempre).
   */
  /**
   * «Vincular gasto» de un cargo cuyo concepto cita una factura (0.0.75,
   * invariante 69): los gastos a ±max(120, dias) que TIENEN esa factura y
   * no salen como candidatos, agrupados como `excluidos` (con quién está
   * conciliado cada YA_CONCILIADO: posible pago doble o liga equivocada).
   * Se busca por los DÍGITOS sin ceros (solo [0-9]: seguros en `.or`):
   * (A) `folio_ticket` / `notas` que los contienen y (B), con la sonda de
   * serie/folio, los gastos de las facturas recibidas cuyo folio termina en
   * ellos; después filtra EXACTO con `coincideFacturaConGasto`. BEST-EFFORT:
   * error ⇒ null + warn.
   */
  private async otrosGastosConFactura(
    fc: FacturaConcepto,
    ctx: {
      movId: string;
      fecha: string;
      dias: number;
      ventana: { desde: string; hasta: string };
      monedaCuenta: string;
      incluirNoBancarios: boolean;
      candidatoIds: ReadonlySet<string>;
    },
  ): Promise<GrupoExcluidos[] | null> {
    try {
      const digitos = [
        ...new Set(
          fc.numeros.map((n) => n.digitos).filter((d) => /^\d+$/.test(d)),
        ),
      ];
      if (digitos.length === 0) return [];
      const rango = ventanaExcluidos(ctx.fecha, ctx.dias);
      const cols = `${GASTO_EXCLUIDO_COLS}, notas, ${await this.embedFolio()}`;
      const sb = this.supabase.service;
      const { data: dataA, error: errA } = await sb
        .from('gasto')
        .select(cols)
        .or(
          digitos
            .flatMap((d) => [`folio_ticket.ilike.*${d}*`, `notas.ilike.*${d}*`])
            .join(','),
        )
        .gte('fecha_gasto', rango.desde)
        .lte('fecha_gasto', rango.hasta)
        .limit(EXCLUIDOS_LECTURA_TOPE);
      if (errA) throw new Error(errA.message);
      const porId = new Map<string, Record<string, unknown>>();
      for (const g of (dataA ?? []) as unknown as Array<
        Record<string, unknown>
      >) {
        if (typeof g.id === 'string') porId.set(g.id, g);
      }
      if (await serieFolioRecibidaDisponible(sb)) {
        const facturaIds = new Set<string>();
        for (const d of digitos) {
          const { data: fr, error: errF } = await sb
            .from('factura_recibida')
            .select('id')
            .ilike('folio', `%${d}`)
            .limit(50);
          if (errF) throw new Error(errF.message);
          for (const f of (fr ?? []) as Array<{ id?: unknown }>) {
            if (typeof f.id === 'string') facturaIds.add(f.id);
          }
        }
        if (facturaIds.size > 0) {
          const { data: dataB, error: errB } = await sb
            .from('gasto')
            .select(cols)
            .in('factura_recibida_id', [...facturaIds])
            .gte('fecha_gasto', rango.desde)
            .lte('fecha_gasto', rango.hasta)
            .limit(EXCLUIDOS_LECTURA_TOPE);
          if (errB) throw new Error(errB.message);
          for (const g of (dataB ?? []) as unknown as Array<
            Record<string, unknown>
          >) {
            if (typeof g.id === 'string' && !porId.has(g.id))
              porId.set(g.id, g);
          }
        }
      }
      const filas = [...porId.values()]
        .filter(
          (g) =>
            !ctx.candidatoIds.has(g.id as string) &&
            coincideFacturaConGasto(fc, foliosDeGastoCrudo(g)),
        )
        .map((g) => gastoExcluibleDeFila(g))
        .filter((g): g is GastoExcluible => g !== null);
      const grupos = agruparExcluidos(filas, {
        monedaCuenta: ctx.monedaCuenta,
        ventana: ctx.ventana,
        fechaCargo: ctx.fecha,
        incluirNoBancarios: ctx.incluirNoBancarios,
      });
      const yaConciliados = grupos.find((g) => g.motivo === 'YA_CONCILIADO');
      if (!yaConciliados) return grupos;
      return conCargosConciliados(
        grupos,
        await this.cargosConciliadosDe(yaConciliados.gastos.map((g) => g.id)),
      );
    } catch (err) {
      this.logger.warn(
        `gastos-candidatos ${ctx.movId}: no se pudieron leer los otros gastos de ${fc.texto}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async excluidosDeCandidatos(opts: {
    movId: string;
    q: string | undefined;
    montoCargo: number;
    monedaCuenta: string;
    fecha: string;
    dias: number;
    ventana: { desde: string; hasta: string };
    /** Con la bandera, efectivo / PERSONAL_* ya son del universo. */
    incluirNoBancarios?: boolean;
    /** Cuenta MXN (0.0.75): los USD bancarios en banda son del universo. */
    cruzadosUsd?: boolean;
  }): Promise<ExcluidosCandidatos | null> {
    const monto = montoReferenciaExcluidos(opts.q, opts.montoCargo);
    if (!(monto > 0)) return { excluidos: [], excluidos_monto: monto };
    try {
      // El MISMO rango de monto que la búsqueda de los candidatos («212» ⇒
      // [212, 213)): lo que la búsqueda abarca y no salió, se explica.
      const montos = rangoMontoExcluidos(opts.q, opts.montoCargo);
      const rango = ventanaExcluidos(opts.fecha, opts.dias);
      const consulta = this.supabase.service
        .from('gasto')
        .select(GASTO_EXCLUIDO_COLS)
        .gte('monto', montos.min);
      const { data, error } = await (
        montos.maxExclusivo
          ? consulta.lt('monto', montos.max)
          : consulta.lte('monto', montos.max)
      )
        .gte('fecha_gasto', rango.desde)
        .lte('fecha_gasto', rango.hasta)
        .order('fecha_gasto', { ascending: false })
        .order('id', { ascending: true })
        .limit(EXCLUIDOS_LECTURA_TOPE);
      if (error) throw new Error(error.message);
      const filas = ((data ?? []) as unknown as Array<Record<string, unknown>>)
        .map((f) => gastoExcluibleDeFila(f))
        .filter((g): g is GastoExcluible => g !== null);
      const grupos = agruparExcluidos(filas, {
        monedaCuenta: opts.monedaCuenta,
        ventana: opts.ventana,
        fechaCargo: opts.fecha,
        incluirNoBancarios: opts.incluirNoBancarios === true,
        ...(opts.cruzadosUsd
          ? { montoCargo: opts.montoCargo, cruzadosUsd: true }
          : {}),
      });
      const yaConciliados = grupos.find((g) => g.motivo === 'YA_CONCILIADO');
      if (!yaConciliados) return { excluidos: grupos, excluidos_monto: monto };
      const cargos = await this.cargosConciliadosDe(
        yaConciliados.gastos.map((g) => g.id),
      );
      return {
        excluidos: conCargosConciliados(grupos, cargos),
        excluidos_monto: monto,
      };
    } catch (err) {
      this.logger.warn(
        `gastos-candidatos ${opts.movId}: no se pudieron leer los excluidos: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * gasto_id ⇒ cargos con los que YA está conciliado (puente + fecha y
   * cuenta del movimiento). `null` si la lectura falla: el grupo
   * `YA_CONCILIADO` viaja igual, sin decir con qué cargo.
   */
  private async cargosConciliadosDe(
    gastoIds: string[],
  ): Promise<Map<string, CargoConciliadoExcluido[]> | null> {
    try {
      const partes = await this.partesDeGastos(gastoIds);
      if (partes.length === 0) return new Map();
      const movs = await this.leerPorLotes(
        partes.map((p) => p.movimiento_id),
        (lote) =>
          this.supabase.service
            .from('movimiento_bancario')
            .select('id, fecha, cuenta:cuenta_bancaria(alias)')
            .in('id', lote),
      );
      return cargosConciliadosPorGasto(partes, movs);
    } catch (err) {
      this.logger.warn(
        `gastos-candidatos: no se pudo leer con qué cargo están conciliados ${gastoIds.length} gasto(s): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Candidatos con TODO el contexto que se le manda a la IA y al panel
   * (matrícula, vuelo, captura). Mismo universo que `gastosCandidatos`: solo
   * cambia el select.
   */
  private async gastosCandidatosRicos(opts: {
    moneda: string | null;
    desde: string;
    hasta: string;
    montoMin?: number;
    montoMax?: number;
    mayorQue?: number;
    limite: number;
  }): Promise<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }> {
    let q = this.supabase.service
      .from('gasto')
      .select(await this.gastoRicoCols())
      .eq('conciliado', false)
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', opts.desde)
      .lte('fecha_gasto', opts.hasta);
    if (opts.moneda) q = q.eq('moneda', opts.moneda);
    if (opts.montoMin != null) q = q.gte('monto', opts.montoMin);
    if (opts.montoMax != null) q = q.lte('monto', opts.montoMax);
    if (opts.mayorQue != null) q = q.gt('monto', opts.mayorQue);
    const { data, error } = await q.limit(opts.limite);
    return {
      data: (data ?? null) as Array<Record<string, unknown>> | null,
      error: error ? { message: error.message } : null,
    };
  }

  // =====================================================================
  // CONCILIACIÓN DE INGRESOS (24-sep-2026, contrato §6) — abono ↔ ingreso,
  // «Por conciliar» y «Sugerir con IA». Todo detrás de la sonda: sin la
  // migración responde 503 INGRESOS_NO_DISPONIBLE.
  // =====================================================================

  /**
   * Liga (o desvincula con `ingresoId = null`) un ABONO con un INGRESO
   * registrado (regla 6.3). 1 ↔ 1 y EXCLUYENTE con gasto/cobro/sobre/
   * clasificación (CHECK + índice único en BD); cambiar de ingreso exige
   * desvincular primero. Re-ligar el MISMO ingreso es idempotente.
   */
  async linkIngreso(
    movId: string,
    ingresoId: string | null,
    userId: string,
  ): Promise<Record<string, unknown>> {
    if (!(await this.ingresosOn())) throw errorIngresosNoDisponibles();
    const sb = this.supabase.service;
    const cols = await this.movCols();
    const { data: movRaw, error: movErr } = await sb
      .from('movimiento_bancario')
      .select(cols)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as Record<string, unknown>;
    const actual =
      typeof mov.ingreso_id === 'string' && mov.ingreso_id
        ? mov.ingreso_id
        : null;

    // ---- DESVINCULAR ----
    if (ingresoId === null) {
      if (!actual) return { ...mov, ingreso: null };
      // CAS sobre la liga leída: si otra petición ya la cambió, no se
      // desvincula a ciegas lo que otro acaba de ligar.
      const { data, error } = await sb
        .from('movimiento_bancario')
        .update({ ingreso_id: null, conciliado: false, updated_by: userId })
        .eq('id', movId)
        .eq('ingreso_id', actual)
        .select(cols)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        throw new ConflictException({
          message:
            'La liga de este abono cambió mientras la desvinculabas: recarga y vuelve a intentarlo.',
          error: 'MOVIMIENTO_YA_LIGADO',
          details: { liga: 'INGRESO' },
        });
      }
      await this.bitacoraIngreso(
        actual,
        'DESCONCILIAR',
        userId,
        { movimiento_id: movId },
        `abono del ${String(mov.fecha)} · ${montoBonito(Number(mov.monto) || 0)}`,
      );
      return {
        ...(data as unknown as Record<string, unknown>),
        ingreso: null,
      };
    }

    // ---- LIGAR ----
    if (mov.tipo !== (TipoMovimientoBancario.ABONO as string)) {
      throw new BadRequestException({
        message: 'Solo un abono (entrada de dinero) se liga a un ingreso.',
        error: 'SOLO_ABONOS',
      });
    }
    // `gastos_n` (lote) no aplica a un ABONO, pero el candado es el mismo.
    const liga = ligadoAGasto(mov)
      ? 'GASTO'
      : mov.cobro_id
        ? 'COBRO'
        : mov.cobro_grupo_id
          ? 'SOBRE'
          : mov.clasificacion_id
            ? 'CLASIFICACION'
            : actual && actual !== ingresoId
              ? 'INGRESO'
              : null;
    if (liga) {
      // OMITIDO (0.0.77, invariante 75): el rechazo de siempre, con el
      // motivo de la omisión cuando la clasificación es la canónica.
      const omitido =
        liga === 'CLASIFICACION' &&
        typeof mov.clasificacion_id === 'string' &&
        mov.clasificacion_id === (await this.idClasificacionOmitido());
      throw new ConflictException({
        message: omitido
          ? mensajeMovimientoOmitido(
              leerOmision(typeof mov.notas === 'string' ? mov.notas : null),
            )
          : liga === 'INGRESO'
            ? 'Este abono ya está conciliado con otro ingreso: desvincúlalo antes de ligar este.'
            : 'Ese movimiento ya está conciliado con otra cosa: desvincúlalo antes.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: omitido ? { liga, omitido: true } : { liga },
      });
    }
    const { data: ingRaw, error: ingErr } = await sb
      .from('ingreso')
      .select(
        'id, folio, categoria, monto, comision_monto, moneda, cuenta_bancaria_id, deleted_at, descripcion',
      )
      .eq('id', ingresoId)
      .maybeSingle();
    if (ingErr) throw new Error(ingErr.message);
    if (!ingRaw) {
      throw new NotFoundException({
        message: 'Ese ingreso ya no existe.',
        error: 'INGRESO_NO_EXISTE',
        details: { ingreso_id: ingresoId },
      });
    }
    const ing = ingRaw as unknown as Record<string, unknown>;
    const etiqueta = etiquetaIngreso(Number(ing.folio));
    const resumen = {
      id: ing.id as string,
      folio: Number(ing.folio),
      categoria: ing.categoria as string,
      monto: Number(ing.monto),
      moneda: ing.moneda as string,
      descripcion: (ing.descripcion as string) ?? '',
    };
    // Re-ligar el MISMO ingreso: idempotente (el reintento del panel).
    if (actual === ingresoId) return { ...mov, ingreso: resumen };
    if (ing.deleted_at) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} está dado de baja.`,
        error: 'INGRESO_DADO_DE_BAJA',
      });
    }
    if (!ing.cuenta_bancaria_id) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} se registró en efectivo: no llegó al banco.`,
        error: 'INGRESO_SIN_CUENTA',
      });
    }
    if (ing.cuenta_bancaria_id !== mov.cuenta_bancaria_id) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} se registró en otra cuenta: corrige la cuenta del ingreso o liga el abono de esa cuenta.`,
        error: 'INGRESO_OTRA_CUENTA',
        details: {
          cuenta_ingreso: ing.cuenta_bancaria_id,
          cuenta_movimiento: mov.cuenta_bancaria_id,
        },
      });
    }
    const info = await this.infoCuenta(mov.cuenta_bancaria_id as string);
    if (!info.moneda || String(ing.moneda) !== info.moneda) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} es en ${String(ing.moneda)} y la cuenta del abono es en ${info.moneda ?? '¿?'}.`,
        error: 'INGRESO_MONEDA_DISTINTA',
      });
    }
    const { data: otro, error: otroErr } = await sb
      .from('movimiento_bancario')
      .select('id, fecha')
      .eq('ingreso_id', ingresoId)
      .neq('id', movId)
      .limit(1)
      .maybeSingle();
    if (otroErr) throw new Error(otroErr.message);
    if (otro) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} ya está conciliado con otro abono (${String((otro as { fecha?: unknown }).fecha)}).`,
        error: 'INGRESO_YA_CONCILIADO',
        details: {
          movimiento_id: (otro as { id: string }).id,
          fecha: (otro as { fecha?: unknown }).fecha ?? null,
        },
      });
    }
    const cuadre = montoCuadraIngreso(
      {
        monto: Number(mov.monto) || 0,
        monto_bruto: mov.monto_bruto == null ? null : Number(mov.monto_bruto),
      },
      {
        monto: Number(ing.monto) || 0,
        comision_monto:
          ing.comision_monto == null ? null : Number(ing.comision_monto),
      },
      TOLERANCIA_INGRESO,
    );
    if (!cuadre.cuadra) {
      const netoIng = netoIngreso(
        Number(ing.monto) || 0,
        ing.comision_monto == null ? null : Number(ing.comision_monto),
      );
      throw new ConflictException({
        message: `El abono es de ${montoBonito(Number(mov.monto) || 0)} y el ingreso ${etiqueta} neto de ${montoBonito(netoIng)}: corrige el monto o la comisión del ingreso.`,
        error: 'INGRESO_MONTO_DISTINTO',
        details: {
          monto_abono: r2(Number(mov.monto) || 0),
          neto_ingreso: netoIng,
          diferencia: cuadre.diferencia,
        },
      });
    }
    // CAS: solo si el abono SIGUE sin ingreso. Sin esta guarda, dos ligas
    // simultáneas del MISMO abono a dos ingresos distintos (auto-cruce
    // inverso + alta manual, dos pestañas) se pisaban: el CHECK excluyente
    // no lo impide (la liga es la misma columna) y el primer ingreso quedaba
    // desconciliado en silencio con su bitácora diciendo CONCILIAR.
    const { data, error } = await sb
      .from('movimiento_bancario')
      .update({
        ingreso_id: ingresoId,
        conciliado: true,
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .is('ingreso_id', null)
      .select(cols)
      .maybeSingle();
    if (!error && !data) {
      throw new ConflictException({
        message:
          'Este abono se acaba de conciliar con otro ingreso: desvincúlalo antes de ligar este.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: { liga: 'INGRESO' },
      });
    }
    if (error) {
      const msg = error.message ?? '';
      if (error.code === '23505' || msg.includes('uq_mov_bancario_ingreso')) {
        throw new ConflictException({
          message: `El ingreso ${etiqueta} ya está conciliado con otro abono.`,
          error: 'INGRESO_YA_CONCILIADO',
          details: { movimiento_id: null, fecha: null },
        });
      }
      if (
        error.code === '23514' ||
        msg.includes('movimiento_bancario_ingreso')
      ) {
        throw new ConflictException({
          message:
            'Ese movimiento ya está conciliado con otra cosa: desvincúlalo antes.',
          error: 'MOVIMIENTO_YA_LIGADO',
          details: { liga: null },
        });
      }
      throw new Error(msg);
    }
    await this.bitacoraIngreso(
      ingresoId,
      'CONCILIAR',
      userId,
      { movimiento_id: movId, por: cuadre.por },
      `abono del ${String(mov.fecha)} · ${montoBonito(Number(mov.monto) || 0)}`,
    );
    return {
      ...(data as unknown as Record<string, unknown>),
      ingreso: resumen,
    };
  }

  /**
   * CAMINO INVERSO para ingresos (espejo de `intentarCruzarGasto`, NUNCA
   * lanza): un ingreso con cuenta registrado DESPUÉS de importar el estado
   * de cuenta busca sus abonos pendientes (misma cuenta, ±días, monto que
   * cuadra) — ≤ 5 — y corre `autoMatchPendientes` sobre ellos: la MISMA
   * decisión unificada liga solo si el ingreso es el candidato único.
   * (Efecto aceptado: esos ≤ 5 abonos corren el cruce COMPLETO, igual que
   * «Cruzar pendientes».)
   */
  async intentarCruzarIngreso(
    ingresoId: string,
    userId: string,
  ): Promise<{
    ligado: boolean;
    movimiento_id: string | null;
    motivo: string;
  }> {
    const nada = (motivo: string) => ({
      ligado: false,
      movimiento_id: null,
      motivo,
    });
    try {
      if (!(await this.ingresosOn())) return nada('Ingresos no habilitados.');
      const { data, error } = await this.supabase.service
        .from('ingreso')
        .select(INGRESO_CANDIDATO_COLS + ', deleted_at')
        .eq('id', ingresoId)
        .maybeSingle();
      if (error) return nada(error.message);
      if (!data) return nada('El ingreso ya no existe.');
      const fila = data as unknown as Record<string, unknown>;
      if (fila.deleted_at) return nada('El ingreso está dado de baja.');
      const ing = this.aIngresoCandidato(fila);
      if (!ing.cuenta_bancaria_id) {
        return nada('Ingreso en efectivo: no pasa por el banco.');
      }
      const ya = await this.ingresosConMovimiento([ingresoId]);
      if (ya.size > 0) return nada('El ingreso ya está conciliado.');
      const info = await this.infoCuenta(ing.cuenta_bancaria_id);
      const pasarela = info.tipo === TIPO_CUENTA_PASARELA;
      const { desde, hasta } = ventanaDias(
        ing.fecha,
        pasarela ? PAYWISE_VENTANA_DIAS : MATCH_DAYS,
      );
      const { data: movs, error: movErr } = await this.supabase.service
        .from('movimiento_bancario')
        .select('id, monto, monto_bruto')
        .eq('tipo', TipoMovimientoBancario.ABONO)
        .eq('conciliado', false)
        .eq('cuenta_bancaria_id', ing.cuenta_bancaria_id)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .limit(50);
      if (movErr) return nada(movErr.message);
      const candidato: CandidatoAbonoCruce = {
        tipo: 'INGRESO',
        id: ing.id,
        monto: ing.monto,
        comision: ing.comision_monto,
        fecha: ing.fecha,
        cliente: ing.cliente,
        cuenta_bancaria_id: ing.cuenta_bancaria_id,
      };
      const ids = ((movs ?? []) as Array<Record<string, unknown>>)
        .filter((m) =>
          cuadraMontoAbono(
            {
              monto: Number(m.monto) || 0,
              monto_bruto: m.monto_bruto == null ? null : Number(m.monto_bruto),
              descripcion: null,
              cuenta_bancaria_id: ing.cuenta_bancaria_id as string,
            },
            candidato,
            pasarela,
          ),
        )
        .map((m) => m.id as string)
        .slice(0, 5);
      if (ids.length === 0) {
        return nada('Ningún abono pendiente del banco cuadra con el ingreso.');
      }
      const r = await this.autoMatchPendientes({ movimiento_ids: ids }, userId);
      const hit = r.detalle.find(
        (d) => d.resultado === 'CONCILIADO' && d.ingreso_id === ingresoId,
      );
      if (hit) {
        this.logger.log(
          `auto-cruce inverso: el ingreso ${ingresoId} se ligó con el abono ${hit.movimiento_id}.`,
        );
        return {
          ligado: true,
          movimiento_id: hit.movimiento_id,
          motivo: `Ligado por ${hit.criterio ?? 'MONTO_EXACTO'}.`,
        };
      }
      return nada(
        `${ids.length} abono(s) cuadran con el ingreso pero ninguno es inequívoco: vincúlalo a mano.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`auto-cruce inverso del ingreso ${ingresoId}: ${msg}`);
      return nada(msg);
    }
  }

  /**
   * Lee EN LOTE todo lo que hace falta para decidir qué es cada abono
   * pendiente (una sola vez por respuesta, jamás una consulta por fila):
   * cuentas, clientes ACTIVOS (nombre del ordenante), líneas del banco de
   * esas cuentas (duplicados), y los candidatos LIBRES de la ventana
   * [min − 30, max + 30] — cobros positivos sin sobre ni anticipo, sobres,
   * ingresos vivos con cuenta —, paginados (PostgREST corta en 1000). Si
   * una lectura de candidatos falla o llega al tope, `completo = false`.
   *
   * UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): con la sonda de
   * 20261014000003 un cobro está ocupado por su COBERTURA, no por «tener
   * liga»: la puente (universo paginado por su llave completa, con el abono
   * y su cuenta embebidos: `colsPuenteLigas`) da las partes y
   * `cobroParaCruce` decide — cubierto, cruzado o «de un solo abono» ⇒
   * ocupado; parcial de banco ⇒ libre con `faltante` (la MISMA regla del
   * auto-cruce). Sin la sonda, cualquier liga ocupa (como el 0.0.77).
   */
  private async contextoAbonos(
    abonos: Array<Record<string, unknown>>,
  ): Promise<{
    cuentas: Map<
      string,
      { alias: string | null; moneda: string | null; tipo: string | null }
    >;
    clientes: Array<{ id: string; nombre: string }>;
    lineas: Array<{
      id: string;
      cuenta_bancaria_id: string;
      tipo: string;
      fecha: string;
      monto: number;
      conciliado: boolean;
      descripcion: string | null;
      referencia: string | null;
    }>;
    candidatos: CandidatoAbonoLeido[];
    completo: boolean;
  }> {
    const sb = this.supabase.service;
    const fechas = abonos.map((a) => a.fecha as string).sort();
    const cuentaIds = [
      ...new Set(abonos.map((a) => a.cuenta_bancaria_id as string)),
    ];
    const vacio = {
      cuentas: new Map<
        string,
        { alias: string | null; moneda: string | null; tipo: string | null }
      >(),
      clientes: [] as Array<{ id: string; nombre: string }>,
      lineas: [] as Array<{
        id: string;
        cuenta_bancaria_id: string;
        tipo: string;
        fecha: string;
        monto: number;
        conciliado: boolean;
        descripcion: string | null;
        referencia: string | null;
      }>,
      candidatos: [] as CandidatoAbonoLeido[],
      completo: true,
    };
    const { data: ctas, error: ctaErr } = await sb
      .from('cuenta_bancaria')
      .select('id, alias, moneda, tipo');
    if (ctaErr) throw new Error(ctaErr.message);
    for (const c of (ctas ?? []) as Array<Record<string, unknown>>) {
      vacio.cuentas.set(c.id as string, {
        alias: (c.alias as string | null) ?? null,
        moneda: (c.moneda as string | null) ?? null,
        tipo: (c.tipo as string | null) ?? null,
      });
    }
    if (abonos.length === 0) return vacio;
    const min = fechas[0];
    const max = fechas[fechas.length - 1];

    // Clientes activos y líneas del banco: best-effort (sin ellos no hay
    // sugerencia de cliente ni aviso de duplicado — nunca se inventa).
    try {
      const { filas } = await this.leerPaginado(
        (a, b) =>
          sb
            .from('cliente')
            .select('id, nombre')
            .eq('activo', true)
            .order('id', { ascending: true })
            .range(a, b),
        TOPE_UNIVERSO,
      );
      vacio.clientes = filas
        .filter((c) => typeof c.nombre === 'string')
        .map((c) => ({ id: c.id as string, nombre: c.nombre as string }));
    } catch (err) {
      this.logger.warn(
        `abonos pendientes: no se pudieron leer los clientes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const { filas } = await this.leerPaginado(
        (a, b) =>
          sb
            .from('movimiento_bancario')
            .select(
              'id, cuenta_bancaria_id, tipo, fecha, monto, conciliado, descripcion, referencia',
            )
            .in('cuenta_bancaria_id', cuentaIds)
            .eq('tipo', TipoMovimientoBancario.ABONO)
            .gte('fecha', min)
            .lte('fecha', max)
            .order('id', { ascending: true })
            .range(a, b),
        TOPE_UNIVERSO * 2,
      );
      vacio.lineas = filas.map((m) => ({
        id: m.id as string,
        cuenta_bancaria_id: m.cuenta_bancaria_id as string,
        tipo: m.tipo as string,
        fecha: m.fecha as string,
        monto: Number(m.monto) || 0,
        conciliado: m.conciliado === true,
        descripcion: (m.descripcion as string | null) ?? null,
        referencia: (m.referencia as string | null) ?? null,
      }));
    } catch (err) {
      this.logger.warn(
        `abonos pendientes: no se pudieron leer las líneas del banco: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Candidatos LIBRES de la ventana ampliada (±30 días).
    const desde = ventanaDias(min, VENTANA_MANUAL_DIAS).desde;
    const hasta = ventanaDias(max, VENTANA_MANUAL_DIAS).hasta;
    const lo = `${desde}T00:00:00-05:00`;
    const hi = `${hasta}T23:59:59-05:00`;
    try {
      const [cobros, sobres, ingresos, ligas] = await Promise.all([
        this.leerPaginado(
          (a, b) =>
            sb
              .from('cobro_vuelo')
              .select(
                'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, fecha_vuelo, cliente:cliente_id(nombre))',
              )
              .gt('monto', 0)
              .is('cobro_grupo_id', null)
              .is('ingreso_anticipo_id', null)
              .in('metodo_cobro', METODOS_ABONO_MANUAL)
              .gte('fecha_cobro', lo)
              .lte('fecha_cobro', hi)
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO,
        ),
        this.leerPaginado(
          (a, b) =>
            sb
              .from('cobro_grupo')
              .select(
                'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, fecha_vuelo, cliente:cliente_id(nombre))',
              )
              .gt('monto', 0)
              .in('metodo_cobro', METODOS_ABONO_MANUAL)
              .gte('fecha_cobro', lo)
              .lte('fecha_cobro', hi)
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO,
        ),
        this.leerPaginado(
          (a, b) =>
            sb
              .from('ingreso')
              .select(INGRESO_CANDIDATO_COLS)
              .is('deleted_at', null)
              .not('cuenta_bancaria_id', 'is', null)
              .gte('fecha', desde)
              .lte('fecha', hasta)
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO,
        ),
        // Toda liga cobro/sobre/ingreso del banco (qué candidato ya NO está
        // libre): se lee el universo de ligas, no un `in (…)` gigante.
        this.leerPaginado(
          (a, b) =>
            sb
              .from('movimiento_bancario')
              .select('id, cobro_id, cobro_grupo_id, ingreso_id')
              .or(
                'cobro_id.not.is.null,cobro_grupo_id.not.is.null,ingreso_id.not.is.null',
              )
              .order('id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO * 3,
        ),
      ]);
      // UN COBRO, VARIOS ABONOS (invariante 77): con la sonda de
      // 20261014000003 el cobro se decide por su COBERTURA (abajo), no por
      // su espejo `cobro_id`.
      const conPuente = await this.cobrosLoteOn();
      const conParciales = conPuente && (await this.cobrosParcialesOn());
      const ocupados = new Set<string>();
      for (const m of ligas.filas) {
        if (!conParciales && typeof m.cobro_id === 'string')
          ocupados.add(`COBRO_VUELO:${m.cobro_id}`);
        if (typeof m.cobro_grupo_id === 'string')
          ocupados.add(`SOBRE_GRUPO:${m.cobro_grupo_id}`);
        if (typeof m.ingreso_id === 'string')
          ocupados.add(`INGRESO:${m.ingreso_id}`);
      }
      // Puente de cobros (12-oct-2026): los cobros de un LOTE no tienen
      // espejo `cobro_id`; se leen de la puente (universo, paginado). Con
      // varios abonos por cobro (0.0.78, invariante 77) el orden va por la
      // PK completa (cobro_id, movimiento_id): solo por cobro_id las páginas
      // podrían saltar o repetir filas. Con la sonda de parciales, con
      // `monto_parte` y el abono (cuenta) embebido para la cobertura.
      let partesTruncadas = false;
      let partesPorCobro = new Map<string, ParteCobroBanco[]>();
      if (conPuente) {
        const partes = await this.leerPaginado(
          (a, b) =>
            sb
              .from('movimiento_bancario_cobro')
              .select(
                conParciales ? colsPuenteLigas(MOV_LIGA_COLS) : 'cobro_id',
              )
              .order('cobro_id', { ascending: true })
              .order('movimiento_id', { ascending: true })
              .range(a, b),
          TOPE_UNIVERSO * 3,
        );
        partesTruncadas = partes.truncado;
        if (conParciales) {
          partesPorCobro = partesDeFilasPuente(partes.filas);
        } else {
          for (const p of partes.filas) {
            if (typeof p.cobro_id === 'string')
              ocupados.add(`COBRO_VUELO:${p.cobro_id}`);
          }
        }
      }
      /** ¿Libre (y por cuánto, si es parcial)? Sin la sonda: sin liga. */
      const cruceDeCobro = (
        c: Record<string, unknown>,
      ): { libre: boolean; faltante: number | null } =>
        conParciales
          ? cobroParaCruce(c, partesPorCobro.get(c.id as string) ?? [], null, {
              conParciales: true,
              pasarela: false,
            })
          : {
              libre: !ocupados.has(`COBRO_VUELO:${c.id as string}`),
              faltante: null,
            };
      /**
       * Lo mismo para los FRENOS (revisión del 15-oct-2026): la regla del
       * trigger A sin el método PAYWISE, la de `cobrosExactosLibresDeAbono`.
       * Sin la sonda no hay parciales y es la misma que la de ligar.
       */
      const frenoDeCobro = (
        c: Record<string, unknown>,
      ): { libre: boolean; faltante: number | null } | null =>
        conParciales
          ? cobroParaCruce(c, partesPorCobro.get(c.id as string) ?? [], null, {
              conParciales: true,
              pasarela: false,
              freno: true,
            })
          : null;
      const truncado =
        cobros.truncado ||
        sobres.truncado ||
        ingresos.truncado ||
        ligas.truncado ||
        partesTruncadas;
      const lista: CandidatoAbonoLeido[] = [];
      for (const c of cobros.filas) {
        const vuelo = unwrapOne(
          c.vuelo as {
            folio?: unknown;
            fecha_vuelo?: unknown;
            cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
          } | null,
        );
        const cliente = unwrapOne(vuelo?.cliente);
        const monto = r2(Number(c.monto) || 0);
        const comision =
          Number(c.comision_banco_monto) > 0
            ? r2(Number(c.comision_banco_monto))
            : null;
        const cruce = cruceDeCobro(c);
        const freno = frenoDeCobro(c);
        lista.push({
          tipo: 'COBRO_VUELO',
          id: c.id as string,
          monto,
          fecha_vuelo: fechaVueloDe(vuelo?.fecha_vuelo),
          comision,
          neto: r2(monto - (comision ?? 0)),
          moneda: (c.moneda as string) ?? 'USD',
          dia: diaCancun(c.fecha_cobro as string),
          metodo: (c.metodo_cobro as string | null) ?? null,
          cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
          folio: vuelo?.folio == null ? null : Number(vuelo.folio),
          referencia: (c.referencia as string | null) ?? null,
          vuelo_id: (c.vuelo_id as string | null) ?? null,
          grupo_id: null,
          cuenta_bancaria_id: null,
          cuenta_alias: null,
          categoria: null,
          es_anticipo: false,
          descripcion: null,
          fecha_cobro: c.fecha_cobro as string,
          libre: cruce.libre,
          ...(cruce.faltante != null ? { faltante: cruce.faltante } : {}),
          ...(freno ? { freno } : {}),
        });
      }
      for (const s of sobres.filas) {
        const grupo = unwrapOne(
          s.grupo as {
            folio?: unknown;
            fecha_vuelo?: unknown;
            cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
          } | null,
        );
        const cliente = unwrapOne(grupo?.cliente);
        const monto = r2(Number(s.monto) || 0);
        const comision =
          Number(s.comision_banco_monto) > 0
            ? r2(Number(s.comision_banco_monto))
            : null;
        lista.push({
          tipo: 'SOBRE_GRUPO',
          id: s.id as string,
          monto,
          fecha_vuelo: fechaVueloDe(grupo?.fecha_vuelo),
          comision,
          neto: r2(monto - (comision ?? 0)),
          moneda: (s.moneda as string) ?? 'USD',
          dia: diaCancun(s.fecha_cobro as string),
          metodo: (s.metodo_cobro as string | null) ?? null,
          cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
          folio: grupo?.folio == null ? null : Number(grupo.folio),
          referencia: (s.referencia as string | null) ?? null,
          vuelo_id: null,
          grupo_id: (s.grupo_id as string | null) ?? null,
          cuenta_bancaria_id: null,
          cuenta_alias: null,
          categoria: null,
          es_anticipo: false,
          descripcion: null,
          fecha_cobro: s.fecha_cobro as string,
          libre: !ocupados.has(`SOBRE_GRUPO:${s.id as string}`),
        });
      }
      for (const f of ingresos.filas) {
        const i = this.aIngresoCandidato(f);
        lista.push({
          tipo: 'INGRESO',
          id: i.id,
          monto: i.monto,
          comision: i.comision_monto,
          neto: netoIngreso(i.monto, i.comision_monto),
          moneda: i.moneda,
          dia: i.fecha,
          metodo: null,
          cliente: i.cliente,
          folio: i.folio,
          referencia: i.referencia,
          vuelo_id: null,
          grupo_id: null,
          cuenta_bancaria_id: i.cuenta_bancaria_id,
          cuenta_alias: i.cuenta_bancaria_id
            ? (vacio.cuentas.get(i.cuenta_bancaria_id)?.alias ?? null)
            : null,
          categoria: i.categoria,
          es_anticipo: esAnticipo(i.categoria),
          descripcion: i.descripcion,
          fecha_cobro: i.fecha,
          libre: !ocupados.has(`INGRESO:${i.id}`),
        });
      }
      vacio.candidatos = lista;
      vacio.completo = !truncado;
    } catch (err) {
      this.logger.warn(
        `abonos pendientes: lectura de candidatos falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      vacio.candidatos = [];
      vacio.completo = false;
    }
    return vacio;
  }

  /**
   * ¿El candidato cuadra EXACTO (r2) con el abono por neto o bruto? Un cobro
   * PARCIAL (invariante 77), solo por lo que le falta.
   */
  private montoExactoAbono(
    abono: { monto: number; monto_bruto: number | null },
    c: CandidatoAbonoLeido,
  ): boolean {
    const m = r2(abono.monto);
    if (c.faltante != null) return r2(c.faltante) === m;
    if (r2(c.neto) === m || r2(c.monto) === m) return true;
    return abono.monto_bruto != null && r2(c.monto) === r2(abono.monto_bruto);
  }

  /**
   * |neto − abono| (o bruto vs monto_bruto en pasarela): el menor. Un cobro
   * PARCIAL (invariante 77): |faltante − abono|.
   */
  private difMontoAbono(
    abono: { monto: number; monto_bruto: number | null },
    c: CandidatoAbonoLeido,
  ): number {
    if (c.faltante != null) return r2(Math.abs(c.faltante - abono.monto));
    let d = Math.min(
      Math.abs(c.neto - abono.monto),
      Math.abs(c.monto - abono.monto),
    );
    if (abono.monto_bruto != null) {
      d = Math.min(d, Math.abs(c.monto - abono.monto_bruto));
    }
    return r2(d);
  }

  /**
   * Análisis de UN abono pendiente con el contexto en lote: patrón
   * (traspaso/reverso), categoría y cliente sugeridos, duplicado probable,
   * lo que haría el AUTO («Cruzar pendientes», mismas reglas del auto-cruce)
   * y cuántos candidatos MANUALES cuadran exacto.
   */
  private analizarAbono(
    m: Record<string, unknown>,
    ctx: Awaited<ReturnType<ConciliacionService['contextoAbonos']>>,
  ): {
    abono: AbonoPendiente;
    manuales: CandidatoAbonoLeido[];
    manualesFreno: CandidatoAbonoLeido[];
  } {
    const cuenta = ctx.cuentas.get(m.cuenta_bancaria_id as string) ?? null;
    const moneda = cuenta?.moneda ?? null;
    const pasarela = cuenta?.tipo === TIPO_CUENTA_PASARELA;
    const fecha = m.fecha as string;
    const monto = r2(Number(m.monto) || 0);
    const montoBruto = m.monto_bruto == null ? null : r2(Number(m.monto_bruto));
    const descripcion = (m.descripcion as string | null) ?? null;
    const patron: AbonoPendiente['patron'] = patronTraspaso(descripcion)
      ? 'TRASPASO'
      : patronReverso(descripcion)
        ? 'REVERSO'
        : null;
    const dup = posibleDuplicado(
      {
        id: m.id as string,
        cuenta_bancaria_id: m.cuenta_bancaria_id as string,
        tipo: TipoMovimientoBancario.ABONO,
        fecha,
        monto,
        conciliado: false,
        descripcion,
        referencia: (m.referencia as string | null) ?? null,
      },
      ctx.lineas,
    );
    // Ventanas calculadas UNA vez por abono (se comparan días de pared).
    const ventanas = new Map<number, { desde: string; hasta: string }>([
      [MATCH_DAYS, ventanaDias(fecha, MATCH_DAYS)],
      [PAYWISE_VENTANA_DIAS, ventanaDias(fecha, PAYWISE_VENTANA_DIAS)],
      [VENTANA_MANUAL_DIAS, ventanaDias(fecha, VENTANA_MANUAL_DIAS)],
    ]);
    const dentro = (c: CandidatoAbonoLeido, dias: number) => {
      const v = ventanas.get(dias) ?? ventanaDias(fecha, dias);
      return c.dia >= v.desde && c.dia <= v.hasta;
    };
    // Candidatos MANUALES: libres, misma moneda, ±30 días; ingresos con
    // cuenta (los de otra cuenta viajan a la IA marcados, pero NO cuentan
    // como «exactos» porque no se pueden ligar a este abono). Un cobro
    // PARCIAL (invariante 77) solo para un abono de BANCO: la pasarela no
    // completa parciales.
    const esManual = (c: CandidatoAbonoLeido) =>
      c.libre &&
      c.moneda === moneda &&
      dentro(c, VENTANA_MANUAL_DIAS) &&
      !(pasarela && c.faltante != null);
    const manuales = moneda ? ctx.candidatos.filter(esManual) : [];
    // Los mismos candidatos con la regla de los FRENOS (revisión del
    // 15-oct-2026, invariante 77): un parcial PAYWISE sin comisión con un
    // SPEI de banco espera este dinero aunque el auto no lo ligue. Lo leen
    // el espejo del freno del AUTO (`cobrosExactos`), `exactos_manual` y la
    // guarda D12 de la IA; la IA sigue recibiendo `manuales`.
    const manualesFreno = moneda
      ? ctx.candidatos.map(vistaFrenoCandidato).filter(esManual)
      : [];
    const abonoCruce: AbonoCruce = {
      monto,
      monto_bruto: montoBruto,
      descripcion,
      cuenta_bancaria_id: m.cuenta_bancaria_id as string,
    };
    let motivo: AbonoPendiente['motivo_pendiente'] = null;
    let candidatosN: number | null = null;
    let exactos: number | null = null;
    // Espejo de `cobrosExactosLibresDeAbono` (lo que hace el AUTO): si el
    // auto elegiría un INGRESO pero un cobro/sobre libre ±30 días cuadra
    // EXACTO, el auto NO liga ⇒ AMBIGUO (anti doble conteo). Con la regla
    // del FRENO, como el auto (`freno: true`).
    const cobrosExactos = (pas: boolean) =>
      manualesFreno.filter(
        (c) =>
          c.tipo !== 'INGRESO' &&
          cuadraMontoAbono(abonoCruce, this.aCandidatoCruceAbono(c), pas),
      ).length;
    const decidir = (
      e: ReturnType<typeof elegirCandidatoAbono>,
      pas: boolean,
    ): void => {
      const n = e.elegido?.tipo === 'INGRESO' ? cobrosExactos(pas) : 0;
      if (n > 0) {
        motivo = 'AMBIGUO';
        candidatosN = e.candidatos_n + n;
        return;
      }
      motivo = e.elegido ? 'SE_PUEDE_CRUZAR' : e.motivo;
      candidatosN = e.candidatos_n;
    };
    if (ctx.completo && moneda) {
      exactos = manualesFreno.filter(
        (c) =>
          (c.tipo !== 'INGRESO' ||
            c.cuenta_bancaria_id === m.cuenta_bancaria_id) &&
          this.montoExactoAbono({ monto, monto_bruto: montoBruto }, c),
      ).length;
      if (patron === 'TRASPASO') {
        // El auto lo clasifica solo («Traspaso entre cuentas»).
        motivo = 'SE_PUEDE_CRUZAR';
        candidatosN = 0;
      } else if (pasarela) {
        // Regla del auto de pasarela: cobros PAYWISE ±5 días (neto → bruto;
        // la referencia con monto distinto nunca liga) y, sin ellos,
        // ingresos de ESTA cuenta.
        const movPw: MovimientoPaywise = {
          id: m.id as string,
          fecha,
          monto,
          monto_bruto: montoBruto,
          comision_monto:
            m.comision_monto == null ? null : r2(Number(m.comision_monto)),
          referencia: (m.referencia as string | null) ?? null,
          descripcion,
          moneda,
        };
        const cobrosPw: CobroPaywise[] = ctx.candidatos
          .filter(
            (c) =>
              c.libre &&
              c.faltante == null &&
              c.tipo !== 'INGRESO' &&
              c.moneda === moneda &&
              c.metodo != null &&
              METODOS_COBRO_PASARELA.includes(c.metodo) &&
              dentro(c, PAYWISE_VENTANA_DIAS),
          )
          .map((c) => ({
            tipo: c.tipo as 'COBRO_VUELO' | 'SOBRE_GRUPO',
            id: c.id,
            fecha_cobro: c.fecha_cobro,
            monto: c.monto,
            moneda: c.moneda,
            metodo_cobro: c.metodo,
            comision_banco_monto: c.comision,
            referencia: c.referencia,
          }));
        const r = cruzarPaywise([movPw], cobrosPw, {
          dias: PAYWISE_VENTANA_DIAS,
        });
        if (r.coinciden.length > 0) {
          motivo = 'SE_PUEDE_CRUZAR';
          candidatosN = 1;
        } else if (r.ambiguos.length > 0) {
          motivo = 'AMBIGUO';
          candidatosN = r.ambiguos[0]?.candidatos.length ?? 2;
        } else {
          const e = elegirCandidatoAbono(
            abonoCruce,
            ctx.candidatos
              .filter(
                (c) =>
                  c.libre &&
                  c.tipo === 'INGRESO' &&
                  c.moneda === moneda &&
                  c.cuenta_bancaria_id === m.cuenta_bancaria_id &&
                  dentro(c, PAYWISE_VENTANA_DIAS),
              )
              .map((c) => this.aCandidatoCruceAbono(c)),
            true,
          );
          decidir(e, true);
        }
      } else {
        const auto = ctx.candidatos.filter(
          (c) =>
            c.libre &&
            c.moneda === moneda &&
            dentro(c, MATCH_DAYS) &&
            (c.tipo === 'INGRESO'
              ? c.cuenta_bancaria_id === m.cuenta_bancaria_id
              : c.metodo != null && METODOS_ABONO_AUTO.includes(c.metodo)),
        );
        const e = elegirCandidatoAbono(
          abonoCruce,
          auto.map((c) => this.aCandidatoCruceAbono(c)),
          false,
        );
        decidir(e, false);
      }
    }
    const categoriaSugerida = categoriaSugeridaDeDescripcion(descripcion);
    return {
      abono: {
        id: m.id as string,
        cuenta_bancaria_id: m.cuenta_bancaria_id as string,
        cuenta_alias: cuenta?.alias ?? null,
        cuenta_moneda: (moneda as MonedaIngreso | null) ?? null,
        cuenta_tipo:
          cuenta?.tipo === 'PASARELA'
            ? 'PASARELA'
            : cuenta?.tipo
              ? 'BANCO'
              : null,
        fecha,
        monto,
        monto_bruto: montoBruto,
        comision_monto:
          m.comision_monto == null ? null : r2(Number(m.comision_monto)),
        descripcion,
        referencia: (m.referencia as string | null) ?? null,
        notas: (m.notas as string | null) ?? null,
        patron,
        motivo_pendiente: motivo,
        candidatos_n: candidatosN,
        exactos_manual: exactos,
        posible_duplicado_de: dup
          ? {
              id: dup.id,
              conciliado: dup.conciliado,
              descripcion: dup.descripcion,
              referencia: dup.referencia,
            }
          : null,
        cliente_sugerido: clienteQueEmpata(descripcion, ctx.clientes),
        categoria_sugerida: categoriaSugerida,
      },
      manuales,
      manualesFreno,
    };
  }

  /**
   * Candidato leído ⇒ forma de la decisión única de abonos (un PARCIAL
   * viaja con su faltante: cuadra SOLO por él, como en el auto-cruce).
   */
  private aCandidatoCruceAbono(c: CandidatoAbonoLeido): CandidatoAbonoCruce {
    return {
      tipo: c.tipo,
      id: c.id,
      monto: c.monto,
      comision: c.comision,
      fecha: c.fecha_cobro,
      cliente: c.cliente,
      cuenta_bancaria_id: c.cuenta_bancaria_id,
      ...(c.faltante != null ? { faltante: c.faltante } : {}),
    };
  }

  /**
   * `GET /conciliacion/abonos-pendientes` (24-sep-2026): los ABONOS del
   * banco que nadie ha identificado, con qué haría el auto, cuántos
   * candidatos manuales cuadran exacto (caso real #235: «Sin candidato
   * automático · 1 con el monto exacto»), cliente y categoría sugeridos y
   * duplicado probable. Honestidad: si una lectura de candidatos falla o se
   * trunca, `motivos_calculados = false` y los motivos van null.
   */
  async abonosPendientes(
    q: AbonosPendientesQuery,
  ): Promise<AbonosPendientesRespuesta> {
    if (!(await this.ingresosOn())) throw errorIngresosNoDisponibles();
    const hasta = q.hasta ?? hoyCancun();
    const desdePedido =
      q.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desdePedido > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    // INICIO OFICIAL (invariante 86): ventana con piso (Ingresos › Por
    // conciliar); el `desde` devuelto es el subido.
    const desde = await this.pisoDesde(desdePedido);
    const limite = Math.min(Math.max(q.limite ?? 300, 1), 500);
    let qb = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, cuenta_bancaria_id, fecha, monto, monto_bruto, comision_monto, descripcion, referencia, notas',
        { count: 'exact' },
      )
      .eq('tipo', TipoMovimientoBancario.ABONO)
      .eq('conciliado', false)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false })
      .order('id', { ascending: true })
      .limit(limite);
    if (q.cuenta_bancaria_id) {
      qb = qb.eq('cuenta_bancaria_id', q.cuenta_bancaria_id);
    }
    const { data, error, count } = await qb;
    if (error) throw new Error(error.message);
    const abonos = (data ?? []) as Array<Record<string, unknown>>;
    const ctx = await this.contextoAbonos(abonos);
    const filas = abonos.map((m) => this.analizarAbono(m, ctx).abono);
    const porMoneda = new Map<MonedaIngreso, { n: number; monto: number }>();
    for (const f of filas) {
      if (!f.cuenta_moneda) continue;
      const cur = porMoneda.get(f.cuenta_moneda) ?? { n: 0, monto: 0 };
      cur.n += 1;
      cur.monto = r2(cur.monto + f.monto);
      porMoneda.set(f.cuenta_moneda, cur);
    }
    return {
      data: filas,
      total: count ?? filas.length,
      desde,
      hasta,
      truncado: abonos.length >= limite,
      motivos_calculados: ctx.completo,
      por_moneda: (['MXN', 'USD'] as MonedaIngreso[])
        .filter((mo) => porMoneda.has(mo))
        .map((mo) => ({ moneda: mo, ...porMoneda.get(mo)! })),
    };
  }

  /** Ficha legible de un candidato (propuestas de la IA y alternativas). */
  private fichaCandidato(c: CandidatoAbonoLeido): CandidatoAbonoFicha {
    const etiqueta =
      c.tipo === 'COBRO_VUELO'
        ? `Cobro · vuelo #${c.folio ?? '?'}`
        : c.tipo === 'SOBRE_GRUPO'
          ? `Sobre G-${c.folio ?? '?'}`
          : `${etiquetaIngreso(c.folio)} · ${c.es_anticipo ? 'Anticipo' : etiquetaCategoriaIngreso(c.categoria)}`;
    return {
      tipo: c.tipo,
      id: c.id,
      etiqueta,
      fecha: c.dia,
      fecha_vuelo: c.fecha_vuelo ?? null,
      monto: c.monto,
      neto: c.neto,
      moneda: c.moneda === 'USD' ? 'USD' : 'MXN',
      metodo_etiqueta: c.metodo ? etiquetaMetodoCobro(c.metodo) : null,
      cliente: c.cliente,
      vuelo_id: c.vuelo_id,
      grupo_id: c.grupo_id,
      es_anticipo: c.es_anticipo,
    };
  }

  /**
   * `POST /conciliacion/sugerir-abonos` — «Sugerir con IA» (24-sep-2026).
   * LA IA PROPONE, LA PERSONA CONFIRMA: nunca liga. Traspasos, reversos,
   * duplicados y lo que el auto ya cruza salen por REGLA (sin gastar
   * créditos); el resto va a pyservices en lotes de ≤ 10 abonos, ≤ 3
   * llamadas EN PARALELO, y cada respuesta se valida contra los candidatos
   * REALES de su abono (la IA jamás inventa un id ni propone registrar como
   * otro ingreso dinero que ya tiene un cobro con el monto exacto).
   */
  async sugerirAbonos(
    dto: SugerirAbonosDto,
    userId: string,
  ): Promise<SugerirAbonosRespuesta> {
    if (!(await this.ingresosOn())) throw errorIngresosNoDisponibles();
    const ids = dto.movimiento_ids?.length ? dto.movimiento_ids : null;
    const hasta = dto.hasta ?? hoyCancun();
    const desdePedido =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (!ids && desdePedido > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    // INICIO OFICIAL (invariante 86): piso SOLO sin ids.
    const desde = ids ? desdePedido : await this.pisoDesde(desdePedido);
    const limite = Math.min(Math.max(dto.limite ?? 20, 1), 30);
    let qb = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, cuenta_bancaria_id, fecha, monto, monto_bruto, comision_monto, descripcion, referencia, notas',
      )
      .eq('tipo', TipoMovimientoBancario.ABONO)
      .eq('conciliado', false)
      .order('fecha', { ascending: true })
      .order('id', { ascending: true })
      .limit(limite);
    if (ids) qb = qb.in('id', ids);
    else qb = qb.gte('fecha', desde).lte('fecha', hasta);
    if (dto.cuenta_bancaria_id) {
      qb = qb.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
    }
    const { data, error } = await qb;
    if (error) throw new Error(error.message);
    const abonos = (data ?? []) as Array<Record<string, unknown>>;
    const ctx = await this.contextoAbonos(abonos);
    const analisis = abonos.map((m) => this.analizarAbono(m, ctx));

    const propuestas = new Map<string, PropuestaAbono>();
    const base = (
      a: AbonoPendiente,
    ): Omit<PropuestaAbono, 'origen' | 'accion' | 'confianza' | 'razon'> => ({
      movimiento_id: a.id,
      fecha: a.fecha,
      monto: a.monto,
      descripcion: a.descripcion,
      referencia: a.referencia,
      cuenta_alias: a.cuenta_alias,
      cuenta_moneda: a.cuenta_moneda,
      candidato: null,
      monto_exacto: false,
      evidencias: [],
      alternativas: [],
      categoria_sugerida: a.categoria_sugerida,
      cliente_sugerido: a.cliente_sugerido,
      posible_duplicado: false,
      motivo_sin_match: null,
    });
    const paraIa: typeof analisis = [];
    for (const an of analisis) {
      const a = an.abono;
      if (a.patron === 'TRASPASO' || a.patron === 'REVERSO') {
        const p =
          a.patron === 'TRASPASO' ? patronTraspaso(a.descripcion) : 'REV';
        propuestas.set(a.id, {
          ...base(a),
          origen: 'REGLA',
          accion:
            a.patron === 'TRASPASO'
              ? 'CLASIFICAR_TRASPASO'
              : 'CLASIFICAR_REVERSO',
          confianza: 0.95,
          razon: `La descripción del banco dice "${p ?? a.patron}"`,
          evidencias: [
            a.patron === 'TRASPASO'
              ? `Clasificación: ${CLASIFICACION_TRASPASO}`
              : `Clasificación: ${CLASIFICACION_REVERSO}`,
          ],
        });
        continue;
      }
      if (a.posible_duplicado_de) {
        propuestas.set(a.id, {
          ...base(a),
          origen: 'REGLA',
          accion: 'REVISAR',
          confianza: 0,
          razon: `Parece la misma línea del banco repetida (${a.fecha} · ${montoBonito(a.monto)}): revisa antes de conciliarla`,
          posible_duplicado: true,
        });
        continue;
      }
      if (a.motivo_pendiente === 'SE_PUEDE_CRUZAR') {
        propuestas.set(a.id, {
          ...base(a),
          origen: 'REGLA',
          accion: 'REVISAR',
          confianza: 0,
          razon: 'Pulsa "Cruzar pendientes": el sistema lo liga solo',
        });
        continue;
      }
      paraIa.push(an);
    }

    // ---- IA: lotes de ≤ 10 abonos, ≤ 3 llamadas EN PARALELO ----
    const lotes: Array<typeof analisis> = [];
    for (
      let i = 0;
      i < paraIa.length && lotes.length < IA_LOTES_MAX;
      i += IA_ABONOS_POR_LOTE
    ) {
      lotes.push(paraIa.slice(i, i + IA_ABONOS_POR_LOTE));
    }
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    // Candidatos por abono ordenados por (dif de monto, |días|). Los cobros
    // PARCIALES (invariante 77) NO viajan a la IA en v1: su contrato no
    // conoce el faltante (abajo se protege el anti doble conteo).
    const candidatosDe = (an: (typeof analisis)[number], tope: number) =>
      an.manuales
        .filter((c) => c.faltante == null)
        .sort(
          (x, y) =>
            this.difMontoAbono(an.abono, x) - this.difMontoAbono(an.abono, y) ||
            difDias(an.abono.fecha, x.dia) - difDias(an.abono.fecha, y.dia),
        )
        .slice(0, tope);
    let consultados = 0;
    let respondieron = 0;
    let errores = 0;
    let nota: string | null = null;
    const porCandidato = new Map<
      string,
      { movId: string; confianza: number }
    >();
    const resultados = await Promise.allSettled(
      lotes.map(async (lote) => {
        let tope = IA_CANDIDATOS_POR_ABONO;
        let porAbono = lote.map((an) => candidatosDe(an, tope));
        const pool = () =>
          new Set(porAbono.flat().map((c) => `${c.tipo}:${c.id}`)).size;
        if (pool() > IA_POOL_MAX) {
          tope = IA_CANDIDATOS_POR_ABONO_RECORTE;
          porAbono = lote.map((an) => candidatosDe(an, tope));
        }
        const cand = new Map<string, CandidatoAbonoLeido>();
        for (const lista of porAbono) {
          for (const c of lista) {
            if (cand.size >= IA_POOL_MAX) break;
            cand.set(`${c.tipo}:${c.id}`, c);
          }
        }
        return {
          lote,
          porAbono,
          cand,
          respuesta: await this.llamarSugerirAbonos(
            baseUrl,
            token,
            lote,
            porAbono,
            cand,
            userId,
          ),
        };
      }),
    );
    for (const r of resultados) {
      if (r.status !== 'fulfilled') {
        errores += 1;
        continue;
      }
      const { lote, porAbono, cand, respuesta } = r.value;
      consultados += 1;
      if (!respuesta.ok) {
        nota ??= respuesta.nota;
        errores += lote.length;
        for (const an of lote) {
          propuestas.set(an.abono.id, {
            ...base(an.abono),
            origen: 'IA',
            accion: 'REVISAR',
            confianza: 0,
            razon: '',
            motivo_sin_match: 'El asistente no respondió para este abono',
          });
        }
        continue;
      }
      respondieron += 1;
      const sugs = new Map(
        respuesta.sugerencias.map((s) => [
          typeof s.movimiento_id === 'string' ? s.movimiento_id : '',
          s,
        ]),
      );
      lote.forEach((an, idx) => {
        const a = an.abono;
        const permitidos = new Set(
          porAbono[idx]
            .map((c) => `${c.tipo}:${c.id}`)
            .filter((k) => cand.has(k)),
        );
        const s = sugs.get(a.id);
        if (!s) {
          propuestas.set(a.id, {
            ...base(a),
            origen: 'IA',
            accion: 'REVISAR',
            confianza: 0,
            razon: '',
            motivo_sin_match: 'El asistente no respondió para este abono',
          });
          return;
        }
        const idCand =
          typeof s.candidato_id === 'string' && permitidos.has(s.candidato_id)
            ? s.candidato_id
            : null;
        let accion = ACCIONES_PROPUESTA.includes(
          s.accion as (typeof ACCIONES_PROPUESTA)[number],
        )
          ? (s.accion as PropuestaAbono['accion'])
          : 'REVISAR';
        let confianza = Math.min(1, Math.max(0, Number(s.confianza) || 0));
        let razon = typeof s.razon === 'string' ? s.razon.slice(0, 300) : '';
        let motivoSinMatch =
          typeof s.motivo_sin_match === 'string'
            ? s.motivo_sin_match.slice(0, 300)
            : null;
        let candidato = idCand ? (cand.get(idCand) ?? null) : null;
        if (accion === 'LIGAR' && !candidato) accion = 'REVISAR';
        if (
          accion !== 'LIGAR' &&
          accion !== 'REVISAR' &&
          accion !== 'REGISTRAR_INGRESO'
        ) {
          // CLASIFICAR_* de la IA no traen candidato.
          candidato = null;
        }
        // UN COBRO, VARIOS ABONOS (invariante 77, D12): la IA no ve los
        // cobros PARCIALES, pero si a uno le falta EXACTAMENTE este abono,
        // ese dinero es (probablemente) su pago: ni «registrar como otro
        // ingreso» ni ligarlo a un ingreso registrado, y ningún cobro exacto
        // se elige solo entre él y el parcial (REVISAR sin preselección).
        // Con la regla del FRENO (revisión del 15-oct-2026): también el
        // parcial PAYWISE sin comisión que la BD sí deja completar.
        const parcialesExactos = an.manualesFreno.filter(
          (c) =>
            c.faltante != null &&
            c.tipo === 'COBRO_VUELO' &&
            this.montoExactoAbono(a, c),
        );
        if (
          parcialesExactos.length > 0 &&
          (accion === 'REGISTRAR_INGRESO' ||
            (accion === 'LIGAR' && candidato?.tipo === 'INGRESO'))
        ) {
          const otrosExactos = porAbono[idx].some(
            (c) =>
              c.tipo !== 'INGRESO' &&
              permitidos.has(`${c.tipo}:${c.id}`) &&
              this.montoExactoAbono(a, c),
          );
          accion = 'REVISAR';
          candidato = null;
          motivoSinMatch =
            parcialesExactos.length === 1 && !otrosExactos
              ? `Al cobro del vuelo #${parcialesExactos[0].folio ?? '?'} (pago parcial) le falta exactamente este monto: revísalo y vincula el abono a ese cobro`
              : 'Hay varios cobros de vuelo que esperan exactamente este monto (al menos uno con pago parcial): revísalos y vincula el abono al que corresponda';
        }
        // Jamás «registrar como otro ingreso» dinero que ya tiene un cobro
        // de vuelo con el monto EXACTO: único ⇒ LIGAR (≤ 0.7); varios ⇒ REVISAR.
        if (accion === 'REGISTRAR_INGRESO') {
          const exactos = porAbono[idx].filter(
            (c) =>
              c.tipo !== 'INGRESO' &&
              permitidos.has(`${c.tipo}:${c.id}`) &&
              this.montoExactoAbono(a, c),
          );
          if (exactos.length === 1) {
            accion = 'LIGAR';
            candidato = exactos[0];
            confianza = Math.min(confianza || 0.7, 0.7);
            razon = 'Hay un cobro de vuelo con el monto exacto';
            motivoSinMatch = null;
          } else if (exactos.length > 1) {
            accion = 'REVISAR';
            candidato = null;
            motivoSinMatch =
              'Hay varios cobros de vuelo con el monto exacto: revísalos antes de registrarlo como otro ingreso';
          }
        }
        // Mismo principio al LIGAR a un INGRESO ya registrado (revisión
        // adversaria 24-sep-2026): si un cobro de vuelo/sobre permitido
        // cuadra EXACTO, la IA no decide entre los dos — REVISAR (sin
        // preselección: ligar el ingreso contaría el pago del vuelo dos
        // veces si ESE es el cobro).
        if (
          accion === 'LIGAR' &&
          candidato?.tipo === 'INGRESO' &&
          porAbono[idx].some(
            (c) =>
              c.tipo !== 'INGRESO' &&
              permitidos.has(`${c.tipo}:${c.id}`) &&
              this.montoExactoAbono(a, c),
          )
        ) {
          accion = 'REVISAR';
          candidato = null;
          motivoSinMatch =
            'Hay un cobro de vuelo con el monto exacto: revísalo antes de ligar el abono a un ingreso registrado';
        }
        if (accion !== 'LIGAR' && accion !== 'REGISTRAR_INGRESO') {
          candidato = accion === 'REVISAR' ? null : candidato;
        }
        if (accion === 'REGISTRAR_INGRESO') candidato = null;
        const alternativas = (
          Array.isArray(s.alternativas) ? s.alternativas : []
        )
          .map((alt) => alt as Record<string, unknown>)
          .filter(
            (alt) =>
              typeof alt?.candidato_id === 'string' &&
              permitidos.has(alt.candidato_id) &&
              (!candidato ||
                alt.candidato_id !== `${candidato.tipo}:${candidato.id}`),
          )
          .slice(0, 3)
          .map((alt) => ({
            candidato: this.fichaCandidato(
              cand.get(alt.candidato_id as string) as CandidatoAbonoLeido,
            ),
            confianza: Math.min(1, Math.max(0, Number(alt.confianza) || 0)),
            razon: typeof alt.razon === 'string' ? alt.razon.slice(0, 300) : '',
          }));
        const categoria =
          typeof s.categoria_sugerida === 'string' &&
          esCategoriaIngreso(s.categoria_sugerida)
            ? s.categoria_sugerida
            : null;
        propuestas.set(a.id, {
          ...base(a),
          origen: 'IA',
          accion,
          candidato: candidato ? this.fichaCandidato(candidato) : null,
          confianza: candidato || accion !== 'REVISAR' ? confianza : 0,
          monto_exacto: candidato ? this.montoExactoAbono(a, candidato) : false,
          razon,
          evidencias: (Array.isArray(s.evidencias) ? s.evidencias : [])
            .filter((e): e is string => typeof e === 'string')
            .slice(0, 4)
            .map((e) => e.slice(0, 300)),
          alternativas,
          categoria_sugerida: categoria ?? a.categoria_sugerida,
          motivo_sin_match: candidato ? null : motivoSinMatch,
        });
        if (candidato && accion === 'LIGAR') {
          const k = `${candidato.tipo}:${candidato.id}`;
          const previo = porCandidato.get(k);
          if (!previo || previo.confianza < confianza) {
            if (previo) this.degradarPorDuplicado(propuestas, previo.movId);
            porCandidato.set(k, { movId: a.id, confianza });
          } else {
            this.degradarPorDuplicado(propuestas, a.id);
          }
        }
      });
    }
    // Ningún abono se queda sin fila: lo que no alcanzó respuesta (lote
    // caído o fuera de los 3 lotes) sale como REVISAR con su motivo.
    for (const an of paraIa) {
      if (propuestas.has(an.abono.id)) continue;
      propuestas.set(an.abono.id, {
        ...base(an.abono),
        origen: 'IA',
        accion: 'REVISAR',
        confianza: 0,
        razon: '',
        motivo_sin_match: 'El asistente no respondió para este abono',
      });
    }
    const lista = analisis
      .map((an) => propuestas.get(an.abono.id))
      .filter((p): p is PropuestaAbono => !!p);
    const conPropuesta = lista.filter(
      (p) => p.accion === 'LIGAR' && p.candidato,
    ).length;
    return {
      revisados: abonos.length,
      con_propuesta: conPropuesta,
      sin_propuesta: abonos.length - conPropuesta,
      errores,
      // false SOLO si se preguntó y NADIE contestó.
      disponible: consultados === 0 ? true : respondieron > 0,
      nota: consultados > 0 && respondieron === 0 ? nota : null,
      desde: ids ? ((abonos[0]?.fecha as string | undefined) ?? desde) : desde,
      hasta: ids
        ? ((abonos[abonos.length - 1]?.fecha as string | undefined) ?? hasta)
        : hasta,
      limite,
      propuestas: lista,
    };
  }

  /** La propuesta pierde su candidato (otro abono lo reclamó con más confianza). */
  private degradarPorDuplicado(
    propuestas: Map<string, PropuestaAbono>,
    movId: string,
  ): void {
    const p = propuestas.get(movId);
    if (!p) return;
    propuestas.set(movId, {
      ...p,
      accion: 'REVISAR',
      candidato: null,
      confianza: 0,
      monto_exacto: false,
      motivo_sin_match:
        'Ese candidato se propuso para otro abono con más confianza',
    });
  }

  /**
   * UNA llamada a pyservices `POST /conciliacion/sugerir-abonos` (≤ 10
   * abonos, ≤ 120 candidatos). Registra el consumo de IA SIEMPRE que llegue
   * `uso_ia` — también en la respuesta truncada (502 IA_RESPUESTA_TRUNCADA:
   * los créditos se gastaron). Nunca lanza: `{ ok:false, nota }`.
   */
  private async llamarSugerirAbonos(
    baseUrl: string,
    token: string,
    lote: Array<{ abono: AbonoPendiente; manuales: CandidatoAbonoLeido[] }>,
    porAbono: CandidatoAbonoLeido[][],
    cand: Map<string, CandidatoAbonoLeido>,
    userId: string,
  ): Promise<
    | { ok: true; sugerencias: Array<Record<string, unknown>> }
    | { ok: false; nota: string }
  > {
    if (!baseUrl || !token) {
      return {
        ok: false,
        nota: 'Asistente de conciliación no configurado (pyservices).',
      };
    }
    const payload = {
      abonos: lote.map((an, idx) => ({
        id: an.abono.id,
        fecha: an.abono.fecha,
        monto: an.abono.monto,
        monto_bruto: an.abono.monto_bruto,
        comision_monto: an.abono.comision_monto,
        descripcion: an.abono.descripcion,
        referencia: an.abono.referencia,
        cuenta_alias: an.abono.cuenta_alias,
        cuenta_moneda: an.abono.cuenta_moneda,
        cuenta_tipo: an.abono.cuenta_tipo,
        candidato_ids: porAbono[idx]
          .map((c) => `${c.tipo}:${c.id}`)
          .filter((k) => cand.has(k)),
      })),
      candidatos: [...cand.entries()].map(([k, c]) => ({
        id: k,
        tipo: c.tipo,
        fecha: c.dia,
        monto: c.monto,
        comision: c.comision,
        neto: c.neto,
        moneda: c.moneda,
        metodo: c.metodo,
        cliente: c.cliente,
        folio:
          c.tipo === 'COBRO_VUELO'
            ? c.folio
            : c.tipo === 'SOBRE_GRUPO'
              ? `G-${c.folio ?? '?'}`
              : etiquetaIngreso(c.folio),
        referencia: c.referencia,
        categoria: c.tipo === 'INGRESO' ? c.categoria : null,
        es_anticipo: c.es_anticipo,
        descripcion: c.tipo === 'INGRESO' ? c.descripcion : null,
        cuenta_alias: c.cuenta_alias,
        otra_cuenta:
          c.tipo === 'INGRESO' &&
          !lote.some(
            (an) => an.abono.cuenta_bancaria_id === c.cuenta_bancaria_id,
          ),
      })),
      categorias: [...CATEGORIAS_INGRESO],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IA_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/sugerir-abonos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
          ...(await this.headersModeloIa()),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const cuerpo = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      // Consumo de IA: en el cuerpo (200) o en el detalle del 502 truncado.
      const detalle = (cuerpo?.detail ?? null) as Record<
        string,
        unknown
      > | null;
      const uso =
        (cuerpo?.uso_ia as UsoIaPayload | null | undefined) ??
        (detalle && typeof detalle === 'object'
          ? (detalle.uso_ia as UsoIaPayload | null | undefined)
          : null) ??
        null;
      if (uso) {
        this.iaUso.registrar(IA_CATEGORIA_ABONOS, uso, {
          usuarioId: userId,
          contexto: {
            abonos: lote.length,
            candidatos: cand.size,
          },
        });
      }
      if (!res.ok) {
        this.logger.warn(
          `pyservices /conciliacion/sugerir-abonos respondió ${res.status}`,
        );
        return { ok: false, nota: `pyservices respondió ${res.status}.` };
      }
      const sugerencias = Array.isArray(cuerpo?.sugerencias)
        ? (cuerpo.sugerencias as Array<Record<string, unknown>>)
        : [];
      return { ok: true, sugerencias };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sugerir-abonos falló: ${msg}`);
      return {
        ok: false,
        nota: `No se pudo contactar al asistente de conciliación: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
