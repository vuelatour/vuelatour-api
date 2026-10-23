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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  CerrarMesDto,
  PreviaCierreQuery,
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
      'Qué pasaría al cerrar el mes: bloqueantes, vuelos que pasan al mes siguiente y reparto antes/después. ?incluir=id,id (21-oct-2026): vuelos ya cobrados después del corte que se quedarían en el mes (vuelos_incluidos). ?aeronave_id (23-oct-2026, invariante 105): la previa de UN avión.',
  })
  previa(@Param('periodo') periodo: string, @Query() q: PreviaCierreQuery) {
    return this.cierres.previa(validarPeriodoCierre(periodo), {
      incluir: q.incluir,
      aeronaveId: q.aeronave_id,
    });
  }

  @Post(':periodo')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Cierra el mes (por avión con aeronave_id; sin él, todos los aviones activos abiertos): congela el reparto y pasa al mes siguiente los vuelos no cobrados al último día. incluir_vuelos (21-oct-2026): los ya cobrados después del corte que se quedan en el mes.',
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
      'Reabre un mes cerrado (solo ADMIN; por avión con aeronave_id, si no todos los cerrados): los vuelos que pasaron regresan a su mes',
  })
  reabrir(
    @Param('periodo') periodo: string,
    @Body() dto: ReabrirMesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.cierres.reabrir(validarPeriodoCierre(periodo), dto, actor);
  }
}
