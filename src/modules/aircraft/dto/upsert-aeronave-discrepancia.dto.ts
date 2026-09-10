import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export const SEVERIDADES_DISCREPANCIA = ['BAJA', 'MEDIA', 'ALTA'] as const;
export const ESTADOS_DISCREPANCIA = [
  'ABIERTA',
  'EN_PROGRESO',
  'RESUELTA',
] as const;
export type EstadoDiscrepancia = (typeof ESTADOS_DISCREPANCIA)[number];

export class CreateDiscrepanciaDto {
  @ApiProperty({ description: 'Falla o anomalía reportada' })
  @IsString()
  descripcion!: string;

  @ApiPropertyOptional({ enum: SEVERIDADES_DISCREPANCIA, default: 'MEDIA' })
  @IsOptional()
  @IsIn(SEVERIDADES_DISCREPANCIA)
  severidad?: 'BAJA' | 'MEDIA' | 'ALTA';

  @ApiPropertyOptional({ enum: ESTADOS_DISCREPANCIA, default: 'ABIERTA' })
  @IsOptional()
  @IsIn(ESTADOS_DISCREPANCIA)
  estado?: EstadoDiscrepancia;

  @ApiPropertyOptional({ description: 'Vuelo donde se detectó (opcional)' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default hoy)' })
  @IsOptional()
  @IsDateString()
  fecha_reporte?: string;

  @ApiPropertyOptional({ description: 'Cómo se resolvió' })
  @IsOptional()
  @IsString()
  resolucion?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_resolucion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Llave de IDEMPOTENCIA generada por el cliente (uuid v4, una por ' +
      'captura; outbox de la app, 10-sep-2026). Un reintento con la misma ' +
      'llave devuelve el reporte YA creado (200, idempotente:true) en vez de ' +
      'duplicar el squawk. Índice único uq_discrepancia_client_request; ' +
      'mientras la columna no exista en BD se ignora (alta sin idempotencia).',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

/**
 * Edición/resolución de un squawk. Hereda `client_request_id` del alta pero
 * el PATCH lo IGNORA (la llave se fija una sola vez al crear).
 */
export class UpdateDiscrepanciaDto extends PartialType(CreateDiscrepanciaDto) {
  @ApiPropertyOptional({
    description:
      'Control de versión (doc 6.1, gana el servidor + aviso): `updated_at` ' +
      'del reporte tal como lo leyó el cliente (ISO). Si alguien lo modificó ' +
      'después, el PATCH no aplica y responde 409 CONFLICTO_VERSION con ' +
      '`details.actual`. Omitido = comportamiento de siempre (último gana).',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  if_updated_at?: string;
}
