import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
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

  @ApiPropertyOptional({
    description:
      'Incluir mantenimientos PROGRAMADO/EN_TALLER con fecha (tipo_evento "mantenimiento"). OPT-IN a propósito: el APK viejo no conoce ese tipo — panel y app nueva lo piden explícito.',
  })
  @IsOptional()
  @Transform(boolQuery)
  @IsBoolean()
  incluir_mantenimientos?: boolean;
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

/**
 * Edición de un evento NO-vuelo (3-sep-2026). Todo opcional: `undefined` =
 * no tocar; `null` en avión/responsable/fin/notas = limpiar. Cambiar de
 * responsable avisa al nuevo y al anterior; cambios de fecha/avión/título/
 * notas avisan 'evento_actualizado' al responsable vigente.
 */
export class UpdateEventoFlotaDto extends PartialType(CreateEventoFlotaDto) {}

/** Rango de GET /v1/me/eventos: días YYYY-MM-DD Cancún (default hoy-7 → hoy+90). */
export class MisEventosQuery {
  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD, día Cancún)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'desde debe ser una fecha YYYY-MM-DD',
  })
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD, día Cancún)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'hasta debe ser una fecha YYYY-MM-DD',
  })
  hasta?: string;
}
