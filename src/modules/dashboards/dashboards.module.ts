import { Module } from '@nestjs/common';
import { ProfitSharingModule } from '../profit-sharing/profit-sharing.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';

@Module({
  imports: [ProfitSharingModule, PyservicesModule],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
