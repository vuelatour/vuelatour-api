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
  CreateBankMovementDto,
  ListBankMovementsQuery,
  ReconcileBankMovementDto,
  UpdateBankMovementDto,
} from './dto/bank-movements.dto';
import { BankMovementsService } from './bank-movements.service';

@ApiTags('Bank Movements')
@ApiBearerAuth()
@Controller({ path: 'bank-movements', version: '1' })
export class BankMovementsController {
  constructor(private readonly movements: BankMovementsService) {}

  @Get()
  @ApiOperation({
    summary: 'List bank movements (conciliado=false = bandeja pendiente)',
  })
  list(@Query() q: ListBankMovementsQuery) {
    return this.movements.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'Create bank movement (ADMIN / FACTURACION)' })
  create(
    @Body() dto: CreateBankMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get bank movement' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.movements.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'Update bank movement (ADMIN / FACTURACION)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.update(id, dto, c.userId);
  }

  @Patch(':id/reconcile')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({ summary: 'Reconcile movement with a gasto' })
  reconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileBankMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.reconcile(id, dto.gasto_id, c.userId);
  }

  @Patch(':id/unreconcile')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({ summary: 'Undo reconciliation' })
  unreconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.unreconcile(id, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete bank movement (ADMIN / FACTURACION)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.movements.remove(id);
  }
}
