import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EstadoUsuario } from '../../../common/types/auth.types';

export class ListPilotsQuery {
  @ApiPropertyOptional({ description: 'Buscar por nombre o email' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: EstadoUsuario })
  @IsOptional()
  @IsEnum(EstadoUsuario)
  estado?: EstadoUsuario;

  @ApiPropertyOptional({ description: 'true = solo pilotos externos / false = solo base' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  externo?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateDescansoDto {
  @ApiProperty({ description: 'Primer día de descanso (YYYY-MM-DD)' })
  @IsISO8601()
  fecha_inicio!: string;

  @ApiProperty({ description: 'Último día de descanso (YYYY-MM-DD)' })
  @IsISO8601()
  fecha_fin!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  motivo?: string;
}

export class ListDescansosQuery {
  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD)' })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD)' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;
}

/**
 * Alta de piloto EXTERNO (doc 3.7): freelance sin acceso al sistema. Queda
 * como usuario rol PILOTO con es_piloto_externo=true y SIN cuenta de auth —
 * la oficina captura sus tacómetros y gastos desde el admin.
 */
export class CreatePilotoExternoDto {
  @ApiProperty({ maxLength: 100, minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 20, description: 'WhatsApp de contacto' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;

  @ApiPropertyOptional({
    description:
      'Solo referencia de contacto: NO le da acceso (la allowlist de signup ignora externos).',
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}
