import {
  Body,
  Controller,
  Get,
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
import {
  CreateCajaMovimientoDto,
  CreateFondoDto,
  ListFondosQuery,
  UpdateFondoDto,
} from './dto/caja-chica.dto';
import { CajaChicaService } from './caja-chica.service';

const LECTURA = [Rol.ADMIN, Rol.FACTURACION, Rol.SOCIO, Rol.COORDINADOR];
const GESTION = [Rol.ADMIN, Rol.FACTURACION];

@ApiTags('Caja chica')
@ApiBearerAuth()
@Controller({ path: 'caja-chica', version: '1' })
export class CajaChicaController {
  constructor(private readonly caja: CajaChicaService) {}

  @Get('me')
  @ApiOperation({ summary: 'Mi fondo de caja chica (saldo + movimientos recientes)' })
  myFondo(@CurrentUser() c: AuthenticatedUser) {
    return this.caja.getMyFondo(c.userId);
  }

  @Get('fondos')
  @Roles(...LECTURA)
  @ApiOperation({ summary: 'List funds with computed balance' })
  listFondos(@Query() q: ListFondosQuery) {
    return this.caja.listFondos(q);
  }

  @Post('fondos')
  @Roles(...GESTION)
  @ApiOperation({ summary: 'Open a petty-cash fund for a person (ADMIN/FACTURACION)' })
  createFondo(@Body() dto: CreateFondoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.caja.createFondo(dto, c.userId);
  }

  @Get('fondos/:id')
  @Roles(...LECTURA)
  @ApiOperation({ summary: 'Fund detail: balance + unified ledger (movements + cash expenses)' })
  getFondo(@Param('id', ParseUUIDPipe) id: string) {
    return this.caja.getFondoDetail(id);
  }

  @Patch('fondos/:id')
  @Roles(...GESTION)
  @ApiOperation({ summary: 'Update fund (activo / moneda / notas)' })
  updateFondo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFondoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.caja.updateFondo(id, dto, c.userId);
  }

  @Post('fondos/:id/movimientos')
  @Roles(...GESTION)
  @ApiOperation({ summary: 'Record a movement (reposición / reintegro / ajuste)' })
  createMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCajaMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.caja.createMovimiento(id, dto, c.userId);
  }
}
