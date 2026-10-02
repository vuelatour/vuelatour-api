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
 * ENTREGAS A LA CUENTA DEL SOCIO (v2, 2-oct-2026, API 0.0.50). Las reglas
 * de negocio (T.C. según moneda, fecha no futura, saldo/adelanto, socio del
 * avión) viven en `reparto-pago.util.ts`, `reparto-cuenta.util.ts` y los
 * servicios; aquí solo forma.
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

const MENSAJE_FECHA = 'La fecha debe tener el formato AAAA-MM-DD.';

/**
 * `GET /v1/profit-sharing/pagos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&socio_id]`.
 * `mes` y `aeronave_id` (el listado por mes —y por avión— de la v1) se
 * DECLARAN solo para responder 410 `PAGOS_POR_MES_RETIRADO` con un mensaje
 * claro: el panel 0.0.49 manda `?mes=…&aeronave_id=…` cuando el reparto
 * está filtrado por avión, y sin declararlos `forbidNonWhitelisted` le
 * daría un 400 genérico.
 */
export class PagosQuery {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'fecha_pago desde (AAAA-MM-DD, inclusive).',
  })
  @IsOptional()
  @IsString()
  @Matches(FECHA_DIA_REGEX, { message: MENSAJE_FECHA })
  desde?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'fecha_pago hasta (AAAA-MM-DD, inclusive).',
  })
  @IsOptional()
  @IsString()
  @Matches(FECHA_DIA_REGEX, { message: MENSAJE_FECHA })
  hasta?: string;

  @ApiPropertyOptional({ description: 'Solo las entregas de ese socio.' })
  @IsOptional()
  @IsUUID()
  socio_id?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'RETIRADO en la v2 ⇒ 410 PAGOS_POR_MES_RETIRADO.',
  })
  @IsOptional()
  @IsString()
  mes?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'RETIRADO en la v2 (filtro por avión del listado por mes) ⇒ 410 PAGOS_POR_MES_RETIRADO.',
  })
  @IsOptional()
  @IsString()
  aeronave_id?: string;
}

/** `POST /v1/profit-sharing/pagos` — una ENTREGA a la cuenta del socio. */
export class CrearPagoSocioDto {
  @ApiProperty({ description: 'usuario.id del socio (aeronave_socio).' })
  @IsUUID()
  socio_id!: string;

  @ApiProperty({
    description: 'Monto entregado en la moneda de la entrega (≤ 2 decimales).',
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
    description: 'Día de la entrega (Cancún); no futuro.',
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
    nullable: true,
    description:
      '«Corresponde a» este avión (informativo): el socio debe serlo de ese avión. Vacío = de toda su cuenta.',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string | null;

  @ApiPropertyOptional({
    example: '2026-09',
    nullable: true,
    description:
      '«Corresponde a» este mes (AAAA-MM, informativo, no futuro). Vacío = ADELANTO A CUENTA.',
  })
  @IsOptional()
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  mes?: string | null;

  @ApiPropertyOptional({
    description:
      'Confirma un ADELANTO: la entrega rebasa lo por entregar de meses cerrados (+ $1.00; el mes en curso no cuenta). Sin él ⇒ 409 PAGO_EXCEDE_SALDO.',
  })
  @IsOptional()
  @Transform(booleanoCrudo)
  @IsBoolean()
  aceptar_exceso?: boolean;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia (uuid por apertura del diálogo). El reintento devuelve la entrega ya registrada (200, idempotente:true).',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

/**
 * `PATCH /v1/profit-sharing/pagos/:id` — al menos un campo (sin contar
 * `aceptar_exceso`). No cambia el socio. `null` en monto, moneda, fecha,
 * método o quién entregó ⇒ 400 (solo el campo AUSENTE se omite); en los
 * textos, el T.C., `aeronave_id` y `mes`, `null` limpia.
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

  @ApiPropertyOptional({
    nullable: true,
    description: '«Corresponde a» este avión; null lo quita.',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '«Corresponde a» este mes (AAAA-MM); null = adelanto a cuenta.',
  })
  @IsOptional()
  @IsString()
  @Matches(MES_REGEX, { message: MENSAJE_MES_INVALIDO })
  mes?: string | null;

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
