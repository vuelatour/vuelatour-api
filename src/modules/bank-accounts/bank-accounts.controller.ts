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

  /**
   * Opciones para el selector «Cuenta de donde salió» del gasto (20-oct-2026,
   * invariante 98): SIN número de cuenta ni CLABE (solo la terminación), para
   * toda la oficina (la coordinación también captura gastos). Va ANTES de
   * `:id` (si no, `ParseUUIDPipe` respondería 400 a «opciones»).
   */
  @Get('opciones')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Bank account options for the expense form (office roles)',
  })
  opciones(@Query('incluir_inactivas') incluirInactivas?: string) {
    return this.accounts.opciones(
      incluirInactivas === 'true' || incluirInactivas === '1',
    );
  }

  @Post()
  // Toda la oficina da de alta una cuenta desde el gasto (decisión del
  // cliente 20-oct-2026); editar y dar de baja siguen siendo de ADMIN.
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Create bank account (office roles)' })
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
