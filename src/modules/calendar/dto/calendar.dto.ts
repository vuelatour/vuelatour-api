import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsOptional, IsUUID } from 'class-validator';

export class CalendarRangeQuery {
  @ApiPropertyOptional({ description: 'Desde (ISO). Default: hoy' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Hasta (ISO). Default: hoy + 30 días' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({
    description: 'Incluir vuelos CANCELADOS. Default: false',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  incluir_cancelados?: boolean;

  @ApiPropertyOptional({ description: 'Incluir solo externos (rosa)' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  solo_externos?: boolean;
}
