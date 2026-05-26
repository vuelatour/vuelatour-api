import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
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
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum TipoRuta {
  SIMPLE = 'SIMPLE',
  MULTIESCALA = 'MULTIESCALA',
}

export class RouteTramoInputDto {
  @ApiProperty({ example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ example: 'HOL' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ description: 'Millas nauticas del tramo (one-way)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas!: number;
}

export class ListRoutesQuery {
  @ApiPropertyOptional({ description: 'Filtra por aeropuerto origen (IATA)' })
  @IsOptional()
  @IsString()
  @Length(3, 4)
  origen?: string;

  @ApiPropertyOptional({ description: 'Filtra por aeropuerto destino (IATA)' })
  @IsOptional()
  @IsString()
  @Length(3, 4)
  destino?: string;

  @ApiPropertyOptional({
    description: 'Búsqueda libre por iata origen/destino',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activa?: boolean;

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

export class CreateRouteDto {
  @ApiPropertyOptional({
    enum: TipoRuta,
    default: TipoRuta.SIMPLE,
    description:
      'SIMPLE = un par origen->destino con NM. MULTIESCALA = se ignoran origen_iata/destino_iata/millas_nauticas; en su lugar provee `tramos[]`.',
  })
  @IsOptional()
  @IsEnum(TipoRuta)
  tipo?: TipoRuta;

  @ApiPropertyOptional({
    example: 'CUN',
    description:
      'Requerido si tipo=SIMPLE. Para MULTIESCALA se deriva del primer tramo.',
  })
  @ValidateIf(
    (o: CreateRouteDto) => (o.tipo ?? TipoRuta.SIMPLE) === TipoRuta.SIMPLE,
  )
  @IsString()
  @Length(3, 4)
  origen_iata?: string;

  @ApiPropertyOptional({
    example: 'CZM',
    description:
      'Requerido si tipo=SIMPLE. Para MULTIESCALA se deriva del último tramo.',
  })
  @ValidateIf(
    (o: CreateRouteDto) => (o.tipo ?? TipoRuta.SIMPLE) === TipoRuta.SIMPLE,
  )
  @IsString()
  @Length(3, 4)
  destino_iata?: string;

  @ApiPropertyOptional({
    description:
      'Millas náuticas one-way (SIMPLE). En MULTIESCALA se calcula como suma de tramos.',
    example: 63.14,
  })
  @ValidateIf(
    (o: CreateRouteDto) => (o.tipo ?? TipoRuta.SIMPLE) === TipoRuta.SIMPLE,
  )
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'SIMPLE: motor multiplica NM por 2. Ignorado en MULTIESCALA.',
  })
  @IsOptional()
  @IsBoolean()
  es_redondo_auto?: boolean;

  @ApiPropertyOptional({
    default: 2,
    description: 'Aterrizajes. En MULTIESCALA se deriva de tramos.length.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  num_aterrizajes?: number;

  @ApiPropertyOptional({
    type: [RouteTramoInputDto],
    description:
      'Requerido si tipo=MULTIESCALA. Tramos ordenados con continuidad (destino[i] === origen[i+1]).',
  })
  @ValidateIf((o: CreateRouteDto) => o.tipo === TipoRuta.MULTIESCALA)
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => RouteTramoInputDto)
  tramos?: RouteTramoInputDto[];

  @ApiPropertyOptional({
    example: 'FOREFLIGHT',
    description: 'GOOGLE_EARTH | FOREFLIGHT | MANUAL | APROXIMACION',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fuente?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateRouteDto extends PartialType(CreateRouteDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
