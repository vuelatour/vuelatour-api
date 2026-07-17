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
  CreateIssuingEntityDto,
  ListIssuingEntitiesQuery,
  UpdateIssuingEntityDto,
  UploadCsdDto,
} from './dto/issuing-entities.dto';
import { IssuingEntitiesService } from './issuing-entities.service';

@ApiTags('IssuingEntities')
@ApiBearerAuth()
@Controller({ path: 'issuing-entities', version: '1' })
export class IssuingEntitiesController {
  constructor(private readonly entities: IssuingEntitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'List razones sociales emisoras (Aerocharter, Aerodinamica)',
  })
  list(@Query() q: ListIssuingEntitiesQuery) {
    return this.entities.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create issuing entity (ADMIN)' })
  create(
    @Body() dto: CreateIssuingEntityDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.entities.create(dto, c.userId);
  }

  @Get('codigo/:codigo')
  @ApiOperation({ summary: 'Get entity by code (AEROCHARTER | AERODINAMICA)' })
  getByCodigo(@Param('codigo') codigo: string) {
    return this.entities.findByCodigo(codigo);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get entity' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.entities.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update entity (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIssuingEntityDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.entities.update(id, dto, c.userId);
  }

  @Post(':id/csd')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary: 'Sube el CSD (.cer/.key en base64) de la emisora (ADMIN)',
  })
  uploadCsd(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadCsdDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.entities.uploadCsd(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activa=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.entities.softDelete(id, c.userId);
  }
}
