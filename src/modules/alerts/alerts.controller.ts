import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { UpdateAlertConfigDto } from './dto/alerts.dto';
import { AlertsService } from './alerts.service';

@ApiTags('Alerts')
@ApiBearerAuth()
@Controller({ path: 'alerts', version: '1' })
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('config')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Lista la configuración de las alertas programadas' })
  listConfig() {
    return this.alerts.listConfig();
  }

  @Patch('config/:clave')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Actualiza una alerta (activa, canal, roles, anticipación)' })
  updateConfig(
    @Param('clave') clave: string,
    @Body() dto: UpdateAlertConfigDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.alerts.updateConfig(clave, { ...dto }, c.userId);
  }

  @Post('run')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ejecuta todas las alertas ahora (prueba manual)' })
  run() {
    return this.alerts.runAll();
  }
}
