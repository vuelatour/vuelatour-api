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
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateCobroDto,
  CreateReembolsoDto,
  UpdateCobroDto,
} from './dto/cobros.dto';
import {
  AssignEscalaDto,
  CancelEscalaDto,
  CaptureTacoDto,
  ClearTacoDto,
  ConfirmTacoDto,
  CreateEscalaDto,
  OperationalLegDto,
  RestoreEscalaDto,
  TacoAiReadDto,
  UpdateEscalaDto,
  UpdateEscalaPermisoDto,
  TacoObsDto,
} from './dto/escalas.dto';
import {
  CombinarVuelosDto,
  AssignFlightDto,
  CancelFlightDto,
  CreateExternalFlightDto,
  CubrirExternoDto,
  CreateReservaDto,
  ReassignAircraftDto,
  ListFlightsQuery,
  SetFlightPlanDto,
  TacoStatusDto,
  CobroStatusDto,
  UpdateFlightDto,
  UpdatePermisoDto,
  VoucherUrlsDto,
  PurgeFlightDto,
  RevertirExternoDto,
} from './dto/flights.dto';
import { CobroReciboService } from './cobro-recibo.service';
import { FlightReportService } from './flight-report.service';
import { FlightsService } from './flights.service';

@ApiTags('Flights')
@ApiBearerAuth()
@Controller({ path: 'flights', version: '1' })
export class FlightsController {
  constructor(
    private readonly flights: FlightsService,
    private readonly report: FlightReportService,
    private readonly recibo: CobroReciboService,
  ) {}

  // ============ Vuelos ============

  @Get(':id/reporte.pdf')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.SOCIO)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({
    summary:
      'Reporte consolidado del vuelo (cotización, ingreso, tacómetro, gastos) en PDF',
  })
  async reportePdf(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
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
  async reporteXlsx(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const folio = await this.report.folio(id);
    const buffer = await this.report.xlsx(id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="vuelo-${folio}.xlsx"`,
    });
  }

  @Get()
  @ApiOperation({
    summary:
      'List flights with filters. El piloto solo ve sus vuelos asignados.',
  })
  list(@Query() q: ListFlightsQuery, @CurrentUser() c: AuthenticatedUser) {
    // El VISITANTE no tiene NADA de vuelos (27-ago): 403 duro aunque la app
    // ni le muestre la pantalla.
    if (c.rol === Rol.VISITANTE) {
      throw new ForbiddenException('El visitante no tiene acceso a vuelos.');
    }
    // Aislamiento (Tarea 15): el piloto siempre se filtra a sus propios vuelos.
    if (c.rol === Rol.PILOTO) q.piloto_id = c.userId;
    return this.flights.list(q, c);
  }

  @Get(':id/combinar-candidatos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Candidatos para combinar este vuelo (anfitriones cuyo avión pernocta en el destino del ferry de ida).',
  })
  candidatosCombinacion(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.candidatosCombinacion(id);
  }

  @Post(':id/combinar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Combina este vuelo con un anfitrión (estrategia de pernocta): cancela ambos ferries, reasigna avión/piloto y liga los vuelos. Los precios no cambian.',
  })
  combinar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CombinarVuelosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.combinarVuelos(id, dto, c.userId);
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

  @Post(':id/revertir-externo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Regresa un vuelo cubierto por externo a vuelo propio: limpia operador/costo del apoyo; queda listo para asignar avión y piloto.',
  })
  revertirExterno(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevertirExternoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.revertirExterno(id, c.userId, dto);
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
  @ApiOperation({
    summary:
      'Get flight summary (+ apoyos 0..N y mi_tripulacion del solicitante, aditivo 29-ago)',
  })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.detalle(id, c);
  }

  @Get(':id/snapshot')
  @ApiOperation({ summary: 'Full flight with escalas + cobros' })
  async snapshot(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.snapshot(id, c);
  }

  @Get(':id/anterior')
  @ApiOperation({
    summary:
      'Vuelo anterior del mismo avión (por fecha, no cancelado): para auditar la cadena de tacómetros desde el detalle. { anterior: null } si no hay.',
  })
  async vueloAnterior(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.vueloAnterior(id);
  }

  @Get(':id/ultimo-taco')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Última lectura de tacómetro del avión del vuelo (historial): sugerencia de salida al capturar/corregir en oficina.',
  })
  ultimoTaco(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.ultimoTacoDeVuelo(id);
  }

  @Get(':id/gastos-resumen')
  @ApiOperation({
    summary:
      'Gastos YA registrados en el vuelo (lista ligera con quién capturó cada uno): la tripulación la ve en la app para no duplicar capturas. Mismo acceso que el detalle del vuelo.',
  })
  async gastosResumen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.gastosResumen(id);
  }

  @Get(':id/quote-view')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Vista de cotización SOLO LECTURA para el piloto: cliente, ruta, pasajeros, fechas, escalas y monto total cobrable. Oculta comisiones, IVA desglosado, plataforma de cobro, overrides y costos internos. El piloto solo ve su vuelo asignado.',
  })
  quoteView(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.quoteView(id, c);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary: 'Update non-cotization fields (piloto, fecha, notas, flags)',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.update(id, dto, c.userId);
  }

  @Get(':id/pilotos-disponibilidad')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Pilotos con conflicto de horario ese día y horas del mes vs. límite',
  })
  pilotosDisponibilidad(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.pilotosDisponibilidad(id);
  }

  @Patch(':id/permiso')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Actualiza el permiso de pista (Admin/Coord. o el piloto asignado)',
  })
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
  @ApiOperation({
    summary:
      'Assign aircraft / pilot / copiloto / apoyos (apoyo_ids 0..N, reemplaza la lista de nivel vuelo; apoyo_id legado = [apoyo_id]) / fecha to a flight (COTIZADO or CONFIRMADO)',
  })
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
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.start(id, c.userId, c);
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
    return this.flights.setFlightPlan(id, dto.foto_plan_vuelo_url, c.userId, c);
  }

  // Sin @Roles: cualquier rol autenticado que ve el detalle del vuelo (igual
  // que GET :id); el PILOTO se restringe a sus vuelos vía assertAccess.
  @Get(':id/plan-vuelo-url')
  @ApiOperation({
    summary:
      'URL firmada (1 h) de la foto del plan de vuelo (bucket privado planes-vuelo). { url: null } si no hay foto.',
  })
  async planVueloUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.flightPlanUrl(id);
  }

  @Post(':id/complete')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition EN_VUELO -> COMPLETADO' })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.complete(id, c.userId, c);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Elimina un vuelo SIN actividad (solicitud fantasma). Si tiene cobros/gastos/tacómetros, se rechaza: cancélalo.',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.deleteFlight(id, c.userId);
  }

  @Delete(':id/purge')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Borrado DEFINITIVO de un vuelo CANCELADO (solo ADMIN). Candados: sin cobros, sin gastos ligados, sin factura. Deja bitácora forense en vuelo_eliminado y limpia calendario/fotos.',
  })
  purge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PurgeFlightDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.purgeFlight(id, dto.motivo, c.userId);
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
    summary:
      'Cancela un vuelo (-> CANCELADO) con motivo auditable. Solo ADMIN/COORDINADOR.',
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
  async listLegs(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.listEscalas(id);
  }

  @Post(':id/legs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary: 'Create a flight leg (tacómetro fields populated later in FASE 3)',
  })
  async createLeg(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.createEscala(id, dto, c.userId);
  }

  @Post(':id/operational-legs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Agrega un tramo OPERATIVO interno (ferry, parada técnica, pernocta operativa) a la ruta real. No se cotiza ni se cobra ni se muestra al cliente; no recalcula el precio.',
  })
  async createOperationalLeg(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OperationalLegDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    // PILOTO (28-ago): solo en vuelo COMPLETADO y solo la tripulación del vuelo
    // (el cliente pidió seguir a otro destino); el service lo valida.
    await this.flights.assertAccess(id, c);
    return this.flights.createOperationalLeg(id, dto, c.userId, c);
  }

  @Post(':id/legs/:legId/assign')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Asigna aeronave/piloto/copiloto (null = hereda del vuelo)/apoyos del tramo (apoyo_ids reemplaza SOLO los de ese tramo) a UN tramo (ida o regreso por separado). El tramo de ida (orden=1) espeja avión/piloto/fecha en el vuelo.',
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
    summary:
      'Actualiza el permiso de pista de un tramo (Admin/Coord. o el piloto asignado al tramo)',
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
  @ApiOperation({
    summary:
      'Update leg metadata (route/orden/horas). Tacómetro endpoints en FASE 3.',
  })
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
    // Valida acceso Y candado de APOYO en un paso (mismas lecturas que
    // assertAccessByLeg): el apoyo opera todo el vuelo menos los tacómetros.
    await this.flights.assertPuedeCapturarTaco(legId, c);
    return this.flights.captureTaco(legId, dto, c.userId);
  }

  @Post('legs/:legId/taco-obs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Observación del equipo sobre las lecturas de un tramo (por lado). No toca valores ni revisión: se muestra en taco-live, histórico del avión y Excel del balance (ámbar + nota).',
  })
  tacoObs(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TacoObsDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.tacoObs(legId, dto, c.userId);
  }

  @Post('legs/:legId/taco/clear')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Borra las lecturas de un tramo (por lado) para que el piloto las recapture. Limpia lectura, origen, foto y hora; si el vuelo estaba COMPLETADO y falta una llegada, regresa a EN_VUELO.',
  })
  clearTaco(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: ClearTacoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.clearTaco(legId, dto, c.userId);
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
      'Propaga lecturas reales (llegada de un tramo → salida del siguiente) y devuelve sugerencias de llegadas pendientes calculadas con el promedio del tramo. YA NO escribe estimados (política del cliente, jul 2026): las sugerencias son solo referencia para capturar en Tacómetros en vivo.',
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
    // Mismo candado que la captura: el APOYO no lee/propone tacómetros.
    await this.flights.assertPuedeCapturarTaco(legId, c);
    return this.flights.tacoAiRead(legId, dto);
  }

  @Post('legs/:legId/cancel')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancela UN tramo (no voló) con motivo auditable: anula sus lecturas provisionales (DEDUCIDO) y lo excluye de horas, completitud, propagación y calendario. Con lecturas/fotos REALES se rechaza (el tramo sí ocurrió).',
  })
  cancelLeg(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: CancelEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.cancelEscala(legId, dto.motivo, c.userId);
  }

  @Post('legs/:legId/restore')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Restaura un tramo cancelado (vuelve a la ruta activa) con motivo auditable (queda en notas internas del vuelo). Las lecturas anuladas no regresan: se recapturan o las ajusta oficina.',
  })
  restoreLeg(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: RestoreEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.restoreEscala(legId, dto.motivo, c.userId);
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
  async listPayments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
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

  @Post(':id/refunds')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Registra un REEMBOLSO al cliente: fila de cobro_vuelo con monto NEGATIVO (todos los lectores lo restan vía cobrosEnUsd). Candado: no puede dejar el cobrado neto del vuelo en negativo; permitido en CANCELADO (devolver anticipo). Motivo obligatorio.',
  })
  async createRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReembolsoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    await this.flights.assertAccess(id, c);
    return this.flights.createReembolso(id, dto, c.userId);
  }

  @Patch('cobros/:cobroId')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Corrige un cobro capturado mal (oficina). Recalcula la bandera cobrado con la fuente canónica. Un REEMBOLSO (monto negativo) no admite corrección de dinero: se elimina y se recaptura.',
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
    summary:
      'Elimina un cobro capturado por error (oficina). Recalcula la bandera cobrado.',
  })
  deletePayment(
    @Param('cobroId', ParseUUIDPipe) cobroId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.deleteCobro(cobroId, c.userId);
  }

  @Get('cobros/:cobroId/recibo.pdf')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.SOCIO, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Recibo de pago del cobro en PDF (documento NO fiscal, no sustituye al CFDI). ' +
      'Folio REC-<folio>-<n> con n = posición del cobro entre los positivos del vuelo ' +
      '(por fecha de captura): eliminar un cobro RENUMERA los recibos posteriores — ' +
      'aceptado por ser un comprobante no fiscal. Un reembolso no genera recibo (409). ' +
      'Vuelo CANCELADO con cobro real (cargo por cancelación) SÍ tiene recibo.',
  })
  async reciboCobroPdf(
    @Param('cobroId', ParseUUIDPipe) cobroId: string,
    @CurrentUser() c: AuthenticatedUser,
  ): Promise<StreamableFile> {
    // El PILOTO solo saca recibos de SUS vuelos (mismo candado que el resto
    // de accesos por vuelo: miTripulacion vía assertAccess).
    if (c.rol === Rol.PILOTO) {
      const vueloId = await this.recibo.vueloIdDeCobro(cobroId);
      await this.flights.assertAccess(vueloId, c);
    }
    const { buffer, folioRecibo } = await this.recibo.pdf(cobroId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="recibo-${folioRecibo}.pdf"`,
    });
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

  @Post('cobro-status')
  // Mismo conjunto que ve las listas (GET /quotes incluye SOCIO): sin él,
  // su columna de cobro quedaría degradada con un 403 por carga.
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA, Rol.SOCIO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Para una lista de vuelos, total cobrado en USD (fuente única cobrosEnUsd) — semáforo de cobro de las tablas de vuelos/cotizaciones.',
  })
  cobroStatus(@Body() dto: CobroStatusDto) {
    return this.flights.cobroStatus(dto.ids);
  }

  @Post('cobro-voucher-urls')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Firma URLs de vouchers de cobro (bucket privado) para el panel admin.',
  })
  cobroVoucherUrls(@Body() dto: VoucherUrlsDto) {
    return this.flights.signCobroVouchers(dto.paths);
  }
}
