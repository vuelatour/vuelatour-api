import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * Cuerpo de `POST /v1/flights/recalcular-cobrado` (20-oct-2026, invariante
 * 99, pesos primero). Rango de `fecha_vuelo` (días Cancún, inclusivos);
 * sin rango se revisan todos los vuelos con precio. ADMIN, idempotente: solo
 * escribe la bandera `cobrado` que cambia.
 */
export class RecalcularCobradoDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desde?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hasta?: string;
}
