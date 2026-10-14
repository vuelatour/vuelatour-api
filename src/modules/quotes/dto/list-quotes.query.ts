import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import {
  IsBoolean,
  IsDateString,
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

  @ApiPropertyOptional({
    description:
      'Búsqueda por folio, ID del cliente (diego02 o diego02-211026), origen, destino, cliente o ciudad',
  })
  @IsOptional()
  @IsString()
  q?: string;

  // Rango sobre `fecha_vuelo` (13-oct-2026, decisión 5 del lote): mismo
  // patrón que `ListFlightsQuery`; también viaja a `/vecinos` (flechas).
  // String (no Date): una fecha simple se corta en día CANCÚN; pasarla por
  // `new Date()` la vuelve medianoche UTC y mueve vuelos de día/mes.
  @ApiPropertyOptional({
    description:
      'fecha_vuelo >= (YYYY-MM-DD = día Cancún desde las 00:00, o ISO con hora tal cual). Con desde/hasta las cotizaciones SIN fecha de vuelo quedan fuera.',
  })
  @IsOptional()
  @IsDateString(
    {},
    { message: 'desde debe ser una fecha YYYY-MM-DD o un instante ISO 8601' },
  )
  desde?: string;

  @ApiPropertyOptional({
    description:
      'fecha_vuelo <= (YYYY-MM-DD = día Cancún hasta las 23:59:59, o ISO con hora tal cual). Con desde/hasta las cotizaciones SIN fecha de vuelo quedan fuera.',
  })
  @IsOptional()
  @IsDateString(
    {},
    { message: 'hasta debe ser una fecha YYYY-MM-DD o un instante ISO 8601' },
  )
  hasta?: string;

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
 * `forbidNonWhitelisted` mandarlos es 400). El rango `desde`/`hasta`
 * (13-oct-2026) también viaja: las cuatro consultas de las flechas lo llevan
 * y el ancla (la cotización abierta) puede quedar fuera de él.
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
