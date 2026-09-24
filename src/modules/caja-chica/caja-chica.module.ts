import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { CajaChicaController } from './caja-chica.controller';
import { CajaChicaService } from './caja-chica.service';

@Module({
  // PyservicesModule (24-sep-2026): Excel de la reposición vía el export
  // genérico `/pdf/tabla-xlsx`.
  imports: [PyservicesModule],
  controllers: [CajaChicaController],
  providers: [CajaChicaService],
  exports: [CajaChicaService],
})
export class CajaChicaModule {}
