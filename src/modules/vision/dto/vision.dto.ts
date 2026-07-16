import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// Tope de los adjuntos en base64: ~12 MB binarios ≈ 16M caracteres base64
// (4/3 del binario). El body global admite 25mb; esto corta antes payloads
// absurdos que solo queman memoria y timeout de la IA.
const MAX_BASE64_CHARS = 16_000_000;

export enum ImageMediaType {
  JPEG = 'image/jpeg',
  PNG = 'image/png',
  WEBP = 'image/webp',
  GIF = 'image/gif',
}

export class ImagenFuenteDto {
  @ApiPropertyOptional({ description: 'Imagen en base64 (sin prefijo data:)' })
  @IsOptional()
  @IsString()
  imageBase64?: string;

  @ApiPropertyOptional({ enum: ImageMediaType, description: 'Requerido si se envía imageBase64' })
  @IsOptional()
  @IsEnum(ImageMediaType)
  mediaType?: ImageMediaType;

  @ApiPropertyOptional({ description: 'Alternativa: URL pública o firmada de la imagen' })
  @IsOptional()
  @IsString()
  imageUrl?: string;
}

export class GastoTicketDto {
  @ApiPropertyOptional({ description: 'Imagen del ticket en base64 (sin prefijo data:)' })
  @IsOptional()
  @IsString()
  imageBase64?: string;

  @ApiPropertyOptional({ enum: ImageMediaType, description: 'Requerido si se envía imageBase64' })
  @IsOptional()
  @IsEnum(ImageMediaType)
  mediaType?: ImageMediaType;

  @ApiPropertyOptional({ description: 'Alternativa: URL pública o firmada de la imagen' })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({
    type: [ImagenFuenteDto],
    description:
      'Varias fotos del MISMO documento (hojas de una factura multi-página); máx 8. Alternativa a imageBase64/imageUrl.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ImagenFuenteDto)
  images?: ImagenFuenteDto[];

  @ApiPropertyOptional({
    description: 'Factura en PDF (base64, sin prefijo data:). Alternativa a las imágenes.',
  })
  @IsOptional()
  @IsString()
  pdfBase64?: string;

  @ApiPropertyOptional({
    description:
      'Factura en Excel (.xlsx) o CSV en base64: pyservices la convierte a texto y la IA extrae los datos.',
  })
  @IsOptional()
  @IsString()
  excelBase64?: string;

  @ApiPropertyOptional({ description: 'Nombre del archivo Excel/CSV (decide el parser).' })
  @IsOptional()
  @IsString()
  excelFilename?: string;
}

/**
 * Constancia de situación fiscal del cliente (PDF del SAT o foto): la IA
 * extrae RFC, razón social, régimen y CP para pre-llenar el alta/edición del
 * cliente en el panel. EXACTAMENTE una fuente: pdfBase64 O imageBase64
 * (+mediaType) — el controller valida la exclusión.
 */
export class ConstanciaFiscalDto {
  @ApiPropertyOptional({
    description:
      'Constancia en PDF (base64, sin prefijo data:). Excluyente con imageBase64.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BASE64_CHARS, { message: 'El PDF excede ~12 MB.' })
  pdfBase64?: string;

  @ApiPropertyOptional({
    description:
      'Foto de la constancia en base64 (sin prefijo data:). Requiere mediaType.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BASE64_CHARS, { message: 'La imagen excede ~12 MB.' })
  imageBase64?: string;

  @ApiPropertyOptional({
    enum: ImageMediaType,
    description: 'Requerido si se envía imageBase64.',
  })
  @IsOptional()
  @IsEnum(ImageMediaType)
  mediaType?: ImageMediaType;
}
