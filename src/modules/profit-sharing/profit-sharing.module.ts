import { Module, forwardRef } from '@nestjs/common';
import { ConciliacionModule } from '../conciliacion/conciliacion.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { FlightsModule } from '../flights/flights.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { CobroUtilidadesService } from './cobro-utilidades.service';
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
  // ConfiguracionModule (6-oct-2026, API 0.0.65): vigencia de las comisiones
  // a cargo del avión (`comisiones_al_avion_desde`) en el reparto. No importa
  // este módulo: sin ciclo.
  imports: [
    PyservicesModule,
    TipoCambioModule,
    ConciliacionModule,
    ConfiguracionModule,
    // Cobro de un vuelo CON UTILIDADES DEL SOCIO (23-nov-2026, invariante
    // 143): `CobroUtilidadesService` llama a `FlightsService.createCobro`.
    // FlightsModule no importa este módulo (ni nada que lo importe): sin
    // ciclo; el forwardRef es higiene.
    forwardRef(() => FlightsModule),
  ],
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
    CobroUtilidadesService,
  ],
  exports: [ProfitSharingService],
})
export class ProfitSharingModule {}
