import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import {
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
  ValidateNested,
} from 'class-validator';

export enum TipoMovimientoBancario {
  CARGO = 'CARGO',
  ABONO = 'ABONO',
}

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

export class LinkMovimientoDto {
  @ApiPropertyOptional({
    description: 'Gasto a vincular. null para desvincular.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  gasto_id?: string | null;
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
