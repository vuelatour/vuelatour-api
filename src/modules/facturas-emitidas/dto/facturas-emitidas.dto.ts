import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
} from 'class-validator';
import {
  ESTATUS_FACTURA_EMITIDA,
  FILTROS_ALERTA,
  METODOS_PAGO_FACTURA,
  MONEDAS_FACTURA,
  ORDENES_FACTURAS,
  type EstatusFacturaEmitida,
  type FiltroAlerta,
  type MetodoPagoFactura,
  type MonedaFactura,
  type OrdenFacturas,
} from '../facturas-emitidas.types';

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_UUID_O_SIN_EMISORA =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|SIN_EMISORA)$/;

/** `GET /v1/facturas-emitidas` — filtros del registro (todos opcionales). */
export class ListFacturasEmitidasQuery {
  @ApiPropertyOptional({
    description:
      'Busca en serie, folio, «A-123», UUID, receptor (nombre/RFC), cliente y folio de vuelo («341» o «#341»). Sin acentos ni mayúsculas.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'Emitidas desde (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(RE_DIA, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({ description: 'Emitidas hasta (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(RE_DIA, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  cliente_id?: string;

  @ApiPropertyOptional({
    description: 'Razón social emisora (uuid) o SIN_EMISORA.',
  })
  @IsOptional()
  @Matches(RE_UUID_O_SIN_EMISORA, {
    message: 'emisora_id debe ser un uuid o SIN_EMISORA',
  })
  emisora_id?: string;

  @ApiPropertyOptional({
    description: 'Serie (igualdad en MAYÚSCULAS); SIN_SERIE = sin serie.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  serie?: string;

  @ApiPropertyOptional({ enum: ESTATUS_FACTURA_EMITIDA })
  @IsOptional()
  @IsIn(ESTATUS_FACTURA_EMITIDA)
  estatus?: EstatusFacturaEmitida;

  @ApiPropertyOptional({ description: 'Facturas ligadas a ese vuelo' })
  @IsOptional()
  @IsUUID('all')
  vuelo_id?: string;

  @ApiPropertyOptional({ enum: FILTROS_ALERTA })
  @IsOptional()
  @IsIn(FILTROS_ALERTA)
  alerta?: FiltroAlerta;

  @ApiPropertyOptional({ enum: ORDENES_FACTURAS, default: 'folio_desc' })
  @IsOptional()
  @IsIn(ORDENES_FACTURAS)
  orden?: OrdenFacturas;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** `GET /v1/facturas-emitidas/export.xlsx` — mismos filtros, sin paginar. */
export class ExportFacturasEmitidasQuery extends OmitType(
  ListFacturasEmitidasQuery,
  ['limit', 'offset'] as const,
) {}

/**
 * Cuerpo multipart de alta/edición: UN solo campo de texto `datos` (JSON de
 * `FacturaEmitidaDatos`) + archivos `pdf`/`xml`. Cualquier otro campo de
 * texto ⇒ 400 (`forbidNonWhitelisted`).
 */
export class FacturaEmitidaMultipartDto {
  @ApiProperty({
    description:
      'JSON de FacturaEmitidaDatos (serie, folio, uuid, fecha_emision, emisora_id, cliente_id, receptor_rfc, receptor_nombre, moneda, subtotal, iva, total, metodo_pago, forma_pago, notas, es_parcial, vuelo_ids).',
  })
  @IsString()
  @MaxLength(20000)
  datos!: string;
}

/**
 * PATCH (mismo formato): `datos` es OPCIONAL (un PATCH que solo trae
 * archivos no necesita mandar `{}`); ausente = `{}`.
 */
export class FacturaEmitidaPatchMultipartDto {
  @ApiPropertyOptional({
    description: 'JSON parcial de FacturaEmitidaDatos (todo opcional).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  datos?: string;
}

/** Multipart SIN campos de texto (`leer-archivo`, `:id/archivo`, comprobante). */
export class SinCamposDto {}

/** `LeerArchivoFacturaDto {}` del contrato (alias con nombre propio). */
export class LeerArchivoFacturaDto extends SinCamposDto {}

/** Motivo de cancelar / eliminar (3–500; el servicio da 400 MOTIVO_REQUERIDO). */
export class MotivoFacturaDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  motivo?: string;
}

/** `?tipo=pdf|xml` de las rutas de archivo. */
export class TipoArchivoQuery {
  @ApiPropertyOptional({ enum: ['pdf', 'xml'], default: 'pdf' })
  @IsOptional()
  @IsIn(['pdf', 'xml'])
  tipo?: 'pdf' | 'xml';
}

/** `GET /v1/facturas-emitidas/vuelos-candidatos`. */
export class VuelosCandidatosQuery {
  @ApiPropertyOptional({
    description:
      '«341»/«#341» ⇒ folio exacto (incluye cancelados); «2026-09-27» o «27/09[/2026]» ⇒ día Cancún; texto ⇒ cliente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Ids separados por coma (≤ 50) para hidratar seleccionados.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50 * 37)
  ids?: string;

  @ApiPropertyOptional({
    description: 'Todos los hijos NO cancelados del grupo',
  })
  @IsOptional()
  @IsUUID('all')
  grupo_id?: string;
}

/**
 * Datos de la factura (JSON del campo `datos`). TODOS opcionales aquí: el
 * alta exige folio, fecha_emision, moneda y total en el servicio (mensajes
 * en español en `details.errores`). Se valida con `validate({ whitelist,
 * forbidNonWhitelisted })` a mano (llega como texto dentro del multipart).
 */
export class FacturaEmitidaDatosDto {
  @IsOptional()
  @IsString()
  @MaxLength(25)
  serie?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  uuid?: string | null;

  @IsOptional()
  @Matches(RE_DIA, { message: 'fecha_emision debe ser YYYY-MM-DD' })
  fecha_emision?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  emisor_rfc?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  emisor_nombre?: string | null;

  @IsOptional()
  @IsUUID('all')
  emisora_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  receptor_rfc?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  receptor_nombre?: string | null;

  @IsOptional()
  @IsUUID('all')
  cliente_id?: string | null;

  @IsOptional()
  @IsIn(MONEDAS_FACTURA)
  moneda?: MonedaFactura;

  // numeric(14,2) en la BD: el tope evita un 500 por desbordamiento.
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(999_999_999_999)
  subtotal?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(999_999_999_999)
  iva?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Max(999_999_999_999)
  total?: number;

  @IsOptional()
  @IsIn(METODOS_PAGO_FACTURA)
  metodo_pago?: MetodoPagoFactura | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/, { message: 'forma_pago son 2 dígitos (catálogo SAT)' })
  forma_pago?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notas?: string | null;

  @IsOptional()
  @IsBoolean()
  es_parcial?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  vuelo_ids?: string[];
}
