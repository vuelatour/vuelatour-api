import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  IaSaldoDto,
  IaUsoQuery,
  UpdateConfiguracionDto,
} from './dto/configuracion.dto';
import { ConfiguracionService } from './configuracion.service';
import { IaUsoService } from '../ia-uso/ia-uso.service';

@ApiTags('Config')
@ApiBearerAuth()
@Controller({ path: 'config', version: '1' })
export class ConfiguracionController {
  constructor(
    private readonly config: ConfiguracionService,
    private readonly iaUsoSvc: IaUsoService,
  ) {}

  @Get()
  // Sin @Roles: la app del piloto/mecánico necesita leer las banderas de
  // comportamiento y no contienen nada sensible (mismo criterio que GET /me).
  @ApiOperation({ summary: 'Banderas globales de comportamiento del sistema' })
  list() {
    return this.config.list();
  }

  // Rutas literales ANTES de ':clave' (convención del repo).
  @Get('ia-uso')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Resumen del consumo de IA (llamadas, tokens y costo USD) por categoría, modelo y día. Default: mes actual en pared Cancún. El saldo es ESTIMADO (los fallos 422/timeout gastan tokens que no llegan al registro).',
  })
  iaUso(@Query() q: IaUsoQuery) {
    return this.iaUsoSvc.resumen(q.desde, q.hasta);
  }

  @Post('ia-saldo')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Registra un checkpoint del saldo real de la consola de Anthropic; el panel estima el saldo restante restando el consumo posterior.',
  })
  iaSaldo(@Body() dto: IaSaldoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.iaUsoSvc.guardarSaldo(
      dto.saldo_usd,
      dto.notas ?? null,
      c.userId,
    );
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
