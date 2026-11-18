import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { AdjuntosIngenieriaService } from './adjuntos-ingenieria.service';
import { ComponentesService } from './componentes.service';
import { EngineeringController } from './engineering.controller';
import { EngineeringService } from './engineering.service';

@Module({
  // CalendarModule: espejo de los mantenimientos a Google Calendar (C1,
  // 12-sep-2026). CalendarModule no importa EngineeringModule: sin ciclo.
  // ConfiguracionModule: entró por el inicio oficial en el historial
  // (invariante 86, 0.0.85). Desde el 0.0.144 (invariante 139) el historial
  // va COMPLETO y `EngineeringService` ya no lo usa; se conserva el import
  // (inofensivo, sin ciclo) para no mover el grafo de módulos.
  // AircraftModule (invariante 135, 0.0.140): `ComponentesService` lee el
  // Hobbs con `AircraftService.currentHobbs`, el MISMO número de la ficha.
  // Sin ciclo: fuera de AppModule, NINGÚN módulo importa EngineeringModule
  // (lo congela `engineering.module.spec`).
  imports: [CalendarModule, ConfiguracionModule, AircraftModule],
  controllers: [EngineeringController],
  // ComponentesService y AdjuntosIngenieriaService (invariante 135, 0.0.140):
  // componentes del avión con vida límite y archivos de ingeniería. Viven
  // aquí (no en engines/propellers/aircraft): solo necesitan Supabase y el
  // Hobbs de AircraftService.
  providers: [
    EngineeringService,
    ComponentesService,
    AdjuntosIngenieriaService,
  ],
  exports: [EngineeringService],
})
export class EngineeringModule {}
