import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { EstadoUsuario, Rol } from '../../../common/types/auth.types';

export class CreateUsuarioDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  nombre!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: Rol })
  @IsEnum(Rol)
  rol!: Rol;

  @ApiPropertyOptional({ enum: EstadoUsuario, default: 'INVITADO' })
  @IsOptional()
  @IsEnum(EstadoUsuario)
  estado?: EstadoUsuario;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tiene_fondo_caja?: boolean;

  @ApiPropertyOptional({ description: 'Últimos 4 dígitos de tarjeta corporativa' })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'tarjeta_terminacion must be 4 digits' })
  tarjeta_terminacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  es_piloto_externo?: boolean;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;
}
