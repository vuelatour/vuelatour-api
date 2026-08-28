import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ExtraerCompraDto {
  @ApiProperty({
    description:
      'PDF de la factura/orden de compra en base64 (sin prefijo data:)',
  })
  @IsString()
  pdf_base64!: string;
}

export class ImportarLineaDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiProperty({ maxLength: 50, description: 'Categoría del ítem' })
  @IsString()
  @MaxLength(50)
  categoria!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiProperty({ description: 'Costo unitario USD' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_usd!: number;
}

export class ImportarCompraDto {
  @ApiPropertyOptional({ description: 'Proveedor de la compra' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de los costos de las LÍNEAS (toda la factura). Con MXN se requiere tc_usd_mxn; el API convierte a USD (moneda canónica interna).',
  })
  @IsOptional()
  @IsIn(['MXN', 'USD'])
  moneda?: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description: 'Tipo de cambio de la compra (MXN por USD).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ description: 'Fecha de la orden' })
  @IsOptional()
  @IsISO8601()
  fecha_orden?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional({
    description:
      'Shipping impreso en la factura (moneda de la compra). Va a cargos_factura de la COMPRA y se prorratea al costo de cada línea.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shipping_usd?: number;

  @ApiPropertyOptional({
    description:
      'Impuestos impresos en la factura (moneda de la compra). Va a cargos_factura de la COMPRA y se prorratea al costo de cada línea.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  impuestos_usd?: number;

  @ApiProperty({ type: [ImportarLineaDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'La compra debe traer al menos una línea.' })
  @ValidateNested({ each: true })
  @Type(() => ImportarLineaDto)
  lineas!: ImportarLineaDto[];
}
