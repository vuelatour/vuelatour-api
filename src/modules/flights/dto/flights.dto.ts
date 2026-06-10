import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EstadoVuelo } from '../../quotes/dto/list-quotes.query';

export class TacoStatusDto {
  @ApiProperty({ type: [String], description: 'IDs de vuelo a evaluar' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class VoucherUrlsDto {
  @ApiProperty({ type: [String], description: 'Paths de vouchers en cobro-vouchers a firmar' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  paths!: string[];
}

export enum EstadoPermiso {
  NO_APLICA = 'no_aplica',
  PENDIENTE = 'pendiente',
  EMITIDO = 'emitido',
}

export class ListFlightsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ enum: EstadoVuelo })
  @IsOptional()
  @IsEnum(EstadoVuelo)
  estado?: EstadoVuelo;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  es_externo?: boolean;

  @ApiPropertyOptional({ description: 'fecha_vuelo >= (ISO)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  desde?: Date;

  @ApiPropertyOptional({ description: 'fecha_vuelo <= (ISO)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hasta?: Date;

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

export class UpdateFlightDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Fecha de traslado inicial / salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ description: 'Fecha de traslado final / regreso a base' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;

  @ApiPropertyOptional({ enum: EstadoPermiso, description: 'Estado del permiso de pista' })
  @IsOptional()
  @IsEnum(EstadoPermiso)
  estado_permiso?: EstadoPermiso;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  facturado?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cobrado?: boolean;
}

export class UpdatePermisoDto {
  @ApiProperty({ enum: EstadoPermiso, description: 'Estado del permiso de pista' })
  @IsEnum(EstadoPermiso)
  estado_permiso!: EstadoPermiso;
}

export class SetFlightPlanDto {
  @ApiProperty({ description: 'URL/path en Storage de la foto del plan de vuelo' })
  @IsString()
  foto_plan_vuelo_url!: string;
}

export class CancelFlightDto {
  @ApiProperty({
    description: 'Motivo de la cancelación. Queda auditado en notas_internas.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;
}

export class AssignFlightDto {
  @ApiPropertyOptional({
    description: 'Aeronave asignada (solo si no es externo)',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Piloto asignado' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Fecha programada del vuelo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;
}

export class CreateExternalFlightDto {
  @ApiProperty()
  @IsUUID()
  cliente_id!: string;

  @ApiProperty({ description: 'Operador externo (ej. XA-TIB)' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo!: string;

  @ApiProperty({ description: 'Lo que cobra el operador externo (USD)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd!: number;

  @ApiProperty({ description: 'Monto total cobrado al cliente (USD)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_total_usd!: number;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas_internas?: string;
}

/**
 * Reserva tentativa: aparta el espacio en el calendario SIN cotización
 * (el cliente aún no confirma o faltan costos para cotizar). Vuelo propio.
 */
export class CreateReservaDto {
  @ApiProperty()
  @IsUUID()
  cliente_id!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ description: 'Destino tentativo (primer destino conocido si es vuelo abierto)' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ description: 'Fecha/hora apartada (salida)' })
  @Type(() => Date)
  @IsDate()
  fecha_vuelo!: Date;

  @ApiPropertyOptional({ description: 'Fecha/hora del regreso (si se conoce)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros?: number;

  @ApiPropertyOptional({ description: 'Aeronave tentativa' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Piloto tentativo' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Vuelo abierto: el itinerario/precio se cierra al final' })
  @IsOptional()
  @IsBoolean()
  cotizacion_abierta?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;
}
