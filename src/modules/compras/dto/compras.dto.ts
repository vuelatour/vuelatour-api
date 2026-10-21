import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';

export enum RolPagoCompra {
  MERCANCIA = 'MERCANCIA',
  ENVIO = 'ENVIO',
  IMPUESTOS = 'IMPUESTOS',
  OTRO = 'OTRO',
}

export enum EstadoCompra {
  ABIERTA = 'ABIERTA',
  RECIBIDA = 'RECIBIDA',
}

// Forma YYYY-MM-DD + fecha REAL (strict: 2026-02-30 no pasa). Sin esto la BD
// respondía 22007/22008 → 500 y dejaba una compra huérfana.
const FECHA_YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CargoFacturaDto {
  @ApiProperty({ maxLength: 120, example: 'Shipping' })
  @IsString()
  @MaxLength(120)
  concepto!: string;

  @ApiProperty({ description: 'Monto en la moneda de la compra' })
  @Type(() => Number)
  @IsNumber()
  monto!: number;
}

export class CompraLineaDto {
  @ApiPropertyOptional({
    description: 'Id de la línea existente (PATCH); sin id = nueva',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ description: 'Ítem del inventario (si ya existe)' })
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiPropertyOptional({
    maxLength: 50,
    description: "Categoría del ítem (default 'Refacción')",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiProperty({
    description: 'Costo unitario de FACTURA en la moneda de la compra',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario!: number;
}

export class CreateCompraDto {
  @ApiPropertyOptional({
    description:
      'Gasto de la factura de mercancía: la compra hereda proveedor/fecha/moneda/TC y arma las líneas desde valor_ia_extraido.conceptos; queda ligado con rol MERCANCIA.',
  })
  @IsOptional()
  @IsUUID()
  gasto_mercancia_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    example: '2026-08-28',
    description: 'Fecha (día Cancún)',
  })
  @IsOptional()
  @Matches(FECHA_YMD, { message: 'fecha debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha inválida (YYYY-MM-DD)' })
  fecha?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description: 'Moneda de las líneas',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({ description: 'TC de la compra (MXN por USD)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    type: [CompraLineaDto],
    description: 'Si vienen, mandan sobre las derivadas del gasto',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompraLineaDto)
  lineas?: CompraLineaDto[];

  @ApiPropertyOptional({
    type: [CargoFacturaDto],
    description:
      'Cargos impresos en la factura de mercancía (Shipping, Tax…), en su moneda (21-oct-2026). Si vienen, mandan sobre los derivados del gasto; `[]` = ninguno.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CargoFacturaDto)
  cargos_factura?: CargoFacturaDto[];
}

/**
 * ENTRADA DE INVENTARIO VINCULADA A UN GASTO YA REGISTRADO (21-oct-2026,
 * invariante 101, caso del cliente «ya registramos el gasto; cuando llegue,
 * vincular»): el API arma la compra de UNA línea con ese gasto como factura
 * de mercancía (costo unitario = monto del gasto ÷ unidades, fuente única
 * `lineaCompraDeRefaccion`) y la recibe. El panel manda solo lo capturado.
 */
export class EntradaDesdeGastoDto {
  @ApiProperty({ description: 'Gasto REFACCION/OTRO/OPERACIONES sin compra' })
  @IsUUID()
  gasto_id!: string;

  @ApiProperty({ description: 'Artículo de Inventario/Tienda que entra' })
  @IsUUID()
  item_id!: string;

  @ApiProperty({ description: 'Unidades que entran (> 0)' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description:
      'Día (Cancún) en que llegó la pieza: fecha de la compra y de la ENTRADA. Default hoy.',
  })
  @IsOptional()
  @Matches(FECHA_YMD, { message: 'fecha debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha inválida (YYYY-MM-DD)' })
  fecha?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional({
    description:
      'TC de la compra (MXN por USD). Default: el del gasto; en pesos sin ninguno, el oficial del día (400 TC_REQUERIDO si tampoco).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ description: 'Default: el proveedor del gasto' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

/**
 * Gastos que pueden ser PAGO de una compra (selector «Vincular gasto ya
 * registrado», 21-oct-2026): sin compra, que no sean el cargo contable de
 * una salida de bodega y de categoría ligable. Ventana por fecha del gasto
 * (día Cancún), búsqueda libre y, opcionalmente, solo los que pueden ser la
 * factura de MERCANCÍA.
 */
export class GastosCandidatosQuery {
  @ApiPropertyOptional({
    description: 'Texto: notas, folio, proveedor o monto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({
    example: '2026-06-23',
    description: 'Default: hasta − 120 días',
  })
  @IsOptional()
  @Matches(FECHA_YMD, { message: 'desde debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'desde inválida (YYYY-MM-DD)' })
  desde?: string;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'Default: hoy (Cancún)',
  })
  @IsOptional()
  @Matches(FECHA_YMD, { message: 'hasta debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'hasta inválida (YYYY-MM-DD)' })
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    description:
      'true = solo gastos que pueden ser la factura de mercancía (REFACCION, OTRO, OPERACIONES)',
    default: false,
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  solo_mercancia?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limite: number = 100;
}

export class UnirComprasDto {
  @ApiProperty({
    type: [String],
    description:
      'Gastos a unir (≥2). Debe incluir o no al de mercancía; se agrega solo.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('all', { each: true })
  gasto_ids!: string[];

  @ApiProperty({ description: 'Gasto de la factura de mercancía (líneas)' })
  @IsUUID()
  mercancia_gasto_id!: string;
}

export class UpdateCompraDto {
  @ApiPropertyOptional({ description: 'null = quitar proveedor' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string | null;

  @ApiPropertyOptional({ example: '2026-08-28' })
  @IsOptional()
  @Matches(FECHA_YMD, { message: 'fecha debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha inválida (YYYY-MM-DD)' })
  fecha?: string;

  @ApiPropertyOptional({ maxLength: 120, description: 'null = limpiar' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string | null;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description: 'Solo mientras ABIERTA',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({ description: 'TC de la compra; null = quitar' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number | null;

  @ApiPropertyOptional({ description: 'null = limpiar' })
  @IsOptional()
  @IsString()
  notas?: string | null;

  @ApiPropertyOptional({
    type: [CargoFacturaDto],
    description: 'Reemplazo completo. Solo mientras ABIERTA',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CargoFacturaDto)
  cargos_factura?: CargoFacturaDto[];

  @ApiPropertyOptional({
    type: [CompraLineaDto],
    description:
      'Reemplazo completo (las que traen id se actualizan, las demás se crean, las ausentes se borran). Solo mientras ABIERTA',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompraLineaDto)
  lineas?: CompraLineaDto[];
}

export class AddPagoCompraDto {
  @ApiProperty()
  @IsUUID()
  gasto_id!: string;

  @ApiProperty({ enum: RolPagoCompra })
  @IsEnum(RolPagoCompra)
  rol!: RolPagoCompra;
}

export class UpdatePagoCompraDto {
  @ApiProperty({
    enum: RolPagoCompra,
    description: 'Nuevo rol del pago dentro de la compra',
  })
  @IsEnum(RolPagoCompra)
  rol!: RolPagoCompra;
}

/**
 * Recibir con cargos SIN tipo de cambio: por default se niega (400) porque
 * el costo entraría incompleto a bodega; `forzar` (query `?forzar=true` o
 * body `{ forzar: true }`) lo acepta a sabiendas — los cargos excluidos
 * siguen en `resumen.cargos_sin_tc` y en los avisos.
 */
export class RecibirCompraDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  forzar?: boolean;
}

export class ListComprasQuery {
  @ApiPropertyOptional({ enum: EstadoCompra })
  @IsOptional()
  @IsEnum(EstadoCompra)
  estado?: EstadoCompra;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
