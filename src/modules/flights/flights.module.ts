import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VisionModule } from '../vision/vision.module';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';

@Module({
  imports: [CalendarModule, NotificationsModule, VisionModule],
  controllers: [FlightsController],
  providers: [FlightsService],
  exports: [FlightsService],
})
export class FlightsModule {}
