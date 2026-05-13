import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CreateAeronaveDto } from './dto/create-aeronave.dto';
import { ListAeronavesQuery } from './dto/list-aeronaves.query';
import { UpdateAeronaveDto } from './dto/update-aeronave.dto';
import {
  CreateAeronaveSocioDto,
  UpdateAeronaveSocioDto,
} from './dto/upsert-aeronave-socio.dto';
import { AircraftService } from './aircraft.service';

@ApiTags('Aircraft')
@ApiBearerAuth()
@Controller({ path: 'aircraft', version: '1' })
export class AircraftController {
  constructor(private readonly aircraft: AircraftService) {}

  @Get()
  @ApiOperation({ summary: 'List aircraft' })
  list(@Query() q: ListAeronavesQuery) {
    return this.aircraft.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create aircraft (ADMIN)' })
  create(@Body() dto: CreateAeronaveDto, @CurrentUser() current: AuthenticatedUser) {
    return this.aircraft.create(dto, current.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one aircraft' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.findById(id);
  }

  @Get(':id/snapshot')
  @ApiOperation({ summary: 'Aircraft with engines, propellers, active owners and overhaul reserves' })
  snapshot(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.getSnapshot(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update aircraft (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAeronaveDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.update(id, dto, current.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate aircraft (sets activa=false). ADMIN.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.softDelete(id, current.userId);
  }

  // ============ Ownership ============

  @Get(':id/owners')
  @ApiQuery({ name: 'history', required: false, type: Boolean, description: 'Include closed shares' })
  @ApiOperation({ summary: 'List ownership shares (active by default)' })
  listOwners(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('history', new ParseBoolPipe({ optional: true })) history = false,
  ) {
    return this.aircraft.listOwners(id, history);
  }

  @Post(':id/owners')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Add ownership share (ADMIN). Caller closes prior shares manually.' })
  createOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAeronaveSocioDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.createOwner(id, dto, current.userId);
  }

  @Patch('owners/:ownerId')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update an ownership share (ADMIN)' })
  updateOwner(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Body() dto: UpdateAeronaveSocioDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.updateOwner(ownerId, dto, current.userId);
  }

  @Delete('owners/:ownerId')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close ownership share with today as vigente_hasta (ADMIN)' })
  closeOwner(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    if (!current) throw new ForbiddenException();
    return this.aircraft.closeOwner(ownerId, new Date(), current.userId);
  }

  // ============ Overhaul reserves ============

  @Get(':id/overhaul-reserves')
  @ApiOperation({ summary: 'Overhaul reserves per engine for this aircraft' })
  listReserves(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.listOverhaulReserves(id);
  }
}
