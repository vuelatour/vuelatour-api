import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const ESTADOS_GRUPO = [
  'RESERVA',
  'COTIZADO',
  'CONFIRMADO_PARCIAL',
  'CONFIRMADO',
  'EN_CURSO',
  'COMPLETADO',
  'CANCELADO',
] as const;

export class ListGruposQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional({
    description: 'Desde (YYYY-MM-DD, día Cancún) por fecha_vuelo.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desde?: string;

  @ApiPropertyOptional({
    description: 'Hasta (YYYY-MM-DD, día Cancún) por fecha_vuelo.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hasta?: string;

  @ApiPropertyOptional({
    enum: ESTADOS_GRUPO,
    description:
      'Estado DERIVADO de los hijos (se filtra en memoria sobre la página leída).',
  })
  @IsOptional()
  @IsIn([...ESTADOS_GRUPO])
  estado?: (typeof ESTADOS_GRUPO)[number];

  @ApiPropertyOptional({ description: 'Folio (G-12 / 12) o nombre.' })
  @IsOptional()
  @IsString()
  q?: string;

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
