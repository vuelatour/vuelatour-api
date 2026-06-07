import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const ESTADOS_MANTENIMIENTO = ['PROGRAMADO', 'EN_TALLER', 'COMPLETADO'] as const;
export type EstadoMantenimiento = (typeof ESTADOS_MANTENIMIENTO)[number];
const PAISES_SERVICIO = ['MX', 'USA'] as const;

export class CreateMantenimientoDto {
  @ApiProperty({
    enum: ESTADOS_MANTENIMIENTO,
    description: 'Ciclo del servicio: programado → en taller → completado',
  })
  @IsIn(ESTADOS_MANTENIMIENTO)
  estado!: EstadoMantenimiento;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  descripcion!: string;

  @ApiPropertyOptional({ enum: PAISES_SERVICIO, description: 'País del servicio (MX/USA)' })
  @IsOptional()
  @IsIn(PAISES_SERVICIO)
  pais?: 'MX' | 'USA';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_programada?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_realizada?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_aeronave?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costo_usd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proveedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateMantenimientoDto {
  @ApiPropertyOptional({ enum: ESTADOS_MANTENIMIENTO })
  @IsOptional()
  @IsIn(ESTADOS_MANTENIMIENTO)
  estado?: EstadoMantenimiento;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional({ enum: PAISES_SERVICIO })
  @IsOptional()
  @IsIn(PAISES_SERVICIO)
  pais?: 'MX' | 'USA';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_programada?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_realizada?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_aeronave?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costo_usd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proveedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class CreateVencimientoDto {
  @ApiProperty()
  @IsUUID()
  tipo_documento_id!: string;

  @ApiProperty({ enum: ['FECHA', 'HORAS', 'PERMANENTE'] })
  @IsIn(['FECHA', 'HORAS', 'PERMANENTE'])
  vence_por!: 'FECHA' | 'HORAS' | 'PERMANENTE';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (si vence_por=FECHA)' })
  @IsOptional()
  @IsDateString()
  fecha_vencimiento?: string;

  @ApiPropertyOptional({ description: 'Horas límite (si vence_por=HORAS)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_limite?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  umbral_alerta_dias?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  motor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
