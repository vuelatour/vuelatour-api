/**
 * SONDA ÚNICA + LECTURAS de la CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026,
 * API 0.0.50, migración `20261002000001`). Sustituye al lector de la v1.
 *
 * Vive APARTE de los servicios a propósito: la usan `RepartoCuentaService`,
 * `RepartoPagoService` y el PRE-CIERRE (que vive dentro de
 * `ProfitSharingService`). Con la sonda en un servicio, el pre-cierre
 * necesitaría inyectarlo y habría un ciclo (los servicios de la cuenta
 * inyectan `ProfitSharingService` para las utilidades). Una instancia por
 * cliente Supabase (registro `WeakMap`, el patrón de `columnaOpcional`).
 *
 * Reglas de la sonda (mecánica de `columnaOpcional`, sobre la columna
 * `reparto_pago.saldo_snapshot_usd`, que crea la MISMA migración que la
 * tabla `reparto_cuenta_socio`):
 *  - Éxito ⇒ `true` memorizado para siempre.
 *  - Columna ausente (42703/PGRST204) o tabla ausente (42P01/PGRST205) ⇒
 *    `false`, re-sondeo cada ≤ 10 min: aplicar la migración la enciende
 *    sola, sin redeploy.
 *  - Cualquier OTRO error ⇒ `true` SIN memorizar: no se oculta un problema
 *    real (la consulta de negocio lo reporta tal cual).
 * Si una lectura de negocio responde «columna/tabla inexistente» de todos
 * modos, la sonda se apaga ahí mismo y la lectura devuelve 'sin_migracion'.
 */
import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COLUMNA_OPCIONAL_REINTENTO_MS,
  esColumnaInexistente,
} from '../../common/columna-opcional.util';
import { SEGUNDOS_URL_MINIATURA } from '../../common/url-firmada.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import {
  COLS_REPARTO_CUENTA,
  COLUMNA_SONDA_CUENTA_SOCIO,
  MIGRACION_REPARTO_CUENTA,
  TABLA_REPARTO_CUENTA_SOCIO,
  type AeronaveFlotaRow,
  type AeronaveSocioRow,
  type CuentaRow,
  type UsuarioSocioRow,
} from './reparto-cuenta.util';
import {
  BUCKET_REPARTO_COMPROBANTES,
  COLS_REPARTO_PAGO,
  TABLA_REPARTO_PAGO,
  type RepartoPagoRow,
} from './reparto-pago.util';

/** Página de PostgREST (max-rows = 1000 corta sin avisar). */
export const CUENTA_PAGINA = 1000;
/** Tope de páginas: más que esto es un error de premisa (lectura fallida). */
export const CUENTA_MAX_PAGINAS = 10;
/** `in (...)` en lotes (la URL de PostgREST revienta con cientos de uuids). */
const LOTE_IDS = 150;

export const SIN_MIGRACION = 'sin_migracion' as const;
export type SinMigracion = typeof SIN_MIGRACION;

export interface FiltrosEntregas {
  socio_id?: string;
  /** `fecha_pago >=` (YYYY-MM-DD). */
  desde?: string;
  /** `fecha_pago <=` (YYYY-MM-DD). */
  hasta?: string;
}

/** Todo lo que se necesita para armar las cuentas (I/O ya hecho). */
export interface UniversoCuentas {
  sociosAeronave: AeronaveSocioRow[];
  cuentas: CuentaRow[];
  /** Entregas VIVAS (del socio pedido, o todas). */
  entregas: RepartoPagoRow[];
  /** Socios + quién entregó / registró (UNA lectura). */
  usuarios: Map<string, UsuarioSocioRow>;
  aeronaves: Map<string, AeronaveFlotaRow>;
}

type ErrorPg = { code?: string | null; message?: string | null } | null;

const esSinMigracion = (e: ErrorPg) =>
  esColumnaInexistente(e) || esTablaInexistente(e);

export class LectorCuentaSocios {
  private readonly logger = new Logger(LectorCuentaSocios.name);
  /** null = sin sondear; true = existe (definitivo); false = no existe. */
  private estado: boolean | null = null;
  private ultimoSondeoMs = 0;
  private sondeoEnCurso: Promise<boolean> | null = null;
  private avisado = false;

  constructor(
    private readonly sb: SupabaseClient,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  /** ¿Está aplicada la migración 20261002000001? (memorizado; re-sondeo ≤ 10 min). */
  async disponible(): Promise<boolean> {
    if (this.estado === true) return true;
    if (
      this.estado === false &&
      this.ahora() - this.ultimoSondeoMs < COLUMNA_OPCIONAL_REINTENTO_MS
    ) {
      return false;
    }
    if (!this.sondeoEnCurso) {
      this.sondeoEnCurso = this.sondear().finally(() => {
        this.sondeoEnCurso = null;
      });
    }
    return this.sondeoEnCurso;
  }

  /** Una consulta de negocio vio la migración ausente: se apaga ya. */
  marcarAusente(): void {
    this.estado = false;
    this.ultimoSondeoMs = this.ahora();
    this.avisar();
  }

  private avisar(): void {
    if (this.avisado) return;
    this.avisado = true;
    this.logger.warn(
      `${TABLA_REPARTO_PAGO}.${COLUMNA_SONDA_CUENTA_SOCIO} no existe todavía: las cuentas de los socios responden disponible:false / 503 hasta aplicar la migración ${MIGRACION_REPARTO_CUENTA}.`,
    );
  }

  private async sondear(): Promise<boolean> {
    this.ultimoSondeoMs = this.ahora();
    try {
      const { error } = await this.sb
        .from(TABLA_REPARTO_PAGO)
        .select(COLUMNA_SONDA_CUENTA_SOCIO)
        .limit(1);
      if (!error) {
        if (this.estado === false) {
          this.logger.log(
            'La migración de la cuenta corriente del socio ya está aplicada: cuentas activadas.',
          );
        }
        this.estado = true;
        return true;
      }
      if (esSinMigracion(error)) {
        this.estado = false;
        this.avisar();
        return false;
      }
      // Otro error (red, permisos…): no se oculta ni se memoriza.
      this.estado = null;
      return true;
    } catch {
      this.estado = null;
      return true;
    }
  }

  /**
   * Entregas VIVAS (`deleted_at is null`), PAGINADAS por id.
   * 'sin_migracion' si la migración no está; cualquier otro error LANZA
   * (jamás una lista recortada presentada como completa).
   */
  async entregasVivas(
    f: FiltrosEntregas = {},
  ): Promise<RepartoPagoRow[] | SinMigracion> {
    const filas: RepartoPagoRow[] = [];
    for (let pagina = 0; ; pagina += 1) {
      if (pagina >= CUENTA_MAX_PAGINAS) {
        throw new Error(
          `más de ${CUENTA_MAX_PAGINAS * CUENTA_PAGINA} entregas a socios en la lectura`,
        );
      }
      const desde = pagina * CUENTA_PAGINA;
      let q = this.sb
        .from(TABLA_REPARTO_PAGO)
        .select(COLS_REPARTO_PAGO)
        .is('deleted_at', null);
      if (f.socio_id) q = q.eq('socio_id', f.socio_id);
      if (f.desde) q = q.gte('fecha_pago', f.desde);
      if (f.hasta) q = q.lte('fecha_pago', f.hasta);
      const { data, error } = await q
        .order('id', { ascending: true })
        .range(desde, desde + CUENTA_PAGINA - 1);
      if (error) {
        if (esSinMigracion(error)) {
          this.marcarAusente();
          return SIN_MIGRACION;
        }
        throw new Error(error.message);
      }
      const chunk = (data ?? []) as unknown as RepartoPagoRow[];
      filas.push(...chunk);
      if (chunk.length < CUENTA_PAGINA) break;
    }
    return filas;
  }

  /** Cuentas configuradas (del socio pedido, o todas). */
  async cuentas(socioId?: string): Promise<CuentaRow[] | SinMigracion> {
    let q = this.sb
      .from(TABLA_REPARTO_CUENTA_SOCIO)
      .select(COLS_REPARTO_CUENTA);
    if (socioId) q = q.eq('socio_id', socioId);
    const { data, error } = await q
      .order('socio_id', { ascending: true })
      .range(0, CUENTA_PAGINA - 1);
    if (error) {
      if (esSinMigracion(error)) {
        this.marcarAusente();
        return SIN_MIGRACION;
      }
      throw new Error(error.message);
    }
    const filas = (data ?? []) as unknown as CuentaRow[];
    // Una fila por socio: 1,000 es imposible en esta flota; si pasara, se
    // falla en vez de devolver una lista recortada.
    if (filas.length >= CUENTA_PAGINA) {
      throw new Error(`más de ${CUENTA_PAGINA - 1} cuentas de socio`);
    }
    return filas;
  }

  /** Filas de `aeronave_socio` (cualquier vigencia). Lanza si falla. */
  async sociosAeronave(socioId?: string): Promise<AeronaveSocioRow[]> {
    let q = this.sb
      .from('aeronave_socio')
      .select(
        'aeronave_id, socio_id, porcentaje, vigente_desde, vigente_hasta',
      );
    if (socioId) q = q.eq('socio_id', socioId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Toda la flota (id, matrícula, activa). Lanza si falla. */
  async aeronaves(): Promise<Map<string, AeronaveFlotaRow>> {
    const { data, error } = await this.sb
      .from('aeronave')
      .select('id, matricula, activa');
    if (error) throw new Error(error.message);
    return new Map(
      ((data ?? []) as unknown as AeronaveFlotaRow[]).map((a) => [a.id, a]),
    );
  }

  /** Usuarios por id, en lotes. Lanza si falla (el socio es la identidad). */
  async usuarios(
    ids: ReadonlyArray<string | null | undefined>,
  ): Promise<Map<string, UsuarioSocioRow>> {
    const unicos = [
      ...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x)),
    ];
    const out = new Map<string, UsuarioSocioRow>();
    for (let i = 0; i < unicos.length; i += LOTE_IDS) {
      const { data, error } = await this.sb
        .from('usuario')
        .select('id, nombre, rol, estado, es_empresa')
        .in('id', unicos.slice(i, i + LOTE_IDS));
      if (error) throw new Error(error.message);
      for (const u of (data ?? []) as unknown as UsuarioSocioRow[]) {
        out.set(u.id, {
          id: u.id,
          nombre: u.nombre ?? null,
          rol: u.rol == null ? null : String(u.rol),
          estado: u.estado == null ? null : String(u.estado),
          es_empresa: u.es_empresa === true,
        });
      }
    }
    return out;
  }

  /**
   * Todo lo que piden las cuentas, en paralelo (la lectura de usuarios
   * después, en UNA consulta por lote). `socioId` acota a un socio.
   */
  async universo(socioId?: string): Promise<UniversoCuentas | SinMigracion> {
    const [sociosAeronave, cuentas, entregas, aeronaves] = await Promise.all([
      this.sociosAeronave(socioId),
      this.cuentas(socioId),
      this.entregasVivas(socioId ? { socio_id: socioId } : {}),
      this.aeronaves(),
    ]);
    if (cuentas === SIN_MIGRACION || entregas === SIN_MIGRACION) {
      return SIN_MIGRACION;
    }
    const usuarios = await this.usuarios([
      ...sociosAeronave.map((r) => r.socio_id),
      ...cuentas.map((c) => c.socio_id),
      ...entregas.flatMap((p) => [
        p.socio_id,
        p.entregado_por,
        p.created_by,
        p.updated_by,
      ]),
    ]);
    return { sociosAeronave, cuentas, entregas, usuarios, aeronaves };
  }

  /** Firma por lote (8 h). Nunca lanza: sin URL el panel pinta su aviso. */
  async firmarComprobantes(
    paths: ReadonlyArray<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unicos = [
      ...new Set(
        paths.filter((p): p is string => typeof p === 'string' && !!p),
      ),
    ];
    if (unicos.length === 0) return out;
    try {
      const { data, error } = await this.sb.storage
        .from(BUCKET_REPARTO_COMPROBANTES)
        .createSignedUrls(unicos, SEGUNDOS_URL_MINIATURA);
      if (error) {
        this.logger.warn(
          `No se pudieron firmar ${unicos.length} comprobante(s) de entregas a socios: ${error.message}`,
        );
        return out;
      }
      for (const it of data ?? []) {
        if (it.path && it.signedUrl) out.set(it.path, it.signedUrl);
      }
    } catch (e) {
      this.logger.warn(
        `Falló la firma de comprobantes de entregas a socios: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return out;
  }
}

const registro = new WeakMap<SupabaseClient, LectorCuentaSocios>();

/** Instancia compartida por cliente (servicios de la cuenta + pre-cierre). */
export function lectorCuentaSocios(sb: SupabaseClient): LectorCuentaSocios {
  let l = registro.get(sb);
  if (!l) {
    l = new LectorCuentaSocios(sb);
    registro.set(sb, l);
  }
  return l;
}

/** Olvida la instancia de ese cliente (specs). */
export function resetLectorCuentaSocios(sb: SupabaseClient): void {
  registro.delete(sb);
}
