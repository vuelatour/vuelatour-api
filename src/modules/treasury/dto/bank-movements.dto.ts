import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

export enum TipoMovimientoBancario {
  CARGO = 'CARGO',
  ABONO = 'ABONO',
}

export class ListBankMovementsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ enum: TipoMovimientoBancario })
  @IsOptional()
  @IsEnum(TipoMovimientoBancario)
  tipo?: TipoMovimientoBancario;

  @ApiPropertyOptional({
    description: 'true = solo conciliados; false = bandeja pendiente',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({ description: 'Fecha desde (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'Fecha hasta (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateBankMovementDto {
  @ApiProperty()
  @IsUUID()
  cuenta_bancaria_id!: string;

  @ApiProperty({ description: 'Fecha del movimiento (YYYY-MM-DD)' })
  @IsDateString()
  fecha!: string;

  @ApiProperty({ enum: TipoMovimientoBancario })
  @IsEnum(TipoMovimientoBancario)
  tipo!: TipoMovimientoBancario;

  @ApiProperty({ description: 'Monto. Siempre positivo.' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional({
    description: 'Saldo de la cuenta despues del movimiento',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  saldo_posterior?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class UpdateBankMovementDto extends PartialType(CreateBankMovementDto) {}

export class ReconcileBankMovementDto {
  @ApiProperty({ description: 'Gasto con el que se concilia el movimiento' })
  @IsUUID()
  gasto_id!: string;
}
