import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum CategoriaGasto {
  GAS = 'GAS',
  ATERRIZAJE = 'ATERRIZAJE',
  TUAS = 'TUAS',
  FBO = 'FBO',
  COMIDA = 'COMIDA',
  HOTEL = 'HOTEL',
  TAXI = 'TAXI',
  REFACCION = 'REFACCION',
  PERMISO = 'PERMISO',
  FIJO = 'FIJO',
  OTRO = 'OTRO',
}

export enum Moneda {
  MXN = 'MXN',
  USD = 'USD',
}

export enum MedioPago {
  EFECTIVO = 'EFECTIVO',
  TARJETA_CORP = 'TARJETA_CORP',
  PERSONAL_PABLO = 'PERSONAL_PABLO',
  PERSONAL_ALE = 'PERSONAL_ALE',
  TRANSFERENCIA = 'TRANSFERENCIA',
}

export enum EstatusComprobante {
  FACTURA = 'FACTURA',
  VALE = 'VALE',
  SIN_COMPROBANTE = 'SIN_COMPROBANTE',
}

export class ListGastosQuery {
  @ApiPropertyOptional({
    description: 'Busca en notas y terminacion de tarjeta',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ enum: CategoriaGasto })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ enum: MedioPago })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

  @ApiPropertyOptional({ enum: EstatusComprobante })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({
    description: 'true = solo gastos sin aeronave (bandeja de pendientes)',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  sin_aeronave?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({ description: 'Fecha de gasto desde (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'Fecha de gasto hasta (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateGastoDto {
  @ApiProperty({ enum: CategoriaGasto })
  @IsEnum(CategoriaGasto)
  categoria!: CategoriaGasto;

  @ApiProperty({ description: 'Monto en la moneda indicada. > 0.' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto!: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({
    description: 'TC DOF del dia (si moneda extranjera vs reporte)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_gasto?: number;

  @ApiProperty({ description: 'Fecha del gasto (YYYY-MM-DD)' })
  @IsDateString()
  fecha_gasto!: string;

  @ApiProperty({ enum: MedioPago })
  @IsEnum(MedioPago)
  medio_pago!: MedioPago;

  @ApiPropertyOptional({
    enum: EstatusComprobante,
    default: EstatusComprobante.SIN_COMPROBANTE,
  })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({ description: 'Vuelo asociado (opcional)' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({
    description: 'Aeronave. Omitir = bandeja de pendientes.',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    description: 'Terminacion de tarjeta (solo si medio_pago=TARJETA_CORP)',
  })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'tarjeta_terminacion deben ser 4 digitos' })
  tarjeta_terminacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  foto_url?: string;

  @ApiPropertyOptional({ description: 'JSON crudo extraido por IA del ticket' })
  @IsOptional()
  @IsObject()
  valor_ia_extraido?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  @ApiPropertyOptional({
    description: 'Marca el gasto como conciliado con estado de cuenta',
  })
  @IsOptional()
  @IsBoolean()
  conciliado?: boolean;
}
