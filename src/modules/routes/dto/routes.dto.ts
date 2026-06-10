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

export enum TipoParada {
  NORMAL = 'NORMAL',
  SERVICIO = 'SERVICIO',
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

  // ---- Detalle por tramo (defaults de plantilla) ----
  @ApiPropertyOptional({ description: 'Pax sugeridos del tramo. NULL = usa pax globales al cotizar.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional({ description: 'Tramo ferry (vacío): tiempo+calzos, 0 pax / sin TUAS.' })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional({ description: 'Pernocta en este tramo (suma viáticos).' })
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({ description: 'Costo de pernocta/viáticos (USD). Default si null.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pernocta_costo_usd?: number;

  @ApiPropertyOptional({ enum: TipoParada, description: 'NORMAL o SERVICIO.' })
  @IsOptional()
  @IsEnum(TipoParada)
  tipo_parada?: TipoParada;

  @ApiPropertyOptional({ description: 'Notas de servicio (ej. cambiar llanta en Toledo).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  servicio_notas?: string;
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
      'Requerido si tipo=MULTIESCALA. Tramos ordenados con continuidad (destino[i] === origen[i+1]). Mínimo 1 (las rutas se arman siempre por tramos; el regreso lo agrega quien crea la ruta).',
  })
  @ValidateIf((o: CreateRouteDto) => o.tipo === TipoRuta.MULTIESCALA)
  @IsArray()
  @ArrayMinSize(1)
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
