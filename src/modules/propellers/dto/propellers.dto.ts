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
      'LEGADO: tacómetro del avión en el último overhaul (escala del taco del avión; no sobrevive traslados). Usar turm_componente.',
    default: 0,
    deprecated: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  turm?: number;

  @ApiPropertyOptional({
    description:
      'TURM en marco del COMPONENTE (como la bitácora física): horas de vida de la hélice en su último overhaul. TSO = horas de vida − TURM. Viaja con la hélice al trasladarla.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  turm_componente?: number;

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

export class TransplantPropellerDto {
  @ApiProperty({ description: 'Nueva aeronave destino' })
  @IsUUID()
  aeronave_destino_id!: string;

  @ApiProperty({
    enum: PosicionHelice,
    description: 'Posición en la aeronave destino',
  })
  @IsEnum(PosicionHelice)
  posicion_destino!: PosicionHelice;

  @ApiProperty({ description: 'Motivo del traslado' })
  @IsString()
  @MinLength(3)
  motivo!: string;
}

export class OverhaulPropellerDto {
  @ApiPropertyOptional({
    description: 'Fecha del overhaul (YYYY-MM-DD); default hoy (Cancún)',
  })
  @IsOptional()
  @IsDateString()
  fecha?: string;

  @ApiPropertyOptional({
    description: 'Notas / taller / referencia del overhaul',
  })
  @IsOptional()
  @IsString()
  motivo?: string;

  @ApiPropertyOptional({ description: 'Nuevo TBO en horas (si cambió)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  tbo_horas?: number;

  @ApiPropertyOptional({
    description: 'Nuevo límite calendario del overhaul (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  tbo_fecha?: string | null;
}
