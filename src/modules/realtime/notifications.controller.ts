import {
  Body,
  Controller,
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
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { ListNotificationsQuery } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista las notificaciones del usuario actual' })
  list(@Query() q: ListNotificationsQuery, @CurrentUser() c: AuthenticatedUser) {
    return this.notifications.list(c.userId, {
      limit: q.limit,
      offset: q.offset,
      unreadOnly: q.unread_only,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Cuenta de notificaciones no leídas (para el badge)' })
  async unreadCount(@CurrentUser() c: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(c.userId) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca una notificación como leída' })
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.notifications.markRead(c.userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca todas las notificaciones como leídas' })
  markAllRead(@Body() _body: unknown, @CurrentUser() c: AuthenticatedUser) {
    return this.notifications.markAllRead(c.userId);
  }
}
