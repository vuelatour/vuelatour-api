import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateInventoryMovementDto,
  ListInventoryMovementsQuery,
} from './dto/inventory-movements.dto';
import { InventoryMovementsService } from './inventory-movements.service';

@ApiTags('Inventory Movements')
@ApiBearerAuth()
@Controller({ path: 'inventory-movements', version: '1' })
export class InventoryMovementsController {
  constructor(private readonly movements: InventoryMovementsService) {}

  @Get()
  @ApiOperation({ summary: 'List inventory movements (cardex)' })
  list(@Query() q: ListInventoryMovementsQuery) {
    return this.movements.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary: 'Register a movement. SALIDA/AJUSTE cost is FIFO-computed.',
  })
  create(
    @Body() dto: CreateInventoryMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.create(dto, c.userId);
  }
}
