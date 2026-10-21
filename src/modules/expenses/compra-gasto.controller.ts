import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CompraGastoService } from './compra-gasto.service';
import { RegistrarGastoCompraDto } from './dto/compra-gasto.dto';

/**
 * `POST /v1/compras/:id/registrar-gasto` (21-oct-2026, invariante 101). La
 * ruta cuelga de `compras` pero el controller vive en `ExpensesModule`: el
 * gasto nace por el alta de siempre y `ExpensesModule` ya importa
 * `ComprasModule` (al revés sería un ciclo). Mismos roles que Compras.
 */
@ApiTags('Compras')
@ApiBearerAuth()
@Controller({ path: 'compras', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR)
export class CompraGastoController {
  constructor(private readonly compraGasto: CompraGastoService) {}

  @Post(':id/registrar-gasto')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Registrar el GASTO de la compra: UN gasto REFACCION por el total de la factura de mercancía (líneas + cargos impresos) en la moneda de la compra, ligado como pago MERCANCIA. Exige tc_usd_mxn (15–25), fecha_gasto y medio_pago; 409 COMPRA_GASTO_YA_REGISTRADO si ya lo tiene.',
  })
  registrarGasto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarGastoCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compraGasto.registrarGasto(id, dto, c.userId, c.rol);
  }
}
