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
import { AdjuntosIngenieriaService } from './adjuntos-ingenieria.service';
import { ComponentesService } from './componentes.service';
import {
  CreateAdjuntoDto,
  CreateComponenteDto,
  ReemplazarComponenteDto,
  RetirarComponenteDto,
  UpdateComponenteDto,
} from './dto/componentes.dto';
import {
  CreateMantenimientoDto,
  CreateVencimientoDto,
  UpdateMantenimientoDto,
} from './dto/engineering.dto';
import { EngineeringService } from './engineering.service';

/**
 * Quién LEE y captura componentes y quién ve/descarga archivos (invariante
 * 135): la oficina y el mecánico. Registrar o quitar un archivo y eliminar un
 * componente quedan en el default del controlador (ADMIN, COORDINADOR).
 */
export const ROLES_INGENIERIA_CON_MECANICO = [
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.MECANICO,
] as const;

@ApiTags('Engineering')
@ApiBearerAuth()
@Controller({ path: 'engineering', version: '1' })
@Roles(Rol.ADMIN, Rol.COORDINADOR)
export class EngineeringController {
  constructor(
    private readonly engineering: EngineeringService,
    private readonly componentes: ComponentesService,
    private readonly adjuntos: AdjuntosIngenieriaService,
  ) {}

  @Get('aircraft/:id/maintenance')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary: 'Mantenimientos (programados/realizados) de una aeronave',
  })
  listMaintenance(@Param('id', ParseUUIDPipe) id: string) {
    return this.engineering.listMantenimientos(id);
  }

  @Post('aircraft/:id/maintenance')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({ summary: 'Registra un mantenimiento de la aeronave' })
  createMaintenance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMantenimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engineering.createMantenimiento(id, dto, c.userId);
  }

  @Patch('maintenance/:mid')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Actualiza/transiciona un servicio (programado → en taller → completado)',
  })
  updateMaintenance(
    @Param('mid', ParseUUIDPipe) mid: string,
    @Body() dto: UpdateMantenimientoDto,
  ) {
    return this.engineering.updateMantenimiento(mid, dto);
  }

  @Get('aircraft/:id/expirations')
  @ApiOperation({
    summary: 'Permisos/licencias/servicios (vencimientos) de una aeronave',
  })
  listExpirations(@Param('id', ParseUUIDPipe) id: string) {
    return this.engineering.listVencimientos(id);
  }

  @Get('aircraft/:id/expirations-eliminadas')
  @ApiOperation({
    summary:
      'Documentos ELIMINADOS del avión (borrado suave): quién/cuándo, restaurables',
  })
  listExpirationsEliminadas(@Param('id', ParseUUIDPipe) id: string) {
    return this.engineering.listVencimientosEliminados(id);
  }

  @Post('aircraft/:id/expirations')
  @ApiOperation({ summary: 'Registra un vencimiento (alimenta las alertas)' })
  createExpiration(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVencimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engineering.createVencimiento(id, dto, c.userId);
  }

  @Get('document-types')
  @ApiOperation({
    summary: 'Catálogo de tipos de documento (para crear vencimientos)',
  })
  documentTypes() {
    return this.engineering.documentTypes();
  }

  @Get('upcoming')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.MECANICO)
  @ApiOperation({
    summary: 'Dashboard de flota: vencimientos y mantenimientos próximos.',
  })
  upcoming(
    @Query('dias') dias?: string,
    // sin_fecha=true (app nueva): incluye también los PROGRAMADO SIN fecha
    // (los auto-creados por el programa de horas, pendientes de confirmar).
    // Opt-in: el APK viejo no maneja fecha_programada null en estas filas.
    @Query('sin_fecha') sinFecha?: string,
  ) {
    const d = Math.min(Math.max(Number(dias) || 60, 1), 365);
    return this.engineering.fleetUpcoming(d, sinFecha === 'true');
  }

  // ===== Componentes del avión con vida límite (invariante 135) =====

  @Get('aircraft/:id/components')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @ApiOperation({
    summary:
      'Componentes del avión (llantas, focos, baterías…) con lo que les queda por horas y por fecha. Responde {disponible, horas_aeronave, hoy, componentes (instalados, por urgencia), retirados (tope 50)}. `vida` lo calcula el API con el Hobbs del avión y el día de hoy en Cancún. disponible=false = migración 20261117000001 sin aplicar.',
  })
  listComponents(@Param('id', ParseUUIDPipe) id: string) {
    return this.componentes.listar(id);
  }

  @Post('aircraft/:id/components')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @ApiOperation({
    summary:
      'Da de alta un componente del avión. Sin límites = se cambia «a condición» (solo se dice cuánto lleva en servicio). 503 MIGRACION_PENDIENTE sin la migración.',
  })
  createComponent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateComponenteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.componentes.crear(id, dto, c.userId);
  }

  @Patch('components/:cid')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @ApiOperation({
    summary:
      'Edita los datos capturados de un componente. Un null EXPLÍCITO limpia un opcional. No cambia el estado (para eso: reemplazar / retirar).',
  })
  updateComponent(
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() dto: UpdateComponenteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.componentes.editar(cid, dto, c.userId);
  }

  @Post('components/:cid/reemplazar')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cambio de componente: el viejo pasa a RETIRADO (fecha, Hobbs y motivo) y entra uno nuevo en su lugar que hereda nombre, categoría, posición, avisos y límites (la fecha exacta de vencimiento no). Responde {retirado, nuevo}. 409 COMPONENTE_YA_RETIRADO.',
  })
  replaceComponent(
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() dto: ReemplazarComponenteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.componentes.reemplazar(cid, dto, c.userId);
  }

  @Post('components/:cid/retirar')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Retira un componente SIN sustituto (queda en el historial con lo que estuvo en servicio). 409 COMPONENTE_YA_RETIRADO.',
  })
  retireComponent(
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() dto: RetirarComponenteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.componentes.retirar(cid, dto, c.userId);
  }

  @Delete('components/:cid')
  @ApiOperation({
    summary:
      'Elimina un componente capturado por error (baja con sello: la fila se conserva y deja de listarse). Responde {ok:true}.',
  })
  deleteComponent(
    @Param('cid', ParseUUIDPipe) cid: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.componentes.eliminar(cid, c.userId);
  }

  // ===== Archivos de ingeniería: sticker, factura, certificado… (invariante 135) =====

  @Get('aircraft/:id/adjuntos')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @ApiOperation({
    summary:
      'Archivos ACTIVOS del avión: los de sus mantenimientos, sus componentes y los motores y hélices que hoy tiene. Responde {disponible, adjuntos}; el más reciente primero. La llave del bucket nunca viaja.',
  })
  listAdjuntos(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjuntos.listarDeAeronave(id);
  }

  @Post('adjuntos')
  @ApiOperation({
    summary:
      'Registra un archivo YA subido al bucket documentos-flota para un mantenimiento, componente, motor o hélice. 404 DESTINO_NO_ENCONTRADO · 400 ARCHIVO_NO_ENCONTRADO · 409 ARCHIVO_YA_REGISTRADO · 409 TOPE_ADJUNTOS (20 por destino) · 503 MIGRACION_PENDIENTE.',
  })
  createAdjunto(
    @Body() dto: CreateAdjuntoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.adjuntos.registrar(dto, c.userId);
  }

  @Get('adjuntos/:aid/url')
  @Roles(...ROLES_INGENIERIA_CON_MECANICO)
  @ApiOperation({
    summary:
      'URL firmada (10 min) para ver el archivo; con descargar=true fuerza la descarga con su nombre original. Responde {url, expira_en_s, nombre, mime}. 404 si no existe o está eliminado.',
  })
  adjuntoUrl(
    @Param('aid', ParseUUIDPipe) aid: string,
    @Query('descargar') descargar?: string,
  ) {
    return this.adjuntos.url(aid, descargar === 'true');
  }

  @Delete('adjuntos/:aid')
  @ApiOperation({
    summary:
      'Quita un archivo (baja con sello: el archivo se conserva en el bucket). Responde {ok:true}.',
  })
  deleteAdjunto(
    @Param('aid', ParseUUIDPipe) aid: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.adjuntos.eliminar(aid, c.userId);
  }
}
