import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
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
  @ApiProperty({ description: 'PDF de la factura/orden de compra en base64 (sin prefijo data:)' })
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

  @ApiPropertyOptional({ description: 'Fecha de la orden' })
  @IsOptional()
  @IsISO8601()
  fecha_orden?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiProperty({ type: [ImportarLineaDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportarLineaDto)
  lineas!: ImportarLineaDto[];
}
