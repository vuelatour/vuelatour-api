/**
 * CIERRE DE MES FORMAL (16-oct-2026, API 0.0.88, invariante 89). Rutas
 * literales antes de `:periodo`; `@Roles` en CADA una. `periodo` = AAAA-MM
 * (otra cosa ⇒ 400 PERIODO_INVALIDO).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  CerrarMesDto,
  ReabrirMesDto,
  validarPeriodoCierre,
} from './dto/cierres.dto';
import { CierresService } from './cierres.service';

@ApiTags('Cierres de mes')
@ApiBearerAuth()
@Controller({ path: 'cierres', version: '1' })
export class CierresController {
  constructor(private readonly cierres: CierresService) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.COORDINADOR, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Estado del cierre de cada mes (desde el inicio oficial hasta el mes en curso)',
  })
  estado() {
    return this.cierres.estado();
  }

  @Get(':periodo/previa')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Qué pasaría al cerrar el mes: bloqueantes, vuelos que pasan al mes siguiente y reparto antes/después',
  })
  previa(@Param('periodo') periodo: string) {
    return this.cierres.previa(validarPeriodoCierre(periodo));
  }

  @Post(':periodo')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Cierra el mes: congela el reparto y pasa al mes siguiente los vuelos no cobrados al último día',
  })
  cerrar(
    @Param('periodo') periodo: string,
    @Body() dto: CerrarMesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.cierres.cerrar(validarPeriodoCierre(periodo), dto, actor);
  }

  @Post(':periodo/reabrir')
  @HttpCode(HttpStatus.OK)
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Reabre un mes cerrado (solo ADMIN): los vuelos que pasaron regresan a su mes',
  })
  reabrir(
    @Param('periodo') periodo: string,
    @Body() dto: ReabrirMesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.cierres.reabrir(validarPeriodoCierre(periodo), dto, actor);
  }
}
