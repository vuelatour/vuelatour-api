import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { ListDescansosQuery } from '../pilots/dto/pilots.dto';
import { PilotsService } from '../pilots/pilots.service';
import { UpdateSelfDto } from '../users/dto/update-self.dto';
import { UsersService } from '../users/users.service';
import { CapturasQuery } from './dto/capturas.dto';
import { MeCapturasService } from './me-capturas.service';

@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly capturas: MeCapturasService,
    private readonly pilots: PilotsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Current authenticated user profile' })
  me(@CurrentUser() current: AuthenticatedUser) {
    return this.users.findByAuthId(current.authId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update non-privileged fields of the current user' })
  update(
    @Body() body: UpdateSelfDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.users.updateSelf(current.authId, body, current.userId);
  }

  @Get('horas')
  // Decisión del cliente (1 ago 2026): los PILOTOS no deben ver sus horas de
  // vuelo — solo oficina. La app instalada degrada con un texto benigno
  // ("Necesitas conexión…") al recibir 403; la app nueva ya ni lo pide.
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Horas voladas del usuario actual (mes en curso o ?mes=YYYY-MM) vs límite informativo de 90 hrs/mes. SOLO oficina: los pilotos no ven sus horas.',
  })
  horas(@CurrentUser() current: AuthenticatedUser, @Query('mes') mes?: string) {
    return this.users.horasDelMes(current.userId, mes);
  }

  @Get('descansos')
  @ApiOperation({
    summary:
      'Descansos marcados del usuario actual (para el calendario de la app). ' +
      'Siempre filtra por el usuario autenticado: /pilots/descansos es de oficina.',
  })
  misDescansos(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: ListDescansosQuery,
  ) {
    return this.pilots.listDescansos({
      ...query,
      piloto_id: current.userId,
    });
  }

  @Get('capturas')
  @Roles(Rol.PILOTO, Rol.MECANICO, Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Historial de capturas del usuario actual (gastos, combustible, cobros, tacómetros, mantenimientos) unificado por fecha desc. Evidencia de que la sincronización de la app quedó en el servidor; SIEMPRE filtra por el usuario autenticado.',
  })
  misCapturas(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: CapturasQuery,
  ) {
    return this.capturas.capturas(current.userId, query);
  }
}
