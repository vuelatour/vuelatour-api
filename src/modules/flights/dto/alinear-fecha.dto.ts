import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/**
 * Cuerpo de `POST /v1/flights/:id/tramos/alinear-fecha` (5-oct-2026). Vacío
 * (`{}`) es lo normal: el panel lo llama justo después de guardar la
 * cotización y el objetivo es la `fecha_vuelo` ya persistida.
 */
export class AlinearFechaTramosDto {
  @ApiPropertyOptional({
    description:
      'Fecha objetivo (ISO 8601). Opcional: por default la fecha_vuelo persistida del vuelo. Solo cuenta su DÍA en hora Cancún; cada tramo conserva su hora.',
    example: '2026-10-13T14:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  fecha_vuelo?: string | null;
}
