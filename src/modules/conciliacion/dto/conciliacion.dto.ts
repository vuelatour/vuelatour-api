import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import {
  JUSTIFICACION_MAX,
  JUSTIFICACION_MIN,
} from '../../../common/vinculo-no-bancario.util';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Matches,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum TipoMovimientoBancario {
  CARGO = 'CARGO',
  ABONO = 'ABONO',
}

/** Día de pared YYYY-MM-DD (filtros sobre la columna DATE `fecha`). */
const RE_DIA_CONCILIACION = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mapeo MANUAL de columnas del estado de cuenta de Paywise (9-sep-2026):
 * respaldo cuando pyservices no reconoce los encabezados. Cada valor es el
 * NOMBRE de la columna tal como viene en el archivo (la respuesta de parse
 * devuelve `columnas` para elegirlas). Con mapeo, el archivo se lee como
 * formato `paywise` (abono NETO con bruto y comisión).
 */
export class MapeoColumnasPaywiseDto {
  @ApiProperty({ description: 'Columna de fecha (fecha de operación/pago).' })
  @IsString()
  @MaxLength(120)
  fecha!: string;

  @ApiPropertyOptional({ description: 'Columna del monto BRUTO cobrado.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bruto?: string;

  @ApiPropertyOptional({ description: 'Columna de la comisión retenida.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  comision?: string;

  @ApiPropertyOptional({ description: 'Columna del NETO depositado.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  neto?: string;

  @ApiPropertyOptional({
    description: 'Columna de referencia / ID de operación / autorización.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional({ description: 'Columna de descripción/concepto.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  descripcion?: string;

  @ApiPropertyOptional({
    description: 'Columna de estatus (aprobado/rechazado…).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  estatus?: string;
}

export class ConciliacionParseDto {
  @ApiProperty({
    description: 'Nombre del archivo (define el parser por extensión)',
  })
  @IsString()
  filename!: string;

  @ApiProperty({ description: 'Contenido del estado de cuenta en base64' })
  @IsString()
  file_base64!: string;

  @ApiPropertyOptional({
    description:
      'Mapeo manual de columnas (Paywise). Solo cuando la detección por encabezados no reconoce el archivo (formato genérico): fuerza el parser Paywise con estas columnas.',
    type: MapeoColumnasPaywiseDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MapeoColumnasPaywiseDto)
  mapeo?: MapeoColumnasPaywiseDto;
}

export class MovimientoImportDto {
  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsISO8601()
  fecha!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descripcion?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto!: number;

  @ApiProperty({ enum: TipoMovimientoBancario })
  @IsEnum(TipoMovimientoBancario)
  tipo!: TipoMovimientoBancario;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  // ADITIVO (Paywise, 9-sep-2026): solo los abonos de una PASARELA los
  // traen. `monto` sigue siendo lo DEPOSITADO (neto).
  @ApiPropertyOptional({
    description: 'Bruto que pagó el cliente (pasarela). monto = neto.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto_bruto?: number;

  @ApiPropertyOptional({
    description: 'Comisión retenida por la pasarela en este movimiento.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  comision_monto?: number;
}

export class ImportarMovimientosDto {
  @ApiProperty({
    description: 'Cuenta bancaria a la que pertenece el estado de cuenta',
  })
  @IsUUID()
  cuenta_bancaria_id!: string;

  @ApiProperty({ type: [MovimientoImportDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MovimientoImportDto)
  movimientos!: MovimientoImportDto[];

  // Archivo original del estado de cuenta: se archiva en el bucket privado
  // estados-cuenta para poder consultarlo/descargarlo después (auditoría).
  @ApiPropertyOptional({ description: 'Nombre del archivo importado' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;

  @ApiPropertyOptional({
    description: 'Archivo del estado de cuenta en base64',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16_000_000)
  file_base64?: string;
}

export class ListConciliacionQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'Filtra por estado de conciliación' })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  conciliado?: boolean;

  // ADITIVOS (24-sep-2026, conciliación de ingresos): tipo y ventana.
  @ApiPropertyOptional({ enum: TipoMovimientoBancario })
  @IsOptional()
  @IsEnum(TipoMovimientoBancario)
  tipo?: TipoMovimientoBancario;

  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD) sobre fecha' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD) sobre fecha' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Tope de gastos de UN cargo (lote): el caso real más grande son 29. */
export const LOTE_GASTOS_MAX = 50;

/** Texto recortado; vacío o solo espacios ⇒ ausente (`undefined`). */
const recortarOpcional = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t ? t : undefined;
};

export class LinkMovimientoDto {
  @ApiPropertyOptional({
    description:
      'Gasto a vincular. null para desvincular TODO (también un lote de varios gastos).',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  gasto_id?: string | null;

  /**
   * 1 cargo ↔ N gastos (2-oct-2026, API 0.0.52). `null` = ausente. Con UN
   * elemento es la misma liga que `gasto_id`. Excluyente con `gasto_id`
   * (400 `LOTE_INVALIDO`, ver `loteInvalido`).
   */
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description: `Gastos que paga este cargo (1..${LOTE_GASTOS_MAX}, sin repetir). Excluyente con gasto_id. Con 2 o más, cada gasto entra por lo que le falta y la suma debe cuadrar con el cargo (tolerancia de 1 centavo por gasto, mínimo 0.02 y máximo 1.00).`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LOTE_GASTOS_MAX)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  gasto_ids?: string[] | null;

  /**
   * GASTO NO BANCARIO (6-oct-2026, API 0.0.63): POR QUÉ se liga un gasto en
   * efectivo (o PERSONAL_*) a este cargo del banco. Obligatoria cuando entra
   * un gasto así (si no, 400 `JUSTIFICACION_REQUERIDA`); con gastos
   * bancarios se ignora. Se recorta; vacía o solo espacios = ausente.
   */
  @ApiPropertyOptional({
    nullable: true,
    minLength: JUSTIFICACION_MIN,
    maxLength: JUSTIFICACION_MAX,
    example:
      'Nadie capturó el estacionamiento del 7 de septiembre; se usa el ticket facturado del 28 para no perder la deducción.',
    description: `Razón para ligar un gasto que NO se pagó con el banco (efectivo, Personal Pablo/Ale) a este cargo (${JUSTIFICACION_MIN}–${JUSTIFICACION_MAX} caracteres). No cambia el medio de pago ni la caja del piloto: queda anotada en las notas del cargo y del gasto. Sin ella, un gasto así responde 400 JUSTIFICACION_REQUERIDA.`,
  })
  @IsOptional()
  @Transform(recortarOpcional)
  @IsString()
  @MinLength(JUSTIFICACION_MIN, {
    message: `La justificación debe tener al menos ${JUSTIFICACION_MIN} caracteres.`,
  })
  @MaxLength(JUSTIFICACION_MAX, {
    message: `La justificación admite hasta ${JUSTIFICACION_MAX} caracteres.`,
  })
  justificacion?: string | null;
}

/**
 * REGLA DEL 400 `LOTE_INVALIDO` del PATCH: `gasto_ids` (arreglo) y
 * `gasto_id` en el MISMO cuerpo son ambiguos. Un JSON no puede llevar
 * `undefined`, así que «presente» = `!== undefined` (con `null` incluido:
 * `{gasto_ids:[…], gasto_id:null}` también rebota). No se usa `'gasto_id' in
 * dto`: con `target` ES2022+ los campos declarados de la clase existen
 * SIEMPRE en la instancia (valen `undefined`).
 */
export function loteInvalido(dto: {
  gasto_id?: string | null;
  gasto_ids?: string[] | null;
}): boolean {
  return Array.isArray(dto.gasto_ids) && dto.gasto_id !== undefined;
}

/**
 * `GET /v1/conciliacion/movimientos/:id/gastos-candidatos` (2-oct-2026):
 * gastos bancarios sin conciliar que podrían pagar este CARGO (uno o varios).
 */
export class GastosCandidatosQuery {
  @ApiPropertyOptional({
    maxLength: 80,
    description:
      'Búsqueda: monto («2801» = [2801, 2802); «2801.40» = ±0.01) o texto (proveedor, nota, lugar o folio del ticket). El panel la manda ya normalizada.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({
    default: 30,
    description: 'Ventana ±días alrededor de la fecha del cargo (1..180).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  dias: number = 30;

  @ApiPropertyOptional({
    default: 100,
    description: 'Máximo de candidatos en la respuesta (1..300).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limite: number = 100;

  /**
   * ADITIVO (6-oct-2026, API 0.0.63): con `true`/`1` el universo incluye
   * también los gastos NO bancarios (EFECTIVO, PERSONAL_*), menos BODEGA,
   * con las mismas reglas (sin conciliar, moneda de la cuenta, ventana,
   * búsqueda; nunca cruzados) y cada candidato dice `no_bancario`. Orden
   * por niveles: lo que cuadra con el cargo (bancario y luego no bancario)
   * antes que el resto.
   */
  @ApiPropertyOptional({
    default: false,
    description:
      'true/1 ⇒ incluye los gastos que NO se pagaron con el banco (efectivo, Personal Pablo/Ale; nunca Bodega), solo en la moneda de la cuenta, con `no_bancario: true`. Orden: bancarios que cuadran con el cargo, no bancarios que cuadran, resto de bancarios, resto de no bancarios. Ligarlos exige `justificacion` en el PATCH.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  incluir_no_bancarios?: boolean;
}

/**
 * Liga de un ABONO: cobro de vuelo (`cobro_id`) O sobre de cobro de GRUPO
 * (`cobro_grupo_id`), excluyentes (400 si vienen ambos). Ambos null/ausentes
 * = desvincular (limpia las dos ligas). Una PARTE de sobre (cobro_vuelo con
 * cobro_grupo_id) nunca se acepta: 409 COBRO_DE_GRUPO.
 */
export class LinkMovimientoCobroDto {
  @ApiPropertyOptional({
    description: 'Cobro de vuelo a vincular. null para desvincular.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  cobro_id?: string | null;

  @ApiPropertyOptional({
    description:
      'Sobre de cobro de GRUPO (cobro_grupo) a vincular; excluyente con cobro_id. null para desvincular.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  cobro_grupo_id?: string | null;
}

/** Candidatos (cobros de vuelo + sobres de grupo) para conciliar un ABONO a mano. */
export class CandidatosCobroQuery {
  @ApiPropertyOptional({
    default: 60,
    description: 'Ventana ±días alrededor de la fecha del abono (1..180).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  dias: number = 60;
}

/**
 * Filtro de estado del reporte de conciliación: las MISMAS 4 pestañas de la
 * página. OJO: en movimiento_bancario "pendiente" y "no conciliado" son el
 * mismo booleano; los "no conciliados" del cliente son la pestaña roja de
 * gastos sin banco (`sin_banco`), que es OTRO universo (tabla gasto).
 */
export const REPORTE_CONCILIACION_ESTADOS = [
  'todos',
  'pendientes',
  'conciliados',
  'sin_banco',
] as const;
export type ReporteConciliacionEstado =
  (typeof REPORTE_CONCILIACION_ESTADOS)[number];

/** Reporte de conciliación en Excel (estado de cuenta + estatus por línea). */
export class ReporteConciliacionQuery {
  @ApiPropertyOptional({
    description:
      'Cuenta bancaria del reporte. Requerida salvo estado=sin_banco (esa pestaña lista gastos, no movimientos de una cuenta).',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiProperty({ description: 'Inicio del periodo (YYYY-MM-DD), obligatorio' })
  @IsISO8601()
  desde!: string;

  @ApiProperty({ description: 'Fin del periodo (YYYY-MM-DD), obligatorio' })
  @IsISO8601()
  hasta!: string;

  @ApiPropertyOptional({
    enum: REPORTE_CONCILIACION_ESTADOS,
    default: 'todos',
    description: 'Mismo filtro que las pestañas de la página de conciliación.',
  })
  @IsOptional()
  @IsIn([...REPORTE_CONCILIACION_ESTADOS])
  estado: ReporteConciliacionEstado = 'todos';
}

/**
 * Auditoría Paywise (9-sep-2026): cruza los abonos importados de la(s)
 * cuenta(s) PASARELA contra los cobros con método PAYWISE del sistema.
 */
export class PaywiseAuditoriaQuery {
  @ApiProperty({
    description: 'Inicio del periodo (YYYY-MM-DD) de los ABONOS de Paywise',
  })
  @IsISO8601()
  desde!: string;

  @ApiProperty({ description: 'Fin del periodo (YYYY-MM-DD)' })
  @IsISO8601()
  hasta!: string;

  @ApiPropertyOptional({
    description:
      'Cuenta PASARELA concreta. Omitida = todas las cuentas de tipo PASARELA.',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({
    default: 5,
    description:
      'Ventana ±días entre el abono y el cobro (liquidación diferida). 0..30.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  dias: number = 5;
}

/** Cobros bancarios (transferencia/link/cheque/Paywise) sin liga con el banco. */
export class CobrosSinBancoQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hace 90 días)' })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;
}

/** Alta de clasificación "sin vuelo" (o recuperación de la existente). */
export class CrearClasificacionDto {
  @ApiProperty({
    description: 'Nombre de la clasificación (p. ej. "Comisión del banco")',
  })
  @IsString()
  @MaxLength(80)
  nombre!: string;
}

/** Concilia por clasificación (sin gasto/cobro). null = quitarla. */
export class ClasificarMovimientoDto {
  @ApiPropertyOptional({
    description:
      'Clasificación a asignar. null para quitarla (vuelve a Pendiente).',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  clasificacion_id?: string | null;

  @ApiPropertyOptional({ description: 'Notas libres del movimiento' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}

/**
 * RE-CRUCE de pendientes (15-sep-2026): vuelve a correr el auto-cruce sobre
 * los movimientos que siguen sin conciliar. Todo opcional: sin filtros son
 * los últimos 90 días de TODAS las cuentas.
 */
export class AutoMatchDto {
  @ApiPropertyOptional({
    description: 'Cuenta bancaria a re-cruzar. Omitida = todas.',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({
    description: 'Inicio (YYYY-MM-DD). Default: hace 90 días (hora Cancún).',
  })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({
    description: 'Fin (YYYY-MM-DD). Default: hoy (hora Cancún).',
  })
  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @ApiPropertyOptional({
    default: 500,
    description: 'Tope de movimientos a revisar en esta corrida (1..2000).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limite?: number;

  /**
   * Re-cruce DIRIGIDO (el panel lo manda cuando el operador quiere reintentar
   * solo unas filas). Manda sobre `desde`/`hasta`: se revisan exactamente
   * estos movimientos (los que sigan `conciliado = false`).
   */
  @ApiPropertyOptional({
    type: [String],
    description: 'Solo estos movimientos (ignora desde/hasta). Máximo 500 ids.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  movimiento_ids?: string[];

  /** ADITIVO (24-sep-2026): solo CARGOS o solo ABONOS en esta corrida. */
  @ApiPropertyOptional({
    enum: TipoMovimientoBancario,
    description: 'Solo CARGO o solo ABONO (omitido = los dos).',
  })
  @IsOptional()
  @IsEnum(TipoMovimientoBancario)
  tipo?: TipoMovimientoBancario;
}

/**
 * Sugerencias de IA EN LOTE para los pendientes de una ventana. La IA
 * PROPONE y nunca liga: la respuesta son propuestas para que el operador
 * confirme en el panel.
 */
export class SugerirLoteDto {
  @ApiPropertyOptional({ description: 'Cuenta bancaria. Omitida = todas.' })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'Inicio (YYYY-MM-DD).' })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({ description: 'Fin (YYYY-MM-DD).' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @ApiPropertyOptional({
    default: 15,
    description:
      'Tope de movimientos a consultar con IA en esta corrida (1..40). Cada uno consume créditos.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(40)
  limite?: number;
}

// =====================================================================
// CONCILIACIÓN DE INGRESOS (24-sep-2026) — rutas nuevas del controller.
// Sin la migración 20260924000004 responden 503 INGRESOS_NO_DISPONIBLE.
// =====================================================================

/** `GET /v1/conciliacion/abonos-pendientes` (default: últimos 90 días). */
export class AbonosPendientesQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hace 90 días)' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hoy Cancún)' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ default: 300, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limite?: number;
}

/**
 * `POST /v1/conciliacion/sugerir-abonos` — la IA PROPONE qué es cada abono
 * pendiente (nunca liga). `movimiento_ids` manda sobre la ventana.
 */
export class SugerirAbonosDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hace 90 días)' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hoy Cancún)' })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 30,
    description: 'Abonos a revisar (cada 10 que vayan a la IA = 1 llamada).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  limite?: number;

  @ApiPropertyOptional({ type: [String], description: 'Máximo 30 ids.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID(undefined, { each: true })
  movimiento_ids?: string[];
}

/** `PATCH /v1/conciliacion/movimientos/:id/ingreso` (null = desvincular). */
export class LinkMovimientoIngresoDto {
  @ApiPropertyOptional({
    description: 'Ingreso a vincular. null para desvincular.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  ingreso_id?: string | null;
}

/**
 * `POST /v1/conciliacion/movimientos/:id/reverso` (30-sep-2026): empareja un
 * CARGO con el ABONO que lo devuelve. Contrato: `:id` = el abono y
 * `cargo_id` = el cargo. Por robustez se acepta también desde el cargo
 * (`:id` = cargo y `abono_id` = el abono): el servicio decide el rol de cada
 * uno por su tipo.
 */
export class EmparejarReversoDto {
  @ApiPropertyOptional({
    description: 'El CARGO que devuelve el abono `:id`.',
  })
  @IsOptional()
  @IsUUID()
  cargo_id?: string;

  @ApiPropertyOptional({
    description:
      'Alternativa desde el cargo: el ABONO que devuelve el cargo `:id`.',
  })
  @IsOptional()
  @IsUUID()
  abono_id?: string;
}

/**
 * `POST /v1/conciliacion/reversos/auto` (30-sep-2026): empareja solas las
 * devoluciones del banco con su cargo. Todo opcional: sin filtros son los
 * abonos de los últimos 90 días (hora Cancún) de todas las cuentas.
 */
export class AutoReversosDto {
  @ApiPropertyOptional({ description: 'Cuenta bancaria. Omitida = todas.' })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({
    description:
      'Inicio (YYYY-MM-DD) de la fecha del ABONO. Default: hace 90 días (hora Cancún).',
  })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({
    description: 'Fin (YYYY-MM-DD) de la fecha del ABONO. Default: hoy.',
  })
  @IsOptional()
  @Matches(RE_DIA_CONCILIACION, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;
}
