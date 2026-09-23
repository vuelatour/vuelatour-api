import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ESTATUS_FACTURA_CLIENTE,
  type EstatusFacturaCliente,
} from '../factura-cliente.util';

export class SetFacturaClienteEstatusDto {
  @ApiProperty({
    enum: ESTATUS_FACTURA_CLIENTE,
    description:
      'Seguimiento MANUAL de la factura del servicio: SIN_FACTURA · ELABORADA_ENVIADA · FACTURADO. Con un CFDI timbrado (vuelo.facturado = true) no puede bajar de FACTURADO (409 VUELO_CON_CFDI).',
  })
  @IsIn(ESTATUS_FACTURA_CLIENTE)
  estatus!: EstatusFacturaCliente;
}

/**
 * Cuerpo ALTERNO de `POST :id/factura-cliente/archivo` para clientes que no
 * mandan multipart (mismo patrón base64 que el resto del repo: foto del
 * gasto, XML de factura recibida, estado de cuenta). Con `multipart/form-data`
 * y el campo `file` estos campos no se usan.
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
}
