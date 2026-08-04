import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export enum PosicionHelice {
  UNICA = 'UNICA',
  IZQUIERDA = 'IZQUIERDA',
  DERECHA = 'DERECHA',
}

export class ListPropellersQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ enum: PosicionHelice })
  @IsOptional()
  @IsEnum(PosicionHelice)
  posicion?: PosicionHelice;

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

export class CreatePropellerDto {
  @ApiProperty()
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ enum: PosicionHelice, default: PosicionHelice.UNICA })
  @IsEnum(PosicionHelice)
  posicion!: PosicionHelice;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  numero_serie!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fabricante?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  modelo?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  horas_totales?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  tbo_horas?: number;

  @ApiPropertyOptional({
    description:
      'TURM: tacómetro del avión en el último overhaul de la hélice (misma escala que los tacos)',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  turm?: number;

  @ApiPropertyOptional({
    description:
      'Fecha límite CALENDARIO del overhaul (TBO por tiempo, ej. 6 años). null = solo por horas.',
  })
  @IsOptional()
  @IsDateString()
  tbo_fecha?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdatePropellerDto extends PartialType(CreatePropellerDto) {}
