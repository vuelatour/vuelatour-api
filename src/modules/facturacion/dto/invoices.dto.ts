import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListPendientesQuery {
  @ApiPropertyOptional({ description: 'fecha_vuelo >= (ISO)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha_vuelo <= (ISO)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cliente_id?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class ListFacturasQuery {
  @ApiPropertyOptional({ enum: ['TIMBRADA', 'CANCELADA', 'ERROR'] })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  emisora_id?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class EmitirFacturaDto {
  @ApiProperty()
  @IsUUID()
  vuelo_id!: string;

  @ApiProperty()
  @IsUUID()
  entidad_fiscal_emisora_id!: string;

  // Receptor alterno opcional (caso 9.7 "SE FACTURÓ A"). Si se envía facturado_a_rfc,
  // el CFDI se emite a este receptor en lugar del cliente del vuelo.
  @ApiPropertyOptional({ description: 'RFC del receptor "SE FACTURÓ A" (12-13).' })
  @IsOptional()
  @Matches(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, { message: 'RFC inválido.' })
  facturado_a_rfc?: string;

  @ApiPropertyOptional({ description: 'Razón social / nombre del receptor "SE FACTURÓ A".' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  facturado_a_nombre?: string;

  @ApiPropertyOptional({ description: 'Régimen fiscal SAT del receptor "SE FACTURÓ A".' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  facturado_a_regimen?: string;

  @ApiPropertyOptional({ description: 'CP (DomicilioFiscalReceptor) del receptor "SE FACTURÓ A".' })
  @IsOptional()
  @Matches(/^\d{5}$/, { message: 'CP de 5 dígitos.' })
  facturado_a_cp?: string;

  @ApiPropertyOptional({ description: 'Uso CFDI del receptor "SE FACTURÓ A".' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  facturado_a_uso_cfdi?: string;
}

export class CancelarFacturaDto {
  @ApiProperty({
    enum: ['01', '02', '03', '04'],
    description:
      'Motivo SAT: 01 comprobante con relación, 02 errores sin relación, 03 no se llevó a cabo, 04 nominativa.',
    default: '02',
  })
  @IsIn(['01', '02', '03', '04'])
  motivo!: string;

  @ApiPropertyOptional({
    description: 'UUID de la factura que sustituye (obligatorio cuando motivo=01).',
  })
  @IsOptional()
  @IsString()
  @Length(36, 36)
  folio_sustitucion?: string;
}

export class NotaCreditoDto {
  @ApiProperty({ description: 'Factura original (TIMBRADA) a la que se relaciona la nota.' })
  @IsUUID()
  factura_id!: string;

  @ApiPropertyOptional({ description: 'Tipo de relación SAT (default 01).', default: '01' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  tipo_relacion?: string;

  @ApiPropertyOptional({ description: 'Monto a acreditar (default: total de la factura original).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto?: number;

  @ApiPropertyOptional({ description: 'Descripción del concepto de la nota de crédito.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  descripcion?: string;
}

export class FacturaFileUrlsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  paths!: string[];
}

const ESTADOS_RECIBIDA = ['SIN_CLASIFICAR', 'CLASIFICADA', 'DESCARTADA'];

export class CrearRecibidaDto {
  @ApiProperty({ description: 'XML del CFDI recibido en base64' })
  @IsString()
  xml_b64!: string;
}

export class ListRecibidasQuery {
  @ApiPropertyOptional({ enum: ESTADOS_RECIBIDA })
  @IsOptional()
  @IsIn(ESTADOS_RECIBIDA)
  estado?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limit = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class UpdateRecibidaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  gasto_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria_sugerida?: string;

  @ApiPropertyOptional({ enum: ESTADOS_RECIBIDA })
  @IsOptional()
  @IsIn(ESTADOS_RECIBIDA)
  estado?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class RecibidaFileUrlsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  paths!: string[];
}

export class AmarrarGastosDto {
  @ApiProperty({
    type: [String],
    description:
      'Gastos amparados por la factura (una factura de proveedor puede cubrir varios aterrizajes/servicios). Lista vacía = desamarrar todo.',
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  gasto_ids!: string[];
}
