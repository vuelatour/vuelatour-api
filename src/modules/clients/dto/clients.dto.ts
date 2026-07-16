import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Normaliza claves SAT a MAYÚSCULAS (RFC/uso CFDI): el SAT las rechaza en
// minúsculas y el equipo las captura como sea.
const aMayusculas = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export enum CanalCliente {
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  LANDING = 'LANDING',
  LLAMADA = 'LLAMADA',
  REFERIDO = 'REFERIDO',
}

export class ListClientesQuery {
  @ApiPropertyOptional({
    description: 'Búsqueda por nombre, email, teléfono o RFC',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: CanalCliente })
  @IsOptional()
  @IsEnum(CanalCliente)
  canal_origen?: CanalCliente;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  es_broker?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activo?: boolean;

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

export class CreateClienteDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telefono?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Razón social para facturar por default',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  razon_social_default?: string;

  @ApiPropertyOptional({
    description:
      'RFC (12-13). Acepta también los genéricos del SAT: XAXX010101000 (público en general) y XEXX010101000 (extranjero). Se normaliza a MAYÚSCULAS.',
  })
  @IsOptional()
  @IsString()
  // El SAT solo acepta RFC en mayúsculas: se normaliza aquí para que el CFDI
  // no rebote por un rfc capturado en minúsculas.
  @Transform(aMayusculas)
  // Patrón SAT (moral 12 / física 13): cubre RFCs normales Y los genéricos
  // XAXX010101000 / XEXX010101000 (mismo regex que el receptor alterno 9.7).
  @Matches(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, { message: 'RFC inválido.' })
  rfc?: string;

  @ApiPropertyOptional({
    description:
      'Régimen fiscal SAT del receptor (c_RegimenFiscal, 3 dígitos; ej. 601, 612, 616).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'Régimen fiscal SAT de 3 dígitos.' })
  regimen_fiscal_receptor?: string;

  @ApiPropertyOptional({
    description: 'Uso CFDI default del cliente (c_UsoCFDI; ej. G03, S01).',
    maxLength: 4,
  })
  @IsOptional()
  @IsString()
  @Transform(aMayusculas)
  @MaxLength(4)
  uso_cfdi?: string;

  @ApiPropertyOptional({
    description: 'CP fiscal (DomicilioFiscalReceptor del CFDI, 5 dígitos).',
  })
  @IsOptional()
  @Matches(/^\d{5}$/, { message: 'CP de 5 dígitos.' })
  codigo_postal?: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Domicilio fiscal completo (de la constancia). El CFDI solo usa el CP; esto es referencia del equipo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  domicilio_fiscal?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'País de residencia (clientes extranjeros, RFC XEXX010101000).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  pais_residencia?: string;

  @ApiPropertyOptional({ enum: CanalCliente })
  @IsOptional()
  @IsEnum(CanalCliente)
  canal_origen?: CanalCliente;

  @ApiPropertyOptional({
    default: false,
    description: 'True = aplica tarifa broker',
  })
  @IsOptional()
  @IsBoolean()
  es_broker?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateClienteDto extends PartialType(CreateClienteDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

/** Tarifa preferencial pactada con el cliente para una aeronave. */
export class TarifaClienteAeronaveDto {
  @ApiProperty({ description: 'Aeronave a la que aplica la tarifa' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({
    description:
      'Tarifa por hora en USD pactada con el cliente (puede ser mayor o menor que la default del avión)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  tarifa_hora_usd!: number;
}

export class SetTarifasClienteDto {
  @ApiProperty({
    type: [TarifaClienteAeronaveDto],
    description:
      'Set COMPLETO de tarifas preferenciales del cliente: reemplaza las existentes (las aeronaves que no vengan pierden su tarifa y vuelven a la default).',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TarifaClienteAeronaveDto)
  tarifas!: TarifaClienteAeronaveDto[];
}
