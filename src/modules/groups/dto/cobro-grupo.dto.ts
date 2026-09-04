import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
  NotEquals,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CUENTAS_COBRO } from '../../../common/cuentas-cobro';
import { Moneda } from '../../bank-accounts/dto/bank-accounts.dto';
import { MetodoPago } from '../../quotes/dto/calculate-quote.dto';

/** Una parte dada a mano: [{vuelo_id, monto}] con Σ == monto del sobre. */
export class ParticionManualItemDto {
  @ApiProperty({ description: 'Vuelo hijo (vivo) del grupo.' })
  @IsUUID()
  vuelo_id!: string;

  @ApiProperty({
    description:
      'Parte NATIVA para ese avión (mismo signo que el sobre; 0 = no recibe).',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  monto!: number;
}

/**
 * SOBRE de cobro de un grupo (4-sep-2026, Fase 2): el pago único del cliente
 * que se PARTE en N cobro_vuelo (uno por avión vivo). Mismas reglas que el
 * cobro por vuelo (moneda, método, TC, comisión bancaria BRUTO/neto, cuenta
 * destino fija, idempotencia por client_request_id). Monto negativo =
 * reembolso del grupo (sin comisión). Roles: ADMIN/COORDINADOR/FACTURACION
 * — el PILOTO no cobra a nivel grupo (sigue cobrando en SU vuelo).
 */
export class CreateCobroGrupoDto {
  @ApiProperty({
    description:
      'Monto NATIVO del pago (≠ 0). Negativo = reembolso del grupo, repartido por lo cobrado de cada avión.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @NotEquals(0, { message: 'monto no puede ser 0' })
  monto!: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiProperty({ enum: MetodoPago })
  @IsEnum(MetodoPago)
  metodo_cobro!: MetodoPago;

  @ApiPropertyOptional({
    description:
      'TC del pago. Con MXN es necesario (si falta se usa el TC del grupo); el mismo TC viaja al sobre y a las N partes.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco en % sobre el sobre (BRUTO en monto; neto = monto − comisión). Se parte con los mismos pesos que el monto.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(20)
  comision_banco_pct?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco como MONTO directo en la moneda del sobre (manda sobre el %).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  comision_banco_monto?: number;

  @ApiPropertyOptional({
    description: 'Cuenta que recibió el pago (lista fija del cliente).',
    enum: CUENTAS_COBRO,
  })
  @IsOptional()
  @ValidateIf((o: { cuenta_destino?: string }) => !!o.cuenta_destino)
  @IsIn(CUENTAS_COBRO, {
    message:
      'cuenta_destino debe ser una de: Paywise, HSBC Dólares, HSBC Pesos, Scotiabank Dólares, Scotiabank Pesos',
  })
  cuenta_destino?: string;

  @ApiPropertyOptional({ description: 'Referencia bancaria / ticket / link.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional({
    description: 'Path del voucher en storage (cobro-vouchers).',
  })
  @IsOptional()
  @IsString()
  foto_voucher_url?: string;

  @ApiPropertyOptional({
    description: 'Fecha real del pago (default: now()).',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_cobro?: Date;

  @ApiPropertyOptional({
    description:
      'Notas del sobre. En un reembolso es el MOTIVO (queda en cada parte).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Llave de IDEMPOTENCIA (uuid v4): un reintento con la misma llave devuelve el sobre YA registrado (200) sin duplicar dinero.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  @ApiPropertyOptional({
    enum: ['AUTO', 'MANUAL'],
    description:
      'AUTO (default): LIQUIDACION si el pago cubre los saldos (±1 USD) o PROPORCIONAL al precio de cada avión; reembolsos proporcionales a lo cobrado. MANUAL: usa particion_manual.',
  })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  modo?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({
    type: [ParticionManualItemDto],
    description:
      'Partes dadas a mano (solo con modo MANUAL); Σ == monto exacto.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ParticionManualItemDto)
  particion_manual?: ParticionManualItemDto[];
}
