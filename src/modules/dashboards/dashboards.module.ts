import { Module } from '@nestjs/common';
import { ProfitSharingModule } from '../profit-sharing/profit-sharing.module';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';

@Module({
  imports: [ProfitSharingModule],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
