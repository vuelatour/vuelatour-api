import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
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
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { EstadoVuelo } from '../../quotes/dto/list-quotes.query';
import { MetodoPago } from '../../quotes/dto/calculate-quote.dto';
import { IF_UPDATED_AT_DESC } from '../../../common/version-cas.util';

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
    description:
      'Solo los hijos de una cotización de GRUPO (vuelo.grupo_id). Cada fila trae grupo_posicion, grupo_pax y el embed grupo {id, folio, nombre, pasajeros_total}.',
  })
  @IsOptional()
  @IsUUID()
  grupo_id?: string;

  @ApiPropertyOptional({
    enum: ['escalas_plan'],
    description:
      'Embed ligero opt-in: "escalas_plan" agrega escalas_plan[] (orden, ruta, fecha_salida_plan, es_ferry, cancelada_at, aeronave_id/aeronave_matricula, piloto_id/piloto_nombre, copiloto_id/copiloto_nombre EXPLÍCITOS del tramo, pasajeros_nombres, notas) a cada vuelo — el calendario de la app pinta el viaje multi-día por tramo. Sin embed cada vuelo ya trae pasajeros_nombres_tramos[], notas_tramos[], tripulacion_nombres[] y apoyos_tramo[] (buscador de la app, 5-sep-2026).',
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

  @ApiPropertyOptional({
    description:
      'Bajar DELTAS (10-sep-2026, app sin internet): solo vuelos con ' +
      'updated_at >= ISO (o con algún TRAMO modificado desde entonces) y, ' +
      'además, `eliminados: [vuelo_id]` de vuelo_eliminado.eliminado_at >= ' +
      'ISO. Sin el parámetro, respuesta de siempre (sin `eliminados`).',
  })
  @IsOptional()
  @IsDateString()
  updated_since?: string;

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

  @ApiPropertyOptional({ description: IF_UPDATED_AT_DESC })
  @IsOptional()
  @IsDateString()
  if_updated_at?: string;
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

/**
 * Body OPCIONAL de DELETE /flights/:id (10-sep-2026, baja desde la app sin
 * internet). El panel sigue llamando sin body (→ 'eliminado desde panel');
 * la app manda el motivo que queda en `vuelo_eliminado.motivo` como
 * 'eliminado desde la app: <motivo>'.
 */
export class DeleteFlightDto {
  @ApiPropertyOptional({
    description:
      'Motivo del borrado (5-500). Opcional: sin él la bitácora dice ' +
      '"eliminado desde panel"; con él "eliminado desde la app: <motivo>".',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  motivo?: string;

  @ApiPropertyOptional({
    description:
      'Llave de la captura en el outbox de la app (uuid). SOLO trazabilidad ' +
      '(queda en el snapshot forense); el borrado ya es idempotente por sí ' +
      'mismo: un vuelo que ya no existe responde 404 VUELO_NO_EXISTE.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

export class CancelFlightDto {
  @ApiProperty({
    description:
      'Motivo de la cancelación. Queda auditado en notas_internas. ' +
      '409 estructurados: VUELO_YA_CANCELADO (idempotente para la app) y ' +
      'VUELO_COMPLETADO (no se puede cancelar).',
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

  @ApiPropertyOptional({
    description:
      IF_UPDATED_AT_DESC +
      ' En assign se valida contra el updated_at del VUELO antes del primer ' +
      'paso (apoyos, vuelo, tramos) y no se vuelve a validar por tramo.',
  })
  @IsOptional()
  @IsDateString()
  if_updated_at?: string;
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

/**
 * `es_externo:true` con `aeronave_id` → 400 claro desde el DTO (el CHECK de
 * `vuelo` los excluye: externo ⇒ operador_externo; propio ⇒ aeronave_id).
 */
function SinAeronaveSiExterno(): PropertyDecorator {
  return ValidateBy({
    name: 'sinAeronaveSiExterno',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        value !== true ||
        (args?.object as { aeronave_id?: unknown } | undefined)?.aeronave_id ==
          null,
      defaultMessage: () =>
        'Un vuelo externo no lleva aeronave propia: quita aeronave_id o es_externo.',
    },
  });
}

export class CreateReservaDto {
  @ApiPropertyOptional({
    description:
      'Cliente existente. Requerido si no viene `cliente_nombre`; si vienen ambos GANA cliente_id.',
  })
  // Requerido sin `cliente_nombre`; si VIENE (aunque haya nombre) debe ser
  // uuid: un id mal formado no debe llegar al service (22P02 → 500).
  @ValidateIf(
    (o: CreateReservaDto) => !o.cliente_nombre || o.cliente_id != null,
  )
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 200,
    description:
      'Cliente NUEVO por nombre (app sin internet, 9-sep-2026): se busca entre TODOS los clientes ' +
      'por nombre normalizado (sin acentos/mayúsculas/espacios dobles); activo → se reutiliza, ' +
      'inactivo → se reactiva, ninguno → se crea justo antes del vuelo (respuesta `cliente_creado`).',
  })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  cliente_nombre?: string;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia (uuid) por captura (outbox de la app / doble clic): repetirla devuelve ' +
      'la reserva YA creada (200, idempotente:true) sin volver a avisar al piloto; un vuelo huérfano ' +
      '(sin tramos) se REPARA con esta misma llave.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Tripulación de APOYO de todo el vuelo (mismas reglas que assign: activos, sin repetir, ' +
      'distintos del piloto/copiloto). Se aplica en la misma operación (antes: 2.º POST /assign).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  apoyo_ids?: string[];

  @ApiPropertyOptional({
    description:
      'Momento REAL de captura en la app (ISO con zona). Solo auditoría: NUNCA provoca 400 — ' +
      'un valor raro deja constancia en notas_internas y el alta sigue.',
  })
  // Sin validadores a propósito: `@Allow()` solo lo deja pasar la whitelist
  // (un tipo raro o un texto largo tampoco deben rechazar: el sello
  // tolerante lo convierte a texto y lo recorta).
  @Allow()
  capturado_en?: string;

  @ApiPropertyOptional({
    description:
      'Outbox de la app: con esta bandera, un posible duplicado (mismo cliente, mismo día Cancún y ' +
      'mismo avión o misma ruta del tramo 1) rebota 409 POSIBLE_DUPLICADO en vez de solo avisar.',
  })
  @IsOptional()
  @IsBoolean()
  rechazar_posible_duplicado?: boolean;

  @ApiPropertyOptional({
    description:
      'Decisión explícita del usuario: agendar aunque parezca duplicado (anula rechazar_posible_duplicado).',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_posible_duplicado?: boolean;

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

  @ApiPropertyOptional({
    description:
      'Aeronave tentativa. OBLIGATORIA en una reserva propia (400 claro sin ella); PROHIBIDA con es_externo.',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description:
      'Vuelo cubierto por un operador EXTERNO (app sin internet, 9-sep-2026): exige operador_externo y ' +
      'prohíbe aeronave_id. Nace como RESERVA con aeronave_id null (tramos sin avión) y se salta ' +
      'taller/squawk/doble reserva/capacidad; el detector de duplicado compara solo la ruta del tramo 1.',
  })
  @IsOptional()
  @IsBoolean()
  @SinAeronaveSiExterno()
  es_externo?: boolean;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description: 'Operador externo (ej. XA-TIB). OBLIGATORIO con es_externo.',
  })
  @ValidateIf(
    (o: CreateReservaDto) =>
      o.es_externo === true || o.operador_externo != null,
  )
  @IsString()
  @Length(2, 100)
  operador_externo?: string;

  @ApiPropertyOptional({
    maxLength: 20,
    description:
      'Matrícula del avión externo (solo con es_externo; vuelo.avion_externo_matricula).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  externo_matricula?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Modelo del avión externo (solo con es_externo; vuelo.avion_externo_modelo).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  externo_modelo?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Lo que cobra el operador externo, en SU moneda (solo con es_externo). 0/omitido = aún sin pactar. ' +
      'El server DERIVA costo_externo_usd (fuente única resolverCostoExterno).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige costo_externo_tc (sin TC, 400 ANTES del insert).',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    description:
      'TC MXN por USD para convertir un costo en MXN (banda 15–25). Solo se usa con costo_externo_moneda=MXN.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  costo_externo_tc?: number;

  @ApiPropertyOptional({ description: 'Piloto tentativo' })
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Piloto EXTERNO por NOMBRE (app sin internet, 9-sep-2026). Solo aplica sin piloto_id (si vienen ambos ' +
      'gana piloto_id). Se busca entre los pilotos externos por nombre normalizado (sin acentos/mayúsculas/' +
      'espacios dobles): activo → se reutiliza, inactivo → se reactiva, ninguno → se crea justo antes del ' +
      'vuelo por el mismo camino que POST /pilots/externo (respuesta `piloto_externo_creado`).',
  })
  @ValidateIf((o: CreateReservaDto) => !o.piloto_id)
  @IsOptional()
  @IsString()
  @Length(2, 100)
  piloto_externo_nombre?: string;

  @ApiPropertyOptional({
    maxLength: 20,
    description: 'WhatsApp del piloto externo (solo se usa al CREARLO).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  piloto_externo_telefono?: string;

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
