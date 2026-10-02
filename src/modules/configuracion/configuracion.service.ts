import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { MARGEN_VENTA_PCT_DEFAULT } from '../inventory/inventario-cardex.util';
import {
  CATALOGO_MODELOS_IA,
  DESCRIPCION_CONFIG_IA_MODELO,
  MENSAJE_MODELO_INVALIDO,
  avisoModeloIa,
  esIdModeloValido,
  headersModeloIa,
  modeloDeValorJson,
  resolverModeloEfectivo,
  valorJsonDeModelo,
  type ModeloIaCatalogo,
} from '../../common/ia-modelo.util';

const COLS = 'clave, activa, valor_numerico, descripcion, updated_at';

/**
 * Tope (ms) de la lectura del modelo de IA: la consulta corre ANTES de cada
 * llamada a pyservices (PDFs, Excel y lecturas con IA) y supabase-js no trae
 * timeout propio. Un PostgREST lento o colgado no puede retrasar esas
 * llamadas más que esto: al vencer se usa el último valor conocido (o el del
 * servidor).
 */
export const TOPE_LECTURA_MODELO_IA_MS = 1_500;

/**
 * Tras una lectura fallida del modelo de IA (error o tope vencido) no se
 * vuelve a consultar durante este lapso (ms): sin él, con la BD caída y el
 * caché frío CADA llamada a pyservices pagaba la espera completa.
 */
export const ESPERA_TRAS_FALLO_MODELO_IA_MS = 10_000;

/**
 * `p` con tope de `ms`: si no se resuelve a tiempo, rechaza con `motivo` y
 * dispara `alVencer` (aborta la petición de fondo). Limpia su timer siempre.
 */
async function conTope<T>(
  p: Promise<T>,
  ms: number,
  motivo: string,
  alVencer?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vencido = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      alVencer?.();
      reject(new Error(motivo));
    }, ms);
  });
  try {
    return await Promise.race([p, vencido]);
  } finally {
    clearTimeout(timer);
  }
}

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
 * MARGEN DE LA TIENDA VuelaTour (25-sep-2026, migración 20260925000001): %
 * que se suma al ÚLTIMO PRECIO DE COMPRA (desde el API 0.0.36; antes el
 * costo FIFO) cuando una SALIDA de bodega a un avión no trae precio de venta
 * (25 = el avión paga ese precio + 25 %; esa diferencia es la
 * utilidad de VuelaTour). 0 = las salidas sin precio van a costo. Rango
 * 0–100 (el PATCH lo valida). Aplica a las salidas NUEVAS. Un solo número:
 * el default vive en `inventario-cardex.util.ts#MARGEN_VENTA_PCT_DEFAULT`.
 */
export const CONFIG_INVENTARIO_MARGEN_VENTA_PCT = 'inventario_margen_venta_pct';
export const INVENTARIO_MARGEN_VENTA_PCT_DEFAULT = MARGEN_VENTA_PCT_DEFAULT;

/**
 * Rango permitido por clave numérica (PATCH `valor_numerico`). Fuera de él
 * ⇒ 400 VALOR_FUERA_DE_RANGO. La BD solo exige ≥ 0.
 */
const RANGOS_NUMERICOS: Record<
  string,
  { min: number; max: number; mensaje: string }
> = {
  [CONFIG_INVENTARIO_MARGEN_VENTA_PCT]: {
    min: 0,
    max: 100,
    mensaje: 'El margen de la tienda va de 0 a 100 %.',
  },
};
/**
 * RESPONSABLES DE FACTURACIÓN (24-sep-2026, migración 20260924000003): lista
 * de usuarios de oficina (`valor_json`, arreglo de uuids) que reciben el
 * aviso «Factura pedida» cuando alguien marca «Necesito factura». Vacía ⇒
 * usuarios con rol FACTURACION; si no hay ⇒ todos los ADMIN activos. Su
 * `activa` NO significa nada: se EXCLUYE del listado general (el panel pinta
 * cada fila como switch) y se edita solo en su propia ruta.
 */
export const CONFIG_RESPONSABLES_FACTURACION = 'responsables_facturacion';
/**
 * EDITORES DE COTIZACIONES COBRADAS (26-sep-2026, migración
 * 20260926000001; pedido de Alejandro y Pablo Canales por WhatsApp con las
 * cotizaciones #305 y #317: «necesito yo poder entrar a las cotizaciones que
 * ya se pagaron y hacer las modificaciones… que se desbloquee para mí, no
 * para todos»). Lista de usuarios (`valor_json`, arreglo de uuids) que SÍ
 * pueden revisar una cotización con cobros registrados (el candado D3
 * `COTIZACION_COBRADA` no les aplica; CFDI, mes cerrado, servicio y grupo sí).
 * Es un permiso por PERSONA, no por rol: en la oficina todos son ADMIN
 * (Alejandro Villalobos también, y NO lo tiene). Reglas de la lista: solo
 * un usuario que YA está en ella puede cambiarla (403
 * `SOLO_EDITORES_COTIZACION_COBRADA`), nunca queda vacía (400
 * `LISTA_VACIA`) y solo admite usuarios ACTIVOS de oficina (400
 * `USUARIOS_INVALIDOS`). Sin la fila (migración sin aplicar) la lista es
 * vacía: nadie tiene el permiso y todo sigue como antes. Igual que
 * `responsables_facturacion`: se EXCLUYE de `GET /v1/config` y `PATCH
 * :clave` la rechaza; se edita en su propia ruta.
 */
export const CONFIG_EDITORES_COTIZACION_COBRADA = 'editores_cotizacion_cobrada';

/**
 * MODELO DE IA (2-oct-2026, API 0.0.51, SIN migración: la fila se crea con
 * upsert en el primer PUT). `valor_json` = `["<id>"]` (la BD solo admite
 * null o ARREGLO en esa columna) o null = «el del servidor» (`ANTHROPIC_MODEL`
 * de pyservices, hoy claude-opus-4-8). Toda llamada a pyservices lleva el
 * header `X-IA-Modelo` SOLO con un modelo configurado. Su `activa` no
 * significa nada: se EXCLUYE de `GET /v1/config` y `PATCH :clave` la
 * rechaza; se edita en `PUT /v1/config/ia-modelo`. Reglas puras en
 * `common/ia-modelo.util.ts`.
 */
export const CONFIG_IA_MODELO = 'ia_modelo';

/**
 * Claves con SECCIÓN PROPIA (`valor_json`): su `activa` no significa nada,
 * así que no salen en el listado general de banderas (el panel pinta cada
 * fila como switch) y `PATCH :clave` las rechaza. Cada una tiene su sección y
 * su ruta.
 */
const CLAVES_SECCION_PROPIA: Record<string, string> = {
  [CONFIG_RESPONSABLES_FACTURACION]:
    'Esta configuración se edita en Responsables de facturación.',
  [CONFIG_EDITORES_COTIZACION_COBRADA]:
    'Esta configuración se edita en «Editan cotizaciones cobradas».',
  [CONFIG_IA_MODELO]:
    'Esta configuración se edita en Créditos de IA → Modelo de IA.',
};

/** Roles de oficina que pueden ser responsables de facturación. */
const ROLES_OFICINA_FACTURACION = ['ADMIN', 'COORDINADOR', 'FACTURACION'];

/**
 * Roles que pueden revisar una cotización (`@Roles` de `POST
 * /quotes/:id/revise` y `:id/ajuste`). El permiso de `/me`
 * (`permisos.editar_cotizacion_cobrada`) exige estar en la lista Y tener uno
 * de estos roles: un usuario de FACTURACION en la lista no podría revisar de
 * todos modos, y el permiso no debe decir lo contrario.
 */
export const ROLES_REVISAN_COTIZACION = ['ADMIN', 'COORDINADOR'] as const;

/** Fila cacheada de una bandera: estado on/off + valor numérico opcional. */
type ConfigRow = { activa: boolean; valor_numerico: number | null };

/** Usuario de oficina (candidato a responsable de facturación). */
interface UsuarioOficina {
  id: string;
  nombre: string;
  rol: string;
}

/** Persona con nombre (nunca un uuid como nombre: «Sin nombre»). */
export interface UsuarioNombre {
  id: string;
  nombre: string;
}

/** `GET|PUT /v1/config/editores-cotizacion-cobrada`. */
export interface EditoresCotizacionCobrada {
  /** Ids guardados en la lista (orden guardado). */
  usuario_ids: string[];
  /** Los ids que resuelven a un usuario, con su nombre. */
  usuarios: UsuarioNombre[];
  /** ¿Quien consulta puede cambiar la lista? (= está en ella). */
  puede_modificar: boolean;
  /**
   * ADITIVO: usuarios ACTIVOS de oficina que se pueden agregar (los mismos
   * que acepta el PUT). El panel pinta un switch por candidato.
   */
  candidatos: Array<UsuarioNombre & { rol: string }>;
}

/** `GET|PUT /v1/config/ia-modelo` (ADMIN). */
export interface ModeloIaConfig {
  /** Id guardado en la configuración; `null` = el del servidor. */
  configurado: string | null;
  /**
   * `ANTHROPIC_MODEL` de pyservices (`GET /ia/modelo`, best-effort): `null`
   * si pyservices es viejo (404), está caído o no está configurado.
   */
  default_servidor: string | null;
  /** El que usarán las próximas lecturas: configurado ?? default_servidor. */
  efectivo: string | null;
  catalogo: ModeloIaCatalogo[];
  /** Último cambio (null = nunca se ha guardado). */
  actualizado_at: string | null;
  actualizado_por_nombre: string | null;
  /** Aviso del configurado fuera del catálogo (verificar id / sin tarifa). */
  aviso: string | null;
}

/** Permisos por PERSONA que viajan en `GET /v1/me` (`permisos`). */
export interface PermisosUsuario {
  /** Puede revisar una cotización con cobros registrados. */
  editar_cotizacion_cobrada: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Caché corto (60 s) de las listas de ids (`valor_json`) por clave. */
  private cacheListas = new Map<string, { ids: string[]; at: number }>();
  /**
   * Caché corto (MISMO TTL de 60 s) del modelo de IA configurado: lo lee
   * cada llamada a pyservices. Se rearma al escribir (`setModeloIa`).
   */
  private cacheModeloIa: { modelo: string | null; at: number } | null = null;
  /** Último fallo al leer el modelo (epoch ms): ver `ESPERA_TRAS_FALLO…`. */
  private falloModeloIaAt: number | null = null;
  /** Lectura del modelo EN CURSO: N llamadas simultáneas comparten una. */
  private lecturaModeloIa: Promise<string | null> | null = null;
  /**
   * Sube con cada escritura del caché del modelo (PUT o GET): una lectura
   * de fondo que empezó ANTES no pisa con un valor viejo lo recién escrito.
   */
  private versionModeloIa = 0;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    // Las claves con SECCIÓN PROPIA (responsables de facturación, editores
    // de cotizaciones cobradas, modelo de IA) no salen aquí: su `activa` no
    // significa nada y el panel pinta cada fila como switch.
    let q = this.supabase.service.from('configuracion_sistema').select(COLS);
    for (const clave of Object.keys(CLAVES_SECCION_PROPIA)) {
      q = q.neq('clave', clave);
    }
    const { data, error } = await q.order('clave');
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
    const seccion = Object.prototype.hasOwnProperty.call(
      CLAVES_SECCION_PROPIA,
      clave,
    )
      ? CLAVES_SECCION_PROPIA[clave]
      : null;
    if (seccion) {
      throw new BadRequestException({
        message: seccion,
        error: 'CLAVE_NO_EDITABLE_AQUI',
        details: { clave },
      });
    }
    const patch: Record<string, unknown> = {};
    if (dto.activa !== undefined) patch.activa = dto.activa;
    if (dto.valor_numerico !== undefined) {
      const rango = RANGOS_NUMERICOS[clave];
      const v = Number(dto.valor_numerico);
      if (rango && (!Number.isFinite(v) || v < rango.min || v > rango.max)) {
        throw new BadRequestException({
          message: rango.mensaje,
          error: 'VALOR_FUERA_DE_RANGO',
          details: { clave, min: rango.min, max: rango.max },
        });
      }
      patch.valor_numerico = dto.valor_numerico;
    }
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

  // ======================= LISTAS DE USUARIOS (valor_json) =======================

  /** Solo uuids, sin repetidos (el orden guardado se conserva). */
  private static idsValidos(raw: unknown): string[] {
    // Un valor editado a mano en la BD («Mary», un número…) haría reventar
    // el `in (…)` de la lectura de usuarios con un 500.
    const esUuid = (x: unknown): x is string =>
      typeof x === 'string' && UUID_RE.test(x);
    return Array.isArray(raw) ? [...new Set(raw.filter(esUuid))] : [];
  }

  /**
   * Ids guardados en `valor_json` de una clave de LISTA (lectura PROPIA:
   * `cachedRow` no lee esa columna). Fila inexistente ⇒ `[]`. Lanza si la
   * consulta falla: cada llamador decide si eso es best-effort o candado.
   */
  private async leerIdsLista(
    clave: string,
    usarCache: boolean,
  ): Promise<string[]> {
    const now = Date.now();
    const c = this.cacheListas.get(clave);
    if (usarCache && c && now - c.at <= ConfiguracionService.TTL_MS) {
      return c.ids;
    }
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .select('clave, valor_json')
      .eq('clave', clave)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const ids = ConfiguracionService.idsValidos(
      (data as { valor_json?: unknown } | null)?.valor_json,
    );
    this.cacheListas.set(clave, { ids, at: now });
    return ids;
  }

  // ================= RESPONSABLES DE FACTURACIÓN (24-sep-2026) =================

  private leerIdsResponsables(usarCache: boolean): Promise<string[]> {
    return this.leerIdsLista(CONFIG_RESPONSABLES_FACTURACION, usarCache);
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
    this.cacheListas.delete(CONFIG_RESPONSABLES_FACTURACION);
    return this.responsablesFacturacion();
  }

  // ============ EDITORES DE COTIZACIONES COBRADAS (26-sep-2026) ============

  /**
   * ¿Este usuario puede revisar una cotización con cobros registrados?
   * Permiso por PERSONA (lista `editores_cotizacion_cobrada`). Falla
   * CERRADO: si la lista no se puede leer, responde `false` (el candado
   * `COTIZACION_COBRADA` sigue en pie) y deja un `warn`. `usarCache: false`
   * en el candado de `revise` (una baja de la lista aplica al instante);
   * `/me` usa el caché de 60 s.
   */
  async puedeEditarCotizacionCobrada(
    userId: string | null | undefined,
    opts: { usarCache?: boolean } = {},
  ): Promise<boolean> {
    if (!userId) return false;
    try {
      const ids = await this.leerIdsLista(
        CONFIG_EDITORES_COTIZACION_COBRADA,
        opts.usarCache ?? true,
      );
      return ids.includes(userId);
    } catch (e) {
      this.logger.warn(
        `No se pudo leer ${CONFIG_EDITORES_COTIZACION_COBRADA}: ${e instanceof Error ? e.message : String(e)}. Sin permiso especial (falla cerrado).`,
      );
      return false;
    }
  }

  /**
   * Permisos por PERSONA de `/me` (ADITIVO). `editar_cotizacion_cobrada`
   * exige estar en la lista Y un rol que pueda revisar cotizaciones
   * (`ROLES_REVISAN_COTIZACION`). Best-effort: nunca tumba `/me`.
   */
  async permisosDe(
    userId: string | null | undefined,
    rol: string | null | undefined,
  ): Promise<PermisosUsuario> {
    const rolRevisa = (ROLES_REVISAN_COTIZACION as readonly string[]).includes(
      rol ?? '',
    );
    return {
      editar_cotizacion_cobrada:
        rolRevisa && (await this.puedeEditarCotizacionCobrada(userId)),
    };
  }

  /**
   * Nombres de quienes PUEDEN editar una cotización cobrada, en el orden de
   * la lista: solo usuarios ACTIVOS de oficina con un rol que revisa
   * cotizaciones (`ROLES_REVISAN_COTIZACION`, el MISMO criterio de
   * `permisosDe`/`/me`) — para el mensaje del 409 «Solo pueden editarla: …».
   * Revisión adversaria 26-sep-2026: con toda la oficina (FACTURACION
   * incluida) el 409 podía mandar a pedírselo a alguien de la lista que NO
   * puede revisar cotizaciones (su `/me` dice `false`). Best-effort: `[]` si
   * no se puede leer — el 409 cae a su mensaje de siempre.
   */
  async editoresCotizacionCobradaNombres(): Promise<UsuarioNombre[]> {
    try {
      const ids = await this.leerIdsLista(
        CONFIG_EDITORES_COTIZACION_COBRADA,
        true,
      );
      if (ids.length === 0) return [];
      const revisa = ROLES_REVISAN_COTIZACION as readonly string[];
      const porId = new Map(
        (await this.usuariosOficina())
          .filter((u) => revisa.includes(u.rol))
          .map((u) => [u.id, u]),
      );
      return ids
        .map((id) => porId.get(id))
        .filter((u): u is UsuarioOficina => !!u)
        .map((u) => ({ id: u.id, nombre: u.nombre }));
    } catch (e) {
      this.logger.warn(
        `No se pudieron resolver los editores de cotizaciones cobradas: ${e instanceof Error ? e.message : String(e)}.`,
      );
      return [];
    }
  }

  /** `GET /v1/config/editores-cotizacion-cobrada` (oficina). */
  async editoresCotizacionCobrada(
    userId: string,
  ): Promise<EditoresCotizacionCobrada> {
    const ids = await this.leerIdsLista(
      CONFIG_EDITORES_COTIZACION_COBRADA,
      false,
    );
    const [oficina, resueltos] = await Promise.all([
      this.usuariosOficina(),
      ids.length > 0
        ? this.supabase.service
            .from('usuario')
            .select('id, nombre')
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
    return {
      usuario_ids: ids,
      usuarios: ids
        .map((id) => porId.get(id))
        .filter((u): u is Record<string, unknown> => !!u)
        .map((u) => ({
          id: u.id as string,
          nombre: ((u.nombre as string | null) ?? '').trim() || 'Sin nombre',
        })),
      puede_modificar: ids.includes(userId),
      candidatos: oficina.map((u) => ({
        id: u.id,
        nombre: u.nombre,
        rol: u.rol,
      })),
    };
  }

  /**
   * `PUT /v1/config/editores-cotizacion-cobrada` ({ usuario_ids }). En este
   * orden: (1) solo un usuario que YA está en la lista puede cambiarla ⇒
   * 403 `SOLO_EDITORES_COTIZACION_COBRADA` (sin la fila sembrada nadie
   * puede: la siembra la migración 20260926000001); (2) nunca vacía ⇒ 400
   * `LISTA_VACIA` (sin nadie en ella nadie podría volver a cambiarla);
   * (3) solo usuarios ACTIVOS de oficina ⇒ 400 `USUARIOS_INVALIDOS` con los
   * ids que no lo son. La escritura es CAS sobre `updated_at` (dos editores
   * a la vez: el segundo recibe 409 `EDITORES_CAMBIARON` y recarga, en vez
   * de pisar al primero con una lista que ya no vio).
   */
  async setEditoresCotizacionCobrada(
    usuarioIds: string[],
    userId: string,
  ): Promise<EditoresCotizacionCobrada> {
    const { data: fila, error: filaErr } = await this.supabase.service
      .from('configuracion_sistema')
      .select('clave, valor_json, updated_at')
      .eq('clave', CONFIG_EDITORES_COTIZACION_COBRADA)
      .maybeSingle();
    if (filaErr) throw new Error(filaErr.message);
    const actuales = ConfiguracionService.idsValidos(
      (fila as { valor_json?: unknown } | null)?.valor_json,
    );
    if (!fila || !actuales.includes(userId)) {
      const editores = await this.editoresCotizacionCobradaNombres();
      throw new ForbiddenException({
        message:
          editores.length > 0
            ? `Solo quien ya puede editar cotizaciones cobradas puede cambiar esta lista (${editores.map((u) => u.nombre).join(', ')}).`
            : 'Solo quien ya puede editar cotizaciones cobradas puede cambiar esta lista.',
        error: 'SOLO_EDITORES_COTIZACION_COBRADA',
        details: { editores },
      });
    }
    const ids = [...new Set(usuarioIds)];
    if (ids.length === 0) {
      throw new BadRequestException({
        message:
          'La lista no puede quedar vacía: al menos una persona debe poder editar cotizaciones cobradas (y cambiar esta lista).',
        error: 'LISTA_VACIA',
      });
    }
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
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .update({
        valor_json: ids,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('clave', CONFIG_EDITORES_COTIZACION_COBRADA)
      .eq('updated_at', (fila as { updated_at: string }).updated_at)
      .select('clave');
    if (error) throw new Error(error.message);
    this.cacheListas.delete(CONFIG_EDITORES_COTIZACION_COBRADA);
    if (!data || data.length === 0) {
      throw new ConflictException({
        message:
          'Alguien más cambió la lista mientras la editabas. Recarga y vuelve a intentar.',
        error: 'EDITORES_CAMBIARON',
      });
    }
    return this.editoresCotizacionCobrada(userId);
  }

  // ===================== MODELO DE IA (2-oct-2026) =====================

  /**
   * Fila `ia_modelo` tal cual (sin caché). `null` = nunca se ha guardado.
   * Con `signal`, la consulta se cancela al abortarlo.
   */
  private async leerFilaModeloIa(signal?: AbortSignal): Promise<{
    valor_json: unknown;
    updated_at: string | null;
    updated_by: string | null;
  } | null> {
    let q = this.supabase.service
      .from('configuracion_sistema')
      .select('clave, valor_json, updated_at, updated_by')
      .eq('clave', CONFIG_IA_MODELO);
    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const fila = data as Record<string, unknown>;
    return {
      valor_json: fila.valor_json,
      updated_at: typeof fila.updated_at === 'string' ? fila.updated_at : null,
      updated_by: typeof fila.updated_by === 'string' ? fila.updated_by : null,
    };
  }

  /**
   * Modelo de IA configurado (`null` = el del servidor). Caché de 60 s (lo
   * consulta cada llamada a pyservices). Best-effort: NUNCA lanza y NUNCA
   * tarda más de `TOPE_LECTURA_MODELO_IA_MS` — si la lectura falla o se
   * cuelga responde el último valor conocido (o `null`, y pyservices usa el
   * suyo): una consulta caída o lenta jamás tumba ni retrasa una lectura de
   * ticket, un PDF o un Excel. Tras un fallo no se reintenta durante
   * `ESPERA_TRAS_FALLO_MODELO_IA_MS`, y las llamadas simultáneas comparten
   * una sola consulta.
   */
  async modeloIa(): Promise<string | null> {
    const now = Date.now();
    const c = this.cacheModeloIa;
    if (c && now - c.at <= ConfiguracionService.TTL_MS) return c.modelo;
    if (
      this.falloModeloIaAt !== null &&
      now - this.falloModeloIaAt < ESPERA_TRAS_FALLO_MODELO_IA_MS
    ) {
      return c?.modelo ?? null;
    }
    if (!this.lecturaModeloIa) {
      this.lecturaModeloIa = this.refrescarModeloIa().finally(() => {
        this.lecturaModeloIa = null;
      });
    }
    return this.lecturaModeloIa;
  }

  /** Lectura con tope de `modeloIa()`. Nunca lanza. */
  private async refrescarModeloIa(): Promise<string | null> {
    const version = this.versionModeloIa;
    const corte = new AbortController();
    try {
      const fila = await conTope(
        this.leerFilaModeloIa(corte.signal),
        TOPE_LECTURA_MODELO_IA_MS,
        `la lectura tardó más de ${TOPE_LECTURA_MODELO_IA_MS} ms`,
        () => corte.abort(),
      );
      const modelo = modeloDeValorJson(fila?.valor_json);
      // Si alguien escribió el caché mientras leíamos (PUT/GET), lo suyo es
      // más nuevo que esta lectura: se respeta.
      if (version !== this.versionModeloIa && this.cacheModeloIa) {
        return this.cacheModeloIa.modelo;
      }
      this.fijarCacheModeloIa(modelo);
      return modelo;
    } catch (e) {
      this.falloModeloIaAt = Date.now();
      this.logger.warn(
        `No se pudo leer ${CONFIG_IA_MODELO}: ${e instanceof Error ? e.message : String(e)}. Se usa el último conocido (o el del servidor).`,
      );
      return this.cacheModeloIa?.modelo ?? null;
    }
  }

  /** Escribe el caché del modelo (y olvida el último fallo). */
  private fijarCacheModeloIa(modelo: string | null): void {
    this.versionModeloIa += 1;
    this.cacheModeloIa = { modelo, at: Date.now() };
    this.falloModeloIaAt = null;
  }

  /**
   * Headers de la llamada a pyservices: `{ 'X-IA-Modelo': id }` SOLO con
   * modelo configurado; `{}` si no (o si la lectura falla). Nunca lanza.
   */
  async headersModeloIa(): Promise<Record<string, string>> {
    return headersModeloIa(await this.modeloIa());
  }

  /**
   * `GET /v1/config/ia-modelo` (sin caché; refresca el de 60 s). El default
   * del servidor lo trae el controller de pyservices (best-effort).
   */
  async modeloIaConfig(
    defaultServidor: string | null,
  ): Promise<ModeloIaConfig> {
    const fila = await this.leerFilaModeloIa();
    const configurado = modeloDeValorJson(fila?.valor_json);
    this.fijarCacheModeloIa(configurado);
    let actualizadoPor: string | null = null;
    if (fila?.updated_by) {
      const { data, error } = await this.supabase.service
        .from('usuario')
        .select('id, nombre')
        .eq('id', fila.updated_by)
        .maybeSingle();
      if (!error && data) {
        const nombre = (data as { nombre?: string | null }).nombre;
        actualizadoPor = (nombre ?? '').trim() || 'Sin nombre';
      }
    }
    return {
      configurado,
      default_servidor: defaultServidor,
      efectivo: resolverModeloEfectivo(configurado, defaultServidor),
      catalogo: CATALOGO_MODELOS_IA.map((m) => ({ ...m })),
      actualizado_at: fila ? fila.updated_at : null,
      actualizado_por_nombre: actualizadoPor,
      aviso: avisoModeloIa(configurado),
    };
  }

  /**
   * `PUT /v1/config/ia-modelo` ({ modelo }, ADMIN). `null` = volver al del
   * servidor. Un id que no cumple la forma ⇒ 400 `MODELO_INVALIDO` (un id
   * FUERA del catálogo con forma válida se acepta: la respuesta trae
   * `aviso`). No hay migración: (1) la fila se CREA si no existe (`upsert`
   * con `ignoreDuplicates` = ON CONFLICT DO NOTHING; `activa` y la
   * descripción fija solo se escriben al nacer) y (2) se actualizan SOLO
   * `valor_json` y quién/cuándo — una descripción editada en la BD no se
   * pisa. El caché de este proceso se rearma al instante; otras réplicas,
   * en ≤ 60 s.
   */
  async setModeloIa(modelo: string | null, userId: string): Promise<void> {
    let id: string | null = null;
    if (modelo !== null) {
      const limpio = typeof modelo === 'string' ? modelo.trim() : '';
      if (!esIdModeloValido(limpio)) {
        throw new BadRequestException({
          message: MENSAJE_MODELO_INVALIDO,
          error: 'MODELO_INVALIDO',
          details: { modelo },
        });
      }
      id = limpio;
    }
    const cambio = {
      valor_json: valorJsonDeModelo(id),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };
    const creada = await this.supabase.service
      .from('configuracion_sistema')
      .upsert(
        {
          clave: CONFIG_IA_MODELO,
          activa: true,
          descripcion: DESCRIPCION_CONFIG_IA_MODELO,
          ...cambio,
        },
        { onConflict: 'clave', ignoreDuplicates: true },
      );
    if (creada.error) throw new Error(creada.error.message);
    const { error } = await this.supabase.service
      .from('configuracion_sistema')
      .update(cambio)
      .eq('clave', CONFIG_IA_MODELO);
    if (error) throw new Error(error.message);
    this.fijarCacheModeloIa(id);
  }
}
