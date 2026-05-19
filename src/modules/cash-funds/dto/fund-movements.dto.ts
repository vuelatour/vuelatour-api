import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum TipoMovimientoFondo {
  REPOSICION = 'REPOSICION',
  REINTEGRO = 'REINTEGRO',
  AJUSTE = 'AJUSTE',
}

export enum EstadoMovimientoFondo {
  SOLICITADO = 'SOLICITADO',
  AUTORIZADO = 'AUTORIZADO',
  RECHAZADO = 'RECHAZADO',
}

/** Estados a los que un autorizador puede resolver una solicitud. */
export enum ResolucionMovimientoFondo {
  AUTORIZADO = 'AUTORIZADO',
  RECHAZADO = 'RECHAZADO',
}

export class ListFundMovementsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  fondo_id?: string;

  @ApiPropertyOptional({ enum: TipoMovimientoFondo })
  @IsOptional()
  @IsEnum(TipoMovimientoFondo)
  tipo?: TipoMovimientoFondo;

  @ApiPropertyOptional({ enum: EstadoMovimientoFondo })
  @IsOptional()
  @IsEnum(EstadoMovimientoFondo)
  estado?: EstadoMovimientoFondo;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateFundMovementDto {
  @ApiProperty()
  @IsUUID()
  fondo_id!: string;

  @ApiProperty({ enum: TipoMovimientoFondo })
  @IsEnum(TipoMovimientoFondo)
  tipo!: TipoMovimientoFondo;

  @ApiProperty({ description: 'Monto. Siempre positivo.' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto!: number;

  @ApiPropertyOptional({
    description: 'Fecha del movimiento (YYYY-MM-DD). Default: hoy.',
  })
  @IsOptional()
  @IsDateString()
  fecha?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class ResolveFundMovementDto {
  @ApiProperty({ enum: ResolucionMovimientoFondo })
  @IsEnum(ResolucionMovimientoFondo)
  estado!: ResolucionMovimientoFondo;

  @ApiPropertyOptional({ description: 'Nota de la resolucion' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}
