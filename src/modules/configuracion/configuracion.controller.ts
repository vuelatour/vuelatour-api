import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  EditoresCotizacionCobradaDto,
  IaSaldoDto,
  IaUsoQuery,
  ResponsablesFacturacionDto,
  UpdateConfiguracionDto,
} from './dto/configuracion.dto';
import { ConfiguracionService } from './configuracion.service';
import { IaUsoService } from '../ia-uso/ia-uso.service';

@ApiTags('Config')
@ApiBearerAuth()
@Controller({ path: 'config', version: '1' })
export class ConfiguracionController {
  constructor(
    private readonly config: ConfiguracionService,
    private readonly iaUsoSvc: IaUsoService,
  ) {}

  @Get()
  // Sin @Roles: la app del piloto/mecánico necesita leer las banderas de
  // comportamiento y no contienen nada sensible (mismo criterio que GET /me).
  @ApiOperation({ summary: 'Banderas globales de comportamiento del sistema' })
  list() {
    return this.config.list();
  }

  // Rutas literales ANTES de ':clave' (convención del repo).
  @Get('ia-uso')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Resumen del consumo de IA (llamadas, tokens y costo USD) por categoría, modelo y día. Default: mes actual en pared Cancún. El saldo es ESTIMADO (los fallos 422/timeout gastan tokens que no llegan al registro).',
  })
  iaUso(@Query() q: IaUsoQuery) {
    return this.iaUsoSvc.resumen(q.desde, q.hasta);
  }

  @Post('ia-saldo')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Registra un checkpoint del saldo real de la consola de Anthropic; el panel estima el saldo restante restando el consumo posterior.',
  })
  iaSaldo(@Body() dto: IaSaldoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.iaUsoSvc.guardarSaldo(
      dto.saldo_usd,
      dto.notas ?? null,
      c.userId,
    );
  }

  // Responsables de facturación (24-sep-2026): quién recibe el aviso
  // «Factura pedida». Literales ANTES de ':clave'.
  @Get('responsables-facturacion')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Responsables de facturación: ids guardados, su resolución, candidatos de oficina, a quién le llegaría HOY el aviso «Factura pedida» y de dónde sale (CONFIG | ROL_FACTURACION | ADMINS). 503 FACTURAS_EMITIDAS_NO_DISPONIBLE sin la migración 20260924000003.',
  })
  responsablesFacturacion() {
    return this.config.responsablesFacturacion();
  }

  @Put('responsables-facturacion')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary:
      'Guarda los responsables de facturación ({ usuario_ids }). Solo usuarios ACTIVOS de oficina (400 USUARIOS_INVALIDOS con los ids que no lo son). [] = por rol (FACTURACION → ADMIN).',
  })
  setResponsablesFacturacion(
    @Body() dto: ResponsablesFacturacionDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.config.setResponsablesFacturacion(
      dto.usuario_ids,
      current.userId,
    );
  }

  // Editores de cotizaciones cobradas (26-sep-2026): permiso por PERSONA
  // para revisar una cotización con cobros. Literales ANTES de ':clave'.
  // El rol solo abre la puerta: el PUT exige además estar YA en la lista.
  @Get('editores-cotizacion-cobrada')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Quién puede editar cotizaciones con cobros registrados: { usuario_ids, usuarios: {id, nombre}[], puede_modificar (quien consulta está en la lista), candidatos (ADITIVO: oficina activa que acepta el PUT) }. Sin la migración 20260926000001 la lista es vacía (nadie tiene el permiso).',
  })
  editoresCotizacionCobrada(@CurrentUser() current: AuthenticatedUser) {
    return this.config.editoresCotizacionCobrada(current.userId);
  }

  @Put('editores-cotizacion-cobrada')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Guarda quién puede editar cotizaciones cobradas ({ usuario_ids }). Solo un usuario que YA está en la lista (403 SOLO_EDITORES_COTIZACION_COBRADA); nunca vacía (400 LISTA_VACIA); solo usuarios ACTIVOS de oficina (400 USUARIOS_INVALIDOS con los ids). Dos cambios a la vez: 409 EDITORES_CAMBIARON al segundo. Responde lo mismo que el GET.',
  })
  setEditoresCotizacionCobrada(
    @Body() dto: EditoresCotizacionCobradaDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.config.setEditoresCotizacionCobrada(
      dto.usuario_ids,
      current.userId,
    );
  }

  @Patch(':clave')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary: 'Actualiza una bandera global: activa y/o valor_numerico (ADMIN)',
  })
  update(
    @Param('clave') clave: string,
    @Body() dto: UpdateConfiguracionDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.config.update(clave, dto, current.userId);
  }
}
