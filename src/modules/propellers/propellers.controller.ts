import {
  Body,
  Controller,
  Delete,
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
  CreatePropellerDto,
  ListPropellersQuery,
  OverhaulPropellerDto,
  TransplantPropellerDto,
  UpdatePropellerDto,
} from './dto/propellers.dto';
import { PropellersService } from './propellers.service';

@ApiTags('Propellers')
@ApiBearerAuth()
@Controller({ path: 'propellers', version: '1' })
export class PropellersController {
  constructor(private readonly propellers: PropellersService) {}

  @Get()
  @ApiOperation({ summary: 'List propellers' })
  list(@Query() q: ListPropellersQuery) {
    return this.propellers.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create propeller (ADMIN)' })
  create(@Body() dto: CreatePropellerDto, @CurrentUser() c: AuthenticatedUser) {
    return this.propellers.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get propeller' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.propellers.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update propeller (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePropellerDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.propellers.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Delete propeller (ADMIN)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.propellers.remove(id);
  }

  @Post(':id/transplant')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Move propeller to another aircraft (ADMIN). La vida viaja con la hélice; queda en bitácora.',
  })
  transplant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransplantPropellerDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.propellers.transplant(id, dto, c.userId);
  }

  @Post(':id/overhaul')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Registrar overhaul (ADMIN): TSO a 0, TSN congelado, ancla al Hobbs actual; queda en bitácora.',
  })
  overhaul(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OverhaulPropellerDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.propellers.overhaul(id, dto, c.userId);
  }

  @Get(':id/eventos')
  @ApiOperation({
    summary:
      'Bitácora de la hélice: instalaciones, traslados, overhauls y ajustes de base.',
  })
  eventos(@Param('id', ParseUUIDPipe) id: string) {
    return this.propellers.listEventos(id);
  }
}
