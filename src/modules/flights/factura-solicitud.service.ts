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
import {
  COLS_FACTURA_LIGADA,
  COLS_SOLICITUD_FACTURA,
  bloqueFacturaServicio,
  resumenFacturaServicio,
  textoAvisoSolicitud,
  type FacturaLigadaRow,
  type VueloSolicitudRow,
} from './factura-solicitud.util';
import type {
  FacturaServicioBloque,
  FacturaServicioResumen,
} from '../facturas-emitidas/facturas-emitidas.types';

/** Ids por consulta `.in(...)` (la URL de PostgREST no crece sin tope). */
const LOTE_IDS = 200;

/** Columnas del vuelo que lee la solicitud (aviso incluido). */
const COLS_VUELO_SOLICITUD = `id, folio, estado, facturado, cliente_id, fecha_vuelo, monto_total_usd, grupo_id, ${COLS_SOLICITUD_FACTURA}`;

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

  /** Columnas de solicitud (+ estado/facturado) de varios vuelos (lotes de 200). */
  private async filasSolicitud(
    ids: string[],
  ): Promise<Map<string, VueloSolicitudRow & { id: string }>> {
    const out = new Map<string, VueloSolicitudRow & { id: string }>();
    const limpios = [...new Set(ids.filter(Boolean))];
    for (const lote of lotes(limpios)) {
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select(`id, estado, facturado, ${COLS_SOLICITUD_FACTURA}`)
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
   */
  async bloquesDeVuelos(
    ids: string[],
  ): Promise<Map<string, FacturaServicioBloque>> {
    const out = new Map<string, FacturaServicioBloque>();
    const limpios = [...new Set(ids.filter(Boolean))];
    if (limpios.length === 0 || !(await this.disponible())) return out;
    try {
      const [filas, ligadas] = await Promise.all([
        this.filasSolicitud(limpios),
        this.ligadasDeVuelos(limpios),
      ]);
      const nombres = await fetchNombresUsuarios(
        this.supabase.service,
        [...filas.values()]
          .map((v) => v.factura_solicitada_por)
          .filter((x): x is string => typeof x === 'string'),
      );
      for (const [id, v] of filas) {
        const quien = v.factura_solicitada_por;
        out.set(
          id,
          bloqueFacturaServicio(
            v,
            ligadas.get(id) ?? [],
            quien ? (nombres.get(quien) ?? null) : null,
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
   * Resúmenes `factura_servicio_resumen` de una página de lista (vuelos o
   * cotizaciones): 2 consultas por cada 200 vuelos. Sin migración o con
   * error ⇒ mapa vacío (el llamador responde `null`).
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
      for (const [id, v] of filas) {
        out.set(id, resumenFacturaServicio(v, ligadas.get(id) ?? []));
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
      factura_servicio: bloque ?? {
        solicitud: null,
        por_facturar: false,
        facturas: [],
        canceladas: 0,
      },
      nueva: nuevos.length > 0,
      vuelos: nuevos.map((n) => n.folio).sort((a, b) => a - b),
      notificados,
    };
  }

  private async avisarSolicitud(
    vuelos: VueloSolicitud[],
    p: {
      actor: ActorSolicitud;
      grupoFolio: number | null;
      grupoId: string | null;
      pagaContraFactura: boolean;
      nota: string | null;
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
      });
      const data: Record<string, unknown> = {
        vuelo_id: primero.id,
        folio: primero.folio,
        paga_contra_factura: p.pagaContraFactura,
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
    return {
      factura_servicio: bloque ?? {
        solicitud: null,
        por_facturar: false,
        facturas: [],
        canceladas: 0,
      },
    };
  }
}
