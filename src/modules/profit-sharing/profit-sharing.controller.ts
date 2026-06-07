import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { ProfitSharingQuery } from './dto/profit-sharing.dto';
import { ProfitSharingService } from './profit-sharing.service';

@ApiTags('Profit Sharing')
@ApiBearerAuth()
@Controller({ path: 'profit-sharing', version: '1' })
export class ProfitSharingController {
  constructor(private readonly profitSharing: ProfitSharingService) {}

  @Get()
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Compute the profit-sharing breakdown per aircraft for a period',
  })
  compute(@Query() q: ProfitSharingQuery) {
    return this.profitSharing.compute(q);
  }

  @Get('pdf')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
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
