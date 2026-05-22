import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { RegisterDeviceDto, UnregisterDeviceDto } from './dto/devices.dto';
import { PushService } from './push.service';

@ApiTags('Devices')
@ApiBearerAuth()
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly push: PushService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registra el token push del dispositivo del usuario actual' })
  async register(@Body() dto: RegisterDeviceDto, @CurrentUser() c: AuthenticatedUser) {
    await this.push.registerToken(c.userId, dto.token, dto.plataforma);
    return { ok: true };
  }

  @Post('unregister')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Da de baja un token push (ej. al cerrar sesión)' })
  async unregister(@Body() dto: UnregisterDeviceDto) {
    await this.push.unregisterToken(dto.token);
    return { ok: true };
  }
}
