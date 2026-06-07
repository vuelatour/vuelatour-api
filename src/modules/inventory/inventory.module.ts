import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';

@Module({
  imports: [PyservicesModule],
  controllers: [InventoryController],
  providers: [InventoryService, ComprasService],
  exports: [InventoryService],
})
export class InventoryModule {}
