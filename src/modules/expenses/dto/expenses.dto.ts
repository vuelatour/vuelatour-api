import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import { descripcionCategoriasGasto } from '../../../common/categoria-gasto.util';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';

export enum CategoriaGasto {
  GAS = 'GAS',
  ATERRIZAJE = 'ATERRIZAJE',
  OPERACIONES = 'OPERACIONES',
  TUAS = 'TUAS',
  FBO = 'FBO',
  COMIDA = 'COMIDA',
  HOTEL = 'HOTEL',
  TAXI = 'TAXI',
  REFACCION = 'REFACCION',
  PERMISO = 'PERMISO',
  /** Honorario del piloto externo (freelance sin acceso; lo captura oficina). */
  PILOTO_EXTERNO = 'PILOTO_EXTERNO',
  FIJO = 'FIJO',
  /** Gasto indirecto de la operación (SIN vuelo; avión opcional). Por ahora
   *  fuera del reparto y de la bandeja de pendientes — pendiente de decidir
   *  su tratamiento con el equipo (hoja "gastos indirectos" de su control). */
  INDIRECTO = 'INDIRECTO',
  /** Gastos de VISITA de trabajo (27-ago): los captura el rol VISITANTE
   *  (la app se la fija sola). Patrón GASOLINA: sin vuelo/avión/escala,
   *  visible en Otros gastos, repartible a mano, fuera de pendientes. */
  VISITA = 'VISITA',
  /** Gasolina de VEHÍCULOS de la empresa (27-ago): gasolinera Pemex/Gulf
   *  (Magna/Premium/Regular), NO combustible de aviación. Gasto de la
   *  EMPRESA: sin vuelo ni avión (candados create/update); visible en Otros
   *  gastos y repartible a mano. Nació porque los coches cargaban como GAS
   *  y contaminaban balances de aviones. */
  GASOLINA = 'GASOLINA',
  /** Nómina / sueldos del personal (29-ago-2026): se clasifica junto a los
   *  gastos INDIRECTOS (sin vuelo; avión opcional) y SÍ es repartible a mano
   *  entre aviones (`gasto_reparto`; el trigger de BD ya la acepta). */
  NOMINA = 'NOMINA',
  /** Servicios AL AVIÓN (29-ago-2026): mantenimientos/servicios contratados
   *  — gasto DIRECTO del avión SIN vuelo (avión permitido y esperado; como
   *  REFACCION queda pendiente hasta tener avión). NO es repartible. */
  SERVICIOS = 'SERVICIOS',
  /** Gasto PERSONAL del dueño (26-ago-2026): lo captura el personal de
   *  VuelaTour pero NO es de la empresa ni de los aviones — seguimiento en
   *  la pantalla "Gastos personales". SIEMPRE sin vuelo y sin avión (candado
   *  en create/update); fuera de balances, reparto, Libro Dinero, tablero de
   *  gastos y pre-cierre. Conciliación y caja chica SÍ lo ven (el dinero
   *  salió de verdad del banco/fondo). */
  PERSONAL_DUENO = 'PERSONAL_DUENO',
  OTRO = 'OTRO',
}

export enum Moneda {
  MXN = 'MXN',
  USD = 'USD',
}

export enum MedioPago {
  EFECTIVO = 'EFECTIVO',
  TARJETA_CORP = 'TARJETA_CORP',
  PERSONAL_PABLO = 'PERSONAL_PABLO',
  PERSONAL_ALE = 'PERSONAL_ALE',
  TRANSFERENCIA = 'TRANSFERENCIA',
  /** PayWise (2-sep-2026): medio BANCARIO — sus cargos aparecen en el estado
   *  de cuenta, así que entra a la conciliación automática, a "gastos sin
   *  banco" y al pre-cierre de bancarios sin conciliar, como TARJETA_CORP y
   *  TRANSFERENCIA. Caja chica NO lo cuenta (esa solo mira EFECTIVO). */
  PAYWISE = 'PAYWISE',
}

export enum TipoCombustible {
  TURBOSINA = 'TURBOSINA',
  AVGAS = 'AVGAS',
}

export enum EstatusComprobante {
  FACTURA = 'FACTURA',
  VALE = 'VALE',
  SIN_COMPROBANTE = 'SIN_COMPROBANTE',
}

/**
 * Seguimiento de facturación de OFICINA — independiente del comprobante que
 * entregó el piloto (la app marca FACTURA con cualquier foto, aunque sea un
 * ticket, así que ese campo NO dice si ya se facturó).
 */
export enum EstatusFacturacion {
  PENDIENTE = 'PENDIENTE',
  SOLICITADA = 'SOLICITADA',
  FACTURADA = 'FACTURADA',
}

export class CreateGastoDto {
  @ApiProperty({
    enum: CategoriaGasto,
    // Código → etiqueta (UI) → destino por default, derivado de la fuente
    // única src/common/categoria-gasto.util.ts (sin duplicar textos).
    description: descripcionCategoriasGasto(),
  })
  @IsEnum(CategoriaGasto)
  categoria!: CategoriaGasto;

  @ApiPropertyOptional({
    description:
      'Folio / número de remisión del ticket o factura (ej. remisión ASA). Con 4+ caracteres alfanuméricos es CANDADO anti-duplicados: otro gasto con el mismo folio se rechaza con 409.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio_ticket?: string;

  @ApiProperty({ description: 'Monto del gasto' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({
    description:
      'Propina incluida en monto (monto = ticket + propina; monto es lo que llega al banco).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  propina?: number;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio MXN/USD si el gasto es en moneda distinta a USD',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  tc_gasto?: number;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  fecha_gasto!: string;

  @ApiProperty({
    enum: MedioPago,
    description:
      'Obligatorio, sin valor por defecto (la app y el panel no preseleccionan).',
  })
  @IsEnum(MedioPago)
  medio_pago!: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({ description: 'Vuelo asociado (opcional)' })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({
    description:
      'Escala/aterrizaje asociado (gastos de pista: un gasto por aterrizaje)',
  })
  @IsOptional()
  @IsUUID()
  escala_id?: string;

  @ApiPropertyOptional({
    description: 'Aeronave (opcional). null = bandeja de pendientes',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({ enum: EstatusComprobante })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({ enum: EstatusFacturacion })
  @IsOptional()
  @IsEnum(EstatusFacturacion)
  estatus_facturacion?: EstatusFacturacion;

  @ApiPropertyOptional({ description: 'URL/path en Supabase Storage' })
  @IsOptional()
  @IsString()
  foto_url?: string;

  @ApiPropertyOptional({ description: 'Litros cargados (solo combustible)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  litros?: number;

  @ApiPropertyOptional({ enum: TipoCombustible })
  @IsOptional()
  @IsEnum(TipoCombustible)
  tipo_combustible?: TipoCombustible;

  @ApiPropertyOptional({ description: 'Aeropuerto/FBO donde se hizo la carga' })
  @IsOptional()
  @IsString()
  lugar?: string;

  @ApiPropertyOptional({
    description: 'Momento preciso de la carga (ISO); permite sugerir el vuelo',
  })
  @IsOptional()
  @IsDateString()
  fecha_hora_carga?: string;

  @ApiPropertyOptional({
    description: 'Valores extraídos por IA antes de confirmación',
  })
  @IsOptional()
  @IsObject()
  valor_ia_extraido?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Captura offline con foto: al recibirla, el servidor lee el comprobante con IA y completa lo que falte (desglose, fecha del ticket, matrícula→avión) sin pisar lo capturado a mano.',
  })
  @IsOptional()
  @IsBoolean()
  leer_con_ia?: boolean;

  @ApiPropertyOptional({
    description:
      'Backfill de oficina: registra el gasto COMO SI lo hubiera subido el ' +
      'piloto del vuelo (usuario_captura + origen = PILOTO). Requiere ' +
      'vuelo_id y que el vuelo tenga piloto. La auditoría (created_by) ' +
      'conserva al usuario real que lo cargó. Solo ADMIN/COORDINADOR.',
  })
  @IsOptional()
  @IsBoolean()
  capturar_como_piloto?: boolean;

  @ApiPropertyOptional({
    description:
      'Capturado con prellenado de IA desde la app (flujo admin): queda pendiente del visto bueno de administración en el panel.',
  })
  @IsOptional()
  @IsBoolean()
  requiere_visto_bueno?: boolean;

  @ApiPropertyOptional({
    description:
      'true al guardar el diálogo Verificar del panel: sella verificado_por/' +
      'verificado_at con quien confirma. false = retirar la confirmación. ' +
      'Solo oficina (los roles de campo no pueden mandarlo).',
  })
  @IsOptional()
  @IsBoolean()
  verificado?: boolean;

  @ApiPropertyOptional({
    description:
      'Llave de IDEMPOTENCIA generada por el cliente (uuid v4, una por ' +
      'captura). Un reintento (timeout tras commit, doble flush del outbox, ' +
      'doble tap) con la misma llave devuelve el gasto YA creado en vez de ' +
      'duplicar dinero. Índice único uq_gasto_client_request.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  @ApiPropertyOptional({
    description:
      'Solo OFICINA: confirma a propósito una fecha_gasto de hace más de ' +
      '365 días (carga histórica real). Sin esta bandera, una fecha tan ' +
      'vieja se rechaza con 400 — casi siempre es el AÑO equivocado del ' +
      'ticket y el gasto quedaría fuera de todos los cortes.',
  })
  @IsOptional()
  @IsBoolean()
  permitir_fecha_antigua?: boolean;

  @ApiPropertyOptional({
    description:
      'Momento REAL de captura (7-sep-2026), ISO 8601 CON zona horaria ' +
      '(ej. 2026-09-05T14:32:00-05:00 o ...Z). La app lo manda al guardar ' +
      'aunque esté sin señal (el outbox lo sube después: created_at = ' +
      'llegada al servidor). Omitido = ahora (panel, cargas masivas). Se ' +
      'rechaza con 400 si viene sin zona, en el futuro (> 10 min) o antes ' +
      'de 2020. Solo auditoría: no toca dinero ni ventanas de edición. En ' +
      'PATCH la columna NO se reescribe (se fija una sola vez al crear): ahí ' +
      'el valor es el sello de la CORRECCIÓN (ver UpdateGastoDto).',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  capturado_en?: string;
}

/**
 * Edición de un gasto. Todo lo heredado es opcional. Dos campos cambian de
 * significado respecto al alta (10-sep-2026, app sin internet):
 *  - `capturado_en`: momento REAL en que el capturista hizo la CORRECCIÓN
 *    (el outbox la sube después). La ventana semanal se evalúa contra ese
 *    sello (si viene y es ≤ ahora), no contra la llegada al servidor, y la
 *    bitácora del gasto conserva «corrección capturada el … · recibida el …».
 *    La columna `capturado_en` del gasto NO se toca.
 *  - `client_request_id`: la llave de la captura ORIGINAL se conserva
 *    siempre (el PATCH ni la reescribe ni la borra); mandarla es inocuo.
 */
export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({
    description: 'Bandera de posible duplicado (la oficina la descarta).',
  })
  @IsOptional()
  @IsBoolean()
  duplicado_sospechado?: boolean;

  @ApiPropertyOptional({
    description:
      'Control de versión (doc 6.1, gana el servidor + aviso): `updated_at` ' +
      'del gasto tal como lo leyó el cliente (ISO). Si alguien lo modificó ' +
      'después, el PATCH no aplica y responde 409 CONFLICTO_VERSION con ' +
      '`details.actual` (la fila vigente), `updated_at_enviado` y ' +
      '`updated_at_actual`. Omitido = comportamiento de siempre (último gana).',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  if_updated_at?: string;
}

/** Query de DELETE /expenses/:id (10-sep-2026). */
export class DeleteGastoQuery {
  @ApiPropertyOptional({
    description:
      'Momento REAL en que el capturista pidió la baja (ISO con zona). Como ' +
      'en el PATCH: la ventana semanal se evalúa contra este sello si viene ' +
      'y es ≤ ahora; la bitácora conserva «baja capturada el … · recibida el …».',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  capturado_en?: string;
}

// ===== Gastos de pista (cuotas de aeródromo VIP SAESA) =====

export class PistasPendientesQuery {
  @ApiProperty({ description: 'fecha >= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'fecha <= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  hasta!: string;
}

export class GenerarPistaItemDto {
  @ApiProperty({
    description: 'Escala (aterrizaje) a la que corresponde la cuota',
  })
  @IsUUID()
  escala_id!: string;

  @ApiProperty({ description: 'Monto de la cuota (editable; PCE es variable)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    enum: CategoriaGasto,
    default: CategoriaGasto.OPERACIONES,
  })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ enum: MedioPago, default: MedioPago.TRANSFERENCIA })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class GenerarPistasDto {
  @ApiProperty({ type: [GenerarPistaItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerarPistaItemDto)
  items!: GenerarPistaItemDto[];
}

export class CreateTarifaAerodromoDto {
  @ApiPropertyOptional({
    description: 'IATA del aeródromo; vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  codigo_iata?: string;

  @ApiPropertyOptional({
    description:
      'Modelo de aeronave (Kodiak/Cessna/Seneca); vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelo?: string;

  @ApiProperty({ description: 'Cuota por aterrizaje' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    description: 'Tarifa variable (p.ej. PCE): el monto es estimado',
  })
  @IsOptional()
  @IsBoolean()
  variable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateTarifaAerodromoDto extends PartialType(
  CreateTarifaAerodromoDto,
) {}

export class PhotoUrlsDto {
  @ApiProperty({
    type: [String],
    description: 'Paths de fotos en gasto-fotos a firmar',
  })
  @IsString({ each: true })
  paths!: string[];
}

export class SugerirVueloQuery {
  @ApiProperty({ description: 'Aeronave de la carga' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Momento de la carga (ISO 8601)' })
  @IsDateString()
  fecha_hora!: string;
}

export class RepartoItemDto {
  @ApiProperty({ description: 'Aeronave que absorbe esta parte del gasto' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Monto en la MONEDA del gasto', example: 500 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monto!: number;
}

export class PutRepartoDto {
  @ApiProperty({
    description:
      'Reparto COMPLETO del gasto entre aviones (reemplaza el anterior; [] lo limpia). Σ montos <= gasto.monto; el remanente queda como gasto de la empresa VuelaTour.',
    type: [RepartoItemDto],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepartoItemDto)
  items!: RepartoItemDto[];
}

export class RepartoMasivoLineaDto {
  @ApiProperty({ description: 'Aeronave que absorbe este porcentaje' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({
    description:
      'Porcentaje del monto de CADA gasto (hasta 2 decimales, 0.01–100)',
    example: 25,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  porcentaje!: number;
}

export class RepartoMasivoDto {
  @ApiProperty({
    type: [String],
    description: 'Gastos generales a los que se aplica el reparto (1–200)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  gasto_ids!: string[];

  @ApiProperty({
    description:
      'Reparto porcentual entre aviones (Σ <= 100.00; lo no asignado queda como gasto de la empresa VuelaTour). Reemplaza el reparto vigente de cada gasto.',
    type: [RepartoMasivoLineaDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepartoMasivoLineaDto)
  items!: RepartoMasivoLineaDto[];
}

export class ListOtrosGastosQuery {
  @ApiPropertyOptional({
    description: 'fecha_gasto >= (YYYY-MM-DD); default inicio del mes Cancún',
  })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({
    description: 'fecha_gasto <= (YYYY-MM-DD); default fin del mes Cancún',
  })
  @IsOptional()
  @IsDateString()
  hasta?: string;
}

export class ListGastosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description: 'Pagos de una compra de refacciones (gasto.compra_id).',
  })
  @IsOptional()
  @IsUUID()
  compra_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_captura_id?: string;

  @ApiPropertyOptional({ enum: CategoriaGasto })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ description: 'fecha_gasto >= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha_gasto <= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({
    description:
      'Fecha de CAPTURA >= (YYYY-MM-DD, día Cancún): lo que se subió desde esa fecha aunque el ticket traiga otra.',
  })
  @IsOptional()
  // Solo día puro: el servicio concatena `T00:00:00-05:00` (corte Cancún);
  // un ISO con hora armaría un timestamp inválido y PostgREST respondería
  // con un error opaco en vez de un 400 legible.
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'capturado_desde debe ser un día YYYY-MM-DD',
  })
  capturado_desde?: string;

  @ApiPropertyOptional({
    description: 'Fecha de CAPTURA <= (YYYY-MM-DD, día Cancún)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'capturado_hasta debe ser un día YYYY-MM-DD',
  })
  capturado_hasta?: string;

  @ApiPropertyOptional({
    enum: ['fecha', 'captura'],
    default: 'fecha',
    description:
      'Orden del listado: fecha = fecha del consumo (fecha_gasto desc, luego llegada al servidor); captura = momento real de captura (capturado_en desc). El Excel respeta el mismo orden.',
  })
  @IsOptional()
  @IsIn(['fecha', 'captura'])
  orden?: 'fecha' | 'captura';

  @ApiPropertyOptional({
    description: 'Solo gastos sin avión asignado (bandeja de pendientes).',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  pendientes?: boolean;

  @ApiPropertyOptional({
    description: 'Solo gastos marcados como posible duplicado.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  duplicados?: boolean;

  @ApiPropertyOptional({ enum: EstatusComprobante })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({
    description:
      'PENDIENTE | SOLICITADA | FACTURADA | NO_FACTURADA (= pendiente o solicitada)',
  })
  @IsOptional()
  @IsIn([...Object.values(EstatusFacturacion), 'NO_FACTURADA'])
  estatus_facturacion?: string;

  @ApiPropertyOptional({ enum: MedioPago })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

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
