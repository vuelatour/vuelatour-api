import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { EstadoPermiso } from './flights.dto';

export class CreateEscalaDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orden!: number;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({ description: 'Hora programada de salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_salida?: Date;

  @ApiPropertyOptional({ description: 'Hora programada de llegada' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_llegada?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  // Campos operativos por tramo (también se editan en tramos internos).
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional({
    description: 'Nombres de pasajeros de este tramo (manifiesto por escala, opcional).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pasajeros_nombres?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({ enum: ['NORMAL', 'SERVICIO'] })
  @IsOptional()
  @IsIn(['NORMAL', 'SERVICIO'])
  tipo_parada?: 'NORMAL' | 'SERVICIO';

  @ApiPropertyOptional({ description: 'Detalle de la parada de servicio/técnica' })
  @IsOptional()
  @IsString()
  servicio_notas?: string;

  @ApiPropertyOptional({ description: 'Fecha/hora planeada de salida del tramo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_salida_plan?: Date;
}

export class UpdateEscalaDto extends PartialType(CreateEscalaDto) {}

/**
 * Tramo OPERATIVO interno (ferry, parada técnica, movimiento interno, pernocta
 * operativa): forma parte de la ruta real pero NO se cotiza ni se cobra ni se
 * muestra al cliente. El orden lo asigna el servidor en el rango operativo.
 */
export class OperationalLegDto {
  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({ enum: ['NORMAL', 'SERVICIO'] })
  @IsOptional()
  @IsIn(['NORMAL', 'SERVICIO'])
  tipo_parada?: 'NORMAL' | 'SERVICIO';

  @ApiPropertyOptional({ description: 'Detalle de la parada de servicio/técnica' })
  @IsOptional()
  @IsString()
  servicio_notas?: string;

  @ApiPropertyOptional({ description: 'Fecha/hora planeada de salida del tramo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_salida_plan?: Date;

  @ApiPropertyOptional({ description: 'Instrucción/justificación operativa para el piloto' })
  @IsOptional()
  @IsString()
  notas?: string;
}

/** Asignación de aeronave/piloto a UN tramo (ida o regreso por separado). */
export class AssignEscalaDto {
  @ApiPropertyOptional({ description: 'Aeronave asignada al tramo (solo si no es externo)' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Piloto asignado al tramo' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Fecha/hora planeada de salida del tramo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_salida_plan?: Date;
}

export class UpdateEscalaPermisoDto {
  @ApiProperty({ enum: EstadoPermiso, description: 'Estado del permiso de pista del tramo' })
  @IsEnum(EstadoPermiso)
  estado_permiso!: EstadoPermiso;
}

export class TacoAiReadDto {
  @ApiProperty({ enum: ['salida', 'llegada'], description: '¿Qué lectura se está tomando?' })
  @IsIn(['salida', 'llegada'])
  which!: 'salida' | 'llegada';

  @ApiPropertyOptional({ description: 'Imagen en base64 (sin prefijo data:). Requiere media_type.' })
  @IsOptional()
  @IsString()
  image_base64?: string;

  @ApiPropertyOptional({ enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] })
  @IsOptional()
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  media_type?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

  @ApiPropertyOptional({ description: 'URL pública/firmada de la imagen (alternativa a base64)' })
  @IsOptional()
  @IsString()
  image_url?: string;
}

export class CaptureTacoDto {
  @ApiPropertyOptional({ description: 'Lectura HOBBS de salida (horas)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taco_salida?: number;

  @ApiPropertyOptional({ description: 'Lectura HOBBS de llegada (horas)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taco_llegada?: number;

  @ApiPropertyOptional({ description: 'URL pública/path de la foto del tacómetro de salida' })
  @IsOptional()
  @IsString()
  foto_taco_salida_url?: string;

  @ApiPropertyOptional({ description: 'URL pública/path de la foto del tacómetro de llegada' })
  @IsOptional()
  @IsString()
  foto_taco_llegada_url?: string;

  @ApiPropertyOptional({ description: 'Valor propuesto por la IA antes de confirmación' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  valor_ia_propuesto?: number;

  @ApiPropertyOptional({ description: 'Hora real de salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_salida?: Date;

  @ApiPropertyOptional({ description: 'Hora real de llegada' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_llegada?: Date;

  @ApiPropertyOptional({ description: 'Captura realizada offline (sincroniza después)' })
  @IsOptional()
  @IsBoolean()
  capturado_offline?: boolean;

  @ApiPropertyOptional({
    description:
      'Foto sincronizada sin lectura confirmada por el piloto: el servidor intenta leerla con IA y marca la escala para revisión en oficina (amarillo). Nunca aplica la lectura IA como definitiva.',
  })
  @IsOptional()
  @IsBoolean()
  pendiente_lectura?: boolean;
}

export class ConfirmTacoDto {
  @ApiPropertyOptional({ description: 'Corrección de la lectura de salida (opcional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taco_salida?: number;

  @ApiPropertyOptional({ description: 'Corrección de la lectura de llegada (opcional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taco_llegada?: number;

  @ApiPropertyOptional({ description: 'Nota de la revisión/corrección (auditoría)' })
  @IsOptional()
  @IsString()
  nota?: string;
}
