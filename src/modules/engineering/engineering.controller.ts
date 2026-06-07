import {
  Body,
  Controller,
  Get,
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
  CreateMantenimientoDto,
  CreateVencimientoDto,
  UpdateMantenimientoDto,
} from './dto/engineering.dto';
import { EngineeringService } from './engineering.service';

@ApiTags('Engineering')
@ApiBearerAuth()
@Controller({ path: 'engineering', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR)
export class EngineeringController {
  constructor(private readonly engineering: EngineeringService) {}

  @Get('aircraft/:id/maintenance')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({ summary: 'Mantenimientos (programados/realizados) de una aeronave' })
  listMaintenance(@Param('id', ParseUUIDPipe) id: string) {
    return this.engineering.listMantenimientos(id);
  }

  @Post('aircraft/:id/maintenance')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({ summary: 'Registra un mantenimiento de la aeronave' })
  createMaintenance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMantenimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engineering.createMantenimiento(id, dto, c.userId);
  }

  @Patch('maintenance/:mid')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary: 'Actualiza/transiciona un servicio (programado → en taller → completado)',
  })
  updateMaintenance(
    @Param('mid', ParseUUIDPipe) mid: string,
    @Body() dto: UpdateMantenimientoDto,
  ) {
    return this.engineering.updateMantenimiento(mid, dto);
  }

  @Get('aircraft/:id/expirations')
  @ApiOperation({ summary: 'Permisos/licencias/servicios (vencimientos) de una aeronave' })
  listExpirations(@Param('id', ParseUUIDPipe) id: string) {
    return this.engineering.listVencimientos(id);
  }

  @Post('aircraft/:id/expirations')
  @ApiOperation({ summary: 'Registra un vencimiento (alimenta las alertas)' })
  createExpiration(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engineering.createVencimiento(id, dto, c.userId);
  }

  @Get('document-types')
  @ApiOperation({ summary: 'Catálogo de tipos de documento (para crear vencimientos)' })
  documentTypes() {
    return this.engineering.documentTypes();
  }

  @Get('upcoming')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({ summary: 'Dashboard de flota: vencimientos y mantenimientos próximos.' })
  upcoming(@Query('dias') dias?: string) {
    const d = Math.min(Math.max(Number(dias) || 60, 1), 365);
    return this.engineering.fleetUpcoming(d);
  }
}
