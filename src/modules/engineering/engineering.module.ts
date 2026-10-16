import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { EngineeringController } from './engineering.controller';
import { EngineeringService } from './engineering.service';

@Module({
  // CalendarModule: espejo de los mantenimientos a Google Calendar (C1,
  // 12-sep-2026). CalendarModule no importa EngineeringModule: sin ciclo.
  // ConfiguracionModule: inicio oficial en el historial (invariante 86,
  // 0.0.85); no importa EngineeringModule: sin ciclo.
  imports: [CalendarModule, ConfiguracionModule],
  controllers: [EngineeringController],
  providers: [EngineeringService],
  exports: [EngineeringService],
})
export class EngineeringModule {}
