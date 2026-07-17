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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CancelarFacturaDto,
  AmarrarGastosDto,
  CrearRecibidaDto,
  EmitirFacturaDto,
  FacturaFileUrlsDto,
  ListFacturasQuery,
  ListPendientesQuery,
  ListRecibidasQuery,
  NotaCreditoDto,
  RecibidaFileUrlsDto,
  UpdateRecibidaDto,
} from './dto/invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller({ path: 'invoices', version: '1' })
@Roles(Rol.ADMIN, Rol.FACTURACION)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('pending')
  @ApiOperation({
    summary: 'Vuelos pagados pendientes de facturar (filtros: fecha, cliente).',
  })
  pending(@Query() q: ListPendientesQuery) {
    return this.invoices.listPendientes(q);
  }

  @Get('pac-health')
  @ApiOperation({
    summary: 'Prueba la conexión/credenciales con el PAC sin consumir timbres.',
  })
  pacHealth() {
    return this.invoices.pacHealth();
  }

  @Get()
  @ApiOperation({
    summary: 'Facturas emitidas (filtros: estado, entidad emisora).',
  })
  list(@Query() q: ListFacturasQuery) {
    return this.invoices.listFacturas(q);
  }

  @Get('cierre')
  @ApiOperation({
    summary:
      'Paquete de cierre mensual (.zip): reporte por avión en Excel + XML/PDF de facturas',
  })
  async cierre(
    @Query('desde') desde: string,
    @Query('hasta') hasta: string,
  ): Promise<StreamableFile> {
    const { buffer } = await this.invoices.cierreZip(desde, hasta);
    return new StreamableFile(buffer, {
      type: 'application/zip',
      disposition: `attachment; filename="cierre-${desde}-a-${hasta}.zip"`,
    });
  }

  @Post('emitir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Emite (timbra) el CFDI de un vuelo con la entidad emisora indicada.',
  })
  emitir(@Body() dto: EmitirFacturaDto, @CurrentUser() c: AuthenticatedUser) {
    return this.invoices.emitir(dto, c.userId);
  }

  // Ruta literal ANTES de las rutas ':id' (convención del repo): Nest evalúa
  // en orden de declaración y 'preview' no debe caer en un handler por id.
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Vista previa del PDF del CFDI SIN timbrar: mismo body que /emitir y mismos datos (no marca facturado ni toca la BD).',
  })
  async preview(@Body() dto: EmitirFacturaDto): Promise<StreamableFile> {
    const pdf = await this.invoices.preview(dto);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: 'inline; filename="factura-preview.pdf"',
    });
  }

  @Post('nota-credito')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Emite una nota de crédito (CFDI Egreso) relacionada a una factura.',
  })
  notaCredito(
    @Body() dto: NotaCreditoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.emitirNotaCredito(dto, c.userId);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela un CFDI timbrado ante el SAT (con motivo SAT).',
  })
  cancelar(
    @Param('id') id: string,
    @Body() dto: CancelarFacturaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.cancelar(id, dto, c.userId);
  }

  @Post('file-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Firma URLs de XML/PDF de facturas (bucket privado) para descarga.',
  })
  fileUrls(@Body() dto: FacturaFileUrlsDto) {
    return this.invoices.signFacturaFiles(dto.paths);
  }

  // ============ Facturas recibidas (buzón) ============

  @Get('recibidas')
  @ApiOperation({
    summary: 'Lista de facturas recibidas (CFDI de proveedores).',
  })
  listRecibidas(@Query() q: ListRecibidasQuery) {
    return this.invoices.listRecibidas(q);
  }

  @Post('recibidas')
  @ApiOperation({
    summary: 'Sube un XML de CFDI recibido: lo parsea y lo registra.',
  })
  crearRecibida(
    @Body() dto: CrearRecibidaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.crearRecibida(dto.xml_b64, c.userId);
  }

  @Patch('recibidas/:id')
  @ApiOperation({
    summary: 'Amarra/actualiza una factura recibida (gasto, avión, estado).',
  })
  updateRecibida(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecibidaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.updateRecibida(id, dto, c.userId);
  }

  @Post('recibidas/:id/amarrar-gastos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Amarra la factura a VARIOS gastos (VIP SAESA: una factura ampara varios aterrizajes). Reemplaza el amarre anterior; lista vacía = desamarrar.',
  })
  amarrarGastos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmarrarGastosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.amarrarGastos(id, dto.gasto_ids, c.userId);
  }

  @Delete('recibidas/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina una factura recibida del buzón.' })
  deleteRecibida(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.deleteRecibida(id);
  }

  @Post('recibidas/file-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Firma URLs de los XML recibidos (bucket privado).',
  })
  recibidaFileUrls(@Body() dto: RecibidaFileUrlsDto) {
    return this.invoices.signFacturaFiles(dto.paths);
  }
}
