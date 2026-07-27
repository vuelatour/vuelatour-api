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
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  ClasificarMovimientoDto,
  ConciliacionParseDto,
  CrearClasificacionDto,
  ImportarMovimientosDto,
  LinkMovimientoCobroDto,
  LinkMovimientoDto,
  ListConciliacionQuery,
  ReporteConciliacionQuery,
} from './dto/conciliacion.dto';
import { ConciliacionService } from './conciliacion.service';

@ApiTags('Conciliación')
@ApiBearerAuth()
@Roles(Rol.ADMIN, Rol.FACTURACION)
@Controller({ path: 'conciliacion', version: '1' })
export class ConciliacionController {
  constructor(private readonly conciliacion: ConciliacionService) {}

  @Post('parse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parsea un estado de cuenta (CSV/Excel/PDF) sin persistir',
  })
  parse(@Body() dto: ConciliacionParseDto) {
    return this.conciliacion.parse(dto);
  }

  @Post('importar')
  @ApiOperation({
    summary: 'Importa movimientos y auto-concilia los CARGO contra gastos',
  })
  importar(
    @Body() dto: ImportarMovimientosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.importar(dto, c.userId);
  }

  @Post('importar-async')
  @ApiOperation({
    summary:
      'Importa como JOB del servidor: responde job_id de inmediato y el proceso (dedupe, archivo, insert, auto-conciliación) sigue en backend con progreso consultable — cerrar el navegador no lo corta.',
  })
  importarAsync(
    @Body() dto: ImportarMovimientosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.importarAsync(dto, c.userId);
  }

  @Get('importar-status/:id')
  @ApiOperation({
    summary:
      'Avance de un job de importación: estado, porcentaje, paso y resultado.',
  })
  importarStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.importStatus(id);
  }

  @Get('reporte.xlsx')
  @ApiOperation({
    summary:
      'Reporte de conciliación en Excel: el estado de cuenta con columna de estatus (Conciliado/PENDIENTE) y con qué se cruzó cada línea. Para revisar/imprimir el cierre de la cuenta.',
  })
  async reporteXlsx(
    @Query() q: ReporteConciliacionQuery,
  ): Promise<StreamableFile> {
    const { buffer, etiqueta } = await this.conciliacion.reporteXlsx(
      q.cuenta_bancaria_id,
      q.desde,
      q.hasta,
    );
    const rango = q.desde || q.hasta ? `-${q.desde ?? ''}-a-${q.hasta ?? ''}` : '';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="conciliacion-${etiqueta}${rango}.xlsx"`,
    });
  }

  @Get('clasificaciones')
  @ApiOperation({
    summary:
      'Catálogo de clasificaciones "sin vuelo" (comisión del banco, impuestos, personal…)',
  })
  clasificaciones() {
    return this.conciliacion.listClasificaciones();
  }

  @Post('clasificaciones')
  @ApiOperation({
    summary:
      'Crea una clasificación (o devuelve la existente con el mismo nombre): el diálogo del panel crea en el mismo espacio.',
  })
  crearClasificacion(
    @Body() dto: CrearClasificacionDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.crearClasificacion(dto.nombre, c.userId);
  }

  @Patch('movimientos/:id/clasificar')
  @ApiOperation({
    summary:
      'Concilia el movimiento por CLASIFICACIÓN (no corresponde a ningún vuelo) con notas; null la quita y vuelve a Pendiente.',
  })
  clasificarMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClasificarMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.clasificarMovimiento(
      id,
      dto.clasificacion_id ?? null,
      dto.notas,
      c.userId,
    );
  }

  @Get('estados-cuenta')
  @ApiOperation({
    summary: 'Estados de cuenta importados (archivo original archivado)',
  })
  estadosCuenta(@Query('cuenta_bancaria_id') cuentaBancariaId?: string) {
    return this.conciliacion.listEstadosCuenta(cuentaBancariaId || undefined);
  }

  @Post('estados-cuenta/:id/url')
  @ApiOperation({
    summary: 'URL firmada (1 h) para descargar el archivo importado',
  })
  estadoCuentaUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.estadoCuentaUrl(id);
  }

  @Get('movimientos')
  @ApiOperation({
    summary: 'Lista movimientos bancarios con su gasto conciliado',
  })
  list(@Query() q: ListConciliacionQuery) {
    return this.conciliacion.list(q);
  }

  @Get('resumen')
  @ApiOperation({
    summary:
      'KPIs de conciliación por cuenta: movimientos, conciliados, pendientes y monto pendiente.',
  })
  resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.conciliacion.resumen(desde, hasta);
  }

  @Patch('movimientos/:id')
  @ApiOperation({ summary: 'Vincula o desvincula un movimiento con un gasto' })
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.link(id, dto.gasto_id ?? null, c.userId);
  }

  @Patch('movimientos/:id/cobro')
  @ApiOperation({
    summary:
      'Vincula o desvincula un ABONO con un cobro de vuelo (conciliación de ingresos)',
  })
  linkCobro(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoCobroDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.linkCobro(id, dto.cobro_id ?? null, c.userId);
  }

  @Post('movimientos/:id/sugerir')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugiere por IA el gasto más probable para un movimiento sin conciliar y ambiguo (ADMIN). Best-effort: disponible=false si la IA no está disponible.',
  })
  sugerir(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.sugerir(id);
  }
}
