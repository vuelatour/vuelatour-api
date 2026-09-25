import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
// Aviso in-app a ADMIN cuando se elimina un movimiento de cardex
// (21-sep-2026). RealtimeModule no importa InventoryModule: sin ciclo.
import { RealtimeModule } from '../realtime/realtime.module';
// Margen de la tienda VuelaTour (`inventario_margen_venta_pct`, 25-sep-2026).
// ConfiguracionModule no importa InventoryModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
// T.C. oficial del día para compras/ventas de bodega (25-sep-2026, API
// 0.0.36): la MISMA fuente que el cotizador. TipoCambioModule no importa
// nada: sin ciclo.
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';
import { InventarioMasivoService } from './inventario-masivo.service';

@Module({
  imports: [
    PyservicesModule,
    RealtimeModule,
    ConfiguracionModule,
    TipoCambioModule,
  ],
  controllers: [InventoryController],
  providers: [InventoryService, ComprasService, InventarioMasivoService],
  exports: [InventoryService],
})
export class InventoryModule {}
