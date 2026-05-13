import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreateEscalaDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orden!: number;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({ description: 'Hora programada de salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_salida?: Date;

  @ApiPropertyOptional({ description: 'Hora programada de llegada' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_llegada?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateEscalaDto extends PartialType(CreateEscalaDto) {}
