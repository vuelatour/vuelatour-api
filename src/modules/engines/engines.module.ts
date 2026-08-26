import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module';
import { EnginesController } from './engines.controller';
import { EnginesService } from './engines.service';

@Module({
  imports: [AircraftModule],
  controllers: [EnginesController],
  providers: [EnginesService],
  exports: [EnginesService],
})
export class EnginesModule {}
