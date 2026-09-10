import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsDate,
  IsISO8601,
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

  @ApiPropertyOptional({
    description:
      'Deltas al reconectar (10-sep-2026): solo entradas cuyo `updated_at` (vuelo o alguno de sus tramos, descanso, evento, mantenimiento) sea ≥ este instante ISO, más `eliminados` = ids de vuelos borrados desde entonces (vuelo_eliminado). Sin el parámetro, respuesta de siempre.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  updated_since?: Date;
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

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia (uuid) por captura (outbox de la app, 9-sep-2026): repetirla devuelve ' +
      'el evento YA creado (200, idempotente:true, aviso:null) sin volver a avisar al responsable.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  @ApiPropertyOptional({
    description:
      'Momento real de captura en la app (ISO con zona). Solo auditoría: se anexa a `notas` como ' +
      '"[Capturado en la app el … · recibido el …]"; NUNCA provoca 400.',
  })
  // Sin validadores a propósito: `@Allow()` solo lo deja pasar la whitelist
  // (un tipo raro o un texto largo tampoco deben rechazar: el sello
  // tolerante lo convierte a texto y lo recorta).
  @Allow()
  capturado_en?: string;
}

/**
 * Edición de un evento NO-vuelo (3-sep-2026). Todo opcional: `undefined` =
 * no tocar; `null` en avión/responsable/fin/notas = limpiar. Cambiar de
 * responsable avisa al nuevo y al anterior; cambios de fecha/avión/título/
 * notas avisan 'evento_actualizado' al responsable vigente.
 */
export class UpdateEventoFlotaDto extends PartialType(CreateEventoFlotaDto) {
  @ApiPropertyOptional({
    description:
      'Control de versión (doc 6.1, gana el servidor + aviso): `updated_at` del evento tal como lo leyó el cliente (ISO). ' +
      'Si alguien lo modificó después, el PATCH no aplica y responde 409 CONFLICTO_VERSION con `details.actual`. ' +
      'Omitido = comportamiento de siempre. Mientras `evento_flota` no tenga trigger de updated_at (migración 20260910000001) se ignora.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  if_updated_at?: string;
}

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
