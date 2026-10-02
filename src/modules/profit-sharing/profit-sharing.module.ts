import { Module } from '@nestjs/common';
import { ConciliacionModule } from '../conciliacion/conciliacion.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingController } from './profit-sharing.controller';
import { ProfitSharingService } from './profit-sharing.service';
import { RepartoCuentaService } from './reparto-cuenta.service';
import { RepartoPagoService } from './reparto-pago.service';

@Module({
  // TipoCambioModule: TC oficial de referencia (open.er-api / BCE) para
  // cotizaciones y gastos MXN sin TC capturado (regla del cliente 29-ago-2026).
  // ConciliacionModule (9-sep-2026): "cobros bancarios sin conciliar" del
  // pre-cierre sale de la MISMA lectura que GET /conciliacion/cobros-sin-banco.
  imports: [PyservicesModule, TipoCambioModule, ConciliacionModule],
  controllers: [ProfitSharingController],
  // Cuenta corriente del socio (v2, 2-oct-2026): RepartoCuentaService
  // inyecta ProfitSharingService (utilidades por mes = compute memoizado) y
  // RepartoPagoService inyecta RepartoCuentaService. El pre-cierre NO los
  // inyecta — comparte solo la sonda/lectura de `reparto-cuenta.lector.ts`.
  providers: [
    ProfitSharingService,
    DineroReportService,
    RepartoCuentaService,
    RepartoPagoService,
  ],
  exports: [ProfitSharingService],
})
export class ProfitSharingModule {}
