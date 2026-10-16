import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { MultasController } from './multas.controller';
import { MultasService } from './multas.service';

@Module({
  // Inicio oficial en la lista (invariante 86, 0.0.85). Sin ciclo.
  imports: [ConfiguracionModule],
  controllers: [MultasController],
  providers: [MultasService],
  exports: [MultasService],
})
export class MultasModule {}
