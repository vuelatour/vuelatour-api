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
  ResyncCalendarDto,
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

  // Ruta LITERAL antes de cualquier ':id' del mismo segmento (convención del
  // repo) — hoy no hay ninguna, pero el orden se conserva.
  @Get('sync-estado')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.FACTURACION, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Estado de la sincronización a Google Calendar (C5, 12-sep-2026): {enabled, calendar_id, ultimo_reconcile_at, ultimo_resync_at, ultimo_resumen, nota}. `enabled:false` = faltan las variables en Railway (GOOGLE_CALENDAR_SYNC_ENABLED / GOOGLE_CALENDAR_ID / GOOGLE_SERVICE_ACCOUNT_JSON). Los últimos = en memoria del proceso: null si aún no ha corrido desde el último deploy.',
  })
  syncEstado() {
    return this.sync.estadoSync();
  }

  @Post('resync')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Backfill COMPLETO a Google Calendar (12-sep-2026): vuelos no cancelados con fecha, descansos de piloto, eventos NO-vuelo y mantenimientos con fecha de la ventana [hoy−30d, hoy+365d] (body opcional `desde`/`hasta` ISO). Secuencial y best-effort: devuelve conteos por tipo {enabled, calendar_id, vuelos, descansos, eventos, mantenimientos, errores, desde, hasta, nota} y nunca lanza por un evento que falle. Los eventos capturados A MANO en Google no se tocan ni se deduplican.',
  })
  resync(@Body() dto?: ResyncCalendarDto) {
    return this.sync.resyncTodo(dto);
  }
}
