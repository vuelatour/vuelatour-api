import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Body de `PATCH :id/escalas/:escalaId/pdf-visibilidad`: toggle directo de
 * `escala.pdf_oculto` (presentación pura del PDF; el precio no cambia y el
 * snapshot NO se toca — el PDF lee la escala viva). Bug 1-sep: el switch ya
 * no depende de que un guardado del cotizador arrastre la bandera.
 */
export class PdfVisibilidadDto {
  @ApiProperty({
    description:
      'true = ocultar el tramo del PDF del cliente (título/itinerario/mapa); false = volverlo a mostrar.',
  })
  @IsBoolean()
  oculto!: boolean;
}
