import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarSyncService } from './calendar-sync.service';

@Module({
  imports: [RealtimeModule],
  controllers: [CalendarController],
  providers: [CalendarService, CalendarSyncService],
  exports: [CalendarService, CalendarSyncService],
})
export class CalendarModule {}
