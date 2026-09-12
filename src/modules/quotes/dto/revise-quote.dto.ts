import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CalculateQuoteDto } from './calculate-quote.dto';

export class ReviseQuoteDto extends CalculateQuoteDto {
  // Tope 1000 (8-sep-2026, D1 del rediseño): el panel arma el motivo como
  // resumen automático del diff + chip humano + texto libre; 500 se quedaba
  // corto. Columna `text`, sin migración.
  @ApiProperty({
    description:
      'Razón de la revisión (chip humano + texto libre; el panel antepone el resumen automático del cambio).',
    example: 'Cliente pidió · pax 4→6 · +Handler $1,500',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  motivo!: string;

  /**
   * Idempotencia (8-sep-2026): llave única por intento de "Guardar". Si ya
   * existe una versión con esa llave (`cotizacion_version_history.
   * client_request_id`, índice único parcial), se devuelve la cotización
   * vigente SIN crear otra versión (200).
   */
  @ApiPropertyOptional({
    description:
      'Llave de idempotencia (uuid) por intento de guardar: repetirla devuelve la cotización vigente (200) sin crear otra versión.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  /**
   * CAMBIO DE AVIÓN DESDE EL COTIZADOR (11-sep-2026, invariante 14 + 9): si
   * la revisión cambia `aeronave_id`, el avión nuevo pasa por el MISMO
   * pre-check de `assign` (squawk ALTA). Con esta bandera la asignación
   * procede A SABIENDAS y se avisa al mecánico, igual que en
   * assign/reassign. No aplica cuando el cotizador no cambió de avión.
   * El TALLER ya no bloquea: solo agrega su aviso a `avisos[]`.
   */
  @ApiPropertyOptional({
    description:
      'Aceptar discrepancia(s) de severidad ALTA del avión NUEVO al cambiarlo ' +
      'desde el cotizador: sin ella, el cambio rechaza con 409 ' +
      'SQUAWK_ALTA_SIN_RESOLVER (details.discrepancias); al aceptar se avisa ' +
      'al mecánico. Un avión EN TALLER ya NO bloquea (11-sep-2026: las ' +
      'cotizaciones son a futuro): se guarda y la respuesta trae el aviso en ' +
      'avisos[] para pintarlo en ámbar.',
  })
  @IsOptional()
  @IsBoolean()
  aceptar_discrepancia_alta?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({ description: 'Fecha de traslado inicial / salida' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_vuelo?: Date;

  @ApiPropertyOptional({ description: 'Fecha de traslado final / regreso' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fecha_traslado_final?: Date;

  // ---- Vuelo cubierto por operador externo (regla 28-ago): al revisar se
  // editan aquí mismo el operador y lo que cobra el avión externo (costo,
  // interno — distinto del precio pactado con el cliente). Solo aplican si
  // el vuelo ya es externo; en un vuelo propio se ignoran.
  @ApiPropertyOptional({
    description: 'Operador externo que cubre el vuelo (solo vuelos externos).',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  operador_externo?: string;

  @ApiPropertyOptional({
    description:
      'Lo que cobra el avión/operador externo, en SU moneda (nombre legado; ' +
      'ver costo_externo_moneda). null o 0 = limpiar el costo (las 4 ' +
      'columnas). El server DERIVA vuelo.costo_externo_usd.',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_usd?: number | null;

  @ApiPropertyOptional({
    description:
      'Alias preferido de costo_externo_usd: el monto en su moneda; null o ' +
      '0 = limpiar. Este gana si vienen ambos.',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costo_externo_monto?: number | null;

  @ApiPropertyOptional({
    enum: ['USD', 'MXN'],
    description:
      'Moneda del costo del externo (default USD). MXN exige TC: el ' +
      'tc_usd_mxn de la revisión o el ya persistido en el vuelo.',
  })
  @IsOptional()
  @IsIn(['USD', 'MXN'])
  costo_externo_moneda?: 'USD' | 'MXN';

  @ApiPropertyOptional({
    type: [String],
    description:
      'Nombres de los pasajeros (manifiesto, para tramitar permisos).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  pasajeros_nombres?: string[];
}
