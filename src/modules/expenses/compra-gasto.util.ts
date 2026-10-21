/**
 * «REGISTRAR GASTO» DE UNA COMPRA (21-oct-2026, invariante 101). Pedido del
 * cliente: «que no se registre la compra en gastos hasta que le den en un
 * botón de "Registrar gasto" y les pida poner sí o sí el tipo de cambio».
 *
 * FUENTE ÚNICA (PURA, sin Nest ni BD) de: la banda razonable del T.C., las
 * validaciones del `POST /v1/compras/:id/registrar-gasto` con sus códigos
 * ESTABLES, el cuerpo del gasto que se crea (UN gasto REFACCION por el
 * total de la FACTURA de mercancía —líneas + cargos impresos en ella— en la
 * moneda de la compra, ligado como pago MERCANCIA) y los textos. La
 * orquestación (candado de la compra, alta por `ExpensesService.create`,
 * T.C. de la compra) vive en `CompraGastoService`.
 */
import { cuentaParaGuardar } from '../../common/medio-pago.util';
import type { MonedaCompra, ResumenCompra } from '../compras/compras.calculo';
import {
  CategoriaGasto,
  type CreateGastoDto,
  MedioPago,
  Moneda,
} from './dto/expenses.dto';
import type { RegistrarGastoCompraDto } from './dto/compra-gasto.dto';

/**
 * Banda razonable del T.C. (MXN por USD), la MISMA que `TC_PAGO_SOCIO_*`
 * (pagos a socios) y `COSTO_EXTERNO_TC_*`: fuera de ella casi siempre es un
 * dedo de más («182.34») o el campo cruzado con el monto.
 */
export const TC_COMPRA_MIN = 15;
export const TC_COMPRA_MAX = 25;

/** Códigos ESTABLES del 400/409 (el panel decide por ellos, nunca por el texto). */
export const CODIGO_COMPRA_GASTO = {
  YA_REGISTRADO: 'COMPRA_GASTO_YA_REGISTRADO',
  SIN_LINEAS: 'COMPRA_SIN_LINEAS',
  SIN_MONTO: 'COMPRA_SIN_MONTO',
  TC_REQUERIDO: 'TC_REQUERIDO',
  TC_FUERA_DE_RANGO: 'TC_FUERA_DE_RANGO',
  NO_DISPONIBLE: 'REGISTRAR_GASTO_NO_DISPONIBLE',
} as const;

export const MENSAJE_COMPRA_GASTO = {
  YA_REGISTRADO:
    'Esta compra ya tiene su gasto de mercancía registrado: no se registra dos veces. Si pagaste otra factura (envío, impuestos), vincúlala como pago con su rol.',
  SIN_LINEAS:
    'La compra no tiene líneas: agrega las refacciones (o vincula un gasto ya registrado) antes de registrar su gasto.',
  SIN_MONTO:
    'La factura de mercancía vale $0.00: captura el costo de las líneas antes de registrar su gasto.',
  TC_REQUERIDO:
    'Captura el tipo de cambio (pesos por dólar): es obligatorio para registrar el gasto de una compra.',
  NO_DISPONIBLE:
    'Registrar el gasto de una compra no está disponible en este servidor; registra el gasto en Gastos y vincúlalo a la compra.',
} as const;

export function mensajeTcFueraDeRango(tc: number): string {
  return `El tipo de cambio ${tc} está fuera del rango razonable (${TC_COMPRA_MIN} a ${TC_COMPRA_MAX} pesos por dólar): revisa la captura.`;
}

export interface ErrorCompraGasto {
  status: 400 | 409;
  code: (typeof CODIGO_COMPRA_GASTO)[keyof typeof CODIGO_COMPRA_GASTO];
  message: string;
  details?: Record<string, unknown>;
}

/** Lo que hace falta de cada pago ligado para decidir si ya hay gasto de mercancía. */
export interface PagoLigado {
  id: string;
  monto: number | string;
  moneda: string;
  compra_rol: string | null;
}

/**
 * Valida ANTES de tocar la BD, en este orden: ya tiene su gasto de
 * mercancía (409, idempotencia del botón), sin líneas, factura en $0 y el
 * T.C. (obligatorio y en banda). `null` = se puede registrar.
 */
export function validarRegistrarGastoCompra(p: {
  tc: number | string | null | undefined;
  nLineas: number;
  resumen: Pick<ResumenCompra, 'total_factura'>;
  pagos: readonly PagoLigado[];
}): ErrorCompraGasto | null {
  const mercancia = p.pagos.find((x) => x.compra_rol === 'MERCANCIA');
  if (mercancia) {
    return {
      status: 409,
      code: CODIGO_COMPRA_GASTO.YA_REGISTRADO,
      message: MENSAJE_COMPRA_GASTO.YA_REGISTRADO,
      details: {
        gasto_id: mercancia.id,
        monto: Number(mercancia.monto),
        moneda: mercancia.moneda,
      },
    };
  }
  if (p.nLineas <= 0) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.SIN_LINEAS,
      message: MENSAJE_COMPRA_GASTO.SIN_LINEAS,
    };
  }
  if (!(Number(p.resumen.total_factura) > 0)) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.SIN_MONTO,
      message: MENSAJE_COMPRA_GASTO.SIN_MONTO,
    };
  }
  const tc = p.tc == null || p.tc === '' ? NaN : Number(p.tc);
  if (!Number.isFinite(tc) || tc <= 0) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.TC_REQUERIDO,
      message: MENSAJE_COMPRA_GASTO.TC_REQUERIDO,
    };
  }
  if (tc < TC_COMPRA_MIN || tc > TC_COMPRA_MAX) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.TC_FUERA_DE_RANGO,
      message: mensajeTcFueraDeRango(tc),
    };
  }
  return null;
}

/** Lo que el cuerpo del gasto toma de la compra. */
export interface CompraParaGasto {
  folio: number;
  referencia: string | null;
  moneda: MonedaCompra;
  proveedor_id: string | null;
  proveedor?: { nombre: string } | null;
}

/** «Compra #12 · Ref. AS-1234 · Aircraft Spruce» (+ las notas capturadas). */
export function notasGastoDeCompra(
  compra: Pick<CompraParaGasto, 'folio' | 'referencia' | 'proveedor'>,
  notas: string | null | undefined,
): string {
  const cabecera = [
    `Compra #${compra.folio}`,
    compra.referencia ? `Ref. ${compra.referencia}` : null,
    compra.proveedor?.nombre ?? null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
  const extra = (notas ?? '').trim();
  return extra ? `${cabecera}\n${extra}` : cabecera;
}

/**
 * El `CreateGastoDto` que se manda al alta de siempre (`ExpensesService.create`):
 * UN gasto REFACCION por `total_factura` en la moneda de la compra, con el
 * T.C. capturado (en las dos monedas: en pesos es el equivalente en dólares
 * del balance; en dólares, lo que convierte a pesos), la fecha y el medio
 * del pago, la cuenta solo con un medio que la lleva (invariante 98), el
 * proveedor de la compra por default y el folio/factura si se capturó. SIN
 * avión ni vuelo: el avión recibe su cargo por la SALIDA de bodega (es el
 * modelo de Compras; con `aeronave_id` se contaría dos veces).
 */
export function cuerpoGastoDeCompra(p: {
  compra: CompraParaGasto;
  resumen: Pick<ResumenCompra, 'total_factura'>;
  dto: RegistrarGastoCompraDto;
}): CreateGastoDto {
  const { compra, dto } = p;
  const cuenta = cuentaParaGuardar(
    dto.medio_pago,
    dto.cuenta_bancaria_id,
    null,
  );
  const folio = dto.folio_ticket?.trim();
  const proveedorId = dto.proveedor_id ?? compra.proveedor_id ?? undefined;
  return {
    categoria: CategoriaGasto.REFACCION,
    monto: Math.round(Number(p.resumen.total_factura) * 100) / 100,
    moneda: compra.moneda === 'MXN' ? Moneda.MXN : Moneda.USD,
    tc_gasto: Number(dto.tc_usd_mxn),
    fecha_gasto: dto.fecha_gasto,
    medio_pago: dto.medio_pago,
    ...(dto.medio_pago === MedioPago.TARJETA_CORP && dto.tarjeta_terminacion
      ? { tarjeta_terminacion: dto.tarjeta_terminacion }
      : {}),
    ...(cuenta ? { cuenta_bancaria_id: cuenta } : {}),
    ...(proveedorId ? { proveedor_id: proveedorId } : {}),
    ...(folio ? { folio_ticket: folio } : {}),
    ...(dto.client_request_id
      ? { client_request_id: dto.client_request_id }
      : {}),
    notas: notasGastoDeCompra(compra, dto.notas),
  } as CreateGastoDto;
}

/** Lo que responde el endpoint del gasto recién creado (subconjunto estable). */
export function resumenGastoRegistrado(gasto: Record<string, unknown>): {
  id: string;
  monto: number;
  moneda: string;
  tc_gasto: number | null;
  fecha_gasto: string | null;
  medio_pago: string | null;
  estado_pago: string | null;
} {
  const tc = Number(gasto.tc_gasto);
  return {
    id: String(gasto.id),
    monto: Number(gasto.monto),
    moneda: String(gasto.moneda ?? ''),
    tc_gasto: Number.isFinite(tc) && tc > 0 ? tc : null,
    fecha_gasto:
      typeof gasto.fecha_gasto === 'string' ? gasto.fecha_gasto : null,
    medio_pago: typeof gasto.medio_pago === 'string' ? gasto.medio_pago : null,
    estado_pago:
      typeof gasto.estado_pago === 'string' ? gasto.estado_pago : null,
  };
}
