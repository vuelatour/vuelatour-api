import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoutesModule } from '../routes/routes.module';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({
  imports: [AircraftModule, AirportsModule, RoutesModule, CalendarModule, NotificationsModule],
  controllers: [QuotesController],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
