/**
 * DTOs del CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89).
 * `confirmar` es booleano ESTRICTO sobre el valor CRUDO del body (con
 * `enableImplicitConversion` el texto 'false' llegaría como true): patrón de
 * `CambioFechaGastoDto`.
 */
import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 400 PERIODO_INVALIDO si `:periodo` no es 'AAAA-MM'. */
export function validarPeriodoCierre(periodo: string): string {
  if (typeof periodo !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new BadRequestException({
      message: 'El periodo debe ser un mes AAAA-MM (p. ej. 2026-09).',
      error: 'PERIODO_INVALIDO',
    });
  }
  return periodo;
}

const crudo = ({ obj, key }: { obj: unknown; key: string }) =>
  (obj as Record<string, unknown>)[key];

/** `POST /v1/cierres/:periodo`. */
export class CerrarMesDto {
  @ApiProperty({
    description: 'Debe ser true (el diálogo de confirmación del panel).',
    example: true,
  })
  @Transform(crudo)
  @IsBoolean({ message: 'confirmar debe ser true' })
  @Equals(true, { message: 'Confirma el cierre del mes (confirmar: true).' })
  confirmar!: boolean;

  @ApiPropertyOptional({
    description:
      'Ids de los vuelos que el diálogo mostró como «pasan al mes siguiente». Si el conjunto real difiere ⇒ 409 PREVIA_CAMBIO con la previa nueva.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  vuelos_esperados?: string[];

  @ApiPropertyOptional({
    description:
      'INCLUIR EN EL MES (21-oct-2026): ids de vuelos de «pasan al mes siguiente» que ya se cobraron DESPUÉS del corte (motivo COBRO_POSTERIOR) y que la oficina deja en este mes en vez de pasarlos. Otro motivo ⇒ 400 INCLUIR_VUELO_NO_COBRADO; un id que ya no está en la lista ⇒ 409 PREVIA_CAMBIO.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  incluir_vuelos?: string[];
}

/** `GET /v1/cierres/:periodo/previa?incluir=id,id` (21-oct-2026). */
export class PreviaCierreQuery {
  @ApiPropertyOptional({
    description:
      'Ids (separados por coma) de vuelos «que pasan» ya cobrados después del corte que se quedarían en este mes: la previa (lista, totales y reparto después) se recalcula con ellos adentro. Un id desconocido se ignora.',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
      : Array.isArray(value)
        ? value
        : undefined,
  )
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  incluir?: string[];
}

/** `POST /v1/cierres/:periodo/reabrir`. */
export class ReabrirMesDto {
  @ApiProperty({
    description: 'Por qué se reabre (5–300 caracteres).',
    example: 'Faltó registrar un gasto de septiembre',
  })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(5, { message: 'Escribe el motivo (al menos 5 caracteres).' })
  @MaxLength(300, { message: 'El motivo admite hasta 300 caracteres.' })
  motivo!: string;

  @ApiProperty({ description: 'Debe ser true.', example: true })
  @Transform(crudo)
  @IsBoolean({ message: 'confirmar debe ser true' })
  @Equals(true, {
    message: 'Confirma la reapertura del mes (confirmar: true).',
  })
  confirmar!: boolean;
}
