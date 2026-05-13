import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListRoutesQuery {
  @ApiPropertyOptional({ description: 'Filtra por aeropuerto origen (IATA)' })
  @IsOptional()
  @IsString()
  @Length(3, 4)
  origen?: string;

  @ApiPropertyOptional({ description: 'Filtra por aeropuerto destino (IATA)' })
  @IsOptional()
  @IsString()
  @Length(3, 4)
  destino?: string;

  @ApiPropertyOptional({ description: 'Búsqueda libre por iata origen/destino' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activa?: boolean;

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

export class CreateRouteDto {
  @ApiProperty({ example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ example: 'CZM' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ description: 'Millas náuticas one-way si es_redondo_auto=true', example: 63.14 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas!: number;

  @ApiPropertyOptional({ default: true, description: 'True = motor multiplica NM por 2 (CUN-X-CUN)' })
  @IsOptional()
  @IsBoolean()
  es_redondo_auto?: boolean;

  @ApiPropertyOptional({ default: 2, description: 'Número total de aterrizajes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  num_aterrizajes?: number;

  @ApiPropertyOptional({ example: 'FOREFLIGHT', description: 'GOOGLE_EARTH | FOREFLIGHT | MANUAL | APROXIMACION' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fuente?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateRouteDto extends PartialType(CreateRouteDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
