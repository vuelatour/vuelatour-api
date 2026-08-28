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
import {
  AddPagoCompraDto,
  CreateCompraDto,
  ListComprasQuery,
  RecibirCompraDto,
  UnirComprasDto,
  UpdateCompraDto,
  UpdatePagoCompraDto,
} from './dto/compras.dto';
import { ComprasService } from './compras.service';

/**
 * Compras de refacciones (28-ago-2026): une la factura de mercancía con sus
 * cargos (envío/aduana) y reparte el costo a cada refacción; al recibir
 * genera las ENTRADAS del cardex. Solo oficina.
 */
@ApiTags('Compras')
@ApiBearerAuth()
@Controller({ path: 'compras', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR)
export class ComprasController {
  constructor(private readonly compras: ComprasService) {}

  @Get()
  @ApiOperation({ summary: 'Listar compras (fecha desc) con totales' })
  list(@Query() q: ListComprasQuery) {
    return this.compras.list(q);
  }

  @Post()
  @ApiOperation({
    summary:
      'Crear compra (opcionalmente desde el gasto de mercancía: hereda datos y arma líneas de los conceptos IA)',
  })
  create(@Body() dto: CreateCompraDto, @CurrentUser() c: AuthenticatedUser) {
    return this.compras.create(dto, c.userId);
  }

  // Literal ANTES de ':id' (convención del repo).
  @Post('unir')
  @ApiOperation({
    summary:
      'Unir gastos sueltos en una compra (mercancía + cargos por heurística)',
  })
  unir(@Body() dto: UnirComprasDto, @CurrentUser() c: AuthenticatedUser) {
    return this.compras.unir(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle: líneas con costo final, pagos y resumen' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.compras.getDetail(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Editar compra (líneas/moneda/cargos_factura solo mientras nada ha entrado al cardex; cambiar el TC de una compra recibida recostea sus ENTRADAS)',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.update(id, dto, c.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Eliminar compra sin ENTRADAS en el cardex (desliga sus gastos)',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.remove(id, c.userId);
  }

  @Post(':id/pagos')
  @ApiOperation({ summary: 'Ligar un gasto como pago de la compra' })
  addPago(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPagoCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.addPago(id, dto, c.userId);
  }

  @Patch(':id/pagos/:gastoId')
  @ApiOperation({
    summary:
      'Cambiar el rol de un pago ya ligado (MERCANCIA/ENVIO/IMPUESTOS/OTRO)',
  })
  updatePago(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('gastoId', ParseUUIDPipe) gastoId: string,
    @Body() dto: UpdatePagoCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.updatePago(id, gastoId, dto, c.userId);
  }

  @Delete(':id/pagos/:gastoId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desligar un gasto de la compra' })
  removePago(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('gastoId', ParseUUIDPipe) gastoId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.removePago(id, gastoId, c.userId);
  }

  @Post(':id/recibir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Recibir: ENTRADAS del cardex con el costo final (o recosteo si ya estaba recibida). Con cargos sin TC responde 400 salvo forzar=true',
  })
  recibir(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RecibirCompraDto,
    @Body() body: RecibirCompraDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.compras.recibir(
      id,
      c.userId,
      q.forzar === true || body?.forzar === true,
    );
  }
}
