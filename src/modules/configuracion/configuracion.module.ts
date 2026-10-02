import { Module, forwardRef } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ConfiguracionController } from './configuracion.controller';
import { ConfiguracionService } from './configuracion.service';

@Module({
  // PyservicesModule (2-oct-2026): `GET /v1/config/ia-modelo` pregunta a
  // pyservices su modelo default. Ciclo de MÓDULOS con forwardRef en los dos
  // lados: PyservicesService lee el modelo configurado de este módulo para
  // el header `X-IA-Modelo`. Entre PROVIDERS no hay ciclo
  // (ConfiguracionService no depende de PyservicesService).
  imports: [forwardRef(() => PyservicesModule)],
  controllers: [ConfiguracionController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService],
})
export class ConfiguracionModule {}
