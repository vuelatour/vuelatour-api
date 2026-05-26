import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, ComprasService],
  exports: [InventoryService],
})
export class InventoryModule {}
