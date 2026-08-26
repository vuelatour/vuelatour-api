import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { PropellersController } from './propellers.controller';
import { PropellersService } from './propellers.service';

@Module({
  imports: [AircraftModule],
  controllers: [PropellersController],
  providers: [PropellersService],
  exports: [PropellersService],
})
export class PropellersModule {}
