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
  CreateBankAccountDto,
  ListBankAccountsQuery,
  UpdateBankAccountDto,
} from './dto/bank-accounts.dto';
import { BankAccountsService } from './bank-accounts.service';

@ApiTags('BankAccounts')
@ApiBearerAuth()
@Controller({ path: 'bank-accounts', version: '1' })
export class BankAccountsController {
  constructor(private readonly accounts: BankAccountsService) {}

  @Get()
  // CLABE/número de cuenta = dato sensible. Mismos roles que las páginas del
  // panel que las consumen (Cuentas bancarias, Conciliación y Tarjetas corp.
  // son ADMIN/FACTURACION); la app del piloto/mecánico no las usa.
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'List bank accounts (ADMIN/FACTURACION)' })
  list(@Query() q: ListBankAccountsQuery) {
    return this.accounts.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create bank account (ADMIN)' })
  create(
    @Body() dto: CreateBankAccountDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.accounts.create(dto, c.userId);
  }

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'Get bank account (ADMIN/FACTURACION)' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update bank account (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankAccountDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.accounts.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activa=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.accounts.softDelete(id, c.userId);
  }
}
