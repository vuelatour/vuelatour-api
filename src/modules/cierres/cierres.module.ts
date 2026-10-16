import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ProfitSharingModule } from '../profit-sharing/profit-sharing.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CierresController } from './cierres.controller';
import { CierresService } from './cierres.service';

/**
 * CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89). Importa el reparto
 * (compute + pre-cierre + memoria de utilidades), las notificaciones y la
 * configuración (inicio oficial). Nadie importa este módulo: el CANDADO
 * `MES_CERRADO` vive como función en `common/cierre-mes.lector` (sin ciclos).
 */
@Module({
  imports: [ProfitSharingModule, RealtimeModule, ConfiguracionModule],
  controllers: [CierresController],
  providers: [CierresService],
})
export class CierresModule {}
