import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  controllers: [NotificationsController],
  providers: [RealtimeGateway, NotificationsService],
  exports: [RealtimeGateway, NotificationsService],
})
export class RealtimeModule {}
