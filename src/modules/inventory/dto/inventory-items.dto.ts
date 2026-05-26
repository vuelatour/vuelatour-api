import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListInventoryItemsQuery {
  @ApiPropertyOptional({ description: 'Busca en nombre y numero de parte' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoria?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({
    description: 'true = solo items en o bajo el stock minimo',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  bajo_stock?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateInventoryItemDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiProperty({
    description: 'Categoria libre (aceites, filtros, llantas...)',
    maxLength: 50,
  })
  @IsString()
  @MaxLength(50)
  categoria!: string;

  @ApiPropertyOptional({ description: 'Umbral para alerta de stock bajo' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_minimo?: number;

  @ApiPropertyOptional({ default: 'Bodega Cancun', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ubicacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateInventoryItemDto extends PartialType(
  CreateInventoryItemDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
