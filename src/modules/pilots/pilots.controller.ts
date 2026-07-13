import {
  Body,
  Controller,
  Delete,
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
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateDescansoDto,
  CreatePilotoExternoDto,
  ListDescansosQuery,
  ListPilotsQuery,
} from './dto/pilots.dto';
import { PilotsService } from './pilots.service';

@ApiTags('Pilots')
@ApiBearerAuth()
@Controller({ path: 'pilots', version: '1' })
export class PilotsController {
  constructor(private readonly pilots: PilotsService) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Lista pilotos con métricas agregadas (vuelos mes/próximos, capturas, gastos).',
  })
  list(@Query() q: ListPilotsQuery) {
    return this.pilots.list(q);
  }

  @Post('externo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Alta de piloto EXTERNO (freelance sin acceso al sistema): asignable a vuelos; la oficina captura sus tacómetros y gastos.',
  })
  createExterno(
    @Body() dto: CreatePilotoExternoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pilots.createExterno(dto, c.userId);
  }

  @Get('descansos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Descansos de pilotos en un rango (para el calendario).' })
  listDescansos(@Query() q: ListDescansosQuery) {
    return this.pilots.listDescansos(q);
  }

  @Post(':id/descansos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Marca un rango de descanso para el piloto.' })
  createDescanso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDescansoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pilots.createDescanso(id, dto, c.userId);
  }

  @Delete('descansos/:descansoId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quita un descanso marcado.' })
  deleteDescanso(@Param('descansoId', ParseUUIDPipe) descansoId: string) {
    return this.pilots.deleteDescanso(descansoId);
  }

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Detalle de un piloto: próximos vuelos, vuelos del mes, capturas y gastos recientes.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pilots.findById(id);
  }
}
