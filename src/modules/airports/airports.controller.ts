import {
  BadRequestException,
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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreateAirportDto,
  ListAirportsQuery,
  UpdateAirportDto,
} from './dto/airports.dto';
import { AirportsService } from './airports.service';

type MatriculaPrefix = 'XA' | 'XB' | 'N';

@ApiTags('Airports')
@ApiBearerAuth()
@Controller({ path: 'airports', version: '1' })
export class AirportsController {
  constructor(private readonly airports: AirportsService) {}

  @Get()
  @ApiOperation({ summary: 'List airports (search by iata/icao/nombre/ciudad with q=)' })
  list(@Query() q: ListAirportsQuery) {
    return this.airports.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create airport (ADMIN)' })
  create(@Body() dto: CreateAirportDto, @CurrentUser() c: AuthenticatedUser) {
    return this.airports.create(dto, c.userId);
  }

  @Get('iata/:iata')
  @ApiOperation({ summary: 'Get airport by IATA code' })
  getByIata(@Param('iata') iata: string) {
    return this.airports.findByIata(iata);
  }

  @Get('distance')
  @ApiQuery({ name: 'origen', description: 'IATA origen' })
  @ApiQuery({ name: 'destino', description: 'IATA destino' })
  @ApiOperation({
    summary:
      'Millas náuticas great-circle entre dos aeropuertos. millas_nauticas=null si falta coordenada.',
  })
  distance(@Query('origen') origen: string, @Query('destino') destino: string) {
    if (!origen || !destino) {
      throw new BadRequestException('origen y destino son requeridos');
    }
    return this.airports.distanceNm(origen, destino);
  }

  @Get(':id/tuas')
  @ApiQuery({ name: 'matricula', enum: ['XA', 'XB', 'N'] })
  @ApiQuery({ name: 'pase_abordar', type: Boolean, required: false })
  @ApiOperation({
    summary:
      'Resolve TUAS per passenger for this airport given matricula and pase de abordar status',
  })
  async computeTuas(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('matricula') matricula: string,
    @Query('pase_abordar') paseAbordar?: string,
  ) {
    const prefix = (matricula ?? '').toUpperCase();
    if (prefix !== 'XA' && prefix !== 'XB' && prefix !== 'N') {
      throw new BadRequestException('matricula must be XA, XB or N');
    }
    const airport = await this.airports.findById(id);
    return this.airports.computeTuasUsdPax(
      airport.iata,
      prefix as MatriculaPrefix,
      paseAbordar === 'true',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get airport by id' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.airports.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update airport (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAirportDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.airports.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activo=false)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.airports.softDelete(id, c.userId);
  }
}
