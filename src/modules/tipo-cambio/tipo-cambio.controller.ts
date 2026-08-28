import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { TipoCambioService } from './tipo-cambio.service';

@ApiTags('Tipo de cambio')
@ApiBearerAuth()
@Controller({ path: 'tipo-cambio', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
export class TipoCambioController {
  constructor(private readonly tipoCambio: TipoCambioService) {}

  @Get('oficial')
  @ApiOperation({
    summary:
      'TC oficial USD→MXN (Banxico FIX / DOF) vigente para una fecha YYYY-MM-DD (default hoy Cancún).',
  })
  async oficial(@Query('fecha') fecha?: string) {
    const dia =
      fecha ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Cancun' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
      throw new BadRequestException('fecha debe ser YYYY-MM-DD');
    }
    const tc = await this.tipoCambio.oficialPara(dia);
    return { fecha: dia, tc, fuente: tc != null ? 'BANXICO_FIX' : null };
  }
}
