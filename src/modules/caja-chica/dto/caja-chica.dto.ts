import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Tope por default / máximo de filas del historial de MI caja. */
export const MI_CAJA_HISTORIAL_LIMIT_DEFAULT = 500;
export const MI_CAJA_HISTORIAL_LIMIT_MAX = 1000;
/** Ventana por default del historial de MI caja: últimos 6 meses. */
export const MI_CAJA_HISTORIAL_MESES_ATRAS = 6;

/**
 * GET /v1/me/caja-chica/movimientos (5-sep-2026): ventana en días Cancún
 * sobre las fechas de pared del libro (`caja_chica_movimiento.fecha` y
 * `gasto.fecha_gasto` son `date`). Default: últimos 6 meses, hasta abierto.
 * El saldo corrido SIEMPRE se calcula sobre el libro completo; la ventana
 * solo recorta lo que se devuelve.
 */
export class MiCajaHistorialQuery {
  @ApiPropertyOptional({
    description: 'Desde (YYYY-MM-DD, día Cancún). Default: hoy − 6 meses.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'desde debe ser una fecha YYYY-MM-DD',
  })
  desde?: string;

  @ApiPropertyOptional({
    description: 'Hasta (YYYY-MM-DD, día Cancún, inclusive). Default: abierto.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'hasta debe ser una fecha YYYY-MM-DD',
  })
  hasta?: string;

  @ApiPropertyOptional({
    default: MI_CAJA_HISTORIAL_LIMIT_DEFAULT,
    minimum: 1,
    maximum: MI_CAJA_HISTORIAL_LIMIT_MAX,
    description:
      'Máximo de movimientos devueltos (los más recientes de la ventana). `count` trae el total de la ventana.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MI_CAJA_HISTORIAL_LIMIT_MAX)
  limit: number = MI_CAJA_HISTORIAL_LIMIT_DEFAULT;
}

export enum MonedaCaja {
  MXN = 'MXN',
  USD = 'USD',
}

export enum TipoMovimientoCaja {
  REPOSICION = 'REPOSICION',
  REINTEGRO = 'REINTEGRO',
  AJUSTE = 'AJUSTE',
}

export class ListFondosQuery {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @ToBooleanQuery()
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

export class CreateFondoDto {
  @ApiProperty({ description: 'Usuario dueño del fondo' })
  @IsUUID()
  usuario_id!: string;

  @ApiPropertyOptional({ enum: MonedaCaja, default: MonedaCaja.MXN })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional({
    description:
      'Caja ACUMULADA (al revés): el saldo es lo POR REPONER — sube al gastar y vuelve a 0 al reponer. Para admins/pilotos que gastan de su bolsa.',
  })
  @IsOptional()
  @IsBoolean()
  es_acumulada?: boolean;

  @ApiPropertyOptional({
    description:
      'Monto nominal del fondo ("su caja es de $6,000"): habilita "por reponer" = fondo − saldo en el panel. Opcional.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  monto_fondo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateFondoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({
    description:
      'Caja MADRE que fondea a esta (null = quitar el vínculo): cada REPOSICIÓN aquí genera un REINTEGRO espejo en la madre. Se configura desde Usuarios.',
  })
  @IsOptional()
  @ValidateIf((o: UpdateFondoDto) => o.fondo_origen_id !== null)
  @IsUUID()
  fondo_origen_id?: string | null;

  @ApiPropertyOptional({
    description:
      'Al vincular: genera también los espejos de las REPOSICIONES YA registradas en esta caja (descuenta el fondeo histórico de la madre).',
  })
  @IsOptional()
  @IsBoolean()
  retroactivo?: boolean;

  @ApiPropertyOptional({
    description: 'Cambiar el modo de la caja (acumulada / fondo clásico).',
  })
  @IsOptional()
  @IsBoolean()
  es_acumulada?: boolean;

  @ApiPropertyOptional({ enum: MonedaCaja })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional({
    description: 'Monto nominal del fondo (a cuánto se repone).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  monto_fondo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class CreateCajaMovimientoDto {
  @ApiProperty({ enum: TipoMovimientoCaja })
  @IsEnum(TipoMovimientoCaja)
  tipo!: TipoMovimientoCaja;

  @ApiProperty({
    description:
      'Monto. REPOSICION y REINTEGRO deben ser > 0. AJUSTE puede ser negativo (corrección a la baja).',
  })
  @Type(() => Number)
  @IsNumber()
  monto!: number;

  @ApiPropertyOptional({ enum: MonedaCaja })
  @IsOptional()
  @IsEnum(MonedaCaja)
  moneda?: MonedaCaja;

  @ApiPropertyOptional({ description: 'Fecha del movimiento (default hoy)' })
  @IsOptional()
  @IsISO8601()
  fecha?: string;

  @ApiPropertyOptional({
    description: 'Quién autoriza (ej. Ale en una reposición)',
  })
  @IsOptional()
  @IsUUID()
  autorizado_por?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

/**
 * Corrección de un movimiento ya registrado (caso Mari, 18-ago: el ingreso
 * quedó sin la fecha real y no había forma de corregirlo). La moneda no se
 * edita: la del fondo manda.
 */
export class UpdateCajaMovimientoDto extends PartialType(
  CreateCajaMovimientoDto,
) {}
