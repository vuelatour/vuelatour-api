/**
 * ¿SE PUEDE ELIMINAR ESTE MOVIMIENTO DE CARDEX? — cálculo PURO (21-sep-2026;
 * regla de costo del 25-sep-2026, API 0.0.36).
 *
 * Pedido del cliente: «podemos agregar una opcion para eliminar algunos
 * movimientos, pero que al momento de eliminarlos pida justificacion y
 * sepamos quien lo hizo». El motivo y el autor los guarda la BD
 * (`inventario_movimiento_eliminado`, migración 20260921000001); aquí vive
 * el candado NUMÉRICO. La existencia NO se guarda en ninguna columna — se
 * deriva del cardex completo cada vez (`inventario-cardex.util.ts`).
 *
 * Regla (fiabilidad numérica es sagrada): se permite eliminar SOLO si en
 * NINGÚN punto de la cronología la existencia queda negativa.
 *
 * El candado del COSTO (`CAMBIA_COSTO_FIFO`) YA NO se emite desde el API
 * 0.0.36: el costo de una salida es el que se GUARDÓ en su fila al
 * registrarla (último precio de compra vigente ese día) y ninguna baja lo
 * mueve — cada salida conserva el costo con que se cobró. El código se
 * conserva en `CODIGOS_BLOQUEO_ELIMINACION` porque un API previo aún podría
 * mandarlo. Lo que SÍ puede cambiar al quitar una ENTRADA es el PRECIO
 * VIGENTE (con el que se valúa la existencia y se cobra la siguiente
 * salida): la evaluación lo informa (`cambia_precio_vigente`) para que el
 * diálogo de confirmación lo diga antes de borrar.
 *
 * DEVOLUCION y AJUSTE quedan FUERA en esta versión (`TIPO_NO_SOPORTADO`):
 * son correcciones de inventario, y la corrección de una corrección se hace
 * con un movimiento contrario, no borrando el rastro.
 *
 * Sin `this`, sin BD, sin `new Date()`: `fecha_movimiento` ya es día Cancún
 * y «hoy» llega como argumento.
 */
import { TipoMovimientoInventario } from './dto/inventory.dto';
import {
  costoVigenteEn,
  EPS,
  fechaCardexEsMx,
  montoTxt,
  precioTxt,
  round,
  salidasQueDependenDe,
  sortChrono,
  type CostoVigente,
  type MovCardex,
} from './inventario-cardex.util';

// Fuente única de los textos (viven en el util del cardex desde el 0.0.36);
// se re-exportan para no romper a quien los importaba de aquí.
export { fechaCardexEsMx, montoTxt };

const SALIDA = TipoMovimientoInventario.SALIDA as string;
const ENTRADA = TipoMovimientoInventario.ENTRADA as string;

/**
 * Medio centavo (se conserva exportada por compatibilidad: desde el 0.0.36
 * ya no hay costo que comparar — cada salida guarda el suyo).
 */
export const TOLERANCIA_COSTO_FIFO = 0.005;

/**
 * Por qué NO se puede eliminar (lo que calcula este helper). `CAMBIA_COSTO_FIFO`
 * ya no lo emite el API 0.0.36; se conserva en el tipo por compatibilidad.
 */
export type CodigoBloqueoCardex =
  | 'STOCK_NEGATIVO'
  | 'CAMBIA_COSTO_FIFO'
  | 'TIPO_NO_SOPORTADO';

/**
 * Códigos ESTABLES del 409 (`code` del cuerpo de error): el panel y la app
 * deciden por ellos, nunca por el texto. Los de cardex los calcula
 * `evaluarEliminacion` (`CAMBIA_COSTO_FIFO` ya no se emite desde el API
 * 0.0.36; se conserva porque un API previo aún podría mandarlo); los otros
 * dos miran el DINERO (compra ligada, gasto conciliado/facturado) y los
 * verifica también la función de BD.
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
 * Movimiento del cardex con lo mínimo para simular la baja. La matrícula es
 * OPCIONAL: sin ella los mensajes dicen «sin avión», los NÚMEROS no cambian.
 * Los campos de venta (`MovCardex`) solo sirven para saber qué salidas se
 * cobraron con el precio de una ENTRADA.
 */
export type MovEliminable = MovCardex & {
  id: string;
  aeronave_matricula?: string | null;
  para_flota?: boolean | null;
};

/**
 * Salida cuyo costo cambiaría al quitar el movimiento. Desde el API 0.0.36
 * `salidas_afectadas` viaja SIEMPRE vacía (el costo de cada salida es el de
 * su fila); el tipo se conserva por compatibilidad.
 */
export interface SalidaAfectada {
  id: string;
  fecha: string;
  /** Costo en MXN (compat ≤ 0.0.35); null = no expresable en pesos. */
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
  /** SIEMPRE [] desde el API 0.0.36 (compat). */
  salidas_afectadas: SalidaAfectada[];
  /** ADITIVOS (0.0.36): último precio de compra hoy, con y sin el movimiento. */
  precio_vigente_antes: CostoVigente | null;
  precio_vigente_despues: CostoVigente | null;
  /** Quitar el movimiento cambia el precio con el que se valúa y se cobra. */
  cambia_precio_vigente: boolean;
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

/** 10 → «10»; 2.5 → «2.5»; 2.375 → «2.38» (sin ceros de relleno). */
export function cantidadTxt(n: number | string): string {
  const v = round(Number(n), 2);
  return String(v);
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

/** «$30.00 USD (5 sep 2026)» — el precio de una compra con su fecha. */
function precioConFecha(c: CostoVigente): string {
  return `${precioTxt(c.unitario, c.moneda)} (${fechaCardexEsMx(c.fecha)})`;
}

/** Dos costos vigentes son el MISMO precio (misma compra o mismo número y moneda). */
function mismoPrecio(a: CostoVigente | null, b: CostoVigente | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.moneda === b.moneda && Math.abs(a.unitario - b.unitario) <= EPS;
}

/**
 * ¿Se puede eliminar `movId` del cardex de `movs` (TODOS los movimientos del
 * producto, en cualquier orden)? `hoy` (día Cancún, YYYY-MM-DD) es el corte
 * del precio vigente; sin él, el último de todos.
 *
 * Lanza si el movimiento no está en la lista: el caller lo lee de la BD
 * antes (404), así que llegar aquí sin él es un error de programación.
 */
export function evaluarEliminacion(
  movs: MovEliminable[],
  movId: string,
  hoy = '9999-12-31',
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
  const precioAntes = costoVigenteEn(orden, { fecha: hoy });
  const precioDespues = costoVigenteEn(restantes, { fecha: hoy });
  const cambiaPrecio = !mismoPrecio(precioAntes, precioDespues);

  const base = {
    stock_antes: stockAntes,
    stock_despues: stockDespues,
    salidas_afectadas: [] as SalidaAfectada[],
    precio_vigente_antes: precioAntes,
    precio_vigente_despues: precioDespues,
    cambia_precio_vigente: cambiaPrecio,
  };

  // (1) Tipos soportados: ENTRADA y SALIDA. Una DEVOLUCION/AJUSTE es en sí
  // una corrección — se corrige con otro movimiento, no borrando el rastro.
  if (objetivo.tipo !== SALIDA && objetivo.tipo !== ENTRADA) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'TIPO_NO_SOPORTADO',
      detalle: `Un movimiento de tipo ${objetivo.tipo} no se elimina: corrige con un movimiento contrario (una ${objetivo.tipo === 'DEVOLUCION' ? 'SALIDA' : 'ENTRADA/SALIDA'} que lo compense), así el cardex conserva el rastro completo.`,
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
    };
  }

  // (3) Ya no hay candado de COSTO: cada salida conserva el costo con que se
  // cobró (guardado en su fila). Se informa lo que SÍ cambia.
  const partes = [
    `Se puede eliminar ${describirMovimiento(objetivo)}: la existencia pasa de ${cantidadTxt(stockAntes)} a ${cantidadTxt(stockDespues)}. Ninguna salida cambia de costo: cada una guarda el costo con que se cobró.`,
  ];
  if (objetivo.tipo === ENTRADA) {
    const deps = salidasQueDependenDe(orden, movId);
    if (deps.length > 0) {
      partes.push(
        `${deps.length} salida(s) se cobraron con el precio de esta compra y conservan su cargo.`,
      );
    }
  }
  if (cambiaPrecio) {
    partes.push(
      precioDespues
        ? `El último precio de compra pasa de ${precioAntes ? precioConFecha(precioAntes) : 'ninguno'} a ${precioConFecha(precioDespues)}: con él se valúa la existencia y se cobra la siguiente salida.`
        : `El producto se queda sin ninguna compra con costo (antes ${precioAntes ? precioConFecha(precioAntes) : 'ninguno'}): la existencia se valúa en $0 y la siguiente salida saldría sin cargo.`,
    );
  }
  return {
    ...base,
    permitido: true,
    codigo_bloqueo: null,
    detalle: partes.join(' '),
  };
}
