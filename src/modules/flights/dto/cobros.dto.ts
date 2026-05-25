import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
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

  @ApiPropertyOptional({ description: 'TC al momento del cobro (si moneda=USD y se factura en MXN)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ description: 'Referencia bancaria, ticket, link, voucher BillPocket' })
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
