import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { ArmarGrupoDto } from './armar-grupo.dto';

export class CreateGrupoDto extends ArmarGrupoDto {
  @ApiProperty({ example: 'Tour Chichén Itzá — 44 pax' })
  @IsString()
  @Length(2, 120)
  nombre!: string;

  @ApiPropertyOptional({
    description: 'Notas visibles al cliente (PDF del grupo).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({ description: 'Notas internas del equipo.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;

  @ApiPropertyOptional({
    description:
      'APARTAR la flota: los hijos nacen en RESERVA (con su precio ya calculado y cotización abierta) para bloquear aviones/pilotos en el calendario antes de cerrar precio; confirmar el grupo los promueve. Default false = nacen COTIZADO.',
  })
  @IsOptional()
  @IsBoolean()
  apartar?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_anexo_aviones?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_subtotal_por_avion?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_precio_por_persona?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_tarifa?: boolean;
}
