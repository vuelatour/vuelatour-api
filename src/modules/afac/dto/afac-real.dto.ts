/**
 * DTO del COSTO REAL AFAC por vuelo (16-oct-2026, API 0.0.89, invariante
 * 90). Valores CRUDOS del body (`@Transform(crudo)`): con
 * `enableImplicitConversion` un texto vacío llegaría como 0 («AFAC no
 * cobró», que es distinto de «sin capturar»); aquí un texto es 400.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  COSTO_REAL_AFAC_MAX,
  MENSAJE_COSTO_REAL_AFAC_INVALIDO,
} from '../../../common/afac-real.util';

const crudo = ({ obj, key }: { obj: unknown; key: string }) =>
  (obj as Record<string, unknown>)[key];

/** `PUT /v1/flights/:id/afac-real`. */
export class PutAfacRealDto {
  @ApiProperty({
    description:
      'Lo que VuelaTour pagó a AFAC por ESTE vuelo, en pesos (0 = AFAC no cobró; distinto de «sin capturar», que se logra con DELETE). Hasta 2 decimales.',
    example: 4500,
  })
  @Transform(crudo)
  @IsNumber(
    { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
    { message: MENSAJE_COSTO_REAL_AFAC_INVALIDO },
  )
  @Min(0, { message: MENSAJE_COSTO_REAL_AFAC_INVALIDO })
  @Max(COSTO_REAL_AFAC_MAX, { message: MENSAJE_COSTO_REAL_AFAC_INVALIDO })
  costo_real_mxn!: number;

  @ApiPropertyOptional({
    description:
      'Notas del costo real (≤ 500). Ausente = se conservan; null o vacío = se borran.',
    nullable: true,
    type: String,
  })
  @Transform(crudo)
  @IsOptional()
  @IsString({ message: 'Las notas deben ser texto.' })
  @MaxLength(500, { message: 'Las notas admiten hasta 500 caracteres.' })
  notas?: string | null;
}
