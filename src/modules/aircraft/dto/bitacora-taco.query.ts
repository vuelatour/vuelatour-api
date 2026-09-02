import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import {
  BITACORA_TIRA_TIPOS,
  type BitacoraTiraTipo,
} from '../bitacora-tiras.util';

/**
 * `tiras=A,B` (lista separada por comas) o `tiras[]=A&tiras[]=B` (arreglo).
 * Cadena vacía ⇒ como si no viniera (aplica el default). El dedupe y el
 * orden canónico los hace normalizarTiras en el service.
 */
const tirasDesdeQuery = ({ value }: { value: unknown }): unknown => {
  const crudo = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value;
  if (!Array.isArray(crudo)) return crudo;
  const limpio = crudo
    .map((v) => String(v).trim().toUpperCase())
    .filter((v) => v.length > 0);
  return limpio.length === 0 && typeof value === 'string' ? undefined : limpio;
};

/**
 * Bitácoras de vuelo imprimibles del avión (una página por libro). Sin
 * rango = todo el histórico. `tiras` elige qué libros salen (default:
 * planeador, motor y hélice); el tiempo de cada uno se deriva del tacómetro
 * con la base capturada en la ficha del avión (planeador) o del componente
 * (motor / hélice). `helice_base` sigue cubriendo la hélice SIN ficha: la
 * oficina teclea el tiempo del primer renglón (como en su plantilla manual)
 * y el resto sale con offset constante sobre el tacómetro.
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
    type: String,
    example: 'PLANEADOR,MOTOR,HELICE',
    description:
      'Bitácoras a imprimir, separadas por comas (PLANEADOR, MOTOR, HELICE). Default: las tres. Se deduplican y salen siempre en ese orden, una página cada una.',
  })
  @IsOptional()
  @Transform(tirasDesdeQuery)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(BITACORA_TIRA_TIPOS, { each: true })
  tiras?: BitacoraTiraTipo[];

  @ApiPropertyOptional({
    enum: ['PLANEADOR', 'MOTOR_HELICE'],
    deprecated: true,
    description:
      'DEPRECADO (compatibilidad): solo aplica si NO viene `tiras`. MOTOR_HELICE ⇒ tiras=MOTOR,HELICE; PLANEADOR ⇒ tiras=MOTOR (la tira de tacómetro histórica).',
  })
  @IsOptional()
  @IsIn(['PLANEADOR', 'MOTOR_HELICE'])
  formato?: 'PLANEADOR' | 'MOTOR_HELICE';

  @ApiPropertyOptional({
    description:
      'Tiempo de hélice del PRIMER renglón del rango (tira HELICE). Solo hace falta si la ficha de la hélice no tiene horas capturadas; si las tiene, se calcula solo. Vacío y sin ficha ⇒ columnas con "—" para llenar a mano.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  helice_base?: number;
}
