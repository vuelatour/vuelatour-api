import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoutesModule } from '../routes/routes.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { QuotesPdfService } from './quotes-pdf.service';

@Module({
  imports: [
    AircraftModule,
    AirportsModule,
    RoutesModule,
    CalendarModule,
    NotificationsModule,
    RealtimeModule,
  ],
  controllers: [QuotesController],
  providers: [QuotesService, QuotesPdfService],
  exports: [QuotesService],
})
export class QuotesModule {}
