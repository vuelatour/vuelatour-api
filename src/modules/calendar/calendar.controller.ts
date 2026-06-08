import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { CalendarRangeQuery } from './dto/calendar.dto';
import { CalendarService } from './calendar.service';
import { CalendarSyncService } from './calendar-sync.service';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly sync: CalendarSyncService,
  ) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO)
  @ApiOperation({
    summary:
      'List flight events in a date range. Default: today → today+30 días. Excluye CANCELADOS. No accesible a pilotos.',
  })
  list(@Query() q: CalendarRangeQuery) {
    return this.calendar.listEvents(q);
  }

  @Post('resync')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-sincroniza a Google Calendar los vuelos redondos (crea el tramo de regreso).',
  })
  resync() {
    return this.sync.resyncRedondos();
  }
}
