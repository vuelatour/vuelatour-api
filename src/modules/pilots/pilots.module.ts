import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { PilotsController } from './pilots.controller';
import { PilotsService } from './pilots.service';

@Module({
  imports: [CalendarModule],
  controllers: [PilotsController],
  providers: [PilotsService],
  exports: [PilotsService],
})
export class PilotsModule {}
