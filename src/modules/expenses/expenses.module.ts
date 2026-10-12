import { Module, forwardRef } from '@nestjs/common';
import { CajaChicaModule } from '../caja-chica/caja-chica.module';
// Refacción a Inventario/Tienda desde el alta de gasto (12-oct-2026,
// invariante 57): compra → recibir → precio → salida. Ninguno de los dos
// importa ExpensesModule: sin ciclo.
import { ComprasModule } from '../compras/compras.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ConciliacionModule } from '../conciliacion/conciliacion.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { FolioRelecturaService } from './folio-relectura.service';

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
  controllers: [ExpensesController],
  // FolioRelecturaService (6-oct-2026): cron `gastos-releer-folio`.
  providers: [ExpensesService, CombustibleMasivoService, FolioRelecturaService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
