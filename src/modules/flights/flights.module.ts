import { Module } from '@nestjs/common';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
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
    AirportsModule,
    CalendarModule,
    ConfiguracionModule,
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
