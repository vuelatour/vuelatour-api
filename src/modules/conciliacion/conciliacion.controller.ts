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
  parse(
    @Body() dto: ConciliacionParseDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.parse(dto, c.userId);
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
      'Reporte de conciliación en Excel: el estado de cuenta con matrícula por línea, estatus (Conciliado/PENDIENTE), con qué se cruzó y los montos sin conciliar en naranja. Filtro de estado = las 4 pestañas de la página (sin_banco = gastos bancarios que no aparecen en el banco).',
  })
  async reporteXlsx(
    @Query() q: ReporteConciliacionQuery,
  ): Promise<StreamableFile> {
    const { buffer, etiqueta } = await this.conciliacion.reporteXlsx(
      q.cuenta_bancaria_id,
      q.desde,
      q.hasta,
      q.estado,
    );
    // El nombre dice qué filtro se exportó (sin_banco → "gastos-sin-banco").
    const sufijoEstado =
      q.estado !== 'todos' ? `-${q.estado.replace(/_/g, '-')}` : '';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="conciliacion-${etiqueta}${sufijoEstado}-${q.desde}-a-${q.hasta}.xlsx"`,
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

  @Get('gastos-sin-banco')
  @ApiOperation({
    summary:
      'Gastos BANCARIOS (tarjeta/transferencia) que NO aparecen en ningún estado de cuenta: sin conciliar tras los cruces. Default: últimos 90 días.',
  })
  gastosSinBanco(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    return this.conciliacion.gastosSinBanco(desde, hasta);
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
  sugerir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.sugerir(id, c.userId);
  }
}
