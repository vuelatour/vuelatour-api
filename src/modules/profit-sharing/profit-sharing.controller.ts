import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingService } from './profit-sharing.service';

@ApiTags('Profit Sharing')
@ApiBearerAuth()
@Controller({ path: 'profit-sharing', version: '1' })
export class ProfitSharingController {
  constructor(
    private readonly profitSharing: ProfitSharingService,
    private readonly dinero: DineroReportService,
  ) {}

  @Get()
  // SOCIO: su rol declara "Lectura + PDFs de reparto" y el menú del panel le
  // ofrece esta página — sin él aquí, el destinatario del reparto veía 403.
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Compute the profit-sharing breakdown per aircraft for a period',
  })
  compute(@Query() q: ProfitSharingQuery) {
    return this.profitSharing.compute(q);
  }

  @Get('pre-cierre')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Checklist de pre-cierre: vuelos sin completar, tacos en revisión, cobros con saldo, gastos sin TC/avión/comprobante y pendientes de conciliar.',
  })
  preCierre(@Query() q: ProfitSharingQuery) {
    return this.profitSharing.preCierre(q);
  }

  @Get('pdf')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Profit-sharing report PDF (rendered by vuelatour-pyservices)',
  })
  async pdf(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.profitSharing.repartoPdf(q);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="reparto-${desde}-a-${hasta}.pdf"`,
    });
  }

  @Get('dinero.xlsx')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Libro «Dinero» del periodo: réplica del control manual del equipo (dinero-vlos + otros ingresos + otros gastos + utilidades). Filas coloreadas por avión, clave vt+cliente con la matrícula como nota. Costo proveedor/comisiones/pagos van vacíos hasta definir sus reglas.',
  })
  async dineroXlsx(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.dinero.xlsx(q.desde, q.hasta);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="dinero-${desde}-a-${hasta}.xlsx"`,
    });
  }

  @Get('xlsx')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Reporte mensual por avión en Excel (rendered by vuelatour-pyservices)',
  })
  async xlsx(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.profitSharing.repartoXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="reporte-mensual-${desde}-a-${hasta}.xlsx"`,
    });
  }
}
