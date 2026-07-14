import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

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
}
