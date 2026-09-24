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
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { LIMITE_MULTER_FACTURA_BYTES } from '../flights/factura-cliente.util';
import {
  ExportFacturasEmitidasQuery,
  FacturaEmitidaMultipartDto,
  FacturaEmitidaPatchMultipartDto,
  LeerArchivoFacturaDto,
  ListFacturasEmitidasQuery,
  MotivoFacturaDto,
  SinCamposDto,
  TipoArchivoQuery,
  VuelosCandidatosQuery,
} from './dto/facturas-emitidas.dto';
import {
  FacturasEmitidasService,
  type ArchivosFactura,
} from './facturas-emitidas.service';

/**
 * Interceptor multipart del registro: campos `pdf` y `xml` (uno cada uno).
 * Multer corta con 1 MB de margen sobre los 10 MB de negocio para que el
 * servicio diga el peso EXACTO (413 ARCHIVO_MUY_GRANDE).
 */
const ArchivosFacturaInterceptor = () =>
  FileFieldsInterceptor(
    [
      { name: 'pdf', maxCount: 1 },
      { name: 'xml', maxCount: 1 },
    ],
    { limits: { fileSize: LIMITE_MULTER_FACTURA_BYTES } },
  );

/**
 * FACTURAS EMITIDAS (registro manual, 24-sep-2026). Solo administración y
 * facturación (`@Roles` de CLASE — el RolesGuard es default-abierto); ver el
 * PDF también lo puede coordinación (`archivo-url`). ORDEN: las rutas
 * literales van ANTES de `:id` (convención del repo).
 */
@ApiTags('Facturas emitidas')
@ApiBearerAuth()
@Roles(Rol.ADMIN, Rol.FACTURACION)
@Controller({ path: 'facturas-emitidas', version: '1' })
export class FacturasEmitidasController {
  constructor(private readonly svc: FacturasEmitidasService) {}

  @Get('por-facturar/conteo')
  @ApiOperation({
    summary:
      'Conteo barato para el badge del menú: { por_facturar, paga_contra_factura }.',
  })
  conteoPorFacturar() {
    return this.svc.conteoPorFacturar();
  }

  @Get('por-facturar')
  @ApiOperation({
    summary:
      'Vuelos con «Necesito factura» sin factura VIGENTE registrada (ni CFDI del PAC), primero los que pagan contra factura y luego la solicitud más vieja. { data: PorFacturarItem[], count }.',
  })
  porFacturar() {
    return this.svc.porFacturar();
  }

  @Get('export.xlsx')
  @ApiOperation({
    summary:
      'Excel del registro con los MISMOS filtros de la lista (sin paginar), orden por número.',
  })
  async exportXlsx(
    @Query() q: ExportFacturasEmitidasQuery,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.svc.exportXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('vuelos-candidatos')
  @ApiOperation({
    summary:
      'Selector de vuelos del diálogo: ?q= (#folio incluye cancelados, fecha = día Cancún, texto = cliente), ?ids= (hidratar) o ?grupo_id= (hijos no cancelados). Máximo 20.',
  })
  vuelosCandidatos(@Query() q: VuelosCandidatosQuery) {
    return this.svc.vuelosCandidatos(q);
  }

  @Post('leer-archivo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ArchivosFacturaInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Lee el PDF y/o XML SIN guardar: campos para prellenar, «ya registrada», cliente sugerido, emisora y avisos. El XML manda; el PDF lo lee pyservices (si falla: campos vacíos + aviso, nunca 500).',
  })
  leerArchivo(
    @UploadedFiles() files: ArchivosFactura | undefined,
    // Sin campos de texto: cualquiera ⇒ 400 (forbidNonWhitelisted).
    @Body() _dto: LeerArchivoFacturaDto,
  ) {
    void _dto;
    return this.svc.leerArchivo(files);
  }

  @Get()
  @ApiOperation({
    summary:
      'Registro de facturas emitidas a mano: filtros, orden por número (folio_desc por defecto), alertas por fila, resumen GLOBAL con huecos de numeración y totales del filtro.',
  })
  lista(@Query() q: ListFacturasEmitidasQuery) {
    return this.svc.lista(q);
  }

  @Post()
  @UseInterceptors(ArchivosFacturaInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Registra una factura: campo de texto `datos` (JSON) + archivos `pdf`/`xml`. 409 FACTURA_DUPLICADA / UUID_DUPLICADO con la existente; 422 XML_NO_CUADRA / XML_ILEGIBLE / XML_NO_PERMITIDO. 201 { factura, avisos }.',
  })
  crear(
    @UploadedFiles() files: ArchivosFactura | undefined,
    @Body() dto: FacturaEmitidaMultipartDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.crear(dto.datos, files, {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Una factura (404 FACTURA_NO_EXISTE si se eliminó).',
  })
  obtener(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.obtener(id);
  }

  @Patch(':id')
  @UseInterceptors(ArchivosFacturaInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Edita (mismo formato multipart; todo opcional). `vuelo_ids` REEMPLAZA el conjunto; archivos nuevos reemplazan (el anterior queda en el historial, nunca se borra). 400 NADA_QUE_CAMBIAR.',
  })
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: ArchivosFactura | undefined,
    @Body() dto: FacturaEmitidaPatchMultipartDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.editar(id, dto?.datos ?? '{}', files, {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Elimina el REGISTRO (soft delete, body { motivo }): libera el número; los archivos se conservan. { ok, id, avisos }. La UI confirma.',
  })
  eliminar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
    @Body() dto?: MotivoFacturaDto,
  ) {
    return this.svc.eliminar(id, dto?.motivo, {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancela la factura (body { motivo }): conserva número y archivos. 409 FACTURA_YA_CANCELADA. Avisos VUELO_SIGUE_FACTURADO.',
  })
  cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoFacturaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.cancelar(id, dto?.motivo, {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Post(':id/reactivar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Regresa a VIGENTE una factura cancelada. 409 FACTURA_NO_CANCELADA.',
  })
  reactivar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.reactivar(id, { userId: c.userId, nombre: c.nombre });
  }

  @Post(':id/archivo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(ArchivosFacturaInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Reemplaza el PDF y/o el XML (el anterior se CONSERVA en el bucket y queda en el historial). 400 SIN_ARCHIVO; 422 XML_NO_CUADRA.',
  })
  reemplazarArchivo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: ArchivosFactura | undefined,
    @Body() _dto: SinCamposDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    void _dto;
    return this.svc.reemplazarArchivos(id, files, {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Delete(':id/archivo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quita el PDF o XML (?tipo=pdf|xml) del registro SIN borrar el objeto del bucket (incidente #297). 404 ARCHIVO_NO_EXISTE.',
  })
  quitarArchivo(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: TipoArchivoQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.quitarArchivo(id, q.tipo ?? 'pdf', {
      userId: c.userId,
      nombre: c.nombre,
    });
  }

  @Get(':id/archivo-url')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'URL firmada (600 s) del PDF o XML (?tipo=pdf|xml): { url, nombre }. 404 ARCHIVO_NO_EXISTE.',
  })
  archivoUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: TipoArchivoQuery,
  ) {
    return this.svc.archivoUrl(id, q.tipo ?? 'pdf');
  }
}
