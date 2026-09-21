/**
 * ¿SE PUEDE ELIMINAR ESTE MOVIMIENTO DE CARDEX? — cálculo PURO (21-sep-2026).
 *
 * Pedido del cliente: «podemos agregar una opcion para eliminar algunos
 * movimientos, pero que al momento de eliminarlos pida justificacion y
 * sepamos quien lo hizo». El motivo y el autor los guarda la BD
 * (`inventario_movimiento_eliminado`, migración 20260921000001); aquí vive
 * el candado NUMÉRICO, que es el delicado: el stock y los costos FIFO NO se
 * guardan en ninguna columna — se derivan del cardex completo cada vez
 * (`inventario-cardex.util.ts`). Borrar un movimiento reescribe la historia
 * de TODO lo que vino después.
 *
 * Regla (fiabilidad numérica es sagrada): se permite eliminar SOLO si
 *
 *   1. en NINGÚN punto de la cronología la existencia queda negativa, y
 *   2. el costo FIFO recalculado de TODAS las demás salidas queda IGUAL
 *      (tolerancia de medio centavo) — EN LAS DOS MONEDAS: pesos (lo que el
 *      cliente lee) y USD (la canónica del cardex). Con capas USD sin TC el
 *      costo en pesos de toda salida es `null`, así que compararlo solo en
 *      pesos daba «no cambió» aunque el costo pasara de $46 a $9,541 USD —
 *      la forma de 66 de los 75 movimientos de producción.
 *
 * Así, una ENTRADA que el FIFO ya consumió, o una SALIDA intermedia que
 * desplazaría las capas de las salidas posteriores, se BLOQUEA con un
 * mensaje que dice exactamente qué hay que eliminar primero — en vez de
 * mover en silencio el costo que ya viajó a los gastos de un avión.
 *
 * DEVOLUCION y AJUSTE quedan FUERA en esta versión (`TIPO_NO_SOPORTADO`):
 * son correcciones de inventario, y la corrección de una corrección se hace
 * con un movimiento contrario, no borrando el rastro.
 *
 * Sin `this`, sin BD, sin `new Date()`: `fecha_movimiento` ya es día Cancún.
 * La simulación reusa `sortChrono`/`walkCardex` (fuente única del FIFO): NO
 * hay un segundo motor de costos aquí.
 */
import { TipoMovimientoInventario } from './dto/inventory.dto';
import {
  EPS,
  round,
  sortChrono,
  walkCardex,
  type MovForFifo,
} from './inventario-cardex.util';

const SALIDA = TipoMovimientoInventario.SALIDA as string;
const ENTRADA = TipoMovimientoInventario.ENTRADA as string;

/** Medio centavo: dos costos FIFO que difieren menos son EL MISMO costo. */
export const TOLERANCIA_COSTO_FIFO = 0.005;

/** Por qué NO se puede eliminar (lo que calcula este helper). */
export type CodigoBloqueoCardex =
  | 'STOCK_NEGATIVO'
  | 'CAMBIA_COSTO_FIFO'
  | 'TIPO_NO_SOPORTADO';

/**
 * Códigos ESTABLES del 409 (`code` del cuerpo de error): el panel y la app
 * deciden por ellos, nunca por el texto. Los tres de cardex los calcula
 * `evaluarEliminacion`; los otros dos miran el DINERO (compra ligada, gasto
 * conciliado/facturado) y los verifica también la función de BD.
 */
export const CODIGOS_BLOQUEO_ELIMINACION = [
  'MOVIMIENTO_DE_COMPRA',
  'STOCK_NEGATIVO',
  'CAMBIA_COSTO_FIFO',
  'GASTO_BLOQUEADO',
  'TIPO_NO_SOPORTADO',
] as const;

export type CodigoBloqueoEliminacion =
  (typeof CODIGOS_BLOQUEO_ELIMINACION)[number];

/** Códigos que SOLO puede levantar la función de BD (carreras y validación). */
export const CODIGOS_BD_ELIMINACION = [
  'MOVIMIENTO_NO_EXISTE',
  'MOVIMIENTO_DE_OTRO_ITEM',
  'MOTIVO_REQUERIDO',
  'USUARIO_REQUERIDO',
] as const;

export type CodigoBdEliminacion = (typeof CODIGOS_BD_ELIMINACION)[number];

const CODIGOS_CONOCIDOS: readonly string[] = [
  ...CODIGOS_BLOQUEO_ELIMINACION,
  ...CODIGOS_BD_ELIMINACION,
];

/**
 * Código que trae el error de `inventario_eliminar_movimiento`: la función
 * levanta «CODIGO: texto para el usuario» y repite el mismo código, SOLO, en
 * el `hint`. Acepta las dos formas (con y sin el texto detrás) para que el
 * caller pueda preferir el `hint`, que es el dato estructurado.
 * null = un error de BD cualquiera, que el caller debe propagar como 500 —
 * jamás convertirlo en un 409 inventado.
 */
export function codigoDeErrorEliminacion(
  mensaje?: string | null,
): CodigoBloqueoEliminacion | CodigoBdEliminacion | null {
  const m = /^\s*([A-Z_]{4,40})\s*(?::|$)/.exec(mensaje ?? '');
  const codigo = m?.[1];
  return codigo && CODIGOS_CONOCIDOS.includes(codigo)
    ? (codigo as CodigoBloqueoEliminacion | CodigoBdEliminacion)
    : null;
}

/** Texto es-MX del error de BD, sin el prefijo «CODIGO: ». */
export function mensajeDeErrorEliminacion(mensaje?: string | null): string {
  const txt = (mensaje ?? '').trim();
  const m = /^\s*[A-Z_]{4,40}\s*:\s*(.+)$/s.exec(txt);
  return (m?.[1] ?? txt).trim();
}

/**
 * Movimiento del cardex con lo mínimo para simular el FIFO sin él. La
 * matrícula es OPCIONAL: sin ella los mensajes dicen «sin avión», los
 * NÚMEROS no cambian.
 */
export type MovEliminable = MovForFifo & {
  id: string;
  aeronave_matricula?: string | null;
  para_flota?: boolean | null;
};

/** Salida cuyo costo FIFO cambiaría al quitar el movimiento. */
export interface SalidaAfectada {
  id: string;
  fecha: string;
  /** Costo FIFO en MXN hoy; null = capas USD sin TC (no expresable en pesos). */
  costo_antes: number | null;
  costo_despues: number | null;
  /**
   * El MISMO costo en USD (moneda canónica del cardex). ADITIVO y SIEMPRE
   * presente: es el único que distingue dos capas USD sin TC, donde la
   * versión en pesos de las dos es `null`.
   */
  costo_antes_usd: number | null;
  costo_despues_usd: number | null;
}

export interface EvaluacionEliminacion {
  permitido: boolean;
  codigo_bloqueo: CodigoBloqueoCardex | null;
  /** Explicación es-MX lista para el usuario (incluye qué eliminar primero). */
  detalle: string;
  /** Existencia HOY (con el movimiento). */
  stock_antes: number;
  /** Existencia si se elimina. */
  stock_despues: number;
  salidas_afectadas: SalidaAfectada[];
}

/** Migración que crea la bitácora y la función de borrado atómico. */
export const MIGRACION_MOVIMIENTO_ELIMINADO = '20260921000001';

/**
 * ¿El error de PostgREST/Postgres es «esa TABLA no existe»? (migración sin
 * aplicar). Mismo criterio que `esColumnaInexistente`, para una tabla:
 * `42P01` (undefined_table) o `PGRST205` (fuera del schema cache). Con la
 * tabla ausente los LECTORES devuelven vacío y avisan en el log; el borrado
 * responde 503 — jamás un borrado a medias.
 */
export function esTablaInexistente(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('relation') && msg.includes('does not exist')) return true;
  return (
    msg.includes('could not find the table') ||
    (msg.includes('could not find') &&
      msg.includes('table') &&
      msg.includes('schema cache'))
  );
}

// ===== Texto (es-MX) =====

const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/**
 * 'YYYY-MM-DD' → '29 ago 2026'. Corta el string (jamás `new Date`: eso
 * restaría un día en Cancún). Un formato inesperado vuelve tal cual.
 */
export function fechaCardexEsMx(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha ?? '');
  if (!m) return fecha ?? '';
  const mes = MESES[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${mes} ${m[1]}`;
}

/** 10 → «10»; 2.5 → «2.5»; 2.375 → «2.38» (sin ceros de relleno). */
export function cantidadTxt(n: number | string): string {
  const v = round(Number(n), 2);
  return String(v);
}

/** 6633.32 → «$6,633.32». Determinista (sin `toLocaleString`, que depende del ICU). */
export function montoTxt(n: number): string {
  const s = Math.abs(n).toFixed(2);
  const [ent, dec] = s.split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '−' : ''}$${miles}.${dec}`;
}

/** «la SALIDA de 10 del 29 ago 2026 a XA-VGV» (fuente única de los mensajes). */
export function describirMovimiento(m: MovEliminable): string {
  const destino =
    m.tipo === SALIDA
      ? m.para_flota === true
        ? ' a toda la flota'
        : m.aeronave_matricula
          ? ` a ${m.aeronave_matricula}`
          : ''
      : '';
  return `la ${m.tipo} de ${cantidadTxt(m.cantidad)} del ${fechaCardexEsMx(m.fecha_movimiento)}${destino}`;
}

// ===== Simulación =====

/**
 * Existencia corriente paso a paso, con la MISMA aritmética de `walkCardex`
 * (la salida resta su cantidad completa aunque no haya capas: el stock
 * negativo se VE, no se esconde en 0).
 */
function recorrerStock(movs: MovEliminable[]): Array<{
  mov: MovEliminable;
  stock: number;
}> {
  let stock = 0;
  return movs.map((mov) => {
    const cant = Number(mov.cantidad);
    stock = round(mov.tipo === SALIDA ? stock - cant : stock + cant);
    return { mov, stock };
  });
}

/** Dos costos FIFO son el mismo (null = no expresable en esa moneda, en ambos). */
function mismoCosto(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= TOLERANCIA_COSTO_FIFO;
}

/**
 * El costo en la moneda en la que SE PUEDE leer: pesos si las capas lo
 * permiten, si no USD (66 de los 75 movimientos de producción son capas USD
 * sin TC: ahí «$0.00 MXN» sería mentira y `null` no dice nada).
 */
function costoTxt(mxn: number | null, usd: number | null): string {
  if (mxn != null) return `${montoTxt(mxn)} MXN`;
  if (usd != null) return `${montoTxt(usd)} USD`;
  return 'un costo que no se puede expresar';
}

/**
 * ¿Se puede eliminar `movId` del cardex de `movs` (TODOS los movimientos del
 * producto, en cualquier orden)?
 *
 * Lanza si el movimiento no está en la lista: el caller lo lee de la BD
 * antes (404), así que llegar aquí sin él es un error de programación.
 */
export function evaluarEliminacion(
  movs: MovEliminable[],
  movId: string,
): EvaluacionEliminacion {
  const orden = sortChrono(movs);
  const objetivo = orden.find((m) => m.id === movId);
  if (!objetivo) {
    throw new Error(
      `El movimiento ${movId} no está en el cardex del producto: no se puede evaluar su eliminación.`,
    );
  }
  const restantes = orden.filter((m) => m.id !== movId);
  const pasosAntes = recorrerStock(orden);
  const pasosDespues = recorrerStock(restantes);
  const stockAntes = pasosAntes.length
    ? pasosAntes[pasosAntes.length - 1].stock
    : 0;
  const stockDespues = pasosDespues.length
    ? pasosDespues[pasosDespues.length - 1].stock
    : 0;

  const base = {
    stock_antes: stockAntes,
    stock_despues: stockDespues,
  };

  // (1) Tipos soportados: ENTRADA y SALIDA. Una DEVOLUCION/AJUSTE es en sí
  // una corrección — se corrige con otro movimiento, no borrando el rastro.
  if (objetivo.tipo !== SALIDA && objetivo.tipo !== ENTRADA) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'TIPO_NO_SOPORTADO',
      detalle: `Un movimiento de tipo ${objetivo.tipo} no se elimina: corrige con un movimiento contrario (una ${objetivo.tipo === 'DEVOLUCION' ? 'SALIDA' : 'ENTRADA/SALIDA'} que lo compense), así el cardex conserva el rastro completo.`,
      salidas_afectadas: [],
    };
  }

  // (2) La existencia no puede quedar negativa en NINGÚN punto: el primer
  // paso que se iría a negativo nombra lo que hay que eliminar primero.
  const negativo = pasosDespues.find((p) => p.stock < -EPS);
  if (negativo) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'STOCK_NEGATIVO',
      detalle: `Sin ${describirMovimiento(objetivo)} la existencia quedaría en ${cantidadTxt(negativo.stock)} al llegar ${describirMovimiento(negativo.mov)}: elimina primero ${describirMovimiento(negativo.mov)} (y su gasto) y vuelve a intentarlo.`,
      salidas_afectadas: [],
    };
  }

  // (3) Ninguna otra SALIDA puede cambiar de costo FIFO: ese costo ya viajó
  // al gasto del avión (invariante 8) y moverlo aquí descuadraría el mes.
  // Se comparan las DOS monedas: en pesos (lo que el cliente lee) Y en USD
  // (la canónica del cardex). Con capas USD sin TC la versión en pesos de
  // CUALQUIER salida es `null`, así que mirar solo los pesos daba «no
  // cambió» para dos costos tan distintos como $46 y $9,541 USD.
  const antes = walkCardex(orden);
  const despues = walkCardex(restantes);
  const afectadas: SalidaAfectada[] = [];
  for (const m of restantes) {
    if (m.tipo !== SALIDA) continue;
    const pa = antes.get(m.id);
    const pd = despues.get(m.id);
    const a = pa?.costoMxnFifo ?? null;
    const d = pd?.costoMxnFifo ?? null;
    const aUsd = pa?.costoUsdFifo ?? null;
    const dUsd = pd?.costoUsdFifo ?? null;
    if (!mismoCosto(a, d) || !mismoCosto(aUsd, dUsd)) {
      afectadas.push({
        id: m.id,
        fecha: m.fecha_movimiento,
        costo_antes: a,
        costo_despues: d,
        costo_antes_usd: aUsd,
        costo_despues_usd: dUsd,
      });
    }
  }
  if (afectadas.length > 0) {
    const primera = restantes.find((m) => m.id === afectadas[0].id)!;
    const detalleUna = `${describirMovimiento(primera)} pasaría de ${costoTxt(afectadas[0].costo_antes, afectadas[0].costo_antes_usd)} a ${costoTxt(afectadas[0].costo_despues, afectadas[0].costo_despues_usd)}`;
    const otras =
      afectadas.length > 1 ? ` (y ${afectadas.length - 1} salida(s) más)` : '';
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'CAMBIA_COSTO_FIFO',
      detalle: `No se puede eliminar: ${detalleUna}${otras}, y ese costo ya se cargó al avión. Elimina primero esa(s) salida(s) —de la más reciente a la más vieja— y luego este movimiento.`,
      salidas_afectadas: afectadas,
    };
  }

  return {
    ...base,
    permitido: true,
    codigo_bloqueo: null,
    detalle: `Se puede eliminar ${describirMovimiento(objetivo)}: la existencia pasa de ${cantidadTxt(stockAntes)} a ${cantidadTxt(stockDespues)} y ninguna otra salida cambia de costo.`,
    salidas_afectadas: [],
  };
}
