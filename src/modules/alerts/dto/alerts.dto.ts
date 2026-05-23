import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

const ROLES = ['ADMIN', 'COORDINADOR', 'ANALISTA', 'FACTURACION', 'PILOTO', 'SOCIO'];

export class UpdateAlertConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({ enum: ['socket', 'email', 'ambos'] })
  @IsOptional()
  @IsIn(['socket', 'email', 'ambos'])
  canal?: 'socket' | 'email' | 'ambos';

  @ApiPropertyOptional({ type: [String], enum: ROLES })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ROLES, { each: true })
  roles?: string[];

  @ApiPropertyOptional({ type: [Number], description: 'Días de anticipación (alertas por fecha)' })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  dias_anticipacion?: number[];

  @ApiPropertyOptional({ description: 'Horas de anticipación (alertas por hora, ej. permiso de pista)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  horas_anticipacion?: number | null;
}
