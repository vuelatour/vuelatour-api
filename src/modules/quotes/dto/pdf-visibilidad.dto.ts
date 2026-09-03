import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, Matches } from 'class-validator';

/**
 * Body de `PATCH :id/escalas/:escalaId/pdf-visibilidad`: PRESENTACIÓN PDF
 * del tramo — `escala.pdf_oculto` (ojito) y/o `escala.pdf_fecha` (fecha
 * SOLO para el PDF del cliente, 3-sep-2026). Ambas son presentación pura:
 * el precio no cambia, no se versiona y el snapshot NO se toca — el PDF lee
 * la escala viva. Bug 1-sep: el switch ya no depende de que un guardado del
 * cotizador arrastre la bandera. Patch PARCIAL: la clave que no viaja no se
 * toca; el service exige al menos una (400 si el body viene vacío).
 */
export class PdfVisibilidadDto {
  @ApiPropertyOptional({
    description:
      'true = ocultar el tramo del PDF del cliente (título/itinerario/mapa); false = volverlo a mostrar. Omitido = no tocar.',
  })
  @IsOptional()
  @IsBoolean()
  oculto?: boolean;

  /**
   * Fecha de PARED (YYYY-MM-DD, sin hora ni zona) que se imprime para el
   * tramo en el PDF del cliente. NO afecta la ruta operativa
   * (`fecha_salida_plan`) ni las fechas del vuelo; el PDF la ignora si el
   * tramo está oculto. `null` = quitar la fecha; omitido = no tocar.
   * Tipado `string | null` a propósito: con `enableImplicitConversion` un
   * tipo `string` a secas convertiría el null a texto.
   */
  @ApiPropertyOptional({
    example: '2026-09-05',
    nullable: true,
    description:
      'Fecha (YYYY-MM-DD, sin hora) SOLO para el PDF del cliente. null = quitar la fecha; omitido = no tocar. No cambia la ruta operativa ni las fechas de vuelo.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'pdf_fecha debe ser YYYY-MM-DD',
  })
  @IsISO8601({ strict: true }, { message: 'pdf_fecha inválida (YYYY-MM-DD)' })
  pdf_fecha?: string | null;
}
