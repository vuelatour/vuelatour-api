import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ValidateNested } from 'class-validator';
import { CalculateQuoteDto, TipoVuelo } from './calculate-quote.dto';
import { ReservaEscalaDto } from '../../flights/dto/flights.dto';

// Re-export para no romper imports existentes (quotes.service.ts importa de aqui).
export { TipoVuelo };

export class CreateQuoteDto extends CalculateQuoteDto {
  // cliente_id viene heredado de CalculateQuoteDto (ahí es opcional, para la
  // tarifa preferencial en el preview). Al CREAR es obligatorio: lo re-valida
  // quotes.service.create() en runtime — no se redeclara aquí porque los
  // metadatos de class-validator del padre (@IsOptional) se heredan igual.

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

  @ApiPropertyOptional({
    description: 'Fecha de traslado inicial / salida (ISO)',
    example: '2026-06-15T09:00:00Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({
    description: 'Fecha de traslado final / regreso a base (ISO)',
    example: '2026-06-15T18:00:00Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

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

  @ApiPropertyOptional({
    description: 'Notas visibles para el cliente (aparecen en PDF)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  // ---- Vuelo CUBIERTO por operador externo (flujo normal del cotizador) ----
  // es_externo ahora vive en CalculateQuoteDto (el motor lo necesita).

  @ApiPropertyOptional({
    description: 'Operador externo (ej. XA-TIB). Requerido si es_externo.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo?: string;

  @ApiPropertyOptional({
    description:
      'Lo que cobra el operador externo, en SU moneda (nombre legado: con ' +
      'costo_externo_moneda=MXN es un monto en PESOS). El server DERIVA ' +
      'vuelo.costo_externo_usd — fuente única de los lectores — con el TC ' +
      'de la cotización (tc_usd_mxn) cuando la moneda es MXN.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd?: number;

  @ApiPropertyOptional({
    description:
      'Alias preferido de costo_externo_usd: el monto en su moneda. Mandar ' +
      'uno de los dos (este gana si vienen ambos).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige TC: el ' +
      'tc_usd_mxn de la cotización (sin él, 400).',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    description: 'Notas internas del equipo (no van al cliente)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;
}
