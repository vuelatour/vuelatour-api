import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ProfitSharingModule } from '../profit-sharing/profit-sharing.module';
import { FacturacionClient } from './facturacion.client';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [PyservicesModule, ProfitSharingModule],
  controllers: [InvoicesController],
  providers: [FacturacionClient, InvoicesService],
  exports: [InvoicesService],
})
export class FacturacionModule {}
