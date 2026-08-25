import { RealtimeModule } from '../realtime/realtime.module';
import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { UsersModule } from '../users/users.module';
import { PilotsController } from './pilots.controller';
import { PilotsService } from './pilots.service';

@Module({
  imports: [CalendarModule, UsersModule, RealtimeModule],
  controllers: [PilotsController],
  providers: [PilotsService],
  exports: [PilotsService],
})
export class PilotsModule {}
