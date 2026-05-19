import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum TipoFondo {
  FIJO = 'FIJO',
  REINTEGRO = 'REINTEGRO',
}

/** Subconjunto de medio_pago que puede enlazar a un fondo de caja chica. */
export enum MedioPagoFondo {
  EFECTIVO = 'EFECTIVO',
  PERSONAL_PABLO = 'PERSONAL_PABLO',
  PERSONAL_ALE = 'PERSONAL_ALE',
}

export enum MonedaFondo {
  MXN = 'MXN',
  USD = 'USD',
}

export class ListFundsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_id?: string;

  @ApiPropertyOptional({ enum: TipoFondo })
  @IsOptional()
  @IsEnum(TipoFondo)
  tipo?: TipoFondo;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateFundDto {
  @ApiProperty()
  @IsUUID()
  usuario_id!: string;

  @ApiProperty({ enum: TipoFondo })
  @IsEnum(TipoFondo)
  tipo!: TipoFondo;

  @ApiProperty({
    enum: MedioPagoFondo,
    description: 'medio_pago de los gastos que consumen el fondo',
  })
  @IsEnum(MedioPagoFondo)
  medio_pago_asociado!: MedioPagoFondo;

  @ApiPropertyOptional({
    description: 'Monto objetivo del fondo FIJO',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_asignado?: number;

  @ApiPropertyOptional({ enum: MonedaFondo, default: MonedaFondo.MXN })
  @IsOptional()
  @IsEnum(MonedaFondo)
  moneda?: MonedaFondo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateFundDto extends PartialType(CreateFundDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
