import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  errorFacturasNoDisponibles,
  facturaEmitidaDisponible,
} from '../../common/factura-emitida-disponible.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { esColumnaInexistente } from '../../common/columna-opcional.util';
import { cobroFacturaDisponible } from '../../common/cobro-factura-disponible.util';
import { cobrosEnUsd } from '../../common/cobros-usd.util';
import {
  cobroExigeFactura,
  origenCobroTexto,
  vueloExigeFactura,
  type CobroExigeFacturaRow,
  type ExigenciaFacturaVuelo,
} from '../../common/cuentas-cobro';
import {
  facturasDeVuelos,
  type FacturaDeVuelo,
} from './factura-cliente-etiquetas';
import {
  COLS_FACTURA_LIGADA,
  COLS_SOLICITUD_FACTURA,
  TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR,
  TIPO_AVISO_SOLICITUD_YA_NO_APLICA,
  bloqueFacturaServicio,
  cobrosAntesDelCambio,
  esSolicitudAutomatica,
  folios,
  linkAvisoCambioSolicitud,
  notaSolicitudAutomatica,
  resumenFacturaServicio,
  textoAvisoCambioSolicitud,
  textoAvisoSolicitud,
  transicionSolicitudAutomatica,
  type CambioDeCobro,
  type CobroParaFactura,
  type FacturaLigadaRow,
  type MotivoCambioSolicitud,
  type TransicionSolicitudAutomatica,
  type VueloSolicitudRow,
} from './factura-solicitud.util';
import type {
  FacturaServicioBloque,
  FacturaServicioResumen,
} from '../facturas-emitidas/facturas-emitidas.types';

/** Ids por consulta `.in(...)` (la URL de PostgREST no crece sin tope). */
const LOTE_IDS = 200;

/**
 * Columnas del vuelo que lee la solicitud (aviso incluido). `factura_estatus`
 * (13-oct-2026, invariante 65) alimenta `estadoSolicitud`: un vuelo marcado
 * «Facturado» a mano ya no cuenta como por facturar. La columna existe desde
 * 20260923000001 (aplicada) y el módulo ya exige 20260924000003.
 */
const COLS_VUELO_SOLICITUD = `id, folio, estado, facturado, factura_estatus, cliente_id, fecha_vuelo, monto_total_usd, grupo_id, ${COLS_SOLICITUD_FACTURA}`;

type VueloSolicitud = VueloSolicitudRow & {
  id: string;
  folio: number;
  cliente_id: string | null;
  fecha_vuelo: string | null;
  monto_total_usd: unknown;
  grupo_id: string | null;
};

export interface ResultadoSolicitud {
  factura_servicio: FacturaServicioBloque;
  /** Hubo al menos una solicitud NUEVA (en grupo: cualquiera de los hermanos). */
  nueva: boolean;
  /** Folios con solicitud NUEVA. */
  vuelos: number[];
  /** Nombres a quienes se PERSISTIÓ la notificación. */
  notificados: string[];
}

export interface ActorSolicitud {
  userId: string;
  nombre?: string | null;
}

/**
 * SOLICITUD AUTOMÁTICA por un cobro que exige factura (13-oct-2026,
 * invariante 60): los vuelos (uno, o los hijos con parte > 0 de un sobre),
 * el cobro/sobre que la dispara (`cuenta_destino`/`metodo_cobro`/`monto`) y
 * quién lo registró (queda como solicitante).
 */
export interface SolicitudPorCobro {
  vueloIds: string[];
  cobro: CobroExigeFacturaRow;
  actorId: string;
  cobroId?: string | null;
  cobroGrupoId?: string | null;
}

export interface ResultadoSolicitudPorCobro {
  /** Folios con solicitud NUEVA (los que ENTRARON al CAS). */
  solicitados: number[];
  /** Nombres a quienes se persistió la notificación. */
  notificados: string[];
  /** Por qué no se pidió nada (ausente cuando sí se pidió). */
  motivo?: 'NO_EXIGE' | 'NO_DISPONIBLE' | 'SIN_CANDIDATOS' | 'FALLO';
}

/**
 * AVISO DE TRANSICIÓN de una solicitud AUTOMÁTICA (14-oct-2026, API 0.0.77,
 * invariante 60): el vuelo, quién movió el dinero (queda excluido del aviso),
 * por qué y el cambio exacto (para el contrafactual ANTES).
 */
export interface AvisoCambioSolicitud {
  vueloId: string;
  actorId: string;
  motivo: MotivoCambioSolicitud;
  cambio: CambioDeCobro;
}

export interface ResultadoAvisoCambioSolicitud {
  /** La transición avisada (null = no hubo aviso). */
  transicion: TransicionSolicitudAutomatica | null;
  /** Nombres a quienes se persistió la notificación. */
  notificados: string[];
  /** Por qué no se avisó (ausente cuando sí se avisó). */
  motivo?:
    | 'NO_DISPONIBLE'
    | 'SIN_SOLICITUD_AUTOMATICA'
    | 'NO_APLICA'
    | 'REGISTRADA'
    | 'SIN_TRANSICION'
    | 'FALLO';
}

/** Por qué un vuelo NO recibe la solicitud automática (para la bitácora). */
function motivoSinSolicitud(
  v: VueloSolicitudRow,
  f: FacturaDeVuelo | undefined,
): string {
  if (v.estado === 'CANCELADO') return 'cancelado';
  if (f?.registrada) return `ya tiene factura «${f.registrada}»`;
  if (v.factura_solicitada_at) return 'solicitud viva';
  if (f && f.exigencia !== 'EXIGE') {
    return 'ya no exige factura (el dinero se devolvió o no quedó en una cuenta que la exija)';
  }
  return 'sin factura leída';
}

/**
 * Bloque `factura_servicio` cuando no se pudo leer (respuesta de
 * solicitar/retirar): todas las llaves, con las ADITIVAS del 0.0.77.
 */
function BLOQUE_VACIO(): FacturaServicioBloque {
  return {
    solicitud: null,
    por_facturar: false,
    facturas: [],
    canceladas: 0,
    marcado_sin_registro: false,
    exigencia: null,
    origenes_exigen: [],
    solicitud_ya_no_aplica: false,
    cobros_sin_factura: 0,
    cobros_sin_factura_exigen: 0,
    asignacion_disponible: false,
  };
}

/**
 * La fila del cambio (su `origenCobroTexto` va en el aviso): la nueva o
 * corregida tal como quedó, o la borrada; null si ya no se encuentra.
 */
function filaDelCambio(
  cambio: CambioDeCobro,
  despues: ReadonlyArray<CobroParaFactura>,
): CobroParaFactura | null {
  if (cambio.tipo === 'BAJA') return cambio.fila;
  const actual = despues.find((c) => c.id === cambio.cobroId);
  if (actual) return actual;
  return cambio.tipo === 'CAMBIO' ? cambio.antes : null;
}

function lotes<T>(arr: ReadonlyArray<T>): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += LOTE_IDS) {
    out.push(arr.slice(i, i + LOTE_IDS));
  }
  return out;
}

/**
 * «NECESITO FACTURA» (pedido de Itzi, 24-sep-2026): solicitud de factura por
 * vuelo + los bloques ADITIVOS `factura_servicio` (snapshot) y
 * `factura_servicio_resumen` (listas de vuelos y cotizaciones).
 *
 * Provider de `FlightsModule` (exportado para `QuotesService` y
 * `FacturasEmitidasService`); NO inyecta `FlightsService` (sin ciclos).
 * Sin la migración 20260924000003: bloques `null`/mapa vacío y la
 * solicitud responde 503 `FACTURAS_EMITIDAS_NO_DISPONIBLE`.
 *
 * Desde el 13-oct-2026 (invariante 60) también la SOLICITUD AUTOMÁTICA por
 * un cobro que exige factura (`solicitarPorCobro`): la MISMA vía que
 * «Necesito factura» —mismas 4 columnas, mismo CAS, mismo aviso y link— con
 * origen automático (nota «Solicitada automáticamente: cobro en HSBC
 * Pesos», `data.origen = 'COBRO'`). Nunca lanza, nunca 503: un cobro ya
 * registrado jamás falla por esto.
 */
@Injectable()
export class FacturaSolicitudService {
  private readonly logger = new Logger(FacturaSolicitudService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  /** ¿La migración 20260924000003 ya está aplicada? */
  disponible(): Promise<boolean> {
    return facturaEmitidaDisponible(this.supabase.service);
  }

  /** Facturas emitidas NO borradas ligadas a cada vuelo (lotes de 200). */
  async ligadasDeVuelos(
    ids: string[],
  ): Promise<Map<string, FacturaLigadaRow[]>> {
    const out = new Map<string, FacturaLigadaRow[]>();
    const limpios = [...new Set(ids.filter(Boolean))];
    for (const lote of lotes(limpios)) {
      const { data, error } = await this.supabase.service
        .from('factura_emitida_vuelo')
        .select(
          `vuelo_id, factura:factura_emitida!inner(${COLS_FACTURA_LIGADA})`,
        )
        .in('vuelo_id', lote)
        .is('factura.deleted_at', null);
      if (error) throw new Error(error.message);
      for (const l of (data ?? []) as Array<{
        vuelo_id?: string;
        factura?: FacturaLigadaRow | FacturaLigadaRow[] | null;
      }>) {
        const f = Array.isArray(l.factura) ? l.factura[0] : l.factura;
        if (!l.vuelo_id || !f || f.deleted_at) continue;
        (out.get(l.vuelo_id) ?? out.set(l.vuelo_id, []).get(l.vuelo_id)!).push(
          f,
        );
      }
    }
    return out;
  }

  /** Columnas de solicitud (+ estado/facturado/estatus manual) de varios vuelos (lotes de 200). */
  private async filasSolicitud(
    ids: string[],
  ): Promise<Map<string, VueloSolicitudRow & { id: string }>> {
    const out = new Map<string, VueloSolicitudRow & { id: string }>();
    const limpios = [...new Set(ids.filter(Boolean))];
    for (const lote of lotes(limpios)) {
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select(
          `id, estado, facturado, factura_estatus, ${COLS_SOLICITUD_FACTURA}`,
        )
        .in('id', lote);
      if (error) throw new Error(error.message);
      for (const v of (data ?? []) as unknown as Array<
        VueloSolicitudRow & { id: string }
      >) {
        out.set(v.id, v);
      }
    }
    return out;
  }

  /** Bloque `factura_servicio` de UN vuelo (null sin migración o si falla). */
  async bloqueDeVuelo(vueloId: string): Promise<FacturaServicioBloque | null> {
    const mapa = await this.bloquesDeVuelos([vueloId]);
    return mapa.get(vueloId) ?? null;
  }

  /**
   * Bloques de VARIOS vuelos en LOTE: vuelo (solicitud) + puente + nombres de
   * quien pidió — 3 consultas por cada 200 vuelos, nunca N+1. Sin migración
   * o si la lectura falla ⇒ mapa vacío (degradación explícita con `warn`: la
   * pantalla no se cae por el bloque nuevo; el panel oculta la burbuja).
   * Desde el 0.0.77 (invariante 60) lee además la factura de sus vuelos con
   * el lector único `facturasDeVuelos` (exigencia y orígenes; en paralelo y
   * en un try PROPIO: si falla, el bloque sale igual con `exigencia: null`,
   * `origenes_exigen: []` y `solicitud_ya_no_aplica: false`, con un warn).
   */
  async bloquesDeVuelos(
    ids: string[],
  ): Promise<Map<string, FacturaServicioBloque>> {
    const out = new Map<string, FacturaServicioBloque>();
    const limpios = [...new Set(ids.filter(Boolean))];
    if (limpios.length === 0 || !(await this.disponible())) return out;
    // FACTURAS POR COBRO (16-oct-2026, invariante 84): el MISMO lector trae
    // los cobros del vuelo (`conCobros`) con su `factura_emitida_id` cuando
    // la sonda de 20261016000001 está; de ahí salen `cobros_n` /
    // `cobros_monto` de cada mini y `cobros_sin_factura*` del bloque.
    const facturasP: Promise<Map<string, FacturaDeVuelo> | null> =
      facturasDeVuelos(this.supabase.service, limpios, {
        conCobros: true,
      }).catch((e: unknown) => {
        this.logger.warn(
          `factura_servicio sin exigencia de ${limpios.length} vuelo(s) (el bloque sale igual): ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      });
    try {
      const [filas, ligadas, asignacion] = await Promise.all([
        this.filasSolicitud(limpios),
        this.ligadasDeVuelos(limpios),
        cobroFacturaDisponible(this.supabase.service),
      ]);
      const [nombres, facturas] = await Promise.all([
        fetchNombresUsuarios(
          this.supabase.service,
          [...filas.values()]
            .map((v) => v.factura_solicitada_por)
            .filter((x): x is string => typeof x === 'string'),
        ),
        facturasP,
      ]);
      for (const [id, v] of filas) {
        const quien = v.factura_solicitada_por;
        out.set(
          id,
          bloqueFacturaServicio(
            v,
            ligadas.get(id) ?? [],
            quien ? (nombres.get(quien) ?? null) : null,
            facturas?.get(id) ?? null,
            asignacion && facturas != null,
          ),
        );
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo armar factura_servicio de ${limpios.length} vuelo(s): ${e instanceof Error ? e.message : String(e)}`,
      );
      return new Map();
    }
    return out;
  }

  /**
   * EXIGENCIA de los vuelos con solicitud AUTOMÁTICA viva (14-oct-2026, API
   * 0.0.77, invariante 60): `facturasDeVuelos` SOLO de esas filas (hoy 0 en
   * producción ⇒ cero consultas). Alimenta `estadoSolicitud(v, vigentes,
   * exigencia)` en las listas, el conteo, la bandeja y el selector: una
   * automática cuyo vuelo ya no exige factura es 'YA_NO_APLICA'. Vuelo sin
   * entrada en el mapa ⇒ `null` ⇒ como antes. Si la lectura falla ⇒ warn y
   * mapa vacío (POR_FACTURAR como antes); nunca lanza.
   */
  async exigenciasDeAutomaticas(
    filas: Iterable<VueloSolicitudRow & { id: string }>,
  ): Promise<Map<string, ExigenciaFacturaVuelo>> {
    const out = new Map<string, ExigenciaFacturaVuelo>();
    const ids = [
      ...new Set(
        [...filas].filter((v) => esSolicitudAutomatica(v)).map((v) => v.id),
      ),
    ];
    if (ids.length === 0) return out;
    try {
      for (const [id, f] of await facturasDeVuelos(
        this.supabase.service,
        ids,
      )) {
        out.set(id, f.exigencia);
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo leer la exigencia de ${ids.length} solicitud(es) automática(s) (cuentan como «Por facturar», como antes): ${e instanceof Error ? e.message : String(e)}`,
      );
      return new Map();
    }
    return out;
  }

  /**
   * Resúmenes `factura_servicio_resumen` de una página de lista (vuelos o
   * cotizaciones): 2 consultas por cada 200 vuelos (+ la exigencia de las
   * solicitudes automáticas vivas, `exigenciasDeAutomaticas`). Sin migración
   * o con error ⇒ mapa vacío (el llamador responde `null`).
   */
  async resumenesDeVuelos(
    ids: string[],
  ): Promise<Map<string, FacturaServicioResumen>> {
    const out = new Map<string, FacturaServicioResumen>();
    const limpios = [...new Set(ids.filter(Boolean))];
    if (limpios.length === 0 || !(await this.disponible())) return out;
    try {
      const [filas, ligadas] = await Promise.all([
        this.filasSolicitud(limpios),
        this.ligadasDeVuelos(limpios),
      ]);
      const exigencias = await this.exigenciasDeAutomaticas(filas.values());
      for (const [id, v] of filas) {
        out.set(
          id,
          resumenFacturaServicio(
            v,
            ligadas.get(id) ?? [],
            exigencias.get(id) ?? null,
          ),
        );
      }
    } catch (e) {
      this.logger.warn(
        `No se pudo armar factura_servicio_resumen de ${limpios.length} vuelo(s): ${e instanceof Error ? e.message : String(e)}`,
      );
      return new Map();
    }
    return out;
  }

  private async vueloOFalla(vueloId: string): Promise<VueloSolicitud> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(COLS_VUELO_SOLICITUD)
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: `Vuelo ${vueloId} not found`,
        error: 'VUELO_NO_EXISTE',
        details: { vuelo_id: vueloId },
      });
    }
    return data;
  }

  /**
   * «Necesito factura». IDEMPOTENTE: si NO estaba pedida registra cuándo y
   * quién y AVISA a facturación; si YA estaba, solo actualiza la nota y/o
   * «paga contra factura» que vengan (lo omitido se conserva) y NO re-avisa.
   * `todo_el_grupo` en un hijo de grupo: la MISMA solicitud a todos los
   * hijos NO cancelados, con UNA notificación por destinatario.
   */
  async solicitar(
    vueloId: string,
    dto: {
      nota?: string | null;
      paga_contra_factura?: boolean;
      todo_el_grupo?: boolean;
    },
    actor: ActorSolicitud,
  ): Promise<ResultadoSolicitud> {
    if (!(await this.disponible())) throw errorFacturasNoDisponibles();
    const vuelo = await this.vueloOFalla(vueloId);
    if (vuelo.estado === 'CANCELADO') {
      throw new ConflictException({
        message:
          'El vuelo está cancelado: no se pide factura. Si el cliente necesita factura del cargo por cancelación, facturación la registra directo en Facturas emitidas.',
        error: 'VUELO_CANCELADO',
        details: { vuelo_id: vueloId, folio: vuelo.folio },
      });
    }
    const sb = this.supabase.service;

    // Hermanos del grupo (solo con la bandera y si el vuelo ES hijo).
    let objetivo: VueloSolicitud[] = [vuelo];
    let grupoFolio: number | null = null;
    if (dto.todo_el_grupo === true && vuelo.grupo_id) {
      const [hijosRes, grupoRes] = await Promise.all([
        sb
          .from('vuelo')
          .select(COLS_VUELO_SOLICITUD)
          .eq('grupo_id', vuelo.grupo_id)
          .neq('estado', 'CANCELADO'),
        sb
          .from('vuelo_grupo')
          .select('id, folio')
          .eq('id', vuelo.grupo_id)
          .maybeSingle(),
      ]);
      if (hijosRes.error) throw new Error(hijosRes.error.message);
      const hijos = (hijosRes.data ?? []) as unknown as VueloSolicitud[];
      objetivo = hijos.some((h) => h.id === vuelo.id)
        ? hijos
        : [vuelo, ...hijos];
      const gf = (grupoRes.data as { folio?: unknown } | null)?.folio;
      grupoFolio = gf == null ? null : Number(gf);
    }

    const nota =
      dto.nota === undefined
        ? undefined
        : typeof dto.nota === 'string' && dto.nota.trim() !== ''
          ? dto.nota.trim()
          : null;
    const paga = dto.paga_contra_factura;
    const ahora = new Date().toISOString();
    const nuevosIds = objetivo
      .filter((v) => !v.factura_solicitada_at)
      .map((v) => v.id);
    const existentesIds = objetivo
      .filter((v) => !!v.factura_solicitada_at)
      .map((v) => v.id);

    // Nuevos: UN update con CAS (`is null`) — si otro pidió en paralelo, su
    // fila ya no entra y no se avisa dos veces.
    let nuevos: Array<{ id: string; folio: number }> = [];
    if (nuevosIds.length > 0) {
      const { data, error } = await sb
        .from('vuelo')
        .update({
          factura_solicitada_at: ahora,
          factura_solicitada_por: actor.userId,
          factura_solicitud_nota: nota ?? null,
          factura_paga_contra_factura: paga ?? false,
          updated_by: actor.userId,
        })
        .in('id', nuevosIds)
        .is('factura_solicitada_at', null)
        .select('id, folio');
      if (error) throw new Error(error.message);
      nuevos = ((data ?? []) as Array<{ id: string; folio: unknown }>).map(
        (r) => ({ id: r.id, folio: Number(r.folio) }),
      );
    }
    // Ya pedidos: solo lo que venga (nota / paga), sin tocar fecha ni quién.
    if (
      existentesIds.length > 0 &&
      (nota !== undefined || paga !== undefined)
    ) {
      const patch: Record<string, unknown> = { updated_by: actor.userId };
      if (nota !== undefined) patch.factura_solicitud_nota = nota;
      if (paga !== undefined) patch.factura_paga_contra_factura = paga;
      const { error } = await sb
        .from('vuelo')
        .update(patch)
        .in('id', existentesIds)
        .not('factura_solicitada_at', 'is', null);
      if (error) throw new Error(error.message);
    }

    // Aviso a facturación: UNA notificación por destinatario con todos los
    // folios nuevos. Best-effort: la solicitud ya quedó guardada.
    let notificados: string[] = [];
    if (nuevos.length > 0) {
      notificados = await this.avisarSolicitud(
        objetivo.filter((v) => nuevos.some((n) => n.id === v.id)),
        {
          actor,
          grupoFolio,
          grupoId: vuelo.grupo_id,
          pagaContraFactura: paga === true,
          nota: nota ?? null,
        },
      );
    }

    const bloque = await this.bloqueDeVuelo(vueloId);
    return {
      factura_servicio: bloque ?? BLOQUE_VACIO(),
      nueva: nuevos.length > 0,
      vuelos: nuevos.map((n) => n.folio).sort((a, b) => a - b),
      notificados,
    };
  }

  /**
   * SOLICITUD AUTOMÁTICA por un cobro que EXIGE factura (13-oct-2026,
   * invariante 60): la MISMA vía que «Necesito factura» (mismas 4 columnas,
   * mismo CAS `.is('factura_solicitada_at', null)` con `.select('id,
   * folio')`, mismo aviso a `destinatariosFacturacion(actorId)` que excluye
   * al actor, mismo link `#por-facturar`), con origen automático. JAMÁS
   * lanza: el cobro ya quedó registrado y un fallo aquí no lo revierte ni
   * responde 5xx (un 5xx dispararía el reintento del outbox de la app y
   * duplicaría dinero). IDEMPOTENTE: solo entran los vuelos sin factura
   * registrada (CFDI vivo, emitida VIGENTE, folio o estatus manual), sin
   * solicitud viva y no CANCELADOS; los demás se omiten sin tocar su nota.
   * Sin la migración 20260924000003 es un no-op con log (nunca 503). Deja
   * bitácora en el log de cada decisión.
   */
  async solicitarPorCobro(
    p: SolicitudPorCobro,
  ): Promise<ResultadoSolicitudPorCobro> {
    const vacio = (
      motivo: ResultadoSolicitudPorCobro['motivo'],
    ): ResultadoSolicitudPorCobro => ({
      solicitados: [],
      notificados: [],
      motivo,
    });
    const idCobro = p.cobroGrupoId
      ? `sobre ${p.cobroGrupoId}`
      : (p.cobroId ?? '?');
    try {
      if (!cobroExigeFactura(p.cobro)) return vacio('NO_EXIGE');
      if (!(await this.disponible())) {
        this.logger.log(
          'Solicitud automática de factura omitida: sin la migración 20260924000003 no hay bandeja «Por facturar»',
        );
        return vacio('NO_DISPONIBLE');
      }
      const ids = [...new Set(p.vueloIds.filter(Boolean))];
      if (ids.length === 0) return vacio('SIN_CANDIDATOS');
      const sb = this.supabase.service;
      const origen = origenCobroTexto(p.cobro);
      const [filasRes, facturas] = await Promise.all([
        sb.from('vuelo').select(COLS_VUELO_SOLICITUD).in('id', ids),
        facturasDeVuelos(sb, ids),
      ]);
      if (filasRes.error) throw new Error(filasRes.error.message);
      const filas = (filasRes.data ?? []) as unknown as VueloSolicitud[];
      // Desde el 0.0.77 (invariante 60) el VUELO también debe exigir: corregir
      // la cuenta de un cobro en un vuelo cuyo dinero ya se devolvió no pide
      // factura (un anticipo devuelto no lleva CFDI).
      const candidatos = filas.filter(
        (v) =>
          v.estado !== 'CANCELADO' &&
          !v.factura_solicitada_at &&
          facturas.get(v.id)?.registrada == null &&
          facturas.get(v.id)?.exigencia === 'EXIGE',
      );
      if (candidatos.length === 0) {
        const motivos = filas.map(
          (v) => `#${v.folio}: ${motivoSinSolicitud(v, facturas.get(v.id))}`,
        );
        this.logger.log(
          `Solicitud automática de factura: nada que pedir para vuelo(s) ${folios(filas.map((v) => Number(v.folio)))} (cobro ${idCobro} ${origen}): ${motivos.join('; ') || 'sin vuelos'}`,
        );
        return vacio('SIN_CANDIDATOS');
      }
      // UN update con el MISMO CAS de `solicitar`: los que ENTRARON son los
      // únicos que se avisan (una carrera deja fuera a alguno sin re-aviso).
      const ahora = new Date().toISOString();
      const { data, error } = await sb
        .from('vuelo')
        .update({
          factura_solicitada_at: ahora,
          factura_solicitada_por: p.actorId,
          factura_solicitud_nota: notaSolicitudAutomatica(origen),
          factura_paga_contra_factura: false,
          updated_by: p.actorId,
        })
        .in(
          'id',
          candidatos.map((v) => v.id),
        )
        .is('factura_solicitada_at', null)
        .select('id, folio');
      if (error) throw new Error(error.message);
      const nuevos = (
        (data ?? []) as Array<{ id: string; folio: unknown }>
      ).map((r) => ({ id: r.id, folio: Number(r.folio) }));
      if (nuevos.length === 0) return vacio('SIN_CANDIDATOS');
      const vuelosNuevos = candidatos.filter((v) =>
        nuevos.some((n) => n.id === v.id),
      );
      // Folio del grupo SOLO si los nuevos son hermanos (sobre de grupo).
      let grupoFolio: number | null = null;
      let grupoId: string | null = null;
      const grupos = new Set(vuelosNuevos.map((v) => v.grupo_id ?? null));
      if (vuelosNuevos.length > 1 && grupos.size === 1) {
        const [g] = [...grupos];
        if (g) {
          grupoId = g;
          const { data: grupo } = await sb
            .from('vuelo_grupo')
            .select('id, folio')
            .eq('id', g)
            .maybeSingle();
          const gf = (grupo as { folio?: unknown } | null)?.folio;
          grupoFolio = gf == null ? null : Number(gf);
        }
      }
      const notificados = await this.avisarSolicitud(vuelosNuevos, {
        actor: { userId: p.actorId },
        grupoFolio,
        grupoId,
        pagaContraFactura: false,
        nota: null,
        automatica: {
          origen,
          cobroId: p.cobroId ?? null,
          cobroGrupoId: p.cobroGrupoId ?? null,
        },
      });
      const solicitados = nuevos.map((n) => n.folio).sort((a, b) => a - b);
      this.logger.log(
        `Solicitud automática de factura: vuelo(s) ${folios(solicitados)} por cobro ${idCobro} ${origen} (registró ${p.actorId}); aviso a: ${notificados.join(', ') || 'nadie'}`,
      );
      return { solicitados, notificados };
    } catch (e) {
      this.logger.warn(
        `Solicitud automática de factura falló (el cobro ${idCobro} quedó registrado): ${e instanceof Error ? e.message : String(e)}`,
      );
      return vacio('FALLO');
    }
  }

  /**
   * AVISO DE TRANSICIÓN de una solicitud AUTOMÁTICA (14-oct-2026, API
   * 0.0.77, invariante 60; revisión F14). Se avisa la TRANSICIÓN, no el
   * estado: «ya no aplica» cuando el vuelo pasa de EXIGE a no exigir y
   * «vuelve a aplicar» cuando pasa de no exigir a EXIGE con la automática
   * todavía viva. El ANTES es CONTRAFACTUAL (`cobrosAntesDelCambio` sobre los
   * cobros de DESPUÉS, con la MISMA regla): no se lee antes de escribir. NO
   * re-sella `factura_solicitada_at` ni escribe `vuelo` (el estado se
   * reclasifica al LEER; retirar es destructivo y lo hace la oficina con
   * confirmación). JAMÁS lanza.
   *  (1) Compuerta de UNA consulta a `vuelo` (`COLS_VUELO_SOLICITUD`): sale
   *      sin la migración 20260924000003 (columna inexistente), si la
   *      solicitud no es automática (o no hay), si el vuelo está CANCELADO o
   *      tiene CFDI del PAC o el estatus manual «Facturado».
   *  (2) `facturasDeVuelos(sb, [id], { conCobros: true })` ⇒ DESPUÉS; sale si
   *      ya tiene factura registrada.
   *  (3) ANTES = `vueloExigeFactura` de los cobros contrafactuales con su
   *      `cobrosEnUsd` (T.C. del vuelo de respaldo).
   *  (4) Con transición: aviso a `destinatariosFacturacion(actorId)` (excluye
   *      al actor; no baja de nivel), tipo
   *      'factura_solicitud_ya_no_aplica' / 'factura_solicitud_vuelve_a_aplicar',
   *      link a la tarjeta de la bandeja y `data` {vuelo_id, folio, origen,
   *      motivo, cobro_id}. Sin transición no avisa (nunca repite).
   */
  async avisarCambioSolicitudAutomatica(
    p: AvisoCambioSolicitud,
  ): Promise<ResultadoAvisoCambioSolicitud> {
    const nada = (
      motivo: ResultadoAvisoCambioSolicitud['motivo'],
    ): ResultadoAvisoCambioSolicitud => ({
      transicion: null,
      notificados: [],
      motivo,
    });
    try {
      const sb = this.supabase.service;
      const { data, error } = await sb
        .from('vuelo')
        .select(COLS_VUELO_SOLICITUD)
        .eq('id', p.vueloId)
        .maybeSingle();
      if (error) {
        if (esColumnaInexistente(error)) return nada('NO_DISPONIBLE');
        throw new Error(error.message);
      }
      const v = (data ?? null) as unknown as VueloSolicitud | null;
      if (!v || !esSolicitudAutomatica(v)) {
        return nada('SIN_SOLICITUD_AUTOMATICA');
      }
      if (
        v.estado === 'CANCELADO' ||
        v.facturado === true ||
        v.factura_estatus === 'FACTURADO'
      ) {
        return nada('NO_APLICA');
      }
      const f = (
        await facturasDeVuelos(sb, [p.vueloId], { conCobros: true })
      ).get(p.vueloId);
      if (!f) return nada('FALLO');
      if (f.registrada != null) return nada('REGISTRADA');
      const despues = f.cobros ?? [];
      const filasAntes = cobrosAntesDelCambio(despues, p.cambio);
      const antes = vueloExigeFactura(
        filasAntes,
        cobrosEnUsd(filasAntes, f.tc_vuelo ?? null, f.tc_vuelo ?? null),
      );
      const transicion = transicionSolicitudAutomatica(antes, f.exigencia);
      if (!transicion) return nada('SIN_TRANSICION');
      const fila = filaDelCambio(p.cambio, despues);
      const cobroId =
        p.cambio.tipo === 'BAJA'
          ? (p.cambio.fila.id ?? null)
          : p.cambio.cobroId;
      const notificados = await this.avisarTransicion(v, {
        transicion,
        motivo: p.motivo,
        actorId: p.actorId,
        cobroId,
        origen: fila ? origenCobroTexto(fila) : null,
        eraReembolso: fila != null && Number(fila.monto) < 0,
      });
      this.logger.log(
        `Solicitud automática de factura del vuelo #${v.folio}: ${transicion === 'YA_NO_APLICA' ? 'ya no aplica' : 'vuelve a aplicar'} (${antes} ⇒ ${f.exigencia}, ${p.motivo}, cobro ${cobroId ?? '?'}, movió ${p.actorId}); aviso a: ${notificados.join(', ') || 'nadie'}`,
      );
      return { transicion, notificados };
    } catch (e) {
      this.logger.warn(
        `Aviso de la solicitud automática de factura falló (el dinero del vuelo ${p.vueloId} quedó registrado): ${e instanceof Error ? e.message : String(e)}`,
      );
      return nada('FALLO');
    }
  }

  /** Notificación de la transición (best-effort; nombres notificados). */
  private async avisarTransicion(
    v: VueloSolicitud,
    p: {
      transicion: TransicionSolicitudAutomatica;
      motivo: MotivoCambioSolicitud;
      actorId: string;
      cobroId: string | null;
      origen: string | null;
      eraReembolso: boolean;
    },
  ): Promise<string[]> {
    try {
      const destinatarios = await this.configuracion.destinatariosFacturacion(
        p.actorId,
      );
      if (destinatarios.length === 0) return [];
      let cliente: string | null = null;
      if (v.cliente_id) {
        const { data } = await this.supabase.service
          .from('cliente')
          .select('nombre')
          .eq('id', v.cliente_id)
          .maybeSingle();
        cliente = (data as { nombre?: string | null } | null)?.nombre ?? null;
      }
      const { titulo, cuerpo } = textoAvisoCambioSolicitud({
        transicion: p.transicion,
        motivo: p.motivo,
        vuelo: { folio: Number(v.folio), fecha_vuelo: v.fecha_vuelo },
        cliente,
        origen: p.origen,
        eraReembolso: p.eraReembolso,
      });
      const data: Record<string, unknown> = {
        vuelo_id: v.id,
        folio: Number(v.folio),
        origen: p.transicion,
        motivo: p.motivo,
        cobro_id: p.cobroId,
      };
      const tipo =
        p.transicion === 'YA_NO_APLICA'
          ? TIPO_AVISO_SOLICITUD_YA_NO_APLICA
          : TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR;
      const link = linkAvisoCambioSolicitud(v.id, p.transicion);
      const resultados = await Promise.all(
        destinatarios.map(async (d) => ({
          nombre: d.nombre,
          ok: await this.notifications.notifyUser(d.id, {
            tipo,
            titulo,
            cuerpo,
            link,
            data,
          }),
        })),
      );
      return resultados.filter((r) => r.ok).map((r) => r.nombre);
    } catch (e) {
      this.logger.warn(
        `Aviso de la solicitud automática de factura del vuelo #${v.folio} falló: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  private async avisarSolicitud(
    vuelos: VueloSolicitud[],
    p: {
      actor: ActorSolicitud;
      grupoFolio: number | null;
      grupoId: string | null;
      pagaContraFactura: boolean;
      nota: string | null;
      /** Solicitud automática por un cobro (invariante 60): origen y liga. */
      automatica?: {
        origen: string;
        cobroId: string | null;
        cobroGrupoId: string | null;
      };
    },
  ): Promise<string[]> {
    try {
      const ordenados = [...vuelos].sort((a, b) => a.folio - b.folio);
      const primero = ordenados[0];
      if (!primero) return [];
      const destinatarios = await this.configuracion.destinatariosFacturacion(
        p.actor.userId,
      );
      if (destinatarios.length === 0) return [];
      const clienteId = primero.cliente_id;
      let cliente: string | null = null;
      if (clienteId) {
        const { data } = await this.supabase.service
          .from('cliente')
          .select('nombre')
          .eq('id', clienteId)
          .maybeSingle();
        cliente = (data as { nombre?: string | null } | null)?.nombre ?? null;
      }
      const actorNombre =
        (p.actor.nombre ?? '').trim() ||
        (
          await fetchNombresUsuarios(this.supabase.service, [p.actor.userId])
        ).get(p.actor.userId) ||
        'Alguien de la oficina';
      const { titulo, cuerpo } = textoAvisoSolicitud({
        actor: actorNombre,
        vuelos: ordenados,
        cliente,
        grupoFolio: ordenados.length > 1 ? p.grupoFolio : null,
        pagaContraFactura: p.pagaContraFactura,
        nota: p.nota,
        ...(p.automatica
          ? { automatica: { origen: p.automatica.origen } }
          : {}),
      });
      const data: Record<string, unknown> = {
        vuelo_id: primero.id,
        folio: primero.folio,
        paga_contra_factura: p.pagaContraFactura,
        // Llaves ADITIVAS de la solicitud automática (la app ignora `data`
        // que no conoce).
        ...(p.automatica
          ? {
              origen: 'COBRO',
              cobro_id: p.automatica.cobroId,
              cobro_grupo_id: p.automatica.cobroGrupoId,
            }
          : {}),
      };
      if (ordenados.length > 1) {
        data.vuelo_ids = ordenados.map((v) => v.id);
        data.grupo_id = p.grupoId;
      }
      const link = `/admin/facturas-emitidas?resaltar=${primero.id}#por-facturar`;
      const resultados = await Promise.all(
        destinatarios.map(async (d) => ({
          nombre: d.nombre,
          ok: await this.notifications.notifyUser(d.id, {
            tipo: 'factura_solicitada',
            titulo,
            cuerpo,
            link,
            data,
          }),
        })),
      );
      return resultados.filter((r) => r.ok).map((r) => r.nombre);
    } catch (e) {
      this.logger.warn(
        `Solicitud de factura guardada pero el aviso falló: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /**
   * Retira la solicitud de ESE vuelo (limpia las 4 columnas). Idempotente;
   * permitido aunque ya haya factura ligada (solo borra el rastro de la
   * solicitud). La confirmación la pide la UI.
   */
  async retirar(
    vueloId: string,
    actor: ActorSolicitud,
  ): Promise<{ factura_servicio: FacturaServicioBloque }> {
    if (!(await this.disponible())) throw errorFacturasNoDisponibles();
    await this.vueloOFalla(vueloId);
    const { error } = await this.supabase.service
      .from('vuelo')
      .update({
        factura_solicitada_at: null,
        factura_solicitada_por: null,
        factura_solicitud_nota: null,
        factura_paga_contra_factura: false,
        updated_by: actor.userId,
      })
      .eq('id', vueloId);
    if (error) throw new Error(error.message);
    const bloque = await this.bloqueDeVuelo(vueloId);
    return { factura_servicio: bloque ?? BLOQUE_VACIO() };
  }
}
