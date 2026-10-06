import {
  BadRequestException,
  ConflictException,
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
import { avionDelGasto } from '../../common/participacion-aeronave.util';
import { round6 } from '../../common/tc.util';
import {
  fetchRepartos,
  type GastoRepartoFila,
} from '../../common/gasto-reparto.util';
import {
  esParteDeSobre,
  filtroLigaCobros,
  filtroLigaCobrosConAnticipos,
  MOV_LIGA_COLS,
  MOV_LIGA_COLS_CON_INGRESO,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
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
  ordenarCandidatosGasto,
} from './gastos-candidatos.util';
import {
  agregarNotaVinculo,
  JUSTIFICACION_MIN,
  limpiarJustificacion,
  lineaNotaCargo,
  lineaNotaGasto,
  mensajeGastoBodega,
  mensajeJustificacionRequerida,
  quitarNotasVinculoNoBancario,
  tieneNotasVinculoNoBancario,
  type CargoDeNota,
  type GastoDeNota,
} from '../../common/vinculo-no-bancario.util';
import {
  agruparExcluidos,
  bandaMontoExcluidos,
  cargosConciliadosPorGasto,
  conCargosConciliados,
  EXCLUIDOS_LECTURA_TOPE,
  GASTO_EXCLUIDO_COLS,
  gastoExcluibleDeFila,
  montoReferenciaExcluidos,
  ventanaExcluidos,
  type CargoConciliadoExcluido,
  type ExcluidosCandidatos,
  type GastoExcluible,
} from './candidatos-excluidos.util';
import {
  CLASIFICACION_TRASPASO,
  conteoVacio,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados,
  montoCasa,
  patronTraspaso,
  primeraLinea,
  sumarResultado,
  terminacionDeMovimiento,
  TOLERANCIA_CENTAVOS,
  ventanaDias,
  type CriterioCruce,
  type GastoCandidatoCruce,
  type ResultadoCruce,
} from './auto-cruce.util';
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
  cliente: string | null;
  fecha_cobro: string;
  monto: number;
  moneda: string;
  metodo_cobro: string;
  referencia: string | null;
  comision_banco_monto: number | null;
  neto: number;
  /** |neto − monto del abono| (0 = cuadra exacto). */
  dif_monto: number;
}

/** Sobre de grupo candidato (se manda `cobro_grupo_id` al PATCH). */
export interface CandidatoSobreGrupo extends SobreConciliacion {
  /** = cobro_grupo_id. */
  id: string;
  cliente: string | null;
  dif_monto: number;
}

export type CandidatoCobro = CandidatoCobroVuelo | CandidatoSobreGrupo;

/** Entrada de linkCobro: cobro de vuelo O sobre de grupo (excluyentes); ambos null = desvincular. */
export interface LigaCobroInput {
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
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
 * solo con `incluir_no_bancarios` (efectivo / PERSONAL_*), y esos van
 * DESPUÉS de todos los bancarios.
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
  excluidos?: ExcluidosCandidatos['excluidos'];
  excluidos_monto?: ExcluidosCandidatos['excluidos_monto'];
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
// Compras EN DÓLARES pagadas con tarjeta: el banco carga PESOS. El cruce
// USD↔MXN solo se acepta si el TC implícito (cargo MXN ÷ gasto USD) cae en
// esta banda plausible — fuera de ella es casi seguro otro gasto. Ajustar si
// el peso se mueve de este rango.
const TC_IMPLICITO_MIN = 15;
const TC_IMPLICITO_MAX = 25;

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

/** Banda de tolerancia de monto (±5%) para juntar gastos candidatos. */
const MATCH_MONTO_PCT = 0.05;

/**
 * Tope de gastos que lee el cálculo del «por qué sigue pendiente» de la
 * lista. Si la ventana trae MÁS que esto, la foto está incompleta y NO se
 * anota ningún motivo (un «sin candidato» falso sería peor que no decir nada).
 */
const MOTIVO_GASTOS_MAX = 4000;

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
 * factura depende de la sonda de la migración 20261005000002.
 */
const GASTO_RICO_COLS = `${GASTO_CRUCE_COLS}, aeronave:aeronave!aeronave_id(matricula), vuelo:vuelo!vuelo_id(folio), captura:usuario!usuario_captura_id(nombre)`;

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
  ) {}

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
    const [ingresos, partes] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
    ]);
    return `${MOV_COLS}${ingresos ? ', ingreso_id' : ''}${partes ? ', gastos_n' : ''}`;
  }

  // =====================================================================
  // 1 CARGO ↔ N GASTOS (2-oct-2026, API 0.0.52): sonda ÚNICA de la
  // migración 20261002000002. Todo lo que nombre `gastos_n`, la puente
  // `movimiento_bancario_gasto` o la vista `v_gasto_conciliacion` va
  // detrás de ella: sin la migración, conciliación responde EXACTAMENTE
  // como el 0.0.51 (espejo `gasto_id` y |monto| del movimiento).
  // =====================================================================

  /** ¿Está aplicada la migración de partes? (memorizado, re-sondeo ≤ 10 min). */
  private partesOn(): Promise<boolean> {
    return partesDisponibles(this.supabase.service);
  }

  /** Fila cruda de la puente ⇒ parte (tipos normalizados). */
  private aParte(f: Record<string, unknown>): ParteCargoGasto {
    return {
      movimiento_id: f.movimiento_id as string,
      gasto_id: f.gasto_id as string,
      monto_parte: r2(Math.abs(Number(f.monto_parte) || 0)),
      moneda: typeof f.moneda === 'string' ? f.moneda : null,
      created_at: typeof f.created_at === 'string' ? f.created_at : null,
    };
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
   */
  private async partesDeGastos(
    gastoIds: ReadonlyArray<string>,
  ): Promise<ParteCargoGasto[]> {
    const filas = await this.leerPorLotesPaginado(
      gastoIds,
      (lote, desde, hasta) =>
        this.supabase.service
          .from('movimiento_bancario_gasto')
          .select(PARTE_COLS)
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

  /** Lecturas `in (…)` en lotes de ≤ 200 ids; un error se LANZA. */
  private async leerPorLotes(
    ids: ReadonlyArray<string>,
    consulta: (lote: string[]) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += 200) {
      const { data, error } = await consulta(unicos.slice(i, i + 200));
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
  ): Promise<Array<Record<string, unknown>>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < unicos.length; i += 200) {
      const lote = unicos.slice(i, i + 200);
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
        async (progreso, paso) => setJob({ progreso, paso }),
      );
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

  private async ejecutarImport(
    dto: ImportarMovimientosDto,
    userId: string,
    onProgress: (progreso: number, paso: string) => Promise<void>,
  ) {
    const base = dto.movimientos
      .filter((m) => m.fecha)
      .map((m) => ({
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
    await onProgress(5, 'Buscando duplicados…');

    // CANDADO DE RE-IMPORTACIÓN: el mismo estado de cuenta subido dos veces
    // duplicaría los movimientos e inflaría los pendientes para siempre (los
    // gastos ya conciliados no se vuelven a cruzar). Dedup MULTICONJUNTO por
    // (fecha, tipo, monto) + leyenda TOLERANTE contra lo ya importado en la
    // cuenta: dos cargos legítimos idénticos del mismo día solo se omiten si
    // ya existen exactamente esas repeticiones en la base.
    const fechas = base.map((r) => r.fecha).sort();
    const { data: previos, error: prevErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('fecha, tipo, monto, descripcion, referencia')
      .eq('cuenta_bancaria_id', dto.cuenta_bancaria_id)
      .gte('fecha', fechas[0])
      .lte('fecha', fechas[fechas.length - 1])
      // SIN limit explícito PostgREST corta en el «Max rows» del proyecto
      // (1000) y el multiconjunto salía incompleto ⇒ duplicados en silencio.
      .limit(20000);
    if (prevErr) throw new Error(prevErr.message);
    // Fuente única del candado: `emparejarDuplicados` (auto-cruce.util). La
    // referencia que la IA lee del PDF NO es estable entre lecturas (29-sep-
    // 2026: el mismo cargo llegó con tres referencias distintas y se insertó
    // tres veces), así que NUNCA veta un duplicado: manda la leyenda
    // tolerante (truncado, redacción) y la referencia solo suma.
    const { aInsertar: nuevos, duplicados: duplicadosOmitidos } =
      emparejarDuplicados(base, previos ?? []);

    await onProgress(18, 'Archivando el estado de cuenta…');
    // El archivo original se archiva DESPUÉS de validar y ANTES de insertar:
    // cada movimiento queda ligado a su estado de cuenta. Se archiva aunque
    // todo resulte duplicado (re-subir un estado de cuenta viejo solo para
    // conservar el archivo es un caso legítimo).
    const estadoCuentaId = await this.archivarEstadoCuenta(dto, userId);

    if (nuevos.length === 0) {
      if (estadoCuentaId) {
        await this.supabase.service
          .from('estado_cuenta_archivo')
          .update({ movimientos_importados: 0 })
          .eq('id', estadoCuentaId);
      }
      return {
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
    }
    const rows = nuevos.map((r) => ({
      ...r,
      estado_cuenta_id: estadoCuentaId,
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
    // referencia a ±5 días; BANCO, neto/bruto a ±3.
    const cuentaInfo = await this.infoCuenta(dto.cuenta_bancaria_id);
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
    const ctx = await this.cargarCtxCruce();
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
    //    Spruce). Solo con TC implícito plausible y candidato único.
    if (moneda === 'MXN' && monto > 0) {
      const { data: usd, error: usdErr } = await this.gastosCandidatos({
        moneda: 'USD',
        desde,
        hasta,
        limite: 25,
      });
      if (usdErr) {
        return {
          ...base,
          resultado: 'ERROR',
          motivo: `No se pudieron leer los gastos en USD: ${usdErr.message}`,
        };
      }
      const plausibles = (usd ?? [])
        .filter((g) => {
          const m = Number((g as { monto: unknown }).monto);
          if (!(m > 0)) return false;
          const tc = monto / m;
          return tc >= TC_IMPLICITO_MIN && tc <= TC_IMPLICITO_MAX;
        })
        .map((g) => this.aCandidatoCruce(g));
      // OJO (revisión 15-sep-2026): aquí el monto NO cuadra — la banda de TC
      // (15-25) acepta cualquier gasto USD dentro de un ±25 % del cargo. Por
      // eso este camino liga SOLO con candidato ÚNICO: desempatar por
      // descripción o por tarjeta entre montos que no coinciden sería ligar
      // «por parecerse», justo lo que el auto-cruce tiene prohibido.
      if (plausibles.length === 1) {
        return this.ligarCargo(mov.id, plausibles[0].id, userId, {
          ...base,
          criterio: 'TC_IMPLICITO',
          candidatos_n: 1,
        });
      }
      if (plausibles.length > 1) {
        return {
          ...base,
          resultado: 'AMBIGUO',
          candidatos_n: plausibles.length,
          motivo: `${plausibles.length} gastos en USD podrían corresponder a este cargo en pesos (tipo de cambio entre ${TC_IMPLICITO_MIN} y ${TC_IMPLICITO_MAX}): vincúlalo a mano.`,
        };
      }
    }
    return {
      ...base,
      motivo: `Ningún gasto bancario sin conciliar de ${montoBonito(monto)} ${moneda ?? ''} entre ${desde} y ${hasta}.`,
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
      await this.linkCobro(movId, liga, userId);
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

  /** Contexto del auto-cruce: se carga UNA vez por corrida, no por fila. */
  private async cargarCtxCruce(): Promise<CruceCtx> {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .select('terminacion, activa')
      .limit(200);
    if (error) {
      // Sin catálogo no hay desempate por tarjeta, pero el cruce sigue.
      this.logger.warn(`No se pudo leer tarjeta_corporativa: ${error.message}`);
      return { terminaciones: [] };
    }
    return {
      terminaciones: (data ?? [])
        .map((t) => (t as { terminacion: unknown }).terminacion)
        .filter((t): t is string => typeof t === 'string'),
    };
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
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (!ids && desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
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
      // caso cruzado USD↔MXN: 1 ↔ 1, se deja al operador).
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

    // El banco deposita monto − comisión bancaria: el abono real es el NETO.
    // Se matchea por bruto (cobros sin comisión) O por neto (con comisión) —
    // antes solo por bruto y los cobros con comisión jamás conciliaban.
    // El cliente (vuelo/grupo) viaja para desempatar por NOMBRE del
    // ordenante (transferencias SPEI) cuando ≥ 2 candidatos cuadran.
    let q = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, monto, comision_banco_monto, fecha_cobro, vuelo:vuelo!vuelo_id(cliente:cliente_id(nombre))',
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
    const candidatos: CandidatoAbonoCruce[] = [
      ...((cobrosRes.data ?? []) as Array<Record<string, unknown>>).map(
        (c): CandidatoAbonoCruce => ({
          tipo: 'COBRO_VUELO',
          id: c.id as string,
          monto: Number(c.monto) || 0,
          comision: Number(c.comision_banco_monto) || null,
          fecha: (c.fecha_cobro as string) ?? '',
          cliente: nombreDe(c.vuelo),
          cuenta_bancaria_id: null,
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
    // Primero el MONTO (misma regla de siempre): los ids que cuadran.
    const cuadran = candidatos.filter(
      (c) =>
        cuadraMontoAbono(abono, c, false) &&
        (c.tipo !== 'INGRESO' ||
          c.cuenta_bancaria_id === abono.cuenta_bancaria_id),
    );
    if (cuadran.length === 0) {
      return {
        ...base,
        motivo: `Ningún cobro bancario de ${montoBonito(monto)} ${moneda ?? ''} entre ${lo.slice(0, 10)} y ${hi.slice(0, 10)}.`,
      };
    }

    // Descarta cobros/sobres/ingresos ya enlazados a otro movimiento; exige
    // candidato único ENTRE LOS UNIVERSOS (o el nombre del ordenante).
    const cobroIds = cuadran
      .filter((c) => c.tipo === 'COBRO_VUELO')
      .map((c) => c.id);
    const sobreIds = cuadran
      .filter((c) => c.tipo === 'SOBRE_GRUPO')
      .map((c) => c.id);
    const ingresoIds = cuadran
      .filter((c) => c.tipo === 'INGRESO')
      .map((c) => c.id);
    const filtro = conIngresos
      ? filtroLigaCobrosConAnticipos(cobroIds, sobreIds, ingresoIds)
      : filtroLigaCobros(cobroIds, sobreIds);
    const { data: yaEnlazados } = filtro
      ? await this.supabase.service
          .from('movimiento_bancario')
          .select(conIngresos ? MOV_LIGA_COLS_CON_INGRESO : MOV_LIGA_COLS)
          .or(filtro)
      : { data: [] as MovimientoLiga[] };
    const ocupados = new Set<string>();
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
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: hayIngreso
          ? `${eleccion.candidatos_n} cobros/sobres/ingresos cuadran con este abono: vincúlalo a mano.`
          : `${eleccion.candidatos_n} cobros/sobres cuadran con este abono: vincúlalo a mano.`,
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
   * hay; null si no se pudo leer (el llamador NO liga).
   */
  private async cobrosExactosLibresDeAbono(
    abono: AbonoCruce,
    fecha: string,
    moneda: string,
    pasarela: boolean,
  ): Promise<number | null> {
    const sb = this.supabase.service;
    const { lo, hi } = this.ventanaAbono(fecha, VENTANA_MANUAL_DIAS);
    const [cobrosRes, sobresRes] = await Promise.all([
      sb
        .from('cobro_vuelo')
        .select('id, monto, comision_banco_monto')
        .gt('monto', 0)
        .is('cobro_grupo_id', null)
        .is('ingreso_anticipo_id', null)
        .in('metodo_cobro', METODOS_ABONO_MANUAL)
        .eq('moneda', moneda)
        .gte('fecha_cobro', lo)
        .lte('fecha_cobro', hi)
        .limit(1000),
      sb
        .from('cobro_grupo')
        .select('id, monto, comision_banco_monto')
        .gt('monto', 0)
        .in('metodo_cobro', METODOS_ABONO_MANUAL)
        .eq('moneda', moneda)
        .gte('fecha_cobro', lo)
        .lte('fecha_cobro', hi)
        .limit(1000),
    ]);
    if (cobrosRes.error || sobresRes.error) return null;
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
    const cobroIds = ((cobrosRes.data ?? []) as Array<Record<string, unknown>>)
      .filter((c) => exacto('COBRO_VUELO', c))
      .map((c) => c.id as string);
    const sobreIds = ((sobresRes.data ?? []) as Array<Record<string, unknown>>)
      .filter((s) => exacto('SOBRE_GRUPO', s))
      .map((s) => s.id as string);
    const filtro = filtroLigaCobros(cobroIds, sobreIds);
    if (!filtro) return 0;
    const { data: ligados, error } = await sb
      .from('movimiento_bancario')
      .select(MOV_LIGA_COLS)
      .or(filtro);
    if (error) return null;
    const ocupados = new Set<string>();
    for (const m of (ligados ?? []) as MovimientoLiga[]) {
      if (typeof m.cobro_id === 'string') ocupados.add(m.cobro_id);
      if (typeof m.cobro_grupo_id === 'string') ocupados.add(m.cobro_grupo_id);
    }
    return [...cobroIds, ...sobreIds].filter((id) => !ocupados.has(id)).length;
  }

  /**
   * Vincula un ABONO con un cobro de vuelo (`cobro_id`) O con el SOBRE de un
   * grupo (`cobro_grupo_id`) — excluyentes (CHECK
   * movimiento_bancario_cobro_excluyente). Ambos null = desvincular (limpia
   * las dos ligas). Una PARTE de sobre jamás se enlaza: 409 COBRO_DE_GRUPO
   * («concilia contra el sobre del grupo G-n»).
   */
  async linkCobro(movId: string, liga: LigaCobroInput, userId: string) {
    const cobroId = liga.cobro_id ?? null;
    const sobreId = liga.cobro_grupo_id ?? null;
    if (cobroId && sobreId) {
      throw new BadRequestException(
        'Indica un cobro de vuelo O un sobre de grupo, no los dos.',
      );
    }
    // Emparejado como devolución de un cargo (30-sep-2026): 409 antes de
    // tocar nada (el trigger también lo rechazaría, con peor mensaje).
    await this.bloquearSiEnReverso(movId);
    const [conIngresos, conPartes] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
    ]);
    const colsMov = `id, gasto_id${conIngresos ? ', ingreso_id' : ''}${conPartes ? ', gastos_n' : ''}`;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as {
      id: string;
      gasto_id: string | null;
      gastos_n?: number | null;
      ingreso_id?: string | null;
    };
    // Un abono conciliado con un INGRESO no se liga ni se desvincula por
    // aquí (su camino es PATCH movimientos/:id/ingreso).
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    // Un movimiento que ya paga gasto(s) NO admite además un cobro (revisión
    // 2-oct-2026): su dinero se contaría dos veces. El trigger A custodia el
    // sentido contrario (partes en un movimiento con cobro); este, el que
    // no tiene CHECK en la BD. Desvincular (ambos null) sí pasa.
    if ((cobroId !== null || sobreId !== null) && ligadoAGasto(mov)) {
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

    if (cobroId) {
      const colsCobro: string = conIngresos
        ? 'id, cobro_grupo_id, ingreso_anticipo_id, sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio))'
        : 'id, cobro_grupo_id, sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio))';
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
      // Un cobro ya enlazado a OTRO movimiento no puede cuadrar una segunda
      // línea del banco (el auto-match ya lo respeta; el manual también).
      const { data: yaEnlazado, error: ocupadoErr } =
        await this.supabase.service
          .from('movimiento_bancario')
          .select('id')
          .eq('cobro_id', cobroId)
          .neq('id', movId)
          .limit(1)
          .maybeSingle();
      if (ocupadoErr) throw new Error(ocupadoErr.message);
      if (yaEnlazado) {
        throw new ConflictException(
          'Ese cobro ya está conciliado con otro movimiento bancario.',
        );
      }
    }

    if (sobreId) {
      const { data: sobre, error: sobreErr } = await this.supabase.service
        .from('cobro_grupo')
        .select('id')
        .eq('id', sobreId)
        .maybeSingle();
      if (sobreErr) throw new Error(sobreErr.message);
      if (!sobre) {
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
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        cobro_id: cobroId,
        cobro_grupo_id: sobreId,
        conciliado:
          cobroId !== null ||
          sobreId !== null ||
          mov.gasto_id !== null ||
          gastosLigadosN(mov) > 0,
        // Vincular un cobro real pisa la clasificación "sin vuelo".
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(await this.movCols())
      .maybeSingle();
    if (error) {
      // Índices únicos uq_mov_bancario_cobro / uq_mov_bancario_cobro_grupo:
      // dos vínculos simultáneos al mismo cobro/sobre pasan el check previo
      // (TOCTOU) pero solo uno gana en la BD.
      if (error.code === '23505' || error.message?.includes('23505'))
        throw new ConflictException(
          sobreId
            ? 'Ese sobre de grupo ya está vinculado a otro movimiento bancario.'
            : 'Ese cobro ya está vinculado a otro movimiento bancario.',
        );
      if (error.code === '23503')
        throw new BadRequestException(
          sobreId ? 'Cobro de grupo no encontrado.' : 'Cobro no encontrado.',
        );
      if (error.code === '23514') {
        // Por NOMBRE del constraint (24-sep-2026): antes cualquier 23514
        // decía «cobro y sobre a la vez».
        const msg = error.message ?? '';
        if (msg.includes('movimiento_bancario_ingreso')) {
          throw new ConflictException({
            message:
              'Ese movimiento ya está conciliado con un ingreso: desvincúlalo antes.',
            error: 'MOVIMIENTO_YA_LIGADO',
            details: { liga: 'INGRESO' },
          });
        }
        if (msg.includes('cobro_excluyente') || !msg) {
          throw new BadRequestException(
            'Un movimiento no puede ligar un cobro de vuelo y un sobre de grupo a la vez.',
          );
        }
        throw new BadRequestException(
          `El movimiento no admite esa liga (${msg.slice(0, 200)}).`,
        );
      }
      throw new Error(error.message);
    }
    return data as unknown as Record<string, unknown>;
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
   * Candidatos para conciliar un ABONO a mano: cobros de vuelo Y sobres de
   * grupo (misma moneda que la cuenta, métodos que llegan al banco, sin
   * conciliar con OTRO movimiento) en ±`dias`, ordenados por cercanía del
   * NETO al monto del abono y luego por fecha. Las PARTES de un sobre nunca
   * se ofrecen (se concilia el sobre, que es lo que depositó el cliente).
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
    };
    candidatos: CandidatoCobro[];
    exactos: number;
    /** ADITIVO (24-sep-2026, solo con la migración de ingresos). */
    ingresos?: CandidatoIngresoAbono[];
  }> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, cuenta_bancaria_id, cobro_id, cobro_grupo_id',
      )
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);
    if (mov.tipo !== TipoMovimientoBancario.ABONO) {
      throw new BadRequestException(
        'Solo un ABONO (entrada de dinero) se concilia contra cobros de vuelo o sobres de grupo.',
      );
    }
    const moneda = await this.monedaCuenta(mov.cuenta_bancaria_id as string);
    const { lo, hi } = this.ventanaAbono(mov.fecha as string, dias);
    // INGRESOS (24-sep-2026): los cobros nacidos de un anticipo NUNCA son
    // candidatos (su dinero se concilia como anticipo) y los ingresos
    // registrados se ofrecen aparte (`ingresos`). Sin la migración: lo de
    // siempre.
    const conIngresos = await this.ingresosOn();

    let qc = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(300);
    if (conIngresos) qc = qc.is('ingreso_anticipo_id', null);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(100);
    if (moneda) {
      qc = qc.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const [cobrosRes, sobresRes] = await Promise.all([qc, qs]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (sobresRes.error) throw new Error(sobresRes.error.message);
    const cobros = (cobrosRes.data ?? []) as Array<Record<string, unknown>>;
    const sobres = (sobresRes.data ?? []) as Array<Record<string, unknown>>;

    // Ya conciliados con OTRO movimiento (fuente única: MOV_LIGA_COLS).
    const filtro = filtroLigaCobros(
      cobros.map((c) => c.id as string),
      sobres.map((s) => s.id as string),
    );
    const ocupadosCobro = new Set<string>();
    const ocupadosSobre = new Set<string>();
    if (filtro) {
      const { data: ligas, error: ligasErr } = await this.supabase.service
        .from('movimiento_bancario')
        .select(MOV_LIGA_COLS)
        .or(filtro);
      if (ligasErr) throw new Error(ligasErr.message);
      for (const m of (ligas ?? []) as MovimientoLiga[]) {
        if (m.id === movId) continue;
        if (typeof m.cobro_id === 'string') ocupadosCobro.add(m.cobro_id);
        if (typeof m.cobro_grupo_id === 'string')
          ocupadosSobre.add(m.cobro_grupo_id);
      }
    }
    const partesN = await this.contarPartesPorSobre(
      sobres.map((s) => s.id as string),
    );

    const montoMov = Number(mov.monto) || 0;
    const refMs = Date.parse(`${mov.fecha as string}T00:00:00Z`);
    const candidatos: CandidatoCobro[] = [
      ...cobros
        .filter((c) => !ocupadosCobro.has(c.id as string))
        .map((c): CandidatoCobroVuelo => {
          const vuelo = unwrapOne(
            c.vuelo as {
              folio?: unknown;
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(vuelo?.cliente);
          const bruto = Number(c.monto) || 0;
          const comision = Number(c.comision_banco_monto) || 0;
          const neto = r2(bruto - (comision > 0 ? comision : 0));
          return {
            tipo: 'COBRO_VUELO',
            id: c.id as string,
            cobro_id: c.id as string,
            vuelo_id: c.vuelo_id as string,
            folio: vuelo?.folio == null ? null : Number(vuelo.folio),
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            fecha_cobro: c.fecha_cobro as string,
            monto: r2(bruto),
            moneda: c.moneda as string,
            metodo_cobro: c.metodo_cobro as string,
            referencia: (c.referencia as string | null) ?? null,
            comision_banco_monto: comision > 0 ? r2(comision) : null,
            neto,
            dif_monto: r2(Math.abs(neto - montoMov)),
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
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(grupo?.cliente);
          return {
            ...norm,
            id: norm.cobro_grupo_id,
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            dif_monto: r2(Math.abs(norm.neto - montoMov)),
          };
        }),
    ]
      .sort(
        (a, b) =>
          a.dif_monto - b.dif_monto ||
          Math.abs(Date.parse(a.fecha_cobro) - refMs) -
            Math.abs(Date.parse(b.fecha_cobro) - refMs),
      )
      .slice(0, CANDIDATOS_MAX);
    const salida = {
      movimiento: {
        id: mov.id as string,
        fecha: mov.fecha as string,
        monto: r2(montoMov),
        tipo: mov.tipo as string,
        moneda,
        cobro_id: (mov.cobro_id as string | null) ?? null,
        cobro_grupo_id: (mov.cobro_grupo_id as string | null) ?? null,
      },
      candidatos,
      exactos: candidatos.filter((c) => c.dif_monto === 0).length,
    };
    if (!conIngresos) return salida;
    return {
      ...salida,
      ingresos: await this.ingresosCandidatosDeAbono(
        movId,
        mov.cuenta_bancaria_id as string,
        mov.fecha as string,
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
      ? 'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))'
      : 'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))';
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
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, cliente:cliente_id(nombre))',
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
   */
  private async ligasDeCobros(
    cobros: ReadonlyArray<CobroPaywise>,
  ): Promise<Map<string, string>> {
    const filtro = filtroLigaCobros(
      cobros.filter((c) => c.tipo === 'COBRO_VUELO').map((c) => c.id),
      cobros.filter((c) => c.tipo === 'SOBRE_GRUPO').map((c) => c.id),
    );
    const out = new Map<string, string>();
    if (!filtro) return out;
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(MOV_LIGA_COLS)
      .or(filtro);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as MovimientoLiga[]) {
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
   * Aplica un cruce: escribe en el cobro de vuelo la comisión REAL del
   * archivo (si difiere — mismo espíritu que `tc_gasto` al ligar gastos;
   * ANTES de ligar, porque un cobro conciliado ya no se toca) y liga el
   * movimiento (`linkCobro`, con sus candados). Un SOBRE no se reescribe
   * (su comisión se parte entre los hijos): solo se liga y se reporta.
   */
  private async aplicarCrucePaywise(
    cruce: CrucePaywise,
    userId: string,
  ): Promise<void> {
    const { cobro, movimiento } = cruce;
    if (
      cobro.tipo === 'COBRO_VUELO' &&
      cruce.comision_paywise != null &&
      cruce.dif_comision != null &&
      Math.abs(cruce.dif_comision) > 0.01 &&
      cruce.comision_paywise >= 0 &&
      cruce.comision_paywise < cobro.monto
    ) {
      const comision = cruce.comision_paywise;
      const { error } = await this.supabase.service
        .from('cobro_vuelo')
        .update({
          comision_banco_monto: comision > 0 ? r2(comision) : null,
          comision_banco_pct:
            comision > 0
              ? Math.round((comision / cobro.monto) * 100 * 10000) / 10000
              : null,
          updated_by: userId,
        })
        .eq('id', cobro.id);
      if (error) throw new Error(error.message);
      this.logger.log(
        `Paywise: comisión real ${comision} escrita en cobro ${cobro.id} (antes ${cruce.comision_sistema}).`,
      );
    }
    await this.linkCobro(
      movimiento.id,
      cobro.tipo === 'COBRO_VUELO'
        ? { cobro_id: cobro.id }
        : { cobro_grupo_id: cobro.id },
      userId,
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
    const movsRaw = conIngresos
      ? movsLeidos.filter(
          (m) => !(typeof m.ingreso_id === 'string' && m.ingreso_id),
        )
      : movsLeidos;
    const movimientosConIngreso = movsLeidos.length - movsRaw.length;
    const movimientos: MovimientoPaywise[] = movsRaw.map((m) => ({
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
  async auditoriaPaywise(q: PaywiseAuditoriaQuery) {
    if (q.desde > q.hasta)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    const u = await this.universoPaywise(q);
    const r = cruzarPaywise(u.movimientos, u.cobros, { dias: q.dias });
    return this.armarSalidaAuditoria(
      q,
      u.cuentas,
      u.movimientos,
      u.cobros,
      u.cobrosConciliadosFuera,
      r,
      { movimientos_con_ingreso: u.movimientosConIngreso },
    );
  }

  /**
   * POST /conciliacion/paywise/auditoria/conciliar — liga automáticamente
   * los cruces que CUADRAN (NETO/BRUTO), escribiendo la comisión real en los
   * cobros de vuelo, y devuelve la auditoría recalculada. Cada liga es
   * independiente: un fallo (carrera, cobro ya ligado) se reporta en
   * `errores` sin tumbar el resto.
   */
  async conciliarPaywise(q: PaywiseAuditoriaQuery, userId: string) {
    if (q.desde > q.hasta)
      throw new BadRequestException('desde no puede ser posterior a hasta');
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
      },
    );
  }

  /**
   * GET /conciliacion/paywise/auditoria.xlsx — 3 hojas: «Cotejo» (todo lo
   * cruzado con bruto/comisión/neto sistema vs Paywise y la diferencia en
   * naranja), «Paywise sin cobro» y «Cobros sin Paywise».
   */
  async auditoriaPaywiseXlsx(
    q: PaywiseAuditoriaQuery,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
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
    return { buffer, etiqueta: 'paywise' };
  }

  /**
   * GET /conciliacion/cobros-sin-banco — el espejo de `gastosSinBanco` para
   * los COBROS (9-sep-2026): cobros de vuelo (no partes de sobre) y sobres
   * con método bancario (transferencia / HSBC link / cheque / Paywise) sin
   * liga con ningún abono importado. Lo usa el pre-cierre como aviso.
   * Default: últimos 90 días por fecha_cobro (cortes Cancún).
   */
  async cobrosSinBanco(desde?: string, hasta?: string) {
    // Defaults en día CANCÚN (no UTC): a las 20:00 de Cancún el UTC ya es
    // mañana y el corte se corría un día.
    const d = desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    const h = hasta ?? hoyCancun();
    if (d > h)
      throw new BadRequestException('desde no puede ser posterior a hasta');
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
    const ligas = await this.ligasDeCobros(cobros);
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
      if (ligas.has(`${c.tipo}:${c.id}`)) return false;
      const ant = c.ingreso_anticipo_id;
      return !(typeof ant === 'string' && ant && anticiposConciliados.has(ant));
    });
    const porMoneda = new Map<string, number>();
    const data = libres.map((c) => {
      porMoneda.set(c.moneda, (porMoneda.get(c.moneda) ?? 0) + c.monto);
      const { ingreso_anticipo_id: ant, ...resto } = c;
      const fila = {
        ...resto,
        metodo_label: etiquetaMetodoCobro(c.metodo_cobro),
        neto: r2(c.monto - (c.comision_banco_monto ?? 0)),
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
      por_moneda: [...porMoneda.entries()].map(([moneda, monto]) => ({
        moneda,
        monto: r2(monto),
      })),
    };
  }

  /** Catálogo de clasificaciones "sin vuelo" (activas, orden alfabético). */
  async listClasificaciones() {
    const { data, error } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .select('id, nombre, activo')
      .eq('activo', true)
      .order('nombre', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
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
  ) {
    // REVERSOS (30-sep-2026): un movimiento emparejado como cargo devuelto /
    // devolución. «Quitar clasificación» (null) en CUALQUIERA de los dos
    // deja AMBOS pendientes; cambiarle la clasificación rompería el par en
    // silencio ⇒ 409 (se quita primero); la MISMA clasificación (editar
    // notas) sí se permite.
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
    const [conIngresosCl, conPartesCl] = await Promise.all([
      this.ingresosOn(),
      this.partesOn(),
    ]);
    const colsMov = `id, gasto_id, cobro_id, cobro_grupo_id${conIngresosCl ? ', ingreso_id' : ''}${conPartesCl ? ', gastos_n' : ''}`;
    const { data: movRaw, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(colsMov)
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!movRaw) throw new NotFoundException(`Movimiento ${movId} not found`);
    const mov = movRaw as unknown as Record<string, unknown>;
    // Ligado a gasto(s) = `gasto_id` (espejo) o `gastos_n > 0` (lote).
    const conGasto = ligadoAGasto(mov);
    // Conciliado con un INGRESO: ni se clasifica ni se «des-clasifica» por
    // aquí (24-sep-2026): el camino es PATCH movimientos/:id/ingreso.
    if (typeof mov.ingreso_id === 'string' && mov.ingreso_id) {
      throw await this.conflictoMovimientoConIngreso(mov.ingreso_id);
    }
    if (clasificacionId && (conGasto || mov.cobro_id || mov.cobro_grupo_id)) {
      throw new ConflictException(
        'El movimiento ya está conciliado con un gasto/cobro: desvincúlalo antes de clasificarlo.',
      );
    }
    if (clasificacionId) {
      const { data: clasif, error: clErr } = await this.supabase.service
        .from('conciliacion_clasificacion')
        .select('id')
        .eq('id', clasificacionId)
        .maybeSingle();
      if (clErr) throw new Error(clErr.message);
      if (!clasif)
        throw new BadRequestException('Clasificación no encontrada.');
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
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update(patch)
      .eq('id', movId)
      .select(await this.movCols())
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as unknown as Record<string, unknown>;
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
      return { ...this.respuestaPar(abono, cargo), idempotente: true };
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
    const d = desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
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
    const colsResumen: string = conPartes
      ? 'id, cuenta_bancaria_id, tipo, monto, conciliado, gastos_n'
      : 'cuenta_bancaria_id, tipo, monto, conciliado';
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(colsResumen);
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const difLotes = conPartes
      ? await this.diferenciaLotesPorCuenta(
          (data ?? []) as unknown as Array<Record<string, unknown>>,
        )
      : null;

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
      }
    >();
    for (const m of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const key = m.cuenta_bancaria_id as string;
      const cur = porCuenta.get(key) ?? {
        total: 0,
        conciliados: 0,
        pendientes: 0,
        monto_pendiente: 0,
      };
      cur.total += 1;
      if (m.conciliado === true) cur.conciliados += 1;
      else {
        cur.pendientes += 1;
        cur.monto_pendiente += Number(m.monto);
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
  async reporteXlsx(
    cuentaBancariaId: string | undefined,
    desde: string,
    hasta: string,
    estado: ReporteConciliacionEstado = 'todos',
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
    // NÚMERO DE FACTURA (5-oct-2026): «Notas» lleva la factura del gasto.
    const embedFolioReporte = await this.embedFolio();
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // escala_id/aeronave_id del gasto y aeronave_id de los vuelos: para
        // resolver la MATRÍCULA de la línea (avionDelGasto, fuente única).
        `${MOV_COLS}${embedIngresoReporte}${colReversoReporte}${colPartesReporte}, gasto:gasto!gasto_id(categoria, vuelo_id, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id), ${embedFolioReporte}), cobro:cobro_vuelo!cobro_id(metodo_cobro, vuelo:vuelo!vuelo_id(folio, aeronave_id)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
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
    // Sobres de grupo normalizados (SOBRE_GRUPO con aviones_n).
    const movs = await this.normalizarSobresEnMovs(
      (data ?? []) as unknown as Array<Record<string, unknown>>,
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
      return [
        (m.fecha as string) ?? '',
        (m.descripcion as string | null) ?? '',
        (m.referencia as string | null) ?? '',
        matriculaDeMov(m),
        esCargo ? monto : null,
        esCargo ? null : monto,
        ok ? 'Conciliado' : 'PENDIENTE',
        ok ? conQue(m) : '',
        // «Notas» = número de la(s) factura(s) del/los gasto(s) ligado(s) +
        // la nota del banco (5-oct-2026, pedido del cliente). Sin gasto con
        // folio (cobros, ingresos, clasificaciones, reversos, gastos sin
        // número) queda la nota del banco como hasta el 0.0.56.
        notasReporteConFactura(
          etiquetaFacturasReporte(foliosDeMov(m)),
          m.notas as string | null,
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
      subtitulo: `${movs.length} movimientos (${etiquetaEstado}) · ${conciliados} conciliados · ${pendientes} pendientes · ${desde} a ${hasta}`,
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
        g.medio_pago === 'TARJETA_CORP'
          ? `Tarjeta${g.tarjeta_terminacion ? ` **** ${g.tarjeta_terminacion as string}` : ''}`
          : g.medio_pago === 'PAYWISE'
            ? 'PayWise'
            : 'Transferencia',
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
    // NÚMERO DE FACTURA (5-oct-2026): `gasto.folio_comprobante` y el de cada
    // `gastos[]` del lote (ADITIVOS; los campos crudos no viajan).
    const embedFolioLista = await this.embedFolio();
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // El gasto/cobro conciliado trae su detalle y su vuelo (folio) para
        // que la fila sea verificable de un clic desde el panel.
        // `gasto.medio_pago` (ADITIVO 6-oct-2026): «Efectivo» en la celda.
        `${MOV_COLS}${embedIngresoLista}${colReverso}${colPartes}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto, vuelo_id, medio_pago, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio), ${embedFolioLista}), cobro:cobro_vuelo!cobro_id(monto, moneda, metodo_cobro, fecha_cobro, vuelo_id, vuelo:vuelo!vuelo_id(folio)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
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
    if (filters.desde) q = q.gte('fecha', filters.desde);
    if (filters.hasta) q = q.lte('fecha', filters.hasta);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const filas = await this.normalizarSobresEnMovs(
      (data ?? []) as unknown as Array<Record<string, unknown>>,
    );
    // ADITIVO (5-oct-2026): `gasto.folio_comprobante` (número de factura).
    for (const m of filas) {
      const gasto = unwrapOne<Record<string, unknown>>(
        m.gasto as Record<string, unknown> | null,
      );
      if (gasto) m.gasto = conFolioComprobante(gasto);
    }
    await this.anotarMotivoPendiente(filas);
    // ADITIVOS (30-sep-2026): `reverso_de` (abono) / `revertido_por` (cargo).
    await this.anotarReversos(filas);
    // ADITIVOS (2-oct-2026): `gastos[]`, `gastos_suma`, `gastos_diferencia`.
    if (conPartes) await this.anotarPartes(filas, embedFolioLista);
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
   */
  private async anotarPartes(
    filas: Array<Record<string, unknown>>,
    embedFolioLista: string,
  ): Promise<void> {
    const conPartes = filas.filter((m) => Number(m.gastos_n) > 0);
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
      }
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
      const { data: gastos, error } = await this.gastosCandidatos({
        moneda: null, // la moneda se filtra por cuenta, fila por fila
        desde,
        hasta,
        limite: MOTIVO_GASTOS_MAX,
      });
      // Truncado = foto incompleta: mejor no decir nada que decir «sin
      // candidato» de un gasto que sí existe.
      if (error || !gastos || gastos.length >= MOTIVO_GASTOS_MAX) return;

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
    } catch (err) {
      this.logger.warn(
        `No se pudo calcular el motivo de los pendientes: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  }> {
    const cols: string = (await this.ingresosOn())
      ? 'id, tipo, gasto_id, gastos_n, monto, cuenta_bancaria_id, ingreso_id'
      : 'id, tipo, gasto_id, gastos_n, monto, cuenta_bancaria_id';
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
      fecha_gasto?: string | null;
      monto?: unknown;
    }>,
    yaLigados: ReadonlySet<string>,
    justificacion: string | null | undefined,
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
      // 1) El CARGO: una línea por gasto no bancario que paga.
      await this.reescribirNotas(
        'movimiento_bancario',
        filaNotas(mov),
        (notas) => {
          let n = args.todoElCargo
            ? quitarNotasVinculoNoBancario(notas)
            : notas;
          for (const id of args.soltar) {
            const g = gastoDe.get(id);
            if (g) {
              n = quitarNotasVinculoNoBancario(n, { gasto: gastoDeNota(g) });
            }
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
      // lectura y la escritura ⇒ 409, ya no un 500 técnico.
      case 'CARGO_EXCEDIDO':
      case 'MOVIMIENTO_YA_LIGADO':
      case 'REVERSO_INVALIDO':
      case 'LOTE_SOLO_API_NUEVO':
      case 'PARTES_INCOHERENTES':
      case 'CARGO_LIGADO':
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
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
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
    if (moneda !== 'MXN' || !(monto > 0)) return [...propios, ...parciales];
    const usd = await traer({ moneda: 'USD', limite: 15, tolerante: true });
    const cruzados = usd
      .map((g) => {
        const m = Number(g.monto);
        const tc = m > 0 ? monto / m : 0;
        return tc >= TC_IMPLICITO_MIN && tc <= TC_IMPLICITO_MAX
          ? aCandidato(g, round6(tc))
          : null;
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
  ): SugerenciaConciliacion['candidatos'][number] {
    const prov = unwrapOne(
      g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
    );
    const vuelo = unwrapOne(g.vuelo as { folio?: unknown } | null);
    const avion = unwrapOne(g.aeronave as { matricula?: unknown } | null);
    const captura = unwrapOne(g.captura as { nombre?: unknown } | null);
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
   * las mismas reglas: sin conciliar, moneda, ventana, búsqueda, cruzados);
   * cada candidato lleva `no_bancario` y los no bancarios van DESPUÉS de
   * todos los bancarios (cada bloque con `ordenarCandidatosGasto`). Ligarlos
   * exige `justificacion` en el PATCH.
   */
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
      .select('id, fecha, monto, tipo, cuenta_bancaria_id')
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
    const moneda = await this.monedaCuenta(mov.cuenta_bancaria_id as string);
    if (!moneda) throw errorSinMonedaCuenta();
    const fecha = typeof mov.fecha === 'string' ? mov.fecha.slice(0, 10) : '';
    const montoCargo = r2(Math.abs(Number(mov.monto)) || 0);
    const ventana = ventanaDias(fecha, dias);
    const busqueda = interpretarBusquedaGasto(query.q);

    // Texto: proveedores que se llaman así (≤ 50), en una consulta aparte.
    let orTexto: string | null = null;
    if (busqueda.tipo === 'texto') {
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
      orTexto = [
        `notas.ilike.*${patron}*`,
        `lugar.ilike.*${patron}*`,
        `folio_ticket.ilike.*${patron}*`,
        ...(provIds.length > 0
          ? [`proveedor_id.in.(${provIds.join(',')})`]
          : []),
      ].join(',');
    }

    const colsRicas = await this.gastoRicoCols();
    const leer = async (monedaQ: string) => {
      let qb = this.supabase.service
        .from('gasto')
        .select(colsRicas)
        .eq('conciliado', false);
      // Universo por medio: bancarios (siempre) o, con la bandera, todo
      // menos BODEGA (`medio_pago` es NOT NULL: el `neq` no pierde nulos).
      qb = incluirNoBancarios
        ? qb.neq('medio_pago', MEDIO_BODEGA)
        : qb.in('medio_pago', MEDIOS_BANCARIOS);
      qb = qb
        .eq('moneda', monedaQ)
        .gte('fecha_gasto', ventana.desde)
        .lte('fecha_gasto', ventana.hasta);
      if (busqueda.tipo === 'monto') {
        qb = qb.gte('monto', busqueda.min);
        qb = busqueda.maxExclusivo
          ? qb.lt('monto', busqueda.max)
          : qb.lte('monto', busqueda.max);
      }
      if (orTexto) qb = qb.or(orTexto);
      const { data, error } = await qb
        .order('fecha_gasto', { ascending: false })
        .order('id', { ascending: true })
        .limit(CANDIDATOS_GASTO_TOPE);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Array<Record<string, unknown>>;
    };

    const propios = await leer(moneda);
    let cruzados: Array<{ g: Record<string, unknown>; tc: number }> = [];
    let leidosUsd = 0;
    if (moneda === 'MXN' && busqueda.tipo === 'vacia' && montoCargo > 0) {
      const usd = await leer('USD');
      leidosUsd = usd.length;
      cruzados = usd
        .map((g) => {
          const m = Number(g.monto);
          return { g, tc: m > 0 ? montoCargo / m : 0 };
        })
        .filter((x) => x.tc >= TC_IMPLICITO_MIN && x.tc <= TC_IMPLICITO_MAX);
    }
    const vinculado = await this.sumasLigadasDe([
      ...propios.map((g) => g.id as string),
      ...cruzados.map((x) => x.g.id as string),
    ]);
    const conMedio = <T extends { medio_pago?: string | null }>(c: T) => ({
      ...c,
      no_bancario: !esMedioBancario(c.medio_pago),
    });
    const candidatos = [
      ...propios.map((g) =>
        conMedio(
          this.aCandidatoGasto(g, null, vinculado.get(g.id as string) ?? 0),
        ),
      ),
      ...cruzados.map((x) =>
        conMedio({
          ...this.aCandidatoGasto(
            x.g,
            round6(x.tc),
            vinculado.get(x.g.id as string) ?? 0,
          ),
          cruzado: true as const,
        }),
      ),
    ];
    // Bancarios primero; luego (solo con la bandera) los no bancarios, cada
    // bloque con el orden de siempre.
    const ref = { montoCargo, fecha };
    const ordenados = [
      ...ordenarCandidatosGasto(
        candidatos.filter((c) => !c.no_bancario),
        ref,
      ),
      ...ordenarCandidatosGasto(
        candidatos.filter((c) => c.no_bancario),
        ref,
      ),
    ];
    const respuesta: GastosCandidatosRespuesta = {
      movimiento: { id: movId, fecha, monto: montoCargo, moneda },
      ventana,
      candidatos: ordenados.slice(0, limite),
      truncado:
        ordenados.length > limite ||
        propios.length >= CANDIDATOS_GASTO_TOPE ||
        leidosUsd >= CANDIDATOS_GASTO_TOPE,
    };
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
    });
    return excluidos ? { ...respuesta, ...excluidos } : respuesta;
  }

  /**
   * `excluidos` de «Vincular gasto» (6-oct-2026, API 0.0.63; caso real: el
   * cargo de $212.00 del 07-sep y sus tres gastos de $212.00 en EFECTIVO).
   * Gastos del MISMO monto (el de `q` si es numérico; si no, el del cargo;
   * ±0.01) a ±max(120, dias) del cargo que NO entraron a los candidatos,
   * agrupados por motivo (`candidatos-excluidos.util`, puro). UNA consulta
   * extra filtrada por monto y fechas (el tope de 1000 no aplica) y, SOLO
   * si hay `YA_CONCILIADO`, la puente de esos ≤ 5 gastos para decir con qué
   * cargo (detrás de la sonda: el endpoint ya respondió 503 sin ella).
   * BEST-EFFORT: si la consulta falla devuelve null y la respuesta sale
   * SIN `excluidos`, como el 0.0.62 (el panel pinta el vacío de siempre).
   */
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
  }): Promise<ExcluidosCandidatos | null> {
    const monto = montoReferenciaExcluidos(opts.q, opts.montoCargo);
    if (!(monto > 0)) return { excluidos: [], excluidos_monto: monto };
    try {
      const banda = bandaMontoExcluidos(monto);
      const rango = ventanaExcluidos(opts.fecha, opts.dias);
      const { data, error } = await this.supabase.service
        .from('gasto')
        .select(GASTO_EXCLUIDO_COLS)
        .gte('monto', banda.min)
        .lte('monto', banda.max)
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
      throw new ConflictException({
        message:
          liga === 'INGRESO'
            ? 'Este abono ya está conciliado con otro ingreso: desvincúlalo antes de ligar este.'
            : 'Ese movimiento ya está conciliado con otra cosa: desvincúlalo antes.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: { liga },
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
                'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
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
                'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, cliente:cliente_id(nombre))',
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
      const ocupados = new Set<string>();
      for (const m of ligas.filas) {
        if (typeof m.cobro_id === 'string')
          ocupados.add(`COBRO_VUELO:${m.cobro_id}`);
        if (typeof m.cobro_grupo_id === 'string')
          ocupados.add(`SOBRE_GRUPO:${m.cobro_grupo_id}`);
        if (typeof m.ingreso_id === 'string')
          ocupados.add(`INGRESO:${m.ingreso_id}`);
      }
      const truncado =
        cobros.truncado ||
        sobres.truncado ||
        ingresos.truncado ||
        ligas.truncado;
      const lista: CandidatoAbonoLeido[] = [];
      for (const c of cobros.filas) {
        const vuelo = unwrapOne(
          c.vuelo as {
            folio?: unknown;
            cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
          } | null,
        );
        const cliente = unwrapOne(vuelo?.cliente);
        const monto = r2(Number(c.monto) || 0);
        const comision =
          Number(c.comision_banco_monto) > 0
            ? r2(Number(c.comision_banco_monto))
            : null;
        lista.push({
          tipo: 'COBRO_VUELO',
          id: c.id as string,
          monto,
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
          libre: !ocupados.has(`COBRO_VUELO:${c.id as string}`),
        });
      }
      for (const s of sobres.filas) {
        const grupo = unwrapOne(
          s.grupo as {
            folio?: unknown;
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

  /** ¿El candidato cuadra EXACTO (r2) con el abono por neto o bruto? */
  private montoExactoAbono(
    abono: { monto: number; monto_bruto: number | null },
    c: CandidatoAbonoLeido,
  ): boolean {
    const m = r2(abono.monto);
    if (r2(c.neto) === m || r2(c.monto) === m) return true;
    return abono.monto_bruto != null && r2(c.monto) === r2(abono.monto_bruto);
  }

  /** |neto − abono| (o bruto vs monto_bruto en pasarela): el menor. */
  private difMontoAbono(
    abono: { monto: number; monto_bruto: number | null },
    c: CandidatoAbonoLeido,
  ): number {
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
  ): { abono: AbonoPendiente; manuales: CandidatoAbonoLeido[] } {
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
    // como «exactos» porque no se pueden ligar a este abono).
    const manuales = moneda
      ? ctx.candidatos.filter(
          (c) =>
            c.libre && c.moneda === moneda && dentro(c, VENTANA_MANUAL_DIAS),
        )
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
    // EXACTO, el auto NO liga ⇒ AMBIGUO (anti doble conteo).
    const cobrosExactos = (pas: boolean) =>
      manuales.filter(
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
      exactos = manuales.filter(
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
    };
  }

  /** Candidato leído ⇒ forma de la decisión única de abonos. */
  private aCandidatoCruceAbono(c: CandidatoAbonoLeido): CandidatoAbonoCruce {
    return {
      tipo: c.tipo,
      id: c.id,
      monto: c.monto,
      comision: c.comision,
      fecha: c.fecha_cobro,
      cliente: c.cliente,
      cuenta_bancaria_id: c.cuenta_bancaria_id,
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
    const desde =
      q.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
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
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (!ids && desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
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
    // Candidatos por abono ordenados por (dif de monto, |días|).
    const candidatosDe = (an: (typeof analisis)[number], tope: number) =>
      [...an.manuales]
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
