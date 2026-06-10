import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum EstadoVuelo {
  RESERVA = 'RESERVA',
  SOLICITUD = 'SOLICITUD',
  COTIZADO = 'COTIZADO',
  CONFIRMADO = 'CONFIRMADO',
  EN_VUELO = 'EN_VUELO',
  COMPLETADO = 'COMPLETADO',
  CANCELADO = 'CANCELADO',
}

export class ListQuotesQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ enum: EstadoVuelo })
  @IsOptional()
  @IsEnum(EstadoVuelo)
  estado?: EstadoVuelo;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  es_externo?: boolean;

  @ApiPropertyOptional({ description: 'Búsqueda por folio, origen, destino' })
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

export class CancelQuoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  motivo?: string;
}
