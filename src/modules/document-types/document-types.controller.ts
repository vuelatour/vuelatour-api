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
import { DocumentTypesService } from './document-types.service';
import {
  CreateTipoDocumentoDto,
  ListTiposDocumentoQuery,
  UpdateTipoDocumentoDto,
} from './dto/document-types.dto';

@ApiTags('Document Types')
@ApiBearerAuth()
@Controller({ path: 'document-types', version: '1' })
export class DocumentTypesController {
  constructor(private readonly tipos: DocumentTypesService) {}

  @Get()
  @ApiOperation({
    summary: 'List document types (lista maestra de vencimientos)',
  })
  list(@Query() q: ListTiposDocumentoQuery) {
    return this.tipos.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create document type (ADMIN)' })
  create(
    @Body() dto: CreateTipoDocumentoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.tipos.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get document type' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tipos.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update document type (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTipoDocumentoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.tipos.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.tipos.softDelete(id, c.userId);
  }
}
