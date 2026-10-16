import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { EnginesController } from './engines.controller';
import { EnginesService } from './engines.service';

@Module({
  // ConfiguracionModule: inicio oficial en la bitácora (invariante 86).
  imports: [AircraftModule, ConfiguracionModule],
  controllers: [EnginesController],
  providers: [EnginesService],
  exports: [EnginesService],
})
export class EnginesModule {}
