import { Module } from '@nestjs/common';
import { ExpirationsModule } from '../expirations/expirations.module';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

@Module({
  imports: [ExpirationsModule],
  controllers: [FlightsController],
  providers: [FlightsService],
  exports: [FlightsService],
})
export class FlightsModule {}
