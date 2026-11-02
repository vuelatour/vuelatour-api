/**
 * SEMÁFORO DE FACTURACIÓN DEL GASTO (`gasto.estatus_facturacion`) —
 * seguimiento de OFICINA, independiente del comprobante que entregó el
 * piloto (`comprobante.util.ts`).
 *
 * Valores (migración `20260814000001`, ampliada por `20260914000002`):
 *
 *  - `PENDIENTE`     🔴 aún no se pide la factura al proveedor (default).
 *  - `SOLICITADA`    🟡 pedida, esperando que llegue.
 *  - `FACTURADA`     🟢 factura en mano (la pone sola el amarre de una
 *                       `factura_recibida`, vía trigger `gasto_sync_facturacion`).
 *  - `NO_FACTURABLE` ⚪ **No requiere factura** (pedido del cliente,
 *                       14-sep-2026): propinas, cuotas sin comprobante
 *                       fiscal, gastos que nadie va a facturar jamás. NO es
 *                       «ya se facturó» y NO es «falta facturar»: es un
 *                       tercer cubo que sale del pendiente del pre-cierre y
 *                       del filtro «por facturar» sin mentir en ninguno.
 *
 * FUENTE ÚNICA del API: filtro de la lista, pre-cierre y Excel leen de aquí
 * (`vuelatour-next/src/components/admin/expenses/facturacion-badge.tsx` es
 * el espejo del panel; paridad manual).
 */

export const ESTATUS_FACTURACION = [
  'PENDIENTE',
  'SOLICITADA',
  'FACTURADA',
  'NO_FACTURABLE',
  'NO_OBTENIDA',
] as const;

export type EstatusFacturacionValor = (typeof ESTATUS_FACTURACION)[number];

/** Etiquetas es-MX — espejo de FACTURACION_ESTADOS del panel. */
export const FACTURACION_LABEL: Record<string, string> = {
  PENDIENTE: 'Pendiente',
  SOLICITADA: 'Solicitada',
  FACTURADA: 'Facturada',
  NO_FACTURABLE: 'No requiere factura',
  NO_OBTENIDA: 'No obtenida',
};

/**
 * Estatus que SÍ están "por facturar" — lo que busca el filtro
 * `NO_FACTURADA` y lo que cuenta el pre-cierre. `NO_FACTURABLE` queda
 * FUERA a propósito: no falta nada por hacer con él.
 */
export const ESTATUS_POR_FACTURAR: readonly string[] = [
  'PENDIENTE',
  'SOLICITADA',
];

/** Etiqueta amable; un código desconocido se devuelve tal cual. */
export function etiquetaFacturacion(
  estatus: string | null | undefined,
): string {
  const codigo = (estatus ?? '').trim();
  if (!codigo) return '';
  return FACTURACION_LABEL[codigo] ?? codigo;
}

/** ¿Falta facturarlo? (pendiente o solicitada). */
export function estaPorFacturar(estatus: string | null | undefined): boolean {
  return ESTATUS_POR_FACTURAR.includes((estatus ?? '').trim());
}

/** ¿El cliente decidió que este gasto no lleva factura? */
export function esNoFacturable(estatus: string | null | undefined): boolean {
  return (estatus ?? '').trim() === 'NO_FACTURABLE';
}

/**
 * «NO OBTENIDA / no emitida» 🟣 (2-nov-2026, invariante 115, migración
 * `20261102000001`): se pidió la factura y el proveedor no la emitió (o no
 * se pudo obtener). Lleva SIEMPRE el motivo (`gasto.facturacion_nota`).
 * Como NO_FACTURABLE sale de «por facturar» y del pendiente del pre-cierre
 * (ya no hay nada que perseguir), pero NO es «no requiere»: en el reporte de
 * efectivos es su propio cubo («no obtenida»).
 */
export function esNoObtenida(estatus: string | null | undefined): boolean {
  return (estatus ?? '').trim() === 'NO_OBTENIDA';
}

/**
 * Cubo del reporte de EFECTIVOS del Excel (fuente única): facturado /
 * POR FACTURAR / no facturable / no obtenida. Meter el ⚪ o el 🟣 en otro
 * cubo sería una cifra falsa.
 */
export function cuboFacturacionEfectivo(
  estatus: string | null | undefined,
): 'facturado' | 'POR FACTURAR' | 'no facturable' | 'no obtenida' {
  const e = (estatus ?? '').trim();
  if (e === 'FACTURADA') return 'facturado';
  if (esNoFacturable(e)) return 'no facturable';
  if (esNoObtenida(e)) return 'no obtenida';
  return 'POR FACTURAR';
}

/**
 * Traducción del filtro de la lista de gastos a una condición de PostgREST.
 *
 *  - `NO_FACTURADA` (meta-valor del link del pre-cierre) → `in
 *    (PENDIENTE, SOLICITADA)`. **Ya NO es `!= FACTURADA`**: con ese `neq`
 *    los `NO_FACTURABLE` caían en la bandeja de "falta por facturar" y el
 *    conteo del pre-cierre no cuadraba con la lista.
 *  - Cualquier otro valor → igualdad exacta.
 *  - Vacío → `null` (sin filtro).
 */
export function filtroFacturacion(
  valor: string | null | undefined,
):
  | { op: 'in'; valores: readonly string[] }
  | { op: 'eq'; valor: string }
  | null {
  const v = (valor ?? '').trim();
  if (!v) return null;
  if (v === 'NO_FACTURADA') return { op: 'in', valores: ESTATUS_POR_FACTURAR };
  return { op: 'eq', valor: v };
}

/**
 * Gasto que el PRE-CIERRE cuenta como "sin facturar".
 *
 * Fuera quedan, por reglas ya vigentes: `medio_pago = BODEGA` (cargo
 * contable del cardex: su factura vive en la ENTRADA del inventario) y
 * `categoria = PERSONAL_DUENO` (gasto del dueño, no de la empresa). Desde
 * el 14-sep-2026 también `NO_FACTURABLE`: la oficina ya dijo que ese gasto
 * no lleva factura, dejarlo sería ruido eterno en el checklist.
 */
export function cuentaComoSinFacturar(g: {
  estatus_facturacion?: unknown;
  medio_pago?: unknown;
  categoria?: unknown;
}): boolean {
  const estatus =
    typeof g.estatus_facturacion === 'string' ? g.estatus_facturacion : '';
  if (
    estatus === 'FACTURADA' ||
    esNoFacturable(estatus) ||
    // NO_OBTENIDA (2-nov-2026): la oficina ya dijo que no la emitieron;
    // seguir contándola sería ruido eterno en el checklist.
    esNoObtenida(estatus)
  ) {
    return false;
  }
  if (g.medio_pago === 'BODEGA') return false;
  if (g.categoria === 'PERSONAL_DUENO') return false;
  return true;
}

/**
 * Mensaje del 400 cuando se intenta guardar `NO_FACTURABLE` y la migración
 * `20260914000002` todavía no está aplicada en esa base.
 */
export const MENSAJE_NO_FACTURABLE_SIN_MIGRACION =
  'Esta opción necesita la migración 20260914000002; mientras, usa Pendiente.';

/**
 * TOLERANCIA a la migración no aplicada: el CHECK viejo de
 * `estatus_facturacion` rechaza `NO_FACTURABLE` con el código 23514. Sin
 * esto el panel recibía un 409 genérico («no cumple una regla de la base de
 * datos») o, peor, un 500 que dispara el reintento del outbox.
 *
 * Se exige que el valor ENVIADO haya sido `NO_FACTURABLE`: así un CHECK
 * distinto (medio↔tarjeta, propina, monto) sigue por su camino de siempre.
 * Solo se mira `message` — `details` trae la FILA que falló y podría
 * contener la palabra `NO_FACTURABLE` de un gasto que ya la tenía.
 */
export function mensajeNoFacturableSinMigracion(
  error: { code?: string | null; message?: string | null },
  valorEnviado: string | null | undefined,
): string | null {
  if (!esNoFacturable(valorEnviado)) return null;
  if (error.code !== '23514') return null;
  if (!/estatus_facturacion/.test(error.message ?? '')) return null;
  return MENSAJE_NO_FACTURABLE_SIN_MIGRACION;
}

/** Migración que admite `NO_OBTENIDA` y crea `gasto.facturacion_nota`. */
export const MIGRACION_NO_OBTENIDA = '20261102000001';

/** 400 cuando se pide `NO_OBTENIDA` (o una nota) sin la migración. */
export const MENSAJE_NO_OBTENIDA_SIN_MIGRACION =
  'Esta opción necesita la migración 20261102000001; mientras, usa Pendiente.';

/** 400 al marcar `NO_OBTENIDA` sin el motivo. */
export const MENSAJE_FACTURACION_NOTA_REQUERIDA =
  'Escribe el motivo por el que no se obtuvo la factura (de 1 a 500 caracteres).';

/** Largo máximo del motivo (CHECK de la BD). */
export const FACTURACION_NOTA_MAX = 500;

/**
 * Generaliza `mensajeNoFacturableSinMigracion` a los dos valores que
 * dependen de una migración del CHECK (23514 con `estatus_facturacion` en
 * el mensaje): NO_FACTURABLE ⇒ 20260914000002; NO_OBTENIDA ⇒ 20261102000001.
 * null = no es ese caso (sigue el camino de siempre).
 */
export function mensajeEstatusSinMigracion(
  error: { code?: string | null; message?: string | null },
  valorEnviado: string | null | undefined,
): string | null {
  const viejo = mensajeNoFacturableSinMigracion(error, valorEnviado);
  if (viejo) return viejo;
  if (!esNoObtenida(valorEnviado)) return null;
  if (error.code !== '23514') return null;
  if (!/estatus_facturacion|facturacion_nota/.test(error.message ?? ''))
    return null;
  return MENSAJE_NO_OBTENIDA_SIN_MIGRACION;
}
