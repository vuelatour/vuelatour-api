import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAeronaveImagenDto {
  @ApiProperty({
    description: 'Path dentro del bucket Storage (ej. uuid/uuid.jpg)',
  })
  @IsString()
  @MaxLength(500)
  storage_path!: string;

  @ApiProperty({
    description: 'URL publica (o firmada) del archivo en Storage',
  })
  @IsUrl({ require_tld: false })
  @MaxLength(1000)
  url!: string;

  @ApiPropertyOptional({ description: 'Texto alternativo accesible' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt_text?: string;

  @ApiPropertyOptional({
    description: 'Marcar como imagen principal de la aeronave',
  })
  @IsOptional()
  @IsBoolean()
  es_principal?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  size_bytes?: number;

  @ApiPropertyOptional({ description: 'MIME type del archivo' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  content_type?: string;
}

export class UpdateAeronaveImagenDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt_text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  es_principal?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orden?: number;
}

export class ReorderAeronaveImagenesDto {
  @ApiProperty({
    description: 'Ids ordenados en la posicion deseada (orden = indice)',
  })
  @IsString({ each: true })
  ids!: string[];
}
