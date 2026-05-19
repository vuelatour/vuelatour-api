import {
  Body,
  Controller,
  Get,
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
  CreateFundMovementDto,
  ListFundMovementsQuery,
  ResolveFundMovementDto,
} from './dto/fund-movements.dto';
import { FundMovementsService } from './fund-movements.service';

@ApiTags('Cash Fund Movements')
@ApiBearerAuth()
@Controller({ path: 'fund-movements', version: '1' })
export class FundMovementsController {
  constructor(private readonly movements: FundMovementsService) {}

  @Get()
  @ApiOperation({ summary: 'List fund movements (reposiciones / reintegros)' })
  list(@Query() q: ListFundMovementsQuery) {
    return this.movements.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR, Rol.ANALISTA, Rol.PILOTO)
  @ApiOperation({ summary: 'Request a movement (estado SOLICITADO)' })
  create(
    @Body() dto: CreateFundMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.create(dto, c.userId);
  }

  @Patch(':id/resolve')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Authorize or reject a movement (ADMIN — Ale)' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveFundMovementDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.movements.resolve(id, dto, c.userId);
  }
}
