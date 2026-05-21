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
  CreateGastoDto,
  ListGastosQuery,
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
    if (c.rol === Rol.PILOTO && !filters.usuario_captura_id) {
      filters.usuario_captura_id = c.userId;
    }
    return this.expenses.list(filters);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary: 'Capture a gasto. Pilotos lo usan desde la app móvil (foto + datos).',
  })
  create(@Body() dto: CreateGastoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.expenses.create(dto, c.userId);
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
