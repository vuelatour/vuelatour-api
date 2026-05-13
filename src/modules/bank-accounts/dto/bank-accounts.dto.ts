import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum Moneda {
  MXN = 'MXN',
  USD = 'USD',
}

export enum RazonSocialEmisora {
  AEROCHARTER = 'AEROCHARTER',
  AERODINAMICA = 'AERODINAMICA',
  OTRA = 'OTRA',
}

export class ListBankAccountsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: Moneda })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({ enum: RazonSocialEmisora })
  @IsOptional()
  @IsEnum(RazonSocialEmisora)
  razon_social?: RazonSocialEmisora;

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

export class CreateBankAccountDto {
  @ApiProperty({ maxLength: 50, example: 'GASTOS GNRAL' })
  @IsString()
  @MaxLength(50)
  alias!: string;

  @ApiProperty({ maxLength: 50, example: 'Scotiabank' })
  @IsString()
  @MaxLength(50)
  banco!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  numero_cuenta?: string;

  @ApiPropertyOptional({ description: 'CLABE 18 dígitos' })
  @IsOptional()
  @IsString()
  @Length(18, 18)
  clabe?: string;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiProperty({ enum: RazonSocialEmisora })
  @IsEnum(RazonSocialEmisora)
  razon_social!: RazonSocialEmisora;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateBankAccountDto extends PartialType(CreateBankAccountDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
