import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ComprasController } from './compras.controller';
import { ComprasService } from './compras.service';

/** Compras de refacciones: reutiliza InventoryService (ENTRADAS del cardex). */
@Module({
  imports: [InventoryModule],
  controllers: [ComprasController],
  providers: [ComprasService],
  exports: [ComprasService],
})
export class ComprasModule {}
