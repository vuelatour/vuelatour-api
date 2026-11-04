import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { CategoriaGasto, MedioPago, Moneda } from './expenses.dto';

/** Roles de «Agregar gasto a la compra»: todo menos la mercancía (esa es «Registrar gasto»). */
export const ROLES_OTRO_GASTO_COMPRA = ['ENVIO', 'IMPUESTOS', 'OTRO'] as const;
export type RolOtroGastoCompra = (typeof ROLES_OTRO_GASTO_COMPRA)[number];

// Forma YYYY-MM-DD + fecha REAL (strict: 2026-02-30 no pasa).
const FECHA_YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «Registrar gasto» de una compra (21-oct-2026, invariante 101):
 * `POST /v1/compras/:id/registrar-gasto`. El MONTO no viaja: es el total de
 * la factura de mercancía que calcula el API (líneas + cargos impresos en
 * ella), en la moneda de la compra. El T.C. es OBLIGATORIO en las dos
 * monedas y se valida en banda (15–25, `compra-gasto.util.ts`).
 */
export class RegistrarGastoCompraDto {
  @ApiProperty({
    description:
      'Tipo de cambio (MXN por USD) del pago. OBLIGATORIO en pesos y en dólares; fuera de 15–25 responde 400 TC_FUERA_DE_RANGO.',
    example: 18.25,
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 6 },
    { message: 'tc_usd_mxn debe ser un número (pesos por dólar)' },
  )
  @IsPositive({ message: 'tc_usd_mxn debe ser mayor a 0' })
  tc_usd_mxn!: number;

  @ApiProperty({
    example: '2026-10-21',
    description:
      'Fecha del pago (día Cancún). Una fecha futura queda «por pagar».',
  })
  @Matches(FECHA_YMD, { message: 'fecha_gasto debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha_gasto inválida (YYYY-MM-DD)' })
  fecha_gasto!: string;

  @ApiProperty({
    enum: MedioPago,
    description: 'Obligatorio (BODEGA no existe aquí: es un pago real).',
  })
  @IsEnum(MedioPago, { message: 'medio_pago inválido' })
  medio_pago!: MedioPago;

  @ApiPropertyOptional({
    description: 'Solo con TARJETA_CORP; vacío = la asignada a quien registra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({
    description:
      'Cuenta de donde salió el pago (invariante 98): solo se guarda con TRANSFERENCIA, DOMICILIADO o PAYWISE.',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({ description: 'Default: el proveedor de la compra.' })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Folio / factura del proveedor (candado anti-duplicados del gasto: repetido ⇒ 409).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio_ticket?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Comprobante ya subido al bucket `gasto-fotos` (path). Con él, el gasto nace «Con comprobante» (4-nov-2026).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foto_url?: string;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia del alta (uuid): un reintento con la misma llave no duplica el gasto.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}

/**
 * «Agregar gasto a la compra» (4-nov-2026): `POST /v1/compras/:id/gastos`.
 * Un pago APARTE de la factura de mercancía (envío de UPS en pesos, aduana,
 * otro cargo) que nace como gasto REAL en Gastos —con su moneda, su medio,
 * su comprobante y su cruce con el banco— ligado a la compra con su rol. El
 * monto SÍ viaja (es otra factura); el T.C. es obligatorio como en
 * «Registrar gasto» (misma banda 15–25): con él el cargo se prorratea al
 * costo de las refacciones aunque la compra esté en la otra moneda.
 */
export class AgregarGastoCompraDto {
  @ApiProperty({
    enum: ROLES_OTRO_GASTO_COMPRA,
    description:
      'Qué pagó este gasto dentro de la compra. MERCANCIA no se acepta aquí (400 COMPRA_GASTO_ROL_MERCANCIA): esa es «Registrar gasto».',
  })
  @IsIn(ROLES_OTRO_GASTO_COMPRA, {
    message: 'rol debe ser ENVIO, IMPUESTOS u OTRO',
  })
  rol!: RolOtroGastoCompra;

  @ApiProperty({ description: 'Monto pagado, en `moneda` (> 0).' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'monto debe ser un número con hasta 2 decimales' },
  )
  @IsPositive({ message: 'monto debe ser mayor a 0' })
  monto!: number;

  @ApiProperty({
    enum: Moneda,
    description: 'Moneda del pago (la de SU factura).',
  })
  @IsEnum(Moneda, { message: 'moneda inválida' })
  moneda!: Moneda;

  @ApiProperty({
    description:
      'Tipo de cambio (MXN por USD) del pago. OBLIGATORIO; fuera de 15–25 responde 400 TC_FUERA_DE_RANGO.',
    example: 18.25,
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 6 },
    { message: 'tc_usd_mxn debe ser un número (pesos por dólar)' },
  )
  @IsPositive({ message: 'tc_usd_mxn debe ser mayor a 0' })
  tc_usd_mxn!: number;

  @ApiProperty({
    example: '2026-11-04',
    description:
      'Fecha del pago (día Cancún). Una fecha futura queda «por pagar».',
  })
  @Matches(FECHA_YMD, { message: 'fecha_gasto debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true }, { message: 'fecha_gasto inválida (YYYY-MM-DD)' })
  fecha_gasto!: string;

  @ApiProperty({
    enum: MedioPago,
    description: 'Obligatorio (es un pago real).',
  })
  @IsEnum(MedioPago, { message: 'medio_pago inválido' })
  medio_pago!: MedioPago;

  @ApiPropertyOptional({
    description: 'Solo con TARJETA_CORP; vacío = la asignada a quien registra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({
    description:
      'Cuenta de donde salió el pago (invariante 98): solo se guarda con TRANSFERENCIA, DOMICILIADO o PAYWISE.',
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional({
    enum: CategoriaGasto,
    description:
      'Default por rol: ENVIO ⇒ PAQUETERIA, IMPUESTOS ⇒ OTRO, OTRO ⇒ OTRO. Una categoría que no se liga a compras ⇒ 400 COMPRA_GASTO_CATEGORIA_NO_LIGABLE.',
  })
  @IsOptional()
  @IsEnum(CategoriaGasto, { message: 'categoria inválida' })
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({
    description:
      'Proveedor de ESTE pago (UPS, el agente aduanal…). Sin default: el de la compra es el de las refacciones.',
  })
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Folio / factura del proveedor (candado anti-duplicados del gasto: repetido ⇒ 409).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio_ticket?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Comprobante ya subido al bucket `gasto-fotos` (path). Con él, el gasto nace «Con comprobante».',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foto_url?: string;

  @ApiPropertyOptional({
    description:
      'Llave de idempotencia del alta (uuid): un reintento con la misma llave no duplica el gasto.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;
}
