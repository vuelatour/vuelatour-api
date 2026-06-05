import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ExpirationsModule } from '../expirations/expirations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

@Module({
  imports: [
    CalendarModule,
    ExpirationsModule,
    NotificationsModule,
    RealtimeModule,
    VisionModule,
  ],
  controllers: [FlightsController],
  providers: [FlightsService],
  exports: [FlightsService],
})
export class FlightsModule {}
