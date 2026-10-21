import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID, Matches } from 'class-validator';

export class ProfitSharingQuery {
  @ApiProperty({ description: 'Inicio del periodo (YYYY-MM-DD)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'Fin del periodo (YYYY-MM-DD)' })
  @IsDateString()
  hasta!: string;

  @ApiPropertyOptional({ description: 'Limitar a una aeronave' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;
}

/**
 * `GET /v1/profit-sharing/aviones/:id/historico` (20-oct-2026, invariante
 * 99): rango de MESES (AAAA-MM). Default: del inicio oficial al mes en curso.
 */
export class HistoricoAvionQuery {
  @ApiPropertyOptional({
    example: '2026-09',
    description: 'Primer mes (AAAA-MM)',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  desde?: string;

  @ApiPropertyOptional({
    example: '2026-10',
    description: 'Último mes (AAAA-MM)',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  hasta?: string;
}
