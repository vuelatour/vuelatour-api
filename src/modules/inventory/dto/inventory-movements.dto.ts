import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
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

export class ListInventoryMovementsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @ApiPropertyOptional({ enum: TipoMovimientoInventario })
  @IsOptional()
  @IsEnum(TipoMovimientoInventario)
  tipo?: TipoMovimientoInventario;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    description: 'Fecha de movimiento desde (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({
    description: 'Fecha de movimiento hasta (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
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

export class CreateInventoryMovementDto {
  @ApiProperty()
  @IsUUID()
  item_id!: string;

  @ApiProperty({ enum: TipoMovimientoInventario })
  @IsEnum(TipoMovimientoInventario)
  tipo!: TipoMovimientoInventario;

  @ApiProperty({ description: 'Cantidad. Siempre positiva.' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiPropertyOptional({
    description:
      'Costo unitario en USD. Requerido en ENTRADA/DEVOLUCION si la captura es USD. En SALIDA lo calcula el API por FIFO.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_usd?: number;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de la CAPTURA (default USD por compatibilidad; panel/app mandan MXN por default). La contabilidad interna sigue en USD.',
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

  @ApiPropertyOptional({
    description: 'Aeronave a la que se carga (obligatorio en SALIDA)',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Proveedor de la pieza (ENTRADA)' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    description: 'Fecha del movimiento (YYYY-MM-DD). Default: hoy.',
  })
  @IsOptional()
  @IsDateString()
  fecha_movimiento?: string;

  @ApiPropertyOptional({ description: 'Fecha de la orden de compra (ENTRADA)' })
  @IsOptional()
  @IsDateString()
  fecha_orden?: string;

  @ApiPropertyOptional({ description: 'Fecha del cargo bancario (ENTRADA)' })
  @IsOptional()
  @IsDateString()
  fecha_cargo_banco?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}
