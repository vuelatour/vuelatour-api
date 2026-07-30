import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AirportsModule } from '../airports/airports.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [NotificationsModule, RealtimeModule, AircraftModule, AirportsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
