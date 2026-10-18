/**
 * CIERRE DE MES FORMAL (16-oct-2026, API 0.0.88, invariante 89, migración
 * `20261016000004_cierre_mes.sql`).
 *
 * Pedido del cliente: «una opción para cerrar el mes que no es el corriente
 * (el anterior) y que los vuelos que aún no se cobren se marquen en el
 * balance y se muevan al siguiente mes hasta que se cobren y completen».
 *
 *  - `estado()`   GET  /v1/cierres                — estado de cada mes.
 *  - `previa()`   GET  /v1/cierres/:periodo/previa — qué pasaría al cerrar.
 *  - `cerrar()`   POST /v1/cierres/:periodo       — cierra y difiere.
 *  - `reabrir()`  POST /v1/cierres/:periodo/reabrir — revierte (solo ADMIN).
 *
 * La DECISIÓN de qué vuelo pasa al mes siguiente NO vive aquí: es
 * `decisionDiferir` (common/mes-contable.util), evaluada por `compute(M)`
 * con su MISMA cadena de T.C. (`cierre.pendientes_que_pasarian`). Este
 * servicio solo ordena las precondiciones, escribe y avisa. El reparto que
 * se congela (`reparto_snapshot` / `socios_snapshot`) es `compute(M, {
 * excluirVuelos })` — el mismo que da `compute(M)` en vivo una vez escritos
 * los diferimientos.
 *
 * Escritura «transaccional a mano» (PostgREST no tiene transacciones):
 * (1) fila `cierre_mes` con CAS (dos cierres a la vez no se pisan); (2) por
 * vuelo, `periodo_contable` con CAS + bitácora `cierre_mes_vuelo`; si algo
 * falla a la mitad, se revierte lo hecho y el mes queda REABIERTO con el
 * motivo «cierre incompleto: …» (jamás un DELETE en caliente) ⇒ 500
 * CIERRE_INCOMPLETO, reintentable.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CLAVES_BLOQUEANTES_PRECIERRE,
  ProfitSharingService,
} from '../profit-sharing/profit-sharing.service';
import { NotificationsService } from '../realtime/notifications.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  cierreMesDisponible,
  errorCierreNoDisponible,
} from '../../common/cierre-mes-disponible.util';
import {
  CIERRE_MES_COLS,
  leerCierresMes,
  olvidarCierres,
  type CierreMesLeido,
  type UsuarioCierre,
} from '../../common/cierre-mes.lector';
import {
  etiquetaMes,
  etiquetaMesMinuscula,
  leyendaPasaA,
  MES_PRIMER_CIERRE,
  mesAnteriorDe,
  mesSiguienteDe,
  motivoNoCerrable,
  periodoContableDe,
  rangoDelMes,
  textoMesAnteriorAbierto,
  textoMesEnCurso,
  textoMesSiguienteCerrado,
  type MotivoDiferir,
  type MotivoNoCerrable,
} from '../../common/mes-contable.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { inicioOficialDe } from '../../common/inicio-oficial.util';
import { mensajePeriodoAntesDelInicio } from '../../common/inicio-oficial.util';
import { clavesClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import { utilidadMesDesdeAviones } from '../profit-sharing/reparto-cuenta.util';
import type {
  CierreRepartoBloque,
  CierreRepartoVuelo,
} from '../profit-sharing/profit-sharing.service';
import {
  validarPeriodoCierre,
  type CerrarMesDto,
  type ReabrirMesDto,
} from './dto/cierres.dto';

/** Roles que CIERRAN un mes. */
export const ROLES_CIERRAN_MES = [Rol.ADMIN, Rol.FACTURACION] as const;
/** Roles que REABREN un mes. */
export const ROLES_REABREN_MES = [Rol.ADMIN] as const;

/** Los 6 renglones del pre-cierre que bloquean (`listo`). */
export { CLAVES_BLOQUEANTES_PRECIERRE };

/** Tope de meses que lista `GET /v1/cierres` (desde el inicio oficial). */
const MAX_MESES_LISTA = 36;

export type EstadoMes = 'ABIERTO' | 'CERRADO' | 'REABIERTO';

export interface MesCierreSalida {
  periodo: string;
  estado: EstadoMes;
  cerrado_at: string | null;
  cerrado_por: UsuarioCierre | null;
  reabierto_at: string | null;
  reabierto_por: UsuarioCierre | null;
  reabierto_motivo: string | null;
  version: number;
  puede_cerrar: boolean;
  motivo_no_cerrable: MotivoNoCerrable | null;
  totales: Record<string, unknown> | null;
}

export interface VueloDiferidoSalida {
  id: string;
  folio: number | null;
  clave_cliente: string | null;
  cliente: string | null;
  aeronave: { id: string; matricula: string | null } | null;
  fecha_vuelo: string | null;
  venta_usd: number;
  cobrado_usd: number;
  por_cobrar_usd: number;
  cobrado_posterior_usd: number;
  /** Día Cancún del último cobro después del corte (ADITIVO 16-oct-2026). */
  fecha_cobro_posterior: string | null;
  motivo: MotivoDiferir | null;
  destino?: string;
  origen?: string;
  leyenda: string;
}

export interface BloqueantePrevia {
  clave: string;
  titulo: string;
  count: number;
  ids?: string[];
}

export interface RepartoAvionPrevia {
  aeronave_id: string;
  matricula: string;
  saldo_usd: number;
  cobrado_usd: number;
  gastos_usd: number;
}

export interface TotalesPrevia {
  vuelos: number;
  completados: number;
  cancelados: number;
  pasan: number;
  pasan_venta_usd: number;
  pasan_cobrado_al_corte_usd: number;
  pasan_por_cobrar_usd: number;
  pasan_cobrado_posterior_usd: number;
  pasan_mxn: number;
  pasan_usd_nativo: number;
  se_quedan_en_cero: number;
}

export interface PreviaCierre {
  periodo: string;
  estado: EstadoMes;
  listo: boolean;
  motivo_no_cerrable: MotivoNoCerrable | null;
  texto_no_cerrable: string | null;
  bloqueantes: BloqueantePrevia[];
  vuelos_que_pasan: VueloDiferidoSalida[];
  vuelos_que_vienen: VueloDiferidoSalida[];
  totales: TotalesPrevia;
  reparto: {
    antes: RepartoAvionPrevia[];
    despues: RepartoAvionPrevia[];
  } | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

type ResultadoCompute = Awaited<ReturnType<ProfitSharingService['compute']>>;

/** Cuerpo de un 409/400 estructurado del cierre. */
function conflicto(
  error: string,
  message: string,
  details?: Record<string, unknown>,
): ConflictException {
  return new ConflictException({
    message,
    error,
    ...(details ? { details } : {}),
  });
}

@Injectable()
export class CierresService {
  private readonly logger = new Logger(CierresService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly profitSharing: ProfitSharingService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly configuracion?: ConfiguracionService,
  ) {}

  /** Reloj inyectable (specs): decide el mes EN CURSO (hora Cancún). */
  ahora: () => Date = () => new Date();

  private get sb() {
    return this.supabase.service;
  }

  private mesEnCurso(): string {
    return hoyCancun(this.ahora()).slice(0, 7);
  }

  private async mesInicio(): Promise<{ mes: string; inicio: string | null }> {
    const inicio = await inicioOficialDe(this.configuracion);
    return { mes: inicio ? inicio.slice(0, 7) : MES_PRIMER_CIERRE, inicio };
  }

  /** 400 PERIODO_INVALIDO si no es 'YYYY-MM' (fuente: el DTO). */
  static validarPeriodo(periodo: string): string {
    return validarPeriodoCierre(periodo);
  }

  private async assertDisponible(): Promise<void> {
    if (!(await cierreMesDisponible(this.sb))) throw errorCierreNoDisponible();
  }

  private assertDesdeInicio(
    periodo: string,
    inicio: string | null,
    mesIni: string,
  ) {
    if (periodo < mesIni) {
      throw new BadRequestException({
        message: inicio
          ? mensajePeriodoAntesDelInicio(inicio)
          : `${etiquetaMes(periodo)} es anterior al primer mes que se cierra en el sistema (${etiquetaMes(mesIni)}).`,
        error: 'PERIODO_ANTES_DEL_INICIO',
        details: { inicio: inicio ?? `${mesIni}-01` },
      });
    }
  }

  // ===================================================================
  // GET /v1/cierres
  // ===================================================================

  async estado(): Promise<{
    disponible: boolean;
    inicio_oficial: string | null;
    mes_en_curso: string;
    meses: MesCierreSalida[];
    siguiente_a_cerrar: string | null;
  }> {
    const { mes: mesIni, inicio } = await this.mesInicio();
    const enCurso = this.mesEnCurso();
    if (!(await cierreMesDisponible(this.sb))) {
      return {
        disponible: false,
        inicio_oficial: inicio,
        mes_en_curso: enCurso,
        meses: [],
        siguiente_a_cerrar: null,
      };
    }
    const filas = await leerCierresMes(this.sb);
    const porMes = new Map(filas.map((f) => [f.periodo, f]));
    const cerrados = new Set(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    const meses: MesCierreSalida[] = [];
    for (
      let m = mesIni;
      m <= enCurso && meses.length < MAX_MESES_LISTA;
      m = mesSiguienteDe(m)
    ) {
      const f = porMes.get(m) ?? null;
      const motivo = motivoNoCerrable({
        mes: m,
        mesEnCurso: enCurso,
        mesInicio: mesIni,
        cerrados,
      });
      meses.push(this.salidaMes(m, f, motivo));
    }
    return {
      disponible: true,
      inicio_oficial: inicio,
      mes_en_curso: enCurso,
      meses,
      siguiente_a_cerrar: meses.find((x) => x.puede_cerrar)?.periodo ?? null,
    };
  }

  private salidaMes(
    mes: string,
    f: CierreMesLeido | null,
    motivo: MotivoNoCerrable | null,
  ): MesCierreSalida {
    return {
      periodo: mes,
      estado: f?.estado ?? 'ABIERTO',
      cerrado_at: f?.cerrado_at ?? null,
      cerrado_por: f?.cerrado_por ?? null,
      reabierto_at: f?.reabierto_at ?? null,
      reabierto_por: f?.reabierto_por ?? null,
      reabierto_motivo: f?.reabierto_motivo ?? null,
      version: f?.version ?? 0,
      puede_cerrar: motivo == null,
      motivo_no_cerrable: motivo,
      totales: f?.totales ?? null,
    };
  }

  // ===================================================================
  // GET /v1/cierres/:periodo/previa
  // ===================================================================

  async previa(periodo: string): Promise<PreviaCierre> {
    CierresService.validarPeriodo(periodo);
    await this.assertDisponible();
    const { mes: mesIni, inicio } = await this.mesInicio();
    this.assertDesdeInicio(periodo, inicio, mesIni);
    const filas = await leerCierresMes(this.sb);
    const p = await this.prepararCierre(periodo, filas, mesIni);
    return p.previa;
  }

  /**
   * Arma la previa (y lo que el cierre escribe): pre-cierre, compute vivo
   * (la decisión), compute simulado sin los diferidos y los totales.
   */
  private async prepararCierre(
    periodo: string,
    filas: CierreMesLeido[],
    mesIni: string,
  ): Promise<{
    previa: PreviaCierre;
    diferidos: CierreRepartoVuelo[];
    despues: ResultadoCompute | null;
    precierre: { listo: boolean; items: BloqueantePrevia[] };
  }> {
    const { desde, hasta } = rangoDelMes(periodo);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    const cerrados = new Set(
      filas.filter((f) => f.estado === 'CERRADO').map((f) => f.periodo),
    );
    const pre = await this.profitSharing.preCierre({ desde, hasta });
    const items = (pre.items as Array<Record<string, unknown>>).map((i) => ({
      clave: String(i.clave),
      titulo: String(i.titulo ?? i.clave),
      count: Number(i.count) || 0,
      ...(Array.isArray(i.ids) ? { ids: i.ids as string[] } : {}),
    }));
    const bloqueantes = items.filter(
      (i) =>
        (CLAVES_BLOQUEANTES_PRECIERRE as readonly string[]).includes(i.clave) &&
        i.count > 0,
    );
    const motivo = motivoNoCerrable({
      mes: periodo,
      mesEnCurso: this.mesEnCurso(),
      mesInicio: mesIni,
      cerrados,
      listo: pre.listo,
    });
    const vivo = await this.profitSharing.compute({ desde, hasta });
    const bloque: CierreRepartoBloque | null =
      'cierre' in vivo && vivo.cierre ? vivo.cierre : null;
    const diferidos =
      fila?.estado === 'CERRADO' ? [] : (bloque?.pendientes_que_pasarian ?? []);
    const vienen = bloque?.diferidos_entran ?? [];
    const despues =
      diferidos.length > 0
        ? await this.profitSharing
            .compute(
              { desde, hasta },
              { excluirVuelos: diferidos.map((d) => d.id) },
            )
            .catch((e: unknown) => {
              this.logger.warn(
                `previa ${periodo}: reparto simulado falló: ${e instanceof Error ? e.message : String(e)}`,
              );
              return null;
            })
        : vivo;
    const [claves, nativos, conteos] = await Promise.all([
      clavesClienteDeVuelos(this.sb, [
        ...diferidos.map((d) => d.id),
        ...vienen.map((d) => d.id),
      ]),
      this.cobrosNativos(diferidos.map((d) => d.id)),
      this.conteosDelMes(desde, hasta),
    ]);
    const salida = (d: CierreRepartoVuelo): VueloDiferidoSalida => ({
      id: d.id,
      folio: d.folio,
      clave_cliente: claves.get(d.id) ?? null,
      cliente: d.cliente,
      aeronave: d.aeronave_id
        ? { id: d.aeronave_id, matricula: d.matricula }
        : null,
      fecha_vuelo: d.fecha_vuelo,
      venta_usd: d.venta_usd,
      cobrado_usd: d.cobrado_usd,
      por_cobrar_usd: d.por_cobrar_usd,
      cobrado_posterior_usd: d.cobrado_posterior_usd ?? 0,
      fecha_cobro_posterior: d.fecha_cobro_posterior ?? null,
      motivo: d.motivo ?? null,
      ...(d.destino ? { destino: d.destino } : {}),
      ...(d.origen ? { origen: d.origen } : {}),
      leyenda: d.destino ? leyendaPasaA(d.destino, d) : d.leyenda,
    });
    const pasan = diferidos.map(salida);
    const sum = (f: (d: CierreRepartoVuelo) => number) =>
      r2(diferidos.reduce((a, d) => a + f(d), 0));
    const totales: TotalesPrevia = {
      vuelos: conteos.completados + conteos.cancelados,
      completados: conteos.completados,
      cancelados: conteos.cancelados,
      pasan: pasan.length,
      pasan_venta_usd: sum((d) => d.venta_usd),
      pasan_cobrado_al_corte_usd: sum((d) => d.cobrado_usd),
      pasan_por_cobrar_usd: sum((d) => d.por_cobrar_usd),
      pasan_cobrado_posterior_usd: sum((d) => d.cobrado_posterior_usd ?? 0),
      pasan_mxn: nativos.mxn,
      pasan_usd_nativo: nativos.usd,
      se_quedan_en_cero: conteos.en_cero,
    };
    const resumenAviones = (r: ResultadoCompute | null): RepartoAvionPrevia[] =>
      (r?.aviones ?? []).map((a) => ({
        aeronave_id: a.aeronave.id,
        matricula: a.aeronave.matricula,
        saldo_usd: r2(a.saldo_disponible_usd),
        cobrado_usd: r2(a.ingresos.cobrado_usd),
        gastos_usd: r2(
          a.gastos.directos_usd +
            a.gastos.indirectos_usd +
            a.gastos.permisos_usd +
            a.gastos.otros_prorrateados_usd,
        ),
      }));
    const previa: PreviaCierre = {
      periodo,
      estado: fila?.estado ?? 'ABIERTO',
      listo: pre.listo,
      motivo_no_cerrable: motivo,
      texto_no_cerrable: motivo ? this.textoMotivo(motivo, periodo) : null,
      bloqueantes,
      vuelos_que_pasan: pasan,
      vuelos_que_vienen: vienen.map(salida),
      totales,
      reparto: despues
        ? { antes: resumenAviones(vivo), despues: resumenAviones(despues) }
        : null,
    };
    return {
      previa,
      diferidos,
      despues,
      precierre: { listo: pre.listo, items },
    };
  }

  private textoMotivo(motivo: MotivoNoCerrable, periodo: string): string {
    switch (motivo) {
      case 'MES_EN_CURSO':
        return textoMesEnCurso(periodo);
      case 'MES_ANTERIOR_ABIERTO':
        return textoMesAnteriorAbierto(periodo, mesAnteriorDe(periodo));
      case 'YA_CERRADO':
        return `${etiquetaMes(periodo)} ya está cerrado.`;
      case 'PRECIERRE_NO_LISTO':
        return `Antes de cerrar ${etiquetaMesMinuscula(periodo)} resuelve los pendientes que bloquean el pre-cierre.`;
      case 'PERIODO_ANTES_DEL_INICIO':
        return `${etiquetaMes(periodo)} es anterior al inicio oficial del sistema.`;
    }
  }

  /** Σ de los cobros REALES de esos vuelos por moneda nativa (`moneda::text`). */
  private async cobrosNativos(
    vueloIds: string[],
  ): Promise<{ mxn: number; usd: number }> {
    if (vueloIds.length === 0) return { mxn: 0, usd: 0 };
    let mxn = 0;
    let usd = 0;
    for (let i = 0; i < vueloIds.length; i += 200) {
      const { data, error } = await this.sb
        .from('cobro_vuelo')
        .select('monto, moneda')
        .in('vuelo_id', vueloIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as Array<{
        monto: unknown;
        moneda: unknown;
      }>) {
        const m = Number(c.monto) || 0;
        if (String(c.moneda) === 'MXN') mxn += m;
        else if (String(c.moneda) === 'USD') usd += m;
      }
    }
    return { mxn: r2(mxn), usd: r2(usd) };
  }

  /** Conteo de los vuelos del DINERO del mes (por `fecha_contable`). */
  private async conteosDelMes(
    desde: string,
    hasta: string,
  ): Promise<{ completados: number; cancelados: number; en_cero: number }> {
    const { data, error } = await this.sb
      .from('vuelo')
      .select('id, estado, monto_total_usd')
      .in('estado', ['COMPLETADO', 'CANCELADO'])
      .gte('fecha_contable', `${desde}T00:00:00-05:00`)
      .lte('fecha_contable', `${hasta}T23:59:59-05:00`);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<{
      estado: string;
      monto_total_usd: unknown;
    }>;
    return {
      completados: filas.filter((v) => v.estado === 'COMPLETADO').length,
      cancelados: filas.filter((v) => v.estado === 'CANCELADO').length,
      en_cero: filas.filter(
        (v) => v.estado === 'COMPLETADO' && !(Number(v.monto_total_usd) > 0),
      ).length,
    };
  }

  // ===================================================================
  // POST /v1/cierres/:periodo
  // ===================================================================

  async cerrar(periodo: string, dto: CerrarMesDto, actor: AuthenticatedUser) {
    CierresService.validarPeriodo(periodo);
    // 1) Sonda.
    await this.assertDisponible();
    // 2) Inicio oficial.
    const { mes: mesIni, inicio } = await this.mesInicio();
    this.assertDesdeInicio(periodo, inicio, mesIni);
    // 3) Mes en curso o futuro.
    if (periodo >= this.mesEnCurso()) {
      throw conflicto('MES_EN_CURSO', textoMesEnCurso(periodo), { periodo });
    }
    const filas = await leerCierresMes(this.sb);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    // 4) Ya cerrado.
    if (fila?.estado === 'CERRADO') {
      throw this.errorYaCerrado(fila);
    }
    // 5) Mes anterior abierto (el primero desde el inicio no tiene).
    const anterior = mesAnteriorDe(periodo);
    if (
      anterior >= mesIni &&
      !filas.some((f) => f.periodo === anterior && f.estado === 'CERRADO')
    ) {
      throw conflicto(
        'MES_ANTERIOR_ABIERTO',
        textoMesAnteriorAbierto(periodo, anterior),
        { periodo_anterior: anterior },
      );
    }
    // 6) Pre-cierre listo; 7) la lista que vio el diálogo.
    const prep = await this.prepararCierre(periodo, filas, mesIni);
    if (!prep.precierre.listo) {
      throw conflicto(
        'PRECIERRE_NO_LISTO',
        `Antes de cerrar ${etiquetaMesMinuscula(periodo)} resuelve los pendientes que bloquean el pre-cierre (${prep.previa.bloqueantes
          .map((b) => `${b.titulo}: ${b.count}`)
          .join('; ')}).`,
        { bloqueantes: prep.previa.bloqueantes },
      );
    }
    if (dto.vuelos_esperados) {
      const esperados = new Set(dto.vuelos_esperados);
      const reales = new Set(prep.diferidos.map((d) => d.id));
      const igual =
        esperados.size === reales.size &&
        [...reales].every((id) => esperados.has(id));
      if (!igual) {
        throw conflicto(
          'PREVIA_CAMBIO',
          'La lista de vuelos que pasan al mes siguiente cambió desde que abriste el diálogo: revísala y vuelve a confirmar.',
          { previa: prep.previa },
        );
      }
    }
    if (!prep.despues) {
      throw new InternalServerErrorException({
        message:
          'No se pudo calcular el reparto del mes sin los vuelos que pasan: vuelve a intentarlo en unos minutos.',
        error: 'CIERRE_REPARTO_FALLIDO',
      });
    }

    // Snapshots.
    const despues = prep.despues;
    const sociosSnapshot = utilidadMesDesdeAviones(
      periodo,
      despues.aviones,
      false,
    );
    const porAvion = despues.aviones.map((a) => ({
      aeronave_id: a.aeronave.id,
      matricula: a.aeronave.matricula,
      saldo_usd: r2(a.saldo_disponible_usd),
    }));
    const totales = {
      vuelos: prep.previa.totales.vuelos,
      vuelos_diferidos: prep.diferidos.length,
      diferidos_venta_usd: prep.previa.totales.pasan_venta_usd,
      diferidos_cobrado_usd: prep.previa.totales.pasan_cobrado_al_corte_usd,
      diferidos_por_cobrar_usd: prep.previa.totales.pasan_por_cobrar_usd,
      saldo_total_usd: r2(porAvion.reduce((s, a) => s + a.saldo_usd, 0)),
      por_avion: porAvion,
    };
    const snapshots = {
      precierre_snapshot: prep.precierre,
      reparto_snapshot: despues,
      socios_snapshot: sociosSnapshot,
      totales,
    };

    // (c) Fila del cierre con CAS.
    const version = await this.escribirFilaCierre(
      periodo,
      fila,
      snapshots,
      actor,
    );

    // (d) Diferimientos (CAS por mes contable) + bitácora; con compensación.
    const destino = mesSiguienteDe(periodo);
    try {
      await this.diferirVuelos(
        periodo,
        destino,
        version,
        prep.diferidos,
        actor,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Cierre de ${periodo} incompleto: ${msg}`);
      await this.marcarIncompleto(periodo, version, msg);
      throw new InternalServerErrorException({
        message: `No se pudo terminar el cierre de ${etiquetaMesMinuscula(periodo)}: ${msg}. No se movió ningún vuelo y el mes quedó abierto; vuelve a intentarlo.`,
        error: 'CIERRE_INCOMPLETO',
        details: { periodo },
      });
    }

    // (e) Memorias y aviso.
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    const releida = (await leerCierresMes(this.sb)).find(
      (f) => f.periodo === periodo,
    );
    const quien = releida?.cerrado_por?.nombre ?? actor.nombre ?? 'la oficina';
    const notificados = await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo: `${etiquetaMes(periodo)} cerrado`,
          cuerpo:
            `Cerró ${quien}. ` +
            (prep.diferidos.length > 0
              ? `${prep.diferidos.length} vuelo(s) pasan a ${etiquetaMesMinuscula(destino)} (por cobrar al cierre: US$${totales.diferidos_por_cobrar_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). `
              : 'Ningún vuelo pasa al mes siguiente. ') +
            `Saldo del reparto: US$${totales.saldo_total_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
          data: {
            periodo,
            version,
            vuelos_diferidos: prep.diferidos.length,
          },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);

    return {
      cierre: {
        periodo,
        estado: 'CERRADO' as const,
        version,
        cerrado_at: releida?.cerrado_at ?? new Date().toISOString(),
        cerrado_por: releida?.cerrado_por ?? {
          id: actor.userId,
          nombre: actor.nombre,
        },
      },
      diferidos: prep.previa.vuelos_que_pasan,
      totales: prep.previa.totales,
      reparto: {
        aviones: porAvion.map((a) => ({
          matricula: a.matricula,
          saldo_usd: a.saldo_usd,
        })),
        total_usd: totales.saldo_total_usd,
      },
      notificados,
    };
  }

  private errorYaCerrado(fila: CierreMesLeido): ConflictException {
    return conflicto(
      'YA_CERRADO',
      `${etiquetaMes(fila.periodo)} ya está cerrado.`,
      { cerrado_at: fila.cerrado_at, cerrado_por: fila.cerrado_por },
    );
  }

  /**
   * Inserta la fila (primer cierre) o la reabre a CERRADO (CAS estado =
   * REABIERTO y la misma `version` leída). 0 filas ⇒ alguien cerró a la vez
   * ⇒ 409 YA_CERRADO. Devuelve la `version` del cierre.
   */
  private async escribirFilaCierre(
    periodo: string,
    fila: CierreMesLeido | null,
    snapshots: Record<string, unknown>,
    actor: AuthenticatedUser,
  ): Promise<number> {
    const ahora = new Date().toISOString();
    if (!fila) {
      const { error } = await this.sb.from('cierre_mes').insert({
        periodo: `${periodo}-01`,
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version: 1,
        ...snapshots,
      });
      if (error) {
        if (error.code === '23505')
          throw await this.yaCerradoTrasCarrera(periodo);
        throw new Error(error.message);
      }
      return 1;
    }
    const version = fila.version + 1;
    const { data, error } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'CERRADO',
        cerrado_at: ahora,
        cerrado_por: actor.userId,
        version,
        ...snapshots,
      })
      .eq('periodo', `${periodo}-01`)
      .eq('estado', 'REABIERTO')
      .eq('version', fila.version)
      .select('periodo');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw await this.yaCerradoTrasCarrera(periodo);
    }
    return version;
  }

  private async yaCerradoTrasCarrera(
    periodo: string,
  ): Promise<ConflictException> {
    olvidarCierres(this.sb);
    const f = (await leerCierresMes(this.sb)).find(
      (x) => x.periodo === periodo,
    );
    if (f?.estado === 'CERRADO') return this.errorYaCerrado(f);
    return conflicto(
      'CIERRE_CONCURRENTE',
      `Alguien más está cerrando o reabriendo ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
      { periodo },
    );
  }

  /**
   * Por cada vuelo de D: `periodo_contable = M+1` con CAS (su mes contable
   * SIGUE siendo M: `periodo_contable` igual al leído) + fila de bitácora.
   * Un fallo revierte lo ya escrito y LANZA.
   */
  private async diferirVuelos(
    periodo: string,
    destino: string,
    version: number,
    diferidos: CierreRepartoVuelo[],
    actor: AuthenticatedUser,
  ): Promise<void> {
    if (diferidos.length === 0) return;
    const ids = diferidos.map((d) => d.id);
    const { data, error } = await this.sb
      .from('vuelo')
      .select('id, folio, periodo_contable, fecha_contable')
      .in('id', ids);
    if (error) throw new Error(error.message);
    const leidos = new Map(
      (
        (data ?? []) as Array<{
          id: string;
          folio: number | null;
          periodo_contable: string | null;
          fecha_contable: string | null;
        }>
      ).map((v) => [v.id, v]),
    );
    const hechos: Array<{ id: string; anterior: string | null }> = [];
    const nuevo = periodoContableDe(destino);
    try {
      for (const d of diferidos) {
        const v = leidos.get(d.id);
        if (!v) throw new Error(`el vuelo #${d.folio ?? '?'} ya no existe`);
        const anterior = v.periodo_contable;
        let q = this.sb
          .from('vuelo')
          .update({ periodo_contable: nuevo, updated_by: actor.userId })
          .eq('id', d.id);
        q =
          anterior == null
            ? q.is('periodo_contable', null)
            : q.eq('periodo_contable', anterior);
        const { data: upd, error: uErr } = await q.select('id');
        if (uErr) throw new Error(uErr.message);
        if (!upd || upd.length === 0) {
          throw new Error(
            `el vuelo #${d.folio ?? '?'} cambió de mes mientras se cerraba`,
          );
        }
        hechos.push({ id: d.id, anterior });
        const { error: bErr } = await this.sb.from('cierre_mes_vuelo').insert({
          periodo: `${periodo}-01`,
          cierre_version: version,
          vuelo_id: d.id,
          periodo_origen: `${periodo}-01`,
          periodo_destino: `${destino}-01`,
          periodo_contable_anterior: anterior,
          folio: d.folio ?? v.folio ?? 0,
          cliente: d.cliente,
          aeronave_id: d.aeronave_id,
          matricula: d.matricula,
          venta_usd: d.venta_usd,
          cobrado_usd: d.cobrado_usd,
          por_cobrar_usd: d.por_cobrar_usd,
          motivo: d.motivo ?? 'SIN_COBRO',
          created_by: actor.userId,
        });
        if (bErr) throw new Error(bErr.message);
      }
    } catch (e) {
      // Compensación: cada vuelo movido regresa a su valor anterior (CAS por
      // el valor que escribimos) y su bitácora queda revertida.
      for (const h of hechos.reverse()) {
        try {
          await this.sb
            .from('vuelo')
            .update({ periodo_contable: h.anterior, updated_by: actor.userId })
            .eq('id', h.id)
            .eq('periodo_contable', nuevo);
          await this.sb
            .from('cierre_mes_vuelo')
            .update({
              revertido_at: new Date().toISOString(),
              revertido_por: actor.userId,
            })
            .eq('periodo', `${periodo}-01`)
            .eq('cierre_version', version)
            .eq('vuelo_id', h.id);
        } catch (e2) {
          this.logger.error(
            `Compensación del cierre de ${periodo}: el vuelo ${h.id} no regresó: ${e2 instanceof Error ? e2.message : String(e2)}`,
          );
        }
      }
      throw e;
    }
  }

  /** Cierre a medias ⇒ el mes queda REABIERTO con el motivo (sin borrar). */
  private async marcarIncompleto(
    periodo: string,
    version: number,
    msg: string,
  ): Promise<void> {
    const motivo = `cierre incompleto: ${msg}`.slice(0, 300);
    const { error } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'REABIERTO',
        reabierto_at: new Date().toISOString(),
        reabierto_motivo: motivo.length >= 5 ? motivo : 'cierre incompleto',
      })
      .eq('periodo', `${periodo}-01`)
      .eq('version', version);
    olvidarCierres(this.sb);
    if (error) {
      this.logger.error(
        `Cierre de ${periodo}: no se pudo marcar como incompleto: ${error.message}`,
      );
    }
  }

  // ===================================================================
  // POST /v1/cierres/:periodo/reabrir
  // ===================================================================

  async reabrir(periodo: string, dto: ReabrirMesDto, actor: AuthenticatedUser) {
    CierresService.validarPeriodo(periodo);
    await this.assertDisponible();
    const filas = await leerCierresMes(this.sb);
    const fila = filas.find((f) => f.periodo === periodo) ?? null;
    if (fila?.estado !== 'CERRADO') {
      throw conflicto(
        'NO_ESTA_CERRADO',
        `${etiquetaMes(periodo)} no está cerrado: no hay nada que reabrir.`,
        { periodo },
      );
    }
    const siguiente = mesSiguienteDe(periodo);
    if (filas.some((f) => f.periodo === siguiente && f.estado === 'CERRADO')) {
      throw conflicto(
        'MES_SIGUIENTE_CERRADO',
        textoMesSiguienteCerrado(siguiente),
        { periodo_siguiente: siguiente },
      );
    }
    const motivo = dto.motivo.trim();
    const ahora = new Date().toISOString();
    const { data: upd, error: uErr } = await this.sb
      .from('cierre_mes')
      .update({
        estado: 'REABIERTO',
        reabierto_at: ahora,
        reabierto_por: actor.userId,
        reabierto_motivo: motivo,
      })
      .eq('periodo', `${periodo}-01`)
      .eq('estado', 'CERRADO')
      .eq('version', fila.version)
      .select('periodo');
    if (uErr) throw new Error(uErr.message);
    if (!upd || upd.length === 0) {
      olvidarCierres(this.sb);
      throw conflicto(
        'CIERRE_CONCURRENTE',
        `Alguien más cambió el cierre de ${etiquetaMesMinuscula(periodo)} en este momento: recarga y vuelve a intentarlo.`,
        { periodo },
      );
    }
    // Revertir los diferimientos de ESTE cierre (versión vigente).
    const { data: bit, error: bErr } = await this.sb
      .from('cierre_mes_vuelo')
      .select('id, vuelo_id, folio, periodo_destino, periodo_contable_anterior')
      .eq('periodo', `${periodo}-01`)
      .eq('cierre_version', fila.version)
      .is('revertido_at', null);
    if (bErr) throw new Error(bErr.message);
    let revertidos = 0;
    const noRevertidos: Array<{
      vuelo_id: string;
      folio: number | null;
      motivo: string;
    }> = [];
    for (const b of (bit ?? []) as Array<{
      id: string;
      vuelo_id: string;
      folio: number | null;
      periodo_destino: string;
      periodo_contable_anterior: string | null;
    }>) {
      const destino = String(b.periodo_destino).slice(0, 7);
      const { data: v, error: vErr } = await this.sb
        .from('vuelo')
        .update({
          periodo_contable: b.periodo_contable_anterior,
          updated_by: actor.userId,
        })
        .eq('id', b.vuelo_id)
        .eq('periodo_contable', periodoContableDe(destino))
        .select('id');
      if (vErr || !v || v.length === 0) {
        noRevertidos.push({
          vuelo_id: b.vuelo_id,
          folio: b.folio,
          motivo: vErr
            ? vErr.message
            : 'el vuelo ya no está en el mes al que pasó (otro cierre lo movió)',
        });
        continue;
      }
      const { error: rErr } = await this.sb
        .from('cierre_mes_vuelo')
        .update({ revertido_at: ahora, revertido_por: actor.userId })
        .eq('id', b.id);
      if (rErr) {
        this.logger.warn(
          `Reabrir ${periodo}: el vuelo ${b.vuelo_id} regresó pero su bitácora no se marcó: ${rErr.message}`,
        );
      }
      revertidos += 1;
    }
    olvidarCierres(this.sb);
    this.profitSharing.olvidarUtilidadesSocios();
    const releida = (await leerCierresMes(this.sb)).find(
      (f) => f.periodo === periodo,
    );
    const quien =
      releida?.reabierto_por?.nombre ?? actor.nombre ?? 'la oficina';
    await this.notifications
      .notifyRole(
        Rol.ADMIN,
        {
          tipo: 'alerta_sistema',
          titulo: `${etiquetaMes(periodo)} REABIERTO`,
          cuerpo: `${etiquetaMes(periodo)} REABIERTO por ${quien}: ${motivo}.${revertidos > 0 ? ` ${revertidos} vuelo(s) regresan a ${etiquetaMesMinuscula(periodo)}.` : ''}`,
          data: { periodo, revertidos },
          link: `/admin/reportes?desde=${rangoDelMes(periodo).desde}&hasta=${rangoDelMes(periodo).hasta}`,
        },
        actor.userId,
      )
      .catch(() => 0);
    return {
      cierre: {
        periodo,
        estado: 'REABIERTO' as const,
        version: fila.version,
        reabierto_at: releida?.reabierto_at ?? ahora,
        reabierto_por: releida?.reabierto_por ?? {
          id: actor.userId,
          nombre: actor.nombre,
        },
        reabierto_motivo: motivo,
      },
      revertidos,
      no_revertidos: noRevertidos,
    };
  }
}

/** Columnas de `cierre_mes` que el servicio lee (re-export para specs). */
export { CIERRE_MES_COLS };
