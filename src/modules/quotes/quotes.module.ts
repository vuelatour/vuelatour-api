import { Module, forwardRef } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { AirportsModule } from '../airports/airports.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { CONFIRMADOR_COTIZACION } from '../flights/confirmar-vuelo.util';
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
    // Editores de cotizaciones cobradas (26-sep-2026): la lista
    // `editores_cotizacion_cobrada` decide quién revisa con cobros.
    ConfiguracionModule,
    NotificationsModule,
    RealtimeModule,
    // PDF «Cotización interna» (8-sep): cobros con sobre/conciliado desde
    // FlightsService.listCobros (fuente única) y render vía PyservicesService.
    // forwardRef desde el 16-oct-2026: FlightsModule importa este módulo
    // para confirmar un COTIZADO desde el detalle (CONFIRMADOR_COTIZACION).
    forwardRef(() => FlightsModule),
    PyservicesModule,
  ],
  controllers: [QuotesController],
  providers: [
    QuotesService,
    QuotesPdfService,
    QuotesPdfInternoService,
    // Confirmar desde el detalle del vuelo (16-oct-2026, invariante 85):
    // FlightsService recibe `QuotesService.confirm` por este token (sin
    // importar la clase, para no crear el ciclo flights ↔ quotes en runtime).
    { provide: CONFIRMADOR_COTIZACION, useExisting: QuotesService },
  ],
  exports: [QuotesService, CONFIRMADOR_COTIZACION],
})
export class QuotesModule {}
