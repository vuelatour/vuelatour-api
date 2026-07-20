import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAeronaveDto {
  @ApiProperty({ example: 'XB-PEV', maxLength: 10 })
  @IsString()
  @Length(3, 10)
  matricula!: string;

  @ApiProperty({ example: 'Cessna 206', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  modelo!: string;

  @ApiProperty({ enum: ['MX', 'USA'] })
  @IsIn(['MX', 'USA'])
  pais_registro!: 'MX' | 'USA';

  @ApiProperty({ description: '1 o 2 motores', enum: [1, 2] })
  @IsInt()
  @Min(1)
  @Max(2)
  num_motores!: number;

  @ApiProperty({ description: 'Velocidad de crucero en nudos', example: 120 })
  @IsNumber()
  @Min(1)
  velocidad_crucero_kts!: number;

  @ApiProperty({ description: 'Asientos pasajeros (sin piloto)', example: 5 })
  @IsInt()
  @Min(1)
  asientos!: number;

  @ApiPropertyOptional({ description: 'Tarifa pública USD/hora' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarifa_hora_pub_usd?: number;

  @ApiPropertyOptional({ description: 'Tarifa broker USD/hora' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tarifa_hora_broker_usd?: number;

  @ApiPropertyOptional({ description: 'Reserva overhaul por hora (USD)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reserva_overhaul_hr_usd?: number;

  @ApiPropertyOptional({
    description:
      'Aportación AFAC (USD por hora cobrada) por volar con matrícula extranjera. Vacío = no aplica. La usa el Balance por avión.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  permiso_afac_usd_hr?: number;

  @ApiPropertyOptional({
    description: 'Color hex para UI (#XXXXXX)',
    example: '#3B82F6',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color_calendario must be hex #RRGGBB',
  })
  color_calendario?: string;

  @ApiPropertyOptional({
    description: 'IATA base',
    example: 'CUN',
    default: 'CUN',
  })
  @IsOptional()
  @IsString()
  @Length(3, 4)
  ubicacion_base?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({
    description:
      'Secuencia de intervalos de servicio en horas que se repite (ej. [50,100,200] o [100]).',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Min(1, { each: true })
  servicio_intervalos?: number[];

  @ApiPropertyOptional({
    description: 'Horómetro (Hobbs) donde arranca la secuencia de servicios.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  servicio_horas_base?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
