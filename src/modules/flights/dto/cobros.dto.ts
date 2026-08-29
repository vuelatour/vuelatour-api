import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CUENTAS_COBRO } from '../../../common/cuentas-cobro';
import { Moneda } from '../../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../../quotes/dto/calculate-quote.dto';

export class CreateCobroDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  monto!: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiProperty({ enum: MetodoPago })
  @IsEnum(MetodoPago)
  metodo_cobro!: MetodoPago;

  @ApiPropertyOptional({
    description: 'TC al momento del cobro (si moneda=USD y se factura en MXN)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco en % sobre este cobro (terminal/transferencia/link). ' +
      'El monto sigue siendo lo que pagó el CLIENTE; el banco deposita ' +
      'monto − comisión. Explica la diferencia contra el estado de cuenta.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(20)
  comision_banco_pct?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco como MONTO directo en la moneda del cobro (el ' +
      'estado de cuenta trae pesos, no %). Si viene, manda sobre el % (que ' +
      'se deriva solo como referencia).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  comision_banco_monto?: number;

  @ApiPropertyOptional({
    description:
      'A qué CUENTA llegó el cobro (transferencia/HSBC link/cheque). Lista ' +
      'fija del cliente (28-ago-2026): Paywise · HSBC Dólares · HSBC Pesos · ' +
      'Scotiabank Dólares · Scotiabank Pesos.',
    enum: CUENTAS_COBRO,
  })
  @IsOptional()
  @ValidateIf((o: { cuenta_destino?: string }) => !!o.cuenta_destino)
  @IsIn(CUENTAS_COBRO, {
    message:
      'cuenta_destino debe ser una de: Paywise, HSBC Dólares, HSBC Pesos, Scotiabank Dólares, Scotiabank Pesos',
  })
  cuenta_destino?: string;

  @ApiPropertyOptional({
    description: 'Referencia bancaria, ticket, link, voucher BillPocket',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional({
    description:
      'Fecha real del cobro (puede diferir de la del vuelo). Default: now()',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_cobro?: Date;

  @ApiPropertyOptional({
    description:
      'Path del voucher en storage (cobro-vouchers). Obligatorio si método es tarjeta.',
  })
  @IsOptional()
  @IsString()
  foto_voucher_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Llave de IDEMPOTENCIA generada por el cliente (uuid v4, una por ' +
      'captura). Un reintento (timeout tras commit, doble flush del outbox, ' +
      'doble tap) con la misma llave devuelve el cobro YA registrado en vez ' +
      'de duplicar dinero. Índice único uq_cobro_vuelo_client_request.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

/** Corrección de un cobro por oficina; todo opcional (patch). */
export class UpdateCobroDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  monto?: number;

  @ApiPropertyOptional({ enum: Moneda })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({ enum: MetodoPago })
  @IsOptional()
  @IsEnum(MetodoPago)
  metodo_cobro?: MetodoPago;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco en % (0 = quitarla). Recalcula el monto de comisión.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(20)
  comision_banco_pct?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco como MONTO directo (0 = quitarla). Manda sobre el %.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  comision_banco_monto?: number;

  @ApiPropertyOptional({
    description:
      'A qué CUENTA llegó el cobro (transferencia/HSBC link/cheque). Lista ' +
      'fija del cliente (28-ago-2026): Paywise · HSBC Dólares · HSBC Pesos · ' +
      'Scotiabank Dólares · Scotiabank Pesos.',
    enum: CUENTAS_COBRO,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: { cuenta_destino?: string }) => !!o.cuenta_destino)
  @IsIn(CUENTAS_COBRO, {
    message:
      'cuenta_destino debe ser una de: Paywise, HSBC Dólares, HSBC Pesos, Scotiabank Dólares, Scotiabank Pesos',
  })
  cuenta_destino?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_cobro?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
