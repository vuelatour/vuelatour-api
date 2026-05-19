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
import { CreateFundDto, ListFundsQuery, UpdateFundDto } from './dto/funds.dto';
import { FundsService } from './funds.service';

@ApiTags('Cash Funds')
@ApiBearerAuth()
@Controller({ path: 'cash-funds', version: '1' })
export class FundsController {
  constructor(private readonly funds: FundsService) {}

  @Get()
  @ApiOperation({ summary: 'List cash funds with computed balance' })
  list(@Query() q: ListFundsQuery) {
    return this.funds.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'Create cash fund (ADMIN / FACTURACION)' })
  create(@Body() dto: CreateFundDto, @CurrentUser() c: AuthenticatedUser) {
    return this.funds.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get cash fund with balance' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.funds.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({ summary: 'Update cash fund (ADMIN / FACTURACION)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFundDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.funds.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.funds.softDelete(id, c.userId);
  }
}
