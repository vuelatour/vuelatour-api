import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CalendarRangeQuery, CreateEventoFlotaDto } from './dto/calendar.dto';
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
      'List flight events in a date range. Default: today → today+30 días. Incluye CANCELADOS en rojo (historial de operaciones; incluir_cancelados=false los excluye). No accesible a pilotos.',
  })
  list(@Query() q: CalendarRangeQuery) {
    return this.calendar.listEvents(q);
  }

  @Post('eventos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Agenda un evento NO-vuelo (lavado, trámite, visita) que sale en el calendario de flota.',
  })
  createEvento(
    @Body() dto: CreateEventoFlotaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.calendar.createEvento(dto, c.userId);
  }

  @Delete('eventos/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina un evento NO-vuelo del calendario.' })
  removeEvento(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendar.removeEvento(id);
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
