import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateAeronaveSocioDto {
  @ApiProperty({ description: 'Usuario id del socio (persona o empresa)' })
  @IsUUID()
  socio_id!: string;

  @ApiProperty({ minimum: 0.001, maximum: 100, description: 'Porcentaje de propiedad' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(100)
  porcentaje!: number;

  @ApiProperty({ description: 'Fecha de inicio del régimen', example: '2026-01-01' })
  @Type(() => Date)
  @IsDate()
  vigente_desde!: Date;

  @ApiPropertyOptional({ description: 'Si se omite, el régimen queda abierto' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  vigente_hasta?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateAeronaveSocioDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(100)
  porcentaje?: number;

  @ApiPropertyOptional({ description: 'Cerrar régimen poniendo vigente_hasta' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  vigente_hasta?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
