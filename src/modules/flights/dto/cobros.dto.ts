import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(20)
  comision_banco_pct?: number;

  @ApiPropertyOptional({
    description: 'Referencia bancaria, ticket, link, voucher BillPocket',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional({ description: 'Fecha real del cobro (puede diferir de la del vuelo). Default: now()' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_cobro?: Date;

  @ApiPropertyOptional({
    description: 'Path del voucher en storage (cobro-vouchers). Obligatorio si método es tarjeta.',
  })
  @IsOptional()
  @IsString()
  foto_voucher_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
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
    description: 'Comisión del banco en % (0 = quitarla). Recalcula el monto de comisión.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(20)
  comision_banco_pct?: number;

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
