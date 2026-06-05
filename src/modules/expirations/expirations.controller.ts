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
  CreateVencimientoDto,
  ExtraerVencimientoDto,
  ListVencimientosQuery,
  UpdateVencimientoDto,
} from './dto/expirations.dto';
import { ExpirationsClient } from './expirations.client';
import { ExpirationsService } from './expirations.service';

@ApiTags('Expirations')
@ApiBearerAuth()
@Controller({ path: 'expirations', version: '1' })
export class ExpirationsController {
  constructor(
    private readonly expirations: ExpirationsService,
    private readonly extractor: ExpirationsClient,
  ) {}

  @Post('extraer')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Extrae por IA los datos de un documento de vencimiento renovado (PDF/imagen) para pre-llenar el alta. Best-effort: si la IA no está disponible regresa disponible=false.',
  })
  async extraer(@Body() dto: ExtraerVencimientoDto) {
    const result = await this.extractor.extraer({
      pdfBase64: dto.pdfBase64,
      imageBase64: dto.imageBase64,
      mediaType: dto.mediaType,
    });
    if (!result) return { disponible: false };
    return { disponible: true, ...result };
  }

  @Get()
  @ApiOperation({
    summary:
      'List expirations with computed estado (VIGENTE/PROXIMO/VENCIDO/...)',
  })
  list(@Query() q: ListVencimientosQuery) {
    return this.expirations.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create expiration record (ADMIN)' })
  create(
    @Body() dto: CreateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expirations.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get expiration with computed estado' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.expirations.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update expiration (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expirations.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete expiration record (ADMIN)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.expirations.remove(id);
  }
}
