import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import {
  GastosQuery,
  HorasPilotoQuery,
  OperativoQuery,
  OverviewQuery,
  TarjetasQuery,
} from './dto/dashboards.dto';
import { DashboardsService } from './dashboards.service';

@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller({ path: 'dashboards', version: '1' })
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get('overview')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Executive overview: financials, operations pipeline, top clients',
  })
  overview(@Query() q: OverviewQuery) {
    return this.dashboards.overview(q);
  }

  @Get('operativo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Operations dashboard: daily requests, pending quotes, conversion rate, weekly flights',
  })
  operativo(@Query() q: OperativoQuery) {
    return this.dashboards.operativo(q);
  }

  @Get('gastos')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Expenses dashboard: expense per aircraft and period, cost/hour and profit/hour',
  })
  gastos(@Query() q: GastosQuery) {
    return this.dashboards.gastos(q);
  }

  @Get('tarjetas')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Corporate card spend dashboard: live spend by card, by person and by category',
  })
  tarjetas(@Query() q: TarjetasQuery) {
    return this.dashboards.tarjetas(q);
  }

  @Get('horas-piloto')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Pilot hours dashboard: hours per pilot for the period and current month, 90 hrs/month informative limit',
  })
  horasPiloto(@Query() q: HorasPilotoQuery) {
    return this.dashboards.horasPiloto(q);
  }
}
