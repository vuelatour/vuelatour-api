import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { UpdateConfiguracionDto } from './dto/configuracion.dto';
import {
  errorFacturasNoDisponibles,
  facturaEmitidaDisponible,
} from '../../common/factura-emitida-disponible.util';
import {
  elegirDestinatarios,
  type UsuarioAviso,
} from '../flights/factura-solicitud.util';
import type { ResponsablesFacturacion } from '../facturas-emitidas/facturas-emitidas.types';

const COLS = 'clave, activa, valor_numerico, descripcion, updated_at';

/** Claves conocidas (no regar strings sueltos por el código). */
export const CONFIG_CAPTURA_TACO_FOTO_IA = 'captura_taco_foto_ia';
/**
 * Días de gracia de la SEMANA de gastos (regla 1-sep-2026, audio del equipo):
 * los roles de campo capturan/corrigen dentro del bloque lunes→domingo en
 * pared Cancún, y tras el domingo tienen estos días extra para lo de la
 * semana pasada (1 = hasta el lunes). Default 1 en los consumidores.
 */
export const CONFIG_DIAS_GRACIA_GASTOS_SEMANA = 'dias_gracia_gastos_semana';
/**
 * Comisión (%) que Paywise retiene por cobro (9-sep-2026, ≈ 8.857 %). Se
 * provisiona por default en `createCobro`/sobre de grupo cuando el método
 * es PAYWISE y no viene comisión capturada; el estado de cuenta de Paywise
 * la sustituye por la REAL al conciliar. Default en los consumidores:
 * `PAYWISE_COMISION_PCT_DEFAULT`.
 */
export const CONFIG_PAYWISE_COMISION_PCT = 'paywise_comision_pct';
export const PAYWISE_COMISION_PCT_DEFAULT = 8.857;
/**
 * RESPONSABLES DE FACTURACIÓN (24-sep-2026, migración 20260924000003): lista
 * de usuarios de oficina (`valor_json`, arreglo de uuids) que reciben el
 * aviso «Factura pedida» cuando alguien marca «Necesito factura». Vacía ⇒
 * usuarios con rol FACTURACION; si no hay ⇒ todos los ADMIN activos. Su
 * `activa` NO significa nada: se EXCLUYE del listado general (el panel pinta
 * cada fila como switch) y se edita solo en su propia ruta.
 */
export const CONFIG_RESPONSABLES_FACTURACION = 'responsables_facturacion';

/** Roles de oficina que pueden ser responsables de facturación. */
const ROLES_OFICINA_FACTURACION = ['ADMIN', 'COORDINADOR', 'FACTURACION'];

/** Fila cacheada de una bandera: estado on/off + valor numérico opcional. */
type ConfigRow = { activa: boolean; valor_numerico: number | null };

/** Usuario de oficina (candidato a responsable de facturación). */
interface UsuarioOficina {
  id: string;
  nombre: string;
  rol: string;
}

/**
 * Banderas globales de comportamiento del sistema (tabla
 * `configuracion_sistema`). Lecturas con caché corto: /me las consulta en
 * cada arranque de la app y los gates de IA en cada captura — 60 s de
 * retraso máximo al propagar un toggle es aceptable y evita golpear la BD.
 */
@Injectable()
export class ConfiguracionService {
  private readonly logger = new Logger(ConfiguracionService.name);
  private cache: { data: Map<string, ConfigRow>; at: number } | null = null;
  /** Caché corto (60 s) de los ids de responsables (`valor_json`). */
  private cacheResponsables: { ids: string[]; at: number } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .select(COLS)
      // La lista de responsables se edita en su propia sección (su `activa`
      // no significa nada y el panel pinta cada fila como switch).
      .neq('clave', CONFIG_RESPONSABLES_FACTURACION)
      .order('clave');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Fila cacheada de una bandera. Best-effort: una consulta caída jamás tira
   * /me ni una captura — responde el último valor conocido (o nada, y el
   * llamador aplica su default).
   */
  private async cachedRow(clave: string): Promise<ConfigRow | undefined> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > ConfiguracionService.TTL_MS) {
      const { data, error } = await this.supabase.service
        .from('configuracion_sistema')
        .select('clave, activa, valor_numerico');
      if (error) return this.cache?.data.get(clave);
      this.cache = {
        data: new Map(
          (data ?? []).map((r) => [
            r.clave as string,
            {
              activa: r.activa as boolean,
              valor_numerico:
                r.valor_numerico == null ? null : Number(r.valor_numerico),
            },
          ]),
        ),
        at: now,
      };
    }
    return this.cache.data.get(clave);
  }

  /**
   * Valor de una bandera con default seguro si la fila no existe. Best-effort:
   * una consulta caída jamás tira /me ni una captura — responde el último
   * valor conocido o el default.
   */
  async isActiva(clave: string, porDefecto = true): Promise<boolean> {
    return (await this.cachedRow(clave))?.activa ?? porDefecto;
  }

  /**
   * Valor NUMÉRICO de una bandera (p.ej. días de la ventana de edición de
   * gastos). Mismo caché y mismo best-effort que `isActiva`; si la fila no
   * existe o su valor es null, responde el default.
   */
  async numero(clave: string, porDefecto: number): Promise<number> {
    return (await this.cachedRow(clave))?.valor_numerico ?? porDefecto;
  }

  async update(clave: string, dto: UpdateConfiguracionDto, userId: string) {
    if (clave === CONFIG_RESPONSABLES_FACTURACION) {
      throw new BadRequestException({
        message: 'Esta configuración se edita en Responsables de facturación.',
        error: 'CLAVE_NO_EDITABLE_AQUI',
        details: { clave },
      });
    }
    const patch: Record<string, unknown> = {};
    if (dto.activa !== undefined) patch.activa = dto.activa;
    if (dto.valor_numerico !== undefined)
      patch.valor_numerico = dto.valor_numerico;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'Nada que actualizar: manda activa y/o valor_numerico.',
      );
    }
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('clave', clave)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Configuración ${clave} not found`);
    // El toggle se refleja de inmediato en este proceso (la caché se rearma
    // en la siguiente lectura).
    this.cache = null;
    return data;
  }

  // ================= RESPONSABLES DE FACTURACIÓN (24-sep-2026) =================

  /** Ids guardados en `valor_json` (lectura PROPIA: `cachedRow` no lee esa columna). */
  private async leerIdsResponsables(usarCache: boolean): Promise<string[]> {
    const now = Date.now();
    if (
      usarCache &&
      this.cacheResponsables &&
      now - this.cacheResponsables.at <= ConfiguracionService.TTL_MS
    ) {
      return this.cacheResponsables.ids;
    }
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .select('clave, valor_json')
      .eq('clave', CONFIG_RESPONSABLES_FACTURACION)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data as { valor_json?: unknown } | null)?.valor_json;
    // Solo uuids: un valor editado a mano en la BD («Mary», un número…)
    // haría reventar el `in (…)` de la lectura de usuarios con un 500.
    const esUuid = (x: unknown): x is string =>
      typeof x === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
    const ids = Array.isArray(raw) ? [...new Set(raw.filter(esUuid))] : [];
    this.cacheResponsables = { ids, at: now };
    return ids;
  }

  /** Oficina ACTIVA (no piloto externo) de rol ADMIN/COORDINADOR/FACTURACION. */
  private async usuariosOficina(): Promise<UsuarioOficina[]> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre, rol, estado, es_piloto_externo')
      .in('rol', ROLES_OFICINA_FACTURACION)
      .eq('estado', 'ACTIVO')
      .eq('es_piloto_externo', false)
      .order('nombre');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((u) => ({
      id: u.id as string,
      nombre: ((u.nombre as string | null) ?? '').trim() || 'Sin nombre',
      rol: typeof u.rol === 'string' ? u.rol : '',
    }));
  }

  /** Los tres niveles del aviso a partir de la oficina activa y la config. */
  private niveles(
    oficina: UsuarioOficina[],
    idsConfig: string[],
  ): {
    config: UsuarioAviso[];
    facturacion: UsuarioAviso[];
    admins: UsuarioAviso[];
  } {
    const porId = new Map(oficina.map((u) => [u.id, u]));
    const aviso = (u: UsuarioOficina): UsuarioAviso => ({
      id: u.id,
      nombre: u.nombre,
    });
    return {
      config: idsConfig
        .map((id) => porId.get(id))
        .filter((u): u is UsuarioOficina => !!u)
        .map(aviso),
      facturacion: oficina.filter((u) => u.rol === 'FACTURACION').map(aviso),
      admins: oficina.filter((u) => u.rol === 'ADMIN').map(aviso),
    };
  }

  /**
   * ¿A quién le llega el aviso «Factura pedida»? (1) los responsables de la
   * config que sigan ACTIVOS y sean de oficina; si no queda nadie (2) los
   * activos con rol FACTURACION; si no hay (3) los ADMIN activos. El nivel se
   * elige ANTES de excluir a `excluirId` (quien pidió): nadie se avisa a sí
   * mismo y, si era el único del nivel, no se «baja» al siguiente.
   * Best-effort con la config: si no se puede leer, cae al rol (con `warn`).
   */
  async destinatariosFacturacion(
    excluirId?: string | null,
  ): Promise<UsuarioAviso[]> {
    let idsConfig: string[] = [];
    try {
      idsConfig = await this.leerIdsResponsables(true);
    } catch (e) {
      this.logger.warn(
        `No se pudo leer ${CONFIG_RESPONSABLES_FACTURACION}: ${e instanceof Error ? e.message : String(e)}. El aviso va por rol.`,
      );
    }
    const oficina = await this.usuariosOficina();
    return elegirDestinatarios(this.niveles(oficina, idsConfig), excluirId)
      .destinatarios;
  }

  /** `GET /v1/config/responsables-facturacion`. */
  async responsablesFacturacion(): Promise<ResponsablesFacturacion> {
    if (!(await facturaEmitidaDisponible(this.supabase.service))) {
      throw errorFacturasNoDisponibles();
    }
    const ids = await this.leerIdsResponsables(false);
    const [oficina, resueltos] = await Promise.all([
      this.usuariosOficina(),
      ids.length > 0
        ? this.supabase.service
            .from('usuario')
            .select('id, nombre, rol, estado')
            .in('id', ids)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (resueltos.error) throw new Error(resueltos.error.message);
    const porId = new Map(
      ((resueltos.data ?? []) as Array<Record<string, unknown>>).map((u) => [
        u.id as string,
        u,
      ]),
    );
    const { fuente, destinatarios } = elegirDestinatarios(
      this.niveles(oficina, ids),
      null,
    );
    return {
      usuario_ids: ids,
      usuarios: ids
        .map((id) => porId.get(id))
        .filter((u): u is Record<string, unknown> => !!u)
        .map((u) => ({
          id: u.id as string,
          nombre: ((u.nombre as string | null) ?? '').trim() || 'Sin nombre',
          rol: typeof u.rol === 'string' ? u.rol : '',
          activo: u.estado === 'ACTIVO',
        })),
      candidatos: oficina.map((u) => ({
        id: u.id,
        nombre: u.nombre,
        rol: u.rol,
      })),
      efectivos: destinatarios,
      fuente,
    };
  }

  /**
   * `PUT /v1/config/responsables-facturacion` (ADMIN). Solo usuarios ACTIVOS
   * de oficina (ADMIN/COORDINADOR/FACTURACION); cualquier otro id ⇒ 400
   * `USUARIOS_INVALIDOS` con la lista. `[]` = volver al default por rol.
   */
  async setResponsablesFacturacion(
    usuarioIds: string[],
    userId: string,
  ): Promise<ResponsablesFacturacion> {
    if (!(await facturaEmitidaDisponible(this.supabase.service))) {
      throw errorFacturasNoDisponibles();
    }
    const ids = [...new Set(usuarioIds)];
    const oficina = new Set((await this.usuariosOficina()).map((u) => u.id));
    const invalidos = ids.filter((id) => !oficina.has(id));
    if (invalidos.length > 0) {
      throw new BadRequestException({
        message:
          'Solo se pueden elegir usuarios ACTIVOS de oficina (administración, coordinación o facturación).',
        error: 'USUARIOS_INVALIDOS',
        details: { ids: invalidos },
      });
    }
    const ahora = new Date().toISOString();
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .update({ valor_json: ids, updated_at: ahora, updated_by: userId })
      .eq('clave', CONFIG_RESPONSABLES_FACTURACION)
      .select('clave');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      // La migración siembra la fila; si alguien la borró, se recrea.
      const { error: insErr } = await this.supabase.service
        .from('configuracion_sistema')
        .insert({
          clave: CONFIG_RESPONSABLES_FACTURACION,
          activa: true,
          descripcion:
            'Usuarios de oficina que reciben el aviso «Factura pedida» cuando alguien marca «Necesito factura» en un vuelo. Vacío ⇒ usuarios con rol FACTURACION; si no hay ⇒ todos los ADMIN activos.',
          valor_json: ids,
          updated_at: ahora,
          updated_by: userId,
        });
      if (insErr) throw new Error(insErr.message);
    }
    // Se refleja de inmediato en este proceso.
    this.cacheResponsables = null;
    return this.responsablesFacturacion();
  }
}
