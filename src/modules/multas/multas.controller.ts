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
import { CreateMultaDto, ListMultasQuery, UpdateMultaDto } from './dto/multas.dto';
import { MultasService } from './multas.service';

@ApiTags('Multas')
@ApiBearerAuth()
@Controller({ path: 'multas', version: '1' })
export class MultasController {
  constructor(private readonly multas: MultasService) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({ summary: 'Lista de multas (filtros: avión, piloto, estado).' })
  list(@Query() q: ListMultasQuery) {
    return this.multas.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Registra una multa.' })
  create(@Body() dto: CreateMultaDto, @CurrentUser() c: AuthenticatedUser) {
    return this.multas.create(dto, c.userId);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Actualiza una multa.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMultaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.multas.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina una multa.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.multas.remove(id);
  }
}
