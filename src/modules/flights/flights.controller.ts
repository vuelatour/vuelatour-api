import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { CreateCobroDto, UpdateCobroDto } from './dto/cobros.dto';
import {
  AssignEscalaDto,
  CaptureTacoDto,
  ConfirmTacoDto,
  CreateEscalaDto,
  OperationalLegDto,
  TacoAiReadDto,
  UpdateEscalaDto,
  UpdateEscalaPermisoDto,
} from './dto/escalas.dto';
import {
  AssignFlightDto,
  CancelFlightDto,
  CreateExternalFlightDto,
  CubrirExternoDto,
  CreateReservaDto,
  ReassignAircraftDto,
  ListFlightsQuery,
  SetFlightPlanDto,
  TacoStatusDto,
  UpdateFlightDto,
  UpdatePermisoDto,
  VoucherUrlsDto,
} from './dto/flights.dto';
import { FlightReportService } from './flight-report.service';
import { FlightsService } from './flights.service';

@ApiTags('Flights')
@ApiBearerAuth()
@Controller({ path: 'flights', version: '1' })
export class FlightsController {
  constructor(
    private readonly flights: FlightsService,
    private readonly report: FlightReportService,
  ) {}

  // ============ Vuelos ============

  @Get(':id/reporte.pdf')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.SOCIO)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Reporte consolidado del vuelo (cotización, ingreso, tacómetro, gastos) en PDF' })
  async reportePdf(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const folio = await this.report.folio(id);
    const buffer = await this.report.pdf(id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="vuelo-${folio}.pdf"`,
    });
  }

  @Get(':id/reporte.xlsx')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.SOCIO)
  @ApiOperation({ summary: 'Reporte consolidado del vuelo en Excel' })
  async reporteXlsx(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const folio = await this.report.folio(id);
    const buffer = await this.report.xlsx(id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="vuelo-${folio}.xlsx"`,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List flights with filters. El piloto solo ve sus vuelos asignados.' })
  list(@Query() q: ListFlightsQuery, @CurrentUser() c: AuthenticatedUser) {
    // Aislamiento (Tarea 15): el piloto siempre se filtra a sus propios vuelos.
    if (c.rol === Rol.PILOTO) q.piloto_id = c.userId;
    return this.flights.list(q);
  }

  @Post(':id/cubrir-externo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Cubre el vuelo con un operador externo: conserva la cotización al cliente, libera avión/piloto (sin tacómetros; estado manual). Repetido, actualiza operador/costo.',
  })
  cubrirExterno(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CubrirExternoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.cubrirConExterno(id, dto, c.userId);
  }

  @Post('external')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Create an external (subcontracted) flight (~1/10 vuelos). Skips quote engine — costo y monto se ingresan directos.',
  })
  createExternal(
    @Body() dto: CreateExternalFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.createExternal(dto, c.userId);
  }

  @Post('reserva')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Reserva tentativa: aparta el espacio en el calendario SIN cotización (vuelo propio). Se cotiza después desde el detalle.',
  })
  createReserva(
    @Body() dto: CreateReservaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.createReserva(dto, c.userId);
  }

  @Get('taco-live')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Tacómetros en vivo: escalas de los vuelos del día (no cancelados) con estado, origen de cada lectura, fotos firmadas y hora esperada de fin. La operación no se detiene: lo vencido se deduce y oficina confirma/ajusta.',
  })
  tacoLive(@Query('fecha') fecha?: string) {
    return this.flights.tacoLive(fecha);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get flight summary' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.findById(id);
  }

  @Get(':id/snapshot')
  @ApiOperation({ summary: 'Full flight with escalas + cobros' })
  async snapshot(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.snapshot(id);
  }

  @Get(':id/quote-view')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Vista de cotización SOLO LECTURA para el piloto: cliente, ruta, pasajeros, fechas, escalas y monto total cobrable. Oculta comisiones, IVA desglosado, plataforma de cobro, overrides y costos internos. El piloto solo ve su vuelo asignado.',
  })
  quoteView(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.flights.quoteView(id, c);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Update non-cotization fields (piloto, fecha, notas, flags)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.update(id, dto, c.userId);
  }

  @Get(':id/pilotos-disponibilidad')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Pilotos con conflicto de horario ese día y horas del mes vs. límite' })
  pilotosDisponibilidad(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.pilotosDisponibilidad(id);
  }

  @Patch(':id/permiso')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({ summary: 'Actualiza el permiso de pista (Admin/Coord. o el piloto asignado)' })
  updatePermiso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermisoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.updatePermiso(id, dto.estado_permiso, {
      userId: c.userId,
      rol: c.rol,
    });
  }

  @Post(':id/assign')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({ summary: 'Assign aircraft / pilot / fecha to a flight (COTIZADO or CONFIRMADO)' })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.assign(id, dto, c.userId);
  }

  @Post(':id/start')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition CONFIRMADO -> EN_VUELO' })
  async start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.start(id, c.userId);
  }

  @Patch(':id/flight-plan')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Adjunta la foto del plan de vuelo de salida (vuelos hacia/desde pistas con permiso). Piloto desde la app.',
  })
  async setFlightPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFlightPlanDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.setFlightPlan(id, dto.foto_plan_vuelo_url, c.userId);
  }

  @Post(':id/complete')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition EN_VUELO -> COMPLETADO' })
  async complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.complete(id, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Elimina un vuelo SIN actividad (solicitud fantasma). Si tiene cobros/gastos/tacómetros, se rechaza: cancélalo.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.deleteFlight(id);
  }

  @Post(':id/reassign-aircraft')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cambio de aeronave de último minuto: clona el vuelo a la nueva matrícula (cobros se mueven) y el original queda CANCELADO con sus gastos.',
  })
  reassignAircraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignAircraftDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.reassignAircraft(id, dto, c.userId);
  }

  @Post(':id/cancel')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela un vuelo (-> CANCELADO) con motivo auditable. Solo ADMIN/COORDINADOR.',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.cancel(id, dto.motivo, c.userId);
  }

  // ============ Escalas ============

  @Get(':id/legs')
  @ApiOperation({ summary: 'List flight legs (escalas)' })
  async listLegs(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.listEscalas(id);
  }

  @Post(':id/legs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({ summary: 'Create a flight leg (tacómetro fields populated later in FASE 3)' })
  async createLeg(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.createEscala(id, dto, c.userId);
  }

  @Post(':id/operational-legs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Agrega un tramo OPERATIVO interno (ferry, parada técnica, pernocta operativa) a la ruta real. No se cotiza ni se cobra ni se muestra al cliente; no recalcula el precio.',
  })
  createOperationalLeg(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OperationalLegDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.createOperationalLeg(id, dto, c.userId);
  }

  @Post(':id/legs/:legId/assign')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Asigna aeronave/piloto a UN tramo (ida o regreso por separado). El tramo de ida (orden=1) se espeja en el vuelo.',
  })
  assignLeg(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: AssignEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.assignEscala(legId, dto, c.userId);
  }

  @Patch('legs/:legId/permiso')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary: 'Actualiza el permiso de pista de un tramo (Admin/Coord. o el piloto asignado al tramo)',
  })
  async updateLegPermiso(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: UpdateEscalaPermisoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccessByLeg(legId, c);
    return this.flights.updateEscalaPermiso(legId, dto.estado_permiso, {
      userId: c.userId,
      rol: c.rol,
    });
  }

  @Patch('legs/:legId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({ summary: 'Update leg metadata (route/orden/horas). Tacómetro endpoints en FASE 3.' })
  async updateLeg(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: UpdateEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccessByLeg(legId, c);
    return this.flights.updateEscala(legId, dto, c.userId);
  }

  @Patch('legs/:legId/taco')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Capture tacómetro reading (HOBBS) for a leg. Pilots use this from the mobile app — validates monotonicity vs previous reading.',
  })
  async captureTaco(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: CaptureTacoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccessByLeg(legId, c);
    return this.flights.captureTaco(legId, dto, c.userId);
  }

  @Post('legs/:legId/taco/confirm')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Oficina confirma una lectura marcada para revisión (amarillo → verde). Permite corregir los valores en el mismo paso; si corrige la llegada, se propaga como salida del siguiente tramo.',
  })
  confirmTaco(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: ConfirmTacoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.confirmTaco(legId, dto, c.userId);
  }

  @Post(':id/taco/fill-gaps')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rellena los huecos de tacómetro del vuelo con el promedio histórico del tramo. Lo calculado queda en amarillo (revision_requerida) hasta confirmarse. También corre solo cada noche (cierre del día).',
  })
  fillTacoGaps(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.fillTacoGaps(id, c.userId);
  }

  @Get(':id/taco-photos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Galería de fotos de tacómetro del vuelo con URLs firmadas (1 h) + marca de revisión. Para el panel admin.',
  })
  tacoPhotos(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.tacoPhotos(id);
  }

  @Post('legs/:legId/taco/ai-read')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lee el tacómetro de una foto con IA (Claude Vision), sin guardar. Prellena el campo en la app. Si la IA falla o la foto sale ilegible, devuelve una sugerencia histórica para la lectura de llegada.',
  })
  async tacoAiRead(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TacoAiReadDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccessByLeg(legId, c);
    return this.flights.tacoAiRead(legId, dto);
  }

  @Delete('legs/:legId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete leg (only if no tacómetro captured)' })
  deleteLeg(@Param('legId', ParseUUIDPipe) legId: string) {
    return this.flights.deleteEscala(legId);
  }

  // ============ Cobros ============

  @Get(':id/payments')
  @ApiOperation({ summary: 'List payments registered for the flight' })
  async listPayments(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    await this.flights.assertAccess(id, c);
    return this.flights.listCobros(id);
  }

  @Get(':id/bitacora')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Bitácora del vuelo: recordatorios de tacómetro enviados al piloto y capturas de tacómetro registradas, en orden cronológico.',
  })
  bitacora(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.flightBitacora(id);
  }

  @Post(':id/payments')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Register a payment. Auto-marks cobrado=true if sum (USD equiv) >= monto_total. Pilotos pueden registrar cobros BillPocket/efectivo en campo.',
  })
  async createPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCobroDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.createCobro(id, dto, c.userId, c.rol);
  }

  @Patch('cobros/:cobroId')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Corrige un cobro capturado mal (oficina). Recalcula la bandera cobrado con la fuente canónica.',
  })
  updatePayment(
    @Param('cobroId', ParseUUIDPipe) cobroId: string,
    @Body() dto: UpdateCobroDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.updateCobro(cobroId, dto, c.userId);
  }

  @Delete('cobros/:cobroId')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary: 'Elimina un cobro capturado por error (oficina). Recalcula la bandera cobrado.',
  })
  deletePayment(
    @Param('cobroId', ParseUUIDPipe) cobroId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.deleteCobro(cobroId, c.userId);
  }

  @Post('taco-status')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Para una lista de vuelos, indica cuáles tienen el tacómetro incompleto (badge en admin).',
  })
  tacoStatus(@Body() dto: TacoStatusDto) {
    return this.flights.tacoStatus(dto.ids);
  }

  @Post('cobro-voucher-urls')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Firma URLs de vouchers de cobro (bucket privado) para el panel admin.' })
  cobroVoucherUrls(@Body() dto: VoucherUrlsDto) {
    return this.flights.signCobroVouchers(dto.paths);
  }
}
