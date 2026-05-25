import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CreateCobroDto } from './dto/cobros.dto';
import {
  CaptureTacoDto,
  CreateEscalaDto,
  TacoAiReadDto,
  UpdateEscalaDto,
} from './dto/escalas.dto';
import {
  AssignFlightDto,
  CreateExternalFlightDto,
  ListFlightsQuery,
  SetFlightPlanDto,
  TacoStatusDto,
  UpdateFlightDto,
  VoucherUrlsDto,
} from './dto/flights.dto';
import { FlightsService } from './flights.service';

@ApiTags('Flights')
@ApiBearerAuth()
@Controller({ path: 'flights', version: '1' })
export class FlightsController {
  constructor(private readonly flights: FlightsService) {}

  // ============ Vuelos ============

  @Get()
  @ApiOperation({ summary: 'List flights with filters' })
  list(@Query() q: ListFlightsQuery) {
    return this.flights.list(q);
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

  @Get(':id')
  @ApiOperation({ summary: 'Get flight summary' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.findById(id);
  }

  @Get(':id/snapshot')
  @ApiOperation({ summary: 'Full flight with escalas + cobros' })
  snapshot(@Param('id', ParseUUIDPipe) id: string) {
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
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.flights.start(id, c.userId);
  }

  @Patch(':id/flight-plan')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Adjunta la foto del plan de vuelo de salida (vuelos hacia/desde pistas con permiso). Piloto desde la app.',
  })
  setFlightPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFlightPlanDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.setFlightPlan(id, dto.foto_plan_vuelo_url, c.userId);
  }

  @Post(':id/complete')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition EN_VUELO -> COMPLETADO' })
  complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.flights.complete(id, c.userId);
  }

  // ============ Escalas ============

  @Get(':id/legs')
  @ApiOperation({ summary: 'List flight legs (escalas)' })
  listLegs(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.listEscalas(id);
  }

  @Post(':id/legs')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({ summary: 'Create a flight leg (tacómetro fields populated later in FASE 3)' })
  createLeg(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.createEscala(id, dto, c.userId);
  }

  @Patch('legs/:legId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({ summary: 'Update leg metadata (route/orden/horas). Tacómetro endpoints en FASE 3.' })
  updateLeg(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: UpdateEscalaDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.updateEscala(legId, dto, c.userId);
  }

  @Patch('legs/:legId/taco')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Capture tacómetro reading (HOBBS) for a leg. Pilots use this from the mobile app — validates monotonicity vs previous reading.',
  })
  captureTaco(
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: CaptureTacoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.captureTaco(legId, dto, c.userId);
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
  tacoAiRead(@Param('legId', ParseUUIDPipe) legId: string, @Body() dto: TacoAiReadDto) {
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
  listPayments(@Param('id', ParseUUIDPipe) id: string) {
    return this.flights.listCobros(id);
  }

  @Post(':id/payments')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO)
  @ApiOperation({
    summary:
      'Register a payment. Auto-marks cobrado=true if sum (USD equiv) >= monto_total. Pilotos pueden registrar cobros BillPocket/efectivo en campo.',
  })
  createPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCobroDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.flights.createCobro(id, dto, c.userId, c.rol);
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
