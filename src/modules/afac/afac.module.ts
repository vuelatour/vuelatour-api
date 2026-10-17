import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { AfacRealController } from './afac-real.controller';
import { AfacRealService } from './afac-real.service';

/**
 * AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90): captura del
 * costo real por vuelo. Importa la configuración (inicio oficial); el
 * candado `MES_CERRADO` es una función de `common/cierre-mes.lector`. Nadie
 * importa este módulo.
 */
@Module({
  imports: [ConfiguracionModule],
  controllers: [AfacRealController],
  providers: [AfacRealService],
})
export class AfacModule {}
