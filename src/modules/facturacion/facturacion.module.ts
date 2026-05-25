import { Module } from '@nestjs/common';
import { FacturacionClient } from './facturacion.client';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  controllers: [InvoicesController],
  providers: [FacturacionClient, InvoicesService],
  exports: [InvoicesService],
})
export class FacturacionModule {}
