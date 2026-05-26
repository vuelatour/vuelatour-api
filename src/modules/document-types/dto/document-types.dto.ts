import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum AmbitoDocumento {
  AERONAVE = 'AERONAVE',
  PILOTO = 'PILOTO',
  MOTOR = 'MOTOR',
}

export enum FormaVencimiento {
  FECHA = 'FECHA',
  HORAS = 'HORAS',
  PERMANENTE = 'PERMANENTE',
}

export class ListTiposDocumentoQuery {
  @ApiPropertyOptional({ description: 'Busca en el nombre' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: AmbitoDocumento })
  @IsOptional()
  @IsEnum(AmbitoDocumento)
  ambito?: AmbitoDocumento;

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

export class CreateTipoDocumentoDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  nombre!: string;

  @ApiProperty({ enum: AmbitoDocumento })
  @IsEnum(AmbitoDocumento)
  ambito!: AmbitoDocumento;

  @ApiPropertyOptional({
    enum: FormaVencimiento,
    default: FormaVencimiento.FECHA,
  })
  @IsOptional()
  @IsEnum(FormaVencimiento)
  forma_default?: FormaVencimiento;

  @ApiPropertyOptional({
    description: 'Dias de anticipacion para alertar',
    default: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  umbral_alerta_dias?: number;

  @ApiPropertyOptional({
    description: 'Vencido bloquea asignacion de vuelos',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  es_critico?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateTipoDocumentoDto extends PartialType(
  CreateTipoDocumentoDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
