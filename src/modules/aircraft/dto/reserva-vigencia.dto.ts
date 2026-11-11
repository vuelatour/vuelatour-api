import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RESERVA_MOTORES_MAX,
  RESERVA_NOTAS_MAX,
  RESERVA_TARIFA_MAX_USD_HR,
} from '../../../common/reserva-overhaul.util';

/**
 * `PUT /v1/aircraft/:id/reserva-overhaul/vigencias` (10-nov-2026, API
 * 0.0.135, invariante 130): la tarifa de la reserva de overhaul «a partir
 * de» una fecha. Guardar la MISMA fecha corrige esa tarifa; otra fecha crea
 * una tarifa nueva y lo volado antes conserva la suya.
 */
export class GuardarReservaVigenciaDto {
  @ApiProperty({
    description:
      'Día desde el que vale la tarifa (YYYY-MM-DD, día Cancún del vuelo).',
    example: '2026-11-01',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'vigente_desde debe tener el formato AAAA-MM-DD',
  })
  vigente_desde!: string;

  @ApiProperty({
    description:
      'Tarifa en USD por hora POR MOTOR (0 = sin reserva desde ese día).',
    example: 55,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(RESERVA_TARIFA_MAX_USD_HR)
  usd_hr_por_motor!: number;

  @ApiPropertyOptional({
    description:
      'Motores que aportan (default: los motores dados de alta del avión).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(RESERVA_MOTORES_MAX)
  motores?: number;

  @ApiPropertyOptional({ description: 'Nota de la tarifa (por qué cambió).' })
  @IsOptional()
  @IsString()
  @MaxLength(RESERVA_NOTAS_MAX)
  notas?: string;
}
