import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { FlightsModule } from '../flights/flights.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { QuotesModule } from '../quotes/quotes.module';
import { GroupsController } from './groups.controller';
import { GroupsPdfService } from './groups-pdf.service';
import { GroupsService } from './groups.service';

/**
 * Cotización de GRUPO (4-sep-2026, Enfoque A): cabecera comercial
 * `vuelo_grupo` + N vuelos hijos (uno por avión). Orquesta lo que ya
 * existe por vuelo (QuotesService / FlightsService); no calcula dinero
 * propio.
 */
@Module({
  imports: [QuotesModule, FlightsModule, CalendarModule, PyservicesModule],
  controllers: [GroupsController],
  providers: [GroupsService, GroupsPdfService],
  exports: [GroupsService],
})
export class GroupsModule {}
