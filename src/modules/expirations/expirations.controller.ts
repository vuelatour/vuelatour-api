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
  // Metadatos internos (folios de póliza, aseguradora, fechas): oficina y
  // MECÁNICO (su menú del panel incluye Vencimientos — servicios por horas).
  // PILOTO queda fuera; el detalle del avión usa GET /engineering/... .
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary:
      'List expirations with computed estado (VIGENTE/PROXIMO/VENCIDO/...)',
  })
  list(@Query() q: ListVencimientosQuery) {
    return this.expirations.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Create expiration record (ADMIN)' })
  create(
    @Body() dto: CreateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expirations.create(dto, c.userId);
  }

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({ summary: 'Get expiration with computed estado' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.expirations.findById(id);
  }

  @Get(':id/archivo')
  // Documentos sensibles (licencias/seguros): SOLO oficina — el bucket es
  // privado y esta firma usa service key. Sin @Roles, cualquier autenticado
  // (piloto/mecánico con su JWT) podría descargarlos.
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'URL firmada (1 h) de la copia del documento en el bucket privado documentos-flota. 404 si el vencimiento no tiene archivo.',
  })
  archivo(@Param('id', ParseUUIDPipe) id: string) {
    return this.expirations.archivoSignedUrl(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update expiration (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expirations.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete expiration record (ADMIN)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.expirations.remove(id);
  }
}
