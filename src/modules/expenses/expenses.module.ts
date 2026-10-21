import { Module, forwardRef } from '@nestjs/common';
import { CajaChicaModule } from '../caja-chica/caja-chica.module';
// Refacción a Inventario/Tienda desde el alta de gasto (12-oct-2026,
// invariante 57; DEPRECADO desde el 21-oct-2026, el panel ya no lo manda) y
// «Registrar gasto» de una compra (21-oct-2026, invariante 101:
// `CompraGastoController` + `CompraGastoService`, ruta
// `POST /v1/compras/:id/registrar-gasto`). Ninguno de los dos importa
// ExpensesModule: sin ciclo — por eso ese endpoint vive AQUÍ.
import { ComprasModule } from '../compras/compras.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ConciliacionModule } from '../conciliacion/conciliacion.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { CompraGastoController } from './compra-gasto.controller';
import { CompraGastoService } from './compra-gasto.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { FolioRelecturaService } from './folio-relectura.service';
import { GastosPorPagarService } from './gastos-por-pagar.service';

@Module({
  imports: [
    RealtimeModule,
    PyservicesModule,
    VisionModule,
    ConfiguracionModule,
    CajaChicaModule,
    ComprasModule,
    InventoryModule,
    // Auto-cruce con el banco al capturar/editar un gasto bancario
    // (15-sep-2026). forwardRef por higiene: ConciliacionModule no importa
    // ExpensesModule hoy, pero la dependencia es un efecto secundario y no
    // debe amarrar el orden de arranque.
    forwardRef(() => ConciliacionModule),
  ],
  controllers: [ExpensesController, CompraGastoController],
  // FolioRelecturaService (6-oct-2026): cron `gastos-releer-folio`.
  // GastosPorPagarService (19-oct-2026, invariante 93): recordatorio diario
  // de gastos «por pagar» (09:00 Cancún).
  // CompraGastoService (21-oct-2026, invariante 101): el gasto de una compra.
  providers: [
    ExpensesService,
    CombustibleMasivoService,
    FolioRelecturaService,
    GastosPorPagarService,
    CompraGastoService,
  ],
  exports: [ExpensesService],
})
export class ExpensesModule {}
