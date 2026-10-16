/**
 * «¿EN QUÉ LIBRO Y EN QUÉ MES VIVE ESTE GASTO?» (13-oct-2026, API 0.0.75,
 * invariante 72). PURO y FUENTE ÚNICA: lo usa Conciliación para el campo
 * `balance` de cada gasto ligado (enlaces «Ver en balance del avión …» y
 * «Ver en balance general» que abren el libro EN LA CELDA del gasto).
 *
 * Es ESPEJO de `aircraft/aircraft-balance.service.ts` (los libros), no una
 * regla nueva: cada caso cita la consulta o la regla del libro que imita.
 *  - Libro del AVIÓN (`buildPayload(avión)`): vuelos del mes por
 *    `fecha_vuelo` (día Cancún) propios + compartidos (tramo VIVO del avión)
 *    + con tramo cancelado y gastos ligados a él; sus gastos `.in('vuelo_id',
 *    vueloIds)` y, en la fila, solo los de `avionDelGasto === avión` —
 *    saltando PERMISO/INDIRECTO/GAS y `CAT_FUERA_DEL_AVION`; gastos SIN
 *    vuelo del avión por `fecha_gasto`; GAS de toda la flota por
 *    `fecha_gasto` resuelto con `avionDelGasto`; parciales del reparto
 *    manual por la `fecha_gasto` del padre (`parcialEntraAlAvion`); hojas:
 *    «Gastos Indirectos» (fusión de `gastos_indirectos` + `otros_gastos`),
 *    «refacciones» (`inventario_movimiento_id`), «permisos», «combustible».
 *  - Libro EXTERNOS (`buildPayload(null)`, solo dentro del general): los
 *    vuelos `es_externo` sin avión con TODOS sus gastos; su GAS `.is(
 *    'aeronave_id', null)` sin filtro de `fecha_gasto`.
 *  - GENERAL (`payloadGeneral` + `construir_balance_general` de pyservices):
 *    «reporte horas FLOTA» (las filas de todos los libros), «combustible»,
 *    «otros gastos» (`gastosEmpresaYSueltos`: categorías de EMPRESA con o
 *    sin vuelo + sueltos sin vuelo ni avión salvo PERSONAL_DUENO y GAS;
 *    remanente del reparto), «repartidos a aviones» (parciales no
 *    INDIRECTO/NOMINA) e «inventario» (bloque 2 = refacciones). NO pinta
 *    «Gastos Indirectos» ni «permisos».
 * `hoja_general` es la PRIMERA hoja del general donde aparece el gasto.
 * Mover una categoría de hoja o de eje en el libro obliga a tocar este
 * archivo: la alarma de paridad de su spec lee el servicio como texto.
 */
import {
  avionDeGastoEmbebido,
  esVueloExternoSinAvion,
  PARCIAL_A_INDIRECTOS,
  parcialEntraAlAvion,
  vueloEmbebido,
} from './hojas-balance.util';
import {
  CATEGORIAS_GASTO_EMPRESA,
  categoriaEsPagoVendedor,
} from './categoria-gasto.util';
import { CATEGORIAS_REPARTIBLES } from './gasto-reparto.util';
import { mesCalendarioDe } from './fecha-cancun.util';
import { diaContableDeVuelo } from './fecha-contable.util';

type EscalaEmb = { aeronave_id?: string | null };
type VueloEmb = {
  fecha_vuelo?: string | null;
  /** Cierre de mes (invariante 89): con la migración, el eje del dinero. */
  periodo_contable?: string | null;
  fecha_contable?: string | null;
  aeronave_id?: string | null;
  es_externo?: boolean | null;
};

/** El gasto con lo mínimo para ubicarlo (`GASTO_UBICACION_COLS`). */
export interface GastoParaUbicacion {
  id: string;
  categoria: string | null;
  fecha_gasto: string | null;
  monto: number | string | null;
  vuelo_id: string | null;
  aeronave_id: string | null;
  escala_id?: string | null;
  inventario_movimiento_id?: string | null;
  escala?: EscalaEmb | EscalaEmb[] | null;
  vuelo?: VueloEmb | VueloEmb[] | null;
  /**
   * Aviones con un tramo VIVO en el vuelo (solo para los gastos que
   * `necesitaTramosVivos`). Arreglo ⇒ se verifica; ausente ⇒ no se pudo
   * leer y no se verifica.
   */
  aviones_con_tramo_vivo?: readonly string[] | null;
}

/** Una parte del reparto manual (`gasto_reparto`). */
export interface RepartoDeGasto {
  aeronave_id: string;
  monto: number;
}

/** Hoja del libro del AVIÓN (informativo). */
export type HojaLibroAvion =
  | 'reporte_horas'
  | 'combustible'
  | 'gastos_indirectos'
  | 'refacciones'
  | 'permisos';

/** PRIMERA hoja del GENERAL donde aparece (informativo). */
export type HojaLibroGeneral =
  | 'reporte_horas'
  | 'combustible'
  | 'otros_gastos'
  | 'repartidos'
  | 'inventario';

/**
 * Dónde vive el gasto. Invariantes: `aviones.length > 0 ⇔ hoja_avion !=
 * null` y `general ⇔ hoja_general != null`; si no vive en ningún libro la
 * función devuelve null (jamás un enlace que termine en «no está»).
 */
export interface UbicacionBalanceGasto {
  periodo: { desde: string; hasta: string };
  eje: 'vuelo' | 'gasto';
  aviones: string[];
  general: boolean;
  hoja_avion: HojaLibroAvion | null;
  hoja_general: HojaLibroGeneral | null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

const CATEGORIA_TUAS = 'TUAS';

/**
 * ¿Hay que saber qué aviones tienen un tramo VIVO en el vuelo? Un gasto de
 * vuelo SIN tramo y sellado a un avión distinto del del vuelo vive en el
 * libro de ese avión SOLO si el avión voló un tramo (vivo) del vuelo
 * (`escalasAjenas` del libro); si no, ningún libro lo cuenta (caso #255:
 * OPERACIONES de XA-VGV sellada a N4142R sin tramo ⇒ `balance: null`).
 * Incluye el vuelo SIN avión (aún sin asignar): el sellado solo vive en un
 * libro por un tramo. No aplica a lo que se ubica antes de la fila del vuelo
 * (GAS, PERSONAL_DUENO, pago al vendedor, EMPRESA) ni a EXTERNOS sin avión.
 */
export function necesitaTramosVivos(g: GastoParaUbicacion): boolean {
  const cat = g.categoria ?? '';
  if (
    cat === 'GAS' ||
    cat === 'PERSONAL_DUENO' ||
    categoriaEsPagoVendedor(cat) ||
    CATEGORIAS_GASTO_EMPRESA.has(cat)
  ) {
    return false;
  }
  if (!g.vuelo_id || g.escala_id || !g.aeronave_id) return false;
  const vuelo = vueloEmbebido(g as unknown as Record<string, unknown>);
  if (!vuelo || esVueloExternoSinAvion(vuelo)) return false;
  return g.aeronave_id !== ((vuelo.aeronave_id as string | null) ?? null);
}

function armar(
  eje: 'vuelo' | 'gasto',
  dia: string | null,
  aviones: string[],
  hojaAvion: HojaLibroAvion | null,
  hojaGeneral: HojaLibroGeneral | null,
): UbicacionBalanceGasto | null {
  if (!dia) return null;
  const conAvion = aviones.length > 0 && hojaAvion != null;
  if (!conAvion && hojaGeneral == null) return null;
  return {
    periodo: mesCalendarioDe(dia),
    eje,
    aviones: conAvion ? aviones : [],
    general: hojaGeneral != null,
    hoja_avion: conAvion ? hojaAvion : null,
    hoja_general: hojaGeneral,
  };
}

function ubicar(
  g: GastoParaUbicacion,
  repartos: ReadonlyArray<RepartoDeGasto>,
): UbicacionBalanceGasto | null {
  const cat = g.categoria ?? '';
  const crudo = g as unknown as Record<string, unknown>;
  const conVuelo = typeof g.vuelo_id === 'string' && g.vuelo_id !== '';
  const diaGasto =
    typeof g.fecha_gasto === 'string' && g.fecha_gasto
      ? g.fecha_gasto.slice(0, 10)
      : null;
  const vuelo = vueloEmbebido(crudo);
  // MES CONTABLE del vuelo (16-oct-2026, invariante 89): un vuelo DIFERIDO
  // al cerrar un mes vive (con todos sus gastos de eje vuelo) en el mes
  // destino — `fecha_contable` cuando el embed la trae; sin la migración,
  // `fecha_vuelo` como siempre. Fuente única `diaContableDeVuelo`.
  const diaVuelo = diaContableDeVuelo(vuelo);

  // R1: el gasto personal del dueño no es dinero de la empresa.
  if (cat === 'PERSONAL_DUENO') return null;
  // R2: las DOS categorías del pago al vendedor (invariantes 31 y 61)
  // restan en COMISIONES o en «otros movimientos»: celdas sin vínculos.
  if (categoriaEsPagoVendedor(cat)) return null;
  // R3: GAS (hoja «combustible»; eje fecha_gasto con `avionDelGasto`).
  if (cat === 'GAS') {
    const avion = avionDeGastoEmbebido(crudo);
    if (avion) {
      return armar('gasto', diaGasto, [avion], 'combustible', 'combustible');
    }
    // GAS de un EXTERNO sin avión: sigue al VUELO (sin filtro de fecha).
    if (conVuelo && esVueloExternoSinAvion(vuelo)) {
      return armar('vuelo', diaVuelo, [], null, 'combustible');
    }
    return null; // gas sin avión: pendiente del general, ningún libro
  }
  // R4: REPARTO MANUAL (gana sobre el avión sellado y la categoría).
  if (
    repartos.length > 0 &&
    CATEGORIAS_REPARTIBLES.has(cat) &&
    parcialEntraAlAvion(g)
  ) {
    const aviones = [
      ...new Set(repartos.map((r) => r.aeronave_id).filter(Boolean)),
    ];
    const asignado = repartos.reduce((a, r) => a + (Number(r.monto) || 0), 0);
    const remanente = round2((Number(g.monto) || 0) - asignado);
    // El remanente vive en «otros gastos» solo si la lectura de
    // `gastosEmpresaYSueltos` trae al gasto: EMPRESA (con o sin vuelo) o
    // suelto sin vuelo ni avión.
    const leidoComoEmpresa =
      CATEGORIAS_GASTO_EMPRESA.has(cat) || (!conVuelo && !g.aeronave_id);
    const hojaGeneral: HojaLibroGeneral | null =
      remanente > 0 && leidoComoEmpresa
        ? 'otros_gastos'
        : !PARCIAL_A_INDIRECTOS.has(cat)
          ? 'repartidos'
          : null;
    return armar('gasto', diaGasto, aviones, 'gastos_indirectos', hojaGeneral);
  }
  // R5: LA CATEGORÍA DE EMPRESA MANDA (aunque traiga vuelo o avión).
  if (CATEGORIAS_GASTO_EMPRESA.has(cat)) {
    return armar('gasto', diaGasto, [], null, 'otros_gastos');
  }
  // R6: con vuelo ⇒ el libro del mes del VUELO.
  if (conVuelo) {
    if (!vuelo || !diaVuelo) return null;
    if (esVueloExternoSinAvion(vuelo)) {
      // EXTERNOS solo se pinta dentro del general, que no lleva «permisos»
      // ni «Gastos Indirectos».
      if (cat === 'PERMISO' || cat === 'INDIRECTO') return null;
      return armar('vuelo', diaVuelo, [], null, 'reporte_horas');
    }
    const avion = avionDeGastoEmbebido(crudo);
    if (!avion) return null;
    if (
      necesitaTramosVivos(g) &&
      Array.isArray(g.aviones_con_tramo_vivo) &&
      !g.aviones_con_tramo_vivo.includes(avion)
    ) {
      return null; // hueco del libro (caso #255): no cuenta en ninguno
    }
    if (cat === 'PERMISO') {
      return armar('vuelo', diaVuelo, [avion], 'permisos', null);
    }
    if (cat === 'INDIRECTO') {
      return g.inventario_movimiento_id
        ? armar('vuelo', diaVuelo, [avion], 'refacciones', 'inventario')
        : armar('vuelo', diaVuelo, [avion], 'gastos_indirectos', null);
    }
    // TUAS (nota), REFACCION, COMISARIATO y cualquier categoría futura: la
    // fila del vuelo (OPERACIONES / PILOTO / OTROS).
    return armar('vuelo', diaVuelo, [avion], 'reporte_horas', 'reporte_horas');
  }
  // R7: sin vuelo ⇒ el libro del mes del GASTO.
  if (cat === CATEGORIA_TUAS) return null; // solo «otros movimientos»
  if (g.aeronave_id) {
    if (cat === 'PERMISO') {
      return armar('gasto', diaGasto, [g.aeronave_id], 'permisos', null);
    }
    return g.inventario_movimiento_id
      ? armar('gasto', diaGasto, [g.aeronave_id], 'refacciones', 'inventario')
      : armar('gasto', diaGasto, [g.aeronave_id], 'gastos_indirectos', null);
  }
  return armar('gasto', diaGasto, [], null, 'otros_gastos');
}

/**
 * Dónde vive el gasto (reglas R1–R8 de la invariante 72; R8 = el periodo es
 * el mes calendario de la fecha del eje). Nunca lanza: una fecha ilegible o
 * un dato raro ⇒ null (sin enlace).
 */
export function ubicacionBalanceDeGasto(
  g: GastoParaUbicacion,
  repartos: ReadonlyArray<RepartoDeGasto> = [],
): UbicacionBalanceGasto | null {
  try {
    return ubicar(g, repartos);
  } catch {
    return null;
  }
}
