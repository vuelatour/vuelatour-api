import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum MonedaCaja {
  MXN = 'MXN',
  USD = 'USD',
}

export enum TipoMovimientoCaja {
  REPOSICION = 'REPOSICION',
  REINTEGRO = 'REINTEGRO',
  AJUSTE = 'AJUSTE',
}

export class ListFondosQuery {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateFondoDto {
  @ApiProperty({ description: 'Usuario dueño del fondo' })
  @IsUUID()
  usuario_id!: string;

  @ApiPropertyOptional({ enum: MonedaCaja, default: MonedaCaja.MXN })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateFondoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ enum: MonedaCaja })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class CreateCajaMovimientoDto {
  @ApiProperty({ enum: TipoMovimientoCaja })
  @IsEnum(TipoMovimientoCaja)
  tipo!: TipoMovimientoCaja;

  @ApiProperty({
    description:
      'Monto. REPOSICION y REINTEGRO deben ser > 0. AJUSTE puede ser negativo (corrección a la baja).',
  })
  @Type(() => Number)
  @IsNumber()
  monto!: number;

  @ApiPropertyOptional({ enum: MonedaCaja })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional({ description: 'Fecha del movimiento (default hoy)' })
  @IsOptional()
  @IsISO8601()
  fecha?: string;

  @ApiPropertyOptional({ description: 'Quién autoriza (ej. Ale en una reposición)' })
  @IsOptional()
  @IsUUID()
  autorizado_por?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
