import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * SOCIO SIN ACCESO (19-oct-2026, invariante 95): alta rápida desde la card de
 * propietarios del avión («que pueda agregar un socio desde esta parte»).
 * Nace con rol SOCIO y estado INACTIVO (no entra al sistema, no recibe
 * invitación), igual que los socios cargados en mayo; el reparto y la cuenta
 * corriente lo toman de `aeronave_socio`, no del estado.
 */
export class CreateSocioDto {
  @ApiProperty({
    maxLength: 100,
    description: 'Nombre de la persona o empresa',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre!: string;

  @ApiPropertyOptional({ description: 'true = es una empresa (razón social)' })
  @IsOptional()
  @IsBoolean()
  es_empresa?: boolean;

  @ApiPropertyOptional({ description: 'Correo de contacto (no da acceso)' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;
}
