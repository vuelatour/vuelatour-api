import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListPendientesQuery {
  @ApiPropertyOptional({ description: 'fecha_vuelo >= (ISO)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha_vuelo <= (ISO)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class ListFacturasQuery {
  @ApiPropertyOptional({ enum: ['TIMBRADA', 'CANCELADA', 'ERROR'] })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  emisora_id?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class EmitirFacturaDto {
  @ApiProperty()
  @IsUUID()
  vuelo_id!: string;

  @ApiProperty()
  @IsUUID()
  entidad_fiscal_emisora_id!: string;
}

export class FacturaFileUrlsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  paths!: string[];
}
