import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CalculateQuoteDto, TipoVuelo } from './calculate-quote.dto';

// Re-export para no romper imports existentes (quotes.service.ts importa de aqui).
export { TipoVuelo };

export class CreateQuoteDto extends CalculateQuoteDto {
  @ApiProperty({ description: 'Cliente que solicita el vuelo' })
  @IsUUID()
  cliente_id!: string;

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
