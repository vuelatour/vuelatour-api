/**
 * ¿SE PUEDE CORREGIR LA CANTIDAD DE ESTA ENTRADA? — cálculo PURO (27-nov-2026,
 * API 0.0.152, invariante 146).
 *
 * Pedido de la oficina (Jimmy, WhatsApp 27-nov-2026, con la captura del
 * cardex del aceite 15W-50): «me podrían habilitar poder editar movimientos
 * en el inventario … este por error de dedo puse 13, pero ingresaron 12».
 * Hasta hoy la única salida era ELIMINAR la entrada (solo ADMIN, con
 * justificación) y volver a capturarla; quien no lo sabía registraba un
 * AJUSTE de 1 «para quitar» la pieza de más — y el ajuste SUMA: la existencia
 * quedaba dos piezas arriba en vez de cuadrar.
 *
 * Regla (la misma del candado de la baja, `evaluarEliminacion`): la
 * existencia NO se guarda — se deriva del cardex completo — así que la
 * corrección se permite SOLO si en NINGÚN punto de la cronología la
 * existencia queda negativa con la cantidad nueva. Subir la cantidad nunca
 * puede dejarla negativa; bajarla sí (si ya salieron piezas que dependían de
 * las que se quitan).
 *
 * Solo ENTRADA. Una SALIDA lleva dinero (su gasto al avión, uno por
 * matrícula si fue repartida): se corrige eliminándola con justificación y
 * capturándola de nuevo. DEVOLUCION, AJUSTE y TRASPASO tampoco se editan.
 *
 * Sin `this`, sin BD, sin `new Date()`.
 */
import { TipoMovimientoInventario } from './dto/inventory.dto';
import {
  cantidadTxt,
  describirMovimiento,
  recorrerStock,
  type MovEliminable,
} from './eliminar-movimiento.util';
import { EPS, round, sortChrono } from './inventario-cardex.util';

const ENTRADA = TipoMovimientoInventario.ENTRADA as string;

/** Por qué NO se puede corregir la cantidad (códigos estables del 409/400). */
export type CodigoBloqueoCantidad =
  | 'TIPO_NO_SOPORTADO'
  | 'SIN_CAMBIO'
  | 'STOCK_NEGATIVO';

export interface EvaluacionCantidad {
  permitido: boolean;
  codigo_bloqueo: CodigoBloqueoCantidad | null;
  /** Explicación es-MX lista para el usuario. */
  detalle: string;
  cantidad_antes: number;
  cantidad_despues: number;
  /** Existencia HOY (con la cantidad actual). */
  stock_antes: number;
  /** Existencia con la cantidad corregida. */
  stock_despues: number;
}

/**
 * ¿Se puede dejar `movId` en `nueva` unidades dentro del cardex de `movs`
 * (TODOS los movimientos del producto, en cualquier orden)?
 *
 * Lanza si el movimiento no está en la lista: el caller lo lee de la BD
 * antes (404), así que llegar aquí sin él es un error de programación.
 */
export function evaluarCambioCantidad(
  movs: MovEliminable[],
  movId: string,
  nueva: number,
): EvaluacionCantidad {
  const orden = sortChrono(movs);
  const objetivo = orden.find((m) => m.id === movId);
  if (!objetivo) {
    throw new Error(
      `El movimiento ${movId} no está en el cardex del producto: no se puede evaluar el cambio de cantidad.`,
    );
  }
  const antes = round(Number(objetivo.cantidad), 2);
  const despues = round(Number(nueva), 2);
  const corregidos = orden.map((m) =>
    m.id === movId ? { ...m, cantidad: despues } : m,
  );
  const pasosAntes = recorrerStock(orden);
  const pasosDespues = recorrerStock(corregidos);
  const stockAntes = pasosAntes.length
    ? pasosAntes[pasosAntes.length - 1].stock
    : 0;
  const stockDespues = pasosDespues.length
    ? pasosDespues[pasosDespues.length - 1].stock
    : 0;
  const base = {
    cantidad_antes: antes,
    cantidad_despues: despues,
    stock_antes: stockAntes,
    stock_despues: stockDespues,
  };

  if (objetivo.tipo !== ENTRADA) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'TIPO_NO_SOPORTADO',
      detalle:
        objetivo.tipo === (TipoMovimientoInventario.SALIDA as string)
          ? 'La cantidad de una SALIDA no se corrige aquí porque ya generó su cargo al avión: elimínala (con su justificación) y captúrala de nuevo con la cantidad correcta.'
          : `La cantidad de un movimiento de tipo ${objetivo.tipo} no se corrige: solo las ENTRADAS.`,
    };
  }
  if (!(despues > 0)) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'SIN_CAMBIO',
      detalle:
        'La cantidad correcta debe ser mayor a 0. Si la entrada no existió, elimínala (con su justificación).',
    };
  }
  if (Math.abs(despues - antes) <= EPS) {
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'SIN_CAMBIO',
      detalle: `La entrada ya tiene ${cantidadTxt(antes)}: no hay nada que corregir.`,
    };
  }

  // La existencia no puede quedar negativa en NINGÚN punto: el primer paso
  // que se iría a negativo dice hasta dónde se puede bajar.
  const negativo = pasosDespues.find((p) => p.stock < -EPS);
  if (negativo) {
    // Lo más que se puede bajar sin dejar a nadie en negativo: la cantidad
    // actual menos el mínimo de la existencia desde este movimiento.
    const idx = orden.findIndex((m) => m.id === movId);
    const minimoDesde = Math.min(...pasosAntes.slice(idx).map((p) => p.stock));
    const minimaPosible = round(Math.max(antes - minimoDesde, 0), 2);
    return {
      ...base,
      permitido: false,
      codigo_bloqueo: 'STOCK_NEGATIVO',
      detalle: `Con ${cantidadTxt(despues)} en vez de ${cantidadTxt(antes)} la existencia quedaría en ${cantidadTxt(negativo.stock)} al llegar ${describirMovimiento(negativo.mov)}: de esta entrada ya salieron piezas. Lo menos que puede quedar es ${cantidadTxt(minimaPosible)}.`,
    };
  }

  return {
    ...base,
    permitido: true,
    codigo_bloqueo: null,
    detalle: `Se puede corregir ${describirMovimiento(objetivo)}: queda en ${cantidadTxt(despues)} y la existencia pasa de ${cantidadTxt(stockAntes)} a ${cantidadTxt(stockDespues)}. El costo unitario no cambia y ninguna salida cambia de costo.`,
  };
}

/** Día Cancún `YYYY-MM-DD` ⇒ `DD/MM/AAAA` (formato del panel desde el 6-nov-2026). */
function fechaDdMmAaaa(dia: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : dia;
}

/**
 * Nota que se AGREGA al movimiento corregido: el dato anterior no se pierde
 * en silencio y se sabe quién y cuándo. `presentacion` = «2 × Caja» cuando la
 * entrada se capturó por empaque (ese desglose deja de aplicar).
 */
export function notaCantidadCorregida(p: {
  hoy: string;
  quien: string | null;
  antes: number;
  despues: number;
  presentacion?: string | null;
  motivo?: string | null;
}): string {
  const quien = p.quien?.trim() ? ` por ${p.quien.trim()}` : '';
  const antes = `${cantidadTxt(p.antes)}${p.presentacion ? ` (${p.presentacion})` : ''}`;
  const motivo = p.motivo?.trim() ? `: ${p.motivo.trim()}` : '';
  return `Cantidad corregida ${fechaDdMmAaaa(p.hoy)}${quien}: antes ${antes}, ahora ${cantidadTxt(p.despues)}${motivo}`;
}
