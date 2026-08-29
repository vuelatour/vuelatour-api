import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { fechaIsoValida, TipoCambioService } from './tipo-cambio.service';

@ApiTags('Tipo de cambio')
@ApiBearerAuth()
@Controller({ path: 'tipo-cambio', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
export class TipoCambioController {
  constructor(private readonly tipoCambio: TipoCambioService) {}

  @Get('oficial')
  @ApiOperation({
    summary:
      'TC oficial de referencia USD→MXN vigente para una fecha YYYY-MM-DD (default hoy Cancún). Fuente diaria open.er-api.com; fechas pasadas sin registro: referencia BCE (frankfurter).',
  })
  async oficial(@Query('fecha') fecha?: string) {
    const dia =
      fecha ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
    // Forma Y calendario real (2026-13-01 pasa el regex; verificación 28-ago).
    if (!fechaIsoValida(dia)) {
      throw new BadRequestException('fecha debe ser YYYY-MM-DD válida');
    }
    const d = await this.tipoCambio.oficialDetallePara(dia);
    return {
      fecha: dia,
      tc: d?.tc ?? null,
      fuente: d?.fuente ?? null,
      // Día real del dato (fin de semana → último publicado antes).
      fecha_dato: d?.fecha_dato ?? null,
    };
  }
}
