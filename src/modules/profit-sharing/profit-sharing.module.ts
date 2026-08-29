import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingController } from './profit-sharing.controller';
import { ProfitSharingService } from './profit-sharing.service';

@Module({
  // TipoCambioModule: TC oficial de referencia (open.er-api / BCE) para
  // cotizaciones y gastos MXN sin TC capturado (regla del cliente 29-ago-2026).
  imports: [PyservicesModule, TipoCambioModule],
  controllers: [ProfitSharingController],
  providers: [ProfitSharingService, DineroReportService],
  exports: [ProfitSharingService],
})
export class ProfitSharingModule {}
