import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { BalanceAvionQuery } from './dto/balance-avion.query';
import { BitacoraTacoQuery } from './dto/bitacora-taco.query';
import { CreateAeronaveDto } from './dto/create-aeronave.dto';
import { ListAeronavesQuery } from './dto/list-aeronaves.query';
import { UpdateAeronaveDto } from './dto/update-aeronave.dto';
import {
  CreateAeronaveSocioDto,
  UpdateAeronaveSocioDto,
} from './dto/upsert-aeronave-socio.dto';
import {
  CreateAeronaveImagenDto,
  UpdateAeronaveImagenDto,
} from './dto/aeronave-imagen.dto';
import {
  CreateAeronaveSeguroDto,
  UpdateAeronaveSeguroDto,
} from './dto/upsert-aeronave-seguro.dto';
import {
  CreateDiscrepanciaDto,
  UpdateDiscrepanciaDto,
} from './dto/upsert-aeronave-discrepancia.dto';
import { AircraftBalanceService } from './aircraft-balance.service';
import { AircraftService } from './aircraft.service';

@ApiTags('Aircraft')
@ApiBearerAuth()
@Controller({ path: 'aircraft', version: '1' })
export class AircraftController {
  constructor(
    private readonly aircraft: AircraftService,
    private readonly balance: AircraftBalanceService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List aircraft' })
  list(@Query() q: ListAeronavesQuery) {
    return this.aircraft.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create aircraft (ADMIN)' })
  create(
    @Body() dto: CreateAeronaveDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.create(dto, current.userId);
  }

  // OJO: ruta literal ANTES de las rutas ':id' o Nest la captura como id.
  @Get('balance-general.xlsx')
  // Mismos roles que el balance por avión: trae utilidad de toda la flota.
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Balance general VuelaTour: consolidado de toda la flota en un solo libro — RESUMEN con una fila por avión (los TOTALES de su libro del periodo, mismo motor que el balance por avión) + totales de flota, y un juego de hojas con los datos de todos los aviones juntos. Default: mes corriente en hora Cancún.',
  })
  async balanceGeneralXlsx(
    @Query() q: BalanceAvionQuery,
  ): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.balance.xlsxGeneral(
      q.desde,
      q.hasta,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="balance-general-vuelatour-${desde}-a-${hasta}.xlsx"`,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one aircraft' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.findById(id);
  }

  @Get(':id/metrics')
  // Trae el bloque de FINANZAS (utilidad por avión): espejo de los dashboards
  // financieros (/v1/dashboards/overview). El detalle del avión en el panel lo
  // pide best-effort (sin permiso, la card simplemente no se pinta).
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Métricas operativas: apto-para-volar, utilización (horas/vuelos) y finanzas',
  })
  metrics(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.aircraftMetrics(id);
  }

  @Get(':id/combustible-mensual')
  // Dinero del avión: mismos roles que /metrics. El expediente del panel lo
  // pide best-effort (sin permiso, la card simplemente no se pinta).
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary:
      'Gasto de combustible (GAS) del avión agrupado por mes — últimos 12 meses en moneda nativa; mismo filtro (aeronave_id + fecha_gasto) que la hoja combustible del balance y el reparto.',
  })
  combustibleMensual(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.combustibleMensual(id);
  }

  @Get(':id/snapshot')
  @ApiOperation({
    summary:
      'Aircraft with engines, propellers, active owners and overhaul reserves',
  })
  snapshot(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.getSnapshot(id);
  }

  @Get(':id/balance.xlsx')
  // Mismos roles que el reparto (/v1/profit-sharing/xlsx): este libro trae
  // utilidad y reparto de socios — misma sensibilidad que el cierre.
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Balance mensual del avión en Excel (réplica del control del equipo: venta/costos/indicadores por vuelo, hojas de gastos, balance y pendientes). Default: mes corriente en hora Cancún.',
  })
  async balanceXlsx(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: BalanceAvionQuery,
  ): Promise<StreamableFile> {
    const { buffer, matricula, desde, hasta } = await this.balance.xlsx(
      id,
      q.desde,
      q.hasta,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="balance-${matricula}-${desde}-a-${hasta}.xlsx"`,
    });
  }

  @Get(':id/bitacora.pdf')
  // Operativo (no trae dinero): quien administra tacómetros puede imprimirla.
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Bitácoras de vuelo imprimibles del avión (plantilla del equipo): una PÁGINA por libro —planeador, motor y hélice (tiras=PLANEADOR,MOTOR,HELICE; default las tres)— con una fila por vuelo: fecha, tacómetro inicial, tiempo acumulado del componente, horas, tacómetro final y ruta. Los tiempos salen de la base capturada (planeador: ficha del avión; motor/hélice: ficha del componente); helice_base = tiempo de hélice del primer renglón cuando la hélice no tiene ficha. formato es DEPRECADO (compatibilidad). Para recortar y pegar en cada bitácora física. Sin rango = todo el histórico.',
  })
  async bitacoraPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: BitacoraTacoQuery,
  ): Promise<StreamableFile> {
    const { buffer, matricula } = await this.aircraft.bitacoraTacoPdf(
      id,
      q.desde,
      q.hasta,
      { tiras: q.tiras, formato: q.formato, heliceBase: q.helice_base },
    );
    const rango =
      q.desde || q.hasta ? `-${q.desde ?? ''}-a-${q.hasta ?? ''}` : '';
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="bitacoras-${matricula}${rango}.pdf"`,
    });
  }

  @Get(':id/tacometros')
  @ApiOperation({
    summary:
      'Histórico de tacómetros por aeronave + horas actuales y próximo servicio por horas',
  })
  tacometros(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.tacometroHistorial(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update aircraft (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAeronaveDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.update(id, dto, current.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate aircraft (sets activa=false). ADMIN.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.softDelete(id, current.userId);
  }

  // ============ Ownership ============

  @Get(':id/owners')
  @ApiQuery({
    name: 'history',
    required: false,
    type: Boolean,
    description: 'Include closed shares',
  })
  @ApiOperation({ summary: 'List ownership shares (active by default)' })
  listOwners(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('history', new ParseBoolPipe({ optional: true })) history = false,
  ) {
    return this.aircraft.listOwners(id, history);
  }

  @Post(':id/owners')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Add ownership share (ADMIN). Caller closes prior shares manually.',
  })
  createOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAeronaveSocioDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.createOwner(id, dto, current.userId);
  }

  @Patch('owners/:ownerId')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update an ownership share (ADMIN)' })
  updateOwner(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Body() dto: UpdateAeronaveSocioDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.updateOwner(ownerId, dto, current.userId);
  }

  @Delete('owners/:ownerId')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close ownership share with today as vigente_hasta (ADMIN)',
  })
  closeOwner(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    if (!current) throw new ForbiddenException();
    return this.aircraft.closeOwner(ownerId, new Date(), current.userId);
  }

  // ============ Seguros ============

  @Get(':id/insurance')
  @ApiOperation({ summary: 'List insurance policies for this aircraft' })
  listInsurance(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.listSeguros(id);
  }

  @Post(':id/insurance')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Add an insurance policy (ADMIN/COORDINADOR)' })
  createInsurance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAeronaveSeguroDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.createSeguro(id, dto, current.userId);
  }

  @Patch('insurance/:seguroId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update an insurance policy (ADMIN/COORDINADOR)' })
  updateInsurance(
    @Param('seguroId', ParseUUIDPipe) seguroId: string,
    @Body() dto: UpdateAeronaveSeguroDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.updateSeguro(seguroId, dto, current.userId);
  }

  @Delete('insurance/:seguroId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an insurance policy (ADMIN/COORDINADOR)' })
  deleteInsurance(@Param('seguroId', ParseUUIDPipe) seguroId: string) {
    return this.aircraft.deleteSeguro(seguroId);
  }

  @Get('insurance/:seguroId/archivo')
  // Documento sensible (póliza): SOLO oficina — mismo contrato que
  // GET /expirations/:id/archivo.
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'URL firmada (1 h) de la copia de la póliza en el bucket privado documentos-flota. 404 si el seguro no tiene archivo.',
  })
  insuranceArchivo(@Param('seguroId', ParseUUIDPipe) seguroId: string) {
    return this.aircraft.seguroArchivoSignedUrl(seguroId);
  }

  // ============ Discrepancias (squawks) ============

  @Get(':id/squawks')
  @ApiOperation({ summary: 'List discrepancies/squawks for this aircraft' })
  listSquawks(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.listDiscrepancias(id);
  }

  @Post(':id/squawks')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary: 'Report a discrepancy/squawk (ADMIN/COORDINADOR/MECANICO)',
  })
  createSquawk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDiscrepanciaDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.createDiscrepancia(id, dto, current.userId);
  }

  @Patch('squawks/:squawkId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary: 'Update/resolve a discrepancy (ADMIN/COORDINADOR/MECANICO)',
  })
  updateSquawk(
    @Param('squawkId', ParseUUIDPipe) squawkId: string,
    @Body() dto: UpdateDiscrepanciaDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.updateDiscrepancia(squawkId, dto, current.userId);
  }

  @Delete('squawks/:squawkId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a discrepancy (ADMIN/COORDINADOR)' })
  deleteSquawk(@Param('squawkId', ParseUUIDPipe) squawkId: string) {
    return this.aircraft.deleteDiscrepancia(squawkId);
  }

  // ============ Overhaul reserves ============

  @Get(':id/overhaul-reserves')
  @ApiOperation({ summary: 'Overhaul reserves per engine for this aircraft' })
  listReserves(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.listOverhaulReserves(id);
  }

  // ============ Imagenes ============

  @Get(':id/images')
  @ApiOperation({ summary: 'List images of an aircraft (ordered by orden)' })
  listImages(@Param('id', ParseUUIDPipe) id: string) {
    return this.aircraft.listImagenes(id);
  }

  @Post(':id/images')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Register an image after uploading to Storage. Frontend uploads file to bucket and posts metadata here.',
  })
  createImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAeronaveImagenDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.createImagen(id, dto, current.userId);
  }

  @Patch('images/:imageId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Update image metadata (alt_text, orden, es_principal)',
  })
  updateImage(
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: UpdateAeronaveImagenDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.aircraft.updateImagen(imageId, dto, current.userId);
  }

  @Delete('images/:imageId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete image (removes both the storage file and the row). If was principal, promotes the next one.',
  })
  deleteImage(@Param('imageId', ParseUUIDPipe) imageId: string) {
    return this.aircraft.deleteImagen(imageId);
  }
}
