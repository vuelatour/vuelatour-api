import { Module } from '@nestjs/common';
// Modelo de IA configurado (2-oct-2026) ⇒ header `X-IA-Modelo` en la
// extracción. ConfiguracionModule no importa ExpirationsModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ExpirationsClient } from './expirations.client';
import { ExpirationsController } from './expirations.controller';
import { ExpirationsService } from './expirations.service';

@Module({
  imports: [ConfiguracionModule],
  controllers: [ExpirationsController],
  providers: [ExpirationsService, ExpirationsClient],
  exports: [ExpirationsService],
})
export class ExpirationsModule {}
