import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CalculateQuoteDto } from './dto/calculate-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { CancelQuoteDto, ListQuotesQuery } from './dto/list-quotes.query';
import {
  PdfPresentacionVueloDto,
  PdfVisibilidadDto,
} from './dto/pdf-visibilidad.dto';
import { PreviewQuoteDto } from './dto/preview-quote.dto';
import { QuickAdjustQuoteDto } from './dto/quick-adjust.dto';
import { ReviseQuoteDto } from './dto/revise-quote.dto';
import { QuotesService } from './quotes.service';
import { QuotesPdfService } from './quotes-pdf.service';
import { QuotesPdfInternoService } from './quotes-pdf-interno.service';

@ApiTags('Quotes')
@ApiBearerAuth()
@Controller({ path: 'quotes', version: '1' })
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly quotesPdf: QuotesPdfService,
    private readonly quotesPdfInterno: QuotesPdfInternoService,
  ) {}

  @Post('calculate')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Compute a quote without persisting. Returns the full breakdown (tiempos, tarifa, TUAS por aeropuerto, IVA, total USD).',
  })
  calculate(@Body() dto: CalculateQuoteDto) {
    return this.quotes.calculate(dto);
  }

  // Ruta LITERAL antes de ':id' (convención del repo).
  @Post('preview-html')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Vista previa HTML de la HOJA 1 del PDF del cliente (rediseño del cotizador, 8-sep-2026): mismo payload y misma plantilla que el PDF, sin fotos, sin persistir. Con quote_id + sucio=false se arma desde la fila y el snapshot guardados (sin motor); si no, corre calculate() con el body y arma el quote-like en memoria. Errores del motor = los de /calculate (400). text/html; Cache-Control: no-store.',
  })
  async previewHtml(@Body() dto: PreviewQuoteDto, @Res() res: Response) {
    const html = await this.quotesPdf.previewHtml(dto);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.send(html);
  }

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'List quotes (vuelos) with filters. No accesible a pilotos.',
  })
  list(@Query() q: ListQuotesQuery) {
    return this.quotes.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Persist a quote (creates vuelo in estado=COTIZADO con cotizacion v1). ADMIN o COORDINADOR. 201; con client_request_id repetido devuelve la cotización ya creada (200, sin duplicar).',
  })
  async create(
    @Body() dto: CreateQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.quotes.create(dto, c.userId);
    if ('idempotente' in r && r.idempotente === true) {
      res.status(HttpStatus.OK);
    }
    return r;
  }

  @Get('rutas-sugeridas')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Rutas que el cliente suele pedir (historial agrupado por itinerario), para sugerir en el cotizador.',
  })
  rutasSugeridas(@Query('cliente_id', ParseUUIDPipe) clienteId: string) {
    return this.quotes.rutasSugeridas(clienteId);
  }

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Get vuelo/quote with current cotization snapshot. No accesible a pilotos.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findById(id);
  }

  @Get(':id/versions')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Full version history of the quote. No accesible a pilotos.',
  })
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findVersions(id);
  }

  @Post(':id/revise')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Revise quote (creates new version, increments cotizacion_version). 409 estructurado COTIZACION_COBRADA si el vuelo tiene dinero cobrado (neto de cobro_vuelo por cobrosEnUsd ≠ 0 o MXN sin TC; cualquier estado salvo CANCELADO); 409 si tiene CFDI, mes cerrado o vuelo de servicio. Con client_request_id repetido devuelve la cotización vigente (200) sin crear otra versión.',
  })
  async revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.quotes.revise(id, dto, c.userId);
    if ('idempotente' in r && r.idempotente === true) {
      res.status(HttpStatus.OK);
    }
    return r;
  }

  @Post(':id/ajuste')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ajuste rápido desde el detalle: extras y/o pasajeros (recalcula TUAs) sin rearmar el cotizador. Versiona como una revisión.',
  })
  quickAdjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickAdjustQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.quickAdjust(id, dto, c.userId);
  }

  // Sub-ruta de ':id': va con las demás rutas ':id/...' (las literales del
  // segmento — calculate, rutas-sugeridas — ya están declaradas antes de
  // ':id', convención del repo).
  @Patch(':id/escalas/:escalaId/pdf-visibilidad')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Presentación PDF de un tramo: prende/apaga su visibilidad (escala.pdf_oculto) y/o fija la fecha que verá el cliente en el PDF (escala.pdf_fecha, solo fecha YYYY-MM-DD; null = quitarla). Patch parcial (misma ruta que el toggle: {oculto} sigue valiendo), sin recálculo ni snapshot — el PDF lee la escala viva; no toca la ruta operativa ni las fechas de vuelo. Mismos roles que revise.',
  })
  pdfVisibilidad(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('escalaId', ParseUUIDPipe) escalaId: string,
    @Body() dto: PdfVisibilidadDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.setPdfVisibilidad(id, escalaId, dto, c.userId);
  }

  @Patch(':id/pdf-visibilidad')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Presentación PDF a nivel VUELO (D5, 8-sep-2026): notas del cliente y toggles pdf_mostrar_tarifa / pdf_mostrar_itinerario SIN crear versión ni notificar (presentación pura, como el ojito). Patch parcial; 400 con body vacío. Mismos roles que revise.',
  })
  pdfPresentacionVuelo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PdfPresentacionVueloDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.setPdfPresentacionVuelo(id, dto, c.userId);
  }

  @Post(':id/confirm')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm the quote (estado COTIZADO -> CONFIRMADO). Locks the current version.',
  })
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.confirm(id, c.userId);
  }

  @Post(':id/cancel')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel the quote/vuelo' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.cancel(id, dto.motivo, c.userId);
  }

  @Post(':id/pdf')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Genera el PDF de la cotización (render en pyservices/WeasyPrint).',
  })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const quote = await this.quotes.findById(id);
    const pdf = await this.quotesPdf.render(quote);
    const folio = (quote as { folio?: number | string | null }).folio ?? id;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cotizacion-${folio}.pdf"`,
    });
    res.send(pdf);
  }

  @Post(':id/pdf-interno')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'PDF «Cotización interna» v2 (USO INTERNO, una hoja, sin fotos): SOLO lo de la cotización — fecha del vuelo, tabla de tramos (ruta con ciudad · fecha · millas · tiempo con calzos · costo/hr · total), desglose canónico con comisión del vendedor, TUAS cobradas, cobros con comisión bancaria/neto/conciliación y notas internas. Sin operación (tacos), partición, gastos ni CFDI: eso vive en el reporte del vuelo. Jamás se manda al cliente. Sin SOCIO ni PILOTO.',
  })
  async pdfInterno(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { buffer, folio } = await this.quotesPdfInterno.render(id, c);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cotizacion-interna-${folio.replace(/[^A-Za-z0-9_-]+/g, '')}.pdf"`,
    });
    res.send(buffer);
  }
}
