import { RealtimeModule } from '../realtime/realtime.module';
import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { UsersModule } from '../users/users.module';
import { PilotsController } from './pilots.controller';
import { PilotsService } from './pilots.service';

@Module({
  // ConfiguracionModule: inicio oficial (invariante 86, 0.0.85); no importa
  // PilotsModule: sin ciclo.
  imports: [CalendarModule, UsersModule, RealtimeModule, ConfiguracionModule],
  controllers: [PilotsController],
  providers: [PilotsService],
  exports: [PilotsService],
})
export class PilotsModule {}
