/**
 * FUENTE ÚNICA de las CATEGORÍAS DE INGRESO (24-sep-2026, pedido del
 * cliente: «faltarían las categorías de "ingresos" de igual manera de como
 * están ya ahorita las de "gastos" … Otros Ingresos, Anticipos y depósitos,
 * Ingresos en cuentas de banco»).
 *
 * Todo lo que NO es un cobro de vuelo vive en `public.ingreso` con una de
 * estas categorías (texto + CHECK `ingreso_categoria_chk`, NO enum: sin
 * repetir el incidente del ENUM `moneda` del 15-sep). El panel COPIA esta
 * tabla byte por byte en `src/lib/admin/categorias-ingreso.ts` con los
 * MISMOS nombres de export (paridad manual, como las categorías de gasto;
 * los dos specs congelan la misma tabla literal).
 *
 * DESTINO: dónde cuenta el dinero. Las de «Otros ingresos (Balance general
 * VuelaTour y Libro Dinero)» SUMAN A RESULTADOS (hoja «Otros ingresos» del
 * Libro Dinero y «Otros movimientos» del Balance general); ANTICIPO_CLIENTE
 * y APORTACION_PRESTAMO quedan FUERA de resultados (el anticipo cuenta como
 * COBRO del vuelo cuando se aplica — cero doble conteo). A propósito NO se
 * dice «Otros ingresos VuelaTour»: ese nombre ya es el bloque de
 * TUAs/extras de los vuelos en el reparto y los dashboards
 * (`otros_ingresos_vuelatour`) y el operador creería que suma ahí.
 *
 * PURO: sin BD ni reloj.
 */
import { normalizarPlano } from '../modules/conciliacion/auto-cruce.util';

export const CATEGORIAS_INGRESO = [
  'OTRO_INGRESO',
  'ANTICIPO_CLIENTE',
  'INGRESO_BANCARIO',
  'REEMBOLSO_DEVOLUCION',
  'VENTA_ACTIVO',
  'APORTACION_PRESTAMO',
] as const;

export type CategoriaIngreso = (typeof CATEGORIAS_INGRESO)[number];

/** Destino de las categorías que SUMAN a resultados. */
export const DESTINO_INGRESO_RESULTADO =
  'Otros ingresos (Balance general VuelaTour y Libro Dinero)';

/** Etiqueta es-MX (orden de los selectores = el de `CATEGORIAS_INGRESO`). */
export const CATEGORIA_INGRESO_LABEL: Record<CategoriaIngreso, string> = {
  OTRO_INGRESO: 'Otros ingresos',
  ANTICIPO_CLIENTE: 'Anticipos y depósitos de clientes',
  INGRESO_BANCARIO: 'Ingresos en cuentas de banco',
  REEMBOLSO_DEVOLUCION: 'Reembolsos y devoluciones recibidos',
  VENTA_ACTIVO: 'Venta de refacciones o activos a terceros',
  APORTACION_PRESTAMO: 'Aportaciones de socios y préstamos',
};

/** A dónde cuenta el ingreso (texto verde del selector de captura). */
export const CATEGORIA_INGRESO_DESTINO: Record<CategoriaIngreso, string> = {
  OTRO_INGRESO: DESTINO_INGRESO_RESULTADO,
  ANTICIPO_CLIENTE:
    'Fuera de resultados hasta aplicarse a un vuelo (ahí cuenta como cobro del vuelo)',
  INGRESO_BANCARIO: DESTINO_INGRESO_RESULTADO,
  REEMBOLSO_DEVOLUCION: DESTINO_INGRESO_RESULTADO,
  VENTA_ACTIVO: DESTINO_INGRESO_RESULTADO,
  APORTACION_PRESTAMO: 'Fuera de resultados (no es venta: es capital o deuda)',
};

/** Ayuda gris del selector (qué va en cada una y qué NO). */
export const CATEGORIA_INGRESO_AYUDA: Record<CategoriaIngreso, string> = {
  OTRO_INGRESO:
    'Dinero que entra y no es de un vuelo ni de otra categoría. Si es el pago de un vuelo, regístralo como cobro en el vuelo.',
  ANTICIPO_CLIENTE:
    'El cliente pagó y su vuelo todavía no existe. Si el vuelo ya existe, registra el cobro en el vuelo.',
  INGRESO_BANCARIO: 'Intereses, rendimientos y bonificaciones del banco.',
  REEMBOLSO_DEVOLUCION:
    'Dinero que nos regresan: aseguradoras, gastos médicos, devoluciones de proveedores. (Si tú le devuelves dinero a un cliente, eso es un reembolso en el vuelo, no un ingreso.)',
  VENTA_ACTIVO:
    'Venta de piezas, equipo o activos a alguien de fuera. Si la pieza sale de bodega, registra también la salida en Inventario.',
  APORTACION_PRESTAMO: 'Dinero que ponen los socios o un préstamo recibido.',
};

/**
 * Categorías que SUMAN A RESULTADOS — DERIVADA del destino (patrón
 * `CATEGORIAS_GASTO_EMPRESA`): una categoría nueva con ese destino entra
 * sola y el spec congela la membresía de hoy (cambiar un destino mueve
 * dinero ⇒ falla en pruebas, no en el cierre).
 */
export const CATEGORIAS_INGRESO_RESULTADO: ReadonlySet<string> = new Set(
  CATEGORIAS_INGRESO.filter(
    (c) => CATEGORIA_INGRESO_DESTINO[c] === DESTINO_INGRESO_RESULTADO,
  ),
);

/** ¿Es una categoría conocida? */
export function esCategoriaIngreso(
  c: string | null | undefined,
): c is CategoriaIngreso {
  return !!c && (CATEGORIAS_INGRESO as readonly string[]).includes(c);
}

/** ¿El ingreso suma a resultados (Libro Dinero y Balance general)? */
export function categoriaIngresoSumaAResultados(
  c: string | null | undefined,
): boolean {
  return !!c && CATEGORIAS_INGRESO_RESULTADO.has(c);
}

/** ¿Es un anticipo de cliente? */
export function esAnticipo(c: string | null | undefined): boolean {
  return c === 'ANTICIPO_CLIENTE';
}

/** Solo el anticipo exige cliente (CHECK `ingreso_anticipo_chk`). */
export function categoriaIngresoExigeCliente(
  c: string | null | undefined,
): boolean {
  return esAnticipo(c);
}

/**
 * Categorías que admiten `vuelo_id` (espejo del CHECK `ingreso_vuelo_chk`):
 * solo REEMBOLSO_DEVOLUCION. El pago de un vuelo es un COBRO del vuelo (o un
 * anticipo si el vuelo aún no existe): como «otro ingreso» contaría dos
 * veces.
 */
export function categoriaIngresoAdmiteVuelo(
  c: string | null | undefined,
): boolean {
  return c === 'REEMBOLSO_DEVOLUCION';
}

/** Etiqueta legible; código desconocido ⇒ capitalizado; vacío ⇒ ''. */
export function etiquetaCategoriaIngreso(c: string | null | undefined): string {
  if (!c) return '';
  const label = (CATEGORIA_INGRESO_LABEL as Record<string, string | undefined>)[
    c
  ];
  if (label) return label;
  const limpio = c.replace(/_/g, ' ').toLowerCase();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/** Folio legible del ingreso: 'ING-12' ('ING-?' si no hay folio). */
export function etiquetaIngreso(folio: number | null | undefined): string {
  return `ING-${folio == null ? '?' : folio}`;
}

/**
 * Heurística DETERMINISTA para PRELLENAR «Registrar como otro ingreso» desde
 * un abono del banco (no liga nada, solo propone la categoría). NUNCA
 * devuelve OTRO_INGRESO ni ANTICIPO_CLIENTE: el pago de un cliente se decide
 * a mano (si fuera el pago de un vuelo, registrarlo como otro ingreso
 * contaría dos veces).
 */
export function categoriaSugeridaDeDescripcion(
  desc: string | null | undefined,
): CategoriaIngreso | null {
  const t = normalizarPlano(desc);
  if (!t) return null;
  if (/REEMBOLSO|REMBOLSO|DEVOLUCION|DEVOL\b|SEGURO|ASEGURADORA/.test(t)) {
    return 'REEMBOLSO_DEVOLUCION';
  }
  if (/INTERES|RENDIMIENTO|BONIFICACION|CASHBACK/.test(t)) {
    return 'INGRESO_BANCARIO';
  }
  if (/APORTACION|PRESTAMO|CREDITO SIMPLE/.test(t)) {
    return 'APORTACION_PRESTAMO';
  }
  return null;
}
