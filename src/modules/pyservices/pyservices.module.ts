import { Module, forwardRef } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { PyservicesService } from './pyservices.service';

@Module({
  // ConfiguracionModule (2-oct-2026): modelo de IA configurado ⇒ header
  // `X-IA-Modelo`. forwardRef: ConfiguracionModule importa este módulo para
  // `GET /v1/config/ia-modelo` (default del servidor).
  imports: [forwardRef(() => ConfiguracionModule)],
  providers: [PyservicesService],
  exports: [PyservicesService],
})
export class PyservicesModule {}
