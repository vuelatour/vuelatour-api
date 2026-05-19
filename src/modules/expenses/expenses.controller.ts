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
  @ApiOperation({
    summary:
      'List expenses (filtros: aeronave, vuelo, categoria, medio, fechas)',
  })
  list(@Query() q: ListGastosQuery) {
    return this.expenses.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary: 'Create expense (cualquiera captura sus gastos, excepto SOCIO)',
  })
  create(@Body() dto: CreateGastoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.expenses.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get expense' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION)
  @ApiOperation({ summary: 'Update / verify expense (oficina verifica)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete expense' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.remove(id);
  }
}
