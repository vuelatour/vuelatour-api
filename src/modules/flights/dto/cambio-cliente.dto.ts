import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { IF_UPDATED_AT_DESC } from '../../../common/version-cas.util';

/**
 * Body de `PATCH /v1/flights/:id/cliente` (27-nov-2026): cambiar el cliente
 * de un vuelo / cotización que ya existe. SOLO viaja el cliente nuevo (y el
 * control de versión opcional): el precio no se recalcula y cualquier otro
 * campo es un 400 (`forbidNonWhitelisted`).
 */
export class CambiarClienteDto {
  @ApiProperty({
    description: 'Cliente NUEVO del vuelo (debe existir y estar activo).',
  })
  @IsUUID('all', { message: 'cliente_id debe ser el id de un cliente.' })
  cliente_id!: string;

  @ApiPropertyOptional({ description: IF_UPDATED_AT_DESC })
  @IsOptional()
  @IsDateString()
  if_updated_at?: string;
}
