import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { ListUsuariosQuery } from './dto/list-usuarios.query';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'List users (admin only)' })
  list(@Query() query: ListUsuariosQuery) {
    return this.users.list(query);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Create / invite user. supabase_auth_id queda null hasta el primer login. Útil para pre-cargar pilotos antes de que se logueen con Google.',
  })
  create(@Body() dto: CreateUsuarioDto, @CurrentUser() current: AuthenticatedUser) {
    return this.users.create(dto, current.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by id (admin or self)' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    if (current.rol !== Rol.ADMIN && current.userId !== id) {
      throw new ForbiddenException('Only ADMIN can view other users');
    }
    return this.users.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary: 'Update user (admin only — includes rol, estado, fondo)',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUsuarioDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.users.update(id, body, current.userId);
  }

  @Post(':id/reset-password')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Define / restablece la contraseña del usuario en Supabase Auth. Si el usuario aún no tiene auth account (INVITADO sin login), crea una con email+password.',
  })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.users.resetPassword(id, dto.password, current.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (sets estado=INACTIVO). Admin only.' })
  async softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    if (current.userId === id) {
      throw new ForbiddenException('Cannot deactivate yourself');
    }
    return this.users.softDelete(id, current.userId);
  }
}
