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
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CalculateQuoteDto } from './dto/calculate-quote.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { CancelQuoteDto, ListQuotesQuery } from './dto/list-quotes.query';
import { ReviseQuoteDto } from './dto/revise-quote.dto';
import { QuotesService } from './quotes.service';

@ApiTags('Quotes')
@ApiBearerAuth()
@Controller({ path: 'quotes', version: '1' })
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Compute a quote without persisting. Returns the full breakdown (tiempos, tarifa, TUAS por aeropuerto, IVA, total USD).',
  })
  calculate(@Body() dto: CalculateQuoteDto) {
    return this.quotes.calculate(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List quotes (vuelos) with filters' })
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
  @ApiOperation({ summary: 'Get vuelo/quote with current cotization snapshot' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findById(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Full version history of the quote' })
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.findVersions(id);
  }

  @Post(':id/revise')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Revise quote (creates new version, increments cotizacion_version). Only SOLICITUD/COTIZADO allow revision.',
  })
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseQuoteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.quotes.revise(id, dto, c.userId);
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
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Generate the cotization PDF (rendered by vuelatour-pyservices)',
  })
  async pdf(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const { buffer, folio, version } = await this.quotes.cotizacionPdf(id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="cotizacion-${folio}-v${version}.pdf"`,
    });
  }
}
