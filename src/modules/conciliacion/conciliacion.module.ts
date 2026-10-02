import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
// Modelo de IA configurado (2-oct-2026). ConfiguracionModule no importa
// ConciliacionModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

@Module({
  imports: [PyservicesModule, ConfiguracionModule],
  controllers: [ConciliacionController],
  providers: [ConciliacionService],
  exports: [ConciliacionService],
})
export class ConciliacionModule {}
