import { Module } from '@nestjs/common';
import { InventoryItemsController } from './inventory-items.controller';
import { InventoryItemsService } from './inventory-items.service';
import { InventoryMovementsController } from './inventory-movements.controller';
import { InventoryMovementsService } from './inventory-movements.service';

@Module({
  controllers: [InventoryItemsController, InventoryMovementsController],
  providers: [InventoryItemsService, InventoryMovementsService],
  exports: [InventoryItemsService, InventoryMovementsService],
})
export class InventoryModule {}
