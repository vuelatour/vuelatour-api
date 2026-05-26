import { Module } from '@nestjs/common';
import { CajaChicaController } from './caja-chica.controller';
import { CajaChicaService } from './caja-chica.service';

@Module({
  controllers: [CajaChicaController],
  providers: [CajaChicaService],
  exports: [CajaChicaService],
})
export class CajaChicaModule {}
