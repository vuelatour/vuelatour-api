import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
} from '../../quotes/dto/calculate-quote.dto';
import { AvionGrupoDto, ExtraGrupoDto } from './armar-grupo.dto';

/**
 * Revisión de un grupo: campos editables de la cabecera + la lista de
 * aviones. Todo opcional salvo `motivo`; lo que no viaja se conserva.
 * `aviones[]`: los que traen `vuelo_id` actualizan ese hijo; sin `vuelo_id`
 * se crean; los hijos vivos ausentes de la lista se CANCELAN. Omitir la
 * lista = re-materializar los hijos vivos tal como están.
 */
export class ReviseGrupoDto {
  @ApiProperty({ example: 'Cliente subió a 46 pax' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  nombre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pasajeros_total?: number;

  @ApiPropertyOptional({ type: [EscalaInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EscalaInputDto)
  escalas_plantilla?: EscalaInputDto[];

  @ApiPropertyOptional({ enum: TipoTarifa })
  @IsOptional()
  @IsEnum(TipoTarifa)
  tarifa_tipo?: TipoTarifa;

  @ApiPropertyOptional({ enum: MetodoPago })
  @IsOptional()
  @IsEnum(MetodoPago)
  metodo_pago?: MetodoPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  metodo_pago_detalle?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  tc_usd_mxn?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pase_abordar?: boolean;

  @ApiPropertyOptional({
    type: [ExtraGrupoDto],
    description: 'Reemplaza la lista de extras del grupo.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ExtraGrupoDto)
  extras_grupo?: ExtraGrupoDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  ajuste_grupo_usd?: number;

  @ApiPropertyOptional({ type: [AvionGrupoDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AvionGrupoDto)
  aviones?: AvionGrupoDto[];

  @ApiPropertyOptional({
    description:
      'Si algún hijo está congelado (cobrado/facturado/mes cerrado), aplicar el cambio SOLO a los editables en vez de rechazar con 409 (el total cambia; se avisa).',
  })
  @IsOptional()
  @IsBoolean()
  solo_editables?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas_internas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_anexo_aviones?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_subtotal_por_avion?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_precio_por_persona?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_tarifa?: boolean;
}
