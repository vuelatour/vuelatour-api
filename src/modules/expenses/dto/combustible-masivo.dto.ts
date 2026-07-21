import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  EstatusComprobante,
  MedioPago,
  Moneda,
  TipoCombustible,
} from './expenses.dto';

/** Tope de filas por archivo: protege el request (inserción secuencial). */
export const MAX_FILAS_COMBUSTIBLE = 500;

export class PreviewCargaCombustibleDto {
  @ApiProperty({ description: 'Archivo XLSX de la plantilla, en base64' })
  @IsString()
  archivo_base64!: string;

  @ApiProperty({ description: 'Nombre del archivo (para el parser)' })
  @IsString()
  filename!: string;
}

/**
 * Fila NORMALIZADA que devuelve el preview en `datos` y que la carga
 * definitiva recibe de vuelta. El servidor RE-VALIDA todo al crear (el
 * preview es cortesía para el panel, no una autorización).
 */
export class FilaCombustibleDto {
  @ApiProperty({
    description: 'Número de fila del Excel (para reportar errores)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fila!: number;

  @ApiProperty({ description: 'Aeronave resuelta desde la matrícula' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Día de la carga (YYYY-MM-DD, día Cancún)' })
  @IsDateString()
  fecha_gasto!: string;

  @ApiProperty({
    description:
      'Momento de la carga (ISO con offset Cancún; 12:00 si el Excel no traía hora)',
  })
  @IsDateString()
  fecha_hora_carga!: string;

  @ApiProperty({ description: 'Litros cargados (> 0)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  litros!: number;

  @ApiProperty({ description: 'Monto pagado (> 0)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monto!: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({ description: 'TC MXN/USD del día (DOF) si se conoce' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  tc_gasto?: number;

  @ApiPropertyOptional({ enum: TipoCombustible })
  @IsOptional()
  @IsEnum(TipoCombustible)
  tipo_combustible?: TipoCombustible;

  @ApiPropertyOptional({ description: 'Aeropuerto/FBO donde se hizo la carga' })
  @IsOptional()
  @IsString()
  lugar?: string;

  @ApiPropertyOptional({ description: 'Vuelo resuelto desde folio_vuelo' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({ description: 'Proveedor resuelto por nombre' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiProperty({ enum: MedioPago })
  @IsEnum(MedioPago)
  medio_pago!: MedioPago;

  @ApiProperty({
    enum: EstatusComprobante,
    description:
      'Mapeado desde la plantilla: FACTURA→FACTURA, TICKET→VALE, PENDIENTE→SIN_COMPROBANTE',
  })
  @IsEnum(EstatusComprobante)
  estatus_comprobante!: EstatusComprobante;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  // ===== Campos informativos del preview (el panel los pinta; la carga
  // definitiva los IGNORA — con forbidNonWhitelisted deben estar declarados
  // para que el round-trip preview→carga no reviente el request). =====

  @ApiPropertyOptional({ description: 'Solo display: matrícula resuelta' })
  @IsOptional()
  @IsString()
  matricula?: string;

  @ApiPropertyOptional({ description: 'Solo display: nombre del proveedor' })
  @IsOptional()
  @IsString()
  proveedor_nombre?: string;

  @ApiPropertyOptional({ description: 'Solo display: folio del vuelo ligado' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  folio_vuelo?: number;
}

export class CargaMasivaCombustibleDto {
  @ApiProperty({ type: [FilaCombustibleDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FILAS_COMBUSTIBLE)
  @ValidateNested({ each: true })
  @Type(() => FilaCombustibleDto)
  filas!: FilaCombustibleDto[];
}

// ===== Respuestas (shapes de salida; no llevan class-validator) =====

export interface FilaPreviewCombustible {
  fila: number;
  ok: boolean;
  errores: string[];
  advertencias: string[];
  /** Parcial: en filas con error solo trae lo que sí se pudo normalizar. */
  datos: Partial<FilaCombustibleDto>;
}

export interface PreviewCargaCombustibleResult {
  filas: FilaPreviewCombustible[];
  resumen: {
    total: number;
    validas: number;
    con_error: number;
    con_advertencia: number;
  };
}

export interface CargaMasivaCombustibleResult {
  creados: number;
  errores: Array<{ fila: number; error: string }>;
}
