import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  ESTADOS_SEGUIMIENTO,
  SEGUIMIENTO_RESOLUCION_MAX,
  SEGUIMIENTO_TEXTO_MAX,
  type EstadoSeguimiento,
} from '../vuelo-seguimiento.util';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Booleano ESTRICTO: se valida el valor CRUDO del body (`obj[key]`). Con
 * `enableImplicitConversion` (main.ts) class-transformer ya convirtió
 * 'false' (string) a Boolean('false') = true ANTES del @Transform: una nota
 * «que no afecta la cotización» entraría como que SÍ. Patrón de
 * `quotes/dto/preview-quote.dto.ts#sucio`; aquí sin coerción: solo
 * true/false JSON pasan `@IsBoolean`.
 */
const booleanoCrudo = ({ obj, key }: { obj: unknown; key: string }) =>
  (obj as Record<string, unknown>)[key];

/**
 * `POST /v1/flights/:id/seguimiento` — SEGUIMIENTO DE LA COTIZACIÓN
 * (29-sep-2026): ajuste que se debe cobrar o agregar a la cotización.
 */
export class CrearSeguimientoDto {
  @ApiProperty({
    maxLength: SEGUIMIENTO_TEXTO_MAX,
    example:
      'Los pax pidieron transporte terrestre; no está en la cotización, hay que cobrarlo.',
    description: 'Texto de la nota (se recorta; 1–1000 caracteres).',
  })
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribe la nota: no puede ir vacía.' })
  @MaxLength(SEGUIMIENTO_TEXTO_MAX)
  texto!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      '«Debe reflejarse en la cotización»: la vigilan el banner del cotizador y el pre-cierre. Default true.',
  })
  @IsOptional()
  @Transform(booleanoCrudo)
  @IsBoolean()
  afecta_cotizacion?: boolean;
}

/**
 * `PATCH /v1/flights/seguimiento/:notaId` — todo opcional (al menos uno).
 * `estado: RESUELTA` sella quién y cuándo; `PENDIENTE` (reabrir) limpia el
 * sello y la resolución.
 */
export class ActualizarSeguimientoDto {
  @ApiPropertyOptional({ enum: ESTADOS_SEGUIMIENTO })
  // `null` NO es «omitido» (revisión adversaria 29-sep-2026): se valida y
  // rebota 400; solo `undefined` (campo ausente) salta la validación.
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn([...ESTADOS_SEGUIMIENTO])
  estado?: EstadoSeguimiento;

  @ApiPropertyOptional({
    maxLength: SEGUIMIENTO_RESOLUCION_MAX,
    nullable: true,
    description:
      '«¿Cómo se resolvió?» (≤ 500, se recorta; "" o null = sin resolución). Solo aplica a una nota RESUELTA.',
  })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(SEGUIMIENTO_RESOLUCION_MAX)
  resolucion?: string | null;

  @ApiPropertyOptional({ maxLength: SEGUIMIENTO_TEXTO_MAX })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribe la nota: no puede ir vacía.' })
  @MaxLength(SEGUIMIENTO_TEXTO_MAX)
  texto?: string;

  @ApiPropertyOptional()
  // `null` ⇒ 400 (con @IsOptional pasaba y el parche lo guardaba como
  // `false`: la nota dejaba de vigilarse en el cotizador y el pre-cierre en
  // silencio). Solo el campo AUSENTE se omite.
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(booleanoCrudo)
  @IsBoolean()
  afecta_cotizacion?: boolean;
}
