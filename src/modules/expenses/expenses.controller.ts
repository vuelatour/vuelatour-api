import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
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
  SugerirVueloQuery,
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

  @Get('sugerir-vuelo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Sugiere el vuelo al que corresponde una carga de combustible (aeronave + momento de la carga). En ruta → ese vuelo; si no → siguiente salida.',
  })
  sugerirVuelo(@Query() q: SugerirVueloQuery) {
    return this.expenses.sugerirVuelo(q.aeronave_id, q.fecha_hora);
  }

  @Get('export')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({ summary: 'Gastos por avión/categoría en Excel (respeta filtros)' })
  async export(@Query() q: ListGastosQuery): Promise<StreamableFile> {
    const buffer = await this.expenses.listXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="gastos.xlsx"',
    });
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
  @ApiOperation({ summary: 'Get gasto by id. Piloto/mecánico solo ven sus propias capturas.' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    const gasto = await this.expenses.findById(id);
    if (
      (c.rol === Rol.PILOTO || c.rol === Rol.MECANICO) &&
      (gasto as { usuario_captura_id: string | null }).usuario_captura_id !== c.userId
    ) {
      throw new ForbiddenException('No tienes acceso a este gasto');
    }
    return gasto;
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Update gasto. Oficina siempre; piloto/mecánico solo su propio gasto y solo el mismo día (doc 5.2/5.3).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (c.rol === Rol.PILOTO || c.rol === Rol.MECANICO) {
      await this.expenses.assertOwnSameDay(id, c.userId);
    }
    return this.expenses.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete gasto. Oficina siempre; piloto/mecánico solo el suyo del mismo día.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (c.rol === Rol.PILOTO || c.rol === Rol.MECANICO) {
      await this.expenses.assertOwnSameDay(id, c.userId);
    }
    return this.expenses.remove(id);
  }
}
