import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { ListPilotsQuery } from './dto/pilots.dto';
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

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Detalle de un piloto: próximos vuelos, vuelos del mes, capturas y gastos recientes.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pilots.findById(id);
  }
}
