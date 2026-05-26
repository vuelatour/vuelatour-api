import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { CalendarRangeQuery } from './dto/calendar.dto';
import { CalendarService } from './calendar.service';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO)
  @ApiOperation({
    summary:
      'List flight events in a date range. Default: today → today+30 días. Excluye CANCELADOS. No accesible a pilotos.',
  })
  list(@Query() q: CalendarRangeQuery) {
    return this.calendar.listEvents(q);
  }
}
