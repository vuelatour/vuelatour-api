import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class OverviewQuery {
  @ApiProperty({ description: 'Inicio del periodo (YYYY-MM-DD)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'Fin del periodo (YYYY-MM-DD)' })
  @IsDateString()
  hasta!: string;
}
