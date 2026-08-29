import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum TipoMovimientoInventario {
  ENTRADA = 'ENTRADA',
  SALIDA = 'SALIDA',
  DEVOLUCION = 'DEVOLUCION',
  AJUSTE = 'AJUSTE',
}

/**
 * Tope de filas por archivo de alta masiva: cada fila OK son ~5 consultas
 * (ítem + empaques + ENTRADA inicial); se procesan en lotes de
 * LOTE_ALTA_MASIVA en paralelo, y con más de 200 el panel se queda sin
 * timeout. El archivo grande se divide.
 */
export const MAX_FILAS_INVENTARIO = 200;
/** Filas OK que se crean en paralelo por lote al confirmar. */
export const LOTE_ALTA_MASIVA = 25;

/**
 * Valida SOLO si el campo viene en el body (undefined = no se toca). A
 * diferencia de @IsOptional, un `null` explícito SÍ se valida → 400 legible
 * en vez de un 23502 (500) de la BD en columnas NOT NULL.
 */
const SiViene = () => ValidateIf((_o, v) => v !== undefined);

export class ListInventarioQuery {
  @ApiPropertyOptional({ description: 'Búsqueda por nombre o número de parte' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional({
    description: 'Solo ítems por debajo del stock mínimo',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  bajo_stock?: boolean;

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

/** Foto extra del producto en el bucket PÚBLICO `inventario-fotos`. */
export class FotoInventarioDto {
  @ApiProperty({ maxLength: 1000, description: 'URL pública de la foto' })
  @IsString()
  @MaxLength(1000)
  url!: string;

  @ApiProperty({
    maxLength: 500,
    description: 'Path del objeto en el bucket (para borrar al reemplazar)',
  })
  @IsString()
  @MaxLength(500)
  // Un path del bucket nunca trae espacios ni "..": lo demás sería un bug del
  // cliente (o un intento de borrar fuera de la carpeta de fotos).
  @Matches(/^(?!.*\.\.)\S+$/, { message: 'path de foto inválido' })
  path!: string;
}

/**
 * Empaque / presentación de un ítem (caja de 6, tarima…): `factor` =
 * unidades del ítem por empaque; `codigo` = código de barras del EMPAQUE
 * (ITF-14/GTIN de la caja), distinto del de la unidad.
 */
export class EmpaqueInputDto {
  @ApiProperty({ maxLength: 60, example: 'Caja de 6' })
  @IsString()
  @MaxLength(60)
  nombre!: string;

  @ApiProperty({ description: 'Unidades por empaque (> 0)', example: 6 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  factor!: number;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Código de barras del empaque (sin espacios; el API lo normaliza). null = sin código.',
    example: '00021400062160',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  codigo?: string | null;
}

export class UpdateEmpaqueDto extends PartialType(EmpaqueInputDto) {
  @ApiPropertyOptional({ maxLength: 60, example: 'Caja de 6' })
  @SiViene()
  @IsString({ message: 'El empaque necesita un nombre.' })
  @MaxLength(60)
  nombre?: string;

  @ApiPropertyOptional({ description: 'Unidades por empaque (> 0)' })
  @SiViene()
  @Type(() => Number)
  @IsNumber({}, { message: 'Las unidades por empaque deben ser un número.' })
  @IsPositive({ message: 'Las unidades por empaque deben ser mayores a 0.' })
  factor?: number;

  @ApiPropertyOptional({ description: 'false = ya no se usa (no se borra)' })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class CreateInventarioItemDto {
  @ApiProperty({ maxLength: 200, example: 'Filtro de aceite 108-1' })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 80, example: 'AeroShell' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  marca?: string | null;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiPropertyOptional({
    description:
      'Código de barras / SKU de la UNIDAD (EAN/UPC tal cual lo lee el escáner; el API quita espacios). Único en bodega, también contra códigos de empaques.',
    maxLength: 60,
    example: '021400062153',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  codigo?: string;

  @ApiProperty({
    maxLength: 50,
    description: 'Categoría libre (aceites, filtros, llantas...)',
  })
  @IsString()
  @MaxLength(50)
  categoria!: string;

  @ApiPropertyOptional({
    description:
      'URL PÚBLICA de la foto del producto (bucket inventario-fotos; el cliente sube el archivo y manda aquí la URL). null = quitar la foto.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  foto_url?: string | null;

  @ApiPropertyOptional({
    description:
      'Path del archivo en el bucket (para borrar al reemplazar). null = quitar.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foto_storage_path?: string | null;

  @ApiPropertyOptional({
    type: [FotoInventarioDto],
    description:
      'Fotos extra del producto [{url, path}] (la principal sigue en foto_url). Al reemplazar/quitar, el API borra del bucket las que ya no estén.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FotoInventarioDto)
  fotos_adicionales?: FotoInventarioDto[];

  @ApiPropertyOptional({ description: 'Umbral de alerta de stock' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock_minimo?: number;

  @ApiPropertyOptional({ default: 'Bodega Cancún', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ubicacion?: string;

  @ApiPropertyOptional({
    maxLength: 30,
    description:
      'Presentación/unidad del stock: pieza, caja, bote, galón, litro, bolsa… NO es la cantidad.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  // Caso real (6 ago 2026): capturaron "1" aquí creyendo que era la cantidad y
  // el ítem quedó en stock 0 ("0 1" en la card). Un número solo NUNCA es una
  // unidad de medida: se rechaza con el mensaje que dice dónde va la cantidad.
  // La cadena vacía es válida (= sin unidad; el servicio la vuelve null).
  @Matches(/^$|^(?!\s*[\d.,]+\s*$).+/, {
    message:
      'La unidad describe cómo se cuenta el stock (pieza, caja, litro), no un número. La cantidad se registra como ENTRADA de inventario.',
  })
  unidad?: string;

  @ApiPropertyOptional({
    description:
      'Descripción de la ficha (contenido, presentación, especificación). La llena la IA desde las fotos; editable.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  descripcion?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    description:
      'Precio de VENTA unitario al avión (decisión del cliente 29-ago-2026): la SALIDA carga este precio como gasto BODEGA; el costo FIFO queda para el inventario. Sin precio (o 0) la salida se carga a costo FIFO como siempre. null = quitar el precio. Viaja JUNTO con precio_venta_moneda.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  precio_venta?: number | null;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda del precio de venta. OBLIGATORIA si viaja precio_venta > 0; sin precio se ignora (el panel siempre manda el par).',
  })
  @IsOptional()
  @IsIn(['MXN', 'USD'])
  precio_venta_moneda?: 'MXN' | 'USD' | null;

  @ApiPropertyOptional({
    type: [EmpaqueInputDto],
    description:
      'Empaques (cajas) que se crean junto con el ítem. Para editar después usa /items/:id/empaques.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EmpaqueInputDto)
  empaques?: EmpaqueInputDto[];
}

/**
 * Edición del ítem. Los empaques NO viajan aquí (tienen sus endpoints
 * propios): mandarlos da 400 por `forbidNonWhitelisted`.
 */
export class UpdateInventarioItemDto extends PartialType(
  OmitType(CreateInventarioItemDto, ['empaques'] as const),
) {
  // Columnas NOT NULL: null explícito → 400 (no 500 de la BD).
  @ApiPropertyOptional({ maxLength: 200 })
  @SiViene()
  @IsString({ message: 'El nombre del ítem no puede ir vacío.' })
  @MaxLength(200)
  nombre?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @SiViene()
  @IsString({ message: 'La categoría del ítem no puede ir vacía.' })
  @MaxLength(50)
  categoria?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @SiViene()
  @IsString({ message: 'La ubicación no puede ir vacía.' })
  @MaxLength(50)
  ubicacion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class CreateMovimientoDto {
  @ApiProperty({ enum: TipoMovimientoInventario })
  @IsEnum(TipoMovimientoInventario)
  tipo!: TipoMovimientoInventario;

  @ApiPropertyOptional({
    description:
      'Cantidad en UNIDADES (siempre positiva). Requerida salvo que se capture por empaque (empaque_id + cantidad_empaques): ahí la calcula el API (cantidad_empaques × factor, 2 decimales) y la enviada se ignora si difiere ≤ 0.011; si difiere más → 400.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad?: number;

  @ApiPropertyOptional({
    description:
      'Captura POR EMPAQUE (caja): id del empaque del ítem. La cantidad en unidades = cantidad_empaques × factor.',
  })
  @IsOptional()
  @IsUUID()
  empaque_id?: string;

  @ApiPropertyOptional({ description: 'Número de empaques capturados (> 0)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad_empaques?: number;

  @ApiPropertyOptional({
    description:
      'Costo unitario en USD. Requerido en ENTRADA/DEVOLUCION/AJUSTE si la captura es USD. En SALIDA se ignora: se calcula por FIFO.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_usd?: number;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de la CAPTURA (default USD por compatibilidad; panel/app mandan MXN por default). La contabilidad interna (FIFO/valorizado/gasto bodega) sigue en USD.',
  })
  @IsOptional()
  @IsIn(['MXN', 'USD'])
  moneda?: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description:
      'Costo unitario en PESOS (capturas MXN). El API lo convierte a USD con tc_usd_mxn.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio de la compra (MXN por USD). Requerido en capturas MXN; en capturas USD es opcional y se conserva para expresar la capa en pesos reales.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;

  @ApiPropertyOptional({
    description:
      'SALIDA: precio de VENTA unitario que paga el avión (default: el precio_venta del ítem). > 0 activa el cargo a precio de venta; 0 explícito o ausente sin precio en el ítem = cargo a costo FIFO (comportamiento de siempre). En otros tipos se ignora.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  venta_unitaria?: number;

  @ApiPropertyOptional({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de la venta (default: la del precio de venta del ítem, o MXN — la moneda operativa de bodega).',
  })
  @IsOptional()
  @IsIn(['MXN', 'USD'])
  venta_moneda?: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description:
      'Avión al que se carga la pieza. Requerido en SALIDA (salvo para_flota).',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description:
      'SALIDA para TODAS las matrículas (aceites/consumibles de flota): el costo FIFO se prorratea en partes iguales entre los aviones activos, un gasto por avión. Excluye aeronave_id.',
  })
  @IsOptional()
  @IsBoolean()
  para_flota?: boolean;

  @ApiPropertyOptional({ description: 'Proveedor de origen (en ENTRADA)' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    description: 'Fecha del movimiento (default: hoy en hora Cancún)',
  })
  @IsOptional()
  @IsISO8601()
  fecha_movimiento?: string;

  @ApiPropertyOptional({ description: 'Fecha de la orden de compra' })
  @IsOptional()
  @IsISO8601()
  fecha_orden?: string;

  @ApiPropertyOptional({ description: 'Fecha del cargo en estado de cuenta' })
  @IsOptional()
  @IsISO8601()
  fecha_cargo_banco?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'No. de orden / factura / referencia',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

/**
 * Corrección del COSTO de una ENTRADA de cardex (caso carga masiva
 * [CARGA-INV-AGO29]: entradas a $0 que el cliente completa con el precio
 * real). SOLO viaja costo/moneda/TC — cantidad, fecha y tipo JAMÁS se
 * editan (romperían el FIFO); mandar otro campo = 400 (forbidNonWhitelisted).
 * La moneda es OBLIGATORIA para que el operador diga en qué capturó (caso
 * aceites 28-ago-2026: pesos capturados como USD multiplicaron ×17 el costo).
 */
export class UpdateMovimientoCostoDto {
  @ApiProperty({
    enum: ['MXN', 'USD'],
    description:
      'Moneda de la captura del costo. MXN exige costo_unitario_mxn + tc_usd_mxn; USD exige costo_unitario_usd.',
  })
  @IsIn(['MXN', 'USD'])
  moneda!: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description: 'Costo unitario en USD (requerido si moneda=USD).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_usd?: number;

  @ApiPropertyOptional({
    description: 'Costo unitario en PESOS (requerido si moneda=MXN).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_unitario_mxn?: number;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio de la compra (MXN por USD). Requerido si moneda=MXN; opcional en USD (expresa la capa en pesos reales).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  tc_usd_mxn?: number;
}

export class ListMovimientosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({ enum: TipoMovimientoInventario })
  @IsOptional()
  @IsEnum(TipoMovimientoInventario)
  tipo?: TipoMovimientoInventario;

  @ApiPropertyOptional({ description: 'Desde (fecha_movimiento)' })
  @IsOptional()
  @IsISO8601()
  desde?: string;

  @ApiPropertyOptional({ description: 'Hasta (fecha_movimiento)' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;

  @ApiPropertyOptional({
    description:
      'true = solo movimientos con costo USD en 0 (entradas de la carga masiva pendientes de costo real).',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  sin_costo?: boolean;

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

/**
 * Alta masiva de ítems desde la plantilla Excel. Con `confirmar=false` (default)
 * solo se valida y se devuelve el preview fila por fila; con `confirmar=true`
 * se crean SOLO las filas OK (idempotente: lo que ya existe sale DUPLICADO).
 */
export class ImportarInventarioDto {
  @ApiProperty({ description: 'Archivo XLSX/CSV de la plantilla, en base64' })
  @IsString()
  archivo_base64!: string;

  @ApiProperty({ description: 'Nombre del archivo (decide el parser)' })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'true = crear las filas OK; false = solo preview',
  })
  @IsOptional()
  @IsBoolean()
  confirmar?: boolean;
}
