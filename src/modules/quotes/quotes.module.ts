import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FlightsModule } from '../flights/flights.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoutesModule } from '../routes/routes.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuotesPdfService } from './quotes-pdf.service';
import { QuotesPdfInternoService } from './quotes-pdf-interno.service';

@Module({
  imports: [
    AircraftModule,
    AirportsModule,
    RoutesModule,
    CalendarModule,
    NotificationsModule,
    RealtimeModule,
    // PDF «Cotización interna» (8-sep): cobros con sobre/conciliado desde
    // FlightsService.listCobros (fuente única) y render vía PyservicesService.
    FlightsModule,
    PyservicesModule,
  ],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesPdfService, QuotesPdfInternoService],
  exports: [QuotesService],
})
export class QuotesModule {}
