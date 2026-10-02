import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  NOTAS_CUENTA_MAX,
  SALDO_INICIAL_MAX_USD,
} from '../reparto-cuenta.util';
import { MENSAJE_MES_INVALIDO, MES_REGEX } from '../reparto-pago.util';

/**
 * CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026, API 0.0.50). Reglas en
 * `reparto-cuenta.util.ts` y `RepartoCuentaService`; aquí solo forma.
 */

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `GET /v1/profit-sharing/socios/:socioId/estado-cuenta?desde&hasta` (meses). */
export class EstadoCuentaQuery {
  @ApiPropertyOptional({
    example: '2026-09',
    description: 'Primer mes (AAAA-MM). Default: arranque de la cuenta.',
  })
  @IsOptional()
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  desde?: string;

  @ApiPropertyOptional({
    example: '2026-10',
    description: 'Último mes (AAAA-MM). Default y tope: el mes en curso.',
  })
  @IsOptional()
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  hasta?: string;
}

/** `PUT /v1/profit-sharing/socios/:socioId/cuenta`. */
export class ConfigurarCuentaSocioDto {
  @ApiProperty({
    example: '2026-09',
    description:
      'Primer mes que suma utilidades a la cuenta (AAAA-MM; no futuro, ≤ 36 meses atrás).',
  })
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  cuenta_desde!: string;

  @ApiProperty({
    example: 0,
    description:
      'Saldo al arrancar, en USD (2 decimales): positivo = se le debía al socio; negativo = ya se le había adelantado.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-SALDO_INICIAL_MAX_USD)
  @Max(SALDO_INICIAL_MAX_USD)
  saldo_inicial_usd!: number;

  @ApiPropertyOptional({ maxLength: NOTAS_CUENTA_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(NOTAS_CUENTA_MAX)
  notas?: string | null;
}
