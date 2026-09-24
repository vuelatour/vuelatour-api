import { Module, forwardRef } from '@nestjs/common';
import { AirportsModule } from '../airports/airports.module';
import { AlertsModule } from '../alerts/alerts.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ExpirationsModule } from '../expirations/expirations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PilotsModule } from '../pilots/pilots.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { CobroReciboService } from './cobro-recibo.service';
import { FacturaClienteService } from './factura-cliente.service';
import { FacturaSolicitudService } from './factura-solicitud.service';
import { FlightReportService } from './flight-report.service';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

@Module({
  imports: [
    AirportsModule,
    // Programa de servicio por horas al capturar un tacómetro (20-sep-2026).
    // forwardRef por higiene: AlertsModule no importa FlightsModule hoy, pero
    // la dependencia es un efecto secundario y no debe amarrar el arranque.
    forwardRef(() => AlertsModule),
    CalendarModule,
    ConfiguracionModule,
    ExpirationsModule,
    NotificationsModule,
    // Piloto externo por nombre desde la reserva (9-sep-2026): sin ciclo,
    // PilotsModule no importa flights.
    PilotsModule,
    PyservicesModule,
    RealtimeModule,
    VisionModule,
  ],
  controllers: [FlightsController],
  providers: [
    FlightsService,
    FlightReportService,
    CobroReciboService,
    FacturaClienteService,
    FacturaSolicitudService,
  ],
  // CobroReciboService: GroupsModule lo usa para el recibo del SOBRE de grupo.
  // FacturaClienteService: FacturacionModule lo usa para marcar FACTURADO el
  // vuelo al timbrar su CFDI (22-sep-2026).
  // FacturaSolicitudService (24-sep-2026): «Necesito factura» + bloques
  // `factura_servicio`; lo usan QuotesService (lista) y FacturasEmitidasModule.
  exports: [
    FlightsService,
    CobroReciboService,
    FacturaClienteService,
    FacturaSolicitudService,
  ],
})
export class FlightsModule {}
