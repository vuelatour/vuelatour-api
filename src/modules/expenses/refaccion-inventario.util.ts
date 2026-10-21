/**
 * REFACCIÓN A INVENTARIO/TIENDA desde el alta de gasto (12-oct-2026,
 * invariante 57). Pedido del cliente: «si se selecciona un avión al dar de
 * alta un gasto de un artículo de inventario, una nota visual: entra a
 * inventario pero se asignará/venderá a ese avión, quedando la traza del
 * artículo»; «el gasto asignado directo al avión se va al avión sin cambiar
 * el precio de venta; desde inventario debe pedir precio de venta
 * obligatorio; el gasto REFACCION crea el ítem si no existe».
 *
 * FUENTE ÚNICA (PURA) de: las validaciones del bloque `inventario` del
 * `POST /v1/expenses`, la línea de la compra que se arma con el gasto, los
 * textos de la salida al avión y los AVISOS de cada etapa que pudo fallar.
 * La orquestación (compra → recibir → precio → salida) vive en
 * `ExpensesService.entrarRefaccionAInventario`. Aquí no hay red.
 *
 * DEPRECADO DESDE EL 21-oct-2026 (invariante 101): el panel ya NO manda el
 * bloque `inventario` (el alta de una refacción es un gasto normal; la
 * bodega se alimenta desde Compras: «Registrar gasto», «Vincular gasto ya
 * registrado» y «Entrada desde un gasto»). El bloque sigue aceptado por
 * compatibilidad y este archivo se conserva porque `lineaCompraDeRefaccion`
 * (monto del gasto ÷ unidades) es la fuente única que reutiliza
 * `ComprasService.entradaDesdeGasto`. No agregar funcionalidad al bloque.
 */

export const CATEGORIA_REFACCION = 'REFACCION';

/** Códigos ESTABLES del 400 (el panel decide por ellos, nunca por el texto). */
export const CODIGO_INVENTARIO = {
  SOLO_REFACCION: 'INVENTARIO_SOLO_REFACCION',
  ITEM_REQUERIDO: 'INVENTARIO_ITEM_REQUERIDO',
  AVION_REQUERIDO: 'INVENTARIO_AVION_REQUERIDO',
  MEDIO_BODEGA: 'INVENTARIO_MEDIO_BODEGA',
  CANTIDAD_INVALIDA: 'INVENTARIO_CANTIDAD_INVALIDA',
  PRECIO_INVALIDO: 'INVENTARIO_PRECIO_INVALIDO',
  TC_REQUERIDO: 'INVENTARIO_TC_REQUERIDO',
  SOLO_AL_CREAR: 'INVENTARIO_SOLO_AL_CREAR',
  // Gastos «por pagar» (19-oct-2026, invariante 93, revisión P12).
  FECHA_FUTURA: 'INVENTARIO_FECHA_FUTURA',
} as const;

/**
 * 400 `INVENTARIO_FECHA_FUTURA` (acuerdo entre repos del 19-oct-2026): una
 * refacción con fecha futura queda «por pagar» y su fecha es la del PAGO;
 * la compra, la ENTRADA del cardex, la SALIDA y el cargo de bodega al avión
 * nacían con esa fecha futura (el cargo, en el balance del mes del pago) y
 * no se movían al marcarla pagada. El panel lo previene con el MISMO texto.
 */
export const MENSAJE_INVENTARIO_FECHA_FUTURA =
  'Una refacción con fecha futura queda «por pagar»: guárdala sin entrada a Inventario/Tienda y registra la entrada desde Inventario/Tienda (Compras) el día que llegue la pieza.';

export interface RefaccionInventarioInput {
  item_id?: string | null;
  nombre?: string | null;
  numero_parte?: string | null;
  categoria?: string | null;
  cantidad: number;
  precio_venta: number;
  precio_venta_moneda: 'MXN' | 'USD';
  vender_al_avion?: boolean | null;
}

export interface ErrorRefaccionInventario {
  code: (typeof CODIGO_INVENTARIO)[keyof typeof CODIGO_INVENTARIO];
  message: string;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Validación SÍNCRONA del bloque, ANTES de tocar la BD: solo REFACCION, ítem
 * existente o nombre del nuevo, cantidad > 0, precio de venta ≥ 0 (0 = a
 * costo), «vender al avión» exige avión y un gasto de BODEGA no es una compra.
 * El T.C. (pesos sin `tc_gasto`) se resuelve aparte porque pide el oficial.
 * `hoy` (día Cancún; gastos por pagar, invariante 93): con él, una fecha del
 * gasto posterior ⇒ `INVENTARIO_FECHA_FUTURA`. El servicio lo pasa SOLO con
 * la migración 20261019000001 (sin ella, todo como el 0.0.94).
 */
export function errorRefaccionInventario(
  dto: {
    categoria?: string | null;
    aeronave_id?: string | null;
    medio_pago?: string | null;
    fecha_gasto?: string | null;
  },
  inv: RefaccionInventarioInput,
  hoy?: string | null,
): ErrorRefaccionInventario | null {
  if (dto.categoria !== CATEGORIA_REFACCION) {
    return {
      code: CODIGO_INVENTARIO.SOLO_REFACCION,
      message:
        'Solo una REFACCIÓN entra a Inventario/Tienda: cambia la categoría o quita el bloque de inventario.',
    };
  }
  if (dto.medio_pago === 'BODEGA') {
    return {
      code: CODIGO_INVENTARIO.MEDIO_BODEGA,
      message:
        'Un cargo de bodega no es una compra: captura la refacción con el medio con que se pagó.',
    };
  }
  if (hoy && texto(dto.fecha_gasto).slice(0, 10) > hoy) {
    return {
      code: CODIGO_INVENTARIO.FECHA_FUTURA,
      message: MENSAJE_INVENTARIO_FECHA_FUTURA,
    };
  }
  if (!texto(inv.item_id) && !texto(inv.nombre)) {
    return {
      code: CODIGO_INVENTARIO.ITEM_REQUERIDO,
      message:
        'Elige el artículo de Inventario/Tienda o escribe el nombre del artículo nuevo.',
    };
  }
  if (!(Number(inv.cantidad) > 0)) {
    return {
      code: CODIGO_INVENTARIO.CANTIDAD_INVALIDA,
      message: 'Captura cuántas unidades entran a inventario (mayor a 0).',
    };
  }
  const precio = Number(inv.precio_venta);
  if (!Number.isFinite(precio) || precio < 0) {
    return {
      code: CODIGO_INVENTARIO.PRECIO_INVALIDO,
      message:
        'Captura el precio de venta unitario de la refacción (0 = se cobra a costo).',
    };
  }
  if (inv.vender_al_avion && !texto(dto.aeronave_id)) {
    return {
      code: CODIGO_INVENTARIO.AVION_REQUERIDO,
      message:
        'Para vender la refacción al avión al guardar, elige el avión (o apaga «Vender al avión» y dale salida después desde Inventario/Tienda).',
    };
  }
  return null;
}

export const MENSAJE_TC_REQUERIDO =
  'Refacción en pesos: captura el tipo de cambio del gasto (no hay tipo de cambio oficial para esa fecha) para valorizar la entrada a inventario.';

export const MENSAJE_SOLO_AL_CREAR =
  'La entrada a Inventario/Tienda solo se captura al CREAR el gasto REFACCIÓN: para una pieza ya comprada usa Inventario/Tienda → Compras (o «Crear compra» en el menú del gasto).';

/** Referencia del ítem con la que se arma la línea de la compra. */
export interface ItemRefaccion {
  item_id?: string;
  nombre: string;
  numero_parte?: string;
  categoria?: string;
}

const round = (n: number, d: number) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * UNA línea de compra: el monto TOTAL del gasto entre las unidades (costo de
 * factura unitario, 4 decimales, en la moneda del gasto). Es lo que `recibir`
 * convierte en la ENTRADA del cardex (último precio de compra).
 */
export function lineaCompraDeRefaccion(
  montoGasto: number | string,
  inv: Pick<RefaccionInventarioInput, 'cantidad'>,
  item: ItemRefaccion,
): {
  item_id?: string;
  nombre: string;
  numero_parte?: string;
  categoria?: string;
  cantidad: number;
  costo_unitario: number;
} {
  const cantidad = Number(inv.cantidad);
  const monto = Math.max(0, Number(montoGasto) || 0);
  return {
    ...(item.item_id ? { item_id: item.item_id } : {}),
    nombre: item.nombre.slice(0, 200),
    ...(item.numero_parte
      ? { numero_parte: item.numero_parte.slice(0, 50) }
      : {}),
    ...(item.categoria ? { categoria: item.categoria.slice(0, 50) } : {}),
    cantidad,
    costo_unitario: round(monto / cantidad, 4),
  };
}

export const NOTAS_COMPRA_REFACCION =
  'Refacción capturada desde Gastos: entra a Inventario/Tienda.';

/** «Gasto 3f9a1c2e» — para encontrar la salida desde el cardex. */
export function referenciaSalidaRefaccion(gastoId: string): string {
  return `Gasto ${gastoId.slice(0, 8)}`;
}

export function notasSalidaRefaccion(
  itemNombre: string,
  cantidad: number,
  fechaGasto: string,
): string {
  return `Refacción comprada para el avión (gasto del ${fechaGasto}): ${cantidad} × ${itemNombre}, vendida al avión al registrarla.`;
}

// ===== Resultado y avisos por etapa (el gasto YA quedó: nunca se borra) =====

export type EtapaInventarioFallida =
  | 'NO_DISPONIBLE'
  | 'ITEM'
  | 'COMPRA'
  | 'RECIBIR'
  | 'SALIDA';

export interface RefaccionInventarioResultado {
  item_id: string | null;
  item_nombre: string | null;
  /** true = el artículo no existía y se creó al recibir la compra. */
  item_creado: boolean;
  compra_id: string | null;
  compra_folio: number | null;
  entrada_id: string | null;
  /** true = el precio de venta quedó en la ficha del artículo. */
  precio_venta_guardado: boolean;
  /** La SALIDA al avión (gasto de bodega del avión), si se pidió y se hizo. */
  salida: {
    movimiento_id: string;
    gasto_id: string | null;
    monto: number;
    moneda: string;
  } | null;
  /** Etapa que falló (null = todo bien). Lo que sí se hizo queda arriba. */
  error: EtapaInventarioFallida | null;
  /** Qué pasó y qué hacer, en palabras del operador (uno por etapa). */
  avisos: string[];
}

export function resultadoVacio(): RefaccionInventarioResultado {
  return {
    item_id: null,
    item_nombre: null,
    item_creado: false,
    compra_id: null,
    compra_folio: null,
    entrada_id: null,
    precio_venta_guardado: false,
    salida: null,
    error: null,
    avisos: [],
  };
}

export function mensajeDe(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = (e as { getResponse?: () => unknown }).getResponse?.();
    if (r && typeof r === 'object' && 'message' in r) {
      const m = (r as { message?: unknown }).message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m)) return m.join('; ');
    }
    if (
      'message' in e &&
      typeof (e as { message?: unknown }).message === 'string'
    ) {
      return (e as { message: string }).message;
    }
  }
  return String(e);
}

const folioTxt = (folio: number | null) => (folio != null ? `#${folio}` : '');

export const AVISO_INVENTARIO_NO_DISPONIBLE =
  'El gasto quedó registrado, pero este servidor no tiene habilitada la entrada a Inventario/Tienda: desde el menú ⋯ del gasto usa «Crear compra» y recíbela.';

export function avisoItemNoExiste(itemId: string): string {
  return `El gasto quedó registrado, pero el artículo elegido (${itemId.slice(0, 8)}…) ya no existe en Inventario/Tienda: desde el menú ⋯ del gasto usa «Crear compra» y elige o crea el artículo al recibirla.`;
}

export function avisoCompraNoCreada(motivo: string): string {
  return `El gasto quedó registrado, pero NO entró a Inventario/Tienda (${motivo}). Desde el menú ⋯ del gasto usa «Crear compra» y recíbela.`;
}

export function avisoCompraNoRecibida(
  folio: number | null,
  motivo: string,
): string {
  return `El gasto quedó registrado y su compra ${folioTxt(folio)} quedó ABIERTA (${motivo}): recíbela desde Inventario/Tienda → Compras para que la pieza entre a bodega.`;
}

export function avisoPrecioNoGuardado(motivo: string): string {
  return `La pieza entró a bodega, pero el precio de venta no se guardó en la ficha del artículo (${motivo}): corrígelo en Inventario/Tienda.`;
}

export function avisoSalidaNoHecha(
  folio: number | null,
  motivo: string,
): string {
  return `La pieza entró a bodega (compra ${folioTxt(folio)}), pero NO se vendió al avión (${motivo}): dale salida desde Inventario/Tienda → el artículo → Registrar movimiento.`;
}
