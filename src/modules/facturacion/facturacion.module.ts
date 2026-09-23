import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ProfitSharingModule } from '../profit-sharing/profit-sharing.module';
import { FlightsModule } from '../flights/flights.module';
import { FacturacionClient } from './facturacion.client';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  // FlightsModule exporta FacturaClienteService: al timbrar un CFDI el vuelo
  // pasa a `factura_estatus = FACTURADO` por la MISMA fuente que usa el panel
  // (22-sep-2026). FlightsModule no importa FacturacionModule: sin ciclo.
  imports: [PyservicesModule, ProfitSharingModule, FlightsModule],
  controllers: [InvoicesController],
  providers: [FacturacionClient, InvoicesService],
  exports: [InvoicesService],
})
export class FacturacionModule {}
