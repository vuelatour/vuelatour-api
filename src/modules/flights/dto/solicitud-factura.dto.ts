import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIMITE_NOTA_SOLICITUD } from '../factura-solicitud.util';

/**
 * `POST /v1/flights/:id/solicitud-factura` — «Necesito factura» (pedido de
 * Itzi, 24-sep-2026). IDEMPOTENTE: la primera vez registra quién y cuándo y
 * avisa a facturación; las siguientes solo actualizan la nota y/o «paga
 * contra factura» que vengan (lo omitido se conserva, sin re-avisar).
 */
export class SolicitarFacturaDto {
  @ApiPropertyOptional({
    maxLength: LIMITE_NOTA_SOLICITUD,
    nullable: true,
    description:
      'Nota para facturación (≤ 500). Se recorta; "" o null la BORRA. Omitida = se conserva la que había.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(LIMITE_NOTA_SOLICITUD)
  nota?: string | null;

  @ApiPropertyOptional({
    description:
      'El cliente paga hasta recibir la factura (prioridad en «Por facturar»). Default false en la primera solicitud.',
  })
  @IsOptional()
  @IsBoolean()
  paga_contra_factura?: boolean;

  @ApiPropertyOptional({
    description:
      'Vuelo hijo de un GRUPO multi-avión: aplica la MISMA solicitud a todos los hijos NO cancelados del grupo con UNA sola notificación. Sin grupo se ignora.',
  })
  @IsOptional()
  @IsBoolean()
  todo_el_grupo?: boolean;
}
