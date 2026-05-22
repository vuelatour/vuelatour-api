import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  controllers: [NotificationsController, DevicesController],
  providers: [RealtimeGateway, NotificationsService, PushService],
  exports: [RealtimeGateway, NotificationsService, PushService],
})
export class RealtimeModule {}
