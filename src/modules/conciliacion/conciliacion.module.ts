import { Module } from '@nestjs/common';
import { PyservicesModule } from '../pyservices/pyservices.module';
// Modelo de IA configurado (2-oct-2026). ConfiguracionModule no importa
// ConciliacionModule: sin ciclo.
import { ConfiguracionModule } from '../configuracion/configuracion.module';
// T.C. OFICIAL del día del cargo (13-oct-2026, invariante 70): el cruce de
// gastos en dólares contra cargos en pesos lo exige. TipoCambioModule no
// importa nada (SupabaseModule es @Global): sin ciclo. Sin este import el
// parámetro @Optional deja todo «funcionando» pero SIN oficial (todo
// AMBIGUO y el pre-cierre en lectura_fallida): conciliacion.module.spec lo
// congela.
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';
import { ConciliacionController } from './conciliacion.controller';
import { ConciliacionService } from './conciliacion.service';

@Module({
  imports: [PyservicesModule, ConfiguracionModule, TipoCambioModule],
  controllers: [ConciliacionController],
  providers: [ConciliacionService],
  exports: [ConciliacionService],
})
export class ConciliacionModule {}
