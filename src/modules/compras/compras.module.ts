import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ComprasController } from './compras.controller';
import { ComprasService } from './compras.service';

/** Compras de refacciones: reutiliza InventoryService (ENTRADAS del cardex). */
@Module({
  // ConfiguracionModule: inicio oficial en la lista (invariante 86, 0.0.85).
  imports: [InventoryModule, ConfiguracionModule],
  controllers: [ComprasController],
  providers: [ComprasService],
  exports: [ComprasService],
})
export class ComprasModule {}
