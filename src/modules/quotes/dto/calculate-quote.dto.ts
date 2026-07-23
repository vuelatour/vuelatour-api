import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum TipoTarifa {
  PUBLICO = 'PUBLICO',
  BROKER = 'BROKER',
}

export enum MetodoPago {
  BILLPOCKET = 'BILLPOCKET',
  HSBC_LINK = 'HSBC_LINK',
  TRANSFERENCIA = 'TRANSFERENCIA',
  /** Pago bancario facturable (IVA como transferencia); lo concilia oficina. */
  CHEQUE = 'CHEQUE',
  EFECTIVO = 'EFECTIVO',
  DOLARES = 'DOLARES',
}

export enum TipoVuelo {
  REDONDO = 'REDONDO',
  MULTIESCALA = 'MULTIESCALA',
}

export enum TipoParada {
  NORMAL = 'NORMAL',
  SERVICIO = 'SERVICIO',
}

export class EscalaInputDto {
  @ApiProperty({ description: 'IATA origen del tramo', example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ description: 'IATA destino del tramo', example: 'HOL' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiProperty({ description: 'Millas nauticas del tramo (one-way)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas!: number;

  // ---- Detalle por tramo (opcional; defaults en el motor) ----
  @ApiPropertyOptional({
    description:
      'Pax de este tramo (TUAS por tramo). Si null usa los pax globales.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional({
    description:
      'Nombres de pasajeros de ESTE tramo (manifiesto por escala, opcional). Puede variar entre tramos o ir vacío.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pasajeros_nombres?: string[];

  @ApiPropertyOptional({
    description:
      'Tramo ferry (vacío): cobra tiempo+calzos pero 0 pax / sin TUAS.',
  })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional({
    description: 'Marca pernocta en este tramo (suma viáticos).',
  })
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({
    description: 'Costo de pernocta/viáticos del tramo (USD). Default si null.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pernocta_costo_usd?: number;

  @ApiPropertyOptional({
    enum: TipoParada,
    description: 'NORMAL o SERVICIO (parada técnica/servicio).',
  })
  @IsOptional()
  @IsEnum(TipoParada)
  tipo_parada?: TipoParada;

  @ApiPropertyOptional({
    description:
      'Notas de servicio (ej. "aterriza en Toledo a cambiar llanta").',
  })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  servicio_notas?: string;

  @ApiPropertyOptional({
    description:
      'Nota operativa de este tramo para el piloto (ej. "cargar gasolina aquí"). Se muestra en su app.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Fecha/hora planeada de salida del tramo. Si se omite, el 1er tramo hereda fecha_vuelo y el último fecha_traslado_final.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_salida_plan?: Date;
}

/** Concepto extra de la cotización (handler, comisariato, extensión, etc.). */
export class ExtraConceptoDto {
  @ApiProperty({
    description: 'Nombre del concepto (ej. Handler, Comisariato)',
  })
  @IsString()
  @Length(1, 120)
  concepto!: string;

  @ApiProperty({
    description:
      'Monto NATIVO en la moneda del renglón (nombre legado: con moneda=MXN ' +
      'es un monto en pesos que el motor convierte con el TC de la cotización).',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_usd!: number;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del renglón (default USD). MXN entra al total en pesos TAL CUAL ' +
      '(sin re-convertir) y al canon USD con el TC de la cotización.',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    description:
      'Monto nativo persistido (re-cotización de renglones MXN ya guardados: ' +
      'ahí monto_usd viene convertido y ESTE es el capturado en pesos).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_nativo?: number;

  @ApiPropertyOptional({
    description: 'TC congelado informativo (se recalcula al cotizar).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tc_aplicado?: number;

  @ApiPropertyOptional({
    description: 'Si entra a la base de IVA (default true)',
  })
  @IsOptional()
  @IsBoolean()
  aplica_iva?: boolean;
}

/**
 * TUA capturada por aeropuerto: monto unitario editable y moneda propia.
 * Las tarifas cambian seguido y los brokers exigen pass-through exacto; los
 * TUAS reales suelen pagarse en PESOS aunque el vuelo se cotice en USD.
 */
export class TuaLineaDto {
  @ApiProperty({ description: 'IATA del aeropuerto al que aplica esta línea' })
  @IsString()
  @Length(3, 4)
  iata!: string;

  @ApiProperty({ description: 'Monto por pasajero en la moneda de la línea' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto_pax!: number;

  @ApiProperty({ enum: ['USD', 'MXN'] })
  @IsIn(['USD', 'MXN'])
  moneda!: 'USD' | 'MXN';
}

export class CalculateQuoteDto {
  @ApiProperty({ description: 'Aeronave que vuela la ruta' })
  @IsUUID()
  aeronave_id!: string;

  @ApiPropertyOptional({
    description:
      'Cliente que cotiza: si tiene tarifa preferencial pactada para la aeronave, esa manda sobre la tarifa default (público/broker). El override manual sigue teniendo prioridad.',
  })
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional({
    enum: TipoVuelo,
    description:
      'Tipo de vuelo. Default REDONDO. Si MULTIESCALA, debe proveerse `escalas[]` (>=2).',
  })
  @IsOptional()
  @IsEnum(TipoVuelo)
  tipo?: TipoVuelo;

  // ---- MULTIESCALA: lista ordenada de tramos ----
  // Solo se exigen si tipo=MULTIESCALA Y no viene ruta_id (cuando hay ruta_id
  // del catalogo, el service hidrata las escalas desde ahi).
  @ApiPropertyOptional({
    type: [EscalaInputDto],
    description:
      'Requerido si tipo=MULTIESCALA y no se pasa ruta_id. Tramos ordenados (ej. CUN->HOL, HOL->CZM, CZM->CUN).',
  })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo === TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EscalaInputDto)
  escalas?: EscalaInputDto[];

  // ---- Single-leg: ruta predefinida o ad-hoc ----
  @ApiPropertyOptional({ description: 'Si se pasa, usa la ruta predefinida' })
  @ValidateIf((o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA)
  @IsOptional()
  @IsUUID()
  ruta_id?: string;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: aeropuerto origen IATA. Requerido si no hay ruta_id ni escalas.',
  })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsString()
  @Length(3, 4)
  origen_iata?: string;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: aeropuerto destino IATA. Requerido si no hay ruta_id ni escalas.',
  })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @IsString()
  @Length(3, 4)
  destino_iata?: string;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: millas náuticas. Requerido si no hay ruta_id ni escalas.',
  })
  @ValidateIf(
    (o: CalculateQuoteDto) => o.tipo !== TipoVuelo.MULTIESCALA && !o.ruta_id,
  )
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  millas_nauticas?: number;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: motor multiplica NM por 2 (vuelo redondo). Default true — todos los vuelos son redondos. Ignorado en MULTIESCALA.',
  })
  @IsOptional()
  @IsBoolean()
  es_redondo_auto?: boolean;

  @ApiPropertyOptional({
    description:
      'Ad-hoc: número de aterrizajes (default 2). Ignorado en MULTIESCALA (se deriva de escalas.length).',
  })
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

  @ApiPropertyOptional({
    description:
      'Pasajeros con pase de abordar (exenta TUAS excepto en Cozumel)',
  })
  @IsOptional()
  @IsBoolean()
  pase_abordar?: boolean;

  @ApiPropertyOptional({
    description:
      'Vuelo abierto: el itinerario/precio se cierra al final (permite re-cotizar con tramos reales hasta antes de cobrar/facturar).',
  })
  @IsOptional()
  @IsBoolean()
  cotizacion_abierta?: boolean;

  @ApiPropertyOptional({
    description:
      'Ajuste final del total: negativo = descuento ("ciérramelo en 750"), positivo = redondeo hacia arriba. Fuera de la base de IVA.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  ajuste_final_usd?: number;

  @ApiPropertyOptional({
    type: [ExtraConceptoDto],
    description:
      'Conceptos extra (handler, comisariato, extensión de servicios…). Se suman al total; los gravados entran a la base de IVA.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtraConceptoDto)
  extras?: ExtraConceptoDto[];

  @ApiProperty({ enum: MetodoPago, description: 'Determina si aplica IVA' })
  @IsEnum(MetodoPago)
  metodo_pago!: MetodoPago;

  @ApiPropertyOptional({
    description:
      'Redondeo AUTOMÁTICO del total al siguiente múltiplo de $10, siempre hacia arriba (976→980, 991→1000). El motor resuelve el ajuste exacto considerando IVA y comisión BillPocket. El descuento (ajuste_final_usd negativo) se aplica antes.',
  })
  @IsOptional()
  @IsBoolean()
  redondeo_automatico?: boolean;

  @ApiPropertyOptional({
    description:
      'Precio TOTAL pactado con el cliente (vuelos cubiertos por externo: el total se acuerda a mano). El motor genera la línea de ajuste directa para aterrizar EXACTO en este monto; manda sobre el redondeo automático.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  total_pactado_usd?: number;

  @ApiPropertyOptional({
    description:
      'Comisión de BillPocket en % (custom por operación: 5, 9… tope 20). Solo aplica con metodo_pago=BILLPOCKET; se cobra al cliente como línea sin IVA.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(20)
  comision_billpocket_pct?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del VENDEDOR en USD (Itzy/Pablo/broker) con modo FIJA. Regla jul 2026: se SUMA al precio del cliente (componente canónico pre-IVA: si la cotización lleva IVA, la comisión también lo genera). El neto VuelaTour (total − comisión) equivale al precio base. Interna: jamás como línea en el PDF del cliente (se absorbe en el subtotal).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  comision_vendedor_usd?: number;

  @ApiPropertyOptional({
    enum: ['FIJA', 'POR_HORA'],
    description:
      'Modalidad de la comisión del vendedor (default FIJA). POR_HORA: comisión = comision_vendedor_tarifa_hr × horas cobradas, recalculada en cada revisión (si cambian las horas, cambia la comisión).',
  })
  @IsOptional()
  @IsIn(['FIJA', 'POR_HORA'])
  comision_vendedor_modo?: 'FIJA' | 'POR_HORA';

  @ApiPropertyOptional({
    description:
      'Tarifa de la comisión del vendedor en USD por hora cobrada (solo modo POR_HORA, ej. 50 ⇒ $50/hr).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  comision_vendedor_tarifa_hr?: number;

  @ApiPropertyOptional({
    description: 'Quién vendió y cobra la comisión (Itzy, Pablo, broker…).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  comision_vendedor_nombre?: string;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio MXN por USD con el que entrará el pago (BillPocket/transferencia pueden cobrarse en pesos). Persiste tc_usd_mxn y monto_total_mxn; los cobros MXN sin TC lo usan de respaldo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Horas de SOBREVUELO (ej. sobrevolar la isla 0.5 hr): se suman al tiempo cobrable antes del mínimo de 1 hr.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  sobrevuelo_hr?: number;

  @ApiPropertyOptional({
    description: 'Tarifa por hora override (USD). Si null, usa la del avión.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tarifa_hora_override_usd?: number;

  @ApiPropertyOptional({
    description:
      'TUAS por pasajero override (USD). Si null, usa la del aeropuerto.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tuas_override_usd_pax?: number;

  @ApiPropertyOptional({
    type: [TuaLineaDto],
    description:
      'TUAS capturadas POR AEROPUERTO (monto unitario + moneda): mandan ' +
      'sobre el catálogo y sobre tuas_override_usd_pax para ese aeropuerto. ' +
      'monto_unitario × pax del tramo/vuelo = total de la línea.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TuaLineaDto)
  tuas_lineas?: TuaLineaDto[];

  @ApiPropertyOptional({
    description: 'Override de IVA (0.16 default si transferencia/tarjeta)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  iva_pct_override?: number;
}
