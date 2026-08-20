import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// OJO: @Type(() => Boolean) convierte el string "false" del querystring en
// true (Boolean('false') === true). Este transform respeta el valor real.
const boolQuery = ({ value }: { value: unknown }): boolean | undefined =>
  value === undefined ? undefined : value === true || value === 'true';

export class CalendarRangeQuery {
  @ApiPropertyOptional({ description: 'Desde (ISO). Default: hoy' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Hasta (ISO). Default: hoy + 30 días' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({
    description:
      'Incluir vuelos CANCELADOS (rojo, historial). Default: true desde ago 2026; false los excluye.',
  })
  @IsOptional()
  @Transform(boolQuery)
  @IsBoolean()
  incluir_cancelados?: boolean;

  @ApiPropertyOptional({ description: 'Incluir solo externos (rosa)' })
  @IsOptional()
  @Transform(boolQuery)
  @IsBoolean()
  solo_externos?: boolean;
}

/**
 * Evento NO-vuelo del calendario (21-ago-2026): lavado de avión, trámites,
 * visitas — se agenda desde la app/panel y sale en GET /v1/calendar.
 */
export class CreateEventoFlotaDto {
  @ApiProperty({ description: 'Qué es (ej. "Lavado XA-VGV", "Trámite AFAC")' })
  @IsString()
  @MaxLength(120)
  titulo!: string;

  @ApiProperty({ description: 'Fecha y hora del evento (ISO, hora Cancún)' })
  @Type(() => Date)
  @IsDate()
  fecha!: Date;

  @ApiPropertyOptional({ description: 'Fin (eventos de varios días)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_fin?: Date;

  @ApiPropertyOptional({ description: 'Avión relacionado (opcional)' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Responsable (opcional)' })
  @IsOptional()
  @IsUUID()
  responsable_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}
