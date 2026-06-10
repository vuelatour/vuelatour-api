import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum TipoTarifa {
  PUBLICO = 'PUBLICO',
  BROKER = 'BROKER',
}

export enum MetodoPago {
  BILLPOCKET = 'BILLPOCKET',
  HSBC_LINK = 'HSBC_LINK',
  TRANSFERENCIA = 'TRANSFERENCIA',
  EFECTIVO = 'EFECTIVO',
  DOLARES = 'DOLARES',
}

export enum TipoVuelo {
  REDONDO = 'REDONDO',
  MULTIESCALA = 'MULTIESCALA',
}

export enum TipoParada {
  NORMAL = 'NORMAL',
  SERVICIO = 'SERVICIO',
}

export class EscalaInputDto {
  @ApiProperty({ description: 'IATA origen del tramo', example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ description: 'IATA destino del tramo', example: 'HOL' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ description: 'Millas nauticas del tramo (one-way)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas!: number;

  // ---- Detalle por tramo (opcional; defaults en el motor) ----
  @ApiPropertyOptional({ description: 'Pax de este tramo (TUAS por tramo). Si null usa los pax globales.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional({ description: 'Tramo ferry (vacío): cobra tiempo+calzos pero 0 pax / sin TUAS.' })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional({ description: 'Marca pernocta en este tramo (suma viáticos).' })
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({ description: 'Costo de pernocta/viáticos del tramo (USD). Default si null.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pernocta_costo_usd?: number;

  @ApiPropertyOptional({ enum: TipoParada, description: 'NORMAL o SERVICIO (parada técnica/servicio).' })
  @IsOptional()
  @IsEnum(TipoParada)
  tipo_parada?: TipoParada;

  @ApiPropertyOptional({ description: 'Notas de servicio (ej. "aterriza en Toledo a cambiar llanta").' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  servicio_notas?: string;
}

export class CalculateQuoteDto {
  @ApiProperty({ description: 'Aeronave que vuela la ruta' })
  @IsUUID()
  aeronave_id!: string;

  @ApiPropertyOptional({
    enum: TipoVuelo,
    description:
      'Tipo de vuelo. Default REDONDO. Si MULTIESCALA, debe proveerse `escalas[]` (>=2).',
  })
  @IsOptional()
  @IsEnum(TipoVuelo)
  tipo?: TipoVuelo;

  // ---- MULTIESCALA: lista ordenada de tramos ----
  // Solo se exigen si tipo=MULTIESCALA Y no viene ruta_id (cuando hay ruta_id
  // del catalogo, el service hidrata las escalas desde ahi).
  @ApiPropertyOptional({
    type: [EscalaInputDto],
    description:
      'Requerido si tipo=MULTIESCALA y no se pasa ruta_id. Tramos ordenados (ej. CUN->HOL, HOL->CZM, CZM->CUN).',
  })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo === TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => EscalaInputDto)
  escalas?: EscalaInputDto[];

  // ---- Single-leg: ruta predefinida o ad-hoc ----
  @ApiPropertyOptional({ description: 'Si se pasa, usa la ruta predefinida' })
  @ValidateIf((o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA)
  @IsOptional()
  @IsUUID()
  ruta_id?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: aeropuerto origen IATA. Requerido si no hay ruta_id ni escalas.' })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsString()
  @Length(3, 4)
  origen_iata?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: aeropuerto destino IATA. Requerido si no hay ruta_id ni escalas.' })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsString()
  @Length(3, 4)
  destino_iata?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: millas náuticas. Requerido si no hay ruta_id ni escalas.' })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas?: number;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: motor multiplica NM por 2 (vuelo redondo). Default true — todos los vuelos son redondos. Ignorado en MULTIESCALA.',
  })
  @IsOptional()
  @IsBoolean()
  es_redondo_auto?: boolean;

  @ApiPropertyOptional({ description: 'Ad-hoc: número de aterrizajes (default 2). Ignorado en MULTIESCALA (se deriva de escalas.length).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  num_aterrizajes?: number;

  @ApiProperty({ enum: TipoTarifa })
  @IsEnum(TipoTarifa)
  tipo_tarifa!: TipoTarifa;

  @ApiProperty({ description: 'Número de pasajeros (para TUAS)', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros!: number;

  @ApiPropertyOptional({ description: 'Pasajeros con pase de abordar (exenta TUAS excepto en Cozumel)' })
  @IsOptional()
  @IsBoolean()
  pase_abordar?: boolean;

  @ApiProperty({ enum: MetodoPago, description: 'Determina si aplica IVA' })
  @IsEnum(MetodoPago)
  metodo_pago!: MetodoPago;

  @ApiPropertyOptional({ description: 'Tarifa por hora override (USD). Si null, usa la del avión.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tarifa_hora_override_usd?: number;

  @ApiPropertyOptional({ description: 'TUAS por pasajero override (USD). Si null, usa la del aeropuerto.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tuas_override_usd_pax?: number;

  @ApiPropertyOptional({ description: 'Override de IVA (0.16 default si transferencia/tarjeta)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  iva_pct_override?: number;
}
