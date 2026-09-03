import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CalendarService } from '../calendar/calendar.service';
import { MisEventosQuery } from '../calendar/dto/calendar.dto';
import {
  CONFIG_CAPTURA_TACO_FOTO_IA,
  CONFIG_DIAS_GRACIA_GASTOS_SEMANA,
  ConfiguracionService,
} from '../configuracion/configuracion.service';
import { ListDescansosQuery } from '../pilots/dto/pilots.dto';
import { PilotsService } from '../pilots/pilots.service';
import { PushService } from '../realtime/push.service';
import { UpdateSelfDto } from '../users/dto/update-self.dto';
import { UsersService } from '../users/users.service';
import { CapturasQuery } from './dto/capturas.dto';
import { MeCapturasService } from './me-capturas.service';

@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly capturas: MeCapturasService,
    private readonly pilots: PilotsService,
    private readonly configuracion: ConfiguracionService,
    private readonly calendar: CalendarService,
    private readonly push: PushService,
  ) {}

  /** Dispositivos push del propio usuario (0 = este teléfono no recibe
   *  avisos; la app lo muestra en rojo en Perfil). Best-effort: nunca
   *  tumba /me. */
  private async misDispositivos(userId: string): Promise<number> {
    try {
      return (
        (await this.push.contarDispositivosPorUsuario([userId])).get(userId) ??
        0
      );
    } catch {
      return 0;
    }
  }

  @Get()
  @ApiOperation({ summary: 'Current authenticated user profile' })
  async me(@CurrentUser() current: AuthenticatedUser) {
    // Las banderas de comportamiento viajan DENTRO de /me: es el único read
    // que la app consulta siempre al arrancar y cachea entero para offline —
    // así el toggle llega al piloto sin plomería nueva.
    const [
      usuario,
      capturaTacoFotoIa,
      diasGraciaSemana,
      sinLimiteHasta,
      pushDispositivos,
    ] = await Promise.all([
      this.users.findByAuthId(current.authId),
      this.configuracion.isActiva(CONFIG_CAPTURA_TACO_FOTO_IA),
      this.configuracion.numero(CONFIG_DIAS_GRACIA_GASTOS_SEMANA, 1),
      this.users.gastosSinLimiteHasta(current.userId),
      this.misDispositivos(current.userId),
    ]);
    return {
      ...usuario,
      // Top-level a propósito (3-sep-2026): `config` conserva su shape.
      push_dispositivos: pushDispositivos,
      config: {
        captura_taco_foto_ia: capturaTacoFotoIa,
        dias_gracia_gastos_semana: diasGraciaSemana,
        // Permiso temporal (1-sep, caso Luis): mientras ahora < esta fecha,
        // los candados de TIEMPO de gastos no aplican a este usuario; la app
        // lo usa solo para no regañarlo en la UI. ISO o null (= regla normal).
        gastos_sin_limite_hasta: sinLimiteHasta,
      },
    };
  }

  @Patch()
  @ApiOperation({ summary: 'Update non-privileged fields of the current user' })
  async update(
    @Body() body: UpdateSelfDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    // MISMO shape que el GET: la app guarda esta respuesta en la misma llave
    // de caché offline que /me — sin `config` la bandera revertía al default
    // al editar el perfil (hallazgo de la revisión adversarial, ago 2026).
    const [
      usuario,
      capturaTacoFotoIa,
      diasGraciaSemana,
      sinLimiteHasta,
      pushDispositivos,
    ] = await Promise.all([
      this.users.updateSelf(current.authId, body, current.userId),
      this.configuracion.isActiva(CONFIG_CAPTURA_TACO_FOTO_IA),
      this.configuracion.numero(CONFIG_DIAS_GRACIA_GASTOS_SEMANA, 1),
      this.users.gastosSinLimiteHasta(current.userId),
      this.misDispositivos(current.userId),
    ]);
    return {
      ...usuario,
      push_dispositivos: pushDispositivos,
      config: {
        captura_taco_foto_ia: capturaTacoFotoIa,
        dias_gracia_gastos_semana: diasGraciaSemana,
        // MISMO shape que el GET (ver nota de la llave de caché offline).
        gastos_sin_limite_hasta: sinLimiteHasta,
      },
    };
  }

  @Get('horas')
  // Decisión del cliente (1 ago 2026): los PILOTOS no deben ver sus horas de
  // vuelo — solo oficina. La app instalada degrada con un texto benigno
  // ("Necesitas conexión…") al recibir 403; la app nueva ya ni lo pide.
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Horas voladas del usuario actual (mes en curso o ?mes=YYYY-MM) vs límite informativo de 90 hrs/mes. SOLO oficina: los pilotos no ven sus horas.',
  })
  horas(@CurrentUser() current: AuthenticatedUser, @Query('mes') mes?: string) {
    return this.users.horasDelMes(current.userId, mes);
  }

  @Get('descansos')
  @ApiOperation({
    summary:
      'Descansos marcados del usuario actual (para el calendario de la app). ' +
      'Siempre filtra por el usuario autenticado: /pilots/descansos es de oficina.',
  })
  misDescansos(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: ListDescansosQuery,
  ) {
    return this.pilots.listDescansos({
      ...query,
      piloto_id: current.userId,
    });
  }

  @Get('eventos')
  @ApiOperation({
    summary:
      'Eventos NO-vuelo donde el usuario actual es RESPONSABLE (citas: lavado, trámite, "llenar bitácora"…). Rango en días Cancún ?desde&hasta (default hoy-7 → hoy+90); una fila por evento, sin expandir por día. Siempre filtra por el usuario autenticado; VISITANTE recibe [].',
  })
  misEventos(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: MisEventosQuery,
  ) {
    if (current.rol === Rol.VISITANTE) return [];
    return this.calendar.listEventosDeResponsable(
      current.userId,
      query.desde,
      query.hasta,
    );
  }

  @Get('capturas')
  @Roles(Rol.PILOTO, Rol.MECANICO, Rol.ADMIN, Rol.COORDINADOR, Rol.VISITANTE)
  @ApiOperation({
    summary:
      'Historial de capturas del usuario actual (gastos, combustible, cobros, tacómetros, mantenimientos) unificado por fecha desc. Evidencia de que la sincronización de la app quedó en el servidor; SIEMPRE filtra por el usuario autenticado.',
  })
  misCapturas(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: CapturasQuery,
  ) {
    return this.capturas.capturas(current.userId, query);
  }
}
