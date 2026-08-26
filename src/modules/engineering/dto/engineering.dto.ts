import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const ESTADOS_MANTENIMIENTO = [
  'PROGRAMADO',
  'EN_TALLER',
  'COMPLETADO',
] as const;
export type EstadoMantenimiento = (typeof ESTADOS_MANTENIMIENTO)[number];
export const TIPOS_MANTENIMIENTO_LEGADO = ['PROGRAMADO', 'REALIZADO'] as const;
export type TipoMantenimientoLegado =
  (typeof TIPOS_MANTENIMIENTO_LEGADO)[number];
const PAISES_SERVICIO = ['MX', 'USA'] as const;

export class CreateMantenimientoDto {
  @ApiPropertyOptional({
    enum: ESTADOS_MANTENIMIENTO,
    description:
      'Ciclo del servicio: programado → en taller → completado. Opcional solo si viene `tipo` (compat app).',
  })
  // Compat con APKs viejos de la app: mandan `tipo` en vez de `estado`. Debe
  // venir al menos uno; si vienen ambos, `estado` explícito gana (el mapeo
  // vive en engineering.service). Se valida `estado` siempre que venga, y
  // también cuando falten ambos (para exigir al menos uno).
  @ValidateIf(
    (o: CreateMantenimientoDto) =>
      o.estado !== undefined || o.tipo === undefined,
  )
  @IsIn(ESTADOS_MANTENIMIENTO, {
    message:
      'Indica el estado del servicio (PROGRAMADO, EN_TALLER o COMPLETADO) o el tipo (PROGRAMADO/REALIZADO).',
  })
  estado?: EstadoMantenimiento;

  @ApiPropertyOptional({
    enum: TIPOS_MANTENIMIENTO_LEGADO,
    description:
      'Campo legado de la app: PROGRAMADO→estado PROGRAMADO, REALIZADO→estado COMPLETADO. Ignorado si viene `estado`.',
  })
  @IsOptional()
  @IsIn(TIPOS_MANTENIMIENTO_LEGADO)
  tipo?: TipoMantenimientoLegado;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  descripcion!: string;

  @ApiPropertyOptional({
    enum: PAISES_SERVICIO,
    description: 'País del servicio (MX/USA)',
  })
  @IsOptional()
  @IsIn(PAISES_SERVICIO)
  pais?: 'MX' | 'USA';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_programada?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_realizada?: string;

  @ApiPropertyOptional({
    description: 'Horas a las que ENTRÓ realmente (Hobbs).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_aeronave?: number;

  @ApiPropertyOptional({
    description: 'Horas a las que DEBÍA entrar (umbral programado).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_programadas?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costo_usd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proveedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Etapa del programa cíclico que cubre este servicio (ej. 50, 100, 200). Null = fuera del programa.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  etapa_intervalo_hr?: number;

  @ApiPropertyOptional({
    description: 'Tareas ejecutadas (checklist de la etapa + tareas libres).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  tareas_realizadas?: string[];

  @ApiPropertyOptional({
    description: 'Motor al que aplica el servicio (opcional).',
  })
  @IsOptional()
  @IsUUID()
  motor_id?: string;

  @ApiPropertyOptional({
    description: 'Hélice a la que aplica el servicio (opcional).',
  })
  @IsOptional()
  @IsUUID()
  helice_id?: string;
}

export class UpdateMantenimientoDto {
  @ApiPropertyOptional({ enum: ESTADOS_MANTENIMIENTO })
  @IsOptional()
  @IsIn(ESTADOS_MANTENIMIENTO)
  estado?: EstadoMantenimiento;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional({ enum: PAISES_SERVICIO })
  @IsOptional()
  @IsIn(PAISES_SERVICIO)
  pais?: 'MX' | 'USA';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_programada?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fecha_realizada?: string;

  @ApiPropertyOptional({
    description: 'Horas a las que ENTRÓ realmente (Hobbs).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_aeronave?: number;

  @ApiPropertyOptional({
    description: 'Horas a las que DEBÍA entrar (umbral programado).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_programadas?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costo_usd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proveedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Etapa del programa cíclico que cubre este servicio. null explícito la limpia.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  etapa_intervalo_hr?: number | null;

  @ApiPropertyOptional({
    description: 'Tareas ejecutadas (checklist de la etapa + tareas libres).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  tareas_realizadas?: string[];

  @ApiPropertyOptional({
    description: 'Motor al que aplica (null explícito lo limpia).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  motor_id?: string | null;

  @ApiPropertyOptional({
    description: 'Hélice a la que aplica (null explícito la limpia).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  helice_id?: string | null;
}

export class CreateVencimientoDto {
  @ApiProperty()
  @IsUUID()
  tipo_documento_id!: string;

  @ApiProperty({ enum: ['FECHA', 'HORAS', 'PERMANENTE'] })
  @IsIn(['FECHA', 'HORAS', 'PERMANENTE'])
  vence_por!: 'FECHA' | 'HORAS' | 'PERMANENTE';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (si vence_por=FECHA)' })
  @IsOptional()
  @IsDateString()
  fecha_vencimiento?: string;

  @ApiPropertyOptional({ description: 'Horas límite (si vence_por=HORAS)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  horas_limite?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  umbral_alerta_dias?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  motor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  piloto_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Override por documento del es_critico del tipo (null = hereda).',
  })
  @IsOptional()
  @IsBoolean()
  critico?: boolean | null;

  @ApiPropertyOptional({
    description:
      'PATH de la copia del documento en el bucket documentos-flota.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^oficina\/[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'archivo_url debe ser un path oficina/<archivo> del bucket',
  })
  archivo_url?: string;
}
