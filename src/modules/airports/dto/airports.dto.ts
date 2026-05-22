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

export class ListAirportsQuery {
  @ApiPropertyOptional({ description: 'Búsqueda por IATA, ICAO, nombre o ciudad' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2', example: 'MX' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  pais?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateAirportDto {
  @ApiProperty({ description: 'Código IATA (3-4 chars)', example: 'CUN' })
  @IsString()
  @Length(3, 4)
  iata!: string;

  @ApiPropertyOptional({ description: 'Código ICAO (4 chars)', example: 'MMUN' })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  icao?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  nombre!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ciudad?: string;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2', default: 'MX' })
  @IsString()
  @Length(2, 2)
  pais!: string;

  @ApiPropertyOptional({ description: 'Tarifa TUAS USD/pasajero', default: 25, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tuas_default_usd_pax?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  tuas_aplica_xa?: boolean;

  @ApiPropertyOptional({ default: true, description: 'False en CUN' })
  @IsOptional()
  @IsBoolean()
  tuas_aplica_xb?: boolean;

  @ApiPropertyOptional({ default: true, description: 'False en CUN' })
  @IsOptional()
  @IsBoolean()
  tuas_aplica_n?: boolean;

  @ApiPropertyOptional({ default: true, description: 'False en Cozumel' })
  @IsOptional()
  @IsBoolean()
  tuas_pase_abordar_exenta?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'La pista exige tramitar permiso antes del vuelo (ej. HOL, MHL, PTU).',
  })
  @IsOptional()
  @IsBoolean()
  requiere_permiso?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateAirportDto extends PartialType(CreateAirportDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
