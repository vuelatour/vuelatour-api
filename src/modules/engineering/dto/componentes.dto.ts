import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * MANTENIMIENTO UNIFICADO (17-nov-2026, API 0.0.140, invariante 135): DTOs de
 * los componentes del avión con vida límite y de los archivos de ingeniería
 * (sticker del taller, factura, certificado…). Las reglas de «cuánto le
 * queda» viven en `componente-vida.util`; aquí solo se valida la captura.
 */

// ===== Adjuntos =====

export const DESTINOS_ADJUNTO = [
  'MANTENIMIENTO',
  'COMPONENTE',
  'MOTOR',
  'HELICE',
] as const;
export type DestinoAdjunto = (typeof DESTINOS_ADJUNTO)[number];

export const ETIQUETAS_ADJUNTO = [
  'STICKER',
  'FACTURA',
  'CERTIFICADO',
  'ORDEN_TRABAJO',
  'BITACORA',
  'OTRO',
] as const;
export type EtiquetaAdjunto = (typeof ETIQUETAS_ADJUNTO)[number];

/** Los MISMOS tipos que acepta el bucket `documentos-flota`. */
export const MIMES_ADJUNTO = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** Tope del bucket `documentos-flota` (10 MB) y del check de la tabla. */
export const ADJUNTO_BYTES_MAX = 10 * 1024 * 1024;

/**
 * Llave del objeto dentro del bucket: `oficina/…`, sin `..` (mismo criterio
 * que el check `adjunto_ingenieria_path_chk`).
 */
export const RE_STORAGE_PATH_ADJUNTO = /^(?!.*\.\.)oficina\/[A-Za-z0-9._/-]+$/;

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_DIA = 'debe ser una fecha AAAA-MM-DD';

/** Recorta espacios de un texto (lo demás pasa tal cual al validador). */
const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAdjuntoDto {
  @ApiProperty({ enum: DESTINOS_ADJUNTO })
  @IsIn(DESTINOS_ADJUNTO, {
    message:
      'Indica a qué pertenece el archivo: MANTENIMIENTO, COMPONENTE, MOTOR o HELICE.',
  })
  destino!: DestinoAdjunto;

  @ApiProperty({ description: 'Id del mantenimiento/componente/motor/hélice.' })
  @IsUUID()
  destino_id!: string;

  @ApiProperty({
    description:
      'Llave del objeto YA subido al bucket documentos-flota (oficina/…).',
  })
  @IsString()
  @MaxLength(300)
  @Matches(RE_STORAGE_PATH_ADJUNTO, {
    message: 'storage_path debe ser una ruta oficina/<archivo> del bucket',
  })
  storage_path!: string;

  @ApiProperty({ description: 'Nombre original del archivo.' })
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Falta el nombre del archivo.' })
  @MaxLength(200)
  nombre!: string;

  @ApiProperty({ enum: MIMES_ADJUNTO })
  @IsIn(MIMES_ADJUNTO, {
    message: 'Solo se aceptan fotos (JPG, PNG, WebP) o PDF.',
  })
  mime!: (typeof MIMES_ADJUNTO)[number];

  @ApiProperty({ description: 'Tamaño en bytes (hasta 10 MB).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADJUNTO_BYTES_MAX, { message: 'El archivo pesa más de 10 MB.' })
  bytes!: number;

  @ApiPropertyOptional({ enum: ETIQUETAS_ADJUNTO })
  @IsOptional()
  @IsIn(ETIQUETAS_ADJUNTO)
  etiqueta?: EtiquetaAdjunto;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(300)
  nota?: string;
}

// ===== Componentes =====

export class CreateComponenteDto {
  @ApiProperty({ description: 'Ej. «Llanta principal izquierda».' })
  @Transform(recortar)
  @IsString()
  @MinLength(2, {
    message: 'El nombre del componente lleva al menos 2 letras.',
  })
  @MaxLength(120)
  nombre!: string;

  @ApiPropertyOptional({ description: 'Ej. «Tren de aterrizaje», «Luces».' })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  categoria?: string;

  @ApiPropertyOptional({ description: 'Ej. «Principal izquierda», «Nariz».' })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  posicion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_parte?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_serie?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(80)
  fabricante?: string;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD' })
  @IsOptional()
  @Matches(RE_DIA, { message: `fecha_instalacion ${MENSAJE_DIA}` })
  fecha_instalacion?: string;

  @ApiPropertyOptional({
    description: 'Hobbs del AVIÓN el día que se instaló el componente.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_aeronave_instalacion?: number;

  @ApiPropertyOptional({
    description: 'Horas que el componente ya traía (usado). 0 = nuevo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_previas?: number;

  @ApiPropertyOptional({ description: 'Vida límite en horas del componente.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'El límite de horas debe ser mayor que 0.' })
  @Max(999999.99)
  limite_horas?: number;

  @ApiPropertyOptional({ description: 'Vida límite de calendario, en meses.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  limite_meses?: number;

  @ApiPropertyOptional({
    description:
      'Fecha EXACTA de vencimiento (AAAA-MM-DD). Manda sobre instalación + meses.',
  })
  @IsOptional()
  @Matches(RE_DIA, { message: `fecha_vencimiento ${MENSAJE_DIA}` })
  fecha_vencimiento?: string;

  @ApiPropertyOptional({
    description: 'Horas de anticipación para marcar «por vencer» (default 10).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999.99)
  aviso_horas?: number;

  @ApiPropertyOptional({
    description: 'Días de anticipación para marcar «por vencer» (default 30).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  aviso_dias?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(1000)
  notas?: string;
}

/**
 * Edición: todo opcional. Un `null` EXPLÍCITO limpia un opcional (categoría,
 * posición, P/N, S/N, fabricante, fechas, Hobbs al instalar, límites, notas).
 * `nombre`, `horas_previas` y los avisos no admiten null (no son opcionales
 * en la tabla). No cambia `estado`: para eso están reemplazar y retirar.
 */
export class UpdateComponenteDto {
  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @Transform(recortar)
  @IsString()
  @MinLength(2, {
    message: 'El nombre del componente lleva al menos 2 letras.',
  })
  @MaxLength(120)
  nombre?: string;

  @ApiPropertyOptional({ description: 'null explícito la limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  categoria?: string | null;

  @ApiPropertyOptional({ description: 'null explícito la limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  posicion?: string | null;

  @ApiPropertyOptional({ description: 'null explícito lo limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_parte?: string | null;

  @ApiPropertyOptional({ description: 'null explícito lo limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_serie?: string | null;

  @ApiPropertyOptional({ description: 'null explícito lo limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(80)
  fabricante?: string | null;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD; null explícito la limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(RE_DIA, { message: `fecha_instalacion ${MENSAJE_DIA}` })
  fecha_instalacion?: string | null;

  @ApiPropertyOptional({ description: 'null explícito lo limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_aeronave_instalacion?: number | null;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_previas?: number;

  @ApiPropertyOptional({
    description: 'null explícito = ya no se sigue por horas.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'El límite de horas debe ser mayor que 0.' })
  @Max(999999.99)
  limite_horas?: number | null;

  @ApiPropertyOptional({
    description: 'null explícito = ya no se sigue por meses.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  limite_meses?: number | null;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD; null explícito la limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(RE_DIA, { message: `fecha_vencimiento ${MENSAJE_DIA}` })
  fecha_vencimiento?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999.99)
  aviso_horas?: number;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  aviso_dias?: number;

  @ApiPropertyOptional({ description: 'null explícito las limpia.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(1000)
  notas?: string | null;
}

/**
 * Datos del componente NUEVO en un reemplazo. Límites (`limite_horas`,
 * `limite_meses`): número = ese límite; `null` EXPLÍCITO = la pieza nueva no
 * tiene ese límite; AUSENTE = hereda el del que sale (el panel los manda
 * siempre). Lo demás es de la pieza: ausente o null = vacío. `@IsOptional`
 * deja pasar el null TAL CUAL; el servicio distingue null de undefined.
 */
export class NuevoComponenteReemplazoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_parte?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(60)
  numero_serie?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(80)
  fabricante?: string | null;

  @ApiPropertyOptional({
    description: 'Horas que ya trae el nuevo (default 0).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_previas?: number;

  @ApiPropertyOptional({
    description:
      'Omitido = hereda el del componente anterior; null = sin límite por horas.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'El límite de horas debe ser mayor que 0.' })
  @Max(999999.99)
  limite_horas?: number | null;

  @ApiPropertyOptional({
    description:
      'Omitido = hereda el del componente anterior; null = sin límite por meses.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  limite_meses?: number | null;

  @ApiPropertyOptional({
    description:
      'Fecha EXACTA del nuevo (AAAA-MM-DD). La del anterior NO se hereda.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(RE_DIA, { message: `fecha_vencimiento ${MENSAJE_DIA}` })
  fecha_vencimiento?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(1000)
  notas?: string | null;
}

export class RetirarComponenteDto {
  @ApiProperty({ description: 'Fecha del retiro o del cambio (AAAA-MM-DD).' })
  @Matches(RE_DIA, { message: `fecha ${MENSAJE_DIA}` })
  fecha!: string;

  @ApiPropertyOptional({
    description: 'Hobbs del avión en ese momento. Omitido = el Hobbs actual.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999.99)
  horas_aeronave?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(300)
  motivo?: string;
}

export class ReemplazarComponenteDto extends RetirarComponenteDto {
  @ApiPropertyOptional({ type: NuevoComponenteReemplazoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NuevoComponenteReemplazoDto)
  nuevo?: NuevoComponenteReemplazoDto;
}
