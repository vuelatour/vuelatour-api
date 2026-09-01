import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { UpdateConfiguracionDto } from './dto/configuracion.dto';
import { ConfiguracionService } from './configuracion.service';

@ApiTags('Config')
@ApiBearerAuth()
@Controller({ path: 'config', version: '1' })
export class ConfiguracionController {
  constructor(private readonly config: ConfiguracionService) {}

  @Get()
  // Sin @Roles: la app del piloto/mecánico necesita leer las banderas de
  // comportamiento y no contienen nada sensible (mismo criterio que GET /me).
  @ApiOperation({ summary: 'Banderas globales de comportamiento del sistema' })
  list() {
    return this.config.list();
  }

  @Patch(':clave')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary: 'Actualiza una bandera global: activa y/o valor_numerico (ADMIN)',
  })
  update(
    @Param('clave') clave: string,
    @Body() dto: UpdateConfiguracionDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.config.update(clave, dto, current.userId);
  }
}
