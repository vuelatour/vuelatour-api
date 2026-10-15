/**
 * CONCILIACIÓN AL REVÉS DE UNA ENTRADA DE DINERO (14-oct-2026, API 0.0.78,
 * invariante 78). Pedido del usuario desde /admin/ingresos: «y me hace falta
 * que si doy clic en Conciliado vea el detalle de con qué estado de cuenta se
 * concilio y sus detalles». Gemela de la de Gastos (invariante 71): desde un
 * COBRO de vuelo (o la parte de un sobre, o un cobro aplicado de un
 * anticipo) o desde un INGRESO, sus ABONOS del banco con la cuenta, el estado
 * de cuenta de origen, lo que cada abono aporta, el lote que pagó y quién
 * registró la liga.
 *
 * FUENTE ÚNICA, PURA (sin Nest ni red), del modelo de `GET
 * /v1/conciliacion/cobros/:id` y `GET /v1/conciliacion/ingresos/:id`.
 * NINGÚN número se calcula aquí: el neto es `netoDeCobro` / `netoIngreso`;
 * la cobertura es `coberturaCobro` del 0.0.78 (invariante 77) TAL CUAL por
 * UN adaptador (`coberturaDeEntrada`); el estado, `estadoBancoCobro` (la
 * cadena de `flights.adjuntarSobres`) o `estadoConciliacionIngreso`; lo que
 * aporta cada abono es `monto_parte` de la puente; el lote, el de
 * `anotarCobrosDeAbonos` (el lector de GET movimientos); el cuadre del
 * ingreso, `montoCuadraIngreso` (la regla con la que se ligó); el T.C. de un
 * cruce, `tcImplicitoCobro` del 0.0.78 (jamás el `tc_usd_mxn` del cobro: en
 * USD nunca se guarda y en MXN es el de VENTA). La base de cada abono es
 * `aMovimientoDetalle`, la MISMA del cargo de un gasto. Jamás viajan
 * `numero_cuenta`, `clabe`, `storage_path`, `foto_voucher_url`,
 * `archivo_path` ni notas crudas.
 */
import {
  netoDeCobro,
  tcImplicitoCobro,
  TOLERANCIA_COBRO_BANCO,
  type CoberturaCobro,
  type EstadoBancoCobro,
} from '../../common/cobro-banco.util';
import {
  cobroEstaConciliado,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import {
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
} from '../../common/categoria-ingreso.util';
import { diaCancun } from '../../common/fecha-cancun.util';
import {
  etiquetaMetodoCobro,
  METODOS_COBRO_ABONO_AUTO,
} from '../../common/metodo-cobro.util';
import { normalizarTc } from '../../common/tc.util';
import { quitarNotasVinculoNoBancario } from '../../common/vinculo-no-bancario.util';
import {
  conceptoDeCobro,
  montoCuadraIngreso,
  netoIngreso,
  TOLERANCIA_INGRESO,
} from '../ingresos/ingresos.util';
import {
  aMovimientoDetalle,
  cuentaDeFila,
  registroDeParte,
  type CuentaDeCargo,
  type MovimientoDetalle,
  type RegistroLiga,
  type UltimoMovimientoCuenta,
} from './cargos-de-gasto.util';
import { parteCruzada } from './conciliacion-parcial.util';
import { quitarLineaOmision } from './omision.util';
import { comisionPaywise } from './paywise-cruce.util';
// Solo el TIPO (la forma del sobre en GET movimientos): no hay ciclo en runtime.
import type { SobreConciliacion } from './conciliacion.service';

/**
 * Desde cuándo la puente de COBROS guarda QUIÉN hizo la liga: 12-oct-2026
 * 00:00 hora Cancún. Las partes anteriores son el BACKFILL de 20261012000002,
 * que copió `updated_at`/`updated_by` del ABONO: nombrarían a quien tocó el
 * abono, no a quien ligó. Verificado en prod el 14-oct-2026: 57 partes, 29 del
 * backfill (la última 2026-10-08T18:17:53.188367Z) y 28 reales (la primera
 * 2026-10-13T15:56:03.671262Z). La RPC escribe como DIFF: una parte que
 * cambia de monto conserva su `created_at`/`created_by` («Registró la liga» =
 * quien la CREÓ). Si alguien vuelve a correr un backfill, esta regla se
 * revisa. (El corte de los GASTOS es otro: `LIGAS_REGISTRADAS_DESDE`.)
 */
export const LIGAS_COBRO_REGISTRADAS_DESDE = '2026-10-12T05:00:00.000Z';

/** Cuántos «otros cobros del día» viajan en `mismo_dia_cliente.cobros`. */
export const MISMO_DIA_COBROS_MAX = 10;

/** = `EntradaDinero.origen` de la lista de Ingresos. */
export type OrigenEntrada = 'COBRO_VUELO' | 'INGRESO';

/** Los 5 valores de la lista (`estadoBancoCobro`) — la hoja dice lo mismo. */
export type EstadoBancoEntrada =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'VIA_ANTICIPO'
  | 'SIN_CONCILIAR'
  | 'NO_BANCARIO';

/**
 * DIRECTO = puente (o espejo `cobro_id`); SOBRE = `movimiento_bancario.
 * cobro_grupo_id`; ANTICIPO = el abono del anticipo (`ingreso_id`); INGRESO =
 * `movimiento_bancario.ingreso_id` (1 ↔ 1).
 */
export type ViaEntrada = 'DIRECTO' | 'SOBRE' | 'ANTICIPO' | 'INGRESO';

/** PUENTE = `movimiento_bancario_cobro`; ESPEJO = sin 20261012000002; COLUMNA = liga 1 ↔ 1 por diseño. */
export type FuenteEntrada = 'PUENTE' | 'ESPEJO' | 'COLUMNA';

/** Por qué una liga no dice quién la hizo (el panel jamás inventa un nombre). */
export type SinRegistroLiga =
  | 'ANTERIOR_AL_CORTE'
  | 'NO_SE_GUARDA'
  | 'SIN_BITACORA'
  | 'NO_LEIDO';

/**
 * Avisos de la hoja (solo hechos guardados). Sin TC_NO_REGISTRADO: un cobro
 * en USD jamás guarda T.C. (97/97 en prod) y el de uno en MXN es el de VENTA,
 * no el del cruce.
 */
export type AlertaConciliacionEntrada =
  | 'CONCILIADO_SIN_ABONOS'
  | 'ABONO_CON_SOBRANTE'
  | 'LOTE_SIN_DETALLE';

export interface EntradaDeConciliacion {
  origen: OrigenEntrada;
  /** cobro_id | ingreso_id. */
  id: string;
  /** 'Vuelo #332' | 'ING-3' (mismas reglas que la lista). */
  etiqueta: string;
  /** 'COBRO_VUELO' | CategoriaIngreso. */
  categoria: string;
  /** 'Cobro de vuelo' | etiquetaCategoriaIngreso(...). */
  categoria_etiqueta: string;
  /** YYYY-MM-DD Cancún: diaCancun(fecha_cobro) | ingreso.fecha. */
  dia: string;
  /** Bruto; reembolso negativo. */
  monto: number;
  /** > 0 o null (cobro: comision_banco_monto; ingreso: comision_monto). */
  comision: number | null;
  /** Cobro: LA fórmula del neto (`netoDeCobro`); ingreso: `netoIngreso`. */
  neto: number;
  moneda: 'MXN' | 'USD';
  /**
   * Cobro MXN: su T.C. de VENTA guardado (`normalizarTc`); cobro USD: null
   * SIEMPRE; ingreso: el suyo. Informativo: JAMÁS se usa ni se rotula como
   * el T.C. de un cruce (ver `liga.tc_implicito`).
   */
  tc_usd_mxn: number | null;
  /** metodo_cobro / metodo (texto). */
  metodo: string;
  metodo_etiqueta: string;
  /** Tal cual la lista (cobro: cliente del vuelo; ingreso: cliente ?? pagador). */
  cliente_nombre: string | null;
  /** Cobro: `conceptoDeCobro` (regla de la lista); ingreso: descripción. */
  concepto: string | null;
  vuelo_id: string | null;
  vuelo_folio: number | null;
  /** Solo INGRESO (su `cuenta_bancaria_id`); null = efectivo / caja. */
  cuenta: CuentaDeCargo | null;
  /** Solo COBRO: el texto CAPTURADO («HSBC Dólares»), NO es FK. */
  cuenta_destino: string | null;
  registrado_por_nombre: string | null;
  /** `created_at` del cobro / del ingreso («se registró después de importar»). */
  registrado_at: string | null;
  /** monto < 0. */
  es_reembolso: boolean;
  /** Solo INGRESO (`deleted_at`). */
  dado_de_baja: boolean;
}

export interface LigaDeAbono {
  via: ViaEntrada;
  /**
   * DIRECTO: lo que ESTE abono aporta a ESTE cobro (`monto_parte` de la
   * puente; en ESPEJO, |abono|). SOBRE / ANTICIPO / INGRESO: null (el abono
   * respalda el TODO; el reparto va en su bloque).
   */
  monto_parte: number | null;
  /** La de la cuenta del abono. */
  moneda: string | null;
  /** DIRECTO: moneda de la cuenta ≠ moneda del cobro (hoy 0 casos). */
  cruzada: boolean;
  /**
   * Solo cruzada: `tcImplicitoCobro(monedaCobro, monedaCuenta, neto, parte)`
   * del 0.0.78 (round6). null sin cruce. Jamás `entrada.tc_usd_mxn`.
   */
  tc_implicito: number | null;
  /** Solo INGRESO: `montoCuadraIngreso`, la MISMA regla con la que se ligó. */
  cuadre: {
    por: 'NETO' | 'BRUTO' | null;
    diferencia: number;
    tolerancia: number;
  } | null;
  registro: RegistroLiga | null;
  /** null también en ESPEJO (no se dice nada, como en gastos). */
  sin_registro: SinRegistroLiga | null;
}

/** Solo vía DIRECTO con `cobros_n` ≥ 2. */
export interface LoteDeAbono {
  cobros_n: number;
  /**
   * `cobros[]` de GET movimientos (`anotarCobrosDeAbonos`) TAL CUAL —cobro_id,
   * monto_parte, vuelo_id, folio, cliente, fecha_cobro, monto, moneda,
   * metodo_cobro, comision_banco_monto, neto + los aditivos del 0.0.78—;
   * INCLUYE este cobro. null = no se pudo leer (alerta LOTE_SIN_DETALLE).
   */
  cobros: Array<Record<string, unknown>> | null;
  cobros_suma: number | null;
  /** `diferenciaLoteCobros` = |abono| − Σ partes; jamás ajusta un cobro. */
  cobros_diferencia: number | null;
}

/** Un abono del banco de la entrada (base COMPARTIDA con el cargo de un gasto). */
export interface AbonoDeEntrada extends MovimientoDetalle {
  /** Solo si la importación de la pasarela lo guardó (hoy 0 filas). */
  monto_bruto: number | null;
  /** `comisionPaywise(mov)` (hoy null en todo prod). */
  comision_pasarela: number | null;
  liga: LigaDeAbono;
  lote: LoteDeAbono | null;
  /** Notas del abono SIN las líneas canónicas (vínculo y «Omitido de la conciliación»). */
  notas_oficina: string | null;
}

/**
 * Cobertura del cobro del 0.0.78 TAL CUAL (vía directa). UN solo adaptador
 * (`coberturaDeEntrada`) conoce sus nombres: n_partes ⇒ abonos_n; `pasarela`
 * y `movimiento_ids` no viajan (ya van en `abonos`).
 */
export interface CoberturaDeCobro {
  neto: number;
  /** Σ partes (cruzado ⇒ neto). */
  monto_vinculado: number;
  /** max(neto − Σ, 0). */
  faltante: number;
  /** max(Σ − neto, 0). */
  sobrante: number;
  /** Σ ≥ neto − tolerancia. */
  cubierto: boolean;
  abonos_n: number;
  cruzado: boolean;
  /** `TOLERANCIA_COBRO_BANCO` (1.00): el panel jamás la escribe a mano. */
  tolerancia: number;
}

/** El cobro salió de un anticipo (conciliado o no). */
export interface AnticipoDeEntrada {
  ingreso_id: string;
  /** 'ING-12'. */
  etiqueta: string;
  monto: number;
  moneda: 'MXN' | 'USD';
  dia: string;
  cuenta_bancaria_id: string | null;
  /** El anticipo tiene su abono ligado. */
  conciliado: boolean;
}

/** Un cobro «del mismo día» (lo que ya ve quien concilia: id, vuelo, folio, montos). */
export interface CobroMismoDia {
  cobro_id: string;
  vuelo_id: string | null;
  folio: number | null;
  monto: number;
  neto: number;
}

/**
 * Otros cobros SIN conciliar del MISMO cliente (`vuelo.cliente_id`), MISMO
 * día Cancún y MISMA moneda: bancarios (`METODOS_COBRO_ABONO_AUTO`),
 * positivos, sin liga, sin sobre ni anticipo. Solo cobro SIN_CONCILIAR.
 * Best-effort.
 */
export interface MismoDiaCliente {
  cliente: string | null;
  /** = entrada.dia. */
  dia: string;
  moneda: 'MXN' | 'USD';
  /** ≤ 10, sin este; por folio. */
  cobros: CobroMismoDia[];
  /** Cuántos OTROS hay (puede ser > cobros.length). */
  n: number;
  /** Σ neto de TODOS (este incluido) con LA fórmula del neto; r2. El panel jamás suma. */
  suma_netos: number;
}

/**
 * El cobro se registró cuando ya estaban importados abonos PENDIENTES de su
 * ventana de cruce: el cruce automático (solo al importar; los cobros no
 * tienen cruce «al revés») no volvió a correr. Solo cobro SIN_CONCILIAR.
 */
export interface CruceNoCorrio {
  /** ABONO, conciliado = false, cuentas ACTIVAS de su moneda (BANCO; PAYWISE ⇒ PASARELA), fecha en la ventana y created_at < registrado_at (≥ 1). */
  abonos_previos: number;
  /** Día del cobro − MATCH_DAYS (PAYWISE: − PAYWISE_VENTANA_DIAS). */
  desde: string;
  /** Día del cobro + MATCH_DAYS (PAYWISE: + PAYWISE_VENTANA_DIAS). */
  hasta: string;
}

/** Respuesta de `GET /v1/conciliacion/cobros/:id` y `/ingresos/:id` (panel: ConciliacionDeEntrada). */
export interface ConciliacionDeEntradaRespuesta {
  entrada: EntradaDeConciliacion;
  estado: EstadoBancoEntrada;
  /** null = sin liga. */
  via: ViaEntrada | null;
  /** Cobro: COLUMNA si su liga es de sobre/anticipo; si no, PUENTE | ESPEJO. Ingreso: COLUMNA. */
  fuente: FuenteEntrada;
  /** Solo cobros positivos sin sobre ni anticipo y con estado ≠ NO_BANCARIO. */
  cobertura: CoberturaDeCobro | null;
  /** Por fecha y luego movimiento_id; [] sin liga. */
  abonos: AbonoDeEntrada[];
  /** El cobro es parte de un sobre (ligado o no): `normalizarSobre` + aviones_n. */
  sobre: SobreConciliacion | null;
  /** El cobro salió de un anticipo (conciliado o no). */
  anticipo: AnticipoDeEntrada | null;
  alertas: AlertaConciliacionEntrada[];
  /** Solo SIN_CONCILIAR o PARCIAL; cuentas ACTIVAS con `primera_fecha`. */
  ultimos_movimientos: UltimoMovimientoCuenta[] | null;
  /** Solo cobro SIN_CONCILIAR; null = no hay otros o la lectura falló. */
  mismo_dia_cliente: MismoDiaCliente | null;
  /** Solo cobro SIN_CONCILIAR; null = 0 abonos previos o la lectura falló. */
  cruce_no_corrio: CruceNoCorrio | null;
  /**
   * `cobrosParcialesDisponibles` (0.0.78) Y `!cobroDeUnSoloAbono(cobro,
   * partes)` (comisión > 0, PAYWISE, parte de PASARELA o cruzada). Ingreso ⇒
   * false; cobro de sobre / de anticipo / reembolso ⇒ false (la BD jamás le
   * liga un abono directo); falla ⇒ false.
   */
  varios_abonos_por_cobro: boolean;
}

// ----------------------------------------------------------- helpers

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Embed de PostgREST como objeto o como arreglo de uno. */
function unwrap<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function textoNoVacio(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function numeroONull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function folioDe(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nombreDe(
  nombres: ReadonlyMap<string, string>,
  id: unknown,
): string | null {
  return typeof id === 'string' ? (nombres.get(id) ?? null) : null;
}

// ----------------------------------------------------------- entradas

/**
 * Fila cruda de `cobro_vuelo` (COBRO_HOJA_COLS: con `vuelo` + `cliente`
 * embebidos) ⇒ la entrada. Mismas reglas que `ingresos.service#entradaDeCobro`
 * (etiqueta, día Cancún, cliente, concepto, NETO): la spec de paridad lo
 * congela. Las notas crudas no viajan (solo `conceptoDeCobro`).
 */
export function entradaDeCobroParaHoja(
  c: Record<string, unknown>,
  nombres: ReadonlyMap<string, string>,
): EntradaDeConciliacion {
  const vuelo = unwrap(
    c.vuelo as
      | {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        }
      | null
      | undefined,
  );
  const cliente = unwrap(vuelo?.cliente);
  const folio = vuelo?.folio == null ? null : Number(vuelo.folio);
  const monto = r2(Number(c.monto) || 0);
  const comision = Number(c.comision_banco_monto) || 0;
  const moneda: 'MXN' | 'USD' = c.moneda === 'USD' ? 'USD' : 'MXN';
  const metodo = typeof c.metodo_cobro === 'string' ? c.metodo_cobro : '';
  return {
    origen: 'COBRO_VUELO',
    id: typeof c.id === 'string' ? c.id : '',
    etiqueta: `Vuelo #${folio ?? '?'}`,
    categoria: 'COBRO_VUELO',
    categoria_etiqueta: 'Cobro de vuelo',
    dia: diaCancun(String(c.fecha_cobro)),
    monto,
    comision: comision > 0 ? r2(comision) : null,
    neto: netoDeCobro(
      c.monto as number | string | null | undefined,
      c.comision_banco_monto as number | string | null | undefined,
    ),
    moneda,
    // USD ⇒ null SIEMPRE: el alta y «Editar» nunca guardan T.C. en dólares.
    tc_usd_mxn: moneda === 'USD' ? null : normalizarTc(c.tc_usd_mxn),
    metodo,
    metodo_etiqueta: etiquetaMetodoCobro(metodo || null),
    cliente_nombre: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
    concepto: conceptoDeCobro({ referencia: c.referencia, notas: c.notas }),
    vuelo_id: typeof c.vuelo_id === 'string' ? c.vuelo_id : null,
    vuelo_folio: folio,
    cuenta: null,
    cuenta_destino: textoNoVacio(c.cuenta_destino),
    registrado_por_nombre: nombreDe(nombres, c.registrado_por),
    registrado_at: textoNoVacio(c.created_at),
    es_reembolso: monto < 0,
    dado_de_baja: false,
  };
}

/**
 * Fila cruda de `ingreso` (INGRESO_HOJA_COLS, viva o de baja) ⇒ la entrada.
 * Mismas reglas que la lista (`armar` + `entradaDeIngreso`): etiqueta ING-n,
 * cliente ?? pagador, concepto = descripción, `netoIngreso`.
 */
export function entradaDeIngresoParaHoja(
  i: Record<string, unknown>,
  nombres: ReadonlyMap<string, string>,
): EntradaDeConciliacion {
  const cliente = unwrap(
    i.cliente as { nombre?: unknown } | { nombre?: unknown }[] | null,
  );
  const vuelo = unwrap(
    i.vuelo as { folio?: unknown } | { folio?: unknown }[] | null,
  );
  const cuentaRaw = unwrap(
    i.cuenta as Record<string, unknown> | Record<string, unknown>[] | null,
  );
  const categoria = typeof i.categoria === 'string' ? i.categoria : '';
  const monto = r2(Number(i.monto) || 0);
  const comisionCruda =
    i.comision_monto == null ? null : Number(i.comision_monto);
  const metodo = typeof i.metodo === 'string' ? i.metodo : '';
  return {
    origen: 'INGRESO',
    id: typeof i.id === 'string' ? i.id : '',
    etiqueta: etiquetaIngreso(folioDe(i.folio)),
    categoria,
    categoria_etiqueta: etiquetaCategoriaIngreso(categoria),
    dia: typeof i.fecha === 'string' ? i.fecha : '',
    monto,
    comision:
      comisionCruda != null && comisionCruda > 0 ? r2(comisionCruda) : null,
    neto: netoIngreso(monto, comisionCruda),
    moneda: i.moneda === 'USD' ? 'USD' : 'MXN',
    tc_usd_mxn: normalizarTc(i.tc_usd_mxn),
    metodo,
    metodo_etiqueta: etiquetaMetodoCobro(metodo || null),
    cliente_nombre:
      (typeof cliente?.nombre === 'string' ? cliente.nombre : null) ??
      texto(i.pagador),
    concepto: texto(i.descripcion),
    vuelo_id: typeof i.vuelo_id === 'string' ? i.vuelo_id : null,
    vuelo_folio: folioDe(vuelo?.folio),
    cuenta: cuentaRaw ? cuentaDeFila(cuentaRaw) : null,
    cuenta_destino: null,
    registrado_por_nombre: nombreDe(nombres, i.created_by),
    registrado_at: textoNoVacio(i.created_at),
    es_reembolso: monto < 0,
    dado_de_baja: typeof i.deleted_at === 'string' && i.deleted_at.length > 0,
  };
}

/**
 * El estado del 0.0.78 (`estadoBancoCobro`, la cadena de
 * `flights.adjuntarSobres`) como estado de la hoja: IDENTIDAD tipada —los 5
 * valores SON los de la hoja— y el único lugar que importa el tipo del
 * 0.0.78.
 */
export function estadoBancoEntradaDeCobro(
  e: EstadoBancoCobro,
): EstadoBancoEntrada {
  return e;
}

/**
 * La cobertura del 0.0.78 (`coberturaCobro`) TAL CUAL: el ÚNICO lugar que
 * conoce sus nombres (n_partes ⇒ abonos_n; tolerancia =
 * `TOLERANCIA_COBRO_BANCO`).
 */
export function coberturaDeEntrada(c: CoberturaCobro): CoberturaDeCobro {
  return {
    neto: c.neto,
    monto_vinculado: c.monto_vinculado,
    faltante: c.faltante,
    sobrante: c.sobrante,
    cubierto: c.cubierto,
    abonos_n: c.n_partes,
    cruzado: c.cruzado,
    tolerancia: TOLERANCIA_COBRO_BANCO,
  };
}

/** El embed `anticipo:ingreso!ingreso_anticipo_id(...)` del cobro ⇒ su bloque. */
export function anticipoDeEntrada(
  raw: Record<string, unknown>,
  conciliado: boolean,
): AnticipoDeEntrada {
  return {
    ingreso_id: typeof raw.id === 'string' ? raw.id : '',
    etiqueta: etiquetaIngreso(folioDe(raw.folio)),
    monto: r2(Number(raw.monto) || 0),
    moneda: raw.moneda === 'USD' ? 'USD' : 'MXN',
    dia: typeof raw.fecha === 'string' ? raw.fecha : '',
    cuenta_bancaria_id:
      typeof raw.cuenta_bancaria_id === 'string'
        ? raw.cuenta_bancaria_id
        : null,
    conciliado,
  };
}

// ----------------------------------------------------------- registro

/** Renglón de `ingreso_bitacora` (lo que se lee: actor, cuándo y el diff). */
export interface FilaBitacoraIngreso {
  actor_id?: unknown;
  created_at?: unknown;
  diff?: unknown;
  accion?: unknown;
}

/** El CONCILIAR elegido: quién (id) y cuándo. */
export interface ConciliarDeBitacora {
  actor_id: string | null;
  at: string;
}

function movimientoDelDiff(diff: unknown): string | null {
  let d: unknown = diff;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  const id =
    d && typeof d === 'object'
      ? (d as { movimiento_id?: unknown }).movimiento_id
      : null;
  return typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null;
}

/**
 * «Registró la liga» de un INGRESO o un ANTICIPO: el renglón CONCILIAR MÁS
 * RECIENTE de su bitácora cuyo `diff.movimiento_id` es ESTE abono
 * (`linkIngreso` lo escribe en toda liga: a mano, auto-cruce y camino
 * inverso). Un CONCILIAR de OTRO abono no cuenta; null = no hay (SIN_BITACORA).
 */
export function registroDeBitacoraIngreso(
  filas: ReadonlyArray<FilaBitacoraIngreso>,
  movimientoId: string,
): ConciliarDeBitacora | null {
  const mov = movimientoId.toLowerCase();
  let mejor: { at: string; t: number; actor_id: string | null } | null = null;
  for (const f of filas) {
    if (f.accion !== undefined && f.accion !== 'CONCILIAR') continue;
    if (movimientoDelDiff(f.diff) !== mov) continue;
    if (typeof f.created_at !== 'string') continue;
    const t = Date.parse(f.created_at);
    if (!Number.isFinite(t)) continue;
    if (
      mejor === null ||
      t > mejor.t ||
      (t === mejor.t && f.created_at > mejor.at)
    ) {
      mejor = {
        at: f.created_at,
        t,
        actor_id: typeof f.actor_id === 'string' ? f.actor_id : null,
      };
    }
  }
  return mejor ? { actor_id: mejor.actor_id, at: mejor.at } : null;
}

// ----------------------------------------------------------- abonos

/** La liga de UN abono con la entrada, como la arma el servicio. */
export interface LigaParaAbono {
  via: ViaEntrada;
  /** Respaldo del id si la fila del movimiento no trae el suyo. */
  movimiento_id: string;
  /** Solo DIRECTO: la parte (puente; en ESPEJO, la sintética = |abono|). */
  monto_parte?: number | null;
  /**
   * Solo DIRECTO leído de la PUENTE con `conAutor` (invariante 78): el
   * `created_at` de la PARTE y quién la creó. AUSENTES en ESPEJO (no se dice
   * nada).
   */
  parte_created_at?: string | null;
  ligada_por?: string | null;
  /**
   * ANTICIPO / INGRESO: el CONCILIAR de la bitácora (ya con el nombre) o por
   * qué no se sabe (SIN_BITACORA / NO_LEIDO).
   */
  bitacora?: {
    registro: RegistroLiga | null;
    sin_registro: SinRegistroLiga | null;
  } | null;
}

/** Quién registró la liga, por vía (nunca se inventa un nombre). */
function registroDeLiga(liga: LigaParaAbono): {
  registro: RegistroLiga | null;
  sin_registro: SinRegistroLiga | null;
} {
  if (liga.via === 'SOBRE') {
    // La liga del sobre es una COLUMNA sin autor: jamás el `updated_by` del abono.
    return { registro: null, sin_registro: 'NO_SE_GUARDA' };
  }
  if (liga.via === 'ANTICIPO' || liga.via === 'INGRESO') {
    return {
      registro: liga.bitacora?.registro ?? null,
      sin_registro: liga.bitacora
        ? liga.bitacora.registro
          ? null
          : (liga.bitacora.sin_registro ?? 'SIN_BITACORA')
        : 'NO_LEIDO',
    };
  }
  // DIRECTO. Sin el autor de la parte (ESPEJO o liga sin parte): nada.
  if (liga.parte_created_at === undefined) {
    return { registro: null, sin_registro: null };
  }
  const t =
    typeof liga.parte_created_at === 'string'
      ? Date.parse(liga.parte_created_at)
      : Number.NaN;
  if (!Number.isFinite(t)) return { registro: null, sin_registro: null };
  const registro = registroDeParte(
    { created_at: liga.parte_created_at, ligada_por: liga.ligada_por ?? null },
    LIGAS_COBRO_REGISTRADAS_DESDE,
  );
  return registro
    ? { registro, sin_registro: null }
    : { registro: null, sin_registro: 'ANTERIOR_AL_CORTE' };
}

/**
 * Fila de `movimiento_bancario` (MOV_DETALLE_ABONO_COLS: cuenta, estado de
 * cuenta + quién lo importó, quién lo creó; más lo que le pegó
 * `anotarCobrosDeAbonos`) + su liga ⇒ el abono de ESTA entrada. Ningún
 * número nuevo: la parte es `monto_parte`, el lote el de GET movimientos,
 * el cuadre `montoCuadraIngreso`, la comisión de la pasarela
 * `comisionPaywise` y el T.C. de un cruce `tcImplicitoCobro`.
 */
export function aAbonoDeEntrada(args: {
  mov: Record<string, unknown>;
  liga: LigaParaAbono;
  entrada: Pick<
    EntradaDeConciliacion,
    'origen' | 'moneda' | 'monto' | 'comision' | 'neto'
  >;
}): AbonoDeEntrada {
  const { mov, liga, entrada } = args;
  const base = aMovimientoDetalle(mov, liga.movimiento_id);
  const directo = liga.via === 'DIRECTO';
  const montoParte =
    directo && liga.monto_parte != null
      ? r2(Number(liga.monto_parte) || 0)
      : null;
  const cruzada = directo && parteCruzada(base.moneda, entrada.moneda);
  const tc =
    cruzada && montoParte != null
      ? tcImplicitoCobro(entrada.moneda, base.moneda, entrada.neto, montoParte)
      : null;
  const cuadre =
    liga.via === 'INGRESO'
      ? (() => {
          const q = montoCuadraIngreso(
            {
              monto: Number(mov.monto) || 0,
              monto_bruto: numeroONull(mov.monto_bruto),
            },
            { monto: entrada.monto, comision_monto: entrada.comision },
            TOLERANCIA_INGRESO,
          );
          return {
            por: q.por,
            diferencia: q.diferencia,
            tolerancia: TOLERANCIA_INGRESO,
          };
        })()
      : null;
  const { registro, sin_registro } = registroDeLiga(liga);
  const cobrosN = Number(mov.cobros_n);
  const lote: LoteDeAbono | null =
    directo && Number.isFinite(cobrosN) && cobrosN >= 2
      ? {
          cobros_n: cobrosN,
          cobros: Array.isArray(mov.cobros)
            ? (mov.cobros as Array<Record<string, unknown>>)
            : null,
          cobros_suma: numeroONull(mov.cobros_suma),
          cobros_diferencia: numeroONull(mov.cobros_diferencia),
        }
      : null;
  return {
    ...base,
    monto_bruto: numeroONull(mov.monto_bruto),
    comision_pasarela: comisionPaywise({
      id: base.movimiento_id,
      fecha: base.fecha,
      monto: Number(mov.monto) || 0,
      monto_bruto: numeroONull(mov.monto_bruto),
      comision_monto: numeroONull(mov.comision_monto),
    }),
    liga: {
      via: liga.via,
      monto_parte: montoParte,
      moneda: base.moneda,
      cruzada,
      tc_implicito: tc,
      cuadre,
      registro,
      sin_registro,
    },
    lote,
    // Sin la línea de omisión (0.0.77, invariante 75) ni las del vínculo de
    // un gasto no bancario (invariante 48): las crudas no viajan.
    notas_oficina: quitarNotasVinculoNoBancario(
      quitarLineaOmision(texto(mov.notas)),
    ),
  };
}

/** Copia ordenada por fecha del abono y, en empate, por id del movimiento. */
export function ordenarAbonosDeEntrada(
  abonos: ReadonlyArray<AbonoDeEntrada>,
): AbonoDeEntrada[] {
  return [...abonos].sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
    return a.movimiento_id < b.movimiento_id
      ? -1
      : a.movimiento_id > b.movimiento_id
        ? 1
        : 0;
  });
}

/**
 * Avisos de la hoja, en este orden. SOLO comparan hechos guardados:
 * - CONCILIADO_SIN_ABONOS: CONCILIADO, VIA_ANTICIPO o PARCIAL y ningún abono
 *   se pudo leer (carrera: el abono cambió entre lecturas);
 * - ABONO_CON_SOBRANTE: vía DIRECTO y `sobrante` > tolerancia (liga vieja de
 *   un abono mayor que el cobro; con el tope del 0.0.78 ya no nacen);
 * - LOTE_SIN_DETALLE: el detalle de los otros cobros del lote no se leyó.
 */
export function alertasConciliacionEntrada(args: {
  estado: EstadoBancoEntrada;
  via: ViaEntrada | null;
  cobertura: CoberturaDeCobro | null;
  abonos: ReadonlyArray<AbonoDeEntrada>;
}): AlertaConciliacionEntrada[] {
  const out: AlertaConciliacionEntrada[] = [];
  if (
    (args.estado === 'CONCILIADO' ||
      args.estado === 'VIA_ANTICIPO' ||
      args.estado === 'PARCIAL') &&
    args.abonos.length === 0
  ) {
    out.push('CONCILIADO_SIN_ABONOS');
  }
  if (
    args.via === 'DIRECTO' &&
    args.cobertura !== null &&
    args.cobertura.sobrante > args.cobertura.tolerancia
  ) {
    out.push('ABONO_CON_SOBRANTE');
  }
  if (args.abonos.some((a) => a.lote !== null && a.lote.cobros === null)) {
    out.push('LOTE_SIN_DETALLE');
  }
  return out;
}

// ----------------------------------------------------------- «¿Qué hacer?»

const METODOS_AUTO: ReadonlySet<string> = new Set(METODOS_COBRO_ABONO_AUTO);

function diaSeguro(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  try {
    return diaCancun(iso);
  } catch {
    return null;
  }
}

/**
 * «Mismo cliente, mismo día» (D13): de los cobros leídos (los del cliente en
 * el día, ya filtrados en la BD) se quedan los OTROS cobros SIN conciliar del
 * mismo día Cancún y la misma moneda, positivos, bancarios
 * (`METODOS_COBRO_ABONO_AUTO`), sin sobre ni anticipo y SIN liga (las
 * `ligas` del lector único). Hasta 10 por folio; `n` = cuántos otros hay;
 * `suma_netos` = Σ de LA fórmula del neto de TODOS (este incluido), a
 * centavos. Sin otros ⇒ null. Jamás liga ni propone un lote: el operador
 * vincula en Conciliación.
 */
export function mismoDiaCliente(
  filas: ReadonlyArray<Record<string, unknown>>,
  ligas: ReadonlyArray<MovimientoLiga>,
  entrada: Pick<
    EntradaDeConciliacion,
    'id' | 'dia' | 'moneda' | 'neto' | 'cliente_nombre'
  >,
): MismoDiaCliente | null {
  const vistos = new Set<string>();
  const otros: CobroMismoDia[] = [];
  for (const f of filas) {
    const id = typeof f.id === 'string' ? f.id : null;
    if (!id || id === entrada.id || vistos.has(id)) continue;
    if (diaSeguro(f.fecha_cobro) !== entrada.dia) continue;
    if (f.moneda !== entrada.moneda) continue;
    if (!((Number(f.monto) || 0) > 0)) continue;
    if (typeof f.metodo_cobro !== 'string' || !METODOS_AUTO.has(f.metodo_cobro))
      continue;
    if (textoNoVacio(f.cobro_grupo_id) || textoNoVacio(f.ingreso_anticipo_id))
      continue;
    if (cobroEstaConciliado({ id }, ligas)) continue;
    vistos.add(id);
    otros.push({
      cobro_id: id,
      vuelo_id: typeof f.vuelo_id === 'string' ? f.vuelo_id : null,
      folio: folioDe(f.folio),
      monto: r2(Number(f.monto) || 0),
      neto: netoDeCobro(
        f.monto as number | string | null | undefined,
        f.comision_banco_monto as number | string | null | undefined,
      ),
    });
  }
  if (otros.length === 0) return null;
  otros.sort((a, b) => {
    if (a.folio !== b.folio) {
      if (a.folio === null) return 1;
      if (b.folio === null) return -1;
      return a.folio - b.folio;
    }
    return a.cobro_id < b.cobro_id ? -1 : a.cobro_id > b.cobro_id ? 1 : 0;
  });
  const centavos = otros.reduce(
    (acc, c) => acc + Math.round(c.neto * 100),
    Math.round(entrada.neto * 100),
  );
  return {
    cliente: entrada.cliente_nombre,
    dia: entrada.dia,
    moneda: entrada.moneda,
    cobros: otros.slice(0, MISMO_DIA_COBROS_MAX),
    n: otros.length,
    suma_netos: centavos / 100,
  };
}

/**
 * «El cruce no corrió» (D14): con ≥ 1 abono pendiente de la ventana que ya
 * estaba importado al registrar el cobro ⇒ el bloque; 0 (o sin dato) ⇒ null.
 */
export function cruceNoCorrio(
  abonosPrevios: number | null | undefined,
  desde: string,
  hasta: string,
): CruceNoCorrio | null {
  const n = Number(abonosPrevios);
  if (!Number.isFinite(n) || n < 1) return null;
  return { abonos_previos: Math.trunc(n), desde, hasta };
}
