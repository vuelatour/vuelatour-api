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
import {
  categoriaLigableACompra,
  type MonedaCompra,
  type ResumenCompra,
} from '../compras/compras.calculo';
import {
  CategoriaGasto,
  type CreateGastoDto,
  EstatusComprobante,
  MedioPago,
  Moneda,
} from './dto/expenses.dto';
import {
  ROLES_OTRO_GASTO_COMPRA,
  type AgregarGastoCompraDto,
  type RegistrarGastoCompraDto,
  type RolOtroGastoCompra,
} from './dto/compra-gasto.dto';

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
  // «Agregar gasto a la compra» (4-nov-2026).
  ROL_MERCANCIA: 'COMPRA_GASTO_ROL_MERCANCIA',
  MONTO_REQUERIDO: 'COMPRA_GASTO_MONTO_REQUERIDO',
  CATEGORIA_NO_LIGABLE: 'COMPRA_GASTO_CATEGORIA_NO_LIGABLE',
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
  ROL_MERCANCIA:
    'La factura de las refacciones se registra con «Registrar gasto»; aquí se agregan los otros pagos de la compra (envío, impuestos o aduana, otro cargo).',
  MONTO_REQUERIDO: 'Captura el monto que pagaste (mayor a cero).',
} as const;

export function mensajeCategoriaNoLigable(categoria: string): string {
  return `Un gasto ${categoria} no puede ser pago de una compra de refacciones: elige otra categoría.`;
}

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

/**
 * Qué paga un gasto agregado a la compra (todo menos la mercancía) y la
 * categoría con la que nace si no se manda otra: el envío de una pieza es
 * PAQUETERIA (invariante 97: gasto de la empresa, como la refacción sin
 * avión); impuestos/aduana y otros cargos van a OTRO (así los capturó la
 * oficina en las compras #3 y #4). Nunca una categoría de vuelo.
 */
export const ETIQUETA_ROL_OTRO_GASTO: Readonly<
  Record<RolOtroGastoCompra, string>
> = {
  ENVIO: 'Envío',
  IMPUESTOS: 'Impuestos / aduana',
  OTRO: 'Otro cargo',
};

export const CATEGORIA_POR_ROL_OTRO_GASTO: Readonly<
  Record<RolOtroGastoCompra, CategoriaGasto>
> = {
  ENVIO: CategoriaGasto.PAQUETERIA,
  IMPUESTOS: CategoriaGasto.OTRO,
  OTRO: CategoriaGasto.OTRO,
};

export function esRolOtroGastoCompra(
  rol: string | null | undefined,
): rol is RolOtroGastoCompra {
  return (
    typeof rol === 'string' &&
    (ROLES_OTRO_GASTO_COMPRA as readonly string[]).includes(rol)
  );
}

/** La categoría con la que nace el gasto agregado: la capturada o la del rol. */
export function categoriaOtroGastoCompra(
  rol: RolOtroGastoCompra,
  categoria: CategoriaGasto | string | null | undefined,
): string {
  const c = typeof categoria === 'string' ? categoria.trim() : '';
  return c || CATEGORIA_POR_ROL_OTRO_GASTO[rol];
}

/**
 * Valida «Agregar gasto a la compra» ANTES de tocar la BD, en este orden:
 * el rol (la mercancía tiene su propio botón), el monto, la categoría (una
 * que no se liga a compras jamás entra al costo de bodega) y el T.C.
 * (obligatorio y en banda, como en «Registrar gasto»). `null` = adelante.
 */
export function validarAgregarGastoCompra(p: {
  rol: string | null | undefined;
  monto: number | string | null | undefined;
  tc: number | string | null | undefined;
  categoria?: string | null;
}): ErrorCompraGasto | null {
  if (!esRolOtroGastoCompra(p.rol)) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.ROL_MERCANCIA,
      message: MENSAJE_COMPRA_GASTO.ROL_MERCANCIA,
    };
  }
  const monto = p.monto == null || p.monto === '' ? NaN : Number(p.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.MONTO_REQUERIDO,
      message: MENSAJE_COMPRA_GASTO.MONTO_REQUERIDO,
    };
  }
  const categoria = categoriaOtroGastoCompra(p.rol, p.categoria);
  if (!categoriaLigableACompra(categoria)) {
    return {
      status: 400,
      code: CODIGO_COMPRA_GASTO.CATEGORIA_NO_LIGABLE,
      message: mensajeCategoriaNoLigable(categoria),
      details: { categoria },
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

/**
 * El comprobante que ya subió el panel al bucket (4-nov-2026): con path, el
 * gasto nace «Con comprobante» (FACTURA, lo mismo que guarda el alta de la
 * oficina y la app al subir foto); sin path no se nombra ninguna llave.
 */
export function comprobanteDeFoto(
  fotoUrl: string | null | undefined,
): Pick<CreateGastoDto, 'foto_url' | 'estatus_comprobante'> {
  const foto = typeof fotoUrl === 'string' ? fotoUrl.trim() : '';
  return foto
    ? { foto_url: foto, estatus_comprobante: EstatusComprobante.FACTURA }
    : {};
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
    ...comprobanteDeFoto(dto.foto_url),
    ...(dto.client_request_id
      ? { client_request_id: dto.client_request_id }
      : {}),
    notas: notasGastoDeCompra(compra, dto.notas),
  };
}

/** «Envío de la compra #12 · Ref. AS-1234 · Aircraft Spruce» (+ las notas capturadas). */
export function notasOtroGastoDeCompra(
  compra: Pick<CompraParaGasto, 'folio' | 'referencia' | 'proveedor'>,
  rol: RolOtroGastoCompra,
  notas: string | null | undefined,
): string {
  const cabecera = [
    `${ETIQUETA_ROL_OTRO_GASTO[rol]} de la compra #${compra.folio}`,
    compra.referencia ? `Ref. ${compra.referencia}` : null,
    compra.proveedor?.nombre ?? null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
  const extra = (notas ?? '').trim();
  return extra ? `${cabecera}\n${extra}` : cabecera;
}

/**
 * El `CreateGastoDto` de «Agregar gasto a la compra»: el monto y la moneda
 * de SU factura (no los de la compra), el T.C. capturado, la fecha y el
 * medio del pago, la cuenta solo con un medio que la lleva (invariante 98),
 * el proveedor de ESTE pago (sin default: UPS no es Aircraft Spruce), el
 * folio, el comprobante y las notas con la compra. SIN avión ni vuelo, como
 * la mercancía: el avión paga por la SALIDA de bodega.
 */
export function cuerpoOtroGastoDeCompra(p: {
  compra: Pick<CompraParaGasto, 'folio' | 'referencia' | 'proveedor'>;
  dto: AgregarGastoCompraDto;
}): CreateGastoDto {
  const { compra, dto } = p;
  const cuenta = cuentaParaGuardar(
    dto.medio_pago,
    dto.cuenta_bancaria_id,
    null,
  );
  const folio = dto.folio_ticket?.trim();
  return {
    categoria: categoriaOtroGastoCompra(dto.rol, dto.categoria),
    monto: Math.round(Number(dto.monto) * 100) / 100,
    moneda: dto.moneda === Moneda.MXN ? Moneda.MXN : Moneda.USD,
    tc_gasto: Number(dto.tc_usd_mxn),
    fecha_gasto: dto.fecha_gasto,
    medio_pago: dto.medio_pago,
    ...(dto.medio_pago === MedioPago.TARJETA_CORP && dto.tarjeta_terminacion
      ? { tarjeta_terminacion: dto.tarjeta_terminacion }
      : {}),
    ...(cuenta ? { cuenta_bancaria_id: cuenta } : {}),
    ...(dto.proveedor_id ? { proveedor_id: dto.proveedor_id } : {}),
    ...(folio ? { folio_ticket: folio } : {}),
    ...comprobanteDeFoto(dto.foto_url),
    ...(dto.client_request_id
      ? { client_request_id: dto.client_request_id }
      : {}),
    notas: notasOtroGastoDeCompra(compra, dto.rol, dto.notas),
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
