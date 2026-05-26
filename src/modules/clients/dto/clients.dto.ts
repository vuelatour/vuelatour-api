import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum CanalCliente {
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  LANDING = 'LANDING',
  LLAMADA = 'LLAMADA',
  REFERIDO = 'REFERIDO',
}

export class ListClientesQuery {
  @ApiPropertyOptional({
    description: 'Búsqueda por nombre, email, teléfono o RFC',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: CanalCliente })
  @IsOptional()
  @IsEnum(CanalCliente)
  canal_origen?: CanalCliente;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  es_broker?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

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

export class CreateClienteDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Razón social para facturar por default',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  razon_social_default?: string;

  @ApiPropertyOptional({ description: 'RFC mexicano (12 o 13 caracteres)' })
  @IsOptional()
  @IsString()
  @Length(12, 13)
  rfc?: string;

  @ApiPropertyOptional({ enum: CanalCliente })
  @IsOptional()
  @IsEnum(CanalCliente)
  canal_origen?: CanalCliente;

  @ApiPropertyOptional({
    default: false,
    description: 'True = aplica tarifa broker',
  })
  @IsOptional()
  @IsBoolean()
  es_broker?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateClienteDto extends PartialType(CreateClienteDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
