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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateClienteDto,
  ListClientesQuery,
  SetTarifasClienteDto,
  UpdateClienteDto,
} from './dto/clients.dto';
import { ClientsService } from './clients.service';

@ApiTags('Clients')
@ApiBearerAuth()
@Controller({ path: 'clients', version: '1' })
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @ApiOperation({ summary: 'List clients (any active user)' })
  list(@Query() q: ListClientesQuery) {
    return this.clients.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Create client (ADMIN or COORDINADOR)' })
  create(@Body() dto: CreateClienteDto, @CurrentUser() c: AuthenticatedUser) {
    return this.clients.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get client' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.clients.findById(id);
  }

  @Get(':id/tarifas')
  // Tarifas negociadas = pricing: mismo set de roles que quotes (sin pilotos).
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Tarifas preferenciales por aeronave del cliente (no accesible a pilotos)',
  })
  listTarifas(@Param('id', ParseUUIDPipe) id: string) {
    return this.clients.listTarifas(id);
  }

  @Put(':id/tarifas')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Reemplaza el set de tarifas preferenciales (ADMIN o COORDINADOR)',
  })
  setTarifas(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTarifasClienteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.clients.setTarifas(id, dto, c.userId);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update client (ADMIN or COORDINADOR)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.clients.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.clients.softDelete(id, c.userId);
  }
}
