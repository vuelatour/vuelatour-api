import {
  Body,
  Controller,
  Delete,
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
  CategoriaGasto,
  CreateGastoDto,
  ListGastosQuery,
  PhotoUrlsDto,
  UpdateGastoDto,
} from './dto/expenses.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('Expenses')
@ApiBearerAuth()
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @ApiOperation({ summary: 'List gastos (with filters). Pilotos see only own captures.' })
  list(@Query() q: ListGastosQuery, @CurrentUser() c: AuthenticatedUser) {
    const filters = { ...q };
    // Pilotos y mecánicos solo ven sus propias capturas. El mecánico, además,
    // solo combustible (GAS) — no ve el resto de gastos.
    if ((c.rol === Rol.PILOTO || c.rol === Rol.MECANICO) && !filters.usuario_captura_id) {
      filters.usuario_captura_id = c.userId;
    }
    if (c.rol === Rol.MECANICO) {
      filters.categoria = CategoriaGasto.GAS;
    }
    return this.expenses.list(filters);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Capture a gasto. Pilotos/mecánicos lo usan desde la app móvil. El mecánico solo carga combustible.',
  })
  create(@Body() dto: CreateGastoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.expenses.create(dto, c.userId, c.rol);
  }

  @Post('photo-urls')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Firma URLs de fotos de recibos (bucket privado) para el panel admin.' })
  photoUrls(@Body() dto: PhotoUrlsDto) {
    return this.expenses.signPhotos(dto.paths);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get gasto by id' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Update gasto (admin/coordinador/facturacion)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete gasto (admin/coordinador)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.remove(id);
  }
}
