import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ValidateNested } from 'class-validator';
import { CalculateQuoteDto, TipoVuelo } from './calculate-quote.dto';
import { ReservaEscalaDto } from '../../flights/dto/flights.dto';

// Re-export para no romper imports existentes (quotes.service.ts importa de aqui).
export { TipoVuelo };

export class CreateQuoteDto extends CalculateQuoteDto {
  @ApiProperty({ description: 'Cliente que solicita el vuelo' })
  @IsUUID()
  cliente_id!: string;

  @ApiPropertyOptional({
    type: [ReservaEscalaDto],
    description:
      'Ruta OPERATIVA real del avión (opcional). Si se envía, estas escalas son las del piloto (itinerario_operativo=true) y los tramos comerciales solo fijan el precio — la cotización nunca las pisa.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservaEscalaDto)
  escalas_operacion?: ReservaEscalaDto[];

  @ApiPropertyOptional({ description: 'Fecha de traslado inicial / salida (ISO)', example: '2026-06-15T09:00:00Z' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ description: 'Fecha de traslado final / regreso a base (ISO)', example: '2026-06-15T18:00:00Z' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  @ApiPropertyOptional({
    type: [String],
    description: 'Nombres de los pasajeros (manifiesto, para tramitar permisos).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];

  @ApiPropertyOptional({ description: 'Notas visibles para el cliente (aparecen en PDF)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({ description: 'Notas internas del equipo (no van al cliente)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;
}
