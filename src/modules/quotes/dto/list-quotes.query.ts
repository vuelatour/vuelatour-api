import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
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
  @ToBooleanQuery()
  @IsBoolean()
  es_externo?: boolean;

  @ApiPropertyOptional({
    description:
      'Solo los hijos de una cotización de GRUPO (vuelo.grupo_id). Cada fila trae grupo_posicion, grupo_pax y el embed grupo {id, folio, nombre, pasajeros_total}.',
  })
  @IsOptional()
  @IsUUID()
  grupo_id?: string;

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

/**
 * Filtros de las FLECHAS «‹ Anterior» / «Siguiente ›» del detalle de una
 * cotización (24-sep-2026, pedido de Itzi: «estando adentro de la cotización
 * me pueda brincar a la siguiente»). Son EXACTAMENTE los de la lista
 * (`GET /quotes`) sin paginar: las flechas recorren lo mismo que el operador
 * veía en la lista de donde vino. `limit`/`offset` no existen aquí (con
 * `forbidNonWhitelisted` mandarlos es 400).
 */
export class VecinosQuotesQuery extends OmitType(ListQuotesQuery, [
  'limit',
  'offset',
] as const) {}

/** Una cotización vecina (la anterior o la siguiente en el tiempo). */
export interface QuoteVecino {
  id: string;
  folio: number;
  /** timestamptz del vuelo (nunca null: sin fecha no hay vecino). */
  fecha_vuelo: string;
  estado: EstadoVuelo;
  /** Nombre del cliente; null si no se resolvió (nunca se inventa). */
  cliente_nombre: string | null;
}

/** Respuesta de `GET /v1/quotes/:id/vecinos`. */
export interface QuoteVecinosRespuesta {
  anterior: QuoteVecino | null;
  siguiente: QuoteVecino | null;
  /** La cotización actual no tiene fecha de vuelo: no hay orden cronológico. */
  sin_fecha: boolean;
}

export class CancelQuoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  motivo?: string;
}
