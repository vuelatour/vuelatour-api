import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/**
 * Tramo del borrador para el mapa de la hoja (form-as-document, 8-sep-2026).
 * Mismas reglas de IATA que `EscalaInputDto` del cotizador; el resto del
 * tramo (millas, pax, pernocta) no pinta en el mapa y no viaja.
 */
export class MapaSvgEscalaDto {
  @ApiProperty({ description: 'IATA origen del tramo', example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ description: 'IATA destino del tramo', example: 'HOL' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({
    description: 'Tramo ferry: en el mapa va punteado (igual que en el PDF).',
  })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional({
    description:
      'Ojito del PDF: el tramo oculto NO va al mapa y los visibles se renumeran 1..N — misma regla que escalasVisiblesPdf, para que el panel pueda mandar TODAS sus filas tal cual.',
  })
  @IsOptional()
  @IsBoolean()
  pdf_oculto?: boolean;
}

/**
 * Body de `POST /v1/quotes/mapa-svg`: los tramos del borrador EN ORDEN (el
 * `orden` del badge es la posición 1..N entre los visibles, como en el
 * payload del PDF). Nunca persiste nada.
 */
export class MapaSvgDto {
  @ApiProperty({ type: [MapaSvgEscalaDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MapaSvgEscalaDto)
  escalas!: MapaSvgEscalaDto[];
}
