import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { VisionController } from './vision.controller';
import { VisionService } from './vision.service';

@Module({
  // InventoryModule: categorías reales de bodega para la ficha por IA.
  imports: [InventoryModule],
  controllers: [VisionController],
  providers: [VisionService],
  exports: [VisionService],
})
export class VisionModule {}
