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
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CobroReciboService } from '../flights/cobro-recibo.service';
import { ArmarGrupoDto } from './dto/armar-grupo.dto';
import { CreateCobroGrupoDto } from './dto/cobro-grupo.dto';
import { CreateGrupoDto } from './dto/create-grupo.dto';
import {
  CancelGrupoDto,
  FechaGrupoDto,
  QuitarAvionDto,
  ReemplazarAvionDto,
} from './dto/grupo-acciones.dto';
import { ListGruposQuery } from './dto/list-grupos.query';
import { ReviseGrupoDto } from './dto/revise-grupo.dto';
import { GroupsPdfService } from './groups-pdf.service';
import { GroupsService } from './groups.service';

const LECTURA = [
  Rol.ADMIN,
  Rol.COORDINADOR,
  Rol.FACTURACION,
  Rol.ANALISTA,
  Rol.SOCIO,
] as const;

/** Quién registra/re-parte el SOBRE de cobro (el PILOTO no cobra a nivel grupo). */
const COBRA_GRUPO = [Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION] as const;

@ApiTags('Grupos')
@ApiBearerAuth()
@Controller({ path: 'grupos', version: '1' })
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly groupsPdf: GroupsPdfService,
    private readonly recibo: CobroReciboService,
  ) {}

  // ===== SOBRE de cobro (Fase 2) — rutas literales `cobros/...` ANTES de ':id'.

  @Get('cobros/:cobroGrupoId/recibo.pdf')
  @Roles(...LECTURA)
  @ApiOperation({
    summary:
      'Recibo de pago del SOBRE de grupo en PDF (NO fiscal). Folio REC-G<n>-<k>; concepto "N aeronaves · P pasajeros · ruta"; total/cobrado/saldo del GRUPO (Σ hijos vivos), sin precios por avión. Solo sobres positivos (409 en reembolsos).',
  })
  async reciboSobrePdf(
    @Param('cobroGrupoId', ParseUUIDPipe) cobroGrupoId: string,
  ): Promise<StreamableFile> {
    const { buffer, folioRecibo } = await this.recibo.pdfGrupo(cobroGrupoId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="recibo-${folioRecibo}.pdf"`,
    });
  }

  @Post('cobros/:cobroGrupoId/repartir')
  @Roles(...COBRA_GRUPO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Re-parte el sobre SOLO entre los hijos vivos con la regla AUTO (tras quitar/agregar un avión). La conciliación del sobre no se toca (el banco enlaza al sobre). 409 MES_CERRADO si una parte vieja está en mes cerrado.',
  })
  repartirCobro(
    @Param('cobroGrupoId', ParseUUIDPipe) cobroGrupoId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.repartirCobro(cobroGrupoId, c.userId);
  }

  @Delete('cobros/:cobroGrupoId')
  @Roles(Rol.ADMIN, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Elimina el sobre y sus N partes (confirmación obligatoria en UI). 409 COBRO_CONCILIADO si el banco lo enlaza; 409 MES_CERRADO si alguna parte está en mes cerrado.',
  })
  eliminarCobro(
    @Param('cobroGrupoId', ParseUUIDPipe) cobroGrupoId: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.eliminarCobro(cobroGrupoId, c.userId);
  }

  // Rutas literales ANTES de ':id' (convención del repo).
  @Post('armar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'PREVIEW de la cotización de grupo sin escribir: propone flota si no viene, valida capacidad/pilotos/aviones, corre el motor por avión y devuelve el consolidado.',
  })
  armar(@Body() dto: ArmarGrupoDto) {
    return this.groups.armar(dto);
  }

  @Get()
  @Roles(...LECTURA)
  @ApiOperation({
    summary: 'Lista de grupos con estado derivado y totales Σ de hijos.',
  })
  list(@Query() q: ListGruposQuery) {
    return this.groups.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Crea la cabecera y los N vuelos hijos (uno por avión) con compensación total si falla uno.',
  })
  create(@Body() dto: CreateGrupoDto, @CurrentUser() c: AuthenticatedUser) {
    return this.groups.create(dto, c.userId);
  }

  @Get(':id')
  @Roles(...LECTURA)
  @ApiOperation({
    summary:
      'Detalle: cabecera + hijos (vivos y cancelados) + consolidado + estado derivado + operación + avisos.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.groups.findOne(id);
  }

  @Get(':id/cobros')
  @Roles(...LECTURA)
  @ApiOperation({
    summary:
      'Sobres de cobro del grupo con sus partes por avión, conciliación y recibo disponible.',
  })
  listarCobros(@Param('id', ParseUUIDPipe) id: string) {
    return this.groups.listarCobros(id);
  }

  @Post(':id/cobros/previsualizar')
  @Roles(...COBRA_GRUPO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'PREVIEW del sobre sin escribir: modo (LIQUIDACION/PROPORCIONAL/MANUAL), partes con matrícula/folio/posición y saldo antes/después, verificación Σ y avisos.',
  })
  previsualizarCobro(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCobroGrupoDto,
  ) {
    return this.groups.previsualizarCobro(id, dto);
  }

  @Post(':id/cobros')
  @Roles(...COBRA_GRUPO)
  @ApiOperation({
    summary:
      'Registra el SOBRE (pago único del cliente) y lo parte en N cobro_vuelo por el mismo camino que el cobro por vuelo. 201; con client_request_id repetido devuelve el sobre existente (200). Compensación total si falla una parte (409).',
  })
  async registrarCobro(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCobroGrupoDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.groups.registrarCobro(id, dto, c.userId);
    res.status(r.idempotente ? HttpStatus.OK : HttpStatus.CREATED);
    return r;
  }

  @Post(':id/revise')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Revisa el grupo: cabecera + aviones (actualiza/agrega/cancela hijos, re-materializa extras y ajuste). 409 listando hijos congelados.',
  })
  revise(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseGrupoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.revise(id, dto, c.userId);
  }

  @Post(':id/confirm')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirma TODOS los hijos vivos (pre-check de los N).',
  })
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.confirm(id, c.userId);
  }

  @Post(':id/cancel')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancela el grupo: N × cancel de hijos (respeta candados) y sella la cabecera.',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelGrupoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.cancel(id, dto.motivo, c.userId);
  }

  @Patch(':id/fecha')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Reagenda el grupo: N × assign {fecha_vuelo} conservando el escalonado de cada avión.',
  })
  fecha(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FechaGrupoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.reagendar(id, dto.fecha_vuelo, c.userId);
  }

  @Delete(':id/aviones/:vueloId')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Quita un avión del grupo (cancela el hijo) y re-materializa extras/ajuste en los demás.',
  })
  quitarAvion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vueloId', ParseUUIDPipe) vueloId: string,
    @Body() dto: QuitarAvionDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.quitarAvion(id, vueloId, dto, c.userId);
  }

  @Post(':id/aviones/:vueloId/reemplazar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reemplaza el avión de un hijo: SIMPLE (assign + recotizar opcional) o ULTIMO_MINUTO (reassign-aircraft, clon).',
  })
  reemplazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vueloId', ParseUUIDPipe) vueloId: string,
    @Body() dto: ReemplazarAvionDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.groups.reemplazarAvion(id, vueloId, dto, c.userId);
  }

  @Post(':id/pdf')
  @Roles(...LECTURA)
  @ApiOperation({
    summary:
      'PDF único del grupo (total consolidado + anexo de flota) vía pyservices.',
  })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, folio } = await this.groupsPdf.render(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cotizacion-grupo-G-${folio}.pdf"`,
    });
    res.send(buffer);
  }
}
