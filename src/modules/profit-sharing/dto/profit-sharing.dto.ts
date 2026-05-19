import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

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
