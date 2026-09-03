import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CalendarRangeQuery,
  CreateEventoFlotaDto,
  UpdateEventoFlotaDto,
} from './dto/calendar.dto';
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
      'Agenda un evento NO-vuelo (lavado, trámite, visita) que sale en el calendario de flota. Devuelve el evento + `aviso` {responsable_id, nombre, notificado, push_dispositivos, plataformas} | null (null sin responsable o si quien agenda es el responsable): push_dispositivos = 0 ⇒ al responsable NO le llegará push, avísale por otro medio.',
  })
  createEvento(
    @Body() dto: CreateEventoFlotaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.calendar.createEvento(dto, c.userId);
  }

  @Patch('eventos/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Edita un evento NO-vuelo (id del evento, no el id compuesto por día del calendario). Nuevo responsable → evento_asignado al nuevo y evento_cancelado al anterior; mismo responsable con cambios → evento_actualizado. Devuelve el evento + `aviso` como el POST.',
  })
  updateEvento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventoFlotaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.calendar.updateEvento(id, dto, c.userId);
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
    summary:
      'Re-sincroniza a Google Calendar los vuelos redondos (crea el tramo de regreso).',
  })
  resync() {
    return this.sync.resyncRedondos();
  }
}
