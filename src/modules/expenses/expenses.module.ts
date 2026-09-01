import { Module } from '@nestjs/common';
import { CajaChicaModule } from '../caja-chica/caja-chica.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VisionModule } from '../vision/vision.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [
    RealtimeModule,
    PyservicesModule,
    VisionModule,
    ConfiguracionModule,
    CajaChicaModule,
  ],
  controllers: [ExpensesController],
  providers: [ExpensesService, CombustibleMasivoService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
