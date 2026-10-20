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
  CreateProveedorDto,
  ListProveedoresQuery,
  UpdateProveedorDto,
} from './dto/providers.dto';
import { ProvidersService } from './providers.service';

@ApiTags('Providers')
@ApiBearerAuth()
@Controller({ path: 'providers', version: '1' })
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'List providers' })
  list(@Query() q: ListProveedoresQuery) {
    return this.providers.list(q);
  }

  @Post()
  // Toda la oficina crea y corrige proveedores desde el gasto (decisión del
  // cliente 20-oct-2026, invariante 98); dar de baja sigue siendo de
  // ADMIN/FACTURACION.
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Create provider (office roles)' })
  create(@Body() dto: CreateProveedorDto, @CurrentUser() c: AuthenticatedUser) {
    return this.providers.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get provider' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.providers.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update provider (office roles)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProveedorDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.providers.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.providers.softDelete(id, c.userId);
  }
}
