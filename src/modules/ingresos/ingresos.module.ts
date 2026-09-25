import { Module } from '@nestjs/common';
import { ConciliacionModule } from '../conciliacion/conciliacion.module';
import { FlightsModule } from '../flights/flights.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { IngresosController } from './ingresos.controller';
import { IngresosService } from './ingresos.service';

/**
 * INGRESOS (24-sep-2026): otros ingresos, anticipos de clientes y la vista
 * de todo el dinero que entra. FlightsModule aporta el ÚNICO camino de alta
 * y baja de cobros (`createCobro`/`deleteCobro`) y el cobrado por
 * `cobrosEnUsd` (`cobroStatus`); ConciliacionModule, la liga abono ↔ ingreso
 * y el camino inverso. Ninguno de ellos importa este módulo (sin ciclos).
 */
@Module({
  imports: [
    FlightsModule,
    ConciliacionModule,
    TipoCambioModule,
    PyservicesModule,
  ],
  controllers: [IngresosController],
  providers: [IngresosService],
  exports: [IngresosService],
})
export class IngresosModule {}
