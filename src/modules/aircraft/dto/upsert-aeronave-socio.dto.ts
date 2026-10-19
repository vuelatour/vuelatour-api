import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateAeronaveSocioDto {
  @ApiProperty({ description: 'Usuario id del socio (persona o empresa)' })
  @IsUUID()
  socio_id!: string;

  @ApiProperty({
    minimum: 0.001,
    maximum: 100,
    description: 'Porcentaje de propiedad',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(100)
  porcentaje!: number;

  @ApiProperty({
    description: 'Fecha de inicio del régimen',
    example: '2026-01-01',
  })
  @Type(() => Date)
  @IsDate()
  vigente_desde!: Date;

  @ApiPropertyOptional({ description: 'Si se omite, el régimen queda abierto' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  vigente_hasta?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  /**
   * PROPIETARIOS (19-oct-2026, invariante 95): ids de `aeronave_socio` del
   * MISMO avión a los que este propietario SUSTITUYE. Cada uno termina el
   * día anterior a `vigente_desde` (todo se valida antes de escribir).
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Propietarios vigentes del mismo avión que este sustituye: terminan el día anterior a vigente_desde.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  sustituye_a?: string[];
}

export class UpdateAeronaveSocioDto {
  /** PROPIETARIOS (19-oct-2026, invariante 95): se corrige la persona. */
  @ApiPropertyOptional({
    description: 'Usuario id del socio (persona o empresa)',
  })
  @IsOptional()
  @IsUUID()
  socio_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(100)
  porcentaje?: number;

  /** PROPIETARIOS (19-oct-2026, invariante 95): se corrige el primer día. */
  @ApiPropertyOptional({ description: 'Primer día del régimen' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  vigente_desde?: Date;

  /**
   * Último día del régimen. `null` EXPLÍCITO = reabrir (quitar la fecha de
   * fin); ausente = no se toca.
   */
  @ApiPropertyOptional({
    nullable: true,
    description: 'Último día del régimen; null = reabrir (sin fecha de fin)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  vigente_hasta?: Date | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
