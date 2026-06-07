import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAeronaveSeguroDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  aseguradora!: string;

  @ApiProperty({ description: 'Número de póliza' })
  @IsString()
  @MaxLength(80)
  num_poliza!: string;

  @ApiPropertyOptional({ description: 'Descripción de la cobertura' })
  @IsOptional()
  @IsString()
  cobertura?: string;

  @ApiPropertyOptional({ description: 'Suma asegurada (USD)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  suma_asegurada_usd?: number;

  @ApiPropertyOptional({ description: 'Prima (USD)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  prima_usd?: number;

  @ApiProperty({ example: '2026-01-01' })
  @Type(() => Date)
  @IsDate()
  vigente_desde!: Date;

  @ApiProperty({ example: '2027-01-01' })
  @Type(() => Date)
  @IsDate()
  vigente_hasta!: Date;

  @ApiPropertyOptional({ description: 'URL/path del PDF de la póliza' })
  @IsOptional()
  @IsString()
  archivo_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateAeronaveSeguroDto extends PartialType(CreateAeronaveSeguroDto) {}
