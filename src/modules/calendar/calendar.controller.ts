import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CalendarRangeQuery } from './dto/calendar.dto';
import { CalendarService } from './calendar.service';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @ApiOperation({
    summary:
      'List flight events in a date range. Default: today → today+30 días. Excluye CANCELADOS por default. Color externos rosa #FFB6C1.',
  })
  list(@Query() q: CalendarRangeQuery) {
    return this.calendar.listEvents(q);
  }
}
