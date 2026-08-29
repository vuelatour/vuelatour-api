import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CalculateQuoteDto } from './calculate-quote.dto';

export class ReviseQuoteDto extends CalculateQuoteDto {
  @ApiProperty({
    description: 'Razón de la revisión',
    example: 'Cliente solicitó cambiar avión a Kodiak',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({ description: 'Fecha de traslado inicial / salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ description: 'Fecha de traslado final / regreso' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  // ---- Vuelo cubierto por operador externo (regla 28-ago): al revisar se
  // editan aquí mismo el operador y lo que cobra el avión externo (costo,
  // interno — distinto del precio pactado con el cliente). Solo aplican si
  // el vuelo ya es externo; en un vuelo propio se ignoran.
  @ApiPropertyOptional({
    description: 'Operador externo que cubre el vuelo (solo vuelos externos).',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo?: string;

  @ApiPropertyOptional({
    description:
      'Lo que cobra el avión/operador externo, en SU moneda (nombre legado; ' +
      'ver costo_externo_moneda). null o 0 = limpiar el costo (las 4 ' +
      'columnas). El server DERIVA vuelo.costo_externo_usd.',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd?: number | null;

  @ApiPropertyOptional({
    description:
      'Alias preferido de costo_externo_usd: el monto en su moneda; null o ' +
      '0 = limpiar. Este gana si vienen ambos.',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number | null;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige TC: el ' +
      'tc_usd_mxn de la revisión o el ya persistido en el vuelo.',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    type: [String],
    description:
      'Nombres de los pasajeros (manifiesto, para tramitar permisos).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];
}
