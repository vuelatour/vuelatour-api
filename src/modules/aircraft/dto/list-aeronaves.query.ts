import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListAeronavesQuery {
  @ApiPropertyOptional({ enum: ['MX', 'USA'] })
  @IsOptional()
  @IsIn(['MX', 'USA'])
  pais_registro?: 'MX' | 'USA';

  @ApiPropertyOptional({ description: 'Activas únicamente. Default: true' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({ description: 'Búsqueda por matrícula o modelo' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
