import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ExpirationsModule } from '../expirations/expirations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

@Module({
  imports: [
    CalendarModule,
    ExpirationsModule,
    NotificationsModule,
    PyservicesModule,
    RealtimeModule,
    VisionModule,
  ],
  controllers: [FlightsController],
  providers: [FlightsService, FlightReportService],
  exports: [FlightsService],
})
export class FlightsModule {}
