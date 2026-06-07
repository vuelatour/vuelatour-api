import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export const SEVERIDADES_DISCREPANCIA = ['BAJA', 'MEDIA', 'ALTA'] as const;
export const ESTADOS_DISCREPANCIA = ['ABIERTA', 'EN_PROGRESO', 'RESUELTA'] as const;
export type EstadoDiscrepancia = (typeof ESTADOS_DISCREPANCIA)[number];

export class CreateDiscrepanciaDto {
  @ApiProperty({ description: 'Falla o anomalía reportada' })
  @IsString()
  descripcion!: string;

  @ApiPropertyOptional({ enum: SEVERIDADES_DISCREPANCIA, default: 'MEDIA' })
  @IsOptional()
  @IsIn(SEVERIDADES_DISCREPANCIA)
  severidad?: 'BAJA' | 'MEDIA' | 'ALTA';

  @ApiPropertyOptional({ enum: ESTADOS_DISCREPANCIA, default: 'ABIERTA' })
  @IsOptional()
  @IsIn(ESTADOS_DISCREPANCIA)
  estado?: EstadoDiscrepancia;

  @ApiPropertyOptional({ description: 'Vuelo donde se detectó (opcional)' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default hoy)' })
  @IsOptional()
  @IsDateString()
  fecha_reporte?: string;

  @ApiPropertyOptional({ description: 'Cómo se resolvió' })
  @IsOptional()
  @IsString()
  resolucion?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_resolucion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateDiscrepanciaDto extends PartialType(CreateDiscrepanciaDto) {}
