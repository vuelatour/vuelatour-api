import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * PATCH de una bandera: `activa` y/o `valor_numerico` (al menos uno; el
 * service lo valida — el DTO no puede exigir "uno de dos" declarativamente).
 */
export class UpdateConfiguracionDto {
  @ApiPropertyOptional({ description: 'Nuevo estado de la bandera' })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({
    description:
      'Valor numérico de la bandera (p.ej. días de la ventana de edición de gastos de campo). Nunca negativo.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valor_numerico?: number;
}
