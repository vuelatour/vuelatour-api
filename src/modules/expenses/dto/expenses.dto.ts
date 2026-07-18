import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import {
  ArrayMinSize,
  IsArray,
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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export enum CategoriaGasto {
  GAS = 'GAS',
  ATERRIZAJE = 'ATERRIZAJE',
  OPERACIONES = 'OPERACIONES',
  TUAS = 'TUAS',
  FBO = 'FBO',
  COMIDA = 'COMIDA',
  HOTEL = 'HOTEL',
  TAXI = 'TAXI',
  REFACCION = 'REFACCION',
  PERMISO = 'PERMISO',
  /** Honorario del piloto externo (freelance sin acceso; lo captura oficina). */
  PILOTO_EXTERNO = 'PILOTO_EXTERNO',
  FIJO = 'FIJO',
  /** Gasto indirecto de la operación (SIN vuelo; avión opcional). Por ahora
   *  fuera del reparto y de la bandeja de pendientes — pendiente de decidir
   *  su tratamiento con el equipo (hoja "gastos indirectos" de su control). */
  INDIRECTO = 'INDIRECTO',
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

export enum TipoCombustible {
  TURBOSINA = 'TURBOSINA',
  AVGAS = 'AVGAS',
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

  @ApiPropertyOptional({
    description:
      'Propina incluida en monto (monto = ticket + propina; monto es lo que llega al banco).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  propina?: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio MXN/USD si el gasto es en moneda distinta a USD',
  })
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

  @ApiPropertyOptional({
    description:
      'Escala/aterrizaje asociado (gastos de pista: un gasto por aterrizaje)',
  })
  @IsOptional()
  @IsUUID()
  escala_id?: string;

  @ApiPropertyOptional({
    description: 'Aeronave (opcional). null = bandeja de pendientes',
  })
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

  @ApiPropertyOptional({ description: 'Litros cargados (solo combustible)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  litros?: number;

  @ApiPropertyOptional({ enum: TipoCombustible })
  @IsOptional()
  @IsEnum(TipoCombustible)
  tipo_combustible?: TipoCombustible;

  @ApiPropertyOptional({ description: 'Aeropuerto/FBO donde se hizo la carga' })
  @IsOptional()
  @IsString()
  lugar?: string;

  @ApiPropertyOptional({
    description: 'Momento preciso de la carga (ISO); permite sugerir el vuelo',
  })
  @IsOptional()
  @IsDateString()
  fecha_hora_carga?: string;

  @ApiPropertyOptional({
    description: 'Valores extraídos por IA antes de confirmación',
  })
  @IsOptional()
  @IsObject()
  valor_ia_extraido?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Captura offline con foto: al recibirla, el servidor lee el comprobante con IA y completa lo que falte (desglose, fecha del ticket, matrícula→avión) sin pisar lo capturado a mano.',
  })
  @IsOptional()
  @IsBoolean()
  leer_con_ia?: boolean;

  @ApiPropertyOptional({
    description:
      'Backfill de oficina: registra el gasto COMO SI lo hubiera subido el ' +
      'piloto del vuelo (usuario_captura + origen = PILOTO). Requiere ' +
      'vuelo_id y que el vuelo tenga piloto. La auditoría (created_by) ' +
      'conserva al usuario real que lo cargó. Solo ADMIN/COORDINADOR.',
  })
  @IsOptional()
  @IsBoolean()
  capturar_como_piloto?: boolean;
}

export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({
    description: 'Bandera de posible duplicado (la oficina la descarta).',
  })
  @IsOptional()
  @IsBoolean()
  duplicado_sospechado?: boolean;
}

// ===== Gastos de pista (cuotas de aeródromo VIP SAESA) =====

export class PistasPendientesQuery {
  @ApiProperty({ description: 'fecha >= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'fecha <= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  hasta!: string;
}

export class GenerarPistaItemDto {
  @ApiProperty({
    description: 'Escala (aterrizaje) a la que corresponde la cuota',
  })
  @IsUUID()
  escala_id!: string;

  @ApiProperty({ description: 'Monto de la cuota (editable; PCE es variable)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    enum: CategoriaGasto,
    default: CategoriaGasto.OPERACIONES,
  })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ enum: MedioPago, default: MedioPago.TRANSFERENCIA })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class GenerarPistasDto {
  @ApiProperty({ type: [GenerarPistaItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerarPistaItemDto)
  items!: GenerarPistaItemDto[];
}

export class CreateTarifaAerodromoDto {
  @ApiPropertyOptional({
    description: 'IATA del aeródromo; vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  codigo_iata?: string;

  @ApiPropertyOptional({
    description:
      'Modelo de aeronave (Kodiak/Cessna/Seneca); vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelo?: string;

  @ApiProperty({ description: 'Cuota por aterrizaje' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    description: 'Tarifa variable (p.ej. PCE): el monto es estimado',
  })
  @IsOptional()
  @IsBoolean()
  variable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateTarifaAerodromoDto extends PartialType(
  CreateTarifaAerodromoDto,
) {}

export class PhotoUrlsDto {
  @ApiProperty({
    type: [String],
    description: 'Paths de fotos en gasto-fotos a firmar',
  })
  @IsString({ each: true })
  paths!: string[];
}

export class SugerirVueloQuery {
  @ApiProperty({ description: 'Aeronave de la carga' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Momento de la carga (ISO 8601)' })
  @IsDateString()
  fecha_hora!: string;
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

  @ApiPropertyOptional({
    description: 'Solo gastos sin avión asignado (bandeja de pendientes).',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  pendientes?: boolean;

  @ApiPropertyOptional({
    description: 'Solo gastos marcados como posible duplicado.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  duplicados?: boolean;

  @ApiPropertyOptional({ enum: EstatusComprobante })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({ enum: MedioPago })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

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
