import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { esColumnaInexistente } from '../../common/columna-opcional.util';
import { SupabaseService } from '../supabase/supabase.service';
import { EmailService } from '../notifications/email.service';
import { PushService } from '../realtime/push.service';
import type { CreateUsuarioDto } from './dto/create-usuario.dto';
import type { ListUsuariosQuery } from './dto/list-usuarios.query';
import type { UpdateUsuarioDto } from './dto/update-usuario.dto';
import type { UpdateSelfDto } from './dto/update-self.dto';

const COLUMNS_BASE =
  'id, supabase_auth_id, nombre, email, rol, estado, tiene_fondo_caja, tarjeta_terminacion, es_piloto, es_piloto_externo, telefono, avatar_url, created_at, updated_at';

/**
 * `apodo` (migración `20260917000001`): nombre corto de la oficina para el
 * TÍTULO del evento de Google Calendar del vuelo («Saab N621TX cun-mid-cun
 * 10:00»). Aditivo: quien no lo lea no se entera.
 */
const COLUMNS = `${COLUMNS_BASE}, apodo`;

/** Migración que crea `usuario.apodo`. */
const MIGRACION_APODO = '20260917000001';

export interface UsuarioRow {
  id: string;
  supabase_auth_id: string;
  nombre: string;
  email: string;
  rol: string;
  estado: string;
  tiene_fondo_caja: boolean;
  tarjeta_terminacion: string | null;
  /** También vuela (rol secundario): entra a selectores de piloto y horas. */
  es_piloto: boolean;
  es_piloto_externo: boolean;
  telefono: string | null;
  avatar_url: string | null;
  /**
   * Nombre corto de la oficina («Saab», «Zamora», «Pab») para el título del
   * evento de Google Calendar. `undefined` mientras la migración
   * `20260917000001` no esté aplicada (la columna no viaja en el select).
   */
  apodo?: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /**
   * `usuario.apodo` existe. Arranca en `true` y solo se apaga si Postgres
   * responde 42703 (migración `20260917000001` sin aplicar): así el API se
   * puede desplegar ANTES de la migración sin tumbar el alta, la edición ni
   * el listado de usuarios. No se vuelve a prender hasta el siguiente
   * arranque (aplicar la migración pide un resync del calendario de todas
   * formas, porque el formato del título cambia).
   */
  private apodoDisponible = true;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
    private readonly push: PushService,
  ) {}

  /** Columnas a pedir: con `apodo` mientras la migración esté aplicada. */
  private columnas(): string {
    return this.apodoDisponible ? COLUMNS : COLUMNS_BASE;
  }

  /**
   * Apaga el soporte de `apodo` si el error es «la columna no existe», y
   * dice si hay que reintentar SIN ella. Cualquier otro error se propaga tal
   * cual (nunca se oculta un problema real).
   */
  private degradarApodo(
    error: { code?: string | null; message?: string | null } | null,
  ): boolean {
    if (!this.apodoDisponible || !esColumnaInexistente(error)) return false;
    this.apodoDisponible = false;
    this.logger.warn(
      `Columna usuario.apodo no existe todavía (migración ${MIGRACION_APODO} pendiente): el nombre corto del calendario no se guarda ni se devuelve hasta aplicarla.`,
    );
    return true;
  }

  /** Quita `apodo` de un payload cuando la columna todavía no existe. */
  private sinApodo<T extends Record<string, unknown>>(payload: T): T {
    if (this.apodoDisponible || !('apodo' in payload)) return payload;
    const resto = { ...payload };
    delete resto.apodo;
    return resto;
  }

  async list(filters: ListUsuariosQuery) {
    const consultar = (columnas: string) => {
      let query = this.supabase.service
        .from('usuario')
        .select(columnas, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(filters.offset, filters.offset + filters.limit - 1);

      if (filters.rol === 'PILOTO') {
        // "Pilotos" = quien VUELA: rol PILOTO o doble rol (ADMIN/SOCIO que
        // también vuela). Así los selectores de asignación los incluyen sin
        // cambiar a los consumidores.
        query = query.or('rol.eq.PILOTO,es_piloto.eq.true');
      } else if (filters.rol) {
        query = query.eq('rol', filters.rol);
      }
      if (filters.estado) query = query.eq('estado', filters.estado);
      if (filters.q) {
        const term = `%${filters.q}%`;
        query = query.or(`nombre.ilike.${term},email.ilike.${term}`);
      }
      return query;
    };

    let { data, error, count } = await consultar(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error, count } = await consultar(this.columnas()));
    }
    if (error) throw new Error(`Failed to list usuarios: ${error.message}`);

    // push_dispositivos (3-sep-2026): la oficina ve quién NO tiene la app
    // registrada (badge "Sin app") — una consulta agrupada, best-effort.
    const filas = (data ?? []) as unknown as UsuarioRow[];
    let conteo = new Map<string, number>();
    try {
      conteo = await this.push.contarDispositivosPorUsuario(
        filas.map((u) => u.id),
      );
    } catch {
      /* la lista no se cae por el conteo: se reporta 0 */
    }

    return {
      data: filas.map((u) => ({
        ...u,
        push_dispositivos: conteo.get(u.id) ?? 0,
      })),
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string): Promise<UsuarioRow> {
    const consultar = (columnas: string) =>
      this.supabase.service
        .from('usuario')
        .select(columnas)
        .eq('id', id)
        .maybeSingle();

    let { data, error } = await consultar(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error } = await consultar(this.columnas()));
    }
    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    if (!data) throw new NotFoundException(`Usuario ${id} not found`);
    return data as unknown as UsuarioRow;
  }

  async findByAuthId(authId: string): Promise<UsuarioRow> {
    const consultar = (columnas: string) =>
      this.supabase.service
        .from('usuario')
        .select(columnas)
        .eq('supabase_auth_id', authId)
        .maybeSingle();

    let { data, error } = await consultar(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error } = await consultar(this.columnas()));
    }
    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    if (!data) throw new NotFoundException('Usuario not provisioned');
    return data as unknown as UsuarioRow;
  }

  /**
   * Permiso TEMPORAL "gastos sin límite de tiempo" (1-sep-2026, caso Luis
   * Cáceres): mientras `now() < gastos_sin_limite_hasta` el usuario de campo
   * queda exento de los candados de TIEMPO de gastos (los aplica
   * `expenses.service`). Select puntual: la columna NO viaja en `COLUMNS`
   * (solo la consumen /me — para que la app pueda explicárselo al usuario —
   * y los candados de gastos). Devuelve el ISO tal cual o null.
   */
  async gastosSinLimiteHasta(usuarioId: string): Promise<string | null> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('gastos_sin_limite_hasta')
      .eq('id', usuarioId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load usuario: ${error.message}`);
    return (data?.gastos_sin_limite_hasta as string | null) ?? null;
  }

  /**
   * Crea un usuario sin sesión de Supabase Auth todavía. Se usa para "invitar"
   * a un piloto: queda en estado INVITADO con supabase_auth_id=null. Al primer
   * login con Google, un trigger / proceso de provisión enlaza el auth_id.
   */
  async create(dto: CreateUsuarioDto, createdBy: string): Promise<UsuarioRow> {
    if (!dto.nombre?.trim() || !dto.email?.trim()) {
      throw new BadRequestException('nombre and email are required');
    }

    const payload: Record<string, unknown> = {
      nombre: dto.nombre.trim(),
      email: dto.email.trim().toLowerCase(),
      rol: dto.rol,
      estado: dto.estado ?? 'INVITADO',
      tiene_fondo_caja: dto.tiene_fondo_caja ?? false,
      tarjeta_terminacion: dto.tarjeta_terminacion ?? '',
      es_piloto: dto.es_piloto ?? dto.rol === 'PILOTO',
      es_piloto_externo: dto.es_piloto_externo ?? false,
      telefono: dto.telefono ?? '',
      avatar_url: '',
      // Nombre corto del calendario: vacío = se usa el primer nombre.
      apodo: dto.apodo?.trim() || null,
      created_by: createdBy,
      updated_by: createdBy,
    };

    const insertar = (columnas: string) =>
      this.supabase.service
        .from('usuario')
        .insert(this.sinApodo(payload))
        .select(columnas)
        .maybeSingle();

    let { data, error } = await insertar(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error } = await insertar(this.columnas()));
    }

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(`Email already exists: ${dto.email}`);
      }
      throw new Error(`Failed to create usuario: ${error.message}`);
    }
    const usuario = data as unknown as UsuarioRow;
    // Aviso de invitación por correo (best-effort, no bloquea la creación).
    // Va ANTES del vínculo de tarjeta: si aquel truena, el invitado igual
    // recibe su correo (verificación 26-ago — el reintento daría 409).
    void this.email.sendUserInvitation({
      to: usuario.email,
      nombre: usuario.nombre,
      rol: usuario.rol,
    });
    // Alta con tarjeta (invite-pilot): vincular la tarjeta real del catálogo.
    // Best-effort tras el insert: si la terminación no existe, el usuario YA
    // quedó creado y con su invitación enviada — se limpia el espejo y el
    // 400 lo explica para que el admin no reintente el alta (daría 409).
    if (dto.tarjeta_terminacion) {
      try {
        await this.sincronizarTarjeta(
          usuario.id,
          dto.tarjeta_terminacion,
          createdBy,
        );
      } catch {
        await this.supabase.service
          .from('usuario')
          .update({ tarjeta_terminacion: '' })
          .eq('id', usuario.id);
        throw new BadRequestException(
          `El usuario quedó creado y su invitación enviada, pero la tarjeta **** ${dto.tarjeta_terminacion} no se pudo vincular (no está en Tarjetas corp. o está inactiva): asígnala después desde Editar usuario.`,
        );
      }
    }
    return usuario;
  }

  /**
   * Reenvía el correo de invitación/acceso a un usuario ya existente. Devuelve
   * si el correo se envió (false si Resend está deshabilitado o falló).
   */
  async resendInvitation(id: string): Promise<{ ok: true; sent: boolean; email: string }> {
    const user = await this.findById(id);
    if (user.estado === 'INACTIVO') {
      throw new BadRequestException(
        'El usuario está inactivo; reactívalo antes de reenviar la invitación.',
      );
    }
    // El correo de invitación promete acceso ("ya quedó autorizado") — falso
    // para un externo: la allowlist de signup lo bloquea. Nunca se le envía.
    if (user.es_piloto_externo) {
      throw new BadRequestException(
        'Los pilotos externos no tienen acceso al sistema; no hay invitación que enviar.',
      );
    }
    const sent = await this.email.sendUserInvitation({
      to: user.email,
      nombre: user.nombre,
      rol: user.rol,
      reenvio: true,
    });
    return { ok: true, sent, email: user.email };
  }

  /**
   * Lado usuario del vínculo tarjeta↔usuario (26-ago): asignar una
   * terminación aquí VINCULA la tarjeta real del catálogo (fuente única:
   * tarjeta_corporativa.usuario_id) y desvincula al dueño anterior; las
   * demás tarjetas del usuario se sueltan (esta pantalla asigna "LA tarjeta
   * del usuario" — multi-tarjeta se maneja desde Tarjetas corp.). "" =
   * desvincular todas. Terminación fuera del catálogo → 400: primero se
   * registra la tarjeta. El espejo usuario.tarjeta_terminacion lo escribe el
   * patch normal del caller; el del dueño anterior se recalcula aquí.
   */
  private async sincronizarTarjeta(
    userId: string,
    terminacion: string,
    updatedBy: string,
  ): Promise<void> {
    const sb = this.supabase.service;
    if (terminacion === '') {
      const { error } = await sb
        .from('tarjeta_corporativa')
        .update({ usuario_id: null, updated_by: updatedBy })
        .eq('usuario_id', userId);
      if (error) throw new Error(error.message);
      return;
    }
    const { data: tarjeta, error: tErr } = await sb
      .from('tarjeta_corporativa')
      .select('id, usuario_id, activa')
      .eq('terminacion', terminacion)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!tarjeta || tarjeta.activa !== true) {
      throw new BadRequestException(
        `La tarjeta **** ${terminacion} no está registrada (o está inactiva) en Tarjetas corp.: regístrala primero o deja el campo vacío.`,
      );
    }
    const prevOwner = (tarjeta.usuario_id as string | null) ?? null;
    // Ya es SU tarjeta: nada que hacer. Sin esto, cada guardado del diálogo
    // (que manda la terminación aunque no cambie) desvinculaba las DEMÁS
    // tarjetas del usuario y bumpeaba updated_at (verificación 26-ago).
    if (prevOwner === userId) return;
    const { error: e1 } = await sb
      .from('tarjeta_corporativa')
      .update({ usuario_id: null, updated_by: updatedBy })
      .eq('usuario_id', userId)
      .neq('id', tarjeta.id as string);
    if (e1) throw new Error(e1.message);
    const { error: e2 } = await sb
      .from('tarjeta_corporativa')
      .update({ usuario_id: userId, updated_by: updatedBy })
      .eq('id', tarjeta.id as string);
    if (e2) throw new Error(e2.message);
    // El dueño anterior pierde esta tarjeta: su espejo se recalcula desde el
    // catálogo (otra tarjeta suya vinculada, o vacío).
    if (prevOwner && prevOwner !== userId) {
      const { data: otra } = await sb
        .from('tarjeta_corporativa')
        .select('terminacion')
        .eq('usuario_id', prevOwner)
        .eq('activa', true)
        .order('updated_at', { ascending: false })
        .limit(1);
      const { error: e3 } = await sb
        .from('usuario')
        .update({
          tarjeta_terminacion:
            ((otra?.[0]?.terminacion as string | undefined) ?? '') || '',
        })
        .eq('id', prevOwner);
      if (e3) throw new Error(e3.message);
    }
  }

  async update(id: string, patch: UpdateUsuarioDto, updatedBy: string): Promise<UsuarioRow> {
    if (Object.keys(patch).length === 0) {
      return this.findById(id);
    }
    const extra: Record<string, unknown> = {};
    // "Piloto externo" es EXCLUSIVO de freelance sin cuenta: marcárselo a un
    // usuario ya enlazado a auth lo dejaría FUERA del sistema al instante
    // (resolveUser rechaza externos) — pasó con un ADMIN real por accidente.
    if (patch.es_piloto_externo === true) {
      const current = await this.findById(id);
      if (current.supabase_auth_id) {
        throw new BadRequestException(
          `${current.nombre} ya tiene cuenta con acceso: marcarlo como piloto externo lo bloquearía por completo. Ese flag es solo para freelance dados de alta sin usuario.`,
        );
      }
    }
    // Convertir un piloto EXTERNO en piloto de base NO le abre acceso directo:
    // sin cuenta enlazada pasa por el flujo normal de invitación (INVITADO →
    // primer login con Google → un admin lo activa).
    if (patch.es_piloto_externo === false) {
      const current = await this.findById(id);
      if (current.es_piloto_externo && !current.supabase_auth_id) {
        extra.estado = 'INVITADO';
      }
    }
    // Vínculo de tarjeta: primero el catálogo (400 si la terminación no
    // existe → no se escribe nada del usuario). null explícito = desvincular
    // (el "" del form lo tira stripEmpty en el panel; null sobrevive) y el
    // espejo del usuario se normaliza a ''.
    if (patch.tarjeta_terminacion !== undefined) {
      await this.sincronizarTarjeta(
        id,
        patch.tarjeta_terminacion ?? '',
        updatedBy,
      );
      if (patch.tarjeta_terminacion === null) {
        extra.tarjeta_terminacion = '';
      }
    }
    // Nombre corto del calendario: "" (el form vacío) = quitar el apodo.
    if (patch.apodo !== undefined) {
      extra.apodo = patch.apodo?.trim() ? patch.apodo.trim() : null;
    }
    const escribir = (columnas: string) =>
      this.supabase.service
        .from('usuario')
        .update(this.sinApodo({ ...patch, ...extra, updated_by: updatedBy }))
        .eq('id', id)
        .select(columnas)
        .maybeSingle();

    let { data, error } = await escribir(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error } = await escribir(this.columnas()));
    }

    if (error) throw new Error(`Failed to update usuario: ${error.message}`);
    if (!data) throw new NotFoundException(`Usuario ${id} not found`);
    return data as unknown as UsuarioRow;
  }

  async updateSelf(
    authId: string,
    patch: UpdateSelfDto,
    updatedBy: string,
  ): Promise<UsuarioRow> {
    if (Object.keys(patch).length === 0) {
      return this.findByAuthId(authId);
    }
    const escribir = (columnas: string) =>
      this.supabase.service
        .from('usuario')
        .update({ ...patch, updated_by: updatedBy })
        .eq('supabase_auth_id', authId)
        .select(columnas)
        .maybeSingle();

    let { data, error } = await escribir(this.columnas());
    if (error && this.degradarApodo(error)) {
      ({ data, error } = await escribir(this.columnas()));
    }

    if (error) throw new Error(`Failed to update self: ${error.message}`);
    if (!data) throw new NotFoundException('Usuario not provisioned');
    return data as unknown as UsuarioRow;
  }

  async softDelete(id: string, updatedBy: string): Promise<UsuarioRow> {
    return this.update(id, { estado: 'INACTIVO' as never }, updatedBy);
  }

  /**
   * Define / restablece la contraseña de un usuario en Supabase Auth.
   *
   * - Si el usuario YA tiene `supabase_auth_id` (ya inició sesión con Google
   *   alguna vez) se actualiza su password con `auth.admin.updateUserById`.
   * - Si NO tiene `supabase_auth_id` (todavía no se loguea), se crea la cuenta
   *   en Supabase Auth con su mismo email + password indicado y se enlaza al
   *   row `usuario`. Útil para pre-cargar credenciales de pruebas antes del
   *   primer login.
   *
   * En ambos casos el usuario puede luego loguearse con email/contraseña o
   * con Google (Supabase une cuentas por email).
   */
  async resetPassword(
    id: string,
    newPassword: string,
    actorId: string,
  ): Promise<{ ok: true; created_auth_user: boolean; supabase_auth_id: string }> {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }

    const user = await this.findById(id);
    // Piloto externo (doc 3.7): JAMÁS tiene acceso — esta vía crearía su
    // cuenta de auth y le abriría la puerta aunque la allowlist lo excluya.
    if (user.es_piloto_externo) {
      throw new BadRequestException(
        'Los pilotos externos no tienen acceso al sistema; no se les puede asignar contraseña.',
      );
    }

    if (user.supabase_auth_id) {
      const { error } = await this.supabase.service.auth.admin.updateUserById(
        user.supabase_auth_id,
        { password: newPassword },
      );
      if (error) {
        throw new Error(`Failed to update password: ${error.message}`);
      }
      return {
        ok: true,
        created_auth_user: false,
        supabase_auth_id: user.supabase_auth_id,
      };
    }

    // No auth user yet — create one with email/password and link.
    const { data: created, error: createErr } =
      await this.supabase.service.auth.admin.createUser({
        email: user.email,
        password: newPassword,
        email_confirm: true,
        user_metadata: { nombre: user.nombre, provisioned_by: actorId },
      });

    if (createErr || !created.user) {
      throw new Error(
        `Failed to create auth user: ${createErr?.message ?? 'unknown error'}`,
      );
    }

    const authId = created.user.id;
    const { error: linkErr } = await this.supabase.service
      .from('usuario')
      .update({ supabase_auth_id: authId, updated_by: actorId })
      .eq('id', id);

    if (linkErr) {
      throw new Error(`Failed to link auth user: ${linkErr.message}`);
    }

    return {
      ok: true,
      created_auth_user: true,
      supabase_auth_id: authId,
    };
  }

  /**
   * Horas voladas del usuario en un mes (hora Cancún): suma de
   * taco_llegada − taco_salida de las escalas donde fue piloto (del tramo o,
   * si el tramo no tiene, del vuelo). Límite de 90 hrs/mes: INFORMATIVO
   * (doc 3.6), nunca bloquea. Consulta rápida del piloto en la app.
   */
  async horasDelMes(userId: string, mes?: string) {
    const mesValido = /^\d{4}-(0[1-9]|1[0-2])$/.test(mes ?? '')
      ? (mes as string)
      : new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Cancun',
          year: 'numeric',
          month: '2-digit',
        })
          .format(new Date())
          .slice(0, 7);
    const [y, m] = mesValido.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const desde = `${mesValido}-01T00:00:00-05:00`;
    const hasta = `${mesValido}-${String(ultimoDia).padStart(2, '0')}T23:59:59-05:00`;

    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        'piloto_id, taco_salida, taco_llegada, vuelo:vuelo_id!inner(id, folio, piloto_id, estado, fecha_vuelo)',
      )
      .neq('vuelo.estado', 'CANCELADO')
      .gte('vuelo.fecha_vuelo', desde)
      .lte('vuelo.fecha_vuelo', hasta);
    if (error) throw new Error(error.message);

    let horas = 0;
    const vuelos = new Set<string>();
    for (const e of (data ?? []) as Array<Record<string, unknown>>) {
      const vuelo = (Array.isArray(e.vuelo) ? e.vuelo[0] : e.vuelo) as Record<
        string,
        unknown
      > | null;
      const pilotoTramo = (e.piloto_id as string | null) ?? (vuelo?.piloto_id as string | null);
      if (pilotoTramo !== userId) continue;
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (!Number.isFinite(h) || h <= 0) continue;
      horas += h;
      if (vuelo?.id) vuelos.add(vuelo.id as string);
    }

    const total = Math.round(horas * 10) / 10;
    return {
      mes: mesValido,
      horas: total,
      vuelos: vuelos.size,
      limite: 90,
      restantes: Math.round((90 - total) * 10) / 10,
    };
  }
}
