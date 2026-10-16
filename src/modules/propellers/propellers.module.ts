import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { PropellersController } from './propellers.controller';
import { PropellersService } from './propellers.service';

@Module({
  // ConfiguracionModule: inicio oficial en la bitácora (invariante 86).
  imports: [AircraftModule, ConfiguracionModule],
  controllers: [PropellersController],
  providers: [PropellersService],
  exports: [PropellersService],
})
export class PropellersModule {}
