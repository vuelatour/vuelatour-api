import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export enum TipoMovimientoBancario {
  CARGO = 'CARGO',
  ABONO = 'ABONO',
}

export class ConciliacionParseDto {
  @ApiProperty({ description: 'Nombre del archivo (define el parser por extensión)' })
  @IsString()
  filename!: string;

  @ApiProperty({ description: 'Contenido del estado de cuenta en base64' })
  @IsString()
  file_base64!: string;
}

export class MovimientoImportDto {
  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsISO8601()
  fecha!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descripcion?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto!: number;

  @ApiProperty({ enum: TipoMovimientoBancario })
  @IsEnum(TipoMovimientoBancario)
  tipo!: TipoMovimientoBancario;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;
}

export class ImportarMovimientosDto {
  @ApiProperty({ description: 'Cuenta bancaria a la que pertenece el estado de cuenta' })
  @IsUUID()
  cuenta_bancaria_id!: string;

  @ApiProperty({ type: [MovimientoImportDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MovimientoImportDto)
  movimientos!: MovimientoImportDto[];
}

export class ListConciliacionQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'Filtra por estado de conciliación' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class LinkMovimientoDto {
  @ApiPropertyOptional({ description: 'Gasto a vincular. null para desvincular.', nullable: true })
  @IsOptional()
  @IsUUID()
  gasto_id?: string | null;
}
