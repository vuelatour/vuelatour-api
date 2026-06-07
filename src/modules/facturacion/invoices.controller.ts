import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  EmitirFacturaDto,
  FacturaFileUrlsDto,
  ListFacturasQuery,
  ListPendientesQuery,
  NotaCreditoDto,
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

  @Get('cierre')
  @ApiOperation({
    summary: 'Paquete de cierre mensual (.zip): reporte por avión en Excel + XML/PDF de facturas',
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
  @ApiOperation({ summary: 'Emite (timbra) el CFDI de un vuelo con la entidad emisora indicada.' })
  emitir(@Body() dto: EmitirFacturaDto, @CurrentUser() c: AuthenticatedUser) {
    return this.invoices.emitir(dto, c.userId);
  }

  @Post('nota-credito')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Emite una nota de crédito (CFDI Egreso) relacionada a una factura.' })
  notaCredito(@Body() dto: NotaCreditoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.invoices.emitirNotaCredito(dto, c.userId);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela un CFDI timbrado ante el SAT (con motivo SAT).' })
  cancelar(
    @Param('id') id: string,
    @Body() dto: CancelarFacturaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.invoices.cancelar(id, dto, c.userId);
  }

  @Post('file-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Firma URLs de XML/PDF de facturas (bucket privado) para descarga.' })
  fileUrls(@Body() dto: FacturaFileUrlsDto) {
    return this.invoices.signFacturaFiles(dto.paths);
  }
}
