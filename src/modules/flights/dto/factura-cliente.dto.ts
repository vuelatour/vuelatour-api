import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ESTATUS_FACTURA_CLIENTE,
  LIMITE_FOLIO_FACTURA,
  type EstatusFacturaCliente,
} from '../factura-cliente.util';

/**
 * `PATCH :id/factura-cliente`. Desde el 24-sep-2026 lleva el `estatus`, el
 * `folio` o los dos (al menos uno — si no, 400): el folio se captura o se
 * corrige SIN subir archivo, y sirve también para los vuelos que ya se
 * marcaron «Facturado» sin papel. `folio: null` o `""` lo BORRA.
 */
export class SetFacturaClienteEstatusDto {
  @ApiPropertyOptional({
    enum: ESTATUS_FACTURA_CLIENTE,
    description:
      'Seguimiento MANUAL de la factura del servicio: SIN_FACTURA · ELABORADA_ENVIADA · FACTURADO. Con un CFDI timbrado (vuelo.facturado = true) no puede bajar de FACTURADO (409 VUELO_CON_CFDI).',
  })
  @IsOptional()
  @IsIn(ESTATUS_FACTURA_CLIENTE)
  estatus?: EstatusFacturaCliente;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: LIMITE_FOLIO_FACTURA,
    description:
      'Folio de la factura (p. ej. «A-1234»). Se guarda recortado y sin espacios de sobra; null o "" lo borra. 409 FACTURA_FOLIO_NO_DISPONIBLE si falta la migración 20260924000001.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(LIMITE_FOLIO_FACTURA)
  folio?: string | null;
}

/**
 * Cuerpo ALTERNO de `POST :id/factura-cliente/archivo` para clientes que no
 * mandan multipart (mismo patrón base64 que el resto del repo: foto del
 * gasto, XML de factura recibida, estado de cuenta). Con `multipart/form-data`
 * y el campo `file` estos campos no se usan — salvo `folio`, que viaja como
 * campo de texto del mismo formulario.
 */
export class SubirFacturaClienteDto {
  @ApiPropertyOptional({
    description:
      'Archivo en base64 (PDF o XML, ≤ 10 MB) cuando NO se manda multipart.',
  })
  @IsOptional()
  @IsString()
  file_base64?: string;

  @ApiPropertyOptional({
    description: 'Nombre ORIGINAL del archivo (el que verá la oficina).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;

  @ApiPropertyOptional({
    description:
      'Tipo MIME del archivo (opcional: la extensión del nombre manda).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  content_type?: string;

  @ApiPropertyOptional({
    maxLength: LIMITE_FOLIO_FACTURA,
    description:
      'Folio de la factura (opcional, 24-sep-2026). En multipart es un campo de texto más del formulario. Si el archivo es el XML del CFDI el API saca SERIE-FOLIO y el UUID solo; el folio TECLEADO gana sobre el extraído.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(LIMITE_FOLIO_FACTURA)
  folio?: string;
}
