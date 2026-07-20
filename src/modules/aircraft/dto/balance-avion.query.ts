import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/** Periodo del balance por avión. Sin params = mes corriente en hora Cancún. */
export class BalanceAvionQuery {
  @ApiPropertyOptional({
    description:
      'Inicio del periodo (YYYY-MM-DD). Default: día 1 del mes corriente en hora Cancún.',
  })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({
    description:
      'Fin del periodo (YYYY-MM-DD). Default: último día del mes corriente en hora Cancún.',
  })
  @IsOptional()
  @IsDateString()
  hasta?: string;
}
