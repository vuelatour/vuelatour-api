import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { MedioPago } from './expenses.dto';

// Forma YYYY-MM-DD + fecha REAL (strict: 2026-02-30 no pasa).
const FECHA_YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «Registrar gasto» de una compra (21-oct-2026, invariante 101):
 * `POST /v1/compras/:id/registrar-gasto`. El MONTO no viaja: es el total de
 * la factura de mercancía que calcula el API (líneas + cargos impresos en
 * ella), en la moneda de la compra. El T.C. es OBLIGATORIO en las dos
 * monedas y se valida en banda (15–25, `compra-gasto.util.ts`).
 */
export class RegistrarGastoCompraDto {
  @ApiProperty({
    description:
      'Tipo de cambio (MXN por USD) del pago. OBLIGATORIO en pesos y en dólares; fuera de 15–25 responde 400 TC_FUERA_DE_RANGO.',
    example: 18.25,
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 6 },
    { message: 'tc_usd_mxn debe ser un número (pesos por dólar)' },
  )
  @IsPositive({ message: 'tc_usd_mxn debe ser mayor a 0' })
  tc_usd_mxn!: number;

  @ApiProperty({
    example: '2026-10-21',
    description:
      'Fecha del pago (día Cancún). Una fecha futura queda «por pagar».',
  })
  @Matches(FECHA_YMD, { message: 'fecha_gasto debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha_gasto inválida (YYYY-MM-DD)' })
  fecha_gasto!: string;

  @ApiProperty({
    enum: MedioPago,
    description: 'Obligatorio (BODEGA no existe aquí: es un pago real).',
  })
  @IsEnum(MedioPago, { message: 'medio_pago inválido' })
  medio_pago!: MedioPago;

  @ApiPropertyOptional({
    description: 'Solo con TARJETA_CORP; vacío = la asignada a quien registra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({
    description:
      'Cuenta de donde salió el pago (invariante 98): solo se guarda con TRANSFERENCIA, DOMICILIADO o PAYWISE.',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'Default: el proveedor de la compra.' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Folio / factura del proveedor (candado anti-duplicados del gasto: repetido ⇒ 409).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio_ticket?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia del alta (uuid): un reintento con la misma llave no duplica el gasto.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}
