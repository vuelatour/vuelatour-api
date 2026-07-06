import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { EstadoUsuario, Rol } from '../../../common/types/auth.types';

export class UpdateUsuarioDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nombre?: string;

  @ApiPropertyOptional({ enum: Rol })
  @IsOptional()
  @IsEnum(Rol)
  rol?: Rol;

  @ApiPropertyOptional({ enum: EstadoUsuario })
  @IsOptional()
  @IsEnum(EstadoUsuario)
  estado?: EstadoUsuario;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tiene_fondo_caja?: boolean;

  @ApiPropertyOptional({
    description: 'Últimos 4 dígitos de tarjeta corporativa',
  })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'tarjeta_terminacion must be 4 digits' })
  tarjeta_terminacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  es_piloto_externo?: boolean;

  @ApiPropertyOptional({
    description: 'También vuela (doble rol): entra a selectores de piloto, disponibilidad y horas.',
  })
  @IsOptional()
  @IsBoolean()
  es_piloto?: boolean;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatar_url?: string;
}
