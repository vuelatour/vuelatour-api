import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

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
}

export class UpdateEscalaDto extends PartialType(CreateEscalaDto) {}

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
}
