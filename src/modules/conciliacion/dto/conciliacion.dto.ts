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

export class ConciliacionParseDto {
  @ApiProperty({
    description: 'Nombre del archivo (define el parser por extensión)',
  })
  @IsString()
  filename!: string;

  @ApiProperty({ description: 'Contenido del estado de cuenta en base64' })
  @IsString()
  file_base64!: string;
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

/** Alta de clasificación "sin vuelo" (o recuperación de la existente). */
export class CrearClasificacionDto {
  @ApiProperty({ description: 'Nombre de la clasificación (p. ej. "Comisión del banco")' })
  @IsString()
  @MaxLength(80)
  nombre!: string;
}

/** Concilia por clasificación (sin gasto/cobro). null = quitarla. */
export class ClasificarMovimientoDto {
  @ApiPropertyOptional({
    description: 'Clasificación a asignar. null para quitarla (vuelve a Pendiente).',
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
