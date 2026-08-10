import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
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

  @ApiPropertyOptional({
    description:
      'PATH en el bucket documentos-flota de la copia de la póliza; null explícito = quitar el archivo.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  @Matches(/^oficina\/[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'archivo_url debe ser un path oficina/<archivo> del bucket',
  })
  archivo_url?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateAeronaveSeguroDto extends PartialType(CreateAeronaveSeguroDto) {}
