import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDate,
  IsDateString,
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
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EstadoVuelo } from '../../quotes/dto/list-quotes.query';
import { MetodoPago } from '../../quotes/dto/calculate-quote.dto';

export class TacoStatusDto {
  @ApiProperty({ type: [String], description: 'IDs de vuelo a evaluar' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class CobroStatusDto {
  @ApiProperty({ type: [String], description: 'IDs de vuelo a evaluar' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class VoucherUrlsDto {
  @ApiProperty({
    type: [String],
    description: 'Paths de vouchers en cobro-vouchers a firmar',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  paths!: string[];
}

export enum EstadoPermiso {
  NO_APLICA = 'no_aplica',
  PENDIENTE = 'pendiente',
  EMITIDO = 'emitido',
}

export class ListFlightsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ enum: EstadoVuelo })
  @IsOptional()
  @IsEnum(EstadoVuelo)
  estado?: EstadoVuelo;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  es_externo?: boolean;

  @ApiPropertyOptional({
    enum: ['escalas_plan'],
    description:
      'Embed ligero opt-in: "escalas_plan" agrega escalas_plan[] (orden, ruta, fecha_salida_plan, es_ferry) a cada vuelo — el calendario de la app pinta el viaje multi-día por tramo.',
  })
  @IsOptional()
  @IsIn(['escalas_plan'])
  embed?: 'escalas_plan';

  @ApiPropertyOptional({
    enum: ['COBRADO', 'POR_COBRAR', 'PARCIAL', 'SIN_COBROS'],
    description:
      'Estado de cobro: COBRADO (completo) · POR_COBRAR (falta saldo, con o sin abonos) · PARCIAL (con abonos y falta saldo) · SIN_COBROS (con precio y ni un cobro).',
  })
  @IsOptional()
  @IsIn(['COBRADO', 'POR_COBRAR', 'PARCIAL', 'SIN_COBROS'])
  cobro?: 'COBRADO' | 'POR_COBRAR' | 'PARCIAL' | 'SIN_COBROS';

  // String (no Date): una fecha simple debe cortarse en día CANCÚN; pasarla
  // por `new Date()` la vuelve medianoche UTC y mueve vuelos de día/mes.
  @ApiPropertyOptional({
    description: 'fecha_vuelo >= (ISO con hora, o YYYY-MM-DD = día Cancún)',
  })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({
    description: 'fecha_vuelo <= (ISO con hora, o YYYY-MM-DD = día Cancún)',
  })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  // Tope 500: el selector de vuelos del app (oficina) trae un lote grande y
  // filtra localmente por folio/cliente/ruta/piloto. Los listados paginados
  // siguen usando límites chicos.
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class UpdateFlightDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({ description: 'Fecha de traslado inicial / salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({
    description: 'Fecha de traslado final / regreso a base',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

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

  @ApiPropertyOptional({
    enum: EstadoPermiso,
    description: 'Estado del permiso de pista',
  })
  @IsOptional()
  @IsEnum(EstadoPermiso)
  estado_permiso?: EstadoPermiso;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Nombres de los pasajeros (manifiesto, para tramitar permisos).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  facturado?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cobrado?: boolean;

  @ApiPropertyOptional({
    enum: MetodoPago,
    description:
      'Método de cobro pactado. SOLO editable en vuelos externos sin desglose ' +
      'canónico (en los demás, el método se cambia revisando la cotización ' +
      'porque re-calcula el IVA). Define si el vuelo aparece en Facturas ' +
      'antes de cobrarse.',
  })
  @IsOptional()
  @IsEnum(MetodoPago)
  metodo_cobro?: MetodoPago;
}

export class UpdatePermisoDto {
  @ApiProperty({
    enum: EstadoPermiso,
    description: 'Estado del permiso de pista',
  })
  @IsEnum(EstadoPermiso)
  estado_permiso!: EstadoPermiso;
}

export class SetFlightPlanDto {
  @ApiProperty({
    description:
      'PATH dentro del bucket privado planes-vuelo (p. ej. vuelo-<id>/plan-<ts>.jpg). ' +
      'Para verla se firma vía GET :id/plan-vuelo-url (filas viejas con URL pública completa también se resuelven ahí).',
  })
  @IsString()
  foto_plan_vuelo_url!: string;
}

export class PurgeFlightDto {
  @ApiProperty({
    description:
      'Motivo del borrado DEFINITIVO (queda en la bitácora vuelo_eliminado).',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  motivo!: string;
}

export class CancelFlightDto {
  @ApiProperty({
    description: 'Motivo de la cancelación. Queda auditado en notas_internas.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;
}

/** Reasignación de aeronave de último minuto (clona el vuelo; el original queda cancelado con sus gastos). */
export class ReassignAircraftDto {
  @ApiProperty({ description: 'Nueva aeronave que volará el servicio' })
  @IsUUID()
  aeronave_id!: string;

  @ApiPropertyOptional({
    description: 'Motivo del cambio (queda en el vuelo cancelado)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;

  @ApiPropertyOptional({
    description:
      'Confirmación explícita (2-sep-2026): reasignar AUNQUE la aeronave ' +
      'tenga discrepancia (squawk) ALTA sin resolver. Sin ella se rechaza ' +
      'con 409 SQUAWK_ALTA_SIN_RESOLVER; al aceptar se avisa al mecánico.',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}

export class AssignFlightDto {
  @ApiPropertyOptional({
    description: 'Aeronave asignada (solo si no es externo)',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Piloto asignado' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({
    description:
      'Copiloto del viaje (segundo piloto). Ve todo el vuelo igual que el piloto. ' +
      'Enviar null para quitarlo.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  copiloto_id?: string | null;

  @ApiPropertyOptional({
    description:
      'LEGADO (29-ago-2026): apoyo único del vuelo. Si viene sin apoyo_ids ' +
      'se traduce a apoyo_ids = [apoyo_id] (null/"" = ninguno). La fuente ' +
      'única es la lista `apoyo_ids`.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  apoyo_id?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Tripulación de APOYO de TODO el vuelo (0..N usuarios en tierra: ' +
      'maletas, facturas, cobros, gastos). Ven y operan el vuelo igual que ' +
      'el piloto EXCEPTO tacómetros. REEMPLAZA la lista de nivel vuelo ' +
      '([] = ninguno); los apoyos por tramo no se tocan desde aquí. ' +
      'Cada uno debe estar ACTIVO y ser distinto del piloto y del copiloto.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  apoyo_ids?: string[];

  @ApiPropertyOptional({ description: 'Fecha programada del vuelo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({
    description:
      'Confirmación explícita (2-sep-2026): asignar la aeronave AUNQUE ' +
      'tenga discrepancia (squawk) ALTA sin resolver. Sin ella se rechaza ' +
      'con 409 SQUAWK_ALTA_SIN_RESOLVER (details.discrepancias trae la ' +
      'lista); al aceptar se avisa al mecánico.',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}

/** Tramo de un vuelo EXTERNO multiescala (solo ruta; sin tacos ni pax por tramo). */
export class EscalaExternaDto {
  @ApiProperty({ example: 'CUN' })
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty({ example: 'HOL' })
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({ description: 'Tramo ferry (vacío, sin pasajeros).' })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;
}

/** Cubrir un vuelo existente con operador externo (conversión). */
export class CubrirExternoDto {
  @ApiProperty({ description: 'Operador externo (ej. XA-TIB)' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo!: string;

  @ApiProperty({
    description:
      'Lo que cobra el operador externo, en SU moneda (nombre legado: con ' +
      'costo_externo_moneda=MXN es un monto en PESOS). El server DERIVA ' +
      'vuelo.costo_externo_usd (fuente única de los lectores).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd?: number;

  @ApiPropertyOptional({
    description:
      'Alias preferido de costo_externo_usd: el monto en su moneda. Mandar ' +
      'uno de los dos (este gana si vienen ambos).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige TC: el ' +
      'tc_usd_mxn del diálogo o el ya persistido en el vuelo (sin TC, 400).',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    description:
      'TC MXN por USD pactado. Sin él, un vuelo cotizado en USD no se puede ' +
      'facturar (el CFDI se emite en MXN).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Modelo del avión externo (ej. HAWKER 400 A); sale en el PDF. ' +
      "'' explícito = borrar la ficha (omitir la clave = conservar).",
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: CubrirExternoDto) => (o.avion_externo_modelo ?? '') !== '')
  @MinLength(2)
  @MaxLength(80)
  avion_externo_modelo?: string;

  @ApiPropertyOptional({
    description:
      "Matrícula del avión externo (ej. XA-REG). '' explícito = borrarla.",
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: CubrirExternoDto) => (o.avion_externo_matricula ?? '') !== '')
  @MinLength(2)
  @MaxLength(20)
  avion_externo_matricula?: string;
}

export class CombinarVuelosDto {
  @ApiProperty({
    description:
      'Vuelo ANFITRIÓN: el que ya lleva pax al destino y cuyo avión pernocta.',
  })
  @IsUUID()
  vuelo_anfitrion_id!: string;

  @ApiProperty({
    description:
      'Tramo ferry de ESTE vuelo (el cubierto) que se cancela: su ida vacía.',
  })
  @IsUUID()
  tramo_ferry_id!: string;

  @ApiProperty({
    description: 'Tramo ferry del ANFITRIÓN que se cancela: su regreso vacío.',
  })
  @IsUUID()
  tramo_ferry_anfitrion_id!: string;

  @ApiPropertyOptional({
    description:
      'Asignar también el piloto del anfitrión (el que pernocta) a este vuelo. Default true.',
  })
  @IsOptional()
  @IsBoolean()
  aplicar_piloto?: boolean;

  @ApiPropertyOptional({
    description:
      'Marcar pernocta OPERATIVA en el último tramo activo del anfitrión (solo señal al piloto; jamás toca precios). Default true.',
  })
  @IsOptional()
  @IsBoolean()
  marcar_pernocta?: boolean;

  @ApiPropertyOptional({
    description:
      'Confirmación explícita (2-sep-2026): combinar AUNQUE el avión del ' +
      'anfitrión tenga discrepancia (squawk) ALTA sin resolver. Sin ella se ' +
      'rechaza con 409 SQUAWK_ALTA_SIN_RESOLVER ANTES de tocar nada; al ' +
      'aceptar se avisa al mecánico.',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}

export class CreateExternalFlightDto {
  @ApiProperty()
  @IsUUID()
  cliente_id!: string;

  @ApiProperty({ description: 'Operador externo (ej. XA-TIB)' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo!: string;

  @ApiProperty({
    description:
      'Lo que cobra el operador externo, en SU moneda (nombre legado; ver ' +
      'costo_externo_moneda). El server DERIVA vuelo.costo_externo_usd.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd?: number;

  @ApiPropertyOptional({
    description:
      'Alias preferido de costo_externo_usd: el monto en su moneda. Mandar ' +
      'uno de los dos (este gana si vienen ambos).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige el tc_usd_mxn ' +
      'del alta (sin TC, 400).',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiProperty({ description: 'Monto total cobrado al cliente (USD)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_total_usd!: number;

  @ApiPropertyOptional({
    enum: MetodoPago,
    description:
      'Método de cobro pactado con el cliente. Con método facturable ' +
      '(transferencia/link/terminal/cheque) el vuelo aparece en Facturas ' +
      'ANTES de cobrarse. Default: TRANSFERENCIA.',
  })
  @IsOptional()
  @IsEnum(MetodoPago)
  metodo_cobro?: MetodoPago;

  @ApiPropertyOptional({
    description:
      'TC MXN por USD pactado. Sin él, el vuelo (cotizado en USD) no se ' +
      'puede facturar hasta capturar el TC al emitir.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  tc_usd_mxn?: number;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({
    type: [EscalaExternaDto],
    description:
      'MULTIESCALA opcional: tramos ordenados de la ruta (algunas rutas externas lo necesitan). Si viene, origen/destino del vuelo se derivan del primero/último.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EscalaExternaDto)
  escalas?: EscalaExternaDto[];

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas_internas?: string;
}

/**
 * Reserva tentativa: aparta el espacio en el calendario SIN cotización
 * (el cliente aún no confirma o faltan costos para cotizar). Vuelo propio.
 */
/**
 * Tramo del itinerario de OPERACIÓN en la creación rápida: la ruta real que
 * vuela el avión y ve el piloto (puede salir de otra base, con ferries), que
 * NO es la ruta comercial de la cotización (esa siempre abre/cierra en CUN y
 * se arma después en el cotizador).
 */
export class ReservaEscalaDto {
  @ApiProperty()
  @IsString()
  @Length(3, 4)
  origen_iata!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 4)
  destino_iata!: string;

  @ApiPropertyOptional({ description: 'Hora planeada de salida del tramo' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hora_salida?: Date;

  @ApiPropertyOptional({
    description:
      'Ferry/posicionamiento (sin pasajeros): no se cotiza ni se muestra al cliente',
  })
  @IsOptional()
  @IsBoolean()
  es_ferry?: boolean;

  @ApiPropertyOptional({
    description:
      'Tramo de sobrevuelo (recorrido sobre una zona, no un traslado normal).',
  })
  @IsOptional()
  @IsBoolean()
  es_sobrevuelo?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pasajeros?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];

  @ApiPropertyOptional({
    description:
      'El piloto pernocta tras este tramo (además se marca sola si el siguiente tramo sale otro día).',
  })
  @IsOptional()
  @IsBoolean()
  requiere_pernocta?: boolean;

  @ApiPropertyOptional({ enum: ['NORMAL', 'SERVICIO'] })
  @IsOptional()
  @IsIn(['NORMAL', 'SERVICIO'])
  tipo_parada?: 'NORMAL' | 'SERVICIO';

  @ApiPropertyOptional({
    description: 'Detalle de la parada de servicio/técnica',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  servicio_notas?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}

export class CreateReservaDto {
  @ApiProperty()
  @IsUUID()
  cliente_id!: string;

  @ApiPropertyOptional({
    description: 'Requerido si no se envía escalas_operacion',
  })
  @ValidateIf((o: CreateReservaDto) => !o.escalas_operacion?.length)
  @IsString()
  @Length(3, 4)
  origen_iata?: string;

  @ApiPropertyOptional({
    description:
      'Destino tentativo. Requerido si no se envía escalas_operacion',
  })
  @ValidateIf((o: CreateReservaDto) => !o.escalas_operacion?.length)
  @IsString()
  @Length(3, 4)
  destino_iata?: string;

  @ApiPropertyOptional({
    type: [ReservaEscalaDto],
    description:
      'Itinerario de OPERACIÓN completo (creación rápida): sustituye a origen/destino tentativos. La ruta comercial queda pendiente hasta cotizar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReservaEscalaDto)
  escalas_operacion?: ReservaEscalaDto[];

  @ApiProperty({ description: 'Fecha/hora apartada (salida)' })
  @Type(() => Date)
  @IsDate()
  fecha_vuelo!: Date;

  @ApiPropertyOptional({ description: 'Fecha/hora del regreso (si se conoce)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pasajeros?: number;

  @ApiPropertyOptional({ description: 'Aeronave tentativa' })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ description: 'Piloto tentativo' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({
    description: 'Copiloto (2do piloto). Ve todo el vuelo igual que el piloto.',
  })
  @IsOptional()
  @IsUUID()
  copiloto_id?: string;

  @ApiPropertyOptional({
    description: 'Vuelo abierto: el itinerario/precio se cierra al final',
  })
  @IsOptional()
  @IsBoolean()
  cotizacion_abierta?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Nombres de los pasajeros (si ya se conocen).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];

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

  @ApiPropertyOptional({
    description:
      'Confirmación explícita (2-sep-2026): apartar con la aeronave AUNQUE ' +
      'tenga discrepancia (squawk) ALTA sin resolver. Sin ella se rechaza ' +
      'con 409 SQUAWK_ALTA_SIN_RESOLVER; al aceptar se avisa al mecánico.',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;
}

/** Regreso a vuelo propio (28-ago): un vuelo propio SIEMPRE tiene avión (regla
 *  de BD): si el externo no tenía avión de referencia, hay que elegirlo aquí. */
export class RevertirExternoDto {
  @ApiPropertyOptional({
    description:
      'Avión propio que volará el vuelo. Obligatorio si el vuelo externo no tenía avión de referencia.',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;
}
