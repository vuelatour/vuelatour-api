import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
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
import { CreateRouteDto, ListRoutesQuery, UpdateRouteDto } from './dto/routes.dto';
import { RoutesService } from './routes.service';

@ApiTags('Routes')
@ApiBearerAuth()
@Controller({ path: 'routes', version: '1' })
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @ApiOperation({ summary: 'List predefined routes' })
  list(@Query() q: ListRoutesQuery) {
    return this.routes.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Create route (ADMIN or COORDINADOR)' })
  create(@Body() dto: CreateRouteDto, @CurrentUser() c: AuthenticatedUser) {
    return this.routes.create(dto, c.userId);
  }

  @Get('search')
  @ApiQuery({ name: 'origen', required: true, example: 'CUN' })
  @ApiQuery({ name: 'destino', required: true, example: 'CZM' })
  @ApiOperation({ summary: 'Find route by exact origen+destino (404 if none)' })
  async search(
    @Query('origen') origen: string,
    @Query('destino') destino: string,
  ) {
    if (!origen || !destino) {
      throw new BadRequestException('origen and destino are required');
    }
    const r = await this.routes.findByOriginDestination(origen, destino);
    if (!r) throw new NotFoundException(`No route ${origen}-${destino}`);
    return r;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get route' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.routes.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update route (ADMIN or COORDINADOR)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRouteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.routes.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activa=false)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.routes.softDelete(id, c.userId);
  }
}
