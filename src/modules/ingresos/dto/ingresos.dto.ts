import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CATEGORIAS_INGRESO } from '../../../common/categoria-ingreso.util';
import type {
  CategoriaIngreso,
  MetodoIngreso,
  MonedaIngreso,
} from '../ingresos.types';

/**
 * DTOs de INGRESOS (24-sep-2026). Ningún booleano viaja en QUERY (hueco
 * conocido de `@ToBooleanQuery()`, CLAUDE.md inv. 28): los filtros son enums
 * de texto. Los booleanos (`aceptar_*`) solo viajan en el CUERPO JSON.
 */

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MSG_DIA = 'debe ser una fecha YYYY-MM-DD';

export const MONEDAS_INGRESO: readonly MonedaIngreso[] = ['MXN', 'USD'];
/** = valores del enum `metodo_cobro` de la BD. */
export const METODOS_INGRESO: readonly MetodoIngreso[] = [
  'TRANSFERENCIA',
  'EFECTIVO',
  'DOLARES',
  'CHEQUE',
  'HSBC_LINK',
  'PAYWISE',
  'BILLPOCKET',
  'OTRO',
];
export const ORIGENES_ENTRADA = ['todos', 'cobros', 'ingresos'] as const;
export const FILTROS_CONCILIACION_ENTRADA = [
  'conciliado',
  'sin_conciliar',
  'no_bancario',
  'via_anticipo',
] as const;
export const FILTROS_CONCILIACION_INGRESO = [
  'conciliado',
  'sin_conciliar',
  'no_bancario',
] as const;
export const FILTROS_VUELO_ENTRADA = ['todos', 'por_volar'] as const;
export const VISTAS_INGRESOS = ['otros', 'anticipos', 'todos'] as const;
export const FILTROS_SALDO = ['con_saldo', 'todos'] as const;
export const FILTROS_BAJAS = ['excluir', 'incluir', 'solo'] as const;
export const ALCANCES_VUELOS = ['cliente', 'todos'] as const;

/** `GET /v1/ingresos/resumen`. Default: mes corriente Cancún. */
export class ResumenIngresosQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: día 1 del mes)' })
  @IsOptional()
  @Matches(RE_DIA, { message: `desde ${MSG_DIA}` })
  desde?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (default: hoy Cancún)' })
  @IsOptional()
  @Matches(RE_DIA, { message: `hasta ${MSG_DIA}` })
  hasta?: string;
}

/** Filtros de `GET /v1/ingresos/entradas` (sin paginar: el export). */
export class FiltrosEntradasQuery extends ResumenIngresosQuery {
  @ApiPropertyOptional({ enum: ORIGENES_ENTRADA, default: 'todos' })
  @IsOptional()
  @IsIn(ORIGENES_ENTRADA)
  origen?: (typeof ORIGENES_ENTRADA)[number];

  @ApiPropertyOptional({ enum: MONEDAS_INGRESO })
  @IsOptional()
  @IsIn(MONEDAS_INGRESO)
  moneda?: MonedaIngreso;

  @ApiPropertyOptional({ enum: METODOS_INGRESO })
  @IsOptional()
  @IsIn(METODOS_INGRESO)
  metodo?: MetodoIngreso;

  @ApiPropertyOptional({
    enum: [...CATEGORIAS_INGRESO, 'COBRO_VUELO'],
    description: 'Categoría del ingreso o COBRO_VUELO.',
  })
  @IsOptional()
  @IsIn([...CATEGORIAS_INGRESO, 'COBRO_VUELO'])
  categoria?: CategoriaIngreso | 'COBRO_VUELO';

  @ApiPropertyOptional({ enum: FILTROS_CONCILIACION_ENTRADA })
  @IsOptional()
  @IsIn(FILTROS_CONCILIACION_ENTRADA)
  conciliacion?: (typeof FILTROS_CONCILIACION_ENTRADA)[number];

  @ApiPropertyOptional({
    enum: FILTROS_VUELO_ENTRADA,
    default: 'todos',
    description:
      'por_volar = solo cobros de vuelos que aún no vuelan (depósitos por adelantado).',
  })
  @IsOptional()
  @IsIn(FILTROS_VUELO_ENTRADA)
  vuelo?: (typeof FILTROS_VUELO_ENTRADA)[number];

  @ApiPropertyOptional({
    description:
      'Folio de vuelo, ING-n, cliente, pagador, descripción o referencia (sin acentos).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

/** `GET /v1/ingresos/entradas` (paginado 1..200). */
export class EntradasQuery extends FiltrosEntradasQuery {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** `GET /v1/ingresos` — lista de ingresos registrados. */
export class ListIngresosQuery extends ResumenIngresosQuery {
  @ApiPropertyOptional({ enum: VISTAS_INGRESOS, default: 'otros' })
  @IsOptional()
  @IsIn(VISTAS_INGRESOS)
  vista?: (typeof VISTAS_INGRESOS)[number];

  @ApiPropertyOptional({ enum: CATEGORIAS_INGRESO })
  @IsOptional()
  @IsIn(CATEGORIAS_INGRESO)
  categoria?: CategoriaIngreso;

  @ApiPropertyOptional({ enum: MONEDAS_INGRESO })
  @IsOptional()
  @IsIn(MONEDAS_INGRESO)
  moneda?: MonedaIngreso;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  cliente_id?: string;

  @ApiPropertyOptional({ enum: FILTROS_CONCILIACION_INGRESO })
  @IsOptional()
  @IsIn(FILTROS_CONCILIACION_INGRESO)
  conciliacion?: (typeof FILTROS_CONCILIACION_INGRESO)[number];

  @ApiPropertyOptional({
    enum: FILTROS_SALDO,
    description:
      'Solo vista=anticipos. con_saldo (default) ignora desde/hasta y lista TODOS los anticipos con saldo.',
  })
  @IsOptional()
  @IsIn(FILTROS_SALDO)
  saldo?: (typeof FILTROS_SALDO)[number];

  @ApiPropertyOptional({ enum: FILTROS_BAJAS, default: 'excluir' })
  @IsOptional()
  @IsIn(FILTROS_BAJAS)
  bajas?: (typeof FILTROS_BAJAS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** `GET /v1/ingresos/export.xlsx` — filtros de entradas + `vista`. */
export class ExportIngresosQuery extends FiltrosEntradasQuery {
  @ApiPropertyOptional({ enum: VISTAS_INGRESOS, default: 'todos' })
  @IsOptional()
  @IsIn(VISTAS_INGRESOS)
  vista?: (typeof VISTAS_INGRESOS)[number];
}

/** `GET /v1/ingresos/vuelos-candidatos`. */
export class VuelosCandidatosIngresoQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  cliente_id?: string;

  @ApiPropertyOptional({
    description: 'Folio del vuelo o nombre del cliente (≥ 2 sin cliente).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ enum: ALCANCES_VUELOS, default: 'cliente' })
  @IsOptional()
  @IsIn(ALCANCES_VUELOS)
  alcance?: (typeof ALCANCES_VUELOS)[number];
}

/**
 * Cuerpo multipart del alta: UN campo de texto `datos` (JSON de
 * `CrearIngresoDto`) + archivo opcional `archivo`. Cualquier otro campo de
 * texto ⇒ 400 (`forbidNonWhitelisted`).
 */
export class CrearIngresoMultipartDto {
  @ApiProperty({ description: 'JSON de CrearIngresoDto.' })
  @IsString()
  @MaxLength(20000)
  datos!: string;
}

/** PATCH (mismo formato): `datos` opcional (ausente = `{}`). */
export class EditarIngresoMultipartDto {
  @ApiPropertyOptional({ description: 'JSON parcial de EditarIngresoDto.' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  datos?: string;
}

/**
 * Datos del ingreso (JSON del campo `datos`). Se valida A MANO con
 * `plainToInstance` + `validate({ whitelist, forbidNonWhitelisted })` (llega
 * como texto dentro del multipart). Las reglas que cruzan campos (efectivo
 * sin cuenta, anticipo con cliente, vuelo solo en reembolsos, TC…) las
 * valida el servicio con su `code`.
 */
export class CrearIngresoDto {
  @IsIn(CATEGORIAS_INGRESO)
  categoria!: CategoriaIngreso;

  @Matches(RE_DIA, { message: `fecha ${MSG_DIA}` })
  fecha!: string;

  @IsString()
  @MaxLength(400)
  descripcion!: string;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(99_999_999.99)
  monto!: number;

  @IsIn(MONEDAS_INGRESO)
  moneda!: MonedaIngreso;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  comision_monto?: number | null;

  // TC con los decimales que se quieran: el servicio lo NORMALIZA a 6
  // (invariante 20: los DTOs no rechazan decimales de más).
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  tc_usd_mxn?: number | null;

  @IsIn(METODOS_INGRESO)
  metodo!: MetodoIngreso;

  @IsOptional()
  @IsUUID('all')
  cuenta_bancaria_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  referencia?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  pagador?: string | null;

  @IsOptional()
  @IsUUID('all')
  cliente_id?: string | null;

  @IsOptional()
  @IsUUID('all')
  vuelo_id?: string | null;

  @IsOptional()
  @IsUUID('all')
  aeronave_id?: string | null;

  @IsOptional()
  @IsUUID('all')
  gasto_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  notas?: string | null;

  /** «Registrar como otro ingreso» desde un abono del banco. */
  @IsOptional()
  @IsUUID('all')
  movimiento_bancario_id?: string | null;

  /** Confirma `ABONO_TIENE_COBRO_CANDIDATO` (cuerpo JSON, nunca query). */
  @IsOptional()
  @IsBoolean()
  aceptar_sin_cobro?: boolean;

  /** Confirma `ABONO_POSIBLE_DUPLICADO` (cuerpo JSON, nunca query). */
  @IsOptional()
  @IsBoolean()
  aceptar_posible_duplicado?: boolean;

  /** Llave de IDEMPOTENCIA (uuid por captura). */
  @IsOptional()
  @IsUUID('all')
  client_request_id?: string;
}

/** Edición: todo opcional (sin abono, llave ni confirmaciones) + CAS. */
export class EditarIngresoDto extends PartialType(
  OmitType(CrearIngresoDto, [
    'movimiento_bancario_id',
    'client_request_id',
    'aceptar_sin_cobro',
    'aceptar_posible_duplicado',
  ] as const),
) {
  /** `updated_at` que leyó el cliente (409 CONFLICTO_VERSION si cambió). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  if_updated_at?: string;
}

/** `POST /v1/ingresos/:id/baja`. El servicio exige 5..500 tras `trim`. */
export class BajaIngresoDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @MaxLength(600)
  motivo!: string;
}

/** `POST /v1/ingresos/:id/aplicaciones` — aplicar un anticipo a un vuelo. */
export class AplicarAnticipoDto {
  @ApiProperty()
  @IsUUID('all')
  vuelo_id!: string;

  @ApiProperty({ description: 'Monto a aplicar (moneda del anticipo).' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  monto!: number;

  @ApiPropertyOptional({
    description: 'TC del cobro (default: el del anticipo o el del vuelo).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notas?: string;

  @ApiProperty({ description: 'Llave de idempotencia (OBLIGATORIA).' })
  @IsUUID('all')
  client_request_id!: string;

  @ApiPropertyOptional({
    description:
      'Confirma ANTICIPO_OTRO_CLIENTE (el vuelo es de otro cliente).',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_otro_cliente?: boolean;
}

/**
 * `POST /v1/ingresos/abonos/:movId/cobro-de-vuelo` — «Es el pago de un
 * vuelo que todavía no tiene su cobro registrado».
 */
export class CobroDesdeAbonoDto {
  @ApiProperty()
  @IsUUID('all')
  vuelo_id!: string;

  @ApiPropertyOptional({
    description: 'Bruto del cobro (default: monto_bruto del abono o su monto).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  monto?: number;

  @ApiPropertyOptional({
    description:
      'Comisión del banco (default: la del abono o 0 EXPLÍCITO — nunca se provisiona Paywise).',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  comision_banco_monto?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notas?: string;

  @ApiProperty({ description: 'Llave de idempotencia (OBLIGATORIA).' })
  @IsUUID('all')
  client_request_id!: string;

  /**
   * ADITIVO (revisión adversaria 24-sep-2026): confirma
   * `ABONO_TIENE_COBRO_CANDIDATO` — el vuelo YA tiene un cobro libre que
   * cuadra con el abono y aun así es OTRO pago (cuerpo JSON, nunca query).
   */
  @ApiPropertyOptional({
    description:
      'Confirma ABONO_TIENE_COBRO_CANDIDATO (el vuelo ya tiene un cobro libre con ese monto).',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_sin_cobro?: boolean;
}
