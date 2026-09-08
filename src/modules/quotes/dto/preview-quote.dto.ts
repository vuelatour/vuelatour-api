import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CalculateQuoteDto } from './calculate-quote.dto';

/**
 * Presentación PDF de UN tramo del borrador, cruzada por `orden` (1..N de
 * los tramos del DTO). Manda sobre lo que traiga el tramo del DTO y sobre la
 * escala viva del vuelo (mismo cruce por orden que `escalasVisiblesPdf`).
 */
export class EscalaPdfPreviewDto {
  @ApiProperty({ description: 'Orden del tramo (1..N) en escalas[]' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orden!: number;

  @ApiPropertyOptional({
    description: 'Ocultar el tramo del PDF (título/itinerario/mapa).',
  })
  @IsOptional()
  @IsBoolean()
  pdf_oculto?: boolean;

  @ApiPropertyOptional({
    example: '2026-09-05',
    nullable: true,
    description:
      'Fecha (YYYY-MM-DD) SOLO para el PDF. null = sin fecha; omitida = la del tramo del DTO o de la escala viva.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'pdf_fecha debe ser YYYY-MM-DD',
  })
  @IsISO8601({ strict: true }, { message: 'pdf_fecha inválida (YYYY-MM-DD)' })
  pdf_fecha?: string | null;
}

/**
 * Con `quote_id` y `sucio=false` la vista previa se arma desde lo
 * PERSISTIDO (misma fila y snapshot que el PDF): el motor no corre y los
 * campos del cotizador no hacen falta. En cualquier otro caso el body debe
 * ser un `CalculateQuoteDto` válido.
 */
const requiereMotor = (o: PreviewQuoteDto): boolean =>
  !(o.sucio === false && !!o.quote_id);

/**
 * Body de `POST /v1/quotes/preview-html` (rediseño del cotizador, F1,
 * 8-sep-2026): TODO `CalculateQuoteDto` + los datos de PRESENTACIÓN que el
 * PDF imprime pero el motor no calcula. Nunca persiste nada.
 *
 * - `quote_id` + `sucio=false` → payload EXACTO del PDF de la cotización
 *   guardada (fila + `calculo_snapshot`, sin llamar al motor): una
 *   cotización cobrada muestra la misma hoja que ya tiene el cliente.
 * - `sucio=true` (default) o sin `quote_id` → corre `calculate()` con el DTO
 *   y arma el quote-like en memoria con el MISMO mapeo fila←breakdown de
 *   create/revise + los datos de presentación de este body.
 */
export class PreviewQuoteDto extends CalculateQuoteDto {
  @ApiPropertyOptional({
    description:
      'Cotización guardada de la que parte el borrador. Con sucio=false el payload sale de lo persistido (sin motor); con sucio=true ancla cliente/es_externo/extras GRUPO/pactado como lo haría revise().',
  })
  @IsOptional()
  @IsUUID()
  quote_id?: string;

  @ApiPropertyOptional({
    description:
      'false = el formulario está LIMPIO: vista previa desde la fila y el snapshot persistidos (exige quote_id). Default true.',
  })
  // Transform explícito sobre el valor CRUDO del body (`obj[key]`): con
  // enableImplicitConversion class-transformer ya convirtió 'false' (string)
  // a Boolean('false') = true ANTES de llamar al @Transform, y eso correría
  // el motor sobre un form limpio.
  @Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return !(raw === false || raw === 'false');
  })
  @IsOptional()
  @IsBoolean()
  sucio?: boolean;

  @ApiPropertyOptional({
    description:
      'Fecha de traslado inicial / salida (ISO) → TRASLADOS del PDF.',
    example: '2026-09-12T13:00:00Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_inicial?: Date;

  @ApiPropertyOptional({
    description: 'Fecha de traslado final / regreso (ISO) → TRASLADOS del PDF.',
    example: '2026-09-12T23:00:00Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  @ApiPropertyOptional({
    description: 'Notas visibles para el cliente (pie del desglose).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({
    type: [EscalaPdfPreviewDto],
    description:
      'Ojito/fecha PDF por tramo (cruce por orden 1..N). Manda sobre el tramo del DTO y sobre la escala viva.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EscalaPdfPreviewDto)
  escalas_pdf?: EscalaPdfPreviewDto[];

  @ApiPropertyOptional({
    description:
      'Operador externo (solo informativo: el PDF nunca lo imprime; se acepta para que el body del cotizador viaje completo).',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo?: string;
}

// Los obligatorios del motor (los 4 fijos y los 3 del modo ad-hoc, que el
// padre exige cuando no hay tipo MULTIESCALA ni ruta_id) se relajan SOLO
// para la vista previa LIMPIA (quote_id + sucio=false): un `ValidateIf`
// registrado sobre la propiedad en el hijo apaga TODAS las restricciones
// heredadas del padre cuando devuelve false (class-validator evalúa las
// condicionales primero y las une con AND). Se registra programáticamente
// (el decorador es una función) para no redeclarar los campos (TS2612 con
// useDefineForClassFields).
for (const prop of [
  'aeronave_id',
  'tipo_tarifa',
  'pasajeros',
  'metodo_pago',
  'origen_iata',
  'destino_iata',
  'millas_nauticas',
] as const) {
  ValidateIf(requiereMotor)(PreviewQuoteDto.prototype, prop);
}
