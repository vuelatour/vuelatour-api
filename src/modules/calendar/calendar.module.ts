import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarSyncService } from './calendar-sync.service';

@Module({
  controllers: [CalendarController],
  providers: [CalendarService, CalendarSyncService],
  exports: [CalendarService, CalendarSyncService],
})
export class CalendarModule {}
