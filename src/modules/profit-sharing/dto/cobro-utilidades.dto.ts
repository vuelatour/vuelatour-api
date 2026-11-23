import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MONEDAS_PAGO_SOCIO,
  MONTO_PAGO_MAX,
  NOTAS_PAGO_MAX,
  type MonedaPagoSocio,
} from '../reparto-pago.util';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Booleano ESTRICTO sobre el valor crudo (patrón de `reparto-pago.dto`). */
const booleanoCrudo = ({ obj, key }: { obj: unknown; key: string }) =>
  (obj as Record<string, unknown>)[key];

/**
 * `POST /v1/profit-sharing/vuelos/:vueloId/cobro-utilidades` (23-nov-2026,
 * API 0.0.148, invariante 143): el socio paga su vuelo con sus utilidades.
 * Solo forma: las reglas (T.C. en las dos monedas, fecha no futura, socio del
 * avión, saldo/adelanto, saldo del vuelo) viven en `reparto-pago.util`,
 * `RepartoPagoService` y `FlightsService.createCobro`.
 */
export class CobroConUtilidadesDto {
  @ApiProperty({ description: 'usuario.id del socio que paga con utilidades.' })
  @IsUUID()
  socio_id!: string;

  @ApiProperty({
    description:
      'El avión DE CUYAS UTILIDADES se descuenta (el socio debe serlo de ese avión). Puede no ser el avión que voló.',
  })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Monto del cobro en su moneda (≤ 2 decimales).' })
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
      'T.C. USD→MXN. Obligatorio en las dos monedas (la cuenta del socio es en pesos); sin él se toma el de la cotización del vuelo. Banda 15–25.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999_999)
  tc_usd_mxn?: number | null;

  @ApiPropertyOptional({
    description:
      'Fecha del cobro (ISO). Su MES (día de Cancún) es el mes de utilidades del que se descuenta. No futura. Default: ahora.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_cobro?: Date;

  @ApiPropertyOptional({ maxLength: NOTAS_PAGO_MAX, nullable: true })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(NOTAS_PAGO_MAX)
  notas?: string | null;

  @ApiPropertyOptional({
    description:
      'Confirma un ADELANTO: el cobro rebasa lo por entregar al socio de meses cerrados. Sin él ⇒ 409 PAGO_EXCEDE_SALDO.',
  })
  @IsOptional()
  @Transform(booleanoCrudo)
  @IsBoolean()
  aceptar_exceso?: boolean;

  @ApiProperty({
    description:
      'Llave de idempotencia (uuid por apertura del formulario). El reintento devuelve el cobro ya registrado (200, idempotente:true).',
  })
  @IsUUID()
  client_request_id!: string;
}
