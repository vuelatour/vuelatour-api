import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum ImageMediaType {
  JPEG = 'image/jpeg',
  PNG = 'image/png',
  WEBP = 'image/webp',
  GIF = 'image/gif',
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
}
