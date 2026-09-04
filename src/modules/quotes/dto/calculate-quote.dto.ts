import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
  /**
   * Método MANUAL (18-ago-2026): la oficina escribe cuál es en
   * `metodo_pago_detalle`. Sin IVA por default (el override de IVA es la
   * válvula), fuera de la whitelist del piloto (solo oficina lo registra),
   * fuera del auto-match de conciliación y de la bandeja de Facturas
   * pre-cobro; timbra con FormaPago SAT 99 (Por definir).
   */
  OTRO = 'OTRO',
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
  // Se tolera 0 en el DTO (borradores/payloads legados): el MOTOR exige
  // millas > 0 con mensaje es-MX claro (antes: 400 críptico del validador).
  @Min(0)
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
    description:
      'Ocultar ESTE tramo del PDF de la cotización (título/itinerario/mapa). No afecta el precio: el tramo se sigue cobrando (27-ago).',
  })
  @IsOptional()
  @IsBoolean()
  pdf_oculto?: boolean;

  // ELIMINADO (29-ago-2026): `monto_externo_usd` (monto pactado por tramo del
  // externo SIN avión de referencia). El modo se retiró del motor — los
  // externos se cotizan por el flujo NORMAL (tarifa de referencia, extras,
  // ajuste/total pactado). La columna BD `escala.monto_externo_usd` queda
  // huérfana/DEPRECADA (0 filas la usaban en prod): no leerla ni escribirla.

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
      'es un monto en pesos que el motor convierte con el TC de la cotización). ' +
      'Opcional cuando vienen cantidad y unitario: ahí el motor lo DERIVA ' +
      '(round2(cantidad × unitario)) y lo que se mande aquí se ignora.',
  })
  @ValidateIf(
    (o: ExtraConceptoDto) =>
      !(o.unitario != null && (o.cantidad != null || o.por_persona === true)),
  )
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_usd!: number;

  // ---- cantidad × unitario (4-sep-2026, base de la cotización de grupo) ----
  // Todos opcionales y retrocompatibles: un extra "de monto" sigue igual.
  @ApiPropertyOptional({
    description:
      'Cantidad (ej. 9 personas del tour). Con `unitario`, el motor deriva el ' +
      'monto = round2(cantidad × unitario) y el desglose lo pinta ' +
      '"Concepto · 9 × $85.00".',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cantidad?: number;

  @ApiPropertyOptional({
    description:
      'Precio unitario NATIVO en la moneda del renglón (USD o MXN según `moneda`).',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitario?: number;

  @ApiPropertyOptional({
    description:
      'Extra POR PERSONA: en una cotización de un avión la cantidad se liga a ' +
      'los pasajeros del vuelo en cada recálculo (cambia el pax, cambia el ' +
      'extra). En una línea de GRUPO la cantidad la fija el grupo (grupo_pax).',
  })
  @IsOptional()
  @IsBoolean()
  por_persona?: boolean;

  @ApiPropertyOptional({
    enum: ['GRUPO', 'VUELO'],
    description:
      "Origen del renglón: 'GRUPO' = materializado desde la cotización de " +
      'grupo (revise/ajuste del hijo lo CONSERVAN tal cual; solo el grupo lo ' +
      "edita); 'VUELO' (default) = propio de esta cotización.",
  })
  @IsOptional()
  @IsIn(['GRUPO', 'VUELO'])
  origen?: 'GRUPO' | 'VUELO';

  @ApiPropertyOptional({
    description:
      'Id del extra en la cabecera del grupo (vuelo_grupo.extras_grupo[].id) ' +
      'del que se materializó esta línea; permite consolidar Σ partes.',
  })
  @IsOptional()
  @IsUUID()
  grupo_extra_id?: string;

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
  @ApiProperty({
    description:
      'Aeronave que vuela la ruta (o la REFERENCIA de tarifa/velocidad en ' +
      'vuelos externos). SIEMPRE obligatoria — el modo "externo sin ' +
      'referencia con monto pactado por tramo" se eliminó (29-ago-2026).',
  })
  @IsUUID(undefined, {
    message:
      'Selecciona el avión de la cotización (en vuelos externos, el avión de referencia de tarifa).',
  })
  aeronave_id!: string;

  // ---- Vuelo cubierto por operador EXTERNO (broker) ----
  // Vive aquí (no solo en CreateQuoteDto) porque revise() lo ancla a lo
  // persistido y la persistencia del costo del externo lo consulta.
  @ApiPropertyOptional({
    description:
      'El vuelo lo cubre un operador externo: la cotización al cliente es ' +
      'normal (aeronave_id = referencia de tarifa), pero el vuelo nace ' +
      'es_externo (sin avión propio, sin tacómetros; estado manual).',
  })
  // Transform explícito: con enableImplicitConversion, 'false' (string)
  // sería Boolean('false') = true y marcaría externo un vuelo propio.
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  es_externo?: boolean;

  @ApiPropertyOptional({
    description:
      'Modelo del avión externo (ej. HAWKER 400 A); sale en el PDF. ' +
      "'' explícito = borrar la ficha (omitir la clave = conservar).",
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: CalculateQuoteDto) => (o.avion_externo_modelo ?? '') !== '')
  @Length(2, 80)
  avion_externo_modelo?: string;

  @ApiPropertyOptional({
    description:
      "Matrícula del avión externo (ej. XA-REG). '' explícito = borrarla.",
  })
  @IsOptional()
  @IsString()
  @ValidateIf(
    (o: CalculateQuoteDto) => (o.avion_externo_matricula ?? '') !== '',
  )
  @Length(2, 20)
  avion_externo_matricula?: string;

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
      'PDF: mostrar la tarifa por hora en el desglose (default APAGADO — la regla de ocultar horas/tarifa se vuelve configurable por cotización, 27-ago).',
  })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_tarifa?: boolean;

  @ApiPropertyOptional({
    description:
      'PDF: mostrar la tabla del itinerario de tramos (default PRENDIDO).',
  })
  @IsOptional()
  @IsBoolean()
  pdf_mostrar_itinerario?: boolean;

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
      'Nombre MANUAL del método cuando metodo_pago = OTRO (ej. "PayPal", "Depósito en ventanilla"). Obligatorio con OTRO al crear/revisar.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  metodo_pago_detalle?: string;

  @ApiPropertyOptional({
    description:
      'Redondeo AUTOMÁTICO del total al siguiente múltiplo de $10, siempre hacia arriba (976→980, 991→1000). El motor resuelve el ajuste exacto considerando IVA y comisión BillPocket. El descuento (ajuste_final_usd negativo) se aplica antes.',
  })
  @IsOptional()
  @IsBoolean()
  redondeo_automatico?: boolean;

  // LEGADO — decisión del cliente 2-sep-2026: la opción "Precio pactado con
  // el cliente (total, USD)" se ELIMINÓ del cotizador. La propiedad NO se
  // borra del DTO (forbidNonWhitelisted respondería 400 a la rehidratación
  // del panel y de quickAdjust — indistinguible de una captura manual): queda
  // SOLO como canal de rehidratación del pactado ya persistido en
  // calculo_snapshot.meta (folios vivos 24/69/148). create() la descarta
  // siempre y revise() la ancla a lo persistido: un valor manual NUEVO ya no
  // surte efecto en nada que se guarde.
  @ApiPropertyOptional({
    description:
      'LEGADO (2-sep-2026: la captura se eliminó del cotizador). Solo rehidrata el precio pactado YA persistido de folios viejos — revise() lo ignora si el folio no traía pactado y create() lo descarta siempre. En calculate (preview sin persistencia) se respeta para que el preview de esos folios cuadre.',
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
    description:
      'DEPRECADO (26-ago, nunca usado en prod): se aceptaba para no romper borradores abiertos; el motor lo IGNORA. Usa tiempo_cobrable_override_hr.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  tiempo_vuelo_override_hr?: number;

  @ApiPropertyOptional({
    description:
      'COBRABLE pactado a mano (hr): sustituye la SUMA final (vuelo + calzos + sobrevuelo y el mínimo de 1 hr). Vuelo y calzos siguen calculados e intocables; esto decide el total de horas que se cobran.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(48)
  tiempo_cobrable_override_hr?: number;

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
