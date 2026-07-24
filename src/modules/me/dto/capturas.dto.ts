import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class CapturasQuery {
  @ApiPropertyOptional({ default: 60, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 60;

  @ApiPropertyOptional({
    description:
      'Solo capturas desde este día (YYYY-MM-DD, corte a las 00:00 hora Cancún).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'desde debe ser una fecha YYYY-MM-DD',
  })
  desde?: string;
}
