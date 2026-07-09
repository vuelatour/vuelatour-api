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
  CreateTarifaAerodromoDto,
  GenerarPistasDto,
  ListGastosQuery,
  PhotoUrlsDto,
  PistasPendientesQuery,
  SugerirVueloQuery,
  UpdateGastoDto,
  UpdateTarifaAerodromoDto,
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

  @Post('sugerir-asignaciones')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Barrido de la bandeja: sugiere vuelo/avión para TODOS los gastos pendientes (máx 15). Devuelve gasto→sugerencia; la oficina aplica en lote.',
  })
  sugerirAsignaciones() {
    return this.expenses.sugerirAsignaciones();
  }

  @Get(':id/sugerir-asignacion')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Sugiere a qué vuelo/avión pertenece un gasto de la bandeja: vuelos del capturista a ±3 días (regla si hay uno el mismo día; IA si hay varios). Sin candidatos → sin match (asignación manual).',
  })
  sugerirAsignacion(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.sugerirAsignacion(id);
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

  // ===== Gastos de pista (cuotas de aeródromo) — rutas literales antes de :id =====

  @Get('pistas/pendientes')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Aterrizajes del periodo (destino ≠ CUN) sin gasto de pista, con monto sugerido del tarifario. La oficina revisa y confirma.',
  })
  pistasPendientes(@Query() q: PistasPendientesQuery) {
    return this.expenses.pistasPendientes(q.desde, q.hasta);
  }

  @Post('pistas/generar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Crea los gastos de pista confirmados (origen SISTEMA, un gasto por aterrizaje, SIN_COMPROBANTE hasta amarrar la factura).',
  })
  generarPistas(@Body() dto: GenerarPistasDto, @CurrentUser() c: AuthenticatedUser) {
    return this.expenses.generarPistas(dto, c.userId);
  }

  @Get('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({ summary: 'Tarifario de cuotas de aterrizaje por aeródromo/modelo.' })
  listTarifas() {
    return this.expenses.listTarifasAerodromo();
  }

  @Post('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Agrega una tarifa de aeródromo.' })
  createTarifa(@Body() dto: CreateTarifaAerodromoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.expenses.createTarifaAerodromo(dto, c.userId);
  }

  @Patch('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Actualiza una tarifa de aeródromo.' })
  updateTarifa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTarifaAerodromoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.updateTarifaAerodromo(id, dto, c.userId);
  }

  @Delete('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina una tarifa de aeródromo.' })
  removeTarifa(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.removeTarifaAerodromo(id);
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
