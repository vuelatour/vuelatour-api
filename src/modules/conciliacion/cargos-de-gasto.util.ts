/**
 * CONCILIACIÓN AL REVÉS (13-oct-2026, API 0.0.75, invariante 71): desde un
 * GASTO, sus cargos del banco, la cuenta, el estado de cuenta de origen y
 * quién registró la liga. Pedido de la oficina: en Gastos, el badge de la
 * columna «Banco» decía «Conciliado» pero no CON QUÉ; había que ir a
 * Conciliación y buscar el cargo a ojo.
 *
 * FUENTE ÚNICA, PURA (sin Nest ni red), del modelo que leen la hoja del
 * panel (`GET /v1/conciliacion/gastos/:id`) y el Excel de gastos (pestaña
 * «Cargos del banco»): los dos dicen lo mismo porque los dos salen de aquí.
 * Ningún número se recalcula: lo que un cargo aporta es `monto_parte` (la
 * puente), suma y faltante son los de `v_gasto_conciliacion`, la diferencia
 * del lote es la de `anotarPartes` (`diferenciaLote`) y el T.C. es el
 * `tc_gasto` GUARDADO (nunca monto_parte / monto). Jamás viajan
 * `storage_path`, `numero_cuenta` ni `clabe`: ni se piden ni se copian.
 */
import { parteCruzada } from './conciliacion-parcial.util';
import {
  justificacionVinculoDeCargo,
  quitarNotasVinculoNoBancario,
  type JustificacionVinculo,
} from '../../common/vinculo-no-bancario.util';

/** Por qué un cargo no trae el archivo del estado de cuenta. */
export type MotivoSinArchivo = 'IMPORTADO_SIN_ARCHIVO' | 'CAPTURA_MANUAL';

/** Avisos de la hoja: solo comparan hechos GUARDADOS (nunca un cálculo). */
export type AlertaConciliacionGasto =
  | 'CONCILIADO_SIN_CARGOS'
  | 'ESTADO_DESFASADO'
  | 'TC_NO_REGISTRADO'
  | 'LOTE_SIN_DETALLE';

/** La fila de `v_gasto_conciliacion` del gasto, TAL CUAL. */
export interface VistaConciliacionGasto {
  n_partes: number;
  cruzado: boolean;
  suma: number;
  monto_vinculado: number;
  faltante: number;
  cubierto: boolean;
}

/** Quién y cuándo registró la liga (solo desde `LIGAS_REGISTRADAS_DESDE`). */
export interface RegistroLiga {
  por: string | null;
  at: string;
}

/** Cuenta del cargo. JAMÁS número de cuenta ni CLABE. */
export interface CuentaDeCargo {
  id: string;
  alias: string;
  banco: string;
  moneda: string;
  /** 'BANCO' | 'PASARELA'. */
  tipo: string;
}

/** Archivo del estado de cuenta del que salió el cargo. JAMÁS storage_path. */
export interface EstadoCuentaDeCargo {
  id: string;
  filename: string;
  formato: string | null;
  /** `estado_cuenta_archivo.created_at` (timestamptz). */
  importado_at: string;
  importado_por: string | null;
  movimientos_importados: number;
}

/** El lote que paga el cargo (solo con `gastos_n` ≥ 2), tal cual de `anotarPartes`. */
export interface LoteDeCargo {
  gastos_n: number;
  /** Forma de GET movimientos (`MovimientoGasto[]`); null = no se pudo leer. */
  gastos: Array<Record<string, unknown>> | null;
  gastos_suma: number | null;
  gastos_diferencia: number | null;
}

/**
 * La base de un movimiento del banco en una conciliación AL REVÉS: la
 * comparten el cargo de un gasto (invariante 71) y el abono de una entrada
 * de dinero (invariante 78), con las MISMAS llaves en el MISMO orden
 * (`aMovimientoDetalle`).
 */
export interface MovimientoDetalle {
  movimiento_id: string;
  /** DATE del movimiento. */
  fecha: string;
  tipo: string;
  /** |monto| del movimiento, en la moneda de SU cuenta. */
  monto: number;
  moneda: string | null;
  descripcion: string | null;
  referencia: string | null;
  conciliado: boolean;
  /** 'IMPORTADO' | 'MANUAL'. */
  origen: string | null;
  /** `movimiento_bancario.created_at` (timestamptz). */
  creado_at: string | null;
  /** Quien importó o capturó el movimiento. */
  creado_por: string | null;
  orden_archivo: number | null;
  cuenta: CuentaDeCargo | null;
  estado_cuenta: EstadoCuentaDeCargo | null;
  sin_archivo: MotivoSinArchivo | null;
}

/** Un cargo del banco ligado al gasto (una PARTE de la puente). */
export interface CargoDeGastoDetalle extends MovimientoDetalle {
  parte: {
    /** Lo que ESTE cargo aporta a ESTE gasto. */
    monto_parte: number;
    moneda: string | null;
    /** Moneda de la parte ≠ moneda del gasto (solo 1 ↔ 1). */
    cruzada: boolean;
    registro: RegistroLiga | null;
  };
  lote: LoteDeCargo | null;
  justificacion: JustificacionVinculo | null;
  /** Notas del cargo SIN las líneas del vínculo (las crudas no viajan). */
  notas_oficina: string | null;
}

/** Lo que el lector único devuelve por gasto. */
export interface CargosDeGastoLeidos {
  /** PUENTE = con la migración 20261002000002; ESPEJO = sin ella (`gasto_id`). */
  fuente: 'PUENTE' | 'ESPEJO';
  vista: VistaConciliacionGasto | null;
  cargos: CargoDeGastoDetalle[];
}

/** Último día con movimientos de una cuenta activa (best-effort). */
export interface UltimoMovimientoCuenta {
  cuenta: CuentaDeCargo;
  /**
   * ADITIVO (conciliación al revés de ENTRADAS, invariante 78): el PRIMER
   * día con movimientos (null sin movimientos). Solo viaja si se pidió
   * (`ultimosMovimientosPorCuenta({ conPrimera: true })`): Gastos responde
   * igual que siempre.
   */
  primera_fecha?: string | null;
  ultima_fecha: string | null;
}

/** Estado del gasto con el banco (`estadoBancoGasto`, espejo del panel). */
export type EstadoBancoApi =
  | 'CONCILIADO'
  | 'PARCIAL'
  | 'SIN_CONCILIAR'
  | 'NO_APLICA';

/** Respuesta de `GET /v1/conciliacion/gastos/:id`. */
export interface ConciliacionDeGastoRespuesta {
  gasto: {
    id: string;
    fecha_gasto: string | null;
    categoria: string;
    monto: number;
    moneda: string;
    medio_pago: string | null;
    tarjeta_terminacion: string | null;
    tc_gasto: number | null;
    conciliado: boolean;
    vuelo_id: string | null;
    vuelo_folio: number | null;
    proveedor: string | null;
    lugar: string | null;
    notas_primera_linea: string | null;
    folio_comprobante: string | null;
  };
  estado: EstadoBancoApi;
  fuente: 'PUENTE' | 'ESPEJO';
  vista: VistaConciliacionGasto | null;
  cargos: CargoDeGastoDetalle[];
  alertas: AlertaConciliacionGasto[];
  ultimos_movimientos: UltimoMovimientoCuenta[] | null;
}

/**
 * Desde cuándo la puente guarda QUIÉN hizo la liga: 2-oct-2026 00:00 hora
 * Cancún. Las partes anteriores son el BACKFILL de 20261002000002, que copió
 * `updated_at`/`updated_by` del CARGO: pueden nombrar a quien tocó el cargo
 * por última vez, no a quien ligó. Verificado en prod el 13-oct-2026: la
 * última parte del backfill es de 2026-10-01T22:54:57Z y la primera
 * posterior de 2026-10-02T22:14:39Z (lote de Jimmy Chi); 373 de 506 partes
 * son del backfill. Si alguien vuelve a correr un backfill, esta regla se
 * revisa.
 */
export const LIGAS_REGISTRADAS_DESDE = '2026-10-02T05:00:00.000Z';

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Embed de PostgREST como objeto o como arreglo de uno. */
function unwrap<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Texto de una celda cruda: el texto tal cual, un número a texto; lo demás ''. */
function cadena(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * Fila cruda de `cuenta_bancaria` ⇒ la cuenta del cargo (la usan el cargo y
 * `ultimos_movimientos`). JAMÁS número de cuenta ni CLABE aunque la fila
 * cruda los traiga.
 */
export function cuentaDeFila(raw: Record<string, unknown>): CuentaDeCargo {
  return {
    id: cadena(raw.id),
    alias: cadena(raw.alias),
    banco: cadena(raw.banco),
    moneda: cadena(raw.moneda),
    tipo: cadena(raw.tipo),
  };
}

function numeroONull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Por qué no hay archivo: con `estado_cuenta_id` ⇒ null; `origen` MANUAL ⇒
 * capturado a mano; cualquier otro ⇒ importado sin archivo (así son los 124
 * de prod del 16-jul-2026: nunca se dice «capturado a mano» de ellos).
 */
export function motivoSinArchivo(m: {
  estado_cuenta_id?: unknown;
  origen?: unknown;
}): MotivoSinArchivo | null {
  if (typeof m.estado_cuenta_id === 'string' && m.estado_cuenta_id.trim()) {
    return null;
  }
  return m.origen === 'MANUAL' ? 'CAPTURA_MANUAL' : 'IMPORTADO_SIN_ARCHIVO';
}

/**
 * Registro de la liga SOLO desde el corte `desde` (si no, null). Sin el 2.º
 * parámetro el corte es el de los GASTOS (`LIGAS_REGISTRADAS_DESDE`): la
 * conciliación al revés de un gasto responde byte a byte igual; la de los
 * cobros pasa `LIGAS_COBRO_REGISTRADAS_DESDE` (invariante 78).
 */
export function registroDeParte(
  p: {
    created_at: string | null;
    ligada_por?: string | null;
  },
  desde: string = LIGAS_REGISTRADAS_DESDE,
): RegistroLiga | null {
  if (typeof p.created_at !== 'string') return null;
  const t = Date.parse(p.created_at);
  if (!Number.isFinite(t)) return null;
  if (t < Date.parse(desde)) return null;
  return { por: p.ligada_por ?? null, at: p.created_at };
}

/** Parte de la puente (o la SINTÉTICA del espejo, con `created_at: null`). */
export interface ParteParaCargo {
  movimiento_id: string;
  monto_parte: number;
  moneda: string | null;
  created_at: string | null;
  ligada_por?: string | null;
}

/**
 * Fila de `movimiento_bancario` (con sus embeds `cuenta`, `estado_cuenta` +
 * `importo` y `creo`) ⇒ la BASE del movimiento en la conciliación al revés,
 * compartida por el cargo de un gasto (`aCargoDeGasto`, invariante 71) y el
 * abono de una entrada (`abonos-de-entrada.util#aAbonoDeEntrada`, invariante
 * 78): mismas llaves, mismo orden. JAMÁS `storage_path`, `numero_cuenta` ni
 * `clabe` aunque la fila cruda los traiga. `movIdRespaldo` = el id de la
 * parte/liga si la fila no trae el suyo.
 */
export function aMovimientoDetalle(
  mov: Record<string, unknown>,
  movIdRespaldo: string,
): MovimientoDetalle {
  const cuentaRaw = unwrap(
    mov.cuenta as Record<string, unknown> | Record<string, unknown>[] | null,
  );
  const cuenta: CuentaDeCargo | null = cuentaRaw
    ? cuentaDeFila(cuentaRaw)
    : null;
  const ecRaw = unwrap(
    mov.estado_cuenta as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null,
  );
  const estado_cuenta: EstadoCuentaDeCargo | null = ecRaw
    ? {
        id: cadena(ecRaw.id),
        filename: cadena(ecRaw.filename),
        formato: texto(ecRaw.formato),
        importado_at: cadena(ecRaw.created_at),
        importado_por:
          texto(
            unwrap(
              ecRaw.importo as
                | { nombre?: unknown }
                | { nombre?: unknown }[]
                | null,
            )?.nombre,
          ) ?? null,
        movimientos_importados: Number(ecRaw.movimientos_importados) || 0,
      }
    : null;
  const creo = unwrap(
    mov.creo as { nombre?: unknown } | { nombre?: unknown }[] | null,
  );
  const orden = numeroONull(mov.orden_archivo);
  return {
    movimiento_id: cadena(mov.id) || movIdRespaldo,
    fecha: cadena(mov.fecha),
    tipo: cadena(mov.tipo),
    monto: r2(Math.abs(Number(mov.monto) || 0)),
    moneda: cuenta?.moneda || null,
    descripcion: texto(mov.descripcion),
    referencia: texto(mov.referencia),
    conciliado: mov.conciliado === true,
    origen: texto(mov.origen),
    creado_at: texto(mov.created_at),
    creado_por: texto(creo?.nombre) ?? null,
    orden_archivo: orden,
    cuenta,
    estado_cuenta,
    sin_archivo: motivoSinArchivo(mov),
  };
}

/**
 * Fila de `movimiento_bancario` (con sus embeds `cuenta`, `estado_cuenta` +
 * `importo` y `creo`, más lo que le pegó `anotarPartes`) ⇒ el cargo de ESTE
 * gasto. Los valores del lote se copian TAL CUAL: el centavo de diferencia
 * jamás ajusta el gasto. La base del movimiento es `aMovimientoDetalle`
 * (el MISMO objeto de siempre, mismo orden de llaves).
 */
export function aCargoDeGasto(args: {
  parte: ParteParaCargo;
  mov: Record<string, unknown>;
  gasto: { id: string; moneda: string | null };
}): CargoDeGastoDetalle {
  const { parte, mov, gasto } = args;
  const gastosN = Number(mov.gastos_n);
  const lote: LoteDeCargo | null =
    Number.isFinite(gastosN) && gastosN >= 2
      ? {
          gastos_n: gastosN,
          gastos: Array.isArray(mov.gastos)
            ? (mov.gastos as Array<Record<string, unknown>>)
            : null,
          gastos_suma: numeroONull(mov.gastos_suma),
          gastos_diferencia: numeroONull(mov.gastos_diferencia),
        }
      : null;
  const notas = texto(mov.notas);
  return {
    ...aMovimientoDetalle(mov, parte.movimiento_id),
    parte: {
      monto_parte: r2(Number(parte.monto_parte) || 0),
      moneda: parte.moneda,
      cruzada: parteCruzada(parte.moneda, gasto.moneda),
      registro: registroDeParte(parte),
    },
    lote,
    justificacion: justificacionVinculoDeCargo(notas, gasto.id),
    notas_oficina: quitarNotasVinculoNoBancario(notas),
  };
}

/** Copia ordenada por fecha del cargo y, en empate, por id del movimiento. */
export function ordenarCargosDeGasto(
  cargos: ReadonlyArray<CargoDeGastoDetalle>,
): CargoDeGastoDetalle[] {
  return [...cargos].sort((a, b) => {
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
 * - CONCILIADO_SIN_CARGOS: marcado conciliado y sin ningún cargo ligado;
 * - ESTADO_DESFASADO: `gasto.conciliado` ≠ `cubierto` de la vista (con
 *   partes);
 * - TC_NO_REGISTRADO: una parte cruzada (USD contra pesos) sin `tc_gasto`;
 * - LOTE_SIN_DETALLE: el detalle de los otros gastos del lote no se leyó.
 */
export function alertasConciliacionGasto(args: {
  conciliado: boolean;
  vista: VistaConciliacionGasto | null;
  cargos: ReadonlyArray<CargoDeGastoDetalle>;
  tcGasto: number | null;
}): AlertaConciliacionGasto[] {
  const out: AlertaConciliacionGasto[] = [];
  if (args.conciliado && args.cargos.length === 0) {
    out.push('CONCILIADO_SIN_CARGOS');
  }
  if (
    args.vista &&
    args.vista.n_partes > 0 &&
    args.conciliado !== args.vista.cubierto
  ) {
    out.push('ESTADO_DESFASADO');
  }
  if (args.tcGasto == null && args.cargos.some((c) => c.parte.cruzada)) {
    out.push('TC_NO_REGISTRADO');
  }
  if (args.cargos.some((c) => c.lote !== null && c.lote.gastos === null)) {
    out.push('LOTE_SIN_DETALLE');
  }
  return out;
}
