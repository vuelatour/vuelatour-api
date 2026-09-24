import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { FlightsModule } from '../flights/flights.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FacturasEmitidasController } from './facturas-emitidas.controller';
import { FacturasEmitidasService } from './facturas-emitidas.service';

/**
 * FACTURAS EMITIDAS (registro manual de lo que factura la oficina) +
 * «Por facturar» (24-sep-2026). La facturación AUTOMÁTICA del PAC vive en
 * `FacturacionModule` y no se toca. FlightsModule aporta la fuente única del
 * cobro (`FlightsService.cobroStatus`) y la solicitud (`FacturaSolicitudService`).
 */
@Module({
  imports: [
    FlightsModule,
    PyservicesModule,
    RealtimeModule,
    ConfiguracionModule,
  ],
  controllers: [FacturasEmitidasController],
  providers: [FacturasEmitidasService],
  exports: [FacturasEmitidasService],
})
export class FacturasEmitidasModule {}
