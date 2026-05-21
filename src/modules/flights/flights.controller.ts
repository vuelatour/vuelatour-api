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
import { CaptureTacoDto, CreateEscalaDto, UpdateEscalaDto } from './dto/escalas.dto';
import {
  AssignFlightDto,
  CreateExternalFlightDto,
  ListFlightsQuery,
  UpdateFlightDto,
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
    return this.flights.createCobro(id, dto, c.userId);
  }
}
