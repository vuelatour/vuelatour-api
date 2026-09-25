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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  LIMITE_MULTER_FACTURA_BYTES,
  type ArchivoMultipart,
} from '../flights/factura-cliente.util';
import {
  AplicarAnticipoDto,
  BajaIngresoDto,
  CobroDesdeAbonoDto,
  CrearIngresoMultipartDto,
  EditarIngresoMultipartDto,
  EntradasQuery,
  ExportIngresosQuery,
  ListIngresosQuery,
  ResumenIngresosQuery,
  VuelosCandidatosIngresoQuery,
} from './dto/ingresos.dto';
import { IngresosService } from './ingresos.service';

/**
 * Roles de la CLASE = los del menú «Gastos» (oficina). Constante EXPORTADA:
 * el spec congela que la clase apunte a ella.
 */
export const ROLES_INGRESOS = [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION];

/**
 * Roles que CONCILIAN con el banco y BORRAN cobros (= controller de
 * conciliación y DELETE flights/cobros/:id). Un `@Roles` de MÉTODO manda
 * sobre el de la clase (`getAllAndOverride`): Ingresos no es una puerta
 * trasera para COORDINADOR.
 */
export const ROLES_CONCILIAR = [Rol.ADMIN, Rol.FACTURACION];

/**
 * Multipart del comprobante: campo `archivo` (uno). Multer corta con 1 MB de
 * margen sobre los 10 MB de negocio para que el servicio diga el peso EXACTO
 * (413 ARCHIVO_MUY_GRANDE).
 */
const ArchivoIngresoInterceptor = () =>
  FileInterceptor('archivo', {
    limits: { fileSize: LIMITE_MULTER_FACTURA_BYTES },
  });

/** `Content-Disposition` con nombre ASCII + `filename*` UTF-8. */
function disposicion(nombre: string): string {
  const ascii = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

/**
 * INGRESOS (24-sep-2026): otros ingresos, anticipos de clientes y la vista
 * unificada de todo el dinero que entra. ORDEN: las rutas LITERALES van
 * ANTES de `:id` (convención del repo). Sin la migración 20260924000004 todo
 * responde 503 INGRESOS_NO_DISPONIBLE.
 */
@ApiTags('Ingresos')
@ApiBearerAuth()
@Roles(...ROLES_INGRESOS)
@Controller({ path: 'ingresos', version: '1' })
export class IngresosController {
  constructor(private readonly svc: IngresosService) {}

  @Get('resumen')
  @ApiOperation({
    summary:
      'Tarjetas por moneda del periodo (default: mes corriente Cancún): cobros de vuelos (conciliado / sin conciliar / no pasa por el banco), otros ingresos, anticipos (saldo por aplicar), aportaciones, abonos por identificar. NOMINAL por moneda; los cobros aplicados de un anticipo no suman otra vez.',
  })
  resumen(@Query() q: ResumenIngresosQuery) {
    return this.svc.resumen(q);
  }

  @Get('entradas')
  @ApiOperation({
    summary:
      'Todo el dinero que entra en una lista (solo lectura): cobros de vuelos + ingresos registrados, orden por día desc. Filtros: origen, moneda, método, categoría, conciliación, vuelo=por_volar, q. Paginado 1..200.',
  })
  entradas(@Query() q: EntradasQuery) {
    return this.svc.entradas(q);
  }

  @Get('export.xlsx')
  @ApiOperation({
    summary:
      'Excel de ingresos (Resumen · Ingresos · Cobros de vuelos · Anticipos) con los filtros de «entradas» + vista.',
  })
  async exportXlsx(@Query() q: ExportIngresosQuery): Promise<StreamableFile> {
    const { buffer, filename } = await this.svc.exportXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: disposicion(filename),
    });
  }

  @Get('vuelos-candidatos')
  @ApiOperation({
    summary:
      'Vuelos para aplicar un anticipo o para «Es el pago de un vuelo»: ?cliente_id (vuelos del cliente) o ?q (folio o nombre, ≥ 2) con alcance=todos. Cobrado/saldo por cobrosEnUsd. Tope 50.',
  })
  vuelosCandidatos(@Query() q: VuelosCandidatosIngresoQuery) {
    return this.svc.vuelosCandidatos(q);
  }

  @Post('abonos/:movId/cobro-de-vuelo')
  @Roles(...ROLES_CONCILIAR)
  @ApiOperation({
    summary:
      '«Es el pago de un vuelo»: registra el cobro del vuelo desde un abono del banco (createCobro) y lo concilia (linkCobro); si la liga falla, el cobro se borra. Idempotente por client_request_id. 409 INGRESO_MONTO_DISTINTO / MOVIMIENTO_YA_LIGADO / COBRO_EXCEDE_SALDO.',
  })
  async cobroDeVuelo(
    @Param('movId', ParseUUIDPipe) movId: string,
    @Body() dto: CobroDesdeAbonoDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.cobroDeVueloDesdeAbono(movId, dto, c);
    if (r.idempotente) res.status(HttpStatus.OK);
    return r;
  }

  @Get()
  @ApiOperation({
    summary:
      'Ingresos registrados: vista=otros|anticipos|todos, categoría, moneda, cuenta, cliente, conciliación, saldo=con_saldo|todos (anticipos), bajas=excluir|incluir|solo, q. Paginado 1..200 con totales por moneda.',
  })
  lista(@Query() q: ListIngresosQuery) {
    return this.svc.lista(q);
  }

  @Post()
  @UseInterceptors(ArchivoIngresoInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Registra un ingreso: campo de texto `datos` (JSON de CrearIngresoDto) + `archivo` opcional (foto o PDF ≤ 10 MB). Con movimiento_bancario_id se concilia con ese abono (ADMIN/FACTURACION). Idempotente por client_request_id (200 + idempotente:true). 201 { ingreso, movimiento_id, avisos }.',
  })
  async crear(
    @UploadedFile() archivo: ArchivoMultipart | undefined,
    @Body() dto: CrearIngresoMultipartDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.crear(dto.datos, archivo, c);
    if (r.idempotente) res.status(HttpStatus.OK);
    return r;
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalle: ingreso, aplicaciones (anticipo), abono que lo concilia y bitácora (≤ 100, más nueva primero).',
  })
  obtener(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.obtener(id);
  }

  @Patch(':id')
  @UseInterceptors(ArchivoIngresoInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Edita (multipart `datos` = EditarIngresoDto + `archivo`). Re-valida el estado FUSIONADO; 409 INGRESO_CONCILIADO / ANTICIPO_CON_APLICACIONES / ANTICIPO_MONTO_MENOR_A_APLICADO / CONFLICTO_VERSION. Archivo nuevo = reemplazo (el anterior queda en el historial).',
  })
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() archivo: ArchivoMultipart | undefined,
    @Body() dto: EditarIngresoMultipartDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.editar(id, dto?.datos ?? '{}', archivo, c);
  }

  @Post(':id/baja')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Da de baja el ingreso (soft delete con motivo 5..500). 409 INGRESO_CONCILIADO / ANTICIPO_CON_APLICACIONES / INGRESO_DADO_DE_BAJA.',
  })
  baja(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BajaIngresoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.baja(id, dto.motivo, c);
  }

  @Get(':id/archivo-url')
  @ApiOperation({
    summary: 'URL firmada (600 s) del comprobante. 404 SIN_ARCHIVO.',
  })
  archivoUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.archivoUrl(id);
  }

  @Post(':id/archivo/quitar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quita el comprobante del ingreso SIN borrar el objeto del bucket (queda en el historial).',
  })
  quitarArchivo(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.quitarArchivo(id, c);
  }

  @Post(':id/aplicaciones')
  @ApiOperation({
    summary:
      'Aplica un anticipo a un vuelo: crea un cobro NORMAL del vuelo (createCobro) ligado al anticipo. client_request_id OBLIGATORIO (reintento ⇒ 200 idempotente). 409 ANTICIPO_SIN_SALDO / ANTICIPO_OTRO_CLIENTE / NO_ES_ANTICIPO / COBRO_EXCEDE_SALDO.',
  })
  async aplicar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AplicarAnticipoDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.aplicar(id, dto, c);
    if (r.idempotente) res.status(HttpStatus.OK);
    return r;
  }

  @Delete(':id/aplicaciones/:cobroId')
  @Roles(...ROLES_CONCILIAR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Desaplica: borra el cobro del vuelo (mismos candados que borrar un cobro; ADMIN/FACTURACION) y el monto regresa al saldo del anticipo. 404 APLICACION_NO_EXISTE.',
  })
  desaplicar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cobroId', ParseUUIDPipe) cobroId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.svc.desaplicar(id, cobroId, c);
  }
}
