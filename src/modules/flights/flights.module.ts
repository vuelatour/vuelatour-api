import { Module } from '@nestjs/common';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ExpirationsModule } from '../expirations/expirations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { CobroReciboService } from './cobro-recibo.service';
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
  providers: [FlightsService, FlightReportService, CobroReciboService],
  // CobroReciboService: GroupsModule lo usa para el recibo del SOBRE de grupo.
  exports: [FlightsService, CobroReciboService],
})
export class FlightsModule {}
