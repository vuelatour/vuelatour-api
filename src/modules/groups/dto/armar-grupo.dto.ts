import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  EscalaInputDto,
  MetodoPago,
  TipoTarifa,
  TuaLineaDto,
} from '../../quotes/dto/calculate-quote.dto';

/**
 * Extra de la CABECERA del grupo (`vuelo_grupo.extras_grupo[]`). Nunca
 * guarda un monto total: se MATERIALIZA en cada hijo según `reparto`.
 */
export class ExtraGrupoDto {
  @ApiPropertyOptional({
    description:
      'Id del extra (uuid). Al revisar, conservarlo mantiene la liga con las líneas ya materializadas en los hijos; si se omite el server genera uno.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Tour Chichén Itzá' })
  @IsString()
  @Length(1, 120)
  concepto!: string;

  @ApiPropertyOptional({
    description:
      'Cantidad TOTAL del grupo (ej. 3 camionetas). Obligatoria cuando por_persona=false; con por_persona=true se ignora (cantidad = pasajeros_total).',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cantidad?: number;

  @ApiProperty({
    description: 'Precio unitario NATIVO en `moneda` (ej. 85 por persona).',
    minimum: 0,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitario!: number;

  @ApiPropertyOptional({ enum: ['USD', 'MXN'], default: 'USD' })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({ description: 'Grava IVA (default true).' })
  @IsOptional()
  @IsBoolean()
  aplica_iva?: boolean;

  @ApiPropertyOptional({
    description:
      'Por persona (default true): la cantidad total es pasajeros_total y cada hijo recibe cantidad = sus pax (reparto POR_PAX).',
  })
  @IsOptional()
  @IsBoolean()
  por_persona?: boolean;

  @ApiPropertyOptional({
    enum: ['POR_PAX', 'ANCLA', 'PROPORCIONAL'],
    default: 'POR_PAX',
    description:
      'POR_PAX: cantidad_i = pax_i (por persona; con cantidad explícita equivale a PROPORCIONAL). PROPORCIONAL: el monto total se reparte por pax con pesos exactos (residuo al ancla). ANCLA: toda la línea al avión ancla.',
  })
  @IsOptional()
  @IsIn(['POR_PAX', 'ANCLA', 'PROPORCIONAL'])
  reparto?: 'POR_PAX' | 'ANCLA' | 'PROPORCIONAL';
}

/** Un avión del grupo (= un vuelo hijo). */
export class AvionGrupoDto {
  @ApiPropertyOptional({
    description:
      'Solo al REVISAR: id del hijo existente que representa este avión. Sin él es un avión NUEVO; los hijos vivos que no vengan en la lista se cancelan.',
  })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiProperty({ description: 'Aeronave propia (activa).' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({
    description:
      'Personas que ESTE avión transporta en el grupo (todas sus vueltas). Σ pax == pasajeros_total al crear.',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pax!: number;

  @ApiPropertyOptional({
    enum: [1, 2],
    default: 1,
    description:
      '2 = doble rotación (ida con w1, regreso ferry, ida con w2, regreso con w1, ida ferry, regreso con w2). Exige plantilla ida y vuelta.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 2])
  rotaciones?: 1 | 2;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  piloto_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  copiloto_id?: string | null;

  @ApiPropertyOptional({
    description: 'Tarifa por hora pactada para este avión (USD).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tarifa_hora_override_usd?: number;

  @ApiPropertyOptional({
    description: 'Horas cobrables pactadas para este avión.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(48)
  tiempo_cobrable_override_hr?: number;

  @ApiPropertyOptional({
    description:
      'Salida planeada de este avión. Si se omite, el armador la escalona (10 min entre aviones; el de doble vuelta primero).',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_salida_plan?: Date;

  @ApiPropertyOptional({
    description:
      'Confirmación explícita: usar el avión AUNQUE tenga discrepancia ALTA sin resolver (409 SQUAWK_ALTA_SIN_RESOLVER sin ella al crear; en el preview solo avisa).',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}

export class ArmarGrupoDto {
  @ApiProperty()
  @IsUUID()
  cliente_id!: string;

  @ApiProperty({
    description: 'Salida del grupo (ISO; pared Cancún ya convertida).',
  })
  @Type(() => Date)
  @IsDate()
  fecha_vuelo!: Date;

  @ApiProperty({ minimum: 1, example: 44 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pasajeros_total!: number;

  @ApiProperty({
    type: [EscalaInputDto],
    description:
      'Itinerario comercial COMÚN (ida y vuelta o multiescala). `pasajeros` y `fecha_salida_plan` por tramo se ignoran: los fija el armador por avión.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EscalaInputDto)
  escalas_plantilla!: EscalaInputDto[];

  @ApiProperty({ enum: TipoTarifa })
  @IsEnum(TipoTarifa)
  tarifa_tipo!: TipoTarifa;

  @ApiProperty({
    enum: MetodoPago,
    description: 'Determina el IVA (como el cotizador).',
  })
  @IsEnum(MetodoPago)
  metodo_pago!: MetodoPago;

  @ApiPropertyOptional({
    description: 'Nombre manual cuando metodo_pago = OTRO.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  metodo_pago_detalle?: string;

  @ApiPropertyOptional({
    description:
      'TC MXN por USD del grupo (total MXN y respaldo de cobros MXN).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  tc_usd_mxn?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pase_abordar?: boolean;

  @ApiPropertyOptional({ type: [ExtraGrupoDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ExtraGrupoDto)
  extras_grupo?: ExtraGrupoDto[];

  @ApiPropertyOptional({
    type: [TuaLineaDto],
    description:
      'TUAS capturadas POR AEROPUERTO (unitario + moneda), MISMA línea que el cotizador de un avión. Se pasan tal cual al motor de CADA hijo (cada avión resuelve su exención XA/XB/N). Una línea MXN exige tc_usd_mxn. Vacío/omitido = catálogo.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TuaLineaDto)
  tuas_lineas?: TuaLineaDto[];

  @ApiPropertyOptional({
    description:
      'Ajuste del GRUPO pre-IVA (negativo = descuento). Se reparte entre los hijos por base gravable con pesos exactos (residuo al ancla) y cada hijo lo lleva a su línea AJUSTE.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  ajuste_grupo_usd?: number;

  @ApiPropertyOptional({
    type: [AvionGrupoDto],
    description:
      'Aviones del grupo. Vacío/omitido en /armar ⇒ el server PROPONE flota (greedy por asientos) y reporta la capacidad faltante.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AvionGrupoDto)
  aviones?: AvionGrupoDto[];
}
