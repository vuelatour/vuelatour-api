import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  FACTURA_FOLIO_PAGO_MAX,
  FECHA_DIA_REGEX,
  MENSAJE_MES_INVALIDO,
  MENSAJE_MOTIVO_BAJA_PAGO,
  MES_REGEX,
  METODOS_PAGO_SOCIO,
  MONEDAS_PAGO_SOCIO,
  MONTO_PAGO_MAX,
  MOTIVO_BAJA_PAGO_MAX,
  MOTIVO_BAJA_PAGO_MIN,
  NOTAS_PAGO_MAX,
  RECIBIDO_POR_MAX,
  REFERENCIA_PAGO_MAX,
  type MetodoPagoSocio,
  type MonedaPagoSocio,
} from '../reparto-pago.util';

/**
 * PAGOS DE UTILIDADES A SOCIOS (1-oct-2026, API 0.0.49). Las reglas de
 * negocio (T.C. según moneda, fecha no futura, exceso, socio del avión)
 * viven en `reparto-pago.util.ts` y el servicio; aquí solo forma.
 */

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Booleano ESTRICTO sobre el valor CRUDO del body: con
 * `enableImplicitConversion` el texto 'false' llegaría como `true`
 * (patrón de `preview-quote.dto#sucio` y del seguimiento).
 */
const booleanoCrudo = ({ obj, key }: { obj: unknown; key: string }) =>
  (obj as Record<string, unknown>)[key];

const MENSAJE_FECHA = 'La fecha del pago debe tener el formato AAAA-MM-DD.';

/** `GET /v1/profit-sharing/pagos?mes=YYYY-MM[&aeronave_id]`. */
export class PagosMesQuery {
  @ApiProperty({ example: '2026-09', description: 'Mes calendario (AAAA-MM).' })
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  mes!: string;

  @ApiPropertyOptional({ description: 'Limitar a una aeronave' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;
}

/** `POST /v1/profit-sharing/pagos`. */
export class CrearPagoSocioDto {
  @ApiProperty()
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'usuario.id del socio (aeronave_socio).' })
  @IsUUID()
  socio_id!: string;

  @ApiProperty({
    example: '2026-09',
    description: 'Mes que se paga (AAAA-MM).',
  })
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  mes!: string;

  @ApiProperty({
    description: 'Monto entregado en la moneda del pago (≤ 2 decimales).',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MONTO_PAGO_MAX)
  monto!: number;

  @ApiProperty({ enum: MONEDAS_PAGO_SOCIO })
  @IsIn([...MONEDAS_PAGO_SOCIO])
  moneda!: MonedaPagoSocio;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'T.C. USD→MXN: OBLIGATORIO en MXN y prohibido en USD. Se guarda con 6 decimales (no se rechazan decimales de más: se normalizan).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  // Lo que cabe en numeric(12,6); la banda REALISTA (15–25) la aplica
  // `validarDineroPago` con 400 TC_FUERA_DE_RANGO.
  @Max(999_999)
  tc_usd_mxn?: number | null;

  @ApiProperty({
    example: '2026-10-01',
    description: 'Día del pago (Cancún); no futuro.',
  })
  @IsString()
  @Matches(FECHA_DIA_REGEX, { message: MENSAJE_FECHA })
  fecha_pago!: string;

  @ApiProperty({ enum: METODOS_PAGO_SOCIO })
  @IsIn([...METODOS_PAGO_SOCIO])
  metodo!: MetodoPagoSocio;

  @ApiPropertyOptional({ maxLength: REFERENCIA_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(REFERENCIA_PAGO_MAX)
  referencia?: string | null;

  @ApiPropertyOptional({
    description:
      'Quién entregó el dinero (default: quien registra). Usuario ACTIVO.',
  })
  @IsOptional()
  @IsUUID()
  entregado_por_id?: string;

  @ApiPropertyOptional({
    maxLength: RECIBIDO_POR_MAX,
    nullable: true,
    description: 'Nombre de quien recibió si no fue el socio.',
  })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(RECIBIDO_POR_MAX)
  recibido_por?: string | null;

  @ApiPropertyOptional({
    maxLength: FACTURA_FOLIO_PAGO_MAX,
    nullable: true,
    description: 'Folio de la factura cuando el socio cobra con factura.',
  })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(FACTURA_FOLIO_PAGO_MAX)
  factura_folio?: string | null;

  @ApiPropertyOptional({ maxLength: NOTAS_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(NOTAS_PAGO_MAX)
  notas?: string | null;

  @ApiPropertyOptional({
    description:
      'Confirma un pago que rebasa la utilidad del mes (+ $1.00): sin él ⇒ 409 PAGO_EXCEDE_UTILIDAD. No abre SIN_UTILIDAD_QUE_PAGAR.',
  })
  @IsOptional()
  @Transform(booleanoCrudo)
  @IsBoolean()
  aceptar_exceso?: boolean;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia (uuid por captura). El reintento devuelve el pago ya registrado (200, idempotente:true).',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

/**
 * `PATCH /v1/profit-sharing/pagos/:id` — al menos un campo (sin contar
 * `aceptar_exceso`). No cambia avión, socio ni mes. `null` en monto,
 * moneda, fecha, método o quién entregó ⇒ 400 (solo el campo AUSENTE se
 * omite); en los textos y el T.C., `null` limpia.
 */
export class ActualizarPagoSocioDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MONTO_PAGO_MAX)
  monto?: number;

  @ApiPropertyOptional({ enum: MONEDAS_PAGO_SOCIO })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn([...MONEDAS_PAGO_SOCIO])
  moneda?: MonedaPagoSocio;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Al pasar a USD se limpia solo; al pasar a MXN es obligatorio.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  // Lo que cabe en numeric(12,6); la banda REALISTA (15–25) la aplica
  // `validarDineroPago` con 400 TC_FUERA_DE_RANGO.
  @Max(999_999)
  tc_usd_mxn?: number | null;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(FECHA_DIA_REGEX, { message: MENSAJE_FECHA })
  fecha_pago?: string;

  @ApiPropertyOptional({ enum: METODOS_PAGO_SOCIO })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn([...METODOS_PAGO_SOCIO])
  metodo?: MetodoPagoSocio;

  @ApiPropertyOptional({ maxLength: REFERENCIA_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(REFERENCIA_PAGO_MAX)
  referencia?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  entregado_por_id?: string;

  @ApiPropertyOptional({ maxLength: RECIBIDO_POR_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(RECIBIDO_POR_MAX)
  recibido_por?: string | null;

  @ApiPropertyOptional({ maxLength: FACTURA_FOLIO_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(FACTURA_FOLIO_PAGO_MAX)
  factura_folio?: string | null;

  @ApiPropertyOptional({ maxLength: NOTAS_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(NOTAS_PAGO_MAX)
  notas?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(booleanoCrudo)
  @IsBoolean()
  aceptar_exceso?: boolean;
}

/** `DELETE /v1/profit-sharing/pagos/:id` — soft delete con motivo. */
export class EliminarPagoSocioDto {
  @ApiProperty({
    minLength: MOTIVO_BAJA_PAGO_MIN,
    maxLength: MOTIVO_BAJA_PAGO_MAX,
  })
  @Transform(recortar)
  @IsString({ message: MENSAJE_MOTIVO_BAJA_PAGO })
  @MinLength(MOTIVO_BAJA_PAGO_MIN, { message: MENSAJE_MOTIVO_BAJA_PAGO })
  @MaxLength(MOTIVO_BAJA_PAGO_MAX, { message: MENSAJE_MOTIVO_BAJA_PAGO })
  motivo!: string;
}

/**
 * `POST /v1/profit-sharing/pagos/:id/comprobante`: multipart con SOLO el
 * archivo `file` (cualquier campo de texto ⇒ 400 por `forbidNonWhitelisted`).
 */
export class SinCamposComprobantePagoDto {}
