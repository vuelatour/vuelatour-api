import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExtraConceptoDto } from './calculate-quote.dto';

/**
 * Ajuste rápido desde el detalle de la cotización: extras y/o pasajeros, sin
 * rearmar el cotizador. Todo lo demás (tramos, tarifa, método de pago, IVA) se
 * conserva tal como está; el recálculo y versionado son los de revise().
 */
export class QuickAdjustQuoteDto {
  @ApiPropertyOptional({
    type: [ExtraConceptoDto],
    description:
      'Lista COMPLETA de conceptos extra (reemplaza la actual). Omitir = no tocar extras.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtraConceptoDto)
  extras?: ExtraConceptoDto[];

  @ApiPropertyOptional({
    description:
      'Nuevo número de pasajeros (recalcula TUAs). Los tramos que usaban el global anterior lo heredan.',
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros?: number;

  @ApiPropertyOptional({
    description: 'Motivo del ajuste (queda en el historial de versiones).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}
