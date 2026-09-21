import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
// Aviso in-app a ADMIN cuando se elimina un movimiento de cardex
// (21-sep-2026). RealtimeModule no importa InventoryModule: sin ciclo.
import { RealtimeModule } from '../realtime/realtime.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';
import { InventarioMasivoService } from './inventario-masivo.service';

@Module({
  imports: [PyservicesModule, RealtimeModule],
  controllers: [InventoryController],
  providers: [InventoryService, ComprasService, InventarioMasivoService],
  exports: [InventoryService],
})
export class InventoryModule {}
