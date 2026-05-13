import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListIssuingEntitiesQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activa?: boolean;

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

export class CreateIssuingEntityDto {
  @ApiProperty({ maxLength: 20, example: 'AEROCHARTER' })
  @IsString()
  @MaxLength(20)
  codigo!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  razon_social!: string;

  @ApiPropertyOptional({ description: 'RFC mexicano (12-13 chars)' })
  @IsOptional()
  @IsString()
  @Length(12, 13)
  rfc?: string;

  @ApiPropertyOptional({ description: 'Régimen fiscal SAT (601 = PM Régimen General)' })
  @IsOptional()
  @IsString()
  @Length(3, 10)
  regimen_fiscal_sat?: string;

  @ApiPropertyOptional({ description: 'Código postal del domicilio fiscal' })
  @IsOptional()
  @IsString()
  @Length(5, 5)
  codigo_postal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  direccion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email_facturacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;

  @ApiPropertyOptional({ example: 'SIIGO_NUBE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  pac_proveedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateIssuingEntityDto extends PartialType(CreateIssuingEntityDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
