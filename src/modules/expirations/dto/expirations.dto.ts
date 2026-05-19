import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AmbitoDocumento,
  FormaVencimiento,
} from '../../document-types/dto/document-types.dto';

export { AmbitoDocumento, FormaVencimiento };

export enum EstadoVencimiento {
  VIGENTE = 'VIGENTE',
  PROXIMO = 'PROXIMO',
  VENCIDO = 'VENCIDO',
  PERMANENTE = 'PERMANENTE',
  INDETERMINADO = 'INDETERMINADO',
}

export class ListVencimientosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  motor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tipo_documento_id?: string;

  @ApiPropertyOptional({ enum: AmbitoDocumento })
  @IsOptional()
  @IsEnum(AmbitoDocumento)
  ambito?: AmbitoDocumento;

  @ApiPropertyOptional({
    enum: EstadoVencimiento,
    description: 'Estado calculado',
  })
  @IsOptional()
  @IsEnum(EstadoVencimiento)
  estado?: EstadoVencimiento;

  @ApiPropertyOptional({ default: 300 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 300;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateVencimientoDto {
  @ApiProperty()
  @IsUUID()
  tipo_documento_id!: string;

  @ApiProperty({ enum: FormaVencimiento })
  @IsEnum(FormaVencimiento)
  vence_por!: FormaVencimiento;

  @ApiPropertyOptional({
    description: 'Aeronave objetivo (si el tipo es AERONAVE)',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description: 'Piloto objetivo (si el tipo es PILOTO)',
  })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Motor objetivo (si el tipo es MOTOR)' })
  @IsOptional()
  @IsUUID()
  motor_id?: string;

  @ApiPropertyOptional({
    description: 'Fecha de vencimiento (YYYY-MM-DD), si vence_por=FECHA',
  })
  @IsOptional()
  @IsDateString()
  fecha_vencimiento?: string;

  @ApiPropertyOptional({ description: 'Horas limite, si vence_por=HORAS' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  horas_limite?: number;

  @ApiPropertyOptional({
    description: 'Override del umbral de alerta del tipo (dias)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  umbral_alerta_dias?: number;

  @ApiPropertyOptional({ description: 'Numero de poliza / folio' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  archivo_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateVencimientoDto extends PartialType(CreateVencimientoDto) {}
