import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { OverviewQuery } from './dto/dashboards.dto';
import { DashboardsService } from './dashboards.service';

@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller({ path: 'dashboards', version: '1' })
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get('overview')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Executive overview: financials, operations pipeline, top clients',
  })
  overview(@Query() q: OverviewQuery) {
    return this.dashboards.overview(q);
  }
}
