import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CajaChicaService } from '../caja-chica/caja-chica.service';
import {
  CONFIG_DIAS_GRACIA_GASTOS_SEMANA,
  ConfiguracionService,
} from '../configuracion/configuracion.service';
import { desgloseGastoLineas } from '../../common/desglose-gasto.util';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';
import {
  graciaSaneada,
  limiteCapturaMin,
  limiteEdicion,
} from '../../common/semana-gastos.util';
import {
  CATEGORIAS_REPARTIBLES,
  fetchRepartos,
  repartirPorcentajeCents,
} from '../../common/gasto-reparto.util';
import { NotificationsService } from '../realtime/notifications.service';
import {
  PyservicesService,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import { VisionService } from '../vision/vision.service';
import { IaUsoService } from '../ia-uso/ia-uso.service';
import { Rol } from '../../common/types/auth.types';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { CategoriaGasto, MedioPago } from './dto/expenses.dto';
import type {
  CreateGastoDto,
  CreateTarifaAerodromoDto,
  GenerarPistasDto,
  ListGastosQuery,
  UpdateGastoDto,
  UpdateTarifaAerodromoDto,
} from './dto/expenses.dto';

const COLS =
  'id, vuelo_id, aeronave_id, escala_id, usuario_captura_id, categoria, monto, propina, moneda, tc_gasto, fecha_gasto, proveedor_id, medio_pago, tarjeta_terminacion, litros, tipo_combustible, lugar, fecha_hora_carga, estatus_comprobante, estatus_facturacion, foto_url, valor_ia_extraido, conciliado, duplicado_sospechado, folio_ticket, origen, factura_recibida_id, notas, requiere_visto_bueno, visto_bueno_por, visto_bueno_at, verificado_por, verificado_at, compra_id, compra_rol, created_at, updated_at';

/**
 * Prefijo del aviso ⚠ "avión del gasto ≠ avión del tramo" que se anexa a
 * `notas` (ver `avisoAvionDistintoAlTramo`). Es la clave para RETIRAR el
 * aviso anterior al recalcularlo (nunca se apilan dos, ni queda uno viejo
 * cuando el tramo cambió o se limpió).
 */
const AVISO_AVION_TRAMO_PREFIX = '⚠ el gasto se asignó a ';

/** Notas sin ninguna línea de aviso avión≠tramo (null si no queda nada). */
function quitarAvisoAvionTramo(
  notas: string | null | undefined,
): string | null {
  if (!notas) return null;
  const limpias = notas
    .split('\n')
    .filter((l) => !l.trim().startsWith(AVISO_AVION_TRAMO_PREFIX))
    .join('\n')
    .replace(/\n+$/, '');
  return limpias.trim() ? limpias : null;
}

// Para el panel admin: nombres legibles de proveedor, avión, persona que
// capturó y folio del vuelo (para linkear al detalle). `compra` = la compra
// de refacciones de la que este gasto es un PAGO (28-ago): el equipo la ve
// como "un solo gasto"; se liga/desliga SOLO desde /v1/compras.
const LIST_COLS = `${COLS}, proveedor:proveedor!proveedor_id(nombre), aeronave:aeronave!aeronave_id(matricula), captura:usuario!usuario_captura_id(nombre), verificador:usuario!gasto_verificado_por_fkey(nombre), vuelo:vuelo!vuelo_id(folio), repartos:gasto_reparto(aeronave_id, monto, aeronave:aeronave_id(matricula)), compra:compra!compra_id(id, folio, referencia, estado, proveedor:proveedor!proveedor_id(nombre))`;

/** Ventana en días para considerar dos gastos como posible duplicado.
 *  Ampliada de 3→7 (con proveedor) y 1→3 (sin proveedor) en ago 2026: el
 *  mismo ticket capturado "días después" por otra persona se escapaba. */
const DUP_DAYS = 7;
const DUP_DAYS_SIN_PROVEEDOR = 3;

/** Normalización del folio del ticket: la MISMA regla que la columna
 *  generada `folio_ticket_norm` de la BD (solo alfanumérico, mayúsculas). */
function normalizarFolio(folio: string | null | undefined): string | null {
  const norm = (folio ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return norm.length > 0 ? norm : null;
}

/** Largo mínimo del folio normalizado para el candado duro (los cortos son
 *  demasiado genéricos para rechazar; solo llevan el flag blando). */
const FOLIO_CANDADO_MIN = 4;

/** Tramo al que se enlaza un gasto, con su avión YA resuelto con herencia
 *  (`escala.aeronave_id ?? vuelo.aeronave_id`) — regla B 28-ago-2026. */
interface TramoGastoRef {
  escala_id: string;
  vuelo_id: string;
  /** Avión que voló el tramo (herencia aplicada); null si el vuelo no tiene. */
  aeronave_id: string | null;
  matricula: string | null;
  /** Etiqueta "CUN→MID" para mensajes. */
  tramo: string;
}

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly pyservices: PyservicesService,
    private readonly vision: VisionService,
    private readonly configuracion: ConfiguracionService,
    private readonly cajaChica: CajaChicaService,
    private readonly iaUso: IaUsoService,
  ) {}

  /** Gastos por avión/categoría en Excel (respeta los filtros del listado). */
  async listXlsx(filters: ListGastosQuery): Promise<Buffer> {
    const { data } = await this.list({ ...filters, limit: 5000, offset: 0 });
    // Etiquetas legibles (el reporte lo lee gente de oficina, no la BD).
    const MEDIO_LABEL: Record<string, string> = {
      EFECTIVO: 'Efectivo',
      TARJETA_CORP: 'Tarjeta corporativa',
      TRANSFERENCIA: 'Transferencia',
      PAYWISE: 'PayWise',
      PERSONAL_PABLO: 'Personal Pablo',
      PERSONAL_ALE: 'Personal Ale',
      BODEGA: 'Bodega',
    };
    // Comprobante = qué entregó el piloto (documento físico); Facturación =
    // seguimiento de oficina (¿ya tenemos factura?). Son cosas distintas.
    const COMP_LABEL: Record<string, string> = {
      FACTURA: 'Factura',
      VALE: 'Vale',
      SIN_COMPROBANTE: 'Sin comprobante',
    };
    const FACT_LABEL: Record<string, string> = {
      PENDIENTE: 'Pendiente',
      SOLICITADA: 'Solicitada',
      FACTURADA: 'Facturada',
    };
    const columnas: TablaColumnaPayload[] = [
      { label: 'Fecha' },
      { label: 'Categoría' },
      { label: 'Avión' },
      { label: 'Proveedor' },
      { label: 'Capturó' },
      { label: 'Medio pago' },
      { label: 'Comprobante' },
      { label: 'Facturación' },
      { label: 'Moneda' },
      { label: 'Monto', tipo: 'money' },
    ];
    const filas = data.map((g) => {
      const x = g;
      const aeronave = x.aeronave as { matricula?: string } | null;
      const proveedor = x.proveedor as { nombre?: string } | null;
      const captura = x.captura as { nombre?: string } | null;
      const medio = (x.medio_pago as string) ?? '';
      const comp = (x.estatus_comprobante as string) ?? '';
      const fact = (x.estatus_facturacion as string) ?? '';
      return [
        (x.fecha_gasto as string) ?? '',
        etiquetaCategoriaGasto(x.categoria as string | null),
        // Gasto repartido entre aviones: no está "pendiente" de nada.
        Array.isArray(x.repartos) && x.repartos.length > 0
          ? `Repartido (${x.repartos.length})`
          : (aeronave?.matricula ?? '(pendiente)'),
        proveedor?.nombre ?? '',
        captura?.nombre ?? '',
        MEDIO_LABEL[medio] ?? medio,
        COMP_LABEL[comp] ?? comp,
        FACT_LABEL[fact] ?? fact,
        (x.moneda as string) ?? '',
        Number(x.monto),
      ];
    });
    // Resumen del periodo por categoría (y moneda: un total MXN+USD mezclado
    // sería una mentira numérica): responde "¿cuánto se gastó en COMIDA este
    // mes?" de un vistazo, arriba del listado.
    const porCategoria = new Map<string, number>();
    for (const g of data) {
      const x = g;
      const monto = Number(x.monto);
      if (!Number.isFinite(monto)) continue;
      const clave = `${etiquetaCategoriaGasto(x.categoria as string | null) || '—'} (${(x.moneda as string) ?? '?'})`;
      porCategoria.set(clave, (porCategoria.get(clave) ?? 0) + monto);
    }
    const resumen: Array<[string, number]> = [...porCategoria.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([clave, total]) => [clave, Math.round(total * 100) / 100]);

    // Reporte de EFECTIVOS por persona (pedido de oficina, ago 2026): cuánto
    // trae cada quien en efectivo y cuánto de eso ya se facturó — por moneda,
    // que un total MXN+USD mezclado sería mentira numérica.
    const porPersona = new Map<string, number>();
    for (const g of data) {
      const x = g;
      if ((x.medio_pago as string) !== 'EFECTIVO') continue;
      const monto = Number(x.monto);
      if (!Number.isFinite(monto)) continue;
      const nombre =
        (x.captura as { nombre?: string } | null)?.nombre ?? 'Sin capturador';
      // Fuente: estatus_facturacion (seguimiento de oficina). El comprobante
      // NO sirve aquí: la app marca FACTURA con cualquier foto.
      const facturado =
        (x.estatus_facturacion as string) === 'FACTURADA'
          ? 'facturado'
          : 'POR FACTURAR';
      const clave = `Efectivo ${facturado} · ${nombre} (${(x.moneda as string) ?? '?'})`;
      porPersona.set(clave, (porPersona.get(clave) ?? 0) + monto);
    }
    for (const [clave, total] of [...porPersona.entries()].sort()) {
      resumen.push([clave, Math.round(total * 100) / 100]);
    }
    const rango =
      filters.desde || filters.hasta
        ? ` · ${filters.desde ?? 'inicio'} a ${filters.hasta ?? 'hoy'}`
        : '';
    return this.pyservices.generateTablaXlsx({
      titulo: 'Gastos por avión / categoría',
      subtitulo: `Generado ${new Date().toISOString().slice(0, 10)}${rango}`,
      resumen_titulo: 'Total del periodo por categoría',
      resumen,
      columnas,
      filas,
    });
  }

  async list(filters: ListGastosQuery) {
    let q = this.supabase.service
      .from('gasto')
      .select(LIST_COLS, { count: 'exact' })
      .order('fecha_gasto', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.vuelo_id) q = q.eq('vuelo_id', filters.vuelo_id);
    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.compra_id) q = q.eq('compra_id', filters.compra_id);
    if (filters.usuario_captura_id)
      q = q.eq('usuario_captura_id', filters.usuario_captura_id);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.estatus_comprobante)
      q = q.eq('estatus_comprobante', filters.estatus_comprobante);
    // NO_FACTURADA = pendiente o solicitada (para "todo lo que falta por
    // facturar" en un solo filtro; lo usa el link del pre-cierre).
    if (filters.estatus_facturacion === 'NO_FACTURADA')
      q = q.neq('estatus_facturacion', 'FACTURADA');
    else if (filters.estatus_facturacion)
      q = q.eq('estatus_facturacion', filters.estatus_facturacion);
    if (filters.medio_pago) q = q.eq('medio_pago', filters.medio_pago);
    if (filters.desde) q = q.gte('fecha_gasto', filters.desde);
    if (filters.hasta) q = q.lte('fecha_gasto', filters.hasta);
    // Fecha de CAPTURA (28-ago): "lo que subieron esta semana" aunque el
    // ticket traiga otra fecha — así el panel muestra lo mismo que la app.
    if (filters.capturado_desde)
      q = q.gte('created_at', `${filters.capturado_desde}T00:00:00-05:00`);
    if (filters.capturado_hasta)
      q = q.lte('created_at', `${filters.capturado_hasta}T23:59:59-05:00`);
    // Pendiente = sin avión asignado (la bandeja debe quedar siempre vacía).
    // FIJO e INDIRECTO se excluyen: por diseño no llevan avión/vuelo — no son
    // "pendientes de resolver" (mismo criterio que el pre-cierre).
    if (filters.pendientes === true) {
      // OTRO sin vuelo tampoco es pendiente (26-ago): sin reparto es gasto
      // de la EMPRESA a propósito — se administra en la pantalla Otros
      // gastos, no en esta bandeja.
      // PERSONAL_DUENO tampoco (26-ago): jamás lleva avión/vuelo — dejarlo
      // aquí sería un pendiente eterno (se administra en Gastos personales).
      // NOMINA (29-ago): como INDIRECTO, sin avión por diseño — fuera de la
      // bandeja. SERVICIOS NO se excluye: como REFACCION, sin avión SÍ es
      // pendiente. Misma cadena literal en sugerirAsignaciones y en
      // alerts.service (pre-cierre) o el conteo no cuadra.
      q = q
        .is('aeronave_id', null)
        .not(
          'categoria',
          'in',
          '(FIJO,INDIRECTO,NOMINA,PERSONAL_DUENO,GASOLINA,VISITA)',
        )
        .or('categoria.neq.OTRO,vuelo_id.not.is.null');
    }
    if (filters.duplicados === true) q = q.eq('duplicado_sospechado', true);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    await this.anexarPagosDeCompra(rows);
    return {
      data: rows,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * `compra.n_pagos` = cuántos gastos componen la compra de la que este
   * gasto es un pago (el panel lo usa para mostrar "1 de N" y para avisar
   * antes de desligar el último). Conteo REAL en una sola consulta sobre
   * las compras de la página; los gastos sin compra no cambian.
   */
  private async anexarPagosDeCompra(
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        rows
          .map((r) => r.compra_id)
          .filter((v): v is string => typeof v === 'string'),
      ),
    );
    if (ids.length === 0) return;
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('compra_id')
      .in('compra_id', ids);
    if (error) throw new Error(error.message);
    const conteo = new Map<string, number>();
    for (const g of (data ?? []) as Array<{ compra_id: string | null }>) {
      if (!g.compra_id) continue;
      conteo.set(g.compra_id, (conteo.get(g.compra_id) ?? 0) + 1);
    }
    for (const r of rows) {
      const compraId = r.compra_id;
      if (typeof compraId !== 'string') continue;
      const compra = (r.compra as Record<string, unknown> | null) ?? null;
      r.compra = {
        ...(compra ?? { id: compraId }),
        n_pagos: conteo.get(compraId) ?? 0,
      };
    }
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  /**
   * Sugerencia de asignación para un gasto de la bandeja: ¿a qué vuelo/avión
   * pertenece? Candidatos DETERMINISTAS = vuelos donde el capturista voló o
   * fue de apoyo (piloto/copiloto/apoyo/por tramo) con fecha a ±3 días del
   * gasto. Si hay
   * exactamente UNO el mismo día → match por regla. Si hay varios → Claude
   * elige usando notas/lugar vs la ruta. Sin candidatos o sin IA → sin match
   * (la asignación queda manual: la IA propone, el humano confirma).
   */
  async sugerirAsignacion(gastoId: string) {
    const gasto = await this.findById(gastoId);
    const fecha = gasto.fecha_gasto as string | null;
    const capturo = gasto.usuario_captura_id as string | null;
    const sinMatch = (razon: string) => ({
      sugerido: null,
      confianza: 0,
      razon,
      fuente: 'regla' as const,
      candidatos: [] as Array<Record<string, unknown>>,
    });
    if (!fecha || !capturo) {
      return sinMatch(
        'El gasto no tiene fecha o capturista para buscar vuelos.',
      );
    }

    // Vuelos propios en ±3 días de la fecha del gasto. Los CANCELADOS
    // también (regla del cliente 28-ago-2026): el piloto que voló a recoger,
    // le cancelaron y regresó ferry SÍ gastó en ese vuelo — su gasto se liga
    // ahí y cuenta en el balance/reparto. Solo quedan fuera los externos.
    const base = new Date(`${fecha}T12:00:00-05:00`);
    const lo = new Date(base.getTime() - 3 * 86400_000).toISOString();
    const hi = new Date(base.getTime() + 3 * 86400_000).toISOString();
    const { data: vuelos, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, fecha_vuelo, piloto_id, copiloto_id, apoyo_id, estado, aeronave_id, aeronave:aeronave_id(matricula), escalas:escala(orden, origen_iata, destino_iata, piloto_id, copiloto_id), apoyos:vuelo_apoyo(usuario_id)',
      )
      .eq('es_externo', false)
      .gte('fecha_vuelo', lo)
      .lte('fecha_vuelo', hi);
    if (error) throw new Error(error.message);

    const participo = (v: Record<string, unknown>): boolean => {
      // El APOYO va en el vuelo (maletas, facturas, cobros, gastos): sus
      // gastos se sugieren igual que los del piloto/copiloto.
      if (
        v.piloto_id === capturo ||
        v.copiloto_id === capturo ||
        v.apoyo_id === capturo
      )
        return true;
      // 29-ago: apoyos 0..N (vuelo o tramo) y copiloto por tramo.
      const apoyos =
        (v.apoyos as Array<{ usuario_id?: string | null }> | null) ?? [];
      if (apoyos.some((a) => a.usuario_id === capturo)) return true;
      const escalas =
        (v.escalas as Array<Record<string, unknown>> | null) ?? [];
      return escalas.some(
        (e) => e.piloto_id === capturo || e.copiloto_id === capturo,
      );
    };
    const rutaDe = (v: Record<string, unknown>): string | null => {
      const escalas = [
        ...((v.escalas as Array<Record<string, unknown>> | null) ?? []),
      ].sort((a, b) => Number(a.orden) - Number(b.orden));
      if (escalas.length === 0) return null;
      return [
        escalas[0].origen_iata as string,
        ...escalas.map((e) => e.destino_iata as string),
      ].join(' → ');
    };
    const matriculaDe = (v: Record<string, unknown>): string | null => {
      const a = v.aeronave as
        | { matricula?: string }
        | { matricula?: string }[]
        | null;
      if (Array.isArray(a)) return a[0]?.matricula ?? null;
      return a?.matricula ?? null;
    };

    const candidatos = ((vuelos ?? []) as Array<Record<string, unknown>>)
      .filter(participo)
      .map((v) => ({
        vuelo_id: v.id as string,
        folio: (v.folio as number | null) ?? null,
        fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
        aeronave_id: (v.aeronave_id as string | null) ?? null,
        matricula: matriculaDe(v),
        ruta: rutaDe(v),
        estado: (v.estado as string | null) ?? null,
      }));

    if (candidatos.length === 0) {
      return sinMatch(
        'El piloto no tiene vuelos en ±3 días de la fecha del gasto: asignar a mano.',
      );
    }

    // Regla fuerte: exactamente UN vuelo del capturista el MISMO día (Cancún).
    const diaCancun = (iso: string | null) =>
      iso
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Cancun',
          }).format(new Date(iso))
        : null;
    const mismoDia = candidatos.filter(
      (c) => diaCancun(c.fecha_vuelo) === fecha,
    );
    // Un CANCELADO del mismo día (p. ej. el original de un cambio de avión,
    // que conserva fecha y piloto) NO compite con el vuelo vivo: gana el
    // vivo; el cancelado solo se sugiere cuando es el único del día (sus
    // gastos sí cuentan en el balance) y sigue en `candidatos` para elegirlo
    // a mano.
    const vivosDia = mismoDia.filter((c) => c.estado !== 'CANCELADO');
    if (vivosDia.length === 1) {
      return {
        sugerido: vivosDia[0],
        confianza: 0.95,
        razon: 'Único vuelo (no cancelado) del piloto ese día.',
        fuente: 'regla' as const,
        candidatos,
      };
    }
    if (vivosDia.length === 0 && mismoDia.length === 1) {
      return {
        sugerido: mismoDia[0],
        confianza: 0.8,
        razon:
          'Único vuelo del piloto ese día (CANCELADO: el gasto cuenta igual en su balance).',
        fuente: 'regla' as const,
        candidatos,
      };
    }

    // Ambiguo: Claude elige entre los candidatos (best-effort).
    const { data: piloto } = await this.supabase.service
      .from('usuario')
      .select('nombre')
      .eq('id', capturo)
      .maybeSingle();
    const ia = await this.pyservices.sugerirGastoVuelo({
      gasto: {
        fecha,
        monto: gasto.monto == null ? null : Number(gasto.monto),
        moneda: (gasto.moneda as string | null) ?? null,
        categoria: (gasto.categoria as string | null) ?? null,
        notas: (gasto.notas as string | null) ?? null,
        lugar: (gasto.lugar as string | null) ?? null,
        piloto_nombre: (piloto?.nombre as string | null) ?? null,
      },
      candidatos: candidatos.map((c) => ({
        vuelo_id: c.vuelo_id,
        folio: c.folio,
        fecha_vuelo: c.fecha_vuelo,
        matricula: c.matricula,
        ruta: c.ruta,
        estado: c.estado,
      })),
    });
    // Consumo IA: el barrido sugerirAsignaciones hereda este registro.
    if (ia) {
      this.iaUso.registrar('GASTO_VUELO_SUGERIR', ia.uso_ia, {
        contexto: { gasto_id: gastoId },
      });
    }
    if (!ia) {
      return {
        sugerido: null,
        confianza: 0,
        razon:
          'Hay varios vuelos posibles y el asistente IA no está disponible: elige entre los candidatos.',
        fuente: 'regla' as const,
        candidatos,
      };
    }
    const pick =
      candidatos.find((c) => c.vuelo_id === ia.vuelo_id_sugerido) ?? null;
    return {
      sugerido: pick,
      confianza: pick ? ia.confianza : 0,
      razon:
        ia.razon ||
        (pick ? 'Match propuesto por IA.' : 'Sin coincidencias claras.'),
      fuente: 'ia' as const,
      candidatos,
    };
  }

  /**
   * Barrido de la BANDEJA completa: corre sugerirAsignacion para cada gasto
   * sin avión (máx 15, en tandas de 5 para no saturar la IA) y devuelve la
   * lista gasto→sugerencia. La oficina revisa y aplica en lote — nunca se
   * asigna solo (la IA propone, el humano confirma).
   */
  async sugerirAsignaciones() {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, monto, moneda, categoria, notas, captura:usuario!usuario_captura_id(nombre)',
      )
      .is('aeronave_id', null)
      // Mismo universo que la bandeja: PERSONAL_DUENO jamás tendrá vuelo —
      // sugerirle uno quemaría llamadas de IA en un imposible.
      .not(
        'categoria',
        'in',
        '(FIJO,INDIRECTO,NOMINA,PERSONAL_DUENO,GASOLINA,VISITA)',
      )
      .or('categoria.neq.OTRO,vuelo_id.not.is.null')
      .order('fecha_gasto', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    // Mismo universo que la bandeja (simetría); los repartidos manualmente
    // (gasto_reparto) tampoco reciben sugerencia de vuelo.
    const repartosSug = await fetchRepartos(
      this.supabase.service,
      ((data ?? []) as Array<{ id: string }>).map((g) => g.id),
    );
    const pendientes = ((data ?? []) as Array<Record<string, unknown>>).filter(
      (g) => !repartosSug.has(g.id as string),
    );

    const resumen = (g: Record<string, unknown>) => {
      const cap = g.captura as
        | { nombre?: string }
        | { nombre?: string }[]
        | null;
      const nombre = Array.isArray(cap) ? cap[0]?.nombre : cap?.nombre;
      return {
        id: g.id as string,
        fecha_gasto: (g.fecha_gasto as string | null) ?? null,
        monto: g.monto == null ? null : Number(g.monto),
        moneda: (g.moneda as string | null) ?? null,
        categoria: (g.categoria as string | null) ?? null,
        capturo_nombre: nombre ?? null,
      };
    };

    const resultados: Array<Record<string, unknown>> = [];
    const CONCURRENCIA = 5;
    for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
      const lote = pendientes.slice(i, i + CONCURRENCIA);
      const parciales = await Promise.all(
        lote.map(async (g) => {
          try {
            const sug = await this.sugerirAsignacion(g.id as string);
            return { gasto: resumen(g), ...sug };
          } catch {
            return {
              gasto: resumen(g),
              sugerido: null,
              confianza: 0,
              razon: 'No se pudo evaluar este gasto.',
              fuente: 'regla' as const,
              candidatos: [],
            };
          }
        }),
      );
      resultados.push(...parciales);
    }
    return { total_pendientes: pendientes.length, resultados };
  }

  /** URLs firmadas (1 h) para fotos de recibos en el bucket privado gasto-fotos. */
  async signPhotos(paths: string[]): Promise<Record<string, string>> {
    const clean = [...new Set(paths.filter(Boolean))];
    if (clean.length === 0) return {};
    const { data } = await this.supabase.service.storage
      .from('gasto-fotos')
      .createSignedUrls(clean, 3600);
    const map: Record<string, string> = {};
    for (const it of data ?? []) {
      if (it.signedUrl && it.path) map[it.path] = it.signedUrl;
    }
    return map;
  }

  // ===== Gastos de pista (cuotas de aeródromo, p.ej. VIP SAESA) =====
  //
  // El sistema ya sabe qué avión aterrizó dónde y cuándo (escalas). En vez de
  // capturar desde cero, se PROPONE un gasto por aterrizaje fuera de CUN con
  // el monto del tarifario; la oficina solo confirma (mínimo trabajo, doc 5.2).
  // La factura del proveedor llega días después y se amarra a estos gastos.

  /** Fecha Cancún (UTC-5 fija, sin DST) de un timestamp ISO. */
  private cancunDate(iso: string): string {
    return new Date(new Date(iso).getTime() - 5 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Aterrizajes del periodo (escalas con destino ≠ CUN) que aún NO tienen
   * gasto de pista, con el monto sugerido del tarifario aeródromo×modelo.
   */
  async pistasPendientes(desde: string, hasta: string) {
    const d1 = `${desde}T00:00:00-05:00`;
    const d2 = `${hasta}T23:59:59-05:00`;
    const { data: escalas, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, hora_llegada, fecha_salida_plan, aeronave_id, aeronave:aeronave!aeronave_id(id, matricula, modelo), vuelo:vuelo!vuelo_id(id, folio, estado, es_externo, aeronave_id, aeronave:aeronave!aeronave_id(id, matricula, modelo))',
      )
      .neq('destino_iata', 'CUN')
      // Un tramo cancelado no aterrizó: no pre-provisiona cuota de pista.
      .is('cancelada_at', null)
      .or(
        `and(hora_llegada.gte.${d1},hora_llegada.lte.${d2}),and(hora_llegada.is.null,fecha_salida_plan.gte.${d1},fecha_salida_plan.lte.${d2})`,
      )
      .order('fecha_salida_plan', { ascending: true });
    if (error) throw new Error(error.message);

    type EscalaRow = {
      id: string;
      vuelo_id: string;
      orden: number;
      origen_iata: string;
      destino_iata: string;
      hora_llegada: string | null;
      fecha_salida_plan: string | null;
      aeronave: { id: string; matricula: string; modelo: string } | null;
      vuelo: {
        id: string;
        folio: string | null;
        estado: string;
        es_externo: boolean | null;
        aeronave: { id: string; matricula: string; modelo: string } | null;
      } | null;
    };
    // Vuelos de OPERADOR EXTERNO fuera: sus cuotas de pista las paga el
    // operador (VuelaTour solo paga el costo pactado del vuelo). Vuelos
    // CANCELADOS también fuera A PROPÓSITO (28-ago): esto es PRE-PROVISIÓN
    // — un cancelado no debe proponer pistas; si de verdad aterrizó (voló a
    // recoger), la pista se captura como gasto normal ligado al vuelo.
    const filas = ((escalas ?? []) as unknown as EscalaRow[]).filter(
      (e) =>
        e.vuelo &&
        e.vuelo.estado !== 'CANCELADO' &&
        e.vuelo.es_externo !== true,
    );
    if (filas.length === 0) return { data: [] };

    // Escalas que ya tienen gasto de pista (no proponer doble).
    const { data: existentes, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('escala_id, categoria')
      .in(
        'escala_id',
        filas.map((e) => e.id),
      );
    if (gErr) throw new Error(gErr.message);
    const conGasto = new Set(
      (existentes ?? [])
        .filter(
          (g) => g.categoria === 'OPERACIONES' || g.categoria === 'ATERRIZAJE',
        )
        .map((g) => g.escala_id as string),
    );

    const tarifas = await this.listTarifasAerodromo();

    const data = filas
      .filter((e) => !conGasto.has(e.id))
      .map((e) => {
        const aeronave = e.aeronave ?? e.vuelo?.aeronave ?? null;
        const tarifa = this.matchTarifa(
          tarifas,
          e.destino_iata,
          aeronave?.modelo,
        );
        const fechaIso = e.hora_llegada ?? e.fecha_salida_plan;
        return {
          escala_id: e.id,
          vuelo_id: e.vuelo_id,
          folio: e.vuelo?.folio ?? null,
          orden: e.orden,
          tramo: `${e.origen_iata}→${e.destino_iata}`,
          destino_iata: e.destino_iata,
          fecha: fechaIso,
          fecha_gasto: fechaIso ? this.cancunDate(fechaIso) : null,
          aeronave_id: aeronave?.id ?? null,
          matricula: aeronave?.matricula ?? null,
          modelo: aeronave?.modelo ?? null,
          monto_sugerido: tarifa ? Number(tarifa.monto) : null,
          moneda: tarifa?.moneda ?? 'MXN',
          tarifa_variable: tarifa?.variable ?? false,
        };
      });
    return { data };
  }

  /** Mejor tarifa: iata+modelo > iata > modelo > nada. Modelo por contains. */
  private matchTarifa(
    tarifas: Array<Record<string, unknown>>,
    iata: string,
    modelo?: string | null,
  ) {
    const m = (modelo ?? '').toLowerCase();
    const matchModelo = (t: Record<string, unknown>) =>
      t.modelo != null && m.includes(String(t.modelo).toLowerCase());
    const matchIata = (t: Record<string, unknown>) =>
      t.codigo_iata != null &&
      String(t.codigo_iata).toUpperCase() === iata.toUpperCase();
    const activas = tarifas.filter((t) => t.activo !== false);
    return (
      activas.find((t) => matchIata(t) && matchModelo(t)) ??
      activas.find((t) => matchIata(t) && t.modelo == null) ??
      activas.find((t) => t.codigo_iata == null && matchModelo(t)) ??
      null
    );
  }

  /**
   * Crea los gastos de pista confirmados por la oficina: origen SISTEMA,
   * ligados a su escala/vuelo, SIN_COMPROBANTE hasta que llegue la factura.
   */
  async generarPistas(dto: GenerarPistasDto, userId: string) {
    // Proveedor VIP SAESA por default si existe en el catálogo.
    const { data: prov } = await this.supabase.service
      .from('proveedor')
      .select('id')
      .ilike('nombre', '%saesa%')
      .limit(1)
      .maybeSingle();

    const resultados: Array<{
      escala_id: string;
      ok: boolean;
      gasto_id?: string;
      error?: string;
    }> = [];
    for (const item of dto.items) {
      const { data: esc } = await this.supabase.service
        .from('escala')
        .select(
          'id, vuelo_id, destino_iata, hora_llegada, fecha_salida_plan, aeronave_id, vuelo:vuelo!vuelo_id(aeronave_id)',
        )
        .eq('id', item.escala_id)
        .maybeSingle();
      if (!esc) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: 'Escala no encontrada',
        });
        continue;
      }
      // Whitelist: una "pista" solo puede ser OPERACIONES o ATERRIZAJE.
      // El DTO acepta todo el enum y este insert va DIRECTO a la tabla (no
      // pasa por create()): sin esta guarda, un PERSONAL_DUENO o INDIRECTO
      // ligado a escala/vuelo/avión contaminaría balance y reparto en
      // silencio (verificación adversarial 26-ago).
      const categoria = item.categoria ?? 'OPERACIONES';
      if (
        categoria !== CategoriaGasto.OPERACIONES &&
        categoria !== CategoriaGasto.ATERRIZAJE
      ) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: `Categoría ${etiquetaCategoriaGasto(categoria)} no aplica a gastos de pista`,
        });
        continue;
      }
      const { data: dup } = await this.supabase.service
        .from('gasto')
        .select('id')
        .eq('escala_id', item.escala_id)
        .eq('categoria', categoria)
        .limit(1);
      if (dup && dup.length > 0) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: `Ya existe un gasto de ${etiquetaCategoriaGasto(categoria)} para ese aterrizaje`,
        });
        continue;
      }
      const vuelo = esc.vuelo as unknown as {
        aeronave_id: string | null;
      } | null;
      const fechaIso = (esc.hora_llegada ?? esc.fecha_salida_plan) as
        | string
        | null;
      const { data: gasto, error } = await this.supabase.service
        .from('gasto')
        .insert({
          usuario_captura_id: userId,
          origen: 'SISTEMA',
          categoria,
          monto: item.monto,
          moneda: item.moneda ?? 'MXN',
          fecha_gasto: fechaIso
            ? this.cancunDate(fechaIso)
            : this.cancunDate(new Date().toISOString()),
          medio_pago: item.medio_pago ?? 'TRANSFERENCIA',
          vuelo_id: esc.vuelo_id,
          escala_id: esc.id,
          // Avión del TRAMO con herencia (regla B 28-ago, misma prioridad
          // que create()/`avionDelGasto`): la pista la pagó el avión que
          // aterrizó, no el principal del vuelo.
          aeronave_id:
            (esc.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null,
          proveedor_id: item.proveedor_id ?? prov?.id ?? null,
          lugar: esc.destino_iata,
          estatus_comprobante: 'SIN_COMPROBANTE',
          notas:
            item.notas ?? `Cuota de aterrizaje ${esc.destino_iata as string}`,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .maybeSingle();
      if (error || !gasto) {
        resultados.push({
          escala_id: item.escala_id,
          ok: false,
          error: error?.message ?? 'No se pudo crear el gasto',
        });
        continue;
      }
      resultados.push({
        escala_id: item.escala_id,
        ok: true,
        gasto_id: gasto.id as string,
      });
    }
    return { creados: resultados.filter((r) => r.ok).length, resultados };
  }

  // ===== Tarifario de aeródromos =====

  async listTarifasAerodromo() {
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .order('codigo_iata', { ascending: true, nullsFirst: false })
      .order('modelo', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async createTarifaAerodromo(dto: CreateTarifaAerodromoDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .insert({
        codigo_iata: dto.codigo_iata?.toUpperCase() || null,
        modelo: dto.modelo || null,
        monto: dto.monto,
        moneda: dto.moneda ?? 'MXN',
        variable: dto.variable ?? false,
        activo: dto.activo ?? true,
        notas: dto.notas,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'Ya existe una tarifa para ese aeródromo/modelo.',
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async updateTarifaAerodromo(
    id: string,
    dto: UpdateTarifaAerodromoDto,
    userId: string,
  ) {
    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.codigo_iata !== undefined)
      patch.codigo_iata = dto.codigo_iata?.toUpperCase() || null;
    if (dto.modelo !== undefined) patch.modelo = dto.modelo || null;
    if (dto.monto !== undefined) patch.monto = dto.monto;
    if (dto.moneda !== undefined) patch.moneda = dto.moneda;
    if (dto.variable !== undefined) patch.variable = dto.variable;
    if (dto.activo !== undefined) patch.activo = dto.activo;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    const { data, error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .update(patch)
      .eq('id', id)
      .select('id, codigo_iata, modelo, monto, moneda, variable, activo, notas')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Tarifa ${id} not found`);
    return data;
  }

  async removeTarifaAerodromo(id: string) {
    const { error } = await this.supabase.service
      .from('tarifa_aerodromo')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  /** Visto bueno de administración a un gasto prellenado con IA (app). */
  async darVistoBueno(id: string, userId: string) {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({
        requiere_visto_bueno: false,
        visto_bueno_por: userId,
        visto_bueno_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', id)
      .select(LIST_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  /**
   * Alta de un gasto (app y panel; la carga masiva de combustibles también
   * pasa por aquí).
   *
   * AVIÓN DEL GASTO — regla del cliente 28-ago-2026 (vuelos multi-avión):
   * "los gastos van al avión que realizó el tramo al que están enlazados".
   * `gasto.aeronave_id` se sella con esta prioridad, la MISMA que leen
   * balance/reparto/Libro Dinero vía `avionDelGasto`
   * (`common/participacion-aeronave.util`):
   *   1. avión explícito del DTO (se respeta; si difiere del avión del tramo
   *      se deja aviso ⚠ en notas, sin bloquear — los lectores cuentan el
   *      gasto al avión del TRAMO);
   *   2. avión del TRAMO (`escala.aeronave_id ?? vuelo.aeronave_id`, herencia
   *      de todo el sistema) cuando el gasto trae `escala_id`;
   *   3. avión del VUELO cuando solo trae `vuelo_id`.
   * Un `escala_id` sin `vuelo_id` sella también el vuelo del tramo; un
   * tramo de OTRO vuelo se rechaza. Los demás caminos que sellan avión desde
   * un vuelo (`generarPistas`, `update` al ligar vuelo/tramo) aplican la
   * misma herencia por tramo.
   */
  async create(
    dto: CreateGastoDto,
    userId: string,
    rol?: Rol,
    // notificar:false = flujos en lote (carga masiva de combustibles): una
    // carga de 50 filas no debe disparar 50 push a admin.
    opts?: { notificar?: boolean },
  ) {
    // El mecánico solo puede cargar combustible (GAS).
    if (rol === Rol.MECANICO && dto.categoria !== 'GAS') {
      throw new BadRequestException(
        'El mecánico solo puede cargar combustible (GAS).',
      );
    }
    // VISITANTE (27-ago): SOLO gastos de visita — la categoría se fija en
    // VISITA sin fricción (la app ni la muestra) y el medio queda acotado a
    // su fondo (EFECTIVO) o su tarjeta corporativa.
    if (rol === Rol.VISITANTE) {
      dto.categoria = CategoriaGasto.VISITA;
      // Y jamás liga vuelo/avión/escala (su app ni los muestra).
      delete dto.vuelo_id;
      delete dto.aeronave_id;
      delete dto.escala_id;
      if (
        dto.medio_pago !== MedioPago.EFECTIVO &&
        dto.medio_pago !== MedioPago.TARJETA_CORP
      ) {
        throw new BadRequestException(
          'El visitante paga con su fondo (efectivo) o su tarjeta corporativa.',
        );
      }
    }
    // Fecha del ticket razonable en capturas de CAMPO (28-ago): la IA leyó
    // "26/08/2025" en un ticket de la visita de 2026 y el gasto quedó un año
    // atrás, invisible en el panel. En vez de guardar en silencio, se rechaza
    // con el dato a la vista para que corrijan el año en la app.
    this.assertFechaRazonable(
      dto.fecha_gasto,
      rol,
      dto.permitir_fecha_antigua === true,
    );
    // Regla SEMANAL de captura (1-sep): solo roles de CAMPO — la oficina
    // (vuelos pasados, cargas masivas, cargas históricas) queda exenta, y un
    // permiso temporal `gastos_sin_limite_hasta` vigente también exime.
    await this.assertCapturaEnSemana(dto.fecha_gasto, rol, userId);
    // REGLA B (28-ago): un gasto enlazado a un TRAMO pertenece al avión de
    // ese tramo. Se resuelve UNA vez aquí (vuelo del tramo + avión con
    // herencia) y de aquí salen la herencia y el aviso de discrepancia.
    // Antes que los candados de categoría: un tramo implica vuelo.
    let tramoRef: TramoGastoRef | null = null;
    if (dto.escala_id) {
      tramoRef = await this.resolverTramoGasto(dto.escala_id);
      if (dto.vuelo_id && dto.vuelo_id !== tramoRef.vuelo_id) {
        throw new BadRequestException(
          `El tramo ${tramoRef.tramo} no pertenece al vuelo seleccionado: corrige el vuelo o la escala.`,
        );
      }
      dto.vuelo_id = tramoRef.vuelo_id;
    }
    // Un gasto INDIRECTO es de la operación, NO de un vuelo: ligarlo a uno lo
    // metería al reporte/reparto de ese vuelo y contaminaría sus números.
    if (dto.categoria === CategoriaGasto.INDIRECTO && dto.vuelo_id) {
      throw new BadRequestException(
        'Un gasto INDIRECTO no se liga a un vuelo; usa otra categoría o quita el vuelo.',
      );
    }
    // NOMINA (29-ago): espejo de INDIRECTO — sin vuelo (avión opcional).
    if (dto.categoria === CategoriaGasto.NOMINA && dto.vuelo_id) {
      throw new BadRequestException(
        'Un gasto de NÓMINA no se liga a un vuelo; usa otra categoría o quita el vuelo.',
      );
    }
    // SERVICIOS (29-ago): servicio AL AVIÓN — avión permitido/esperado, pero
    // sin vuelo (no es un gasto de operación de un vuelo concreto).
    if (dto.categoria === CategoriaGasto.SERVICIOS && dto.vuelo_id) {
      throw new BadRequestException(
        'Un gasto de SERVICIOS no se liga a un vuelo (es del avión); quita el vuelo o usa otra categoría.',
      );
    }
    // Un gasto PERSONAL del dueño NO es de la empresa ni de los aviones:
    // con vuelo o avión entraría a reportes/balances y contaminaría dinero
    // de la empresa (candado espejo en update()).
    if (
      dto.categoria === CategoriaGasto.PERSONAL_DUENO &&
      (dto.vuelo_id || dto.aeronave_id || dto.escala_id)
    ) {
      throw new BadRequestException(
        'Un gasto personal del dueño no lleva vuelo, avión ni escala: quítalos o usa otra categoría.',
      );
    }
    // Gasolina de VEHÍCULOS: gasto de la empresa — con avión/vuelo entraría
    // al balance del avión (justo la contaminación que motivó la categoría,
    // caso XB-ANU 27-ago). El avión se asigna, si acaso, con reparto manual.
    if (
      dto.categoria === CategoriaGasto.GASOLINA &&
      (dto.vuelo_id || dto.aeronave_id || dto.escala_id)
    ) {
      throw new BadRequestException(
        'La gasolina de vehículos no lleva vuelo, avión ni escala (para combustible de aviación usa GAS): quítalos o usa otra categoría.',
      );
    }
    // Gastos de VISITA: jamás de un vuelo/avión (mismo patrón).
    if (
      dto.categoria === CategoriaGasto.VISITA &&
      (dto.vuelo_id || dto.aeronave_id || dto.escala_id)
    ) {
      throw new BadRequestException(
        'Un gasto de visita no lleva vuelo, avión ni escala: quítalos o usa otra categoría.',
      );
    }
    // El piloto ya NO ve ni edita desglose en la app (solo el total): el
    // desglose que leyó la IA llega en valor_ia_extraido y aquí se compone
    // para oficina (aplica la regla FBO+IVA).
    let notas = dto.notas;
    const ia = dto.valor_ia_extraido as
      | { conceptos?: Array<{ concepto?: unknown; monto?: unknown }> }
      | undefined;
    const conceptos = (ia?.conceptos ?? [])
      .map((c) => ({
        concepto: String(c.concepto ?? ''),
        monto: Number(c.monto),
      }))
      .filter((c) => c.concepto && Number.isFinite(c.monto) && c.monto > 0);
    if (conceptos.length >= 2) {
      // El desglose cuadra contra el TICKET (monto − propina): la propina
      // de terminal no aparece en los renglones impresos.
      const lineas = desgloseGastoLineas(
        conceptos,
        Math.round((dto.monto - (dto.propina ?? 0)) * 100) / 100,
        dto.moneda,
      );
      const bloque = `Desglose:\n${lineas.join('\n')}`;
      notas = notas ? `${notas}\n\n${bloque}` : bloque;
    }
    // Distintivo pedido por el cliente: quién sube el gasto (piloto vs oficina).
    let origen: string =
      rol === Rol.PILOTO
        ? 'PILOTO'
        : rol === Rol.MECANICO
          ? 'MECANICO'
          : rol === Rol.VISITANTE
            ? 'VISITANTE'
            : 'OFICINA';
    // Backfill de oficina "como si lo hubiera subido el piloto": la oficina
    // carga gastos de vuelos pasados y deben quedar atribuidos al piloto del
    // vuelo (usuario_captura + origen = PILOTO), pero created_by conserva al
    // admin real (auditoría). Solo ADMIN/COORDINADOR.
    let capturaId = userId;
    let aeronaveId = dto.aeronave_id;
    if (dto.capturar_como_piloto === true) {
      if (rol !== Rol.ADMIN && rol !== Rol.COORDINADOR) {
        throw new BadRequestException(
          'Solo oficina (admin/coordinador) puede registrar un gasto a nombre del piloto.',
        );
      }
      if (!dto.vuelo_id) {
        throw new BadRequestException(
          'Para simular la captura del piloto, selecciona el vuelo.',
        );
      }
      const { data: vuelo } = await this.supabase.service
        .from('vuelo')
        .select('id, folio, piloto_id, aeronave_id')
        .eq('id', dto.vuelo_id)
        .maybeSingle();
      if (!vuelo) {
        throw new BadRequestException('El vuelo seleccionado no existe.');
      }
      if (!vuelo.piloto_id) {
        throw new BadRequestException(
          `El vuelo #${vuelo.folio as number} no tiene piloto asignado; no se puede registrar a su nombre.`,
        );
      }
      capturaId = vuelo.piloto_id as string;
      origen = 'PILOTO';
      // El avión del tramo (o del vuelo) si no se envió, para que el costo
      // caiga en él.
      aeronaveId =
        dto.aeronave_id ??
        tramoRef?.aeronave_id ??
        (vuelo.aeronave_id as string | null) ??
        undefined;
    }
    // Herencia tramo/vuelo→avión al ESCRIBIR (misma regla que la lectura del
    // balance, `avionDelGasto`): el dinero de un gasto ligado a un tramo
    // pertenece al avión que VOLÓ ese tramo (`escala.aeronave_id ??
    // vuelo.aeronave_id`, regla B 28-ago); con solo vuelo, al avión del
    // vuelo. Sin esto, el reparto (que filtra por aeronave_id CRUDO) no lo
    // veía — un gasto con vuelo pero sin avión era invisible para los socios.
    // A PROPÓSITO no hay candado por estado del vuelo (ni aquí ni en
    // update()): un vuelo CANCELADO acepta gastos — incluido GAS — porque
    // el avión pudo volar a recoger y regresar ferry (regla del cliente
    // 28-ago-2026); esos gastos cuentan en balance y reparto.
    if (!aeronaveId && dto.vuelo_id) {
      if (tramoRef) {
        aeronaveId = tramoRef.aeronave_id ?? undefined;
      } else {
        const { data: vueloRef } = await this.supabase.service
          .from('vuelo')
          .select('aeronave_id')
          .eq('id', dto.vuelo_id)
          .maybeSingle();
        aeronaveId = (vueloRef?.aeronave_id as string | null) ?? undefined;
      }
    }
    // Avión EXPLÍCITO distinto al del tramo: se respeta lo que mandó el
    // usuario (puede ser deliberado), pero queda aviso — balance, reparto y
    // Libro Dinero cuentan el gasto al avión del TRAMO (`avionDelGasto`).
    const avisoTramo = await this.avisoAvionDistintoAlTramo(
      dto.aeronave_id,
      tramoRef,
    );
    if (avisoTramo) notas = notas ? `${notas}\n${avisoTramo}` : avisoTramo;
    // El combustible se controla POR AVIÓN (gasto mensual del avión en el
    // balance): una carga sin avión sería invisible para balance y reparto.
    if (dto.categoria === CategoriaGasto.GAS && !aeronaveId) {
      throw new BadRequestException(
        'La carga de combustible necesita el avión: selecciona la aeronave (o un vuelo del cual tomarla).',
      );
    }
    // TARJETA CORP "por detrás" (26-ago): el usuario solo elige "Tarjeta
    // corporativa" en la app — la TERMINACIÓN se sella sola con este orden:
    // (1) valor explícito del cliente (APK viejo con selector / oficina),
    // (2) la que la IA leyó en el VOUCHER (máxima fidelidad: es la tarjeta
    //     que de verdad pagó), (3) la tarjeta ASIGNADA al capturador en el
    // catálogo (vínculo de Tarjetas corp.; con varias, la más reciente).
    // Así el tablero "por tarjeta" queda completo sin confundir a nadie; si
    // el voucher contradice lo sellado, la discrepancia IA lo grita.
    let tarjetaTerminacion = dto.tarjeta_terminacion;
    if (!tarjetaTerminacion && String(dto.medio_pago) === 'TARJETA_CORP') {
      const iaTerm = (
        dto.valor_ia_extraido as { tarjeta_terminacion?: unknown } | undefined
      )?.tarjeta_terminacion;
      if (typeof iaTerm === 'string' && /^\d{4}$/.test(iaTerm)) {
        tarjetaTerminacion = iaTerm;
      } else {
        const { data: tj } = await this.supabase.service
          .from('tarjeta_corporativa')
          .select('terminacion')
          .eq('usuario_id', capturaId)
          .eq('activa', true)
          .order('updated_at', { ascending: false })
          .limit(1);
        tarjetaTerminacion =
          (tj?.[0]?.terminacion as string | undefined) ?? undefined;
      }
    }

    // VALIDACIÓN DE MATRÍCULA (26-ago, caso ASUR Mérida vuelo #105): si la
    // IA leyó una matrícula en el comprobante y NO es la del avión al que
    // quedó el gasto (elegido o HEREDADO del tramo/vuelo — sin escala, en
    // cambios de avión a media jornada la herencia cuelga el gasto en el
    // avión principal; con escala ya cae en el avión del tramo), se
    // advierte de inmediato: ⚠ en notas + visto bueno pendiente + aviso a
    // oficina. No bloquea: el recibo puede traer una matrícula ajena real.
    let discrepanciaMatricula: string | null = null;
    const matriculaIA = (
      dto.valor_ia_extraido as { matricula?: unknown } | undefined
    )?.matricula;
    if (typeof matriculaIA === 'string' && matriculaIA.trim() && aeronaveId) {
      const { data: flotaMat } = await this.supabase.service
        .from('aeronave')
        .select('id, matricula');
      const normMat = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const delRecibo = (flotaMat ?? []).find(
        (a) => normMat(a.matricula as string) === normMat(matriculaIA),
      );
      if (delRecibo && delRecibo.id !== aeronaveId) {
        const asignada = (flotaMat ?? []).find((a) => a.id === aeronaveId);
        discrepanciaMatricula = `el comprobante trae la matrícula ${delRecibo.matricula as string} pero el gasto quedó en ${(asignada?.matricula as string | undefined) ?? 'otro avión'}`;
        const linea = `⚠ ${discrepanciaMatricula} — revisar`;
        notas = notas ? `${notas}\n${linea}` : linea;
      }
    }
    // Propina: sub-parte informativa del monto (monto = ticket + propina, es
    // lo que se concilia contra el banco). Nunca puede exceder el total.
    if (dto.propina != null && Number(dto.propina) > Number(dto.monto)) {
      throw new BadRequestException(
        'La propina no puede ser mayor que el monto total pagado.',
      );
    }
    const payload: Record<string, unknown> = {
      usuario_captura_id: capturaId,
      origen,
      // Prellenado con IA desde la app (flujo admin): pendiente del visto
      // bueno de administración en el panel. No bloquea nada. Una matrícula
      // que no coincide con el avión asignado también exige visto bueno.
      requiere_visto_bueno:
        dto.requiere_visto_bueno === true || discrepanciaMatricula != null,
      categoria: dto.categoria,
      monto: dto.monto,
      propina: dto.propina ?? 0,
      moneda: dto.moneda,
      tc_gasto: dto.tc_gasto,
      fecha_gasto: dto.fecha_gasto,
      medio_pago: dto.medio_pago,
      tarjeta_terminacion: tarjetaTerminacion,
      vuelo_id: dto.vuelo_id,
      escala_id: dto.escala_id,
      aeronave_id: aeronaveId,
      proveedor_id: dto.proveedor_id,
      litros: dto.litros,
      tipo_combustible: dto.tipo_combustible,
      lugar: dto.lugar,
      fecha_hora_carga: dto.fecha_hora_carga,
      estatus_comprobante: dto.estatus_comprobante ?? 'SIN_COMPROBANTE',
      // Sin valor explícito se omite la llave: manda el default de la BD
      // (PENDIENTE) y el trigger del amarre de factura recibida.
      estatus_facturacion: dto.estatus_facturacion,
      foto_url: dto.foto_url,
      valor_ia_extraido: dto.valor_ia_extraido,
      duplicado_sospechado: await this.looksLikeDuplicate(dto),
      folio_ticket: dto.folio_ticket?.trim() || null,
      // Idempotencia (29-ago): un reintento con la misma llave colisiona en
      // uq_gasto_client_request y devuelve la fila EXISTENTE (abajo).
      client_request_id: dto.client_request_id ?? null,
      notas,
      created_by: userId,
      updated_by: userId,
    };

    // CANDADO por folio/remisión: el mismo ticket capturado dos veces trae
    // el mismo folio, sin importar quién ni cuántos días después. El pre-check
    // da el mensaje con detalle; el índice único de la BD cubre la carrera.
    await this.assertFolioTicketLibre(dto.folio_ticket);

    // CANDADO DE VENTANA (29-ago, mientras vivan APKs sin llave de
    // idempotencia): un payload SIN client_request_id NI folio_ticket que es
    // IDÉNTICO a un gasto del mismo capturista creado hace < 90 s es casi
    // seguro el reintento del outbox/doble tap (pares reales en prod con
    // 3-5 s de diferencia). Con notas distintas o con llave/folio JAMÁS
    // bloquea.
    if (!dto.client_request_id && !dto.folio_ticket?.trim()) {
      await this.assertNoCapturaRepetida(
        dto,
        capturaId,
        notas ?? null,
        aeronaveId ?? null,
      );
    }

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert(payload)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      if (error.code === '23505') {
        // Colisión de la LLAVE DE IDEMPOTENCIA: el gasto YA se creó en un
        // intento anterior (timeout tras commit / doble flush del outbox).
        // Se devuelve la fila existente con el mismo shape que un alta
        // normal: el reintento se vuelve inocuo.
        if (
          dto.client_request_id &&
          error.message.includes('uq_gasto_client_request')
        ) {
          const { data: existente, error: exErr } = await this.supabase.service
            .from('gasto')
            .select(COLS)
            .eq('client_request_id', dto.client_request_id)
            .maybeSingle();
          if (!exErr && existente) {
            this.logger.log(
              `Gasto idempotente: reintento con client_request_id ${dto.client_request_id} → se devuelve el gasto existente ${existente.id as string} (sin duplicar).`,
            );
            return existente;
          }
        }
        throw new ConflictException(
          `Ya existe un gasto con el folio/remisión "${dto.folio_ticket}": es el mismo pago capturado dos veces. Si de verdad es otro ticket, corrige el folio.`,
        );
      }
      throw new Error(error.message);
    }

    // Aviso inmediato a oficina del cruce de matrícula (no solo en notas):
    // mismo canal que las discrepancias del enriquecimiento IA.
    if (discrepanciaMatricula && data && opts?.notificar !== false) {
      const avisoMat = {
        tipo: 'alerta_sistema',
        titulo: 'Matrícula del comprobante no coincide',
        cuerpo: `${etiquetaCategoriaGasto(dto.categoria)} · $${Number(dto.monto).toFixed(2)} ${dto.moneda}: ${discrepanciaMatricula}. Corrige el avión del gasto si aplica.`,
        data: { gasto_id: data.id as string },
        link: '/admin/expenses',
      };
      void this.notifications.notifyRole(Rol.ADMIN, avisoMat);
      void this.notifications.notifyRole(Rol.ANALISTA, avisoMat);
    }

    // Captura OFFLINE con foto: el piloto no tuvo IA en campo — el servidor
    // lee el comprobante ahora y completa lo que falte (como el tacómetro:
    // la operación no se detiene y el dato llega completo igual).
    if (dto.leer_con_ia === true && dto.foto_url) {
      void this.enriquecerGastoConIA(
        (data as { id: string }).id,
        dto.foto_url,
        userId,
      ).catch((err) =>
        this.logger.warn(
          `Enriquecimiento IA del gasto falló: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    // Aviso a admin: el piloto subió un gasto desde campo.
    if (opts?.notificar !== false) {
      void this.notifications.notifyRole(
        Rol.ADMIN,
        {
          tipo: 'gasto_registrado',
          titulo: 'Gasto registrado',
          cuerpo: `${etiquetaCategoriaGasto(dto.categoria)} · ${dto.moneda} ${Number(dto.monto).toLocaleString('en-US')}`,
          data: {
            gasto_id: (data as { id: string }).id,
            vuelo_id: dto.vuelo_id ?? null,
          },
          link: dto.vuelo_id
            ? `/admin/flights/${dto.vuelo_id}`
            : '/admin/expenses',
        },
        userId,
      );
    }

    return data!;
  }

  /**
   * Lee el comprobante de un gasto capturado OFFLINE y completa los campos
   * que el piloto no pudo llenar. REGLAS: lo manual NUNCA se pisa (el monto
   * jamás se toca; si la IA lee otro total, se anota para revisión). Se
   * completa: desglose→notas, fecha del ticket, categoría (solo si quedó
   * OTRO), tarjeta, litros/lugar en GAS, matrícula→aeronave si estaba vacía.
   */
  /**
   * Reanaliza el comprobante YA GUARDADO de un gasto con la IA de visión
   * (botón del panel, 24-ago-2026): gastos capturados antes de una mejora
   * del prompt (p. ej. la separación Operación/TUA/FBO) se quedaban con la
   * lectura vieja pegada. SOLO-LECTURA a propósito: no persiste nada — la
   * lectura vuelve al panel para prellenar el formulario y `valor_ia_extraido`
   * se guarda JUNTO con el PATCH cuando el humano confirma (misma
   * transacción que las notas: sin divergencia notas↔jsonb, y Cancelar
   * de verdad descarta; ronda adversarial 24-ago).
   *
   * Multi-hoja: el alta admin de la app guarda las hojas 2..N en
   * `valor_ia_extraido.fotos_adicionales` — se mandan TODAS a la IA (leer
   * solo la hoja 1 daría un total parcial que parece bueno).
   */
  async reanalizarConIA(gastoId: string, userId?: string) {
    // Misma ruta /vision/gasto que la captura, pero categoría propia en el
    // registro de consumo: la decide el call site, nunca pyservices.
    const reg = {
      categoria: 'REANALISIS',
      usuarioId: userId ?? null,
      contexto: { gasto_id: gastoId },
    };
    const gasto = (await this.findById(gastoId)) as {
      foto_url?: string | null;
      valor_ia_extraido?: { fotos_adicionales?: unknown } | null;
    };
    const path = gasto.foto_url ?? null;
    if (!path) {
      throw new BadRequestException(
        'El gasto no tiene comprobante que analizar',
      );
    }
    const fotosAdicionales = Array.isArray(
      gasto.valor_ia_extraido?.fotos_adicionales,
    )
      ? (gasto.valor_ia_extraido.fotos_adicionales as unknown[]).filter(
          (f): f is string => typeof f === 'string' && f.length > 0,
        )
      : [];
    const paths = [path, ...fotosAdicionales];
    const urls = await this.signPhotos(paths);
    if (!urls[path]) {
      throw new BadRequestException('No se pudo firmar el comprobante');
    }
    const lower = path.toLowerCase();
    let lectura: Awaited<ReturnType<VisionService['readGastoTicket']>>;
    if (lower.endsWith('.pdf')) {
      const b64 = await this.descargarBase64(urls[path]);
      lectura = b64
        ? await this.vision.readGastoTicket({ pdfBase64: b64 }, reg)
        : null;
    } else if (/\.(xlsx|xls|csv)$/.test(lower)) {
      const b64 = await this.descargarBase64(urls[path]);
      lectura = b64
        ? await this.vision.readGastoTicket(
            {
              excelBase64: b64,
              excelFilename: path.split('/').pop() ?? 'comprobante.xlsx',
            },
            reg,
          )
        : null;
    } else if (fotosAdicionales.length > 0) {
      // Factura multi-hoja: todas las páginas juntas (Claude las descarga).
      lectura = await this.vision.readGastoTicket(
        {
          images: paths
            .filter((pp) => urls[pp])
            .map((pp) => ({ imageUrl: urls[pp] })),
        },
        reg,
      );
    } else {
      // Imagen: Claude descarga la URL firmada — sin re-subir bytes.
      lectura = await this.vision.readGastoTicket(
        { imageUrl: urls[path] },
        reg,
      );
    }
    if (!lectura) return { disponible: false as const };
    if (lectura.motivo && lectura.monto === undefined) {
      return { disponible: false as const, motivo: lectura.motivo };
    }
    // Las hojas adicionales viven SOLO en este jsonb: la llave se conserva
    // en la lectura que el panel guardará (perderla dejaría fotos huérfanas).
    return {
      disponible: true as const,
      ...lectura,
      ...(fotosAdicionales.length > 0
        ? { fotos_adicionales: fotosAdicionales }
        : {}),
    };
  }

  /** Bytes de una URL firmada del bucket, en base64 (PDF/Excel a la IA). */
  private async descargarBase64(url: string): Promise<string | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch {
      return null;
    }
  }

  private async enriquecerGastoConIA(
    gastoId: string,
    fotoPath: string,
    userId: string,
  ): Promise<void> {
    const urls = await this.signPhotos([fotoPath]);
    const imageUrl = urls[fotoPath];
    if (!imageUrl) return;
    const ai = await this.vision.readGastoTicket(
      { imageUrl },
      {
        usuarioId: userId,
        contexto: { gasto_id: gastoId, origen: 'offline_enriquecimiento' },
      },
    );
    if (!ai || ai.monto === undefined || !ai.legible) return;

    const gasto = await this.findById(gastoId);
    const patch: Record<string, unknown> = {
      valor_ia_extraido: ai,
      updated_by: userId,
    };

    // REGLA: lo que el piloto CAPTURÓ nunca se sobreescribe. Solo se llenan
    // huecos; toda diferencia IA-vs-captura se anota con ⚠ y se avisa a
    // oficina — los pilotos también se equivocan y debe quedar visible.
    const discrepancias: string[] = [];

    // Categoría: la app ya NO preselecciona OTRO (24-ago) — un OTRO que
    // llega es elección deliberada (p. ej. comisariato de pasajeros). La IA
    // nunca pisa la categoría: toda diferencia queda como discrepancia
    // visible para que oficina decida en Verificar.
    if (ai.categoria_sugerida && ai.categoria_sugerida !== gasto.categoria) {
      discrepancias.push(
        `categoría capturada ${etiquetaCategoriaGasto(gasto.categoria as string)}, la IA sugiere ${etiquetaCategoriaGasto(ai.categoria_sugerida)}`,
      );
    }
    // Fecha: NO se pisa; si el ticket trae otra, discrepancia.
    if (
      ai.fecha &&
      /^\d{4}-\d{2}-\d{2}$/.test(ai.fecha) &&
      ai.fecha !== (gasto.fecha_gasto as string | null)
    ) {
      discrepancias.push(
        `fecha capturada ${gasto.fecha_gasto as string}, el ticket dice ${ai.fecha}`,
      );
    }
    // Moneda distinta = monto probablemente en la divisa equivocada.
    if (ai.moneda && ai.moneda !== gasto.moneda) {
      discrepancias.push(
        `moneda capturada ${gasto.moneda as string}, el ticket está en ${ai.moneda}`,
      );
    }
    // Total: nunca se toca; diferencia → discrepancia. El ticket puede NO
    // traer la propina impresa (se agrega en la terminal): la lectura IA es
    // consistente si coincide con el total pagado O con el ticket (monto −
    // propina) — si no se acepta esa segunda forma, el flujo feliz de
    // propina dispararía una alerta falsa en cada sync.
    const montoTicket = Number(gasto.monto) - Number(gasto.propina ?? 0);
    if (
      ai.monto != null &&
      Math.abs(Number(gasto.monto) - ai.monto) > 0.01 &&
      Math.abs(montoTicket - ai.monto) > 0.01
    ) {
      discrepancias.push(
        `total capturado $${Number(gasto.monto).toFixed(2)} ${gasto.moneda}, la IA leyó $${ai.monto.toFixed(2)} ${ai.moneda ?? ''}`,
      );
    }
    // Tarjeta: llenar si falta; discrepancia si difiere.
    if (!gasto.tarjeta_terminacion && ai.tarjeta_terminacion) {
      patch.tarjeta_terminacion = ai.tarjeta_terminacion;
    } else if (
      ai.tarjeta_terminacion &&
      gasto.tarjeta_terminacion &&
      ai.tarjeta_terminacion !== gasto.tarjeta_terminacion
    ) {
      discrepancias.push(
        `tarjeta capturada •${gasto.tarjeta_terminacion as string}, el voucher dice •${ai.tarjeta_terminacion}`,
      );
    }
    if (gasto.categoria === 'GAS' || ai.categoria_sugerida === 'GAS') {
      if (gasto.litros == null && (ai as { litros?: number }).litros != null) {
        patch.litros = (ai as { litros?: number }).litros;
      }
    }
    // Folio/remisión del ticket: llenar si falta. Si el folio leído YA existe
    // en otro gasto, NO se escribe (el índice único reventaría el patch):
    // se marca posible duplicado y queda la nota — es justo el caso "dos
    // personas capturaron el mismo ticket" detectado por la foto.
    if (!gasto.folio_ticket && ai.folio) {
      const folioLeido = String(ai.folio).slice(0, 60);
      const norm = normalizarFolio(folioLeido);
      if (norm && norm.length >= FOLIO_CANDADO_MIN) {
        const { data: repetido } = await this.supabase.service
          .from('gasto')
          .select('id')
          .eq('folio_ticket_norm', norm)
          .neq('id', gastoId)
          .limit(1);
        if ((repetido ?? []).length > 0) {
          patch.duplicado_sospechado = true;
          discrepancias.push(
            `el folio ${folioLeido} del ticket YA está capturado en otro gasto — posible pago duplicado`,
          );
        } else {
          patch.folio_ticket = folioLeido;
        }
      } else if (norm) {
        patch.folio_ticket = folioLeido;
      }
    }
    // Matrícula del documento → avión (saca el gasto de la bandeja solo).
    if (ai.matricula) {
      const { data: aviones } = await this.supabase.service
        .from('aeronave')
        .select('id, matricula')
        .eq('activa', true);
      const norm = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const match = (aviones ?? []).find(
        (a) => norm(a.matricula as string) === norm(ai.matricula!),
      );
      if (
        match &&
        !gasto.aeronave_id &&
        // Un gasto PERSONAL del dueño, GASOLINA (vehículos) o VISITA JAMÁS
        // recibe avión — ni siquiera si el comprobante trae una matrícula:
        // este update va directo a la tabla y brincaría el candado de
        // update().
        gasto.categoria !== 'PERSONAL_DUENO' &&
        gasto.categoria !== 'GASOLINA' &&
        gasto.categoria !== 'VISITA'
      ) {
        patch.aeronave_id = match.id;
      } else if (match && gasto.aeronave_id && match.id !== gasto.aeronave_id) {
        discrepancias.push(
          `el documento trae la matrícula ${match.matricula as string} pero el gasto está asignado a otro avión`,
        );
      }
    }

    // Notas: bloque IA (desglose con la regla FBO+IVA + proveedor +
    // matrícula), añadido DESPUÉS de lo que el piloto escribió, y las ⚠
    // discrepancias.
    // El desglose cuadra contra el TICKET (monto − propina): la propina de
    // terminal no aparece en los renglones impresos.
    const lineas: string[] = desgloseGastoLineas(
      (ai.conceptos ?? []).filter(
        (c) => c.concepto && Number.isFinite(c.monto),
      ),
      montoTicket,
      (ai.moneda ?? gasto.moneda) as string,
    );
    const extras = [ai.matricula, ai.proveedor, ai.concepto]
      .filter((v): v is string => !!v && v.trim().length > 0)
      .join(' · ');
    if (extras) lineas.push(extras);
    for (const d of discrepancias) lineas.push(`⚠ ${d} — revisar`);
    if (lineas.length > 0) {
      const bloque = `[IA al sincronizar]\n${lineas.join('\n')}`;
      patch.notas = gasto.notas ? `${gasto.notas}\n\n${bloque}` : bloque;
    }

    const { error } = await this.supabase.service
      .from('gasto')
      .update(patch)
      .eq('id', gastoId);
    if (error) throw new Error(error.message);

    // Con discrepancias, oficina se entera de inmediato (no solo en notas).
    if (discrepancias.length > 0) {
      const aviso = {
        tipo: 'alerta_sistema',
        titulo: 'Gasto con discrepancias IA vs captura',
        cuerpo: `${etiquetaCategoriaGasto(gasto.categoria as string)} · $${Number(gasto.monto).toFixed(2)} ${gasto.moneda as string}: ${discrepancias[0]}${discrepancias.length > 1 ? ` (+${discrepancias.length - 1} más)` : ''}`,
        data: { gasto_id: gastoId },
        link: '/admin/expenses',
      };
      void this.notifications.notifyRole(Rol.ADMIN, aviso);
      void this.notifications.notifyRole(Rol.ANALISTA, aviso);
    }
    this.logger.log(
      `Gasto ${gastoId} enriquecido con IA al sincronizar (${discrepancias.length} discrepancias)`,
    );
  }

  /**
   * Posible duplicado (doble captura). Dos reglas, deterministas — más fiable
   * que IA para esto:
   * - CON proveedor: mismo proveedor + monto + moneda, fecha ±DUP_DAYS
   *   (regla del diseño funcional).
   * - SIN proveedor (capturas del piloto/mecánico desde la app): misma
   *   categoría + monto + moneda, fecha ±DUP_DAYS_SIN_PROVEEDOR — ventana más
   *   corta para no marcar falsos positivos (dos taxis iguales en días
   *   distintos).
   * El flag NUNCA bloquea: la app avisa al capturista y el admin lo lista.
   * El candado DURO es aparte y por folio (assertFolioTicketLibre).
   */
  /**
   * CANDADO DURO anti-duplicados por folio/remisión: si otro gasto ya tiene
   * el MISMO folio normalizado (4+ alfanuméricos), 409 con un mensaje que
   * identifica al gasto existente. Usa la columna generada folio_ticket_norm
   * (misma regla que el índice único, que cubre la carrera). Los folios
   * cortos no bloquean: demasiado genéricos — solo llevan el flag blando.
   */
  /**
   * Resuelve el tramo (escala) al que se enlaza un gasto: vuelo dueño y avión
   * CON HERENCIA (`escala.aeronave_id ?? vuelo.aeronave_id`, regla de todo
   * el sistema). Es la misma resolución que `avionDelGasto` aplica al LEER
   * (balance por avión, reparto, Libro Dinero): sellar aquí lo mismo evita
   * que la lista/filtros del panel (aeronave_id crudo) digan otro avión.
   */
  private async resolverTramoGasto(escalaId: string): Promise<TramoGastoRef> {
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, vuelo_id, orden, origen_iata, destino_iata, aeronave_id, aeronave:aeronave!aeronave_id(matricula), vuelo:vuelo!vuelo_id(aeronave_id, aeronave:aeronave!aeronave_id(matricula))',
      )
      .eq('id', escalaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new BadRequestException(
        'La escala (tramo) seleccionada no existe.',
      );
    }
    const propia = data.aeronave as unknown as { matricula: string } | null;
    const vuelo = data.vuelo as unknown as {
      aeronave_id: string | null;
      aeronave: { matricula: string } | null;
    } | null;
    const aeronaveId =
      (data.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null;
    return {
      escala_id: data.id as string,
      vuelo_id: data.vuelo_id as string,
      aeronave_id: aeronaveId,
      matricula: data.aeronave_id
        ? (propia?.matricula ?? null)
        : (vuelo?.aeronave?.matricula ?? null),
      tramo: `${data.origen_iata as string}→${data.destino_iata as string}`,
    };
  }

  /**
   * Aviso ⚠ para notas cuando el usuario manda un avión EXPLÍCITO distinto
   * al que voló el tramo del gasto. No bloquea (puede ser deliberado), pero
   * deja claro que balance/reparto cuentan el gasto al avión del TRAMO
   * (`avionDelGasto`). Null si no hay tramo, no hay avión explícito o
   * coinciden.
   */
  private async avisoAvionDistintoAlTramo(
    aeronaveIdExplicita: string | undefined,
    tramo: TramoGastoRef | null,
  ): Promise<string | null> {
    if (
      !aeronaveIdExplicita ||
      !tramo?.aeronave_id ||
      tramo.aeronave_id === aeronaveIdExplicita
    ) {
      return null;
    }
    const { data: elegida } = await this.supabase.service
      .from('aeronave')
      .select('matricula')
      .eq('id', aeronaveIdExplicita)
      .maybeSingle();
    const matEleg = (elegida?.matricula as string | undefined) ?? 'otro avión';
    const matTramo = tramo.matricula ?? 'otro avión';
    return `${AVISO_AVION_TRAMO_PREFIX}${matEleg} pero el tramo ${tramo.tramo} lo voló ${matTramo}: en balance y reparto cuenta al avión del tramo — revisar`;
  }

  /**
   * CANDADO DE VENTANA anti-reintento (29-ago-2026, auditoría "ya lo había
   * guardado y no está"): SOLO para payloads sin llave de idempotencia y sin
   * folio (APKs viejos). Si el MISMO capturista tiene un gasto IDÉNTICO
   * (vuelo + monto + moneda + categoría + notas normalizadas) creado hace
   * menos de 90 s, el segundo insert es casi seguro el reintento del outbox
   * o un doble tap → 409 con el dato a la vista. Dos gastos reales seguidos
   * (dos taxis iguales) se distinguen cambiando la nota o esperando.
   * Consulta caída = no frenar (best-effort; el candado real futuro es la
   * llave).
   */
  private async assertNoCapturaRepetida(
    dto: CreateGastoDto,
    capturaId: string,
    notasFinales: string | null,
    aeronaveId: string | null,
  ): Promise<void> {
    const desde = new Date(Date.now() - 90_000).toISOString();
    let q = this.supabase.service
      .from('gasto')
      .select('id, created_at, notas')
      .eq('usuario_captura_id', capturaId)
      .eq('categoria', dto.categoria)
      .eq('moneda', dto.moneda)
      .eq('monto', dto.monto)
      .gte('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(5);
    q = dto.vuelo_id ? q.eq('vuelo_id', dto.vuelo_id) : q.is('vuelo_id', null);
    // El avión sellado también debe coincidir (un reintento hereda el mismo):
    // sin esto, una carga masiva con dos aviones al mismo monto chocaría.
    q = aeronaveId
      ? q.eq('aeronave_id', aeronaveId)
      : q.is('aeronave_id', null);
    const { data, error } = await q;
    if (error) return; // best-effort: no frenar capturas por una consulta caída
    const norm = (s: unknown): string =>
      String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const gemelo = (data ?? []).find(
      (g) => norm(g.notas) === norm(notasFinales),
    );
    if (!gemelo) return;
    const segundos = Math.max(
      1,
      Math.round(
        (Date.now() - new Date(gemelo.created_at as string).getTime()) / 1000,
      ),
    );
    this.logger.warn(
      `Captura repetida bloqueada: gasto idéntico ${gemelo.id as string} del mismo capturista hace ${segundos} s (sin client_request_id ni folio).`,
    );
    throw new ConflictException(
      `Parece la misma captura repetida (hace ${segundos} s). Si son dos gastos reales, cambia la nota o espera un momento.`,
    );
  }

  private async assertFolioTicketLibre(
    folio: string | null | undefined,
    excluirId?: string,
  ): Promise<void> {
    const norm = normalizarFolio(folio);
    if (!norm || norm.length < FOLIO_CANDADO_MIN) return;
    let q = this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, monto, moneda, categoria, captura:usuario!usuario_captura_id(nombre)',
      )
      .eq('folio_ticket_norm', norm)
      .limit(1);
    if (excluirId) q = q.neq('id', excluirId);
    const { data, error } = await q;
    // Consulta caída: no frenar aquí — el índice único de la BD es el candado real.
    if (error) return;
    const dup = (data ?? [])[0] as
      | {
          fecha_gasto: string;
          monto: string;
          moneda: string;
          categoria: string;
          captura: { nombre?: string } | { nombre?: string }[] | null;
        }
      | undefined;
    if (!dup) return;
    const cap = Array.isArray(dup.captura) ? dup.captura[0] : dup.captura;
    throw new ConflictException(
      `El folio/remisión "${folio}" ya está capturado: gasto ${etiquetaCategoriaGasto(dup.categoria)} de $${Number(dup.monto).toFixed(2)} ${dup.moneda} con fecha ${dup.fecha_gasto}${cap?.nombre ? ` (capturó ${cap.nombre})` : ''}. Es el mismo pago dos veces — si de verdad es otro ticket, corrige el folio.`,
    );
  }

  private async looksLikeDuplicate(dto: CreateGastoDto): Promise<boolean> {
    const base = new Date(`${dto.fecha_gasto}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return false;
    const dias = dto.proveedor_id ? DUP_DAYS : DUP_DAYS_SIN_PROVEEDOR;
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - dias);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + dias);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    let q = this.supabase.service
      .from('gasto')
      .select('id')
      .eq('moneda', dto.moneda)
      .eq('monto', dto.monto)
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .limit(1);
    q = dto.proveedor_id
      ? q.eq('proveedor_id', dto.proveedor_id)
      : q.eq('categoria', dto.categoria);
    const { data, error } = await q;
    if (error) return false; // la detección no debe bloquear la captura
    return (data ?? []).length > 0;
  }

  /**
   * Sugiere a qué vuelo corresponde una carga de combustible según la
   * aeronave (matrícula) y el momento de la carga:
   *  - si la carga cae dentro de la ventana del vuelo (en ruta) → ese vuelo;
   *  - si no → la SIGUIENTE salida de esa aeronave (la carga de las 6 pm
   *    "previene" el siguiente vuelo, aunque sea días después).
   * Devuelve el sugerido + candidatos cercanos para confirmar/cambiar.
   */
  async sugerirVuelo(aeronaveId: string, fechaHoraIso: string) {
    const t = new Date(fechaHoraIso).getTime();
    if (!Number.isFinite(t)) {
      throw new BadRequestException('fecha_hora inválida (usa ISO 8601)');
    }
    const desde = new Date(t - 7 * 86_400_000).toISOString();
    const hasta = new Date(t + 14 * 86_400_000).toISOString();

    // Los CANCELADOS entran al universo (28-ago): una carga hecha para un
    // vuelo que luego se canceló (o que voló a recoger y regresó ferry) es
    // gasto real de ese vuelo. Abajo NO se proponen como "siguiente salida":
    // un vuelo que ya no va no se "previene".
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, origen_iata, destino_iata, estado, fecha_vuelo, fecha_traslado_final, aeronave_id, escalas:escala(aeronave_id, fecha_salida_plan, hora_salida, hora_llegada)',
      )
      .not('fecha_vuelo', 'is', null)
      .gte('fecha_vuelo', desde)
      .lte('fecha_vuelo', hasta)
      .order('fecha_vuelo', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    interface LegRow {
      aeronave_id: string | null;
      fecha_salida_plan: string | null;
      hora_salida: string | null;
      hora_llegada: string | null;
    }
    const ms = (v: string | null) => (v ? new Date(v).getTime() : null);

    const deAvion = (data ?? [])
      .map((v) => {
        const escalas = ((v.escalas as LegRow[] | null) ?? []).filter(
          (e) =>
            e.aeronave_id === aeronaveId ||
            (e.aeronave_id == null && v.aeronave_id === aeronaveId),
        );
        const esDeAvion = v.aeronave_id === aeronaveId || escalas.length > 0;
        if (!esDeAvion) return null;
        const salidas = escalas
          .map((e) => ms(e.fecha_salida_plan))
          .filter((x): x is number => x != null);
        const llegadas = escalas
          .map((e) => ms(e.hora_llegada))
          .filter((x): x is number => x != null);
        const inicio = salidas.length
          ? Math.min(...salidas)
          : (ms(v.fecha_vuelo as string) ?? t);
        const fin = Math.max(
          ms(v.fecha_traslado_final as string | null) ?? inicio,
          salidas.length ? Math.max(...salidas) : inicio,
          llegadas.length ? Math.max(...llegadas) : inicio,
        );
        return { v, inicio, fin };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const VENTANA_ANTES_MS = 3 * 3_600_000; // carga previa al primer despegue
    const VENTANA_DESPUES_MS = 2 * 3_600_000; // carga justo al cerrar el vuelo

    const toItem = (c: (typeof deAvion)[number]) => ({
      vuelo_id: c.v.id as string,
      folio: c.v.folio as number,
      origen_iata: c.v.origen_iata as string,
      destino_iata: c.v.destino_iata as string,
      estado: c.v.estado as string,
      fecha_vuelo: c.v.fecha_vuelo as string,
    });

    // 1) Carga en ruta: cae dentro de la ventana del vuelo (o va en el aire).
    //    Si un CANCELADO y un vuelo vivo se traslapan (cancelaron el de la
    //    mañana y el avión salió a otro chárter), gana el vivo: el cancelado
    //    solo se sugiere cuando es el único cuya ventana contiene la carga.
    const dentro = (c: (typeof deAvion)[number]) =>
      (t >= c.inicio - VENTANA_ANTES_MS && t <= c.fin + VENTANA_DESPUES_MS) ||
      (c.v.estado === 'EN_VUELO' && t >= c.inicio - VENTANA_ANTES_MS);
    const enRuta =
      deAvion.find((c) => c.v.estado !== 'CANCELADO' && dentro(c)) ??
      deAvion.find(dentro);
    // 2) Previno: la siguiente salida de la aeronave después de la carga.
    //    Un CANCELADO no es una salida por venir (ver arriba); sí puede ser
    //    "en ruta" o "anterior" y siempre aparece entre los candidatos.
    const siguiente = deAvion
      .filter((c) => c.inicio >= t && c.v.estado !== 'CANCELADO')
      .sort((a, b) => a.inicio - b.inicio)[0];
    // 3) Fallback: el vuelo más cercano hacia atrás.
    const anterior = deAvion
      .filter((c) => c.inicio < t)
      .sort((a, b) => b.inicio - a.inicio)[0];

    const elegido = enRuta ?? siguiente ?? anterior ?? null;
    const razon = enRuta
      ? 'EN_RUTA'
      : siguiente
        ? 'SIGUIENTE_SALIDA'
        : anterior
          ? 'VUELO_ANTERIOR'
          : null;

    const candidatos = deAvion
      .slice()
      .sort((a, b) => Math.abs(a.inicio - t) - Math.abs(b.inicio - t))
      .slice(0, 5)
      .map(toItem);

    return {
      sugerido: elegido ? { ...toItem(elegido), razon } : null,
      candidatos,
    };
  }

  /**
   * Permiso TEMPORAL "sin límite de tiempo" (1-sep-2026, caso Luis Cáceres):
   * `usuario.gastos_sin_limite_hasta` (timestamptz) exime al usuario de campo
   * de los candados de TIEMPO de gastos (ventana semanal de edición, candado
   * de captura semanal y candado de reposición de caja chica) mientras
   * `now() < hasta` — p.ej. Luis capturando el fin de semana atrasado el
   * 1-sep. Los candados de PROPIEDAD (solo sus gastos) y de CONCILIADO con el
   * banco se CONSERVAN: el permiso relaja el "cuándo", nunca el "qué".
   * Expira solo (null o pasado = regla normal); la oficina lo pone/renueva
   * directo en la columna. Select puntual sin caché: se consulta solo al
   * capturar/corregir y así la revocación surte efecto inmediato.
   */
  private async sinLimiteVigente(userId: string): Promise<boolean> {
    if (!userId) return false;
    const { data } = await this.supabase.service
      .from('usuario')
      .select('gastos_sin_limite_hasta')
      .eq('id', userId)
      .maybeSingle();
    // Error o sin fila → sin permiso (fail-closed a la regla normal).
    const hasta = data?.gastos_sin_limite_hasta as string | null | undefined;
    if (!hasta) return false;
    const ms = Date.parse(hasta);
    return Number.isFinite(ms) && ms > Date.now();
  }

  /**
   * Regla SEMANAL (audio del equipo, 1-sep-2026 — sustituye la ventana de N
   * días): el CAPTURISTA (piloto/mecánico/visitante) corrige o borra su gasto
   * mientras hoy ≤ domingo de la semana de CAPTURA (lunes→domingo, pared
   * Cancún) + días de gracia (`dias_gracia_gastos_semana`, default 1 = hasta
   * el lunes siguiente; lo capturado en lunes de gracia pertenece a la semana
   * nueva → editable hasta SU lunes) — y solo si aún no está conciliado ni
   * entró ya a una REPOSICIÓN de su caja chica. Después, únicamente oficina.
   * Lanza si no cumple.
   */
  async assertOwnEnVentana(id: string, userId: string): Promise<void> {
    const gasto = await this.findById(id);
    if (gasto.usuario_captura_id !== userId) {
      throw new ForbiddenException(
        'Solo puedes corregir gastos capturados por ti.',
      );
    }
    if (gasto.conciliado === true) {
      throw new ConflictException(
        'Este gasto ya está conciliado con el banco; pide el ajuste a oficina.',
      );
    }
    // Permiso temporal sin límite (caso Luis, 1-sep): salta SOLO los candados
    // de TIEMPO que siguen (reposición de caja chica y semana de edición).
    // Dueño y conciliado ya se validaron arriba y aplican SIEMPRE.
    if (await this.sinLimiteVigente(userId)) return;
    // Candado "ya repuesto" (1-sep): un gasto EFECTIVO cuya fecha quedó
    // cubierta por la ÚLTIMA reposición de la caja chica del capturista ya
    // está saldado — tocarlo descuadraría un corte que ya se pagó, aunque
    // siga dentro de la ventana de días.
    if (gasto.medio_pago === MedioPago.EFECTIVO) {
      const ultima = await this.cajaChica.fechaUltimaReposicionDe(
        gasto.usuario_captura_id as string,
        gasto.moneda as string,
      );
      const diaGasto = String(gasto.fecha_gasto ?? '').slice(0, 10);
      if (ultima && diaGasto && diaGasto <= ultima) {
        throw new ConflictException(
          'Este gasto ya entró a una reposición de tu caja chica; pide el ajuste a oficina.',
        );
      }
    }
    // Semana de edición: la semana (lunes→domingo, pared Cancún) es la de la
    // CAPTURA (created_at) + días de gracia. Cálculo en el helper puro
    // `semana-gastos.util` (patrón en-CA + T12:00:00Z, con spec propio).
    const gracia = graciaSaneada(
      await this.configuracion.numero(CONFIG_DIAS_GRACIA_GASTOS_SEMANA, 1),
    );
    const capturado = diaCancun(gasto.created_at as string);
    if (hoyCancun() > limiteEdicion(capturado, gracia)) {
      throw new ForbiddenException(
        gracia === 1
          ? 'Los gastos solo se corrigen dentro de su semana (hasta el lunes siguiente). Pide el ajuste a oficina.'
          : gracia === 0
            ? 'Los gastos solo se corrigen dentro de su semana (lunes a domingo). Pide el ajuste a oficina.'
            : `Los gastos solo se corrigen dentro de su semana (hasta ${gracia} días después del domingo). Pide el ajuste a oficina.`,
      );
    }
  }

  /**
   * Capturas de CAMPO (piloto/mecánico/visitante): la fecha del gasto no
   * puede estar a más de 120 días atrás ni a más de 1 día a futuro (hora
   * Cancún). La OFICINA tiene su propia banda, más ancha (auditoría 29-ago:
   * dos gastos con año 2025 quedaron fuera de TODOS los cortes): más de
   * 365 días atrás o más de 30 días a futuro se rechaza con 400 — salvo
   * `permitir_fecha_antigua === true` (carga histórica deliberada).
   */
  private assertFechaRazonable(
    fecha: string | undefined,
    rol?: Rol,
    permitirAntigua = false,
  ): void {
    if (!fecha) return;
    const esCampo =
      rol === Rol.PILOTO || rol === Rol.MECANICO || rol === Rol.VISITANTE;
    const hoy = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Cancun',
    });
    const dia = fecha.slice(0, 10);
    const ms = Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`);
    if (!Number.isFinite(ms)) return;
    const dias = Math.round(ms / 86_400_000);
    const bonita = dia.split('-').reverse().join('/');
    if (esCampo) {
      if (dias > 1) {
        throw new BadRequestException(
          `La fecha del gasto (${bonita}) está en el futuro: revísala antes de guardar.`,
        );
      }
      if (dias < -120) {
        throw new BadRequestException(
          `La fecha del gasto (${bonita}) es de hace más de 4 meses: revisa el AÑO del ticket antes de guardar (¿es ${hoy.slice(0, 4)}?).`,
        );
      }
      return;
    }
    // Oficina: banda ancha pero con tope — el "año equivocado" (2025 en un
    // ticket de 2026) es el error real que esconde gastos de los cortes.
    if (permitirAntigua) return;
    if (dias > 30) {
      throw new BadRequestException(
        `La fecha del gasto (${bonita}) está a más de 30 días en el futuro: revisa el AÑO/mes antes de guardar.`,
      );
    }
    if (dias < -365) {
      throw new BadRequestException(
        `La fecha del gasto (${bonita}) es de hace más de un año: casi siempre es el AÑO equivocado del ticket (¿es ${hoy.slice(0, 4)}?). Si de verdad es una carga histórica, marca "permitir fecha antigua".`,
      );
    }
  }

  /**
   * Regla SEMANAL de CAPTURA (audio del equipo, 1-sep-2026): un rol de CAMPO
   * (piloto/mecánico/visitante) solo captura gastos de su semana en curso
   * (lunes→domingo, pared Cancún); en los primeros `dias_gracia_gastos_semana`
   * días de la semana (default 1 = el lunes) todavía acepta la semana pasada.
   * La OFICINA queda exenta (captura de vuelos pasados, cargas masivas e
   * históricas van por ahí). Vive junto a `assertFechaRazonable`: aquella
   * acota el disparate (año equivocado), esta acota la semana operativa.
   * Un permiso temporal `gastos_sin_limite_hasta` vigente (caso Luis, 1-sep)
   * también exenta al capturista de campo mientras dure.
   */
  private async assertCapturaEnSemana(
    fecha: string | undefined,
    rol?: Rol,
    userId?: string,
  ): Promise<void> {
    const esCampo =
      rol === Rol.PILOTO || rol === Rol.MECANICO || rol === Rol.VISITANTE;
    if (!esCampo || !fecha) return;
    const dia = fecha.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return; // formato lo valida el DTO
    // Permiso temporal sin límite: exento del candado semanal mientras dure.
    if (userId && (await this.sinLimiteVigente(userId))) return;
    const gracia = graciaSaneada(
      await this.configuracion.numero(CONFIG_DIAS_GRACIA_GASTOS_SEMANA, 1),
    );
    if (dia < limiteCapturaMin(hoyCancun(), gracia)) {
      throw new BadRequestException(
        gracia === 1
          ? 'Los gastos se capturan dentro de su semana (lunes a domingo). El lunes aún puedes capturar los de la semana pasada; después ya solo los de la semana en curso.'
          : gracia === 0
            ? 'Los gastos se capturan dentro de su semana (lunes a domingo). Los de semanas pasadas los captura la oficina.'
            : `Los gastos se capturan dentro de su semana (lunes a domingo). En los primeros ${gracia} días de la semana aún puedes capturar los de la semana pasada; después ya solo los de la semana en curso.`,
      );
    }
  }

  async update(id: string, dto: UpdateGastoDto, userId: string, rol?: Rol) {
    if (dto.fecha_gasto !== undefined) {
      this.assertFechaRazonable(
        dto.fecha_gasto,
        rol,
        dto.permitir_fecha_antigua === true,
      );
      // Mover la fecha a una semana ya cerrada equivale a capturar en ella:
      // mismo candado semanal que en el alta (oficina exenta y permiso
      // temporal `gastos_sin_limite_hasta` también).
      await this.assertCapturaEnSemana(dto.fecha_gasto, rol, userId);
    }
    if (Object.keys(dto).length === 0) return this.findById(id);
    // Confirmación del panel (28-ago): sellar/retirar es acción EXPLÍCITA
    // del diálogo Verificar; si un rol de CAMPO vuelve a editar su gasto,
    // el sello se LIMPIA (la información cambió: oficina debe re-confirmar).
    const sello: Record<string, unknown> = {};
    if (dto.verificado === true) {
      sello.verificado_por = userId;
      sello.verificado_at = new Date().toISOString();
    } else if (dto.verificado === false) {
      sello.verificado_por = null;
      sello.verificado_at = null;
    } else if (
      rol === Rol.PILOTO ||
      rol === Rol.MECANICO ||
      rol === Rol.VISITANTE
    ) {
      sello.verificado_por = null;
      sello.verificado_at = null;
    }
    delete dto.verificado;
    const necesitaActual =
      dto.propina !== undefined ||
      dto.monto !== undefined ||
      dto.categoria !== undefined ||
      dto.vuelo_id !== undefined ||
      dto.aeronave_id !== undefined ||
      dto.escala_id !== undefined ||
      dto.moneda !== undefined;
    const actual = necesitaActual
      ? ((await this.findById(id)) as {
          monto?: unknown;
          propina?: unknown;
          categoria?: string;
          vuelo_id?: string | null;
          aeronave_id?: string | null;
          escala_id?: string | null;
          moneda?: string;
          notas?: string | null;
        })
      : null;
    // REGLA B (28-ago): el TRAMO manda sobre vuelo y avión del gasto.
    // Quitar el vuelo (null) sin decir nada del tramo también quita el
    // tramo: una escala no vive sin su vuelo. Un tramo (nuevo o ya ligado)
    // sella el vuelo si faltaba y se rechaza si es de OTRO vuelo. La
    // herencia del AVIÓN del tramo se aplica más abajo, pasados los candados
    // (que así ven el vuelo efectivo). El DTO tipa string, pero el panel
    // manda null para "quitar" (IsOptional lo deja pasar): vista con null.
    const dtoNull = dto as {
      vuelo_id?: string | null;
      escala_id?: string | null;
    };
    if (
      dtoNull.vuelo_id === null &&
      dtoNull.escala_id === undefined &&
      actual?.escala_id
    ) {
      dtoNull.escala_id = null;
    }
    const escalaEf: string | null | undefined =
      dtoNull.escala_id !== undefined
        ? dtoNull.escala_id
        : (actual?.escala_id ?? null);
    let tramoRef: TramoGastoRef | null = null;
    // Religar el gasto a OTRO vuelo sin decir nada del tramo (flujo "Asignar
    // vuelo" del panel / sugerencias IA: mandan solo vuelo_id) cuando el
    // gasto traía un tramo del vuelo ANTERIOR: el tramo viejo se LIMPIA solo
    // (una escala no vive fuera de su vuelo) y el avión se re-hereda del
    // vuelo nuevo — antes respondía 400 y la oficina no podía corregir el
    // vuelo desde la bandeja. El 400 se conserva solo cuando el DTO manda
    // EXPLÍCITAMENTE una escala que no es del vuelo efectivo.
    let escalaAutoLimpiada = false;
    if (
      actual &&
      escalaEf &&
      (dto.escala_id !== undefined ||
        dto.vuelo_id !== undefined ||
        dto.aeronave_id !== undefined)
    ) {
      tramoRef = await this.resolverTramoGasto(escalaEf);
      const vueloEf =
        dto.vuelo_id !== undefined ? dto.vuelo_id : (actual.vuelo_id ?? null);
      if (vueloEf && vueloEf !== tramoRef.vuelo_id) {
        if (dto.escala_id !== undefined) {
          throw new BadRequestException(
            `El tramo ${tramoRef.tramo} no pertenece al vuelo del gasto: corrige el vuelo o quita la escala.`,
          );
        }
        dtoNull.escala_id = null;
        tramoRef = null;
        escalaAutoLimpiada = true;
      } else if (!vueloEf) {
        dto.vuelo_id = tramoRef.vuelo_id;
      }
    }
    // Gasto con REPARTO MANUAL (gasto_reparto): mutar monto/categoría/vuelo/
    // moneda reubicaría dinero ya atribuido a aviones en silencio — se exige
    // quitar o corregir el reparto primero (pantalla Otros gastos).
    if (
      dto.monto !== undefined ||
      dto.categoria !== undefined ||
      dto.vuelo_id !== undefined ||
      dto.moneda !== undefined ||
      dto.aeronave_id !== undefined
    ) {
      const repartosDe = await fetchRepartos(this.supabase.service, [id]);
      const filas = repartosDe.get(id);
      if (filas && filas.length > 0) {
        const suma = Math.round(
          filas.reduce((acc, r) => acc + r.monto, 0) * 100,
        );
        if (
          dto.monto !== undefined &&
          Math.round(Number(dto.monto) * 100) < suma
        ) {
          throw new BadRequestException(
            `El gasto está repartido entre aviones por $${(suma / 100).toFixed(2)}: baja o quita el reparto en Otros gastos antes de reducir el monto.`,
          );
        }
        if (
          dto.categoria !== undefined &&
          !CATEGORIAS_REPARTIBLES.has(dto.categoria)
        ) {
          throw new BadRequestException(
            'El gasto está repartido entre aviones: quita el reparto en Otros gastos antes de cambiarlo a esa categoría.',
          );
        }
        if (dto.vuelo_id) {
          throw new BadRequestException(
            'El gasto está repartido entre aviones: quita el reparto en Otros gastos antes de ligarlo a un vuelo.',
          );
        }
        if (dto.moneda !== undefined && dto.moneda !== actual?.moneda) {
          throw new BadRequestException(
            'El gasto está repartido entre aviones (montos en su moneda): quita el reparto antes de cambiar la moneda.',
          );
        }
        if (dto.aeronave_id) {
          throw new BadRequestException(
            'El gasto está repartido entre aviones: el avión individual no aplica — edita el reparto en Otros gastos.',
          );
        }
      }
    }
    // Candado espejo de create(): PERSONAL_DUENO (gasto personal del dueño)
    // jamás lleva vuelo ni avión — se valida el estado EFECTIVO tras el
    // merge (cambiar la categoría hacia PERSONAL con vuelo/avión vivos, o
    // ligar vuelo/avión a un PERSONAL existente, ambos contaminarían
    // balances de la empresa).
    if (
      dto.categoria !== undefined ||
      dto.vuelo_id !== undefined ||
      dto.aeronave_id !== undefined ||
      dto.escala_id !== undefined
    ) {
      const catEf = dto.categoria ?? actual?.categoria;
      const vueloEf =
        dto.vuelo_id !== undefined ? dto.vuelo_id : actual?.vuelo_id;
      const avionEf =
        dto.aeronave_id !== undefined ? dto.aeronave_id : actual?.aeronave_id;
      const escalaEf =
        dto.escala_id !== undefined ? dto.escala_id : actual?.escala_id;
      if (catEf === 'PERSONAL_DUENO' && (vueloEf || avionEf || escalaEf)) {
        throw new BadRequestException(
          'Un gasto personal del dueño no lleva vuelo, avión ni escala: quítalos o usa otra categoría.',
        );
      }
      if (catEf === 'GASOLINA' && (vueloEf || avionEf || escalaEf)) {
        throw new BadRequestException(
          'La gasolina de vehículos no lleva vuelo, avión ni escala (para combustible de aviación usa GAS): quítalos o usa otra categoría.',
        );
      }
      if (catEf === 'VISITA' && (vueloEf || avionEf || escalaEf)) {
        throw new BadRequestException(
          'Un gasto de visita no lleva vuelo, avión ni escala: quítalos o usa otra categoría.',
        );
      }
    }
    // El invariante propina <= monto también vive aquí (el create no basta:
    // un PATCH parcial de solo uno de los dos podría dejar ticket negativo).
    if (dto.propina !== undefined || dto.monto !== undefined) {
      const monto = dto.monto ?? Number(actual?.monto);
      const propina = dto.propina ?? Number(actual?.propina ?? 0);
      if (Number(propina) > Number(monto)) {
        throw new BadRequestException(
          'La propina no puede ser mayor que el monto total pagado.',
        );
      }
    }
    // Mismo candado del create: corregir el folio hacia uno ya capturado
    // también es duplicar el pago (se excluye el propio gasto).
    if (dto.folio_ticket !== undefined) {
      await this.assertFolioTicketLibre(dto.folio_ticket, id);
    }
    // INDIRECTO jamás se liga a un vuelo (regla 18-ago: no es costo de un
    // vuelo; va a la hoja de indirectos). Se valida el estado FUSIONADO:
    // reclasificar a INDIRECTO un gasto con vuelo, o ligar vuelo a un
    // INDIRECTO, se rechaza con instrucción clara.
    if (dto.categoria !== undefined || dto.vuelo_id !== undefined) {
      const categoriaEfectiva = dto.categoria ?? actual?.categoria;
      const vueloEfectivo =
        dto.vuelo_id !== undefined ? dto.vuelo_id : actual?.vuelo_id;
      if (categoriaEfectiva === 'INDIRECTO' && vueloEfectivo) {
        throw new BadRequestException(
          'Un gasto INDIRECTO no se liga a un vuelo: quítale el vuelo primero (o usa otra categoría).',
        );
      }
      // NOMINA (29-ago): espejo de INDIRECTO — sin vuelo (avión opcional).
      if (categoriaEfectiva === 'NOMINA' && vueloEfectivo) {
        throw new BadRequestException(
          'Un gasto de NÓMINA no se liga a un vuelo: quítale el vuelo primero (o usa otra categoría).',
        );
      }
      // SERVICIOS (29-ago): gasto del AVIÓN sin vuelo (avión permitido).
      if (categoriaEfectiva === 'SERVICIOS' && vueloEfectivo) {
        throw new BadRequestException(
          'Un gasto de SERVICIOS no se liga a un vuelo (es del avión): quítale el vuelo primero (o usa otra categoría).',
        );
      }
    }

    // El combustible se controla POR AVIÓN: quitarle el avión (o cambiar a
    // GAS un gasto sin avión) lo dejaría fuera del balance y del reparto.
    if (dto.categoria !== undefined || dto.aeronave_id !== undefined) {
      const categoriaEf = dto.categoria ?? actual?.categoria;
      const aeronaveEf =
        dto.aeronave_id !== undefined ? dto.aeronave_id : actual?.aeronave_id;
      const vueloEf =
        dto.vuelo_id !== undefined ? dto.vuelo_id : actual?.vuelo_id;
      if (categoriaEf === 'GAS' && !aeronaveEf && !vueloEf) {
        throw new BadRequestException(
          'La carga de combustible necesita el avión: asigna la aeronave antes de quitarla.',
        );
      }
    }
    // Herencia tramo/vuelo→avión también por PATCH (el flujo "Asignar
    // vuelo" del panel no sellaba el avión y la carga seguía invisible para
    // el reparto). Misma prioridad que create()/`avionDelGasto`:
    //  - con TRAMO: el avión del tramo (`escala.aeronave_id ??
    //    vuelo.aeronave_id`) se sella al cambiar de tramo, al ligar vuelo o
    //    si el gasto no tenía avión — un avión explícito del usuario se
    //    respeta (con aviso ⚠ abajo si difiere del tramo);
    //  - solo VUELO: el avión del vuelo cuando el gasto no tenía avión.
    let aeronaveHeredada: string | null = null;
    if (actual && dto.aeronave_id === undefined) {
      if (
        tramoRef?.aeronave_id &&
        (dto.escala_id !== undefined || dto.vuelo_id || !actual.aeronave_id)
      ) {
        aeronaveHeredada = tramoRef.aeronave_id;
      } else if (
        !tramoRef &&
        dto.vuelo_id &&
        // Tramo auto-limpiado: el avión sellado venía del tramo VIEJO — se
        // re-hereda del vuelo nuevo aunque el gasto ya tuviera avión.
        (escalaAutoLimpiada || !actual.aeronave_id)
      ) {
        const { data: vueloRef } = await this.supabase.service
          .from('vuelo')
          .select('aeronave_id')
          .eq('id', dto.vuelo_id)
          .maybeSingle();
        aeronaveHeredada = (vueloRef?.aeronave_id as string | null) ?? null;
      }
    }
    // Aviso contra el avión EFECTIVO tras el merge (explícito del DTO →
    // heredado → el que ya tenía el gasto): así el aviso siempre es
    // verdadero — los lectores cuentan el gasto al avión del tramo
    // (`avionDelGasto`) y esto lo dice cuando difiere.
    const avionEfectivo =
      dto.aeronave_id !== undefined
        ? (dto.aeronave_id ?? undefined)
        : (aeronaveHeredada ?? actual?.aeronave_id ?? undefined);
    const avisoTramo = await this.avisoAvionDistintoAlTramo(
      avionEfectivo,
      tramoRef,
    );

    // Campos del DTO que NO son columna de gasto: reventarían el UPDATE.
    const cols: Record<string, unknown> = { ...dto };
    delete cols.capturar_como_piloto;
    delete cols.leer_con_ia;
    delete cols.permitir_fecha_antigua;
    // La llave de idempotencia se fija SOLO al crear: reescribirla en un
    // PATCH podría colisionar con otra captura o robarle su llave.
    delete cols.client_request_id;
    if (aeronaveHeredada) cols.aeronave_id = aeronaveHeredada;
    else if (escalaAutoLimpiada && dto.aeronave_id === undefined) {
      // El vuelo nuevo no tiene avión (externo sin referencia): el avión
      // sellado por el tramo viejo ya no aplica (libro EXTERNOS).
      cols.aeronave_id = null;
    }
    // Aviso ⚠ avión ≠ tramo: UNA sola vez y sin apilar — se retira cualquier
    // aviso anterior del mismo tipo (otro avión, otro tramo, tramo ya
    // limpiado) antes de poner el vigente; repetir el PATCH no cambia nada.
    // También al QUITAR el tramo (escala_id: null) o DESLIGAR el vuelo
    // (vuelo_id: null → el tramo se limpia arriba): sin tramo el aviso es
    // falso y se quedaba pegado (verificación 28-ago).
    const tramoQuitado =
      dtoNull.escala_id === null || dtoNull.vuelo_id === null;
    if (avisoTramo || tramoRef !== null || escalaAutoLimpiada || tramoQuitado) {
      const notasBase =
        dto.notas !== undefined ? dto.notas : (actual?.notas ?? null);
      const sinAvisoViejo = quitarAvisoAvionTramo(notasBase);
      const notasNuevas = avisoTramo
        ? sinAvisoViejo
          ? `${sinAvisoViejo}\n${avisoTramo}`
          : avisoTramo
        : sinAvisoViejo;
      if ((notasNuevas ?? null) !== (notasBase ?? null)) {
        cols.notas = notasNuevas;
      }
    }
    if (dto.folio_ticket !== undefined) {
      cols.folio_ticket = dto.folio_ticket?.trim() || null;
    }
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({ ...cols, ...sello, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      if (error.code === '23505')
        throw new ConflictException(
          `Ya existe un gasto con el folio/remisión "${dto.folio_ticket}": es el mismo pago capturado dos veces. Si de verdad es otro ticket, corrige el folio.`,
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  async remove(id: string, userId: string, rol?: Rol) {
    // Un gasto conciliado está amarrado a un movimiento bancario (FK con
    // set null): borrarlo dejaría el movimiento "conciliado" apuntando a
    // nada y la conciliación se sobreestimaría en silencio.
    const gasto = await this.findById(id);
    if (gasto.conciliado === true) {
      throw new ConflictException(
        'Este gasto ya está conciliado con el banco; desconcíliaselo en Conciliación antes de eliminarlo.',
      );
    }
    // PAGO de una compra de refacciones (28-ago): la FK es `set null`, así
    // que borrarlo dejaría la compra sin ese pago EN SILENCIO (su costo
    // prorrateado en bodega ya no cuadraría con nada). Se desliga primero
    // desde Compras, con intención.
    const compraId = (gasto.compra_id as string | null) ?? null;
    if (compraId) {
      const { data: compra } = await this.supabase.service
        .from('compra')
        .select('folio')
        .eq('id', compraId)
        .maybeSingle();
      const folio = (compra as { folio?: number } | null)?.folio;
      throw new ConflictException(
        `Este gasto es un pago de la compra #${folio ?? '?'} de refacciones; quítalo primero desde Compras.`,
      );
    }
    // Gasto REPARTIDO entre aviones: el reparto es acto de oficina — el
    // piloto/mecánico no puede tirar la atribución de N aviones al borrar su
    // captura (cascade); la oficina sí puede y se le informa en la respuesta.
    const repartosDel = await fetchRepartos(this.supabase.service, [id]);
    const filasReparto = repartosDel.get(id) ?? [];
    if (
      filasReparto.length > 0 &&
      (rol === Rol.PILOTO || rol === Rol.MECANICO || rol === Rol.VISITANTE)
    ) {
      throw new ConflictException(
        'La oficina ya repartió este gasto entre aviones: pídeles a ellos eliminarlo o corregirlo.',
      );
    }
    // Atribución del borrado en la bitácora (1-sep): el trigger de BD toma
    // OLD.updated_by como actor del DELETE, así que se sella ANTES de borrar.
    // Ese update tiene diff de negocio vacío → el trigger NO inserta fila.
    const { error: selloErr } = await this.supabase.service
      .from('gasto')
      .update({ updated_by: userId })
      .eq('id', id);
    if (selloErr) throw new Error(selloErr.message);
    const { error } = await this.supabase.service
      .from('gasto')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return {
      deleted: true,
      id,
      reparto_eliminado:
        filasReparto.length > 0 ? filasReparto.length : undefined,
    };
  }

  // ===== Reparto MANUAL de gastos generales entre aviones (26-ago-2026) ====

  /**
   * Gastos GENERALES del periodo (sin vuelo, categorías OTRO/FIJO/
   * INDIRECTO/GASOLINA/VISITA)
   * con su reparto embebido + resumen del mes: total, asignado a aviones y
   * gasto de la EMPRESA VuelaTour (remanentes + no asignados), por moneda.
   * Alimenta la pantalla "Otros gastos".
   */
  async listOtrosGastos(desdeQ?: string, hastaQ?: string) {
    // Default: mes corriente en hora Cancún (mismo helper que el balance).
    const hoy = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [y, m] = hoy.split('-').map(Number);
    const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const desde = desdeQ ?? `${hoy.slice(0, 7)}-01`;
    const hasta =
      hastaQ ?? `${hoy.slice(0, 7)}-${String(fin).padStart(2, '0')}`;
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(LIST_COLS)
      .is('vuelo_id', null)
      // NOMINA (29-ago) se administra aquí como los indirectos; SERVICIOS
      // no: es gasto directo del avión (vive en el tablero normal).
      .in('categoria', [
        'OTRO',
        'FIJO',
        'INDIRECTO',
        'NOMINA',
        'GASOLINA',
        'VISITA',
      ])
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta)
      .order('fecha_gasto', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    const gastos = (data ?? []) as Array<Record<string, unknown>>;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const resumen = new Map<
      string,
      { total: number; asignado: number; empresa: number }
    >();
    for (const g of gastos) {
      const moneda = (g.moneda as string) ?? 'MXN';
      const acc = resumen.get(moneda) ?? { total: 0, asignado: 0, empresa: 0 };
      const monto = Number(g.monto ?? 0);
      const filas = (g.repartos as Array<{ monto: unknown }> | null) ?? [];
      const sumaReparto = filas.reduce((a, r) => a + Number(r.monto), 0);
      // Asignado = reparto manual; sin reparto, un gasto con avión propio
      // cuenta entero a ese avión (comportamiento clásico); sin nada =
      // empresa completa.
      const asignado =
        filas.length > 0
          ? Math.min(sumaReparto, monto)
          : g.aeronave_id
            ? monto
            : 0;
      acc.total += monto;
      acc.asignado += asignado;
      acc.empresa += Math.max(0, monto - asignado);
      resumen.set(moneda, acc);
    }
    return {
      periodo: { desde, hasta },
      data: gastos,
      resumen: [...resumen.entries()].map(([moneda, v]) => ({
        moneda,
        total: r2(v.total),
        asignado_aviones: r2(v.asignado),
        empresa: r2(v.empresa),
      })),
    };
  }

  /** Reparto actual de un gasto (items + suma + remanente de empresa). */
  async getReparto(gastoId: string) {
    const gasto = (await this.findById(gastoId)) as Record<string, unknown>;
    const { data, error } = await this.supabase.service
      .from('gasto_reparto')
      .select('aeronave_id, monto, aeronave:aeronave_id(matricula)')
      .eq('gasto_id', gastoId)
      .order('monto', { ascending: false });
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((r) => ({
      aeronave_id: r.aeronave_id as string,
      monto: Number(r.monto),
      matricula:
        (
          (Array.isArray(r.aeronave) ? r.aeronave[0] : r.aeronave) as {
            matricula?: string;
          } | null
        )?.matricula ?? null,
    }));
    const suma = Math.round(items.reduce((a, i) => a + i.monto, 0) * 100) / 100;
    const monto = Number(gasto.monto ?? 0);
    return {
      gasto: {
        id: gasto.id,
        categoria: gasto.categoria,
        monto,
        moneda: gasto.moneda,
        fecha_gasto: gasto.fecha_gasto,
        notas: gasto.notas,
      },
      items,
      suma,
      remanente_empresa: Math.round((monto - suma) * 100) / 100,
    };
  }

  /**
   * Reemplaza el reparto completo de un gasto (idempotente: upsert de los
   * aviones vigentes + borrado de los que salieron — nunca hay estado
   * intermedio vacío). items = [] limpia el reparto (el gasto vuelve a ser
   * 100% de la empresa, o de su avión propio si lo tiene).
   * Candados: solo gastos SIN vuelo de categorías repartibles
   * (OTRO/FIJO/INDIRECTO/NOMINA/GASOLINA/VISITA);
   * montos > 0 en la MONEDA del gasto; aviones sin repetir;
   * Σ montos <= gasto.monto (a centavos). El remanente se DERIVA, jamás se
   * persiste.
   */
  async putReparto(
    gastoId: string,
    items: Array<{ aeronave_id: string; monto: number }>,
    userId: string,
  ) {
    const gasto = (await this.findById(gastoId)) as Record<string, unknown>;
    await this.reemplazarRepartoDeGasto(gasto, items, userId);
    return this.getReparto(gastoId);
  }

  /**
   * Núcleo del reemplazo de reparto de UN gasto (candados + escritura).
   * Lo comparten putReparto y putRepartoMasivo: los candados viven aquí y
   * SOLO aquí (categoría repartible, sin vuelo, aviones activos sin repetir,
   * Σ ≤ monto, reemplazo sin estado intermedio, limpieza de aeronave_id).
   */
  private async reemplazarRepartoDeGasto(
    gasto: Record<string, unknown>,
    items: Array<{ aeronave_id: string; monto: number }>,
    userId: string,
  ) {
    const gastoId = gasto.id as string;
    if (gasto.vuelo_id) {
      throw new BadRequestException(
        'Este gasto está ligado a un vuelo: su avión se controla por el vuelo, no por reparto manual.',
      );
    }
    if (!CATEGORIAS_REPARTIBLES.has(gasto.categoria as string)) {
      throw new BadRequestException(
        'Solo los gastos generales (OTRO, FIJO, INDIRECTO, NOMINA, GASOLINA, VISITA) se reparten entre aviones.',
      );
    }
    const ids = items.map((i) => i.aeronave_id);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Hay un avión repetido en el reparto: junta sus montos en una sola línea.',
      );
    }
    const sumaCents = items.reduce((a, i) => a + Math.round(i.monto * 100), 0);
    const montoCents = Math.round(Number(gasto.monto ?? 0) * 100);
    if (sumaCents > montoCents) {
      throw new BadRequestException(
        `El reparto suma $${(sumaCents / 100).toFixed(2)} y el gasto es de $${(
          montoCents / 100
        ).toFixed(
          2,
        )} ${gasto.moneda as string}: ajusta los montos (lo no asignado queda como gasto de VuelaTour).`,
      );
    }
    const sb = this.supabase.service;
    // Solo aviones ACTIVOS: un parcial hacia un avión inactivo restaría CERO
    // veces (el reparto a socios solo enumera activos) sin ser empresa —
    // dinero invisible (verificación 26-ago).
    if (ids.length > 0) {
      const { data: activas, error: actErr } = await sb
        .from('aeronave')
        .select('id')
        .in('id', ids)
        .eq('activa', true);
      if (actErr) throw new Error(actErr.message);
      const okIds = new Set((activas ?? []).map((a) => a.id as string));
      const malas = ids.filter((i) => !okIds.has(i));
      if (malas.length > 0) {
        throw new BadRequestException(
          'Alguna aeronave del reparto no existe o está inactiva: solo se reparte entre aviones activos.',
        );
      }
    }
    // Reemplazo sin estado intermedio vacío: UPDATE de las filas que siguen
    // (conserva created_by original), INSERT de las nuevas (sella created_by)
    // y DELETE de las que salieron.
    const { data: previas, error: prevErr } = await sb
      .from('gasto_reparto')
      .select('aeronave_id')
      .eq('gasto_id', gastoId);
    if (prevErr) throw new Error(prevErr.message);
    const previasIds = new Set(
      (previas ?? []).map((p) => p.aeronave_id as string),
    );
    for (const item of items) {
      const monto = Math.round(item.monto * 100) / 100;
      if (previasIds.has(item.aeronave_id)) {
        const { error: upErr } = await sb
          .from('gasto_reparto')
          .update({ monto, updated_by: userId })
          .eq('gasto_id', gastoId)
          .eq('aeronave_id', item.aeronave_id);
        if (upErr) throw new Error(upErr.message);
      } else {
        const { error: insErr } = await sb.from('gasto_reparto').insert({
          gasto_id: gastoId,
          aeronave_id: item.aeronave_id,
          monto,
          created_by: userId,
          updated_by: userId,
        });
        if (insErr) {
          if (insErr.code === '23503')
            throw new BadRequestException(
              'Alguna aeronave del reparto no existe.',
            );
          throw new Error(insErr.message);
        }
      }
    }
    const del = sb.from('gasto_reparto').delete().eq('gasto_id', gastoId);
    const { error: delErr } = await (ids.length > 0
      ? del.not('aeronave_id', 'in', `(${ids.join(',')})`)
      : del);
    if (delErr) throw new Error(delErr.message);
    // El reparto SUSTITUYE al avión único: limpiar gasto.aeronave_id evita
    // el chip confuso "avión clásico + reparto" (los lectores igual ignoran
    // aeronave_id cuando hay reparto — esto es solo claridad de UI).
    if (items.length > 0 && gasto.aeronave_id) {
      await sb
        .from('gasto')
        .update({ aeronave_id: null, updated_by: userId })
        .eq('id', gastoId);
    }
  }

  /**
   * REPARTO MASIVO: aplica el MISMO reparto porcentual a varios gastos
   * generales de una vez (reemplaza el reparto vigente de cada uno).
   * Porcentaje → centavos por gasto con `repartirPorcentajeCents`
   * (centésimas de punto ENTERAS + residuo por mayor resto: con Σ = 100 %
   * cada gasto queda repartido al centavo exacto). Procesa TODOS los gastos
   * y reporta éxitos vs errores por gasto (patrón carga masiva de
   * combustibles): un gasto inválido no tumba el lote ni se omite en
   * silencio. Una línea que cae a $0.00 (porcentaje chico × monto chico)
   * manda el gasto a errores — el CHECK monto>0 de gasto_reparto no admite
   * ceros y omitir la línea callado mentiría el reparto pedido.
   */
  async putRepartoMasivo(
    dto: {
      gasto_ids: string[];
      items: Array<{ aeronave_id: string; porcentaje: number }>;
    },
    userId: string,
  ) {
    const avionIds = dto.items.map((i) => i.aeronave_id);
    if (new Set(avionIds).size !== avionIds.length) {
      throw new BadRequestException(
        'Hay un avión repetido en el reparto: junta sus porcentajes en una sola línea.',
      );
    }
    // Σ porcentajes ≤ 100.00 en CENTÉSIMAS enteras (nunca sumar floats:
    // 33.33+33.33+33.34 en float no da 100 exacto).
    const centesimas = dto.items.map((i) => Math.round(i.porcentaje * 100));
    const totalCentesimas = centesimas.reduce((a, c) => a + c, 0);
    if (totalCentesimas > 10000) {
      throw new BadRequestException(
        `Los porcentajes suman ${(totalCentesimas / 100).toFixed(2)}% y el máximo es 100.00%: ajusta las líneas (lo no asignado queda como gasto de VuelaTour).`,
      );
    }
    // Aviones ACTIVOS validados UNA vez para todo el lote (mismo candado que
    // el reparto individual, que igual lo re-verifica por gasto).
    const sb = this.supabase.service;
    const { data: activas, error: actErr } = await sb
      .from('aeronave')
      .select('id')
      .in('id', avionIds)
      .eq('activa', true);
    if (actErr) throw new Error(actErr.message);
    const okIds = new Set((activas ?? []).map((a) => a.id as string));
    if (avionIds.some((i) => !okIds.has(i))) {
      throw new BadRequestException(
        'Alguna aeronave del reparto no existe o está inactiva: solo se reparte entre aviones activos.',
      );
    }
    const gastoIds = [...new Set(dto.gasto_ids)];
    const { data: gastosData, error: gErr } = await sb
      .from('gasto')
      .select('id, vuelo_id, categoria, monto, moneda, aeronave_id')
      .in('id', gastoIds);
    if (gErr) throw new Error(gErr.message);
    const porId = new Map(
      ((gastosData ?? []) as Array<Record<string, unknown>>).map((g) => [
        g.id as string,
        g,
      ]),
    );
    const errores: Array<{ gasto_id: string; error: string }> = [];
    let exitos = 0;
    const porcentajes = dto.items.map((i) => i.porcentaje);
    for (const gastoId of gastoIds) {
      const gasto = porId.get(gastoId);
      if (!gasto) {
        errores.push({ gasto_id: gastoId, error: 'El gasto no existe.' });
        continue;
      }
      const montoCents = Math.round(Number(gasto.monto ?? 0) * 100);
      const partes = repartirPorcentajeCents(montoCents, porcentajes);
      const lineaCero = partes.findIndex((c) => c <= 0);
      if (lineaCero >= 0) {
        errores.push({
          gasto_id: gastoId,
          error: `El ${dto.items[lineaCero].porcentaje}% de $${(
            montoCents / 100
          ).toFixed(
            2,
          )} ${(gasto.moneda as string) ?? ''} queda en $0.00: este gasto necesita reparto manual.`,
        });
        continue;
      }
      const items = dto.items.map((i, idx) => ({
        aeronave_id: i.aeronave_id,
        monto: partes[idx] / 100,
      }));
      try {
        await this.reemplazarRepartoDeGasto(gasto, items, userId);
        exitos += 1;
      } catch (err) {
        errores.push({
          gasto_id: gastoId,
          error:
            err instanceof BadRequestException
              ? err.message
              : err instanceof Error
                ? err.message
                : 'No se pudo aplicar el reparto.',
        });
      }
    }
    this.logger.log(
      `Reparto masivo: ${exitos} gastos repartidos, ${errores.length} con error (usuario ${userId})`,
    );
    return { procesados: gastoIds.length, exitos, errores };
  }
}
