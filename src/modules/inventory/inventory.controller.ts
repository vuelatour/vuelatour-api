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
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateInventarioItemDto,
  CreateMovimientoDto,
  EmpaqueInputDto,
  ImportarInventarioDto,
  ListInventarioQuery,
  ListMovimientosQuery,
  ResumenItemQuery,
  UpdateEmpaqueDto,
  UpdateInventarioItemDto,
  UpdateMovimientoCostoDto,
} from './dto/inventory.dto';
import { ExtraerCompraDto, ImportarCompraDto } from './dto/compras.dto';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';
import { InventarioMasivoService } from './inventario-masivo.service';

const OFICINA = [
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.ANALISTA,
  Rol.FACTURACION,
  Rol.SOCIO,
  Rol.MECANICO,
];

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly compras: ComprasService,
    private readonly masivo: InventarioMasivoService,
  ) {}

  @Post('compras/extraer')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extrae líneas de producto de un PDF de compra (IA)',
  })
  extraerCompra(
    @Body() dto: ExtraerCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.extraer(dto, c.userId);
  }

  @Post('compras/importar')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary: 'Crea ítems (si faltan) y registra entradas desde una compra',
  })
  importarCompra(
    @Body() dto: ImportarCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.importar(dto, c.userId);
  }

  // Escaneo: un código identifica UNA cosa en bodega (ítem/unidad o empaque).
  // Ruta literal antes de cualquier ':id'.
  @Get('codigo/:codigo')
  @Roles(...OFICINA)
  @ApiOperation({
    summary:
      'Busca por código de barras (unidad o empaque) entre ítems y empaques ACTIVOS. 200 { tipo: ITEM|EMPAQUE, item (detalle con empaques[]), empaque | null } · 404 "Código no registrado".',
  })
  buscarPorCodigo(@Param('codigo') codigo: string) {
    return this.inventory.buscarPorCodigo(codigo);
  }

  @Get('items')
  @Roles(...OFICINA)
  @ApiOperation({
    summary: 'List inventory items with computed stock + valuation',
  })
  listItems(@Query() q: ListInventarioQuery) {
    return this.inventory.listItems(q);
  }

  @Get('items/export')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Inventario valorizado en Excel (respeta filtros)' })
  async exportItems(@Query() q: ListInventarioQuery): Promise<StreamableFile> {
    const buffer = await this.inventory.itemsXlsx(q);
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: 'attachment; filename="inventario-valorizado.xlsx"',
    });
  }

  // ===== Alta masiva (plantilla + importar) — literales ANTES de 'items/:id' =====

  // COORDINADOR ve el menú Inventario del panel y opera la carga; SOCIO
  // solo consulta (no aparece aquí a propósito).
  @Get('items/plantilla.xlsx')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Plantilla Excel para el alta masiva de ítems (categorías reales y unidades sugeridas como listas; fila de ejemplo).',
  })
  async plantillaItems(): Promise<StreamableFile> {
    const buffer = await this.masivo.plantillaXlsx();
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: 'attachment; filename="plantilla-inventario.xlsx"',
    });
  }

  @Post('items/importar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Alta masiva desde la plantilla (máximo 200 filas por archivo). confirmar=false (default): solo PREVIEW fila por fila (OK/ERROR/DUPLICADO + mensajes); confirmar=true: crea las filas OK (ítem + empaque + ENTRADA inicial) en lotes, idempotente.',
  })
  importarItems(
    @Body() dto: ImportarInventarioDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.masivo.importar(dto, c.userId);
  }

  @Post('items')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary: 'Create inventory item (ADMIN or MECANICO); acepta empaques[]',
  })
  createItem(
    @Body() dto: CreateInventarioItemDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.createItem(dto, c.userId);
  }

  @Get('movimientos')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Cardex: list inventory movements (filterable)' })
  listMovimientos(@Query() q: ListMovimientosQuery) {
    return this.inventory.listMovimientos(q);
  }

  @Get('movimientos/export')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Cardex en Excel (respeta filtros)' })
  async exportMovimientos(
    @Query() q: ListMovimientosQuery,
  ): Promise<StreamableFile> {
    const buffer = await this.inventory.movimientosXlsx(q);
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: 'attachment; filename="cardex.xlsx"',
    });
  }

  // Sufijo literal declarado ANTES de 'items/:id' (convención del repo).
  @Get('items/:id/cardex-libro.xlsx')
  @Roles(...OFICINA)
  @ApiOperation({
    summary:
      'Cardex del ítem en formato LIBRO (Excel): bloque ENTRADAS | bloque SALIDAS con venta, remanente y ganancia FIFO por salida.',
  })
  async cardexLibro(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.inventory.cardexLibroXlsx(id);
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Resumen del producto para el detalle del panel (4-sep-2026). Literal
  // ANTES de 'items/:id'.
  @Get('items/:id/resumen')
  @Roles(...OFICINA)
  @ApiOperation({
    summary:
      'Resumen del producto: bloques COMPRAS | VENTAS (los mismos del cardex libro), RESUMEN por día (existencia al cierre + utilidad del día) y totales — mismo FIFO/ganancia que la hoja Inventario del Balance general. Montos en MXN. desde/hasta opcionales (YYYY-MM-DD, día Cancún).',
  })
  resumenItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ResumenItemQuery,
  ) {
    return this.inventory.resumenItem(id, q);
  }

  @Get('items/:id')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Item detail with cardex + FIFO stats + empaques' })
  getItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getItemDetail(id);
  }

  @Patch('items/:id')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({ summary: 'Update inventory item (ADMIN or MECANICO)' })
  updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventarioItemDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.updateItem(id, dto, c.userId);
  }

  @Delete('items/:id')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Soft delete item (activo=false). Libera su código de barras y desactiva sus empaques (liberando también sus códigos); queda rastro en notas.',
  })
  removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.softDeleteItem(id, c.userId);
  }

  // ===== Empaques (cajas) del ítem =====

  @Post('items/:id/empaques')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Agrega un empaque (caja de N) al ítem: nombre, factor (unidades por empaque) y su código de barras opcional (distinto al de la unidad).',
  })
  createEmpaque(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EmpaqueInputDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.createEmpaque(id, dto, c.userId);
  }

  @Patch('items/:id/empaques/:empaqueId')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary: 'Edita un empaque (nombre, factor, código, activo)',
  })
  updateEmpaque(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('empaqueId', ParseUUIDPipe) empaqueId: string,
    @Body() dto: UpdateEmpaqueDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.updateEmpaque(id, empaqueId, dto, c.userId);
  }

  @Delete('items/:id/empaques/:empaqueId')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Borra un empaque sin movimientos. 409 si ya se usó en el cardex: desactívalo (activo=false).',
  })
  removeEmpaque(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('empaqueId', ParseUUIDPipe) empaqueId: string,
  ) {
    return this.inventory.deleteEmpaque(id, empaqueId);
  }

  @Post('items/:id/movimientos')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Register a cardex movement. SALIDA computes FIFO cost and requires aeronave_id. Por empaque: empaque_id + cantidad_empaques (cantidad = empaques × factor, en unidades).',
  })
  createMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.createMovimiento(id, dto, c.userId);
  }

  @Patch('items/:id/movimientos/:movId')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Corrige el COSTO de una ENTRADA (moneda/costo/TC; cantidad/fecha/tipo jamás). 409 si nace de una compra (se corrige desde la compra) o si el FIFO ya consumió unidades de esa capa.',
  })
  updateCostoMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('movId', ParseUUIDPipe) movId: string,
    @Body() dto: UpdateMovimientoCostoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.updateCostoEntrada(id, movId, dto, c.userId);
  }
}
