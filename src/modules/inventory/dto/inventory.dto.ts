import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum TipoMovimientoInventario {
  ENTRADA = 'ENTRADA',
  SALIDA = 'SALIDA',
  DEVOLUCION = 'DEVOLUCION',
  AJUSTE = 'AJUSTE',
}

export class ListInventarioQuery {
  @ApiPropertyOptional({ description: 'Búsqueda por nombre o número de parte' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ description: 'Solo ítems por debajo del stock mínimo' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  bajo_stock?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateInventarioItemDto {
  @ApiProperty({ maxLength: 200, example: 'Filtro de aceite 108-1' })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiPropertyOptional({
    description: 'SKU / código de barras interno (distinto del numero_parte)',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  codigo?: string;

  @ApiProperty({ maxLength: 50, description: 'Categoría libre (aceites, filtros, llantas...)' })
  @IsString()
  @MaxLength(50)
  categoria!: string;

  @ApiPropertyOptional({ description: 'Umbral de alerta de stock' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_minimo?: number;

  @ApiPropertyOptional({ default: 'Bodega Cancún', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ubicacion?: string;

  @ApiPropertyOptional({
    maxLength: 30,
    description: 'Presentación/unidad del stock: pieza, caja, bote, galón, litro, bolsa…',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unidad?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateInventarioItemDto extends PartialType(CreateInventarioItemDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class CreateMovimientoDto {
  @ApiProperty({ enum: TipoMovimientoInventario })
  @IsEnum(TipoMovimientoInventario)
  tipo!: TipoMovimientoInventario;

  @ApiProperty({ description: 'Cantidad (siempre positiva)' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiPropertyOptional({
    description:
      'Costo unitario en USD. Requerido en ENTRADA/DEVOLUCION/AJUSTE si la captura es USD. En SALIDA se ignora: se calcula por FIFO.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_usd?: number;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de la CAPTURA (default USD por compatibilidad; panel/app mandan MXN por default). La contabilidad interna (FIFO/valorizado/gasto bodega) sigue en USD.',
  })
  @IsOptional()
  @IsIn(['MXN', 'USD'])
  moneda?: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description:
      'Costo unitario en PESOS (capturas MXN). El API lo convierte a USD con tc_usd_mxn.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_mxn?: number;

  @ApiPropertyOptional({
    description: 'Tipo de cambio de la compra (MXN por USD). Requerido en capturas MXN.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ description: 'Avión al que se carga la pieza. Requerido en SALIDA (salvo para_flota).' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description:
      'SALIDA para TODAS las matrículas (aceites/consumibles de flota): el costo FIFO se prorratea en partes iguales entre los aviones activos, un gasto por avión. Excluye aeronave_id.',
  })
  @IsOptional()
  @IsBoolean()
  para_flota?: boolean;

  @ApiPropertyOptional({ description: 'Proveedor de origen (en ENTRADA)' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ description: 'Fecha del movimiento (default hoy)' })
  @IsOptional()
  @IsISO8601()
  fecha_movimiento?: string;

  @ApiPropertyOptional({ description: 'Fecha de la orden de compra' })
  @IsOptional()
  @IsISO8601()
  fecha_orden?: string;

  @ApiPropertyOptional({ description: 'Fecha del cargo en estado de cuenta' })
  @IsOptional()
  @IsISO8601()
  fecha_cargo_banco?: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'No. de orden / factura / referencia' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class ListMovimientosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ enum: TipoMovimientoInventario })
  @IsOptional()
  @IsEnum(TipoMovimientoInventario)
  tipo?: TipoMovimientoInventario;

  @ApiPropertyOptional({ description: 'Desde (fecha_movimiento)' })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta (fecha_movimiento)' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
