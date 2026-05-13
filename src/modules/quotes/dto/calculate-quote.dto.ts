import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

export class CalculateQuoteDto {
  @ApiProperty({ description: 'Aeronave que vuela la ruta' })
  @IsUUID()
  aeronave_id!: string;

  // Either ruta_id OR (origen+destino+millas_nauticas) — validated below
  @ApiPropertyOptional({ description: 'Si se pasa, usa la ruta predefinida' })
  @IsOptional()
  @IsUUID()
  ruta_id?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: aeropuerto origen IATA. Requerido si no hay ruta_id.' })
  @ValidateIf((o: CalculateQuoteDto) => !o.ruta_id)
  @IsString()
  @Length(3, 4)
  origen_iata?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: aeropuerto destino IATA. Requerido si no hay ruta_id.' })
  @ValidateIf((o: CalculateQuoteDto) => !o.ruta_id)
  @IsString()
  @Length(3, 4)
  destino_iata?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc: millas náuticas. Requerido si no hay ruta_id.' })
  @ValidateIf((o: CalculateQuoteDto) => !o.ruta_id)
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas?: number;

  @ApiPropertyOptional({ description: 'Ad-hoc: motor multiplica NM por 2 (default true)' })
  @IsOptional()
  @IsBoolean()
  es_redondo_auto?: boolean;

  @ApiPropertyOptional({ description: 'Ad-hoc: número de aterrizajes (default 2)' })
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
