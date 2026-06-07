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
  ListInventarioQuery,
  ListMovimientosQuery,
  UpdateInventarioItemDto,
} from './dto/inventory.dto';
import { ExtraerCompraDto, ImportarCompraDto } from './dto/compras.dto';
import { InventoryService } from './inventory.service';
import { ComprasService } from './compras.service';

const OFICINA = [
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.ANALISTA,
  Rol.FACTURACION,
  Rol.SOCIO,
  Rol.MECANICO,
];

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly compras: ComprasService,
  ) {}

  @Post('compras/extraer')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extrae líneas de producto de un PDF de compra (IA)' })
  extraerCompra(@Body() dto: ExtraerCompraDto) {
    return this.compras.extraer(dto);
  }

  @Post('compras/importar')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({ summary: 'Crea ítems (si faltan) y registra entradas desde una compra' })
  importarCompra(@Body() dto: ImportarCompraDto, @CurrentUser() c: AuthenticatedUser) {
    return this.compras.importar(dto, c.userId);
  }

  @Get('items')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'List inventory items with computed stock + valuation' })
  listItems(@Query() q: ListInventarioQuery) {
    return this.inventory.listItems(q);
  }

  @Get('items/export')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Inventario valorizado en Excel (respeta filtros)' })
  async exportItems(@Query() q: ListInventarioQuery): Promise<StreamableFile> {
    const buffer = await this.inventory.itemsXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="inventario-valorizado.xlsx"',
    });
  }

  @Post('items')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({ summary: 'Create inventory item (ADMIN or MECANICO)' })
  createItem(@Body() dto: CreateInventarioItemDto, @CurrentUser() c: AuthenticatedUser) {
    return this.inventory.createItem(dto, c.userId);
  }

  @Get('movimientos')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Cardex: list inventory movements (filterable)' })
  listMovimientos(@Query() q: ListMovimientosQuery) {
    return this.inventory.listMovimientos(q);
  }

  @Get('items/:id')
  @Roles(...OFICINA)
  @ApiOperation({ summary: 'Item detail with cardex + FIFO stats' })
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
  @ApiOperation({ summary: 'Soft delete item (activo=false)' })
  removeItem(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.inventory.softDeleteItem(id, c.userId);
  }

  @Post('items/:id/movimientos')
  @Roles(Rol.ADMIN, Rol.MECANICO)
  @ApiOperation({
    summary: 'Register a cardex movement. SALIDA computes FIFO cost and requires aeronave_id.',
  })
  createMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.inventory.createMovimiento(id, dto, c.userId);
  }
}
