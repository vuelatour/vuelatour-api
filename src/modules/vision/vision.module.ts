import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
// Modelo de IA configurado (2-oct-2026) ⇒ header `X-IA-Modelo`.
// ConfiguracionModule no importa VisionModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { VisionController } from './vision.controller';
import { VisionService } from './vision.service';

@Module({
  // InventoryModule: categorías reales de bodega para la ficha por IA.
  imports: [InventoryModule, ConfiguracionModule],
  controllers: [VisionController],
  providers: [VisionService],
  exports: [VisionService],
})
export class VisionModule {}
