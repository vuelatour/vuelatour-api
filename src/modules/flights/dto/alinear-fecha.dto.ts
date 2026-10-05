import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';
import {
  MENSAJE_FECHA_VUELO_SIN_ZONA,
  RE_INSTANTE_ISO_CON_ZONA,
} from '../alinear-fecha.util';

/**
 * Cuerpo de `POST /v1/flights/:id/tramos/alinear-fecha` (5-oct-2026). Vacío
 * (`{}`) es lo normal: el panel lo llama justo después de guardar la
 * cotización (o desde el detalle del vuelo) y el objetivo es la
 * `fecha_vuelo` ya persistida.
 */
export class AlinearFechaTramosDto {
  @ApiPropertyOptional({
    description:
      'Fecha objetivo: instante ISO 8601 CON hora y zona (Z u offset). Opcional: por default la fecha_vuelo persistida del vuelo. Solo cuenta su DÍA en hora Cancún; cada tramo conserva su hora. Solo mueve la operación: la fecha de la cotización (vuelo.fecha_vuelo) no cambia.',
    example: '2026-10-13T14:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  // «2026-10-13» (medianoche UTC = el día ANTERIOR en Cancún) y
  // «2026-10-13T02:00» (depende de la zona del servidor) no son instantes.
  @Matches(RE_INSTANTE_ISO_CON_ZONA, { message: MENSAJE_FECHA_VUELO_SIN_ZONA })
  fecha_vuelo?: string | null;
}
