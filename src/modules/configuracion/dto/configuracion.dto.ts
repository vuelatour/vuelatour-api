import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * PATCH de una bandera: `activa` y/o `valor_numerico` (al menos uno; el
 * service lo valida — el DTO no puede exigir "uno de dos" declarativamente).
 */
export class UpdateConfiguracionDto {
  @ApiPropertyOptional({ description: 'Nuevo estado de la bandera' })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({
    description:
      'Valor numérico de la bandera (p.ej. días de la ventana de edición de gastos de campo). Nunca negativo.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valor_numerico?: number;
}

/** Rango del resumen de consumo IA (default: mes actual en pared Cancún). */
export class IaUsoQuery {
  @ApiPropertyOptional({ description: 'Desde YYYY-MM-DD (día Cancún)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta YYYY-MM-DD (día Cancún)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;
}

/** Checkpoint del saldo real de la consola de Anthropic (lo teclea ADMIN). */
export class IaSaldoDto {
  @ApiProperty({
    description: 'Saldo USD visible en la consola de Anthropic al momento',
  })
  @IsNumber()
  @Min(0)
  saldo_usd!: number;

  @ApiPropertyOptional({ description: 'Notas del corte (opcional)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}

/**
 * `PUT /v1/config/responsables-facturacion` (24-sep-2026): quién recibe el
 * aviso «Factura pedida». `[]` = default por rol (FACTURACION → ADMIN).
 * `@IsUUID('all')`: no se asume la versión del uuid de `usuario`.
 */
export class ResponsablesFacturacionDto {
  @ApiProperty({
    type: [String],
    description:
      'Usuarios de oficina ACTIVOS (ADMIN/COORDINADOR/FACTURACION) que reciben el aviso. Máximo 20. Vacío = por rol.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  usuario_ids!: string[];
}

/**
 * `PUT /v1/config/editores-cotizacion-cobrada` (26-sep-2026): quién puede
 * revisar una cotización con cobros registrados. SIN `@ArrayMinSize`: la
 * lista vacía la rechaza el service con el código `LISTA_VACIA` (el
 * ValidationPipe solo daría un 400 genérico sin código).
 */
export class EditoresCotizacionCobradaDto {
  @ApiProperty({
    type: [String],
    description:
      'Usuarios ACTIVOS de oficina (ADMIN/COORDINADOR/FACTURACION) que pueden editar cotizaciones con cobros. Máximo 20. Nunca vacía (400 LISTA_VACIA).',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  usuario_ids!: string[];
}

/**
 * `PUT /v1/config/ia-modelo` (2-oct-2026): modelo de IA de las lecturas.
 * `modelo` es OBLIGATORIO y puede ser `null` (= volver al del servidor). La
 * FORMA del id (`^claude-[a-z0-9.-]{3,80}$`) la valida el service para
 * responder con el código `MODELO_INVALIDO` (el ValidationPipe solo daría un
 * 400 genérico sin código).
 */
export class ModeloIaDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Id del modelo de Anthropic (p. ej. claude-sonnet-5); null = usar el del servidor (ANTHROPIC_MODEL de pyservices). Un id fuera del catálogo se acepta si tiene forma válida.',
  })
  @ValidateIf((o: { modelo?: unknown }) => o.modelo !== null)
  @IsString()
  @MaxLength(200)
  modelo!: string | null;
}
