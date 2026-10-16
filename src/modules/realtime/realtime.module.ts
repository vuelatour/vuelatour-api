import { Module } from '@nestjs/common';
// Inicio oficial (invariante 86, 0.0.85): la campana no lista avisos
// anteriores. ConfiguracionModule no importa RealtimeModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { DevicesController } from './devices.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [ConfiguracionModule],
  controllers: [NotificationsController, DevicesController],
  providers: [RealtimeGateway, NotificationsService, PushService],
  exports: [RealtimeGateway, NotificationsService, PushService],
})
export class RealtimeModule {}
