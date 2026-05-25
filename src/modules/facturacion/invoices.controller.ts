import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  EmitirFacturaDto,
  FacturaFileUrlsDto,
  ListFacturasQuery,
  ListPendientesQuery,
} from './dto/invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller({ path: 'invoices', version: '1' })
@Roles(Rol.ADMIN, Rol.FACTURACION)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('pending')
  @ApiOperation({ summary: 'Vuelos pagados pendientes de facturar (filtros: fecha, cliente).' })
  pending(@Query() q: ListPendientesQuery) {
    return this.invoices.listPendientes(q);
  }

  @Get()
  @ApiOperation({ summary: 'Facturas emitidas (filtros: estado, entidad emisora).' })
  list(@Query() q: ListFacturasQuery) {
    return this.invoices.listFacturas(q);
  }

  @Post('emitir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Emite (timbra) el CFDI de un vuelo con la entidad emisora indicada.' })
  emitir(@Body() dto: EmitirFacturaDto, @CurrentUser() c: AuthenticatedUser) {
    return this.invoices.emitir(dto.vuelo_id, dto.entidad_fiscal_emisora_id, c.userId);
  }

  @Post('file-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Firma URLs de XML/PDF de facturas (bucket privado) para descarga.' })
  fileUrls(@Body() dto: FacturaFileUrlsDto) {
    return this.invoices.signFacturaFiles(dto.paths);
  }
}
