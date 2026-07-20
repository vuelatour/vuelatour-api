import { Module } from '@nestjs/common';
import { AircraftController } from './aircraft.controller';
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftService } from './aircraft.service';
import { ExpirationsModule } from '../expirations/expirations.module';
import { PyservicesModule } from '../pyservices/pyservices.module';

@Module({
  imports: [ExpirationsModule, PyservicesModule],
  controllers: [AircraftController],
  providers: [AircraftService, AircraftBalanceService],
  exports: [AircraftService],
})
export class AircraftModule {}
