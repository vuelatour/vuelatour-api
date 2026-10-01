import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  BUCKETS_FIRMABLES,
  LARGO_MAX_PATH,
  MAX_PATHS_FIRMA,
} from '../storage-firma.util';

/**
 * `POST /v1/storage/firmar` (1-oct-2026). El bucket se valida contra la lista
 * blanca en el service (400 `BUCKET_NO_PERMITIDO` con código propio, no el
 * 400 genérico del ValidationPipe).
 */
export class FirmarStorageDto {
  @ApiProperty({
    enum: BUCKETS_FIRMABLES,
    description:
      'Bucket privado del archivo. Solo la lista blanca; cada bucket con sus roles (ROLES_POR_BUCKET).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  bucket!: string;

  @ApiProperty({
    type: [String],
    description: `Rutas DENTRO del bucket (como se guardan en la BD, p. ej. foto_url). Máximo ${MAX_PATHS_FIRMA}.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_PATHS_FIRMA, {
    message: `Máximo ${MAX_PATHS_FIRMA} archivos por solicitud.`,
  })
  @IsString({ each: true })
  @MaxLength(LARGO_MAX_PATH, { each: true })
  paths!: string[];
}
