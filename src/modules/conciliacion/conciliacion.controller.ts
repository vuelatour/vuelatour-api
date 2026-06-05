import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  ConciliacionParseDto,
  ImportarMovimientosDto,
  LinkMovimientoDto,
  ListConciliacionQuery,
} from './dto/conciliacion.dto';
import { ConciliacionService } from './conciliacion.service';

@ApiTags('Conciliación')
@ApiBearerAuth()
@Roles(Rol.ADMIN, Rol.FACTURACION)
@Controller({ path: 'conciliacion', version: '1' })
export class ConciliacionController {
  constructor(private readonly conciliacion: ConciliacionService) {}

  @Post('parse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parsea un estado de cuenta (CSV/Excel/PDF) sin persistir' })
  parse(@Body() dto: ConciliacionParseDto) {
    return this.conciliacion.parse(dto);
  }

  @Post('importar')
  @ApiOperation({ summary: 'Importa movimientos y auto-concilia los CARGO contra gastos' })
  importar(@Body() dto: ImportarMovimientosDto, @CurrentUser() c: AuthenticatedUser) {
    return this.conciliacion.importar(dto, c.userId);
  }

  @Get('movimientos')
  @ApiOperation({ summary: 'Lista movimientos bancarios con su gasto conciliado' })
  list(@Query() q: ListConciliacionQuery) {
    return this.conciliacion.list(q);
  }

  @Patch('movimientos/:id')
  @ApiOperation({ summary: 'Vincula o desvincula un movimiento con un gasto' })
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.link(id, dto.gasto_id ?? null, c.userId);
  }

  @Post('movimientos/:id/sugerir')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugiere por IA el gasto más probable para un movimiento sin conciliar y ambiguo (ADMIN). Best-effort: disponible=false si la IA no está disponible.',
  })
  sugerir(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.sugerir(id);
  }
}
