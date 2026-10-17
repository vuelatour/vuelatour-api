/**
 * COSTO REAL AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90): la
 * celda EGRESO de cada fila «AFAC por vuelo» del Balance general en
 * pantalla. Solo oficina (`ROLES_AFAC_REAL`); ANALISTA ve el libro sin
 * editar. Rutas de dos segmentos bajo `flights` (no chocan con las de
 * `FlightsController`).
 */
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import { PutAfacRealDto } from './dto/afac-real.dto';
import { AfacRealService } from './afac-real.service';

@ApiTags('AFAC por vuelo')
@ApiBearerAuth()
@Controller({ path: 'flights', version: '1' })
export class AfacRealController {
  constructor(private readonly afac: AfacRealService) {}

  @Put(':id/afac-real')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Guarda el COSTO REAL AFAC del vuelo (pesos; egreso de VuelaTour en «otros movimientos» del Balance general). Idempotente (sin_cambios). ' +
      '503 AFAC_REAL_NO_DISPONIBLE; 404 VUELO_NO_EXISTE; 400 AFAC_VUELO_SIN_AVION / AFAC_VUELO_SIN_FECHA / PERIODO_ANTES_DEL_INICIO; 409 MES_CERRADO.',
  })
  guardar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutAfacRealDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.afac.guardar(id, dto, c.userId);
  }

  @Delete(':id/afac-real')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quita el COSTO REAL AFAC del vuelo (vuelve a «sin capturar»; no borra nada: la bitácora lo registra como QUITADO). Mismas validaciones que el PUT.',
  })
  quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.afac.quitar(id, c.userId);
  }
}
