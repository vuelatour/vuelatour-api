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

export enum PosicionMotor {
  UNICO = 'UNICO',
  IZQUIERDO = 'IZQUIERDO',
  DERECHO = 'DERECHO',
}

export enum TipoMotor {
  PISTON = 'PISTON',
  TURBINA = 'TURBINA',
}

export class ListEnginesQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ enum: TipoMotor })
  @IsOptional()
  @IsEnum(TipoMotor)
  tipo?: TipoMotor;

  @ApiPropertyOptional({ enum: PosicionMotor })
  @IsOptional()
  @IsEnum(PosicionMotor)
  posicion?: PosicionMotor;

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

export class CreateEngineDto {
  @ApiProperty()
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ enum: PosicionMotor, default: PosicionMotor.UNICO })
  @IsEnum(PosicionMotor)
  posicion!: PosicionMotor;

  @ApiProperty({ minLength: 1, maxLength: 50 })
  @IsString()
  @MinLength(1)
  numero_serie!: string;

  @ApiProperty({ enum: TipoMotor })
  @IsEnum(TipoMotor)
  tipo!: TipoMotor;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fabricante?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  modelo?: string;

  @ApiPropertyOptional({
    description: 'Horas lineales desde fabricación',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  horas_totales?: number;

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
      'TURM en marco del COMPONENTE (como la bitácora física): horas de vida del motor en su último overhaul. TSO = horas de vida − TURM. Viaja con el motor al trasladarlo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  turm_componente?: number;

  @ApiProperty({ description: 'Time Between Overhauls (horas)', example: 1700 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  tbo_horas!: number;

  @ApiPropertyOptional({
    description:
      'Fecha límite CALENDARIO del overhaul (TBO por tiempo, ej. 12 años). null = solo por horas.',
  })
  @IsOptional()
  @IsDateString()
  tbo_fecha?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateEngineDto extends PartialType(CreateEngineDto) {}

export class OverhaulEngineDto {
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

export class TransplantEngineDto {
  @ApiProperty({ description: 'Nueva aeronave destino' })
  @IsUUID()
  aeronave_destino_id!: string;

  @ApiProperty({
    enum: PosicionMotor,
    description: 'Posición en la aeronave destino',
  })
  @IsEnum(PosicionMotor)
  posicion_destino!: PosicionMotor;

  @ApiProperty({ description: 'Motivo del traslado' })
  @IsString()
  @MinLength(3)
  motivo!: string;
}
