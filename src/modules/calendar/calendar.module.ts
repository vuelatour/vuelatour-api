import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarSyncService } from './calendar-sync.service';

@Module({
  // ConfiguracionModule: inicio oficial (invariante 86, 0.0.85); no importa
  // CalendarModule: sin ciclo.
  imports: [RealtimeModule, ConfiguracionModule],
  controllers: [CalendarController],
  providers: [CalendarService, CalendarSyncService],
  exports: [CalendarService, CalendarSyncService],
})
export class CalendarModule {}
