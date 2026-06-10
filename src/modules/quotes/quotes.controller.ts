import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { QuickAdjustQuoteDto } from './dto/quick-adjust.dto';
import { ReviseQuoteDto } from './dto/revise-quote.dto';
import { QuotesService } from './quotes.service';
import { QuotesPdfService } from './quotes-pdf.service';

@ApiTags('Quotes')
@ApiBearerAuth()
@Controller({ path: 'quotes', version: '1' })
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly quotesPdf: QuotesPdfService,
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

  @Get()
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({ summary: 'List quotes (vuelos) with filters. No accesible a pilotos.' })
  list(@Query() q: ListQuotesQuery) {
    return this.quotes.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Persist a quote (creates vuelo in estado=COTIZADO con cotizacion v1). ADMIN o COORDINADOR.',
  })
  create(@Body() dto: CreateQuoteDto, @CurrentUser() c: AuthenticatedUser) {
    return this.quotes.create(dto, c.userId);
  }

  @Get(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({ summary: 'Get vuelo/quote with current cotization snapshot. No accesible a pilotos.' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findById(id);
  }

  @Get(':id/versions')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({ summary: 'Full version history of the quote. No accesible a pilotos.' })
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findVersions(id);
  }

  @Post(':id/revise')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Revise quote (creates new version, increments cotizacion_version). Permitida mientras no se haya cobrado/facturado.',
  })
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.revise(id, dto, c.userId);
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

  @Post(':id/confirm')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the quote (estado COTIZADO -> CONFIRMADO). Locks the current version.',
  })
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
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
  @ApiOperation({ summary: 'Genera el PDF de la cotización (render en pyservices/WeasyPrint).' })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const quote = await this.quotes.findById(id);
    const pdf = await this.quotesPdf.render(quote as Record<string, unknown>);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cotizacion-${(quote as { folio?: unknown }).folio ?? id}.pdf"`,
    });
    res.send(pdf);
  }
}
