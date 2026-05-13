import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CalculateQuoteDto } from './calculate-quote.dto';

export enum TipoVuelo {
  SENCILLO = 'SENCILLO',
  REDONDO = 'REDONDO',
  MULTIESCALA = 'MULTIESCALA',
}

export class CreateQuoteDto extends CalculateQuoteDto {
  @ApiProperty({ description: 'Cliente que solicita el vuelo' })
  @IsUUID()
  cliente_id!: string;

  @ApiPropertyOptional({ enum: TipoVuelo, default: TipoVuelo.REDONDO })
  @IsOptional()
  @IsEnum(TipoVuelo)
  tipo?: TipoVuelo;

  @ApiPropertyOptional({ description: 'Fecha programada del vuelo (ISO)', example: '2026-06-15T09:00:00Z' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ description: 'Notas visibles para el cliente (aparecen en PDF)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({ description: 'Notas internas del equipo (no van al cliente)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;
}
