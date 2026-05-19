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
  CreateInventoryItemDto,
  ListInventoryItemsQuery,
  UpdateInventoryItemDto,
} from './dto/inventory-items.dto';
import { InventoryItemsService } from './inventory-items.service';
import { InventoryMovementsService } from './inventory-movements.service';

@ApiTags('Inventory Items')
@ApiBearerAuth()
@Controller({ path: 'inventory-items', version: '1' })
export class InventoryItemsController {
  constructor(
    private readonly items: InventoryItemsService,
    private readonly movements: InventoryMovementsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List inventory items with computed stock' })
  list(@Query() q: ListInventoryItemsQuery) {
    return this.items.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create inventory item (ADMIN)' })
  create(
    @Body() dto: CreateInventoryItemDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.items.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get inventory item with stock' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.items.findById(id);
  }

  @Get(':id/cardex')
  @ApiOperation({ summary: 'Cardex (movement history with running balance)' })
  cardex(@Param('id', ParseUUIDPipe) id: string) {
    return this.movements.cardex(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update inventory item (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventoryItemDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.items.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.items.softDelete(id, c.userId);
  }
}
