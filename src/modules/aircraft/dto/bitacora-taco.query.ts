import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Tira de bitácora de tacómetros. Sin rango = todo el histórico.
 * formato MOTOR_HELICE (bimotor) agrega las columnas de tiempo de hélice:
 * como el sistema aún no lleva horas de vida de hélice (pendiente con el
 * cliente), el valor del PRIMER renglón lo aporta la oficina (helice_base,
 * igual que en su plantilla manual) y el resto se deriva con offset
 * constante sobre el tacómetro.
 */
export class BitacoraTacoQuery {
  @ApiPropertyOptional({ description: 'Inicio del periodo (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'Fin del periodo (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({
    enum: ['PLANEADOR', 'MOTOR_HELICE'],
    description:
      'PLANEADOR (monomotor, default) o MOTOR_HELICE (bimotor con tiempos de hélice).',
  })
  @IsOptional()
  @IsIn(['PLANEADOR', 'MOTOR_HELICE'])
  formato?: 'PLANEADOR' | 'MOTOR_HELICE';

  @ApiPropertyOptional({
    description:
      'Tiempo de hélice del PRIMER renglón del rango (formato MOTOR_HELICE). Sin él, las columnas de hélice salen vacías.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  helice_base?: number;
}
