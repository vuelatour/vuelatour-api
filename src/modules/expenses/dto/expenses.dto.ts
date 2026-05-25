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
  IsString,
  IsUUID,
  Max,
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

export class CreateGastoDto {
  @ApiProperty({ enum: CategoriaGasto })
  @IsEnum(CategoriaGasto)
  categoria!: CategoriaGasto;

  @ApiProperty({ description: 'Monto del gasto' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({ description: 'Tipo de cambio MXN/USD si el gasto es en moneda distinta a USD' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  tc_gasto?: number;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  fecha_gasto!: string;

  @ApiProperty({ enum: MedioPago })
  @IsEnum(MedioPago)
  medio_pago!: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({ description: 'Vuelo asociado (opcional)' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({ description: 'Aeronave (opcional). null = bandeja de pendientes' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ enum: EstatusComprobante })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({ description: 'URL/path en Supabase Storage' })
  @IsOptional()
  @IsString()
  foto_url?: string;

  @ApiPropertyOptional({ description: 'Valores extraídos por IA antes de confirmación' })
  @IsOptional()
  @IsObject()
  valor_ia_extraido?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  conciliado?: boolean;
}

export class PhotoUrlsDto {
  @ApiProperty({ type: [String], description: 'Paths de fotos en gasto-fotos a firmar' })
  @IsString({ each: true })
  paths!: string[];
}

export class ListGastosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_captura_id?: string;

  @ApiPropertyOptional({ enum: CategoriaGasto })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ description: 'fecha_gasto >= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha_gasto <= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  pendientes?: boolean;

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
