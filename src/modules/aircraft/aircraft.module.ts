import { Module } from '@nestjs/common';
import { AircraftController } from './aircraft.controller';
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftService } from './aircraft.service';
import { ExpirationsModule } from '../expirations/expirations.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
// Hoja "inventario" del Balance general (tiendita, 30-ago): el resumen por
// ítem lo calcula InventoryService (FIFO fuente única). Sin ciclo:
// InventoryModule solo importa PyservicesModule.
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    ExpirationsModule,
    PyservicesModule,
    TipoCambioModule,
    InventoryModule,
  ],
  controllers: [AircraftController],
  providers: [AircraftService, AircraftBalanceService],
  exports: [AircraftService],
})
export class AircraftModule {}
