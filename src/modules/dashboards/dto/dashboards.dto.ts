import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

/** Periodo desde/hasta (YYYY-MM-DD) compartido por todos los tableros. */
export class PeriodoQuery {
  @ApiProperty({ description: 'Inicio del periodo (YYYY-MM-DD)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'Fin del periodo (YYYY-MM-DD)' })
  @IsDateString()
  hasta!: string;
}

/** Alias histórico del tablero ejecutivo. */
export class OverviewQuery extends PeriodoQuery {}

export class OperativoQuery extends PeriodoQuery {}
export class GastosQuery extends PeriodoQuery {}
export class TarjetasQuery extends PeriodoQuery {}
export class HorasPilotoQuery extends PeriodoQuery {}
