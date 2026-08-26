import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ExpirationsService } from '../expirations/expirations.service';
import {
  PyservicesService,
  type BitacoraTacoFilaPayload,
} from '../pyservices/pyservices.service';
import type { ListAeronavesQuery } from './dto/list-aeronaves.query';
import type { CreateAeronaveDto } from './dto/create-aeronave.dto';
import type { UpdateAeronaveDto } from './dto/update-aeronave.dto';
import type {
  CreateAeronaveSocioDto,
  UpdateAeronaveSocioDto,
} from './dto/upsert-aeronave-socio.dto';
import type {
  CreateAeronaveImagenDto,
  UpdateAeronaveImagenDto,
} from './dto/aeronave-imagen.dto';
import type {
  CreateAeronaveSeguroDto,
  UpdateAeronaveSeguroDto,
} from './dto/upsert-aeronave-seguro.dto';
import type {
  CreateDiscrepanciaDto,
  UpdateDiscrepanciaDto,
} from './dto/upsert-aeronave-discrepancia.dto';

const AERONAVE_COLS =
  'id, matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, permiso_afac_usd_hr, color_calendario, ubicacion_base, activa, notas, servicio_intervalos, servicio_horas_base, planeador_horas_base, planeador_taco_ref, created_at, updated_at';

const ETAPA_COLS = 'id, intervalo_hr, nombre, tareas';

const SEGURO_COLS =
  'id, aeronave_id, aseguradora, num_poliza, cobertura, suma_asegurada_usd, prima_usd, vigente_desde, vigente_hasta, archivo_url, notas, created_at, updated_at';

const DISCREPANCIA_COLS =
  'id, aeronave_id, vuelo_id, descripcion, severidad, estado, reportado_por, fecha_reporte, resolucion, fecha_resolucion, resuelto_por, notas, created_at, updated_at';

const IMAGEN_COLS =
  'id, aeronave_id, storage_path, url, alt_text, orden, es_principal, etiqueta, size_bytes, content_type, created_at, updated_at';

const IMAGENES_BUCKET = 'aeronave-imagenes';

@Injectable()
export class AircraftService {
  private readonly logger = new Logger(AircraftService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly expirations: ExpirationsService,
    private readonly pyservices: PyservicesService,
  ) {}

  /**
   * Métricas operativas del avión para el expediente:
   *  - airworthiness ("apto para volar"): documentos críticos vencidos +
   *    servicio en taller + componentes con TBO agotado.
   *  - utilización: horas voladas y # de vuelos (mes / año / total).
   *  - finanzas: ingresos cobrados vs gastos por moneda.
   */
  async aircraftMetrics(id: string) {
    const aeronave = await this.findById(id);
    // Cortes de mes/año SIEMPRE en hora Cancún (regla del repo): con Date.UTC
    // un vuelo de las 7–11pm Cancún del último día del mes caía al mes
    // siguiente. Se normaliza a ISO UTC para comparar contra timestamptz.
    const [yyyy, mm] = this.hoyCancun().split('-');
    const startMonth = new Date(
      `${yyyy}-${mm}-01T00:00:00-05:00`,
    ).toISOString();
    const startYear = new Date(`${yyyy}-01-01T00:00:00-05:00`).toISOString();

    const [
      motorsRes,
      helicesMetRes,
      segurosMetRes,
      tallerRes,
      blocking,
      escalas,
      cobrosRes,
      gastosRes,
      squawksRes,
      enVueloRes,
    ] = await Promise.all([
      this.supabase.service
        .from('motor')
        .select(
          'posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .eq('aeronave_id', id),
      // Las hélices también agotan TBO (llevan turm desde ago 2026): antes el
      // semáforo solo revisaba motores y una hélice vencida quedaba en verde.
      this.supabase.service
        .from('helice')
        .select(
          'posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .eq('aeronave_id', id),
      this.supabase.service
        .from('aeronave_seguro')
        .select('vigente_hasta')
        .eq('aeronave_id', id),
      this.supabase.service
        .from('mantenimiento')
        .select('id')
        .eq('aeronave_id', id)
        .eq('estado', 'EN_TALLER')
        .limit(1),
      this.expirations.findBlockingExpirations({ aeronaveId: id }),
      // Asignación por tramo (misma regla que horasVoladas/currentHobbs):
      // filtrar solo por vuelo.aeronave_id atribuía horas de tramos volados
      // en OTRO avión (redondos con ida/regreso en aviones distintos).
      this.escalasDelAvion(
        id,
        'taco_salida, taco_llegada, vuelo:vuelo_id!inner(id, aeronave_id, fecha_vuelo, estado)',
      ),
      this.supabase.service
        .from('cobro_vuelo')
        .select('monto, moneda, vuelo:vuelo_id!inner(aeronave_id, estado)')
        .eq('vuelo.aeronave_id', id)
        .neq('vuelo.estado', 'CANCELADO'),
      this.supabase.service
        .from('gasto')
        .select('monto, moneda')
        .eq('aeronave_id', id),
      // Squawk ALTA sin resolver = avión no apto — MISMO criterio que el
      // candado de asignación (flights.service.validateAssignTargets):
      // BAJA/MEDIA no bloquean.
      this.supabase.service
        .from('aeronave_discrepancia')
        .select('id, descripcion')
        .eq('aeronave_id', id)
        .neq('estado', 'RESUELTA')
        .eq('severidad', 'ALTA'),
      this.supabase.service
        .from('vuelo')
        .select('id')
        .eq('aeronave_id', id)
        .eq('estado', 'EN_VUELO')
        .limit(1),
    ]);
    if (motorsRes.error) throw new Error(motorsRes.error.message);
    if (helicesMetRes.error) throw new Error(helicesMetRes.error.message);
    if (segurosMetRes.error) throw new Error(segurosMetRes.error.message);
    if (tallerRes.error) throw new Error(tallerRes.error.message);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    if (squawksRes.error) throw new Error(squawksRes.error.message);
    if (enVueloRes.error) throw new Error(enVueloRes.error.message);

    const enTaller = (tallerRes.data ?? []).length > 0;

    // Utilización: suma de horas (taco_llegada - taco_salida) y # de vuelos.
    let horasTotal = 0;
    let horasMes = 0;
    let horasAnio = 0;
    // Último horómetro conocido (horas de vida vivas); null = sin tacos aún.
    let maxHobbs: number | null = null;
    const vuelosTotal = new Set<string>();
    const vuelosMes = new Set<string>();
    const vuelosAnio = new Set<string>();
    for (const e of escalas) {
      if (e.taco_salida != null)
        maxHobbs = Math.max(maxHobbs ?? 0, Number(e.taco_salida));
      if (e.taco_llegada != null)
        maxHobbs = Math.max(maxHobbs ?? 0, Number(e.taco_llegada));
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      const v = e.vuelo as { id: string; fecha_vuelo: string | null };
      horasTotal += h;
      vuelosTotal.add(v.id);
      if (v.fecha_vuelo) {
        const f = new Date(v.fecha_vuelo).toISOString();
        if (f >= startYear) {
          horasAnio += h;
          vuelosAnio.add(v.id);
        }
        if (f >= startMonth) {
          horasMes += h;
          vuelosMes.add(v.id);
        }
      }
    }

    // Componentes con overhaul agotado (TBO), usando horas de vida VIVAS.
    // Motores Y hélices: ambos vencen TBO y ambos ponen el avión NO APTO.
    const componentesVencidos = [
      ...(motorsRes.data ?? []).map((m: Record<string, unknown>) => ({
        tipo: 'Motor',
        posicion: m.posicion as string,
        numero_serie: m.numero_serie as string,
        restantes:
          this.componenteEstado(m, maxHobbs ?? 0, true).tbo_restante ?? 1,
      })),
      ...(helicesMetRes.data ?? []).map((h: Record<string, unknown>) => ({
        tipo: 'Hélice',
        posicion: h.posicion as string,
        numero_serie: h.numero_serie as string,
        restantes:
          this.componenteEstado(h, maxHobbs ?? 0, true).tbo_restante ?? 1,
      })),
    ].filter((c) => c.restantes <= 0);

    // Póliza de seguro: si el avión tiene pólizas y TODAS vencieron, no
    // está asegurado (misma regla que el listado).
    const hoyPoliza = this.hoyCancun();
    const ultimaVigencia = (segurosMetRes.data ?? [])
      .map((s) => (s.vigente_hasta as string | null) ?? '')
      .sort()
      .at(-1);
    const polizaVencida = !!ultimaVigencia && ultimaVigencia < hoyPoliza;

    // Discrepancias (squawks) ALTA sin resolver: bloquean el apto igual que
    // bloquean asignar el avión a un vuelo.
    const discrepanciasAltas = (
      (squawksRes.data ?? []) as Array<Record<string, unknown>>
    ).map((s) => ({
      id: s.id as string,
      descripcion: ((s.descripcion as string | null) ?? '').slice(0, 60),
    }));

    // Finanzas por moneda: ingresos cobrados vs gastos.
    const byMoneda = new Map<string, { ingresos: number; gastos: number }>();
    const bump = (
      moneda: string,
      key: 'ingresos' | 'gastos',
      monto: number,
    ) => {
      const cur = byMoneda.get(moneda) ?? { ingresos: 0, gastos: 0 };
      cur[key] += monto;
      byMoneda.set(moneda, cur);
    };
    for (const c of (cobrosRes.data ?? []) as Array<Record<string, unknown>>) {
      bump(c.moneda as string, 'ingresos', Number(c.monto));
    }
    for (const g of (gastosRes.data ?? []) as Array<Record<string, unknown>>) {
      bump(g.moneda as string, 'gastos', Number(g.monto));
    }
    const finanzas = [...byMoneda.entries()].map(([moneda, v]) => ({
      moneda,
      ingresos: v.ingresos,
      gastos: v.gastos,
      utilidad: v.ingresos - v.gastos,
    }));

    // Razones dinámicas del semáforo (el panel las pinta tal cual).
    const razones: string[] = [];
    if (enTaller) razones.push('Servicio en taller');
    for (const b of blocking)
      razones.push(`Documento vencido: ${b.tipo_nombre}`);
    for (const c of componentesVencidos)
      razones.push(`TBO agotado: ${c.tipo} ${c.posicion} (${c.numero_serie})`);
    for (const s of discrepanciasAltas)
      razones.push(`Discrepancia ALTA sin resolver: ${s.descripcion}`);
    if (polizaVencida)
      razones.push(`Póliza de seguro vencida (${ultimaVigencia})`);

    // Próximo servicio por horas: MISMA regla que tacometroHistorial
    // (this.proximoServicio sobre el programa cíclico del avión), enriquecida
    // con las tareas de la(s) etapa(s) del hito.
    const intervalos = ((aeronave.servicio_intervalos as unknown[]) ?? []).map(
      Number,
    );
    const baseServicio = Number(aeronave.servicio_horas_base ?? 0);
    const etapasServicio = await this.etapasDeServicio(id);
    const prox = this.proximoServicioDetallado(
      intervalos,
      baseServicio,
      maxHobbs ?? 0,
      etapasServicio,
    );

    return {
      airworthiness: {
        apto: razones.length === 0,
        documentos_vencidos: blocking,
        en_taller: enTaller,
        componentes_vencidos: componentesVencidos,
        discrepancias_altas: discrepanciasAltas,
        poliza_vencida: polizaVencida,
        razones,
      },
      // Estado de HOY (contrato acordado con el panel: estos nombres exactos).
      horas_actuales: maxHobbs != null ? Number(maxHobbs.toFixed(1)) : null,
      tiempo_total_planeador:
        maxHobbs != null ? this.tiempoTotalPlaneador(aeronave, maxHobbs) : null,
      en_vuelo: (enVueloRes.data ?? []).length > 0,
      proximo_servicio: prox
        ? {
            titulo: prox.nombre ?? `Servicio de ${prox.intervalo} hr`,
            horas_objetivo: prox.a_las,
            faltan_hr: prox.faltan,
            tareas: prox.tareas,
          }
        : null,
      // Distingue "sin programa capturado" de "sin datos": sin esto el KPI
      // mostraba "—" y nadie notaba que el avión no se vigila por horas.
      programa_configurado: intervalos.length > 0,
      utilizacion: {
        horas_total: Number(horasTotal.toFixed(1)),
        horas_mes: Number(horasMes.toFixed(1)),
        horas_anio: Number(horasAnio.toFixed(1)),
        vuelos_total: vuelosTotal.size,
        vuelos_mes: vuelosMes.size,
        vuelos_anio: vuelosAnio.size,
      },
      finanzas,
    };
  }

  /**
   * Histórico de tacómetros de una aeronave + horas actuales (último Hobbs) y el
   * próximo servicio por horas según su programa (secuencia de intervalos).
   */
  async tacometroHistorial(id: string) {
    const aeronave = await this.findById(id);
    // Asignación por tramo (regla de escalasDelAvion): filtrar solo por
    // vuelo.aeronave_id mostraba tacos de tramos volados en OTRO avión y
    // omitía tramos asignados a este. Se conserva el filtro original
    // taco_salida != null (aquí, porque el helper no filtra por columnas).
    const rows = (
      await this.escalasDelAvion(
        id,
        'id, origen_iata, destino_iata, taco_salida, taco_llegada, hora_salida, hora_llegada, fecha_salida_plan, foto_taco_salida_url, foto_taco_llegada_url, vuelo:vuelo_id!inner(id, folio, fecha_vuelo, aeronave_id, estado)',
      )
    ).filter((e) => e.taco_salida != null);

    let horasActuales = 0;
    for (const e of rows) {
      for (const v of [e.taco_salida, e.taco_llegada]) {
        if (v != null) horasActuales = Math.max(horasActuales, Number(v));
      }
    }

    // Firma las fotos del tacómetro (bucket privado taco-fotos) para verlas en
    // el panel admin desde el histórico.
    const fotoPaths: string[] = [];
    for (const e of rows) {
      if (e.foto_taco_salida_url)
        fotoPaths.push(e.foto_taco_salida_url as string);
      if (e.foto_taco_llegada_url)
        fotoPaths.push(e.foto_taco_llegada_url as string);
    }
    const firmadas: Record<string, string> = {};
    if (fotoPaths.length > 0) {
      const { data: signed } = await this.supabase.service.storage
        .from('taco-fotos')
        .createSignedUrls(fotoPaths, 3600);
      for (const s of signed ?? []) {
        if (s.signedUrl && s.path) firmadas[s.path] = s.signedUrl;
      }
    }

    const items = rows
      .map((e) => {
        const v = e.vuelo as {
          id?: string;
          folio?: number;
          fecha_vuelo?: string | null;
        };
        const s = e.taco_salida == null ? null : Number(e.taco_salida);
        const l = e.taco_llegada == null ? null : Number(e.taco_llegada);
        return {
          escala_id: e.id as string,
          // El folio en el panel enlaza al detalle del vuelo.
          vuelo_id: v.id ?? null,
          folio: v.folio ?? null,
          // Fecha OPERATIVA del tramo (plan del tramo o fecha del vuelo).
          // hora_salida es el momento del TECLAZO: capturar tarde los tacos
          // de un vuelo viejo (caso #59, cerrado el 7 ago siendo del 20 jul)
          // fechaba la fila como de hoy y el avión "volaba" sin vuelo.
          fecha:
            (e.fecha_salida_plan as string | null) ??
            v.fecha_vuelo ??
            (e.hora_salida as string | null) ??
            null,
          ruta: `${e.origen_iata as string} → ${e.destino_iata as string}`,
          taco_salida: s,
          taco_llegada: l,
          horas: s != null && l != null ? Number((l - s).toFixed(1)) : null,
          foto_salida_url: e.foto_taco_salida_url
            ? (firmadas[e.foto_taco_salida_url as string] ?? null)
            : null,
          foto_llegada_url: e.foto_taco_llegada_url
            ? (firmadas[e.foto_taco_llegada_url as string] ?? null)
            : null,
        };
      })
      .sort((a, b) => {
        const fa = a.fecha ? Date.parse(a.fecha) : 0;
        const fb = b.fecha ? Date.parse(b.fecha) : 0;
        if (fb !== fa) return fb - fa;
        return Number(b.taco_salida ?? 0) - Number(a.taco_salida ?? 0);
      });

    const intervalos = ((aeronave.servicio_intervalos as unknown[]) ?? []).map(
      Number,
    );
    const base = Number(aeronave.servicio_horas_base ?? 0);
    const etapas = await this.etapasDeServicio(id);

    // Motores y hélices con horas de vida vivas + estatus de overhaul (TBO).
    const [motoresRes, helicesRes] = await Promise.all([
      this.supabase.service
        .from('motor')
        .select(
          'id, posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .eq('aeronave_id', id)
        .order('posicion'),
      this.supabase.service
        .from('helice')
        .select(
          'id, posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .eq('aeronave_id', id)
        .order('posicion'),
    ]);
    const componentes = [
      ...(motoresRes.data ?? []).map((m) => ({
        id: m.id as string,
        tipo: 'MOTOR' as const,
        posicion: m.posicion as string,
        numero_serie: m.numero_serie as string,
        ...this.componenteEstado(m, horasActuales, true),
        tbo_horas: m.tbo_horas != null ? Number(m.tbo_horas) : null,
      })),
      // Las hélices también llevan TURM desde ago 2026: con conTurm=false el
      // TSO caía al respaldo "horas de vida" y la app del mecánico mostraba
      // un "restantes a overhaul" distinto al del panel.
      ...(helicesRes.data ?? []).map((h) => ({
        id: h.id as string,
        tipo: 'HELICE' as const,
        posicion: h.posicion as string,
        numero_serie: h.numero_serie as string,
        ...this.componenteEstado(h, horasActuales, true),
        tbo_horas: h.tbo_horas != null ? Number(h.tbo_horas) : null,
      })),
    ];

    return {
      horas_actuales: Number(horasActuales.toFixed(1)),
      // Tiempo TOTAL del planeador (base capturada + delta del taco); con
      // base 0/0 equivale al tacómetro.
      tiempo_total_planeador: this.tiempoTotalPlaneador(
        aeronave,
        horasActuales,
      ),
      planeador_horas_base: Number(aeronave.planeador_horas_base ?? 0),
      planeador_taco_ref: Number(aeronave.planeador_taco_ref ?? 0),
      servicio_intervalos: intervalos,
      servicio_horas_base: base,
      servicio_etapas: etapas,
      proximo_servicio: this.proximoServicioDetallado(
        intervalos,
        base,
        horasActuales,
        etapas,
      ),
      componentes,
      historial: items,
    };
  }

  /**
   * Próximo umbral de servicio. REGLA DEL MECÁNICO (18-ago-2026): cada
   * intervalo del programa es su PROPIO ciclo desde la base — 50 h en
   * base+50k, 100 h en base+100k, 200 h en base+200k — y manda el hito MÁS
   * CERCANO (el intervalo chico es el más restrictivo y JAMÁS se salta).
   * Antes la secuencia se recorría ENCADENADA (base+50, +100, +200 y
   * repetir): el avión "caminaba" 350 h por vuelta y el próximo servicio
   * podía salir a 200 h saltándose los intermedios (caso: horas 2204.7 con
   * base 1700 decía "200 h a las 2400" en vez de "50 h a las 2250").
   * Cuando varios ciclos caen en el MISMO hito, se reporta el intervalo
   * MAYOR (el servicio de 200 h incluye al de 50/100). Null sin programa.
   */
  proximoServicio(intervalos: number[], base: number, horas: number) {
    const ints = [
      ...new Set(
        intervalos.map(Number).filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    if (ints.length === 0) return null;
    // Primer múltiplo de cada intervalo ESTRICTAMENTE arriba de `horas`
    // (horas por debajo de la base — base recién editada a futuro — cae al
    // primer hito base+intervalo).
    const r1 = (n: number) => Number(n.toFixed(1));
    let aLas: number | null = null;
    let intervalo = 0;
    for (const int of ints) {
      const pasos =
        horas < base ? 1 : Math.floor((r1(horas) - r1(base)) / int) + 1;
      const hito = r1(base + int * pasos);
      if (aLas == null || hito < aLas - 0.05) {
        aLas = hito;
        intervalo = int;
      } else if (Math.abs(hito - aLas) <= 0.05 && int > intervalo) {
        // Hitos coincidentes: gana la etiqueta del servicio mayor.
        intervalo = int;
      }
    }
    if (aLas == null) return null;
    return {
      a_las: aLas,
      intervalo,
      faltan: r1(aLas - horas),
    };
  }

  /** Etapas del programa de servicio (intervalo + nombre + tareas). */
  async etapasDeServicio(aeronaveId: string): Promise<
    Array<{
      id: string;
      intervalo_hr: number;
      nombre: string | null;
      tareas: string[];
    }>
  > {
    const { data, error } = await this.supabase.service
      .from('aeronave_servicio_etapa')
      .select(ETAPA_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('intervalo_hr');
    if (error) throw new Error(error.message);
    return (data ?? []).map((e) => ({
      id: e.id as string,
      intervalo_hr: Number(e.intervalo_hr),
      nombre: (e.nombre as string | null) ?? null,
      tareas: (e.tareas as string[] | null) ?? [],
    }));
  }

  /**
   * Próximo servicio ENRIQUECIDO con las tareas de la(s) etapa(s) que caen en
   * ese hito. Regla del mecánico: en hitos coincidentes el servicio mayor
   * incluye a los menores — las tareas se UNEN (menor→mayor, sin duplicados).
   */
  proximoServicioDetallado(
    intervalos: number[],
    base: number,
    horas: number,
    etapas: Array<{
      intervalo_hr: number;
      nombre: string | null;
      tareas: string[];
    }>,
  ) {
    const prox = this.proximoServicio(intervalos, base, horas);
    if (!prox) return null;
    const r1 = (n: number) => Number(n.toFixed(1));
    const ints = [
      ...new Set(
        intervalos.map(Number).filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    // Todos los intervalos cuyo próximo hito coincide con el hito ganador.
    const incluidos = ints
      .filter((int) => {
        const pasos =
          horas < base ? 1 : Math.floor((r1(horas) - r1(base)) / int) + 1;
        return Math.abs(r1(base + int * pasos) - prox.a_las) <= 0.05;
      })
      .sort((a, b) => a - b);
    const tareas: string[] = [];
    for (const int of incluidos) {
      const etapa = etapas.find((e) => Math.abs(e.intervalo_hr - int) <= 0.05);
      for (const t of etapa?.tareas ?? []) {
        if (!tareas.includes(t)) tareas.push(t);
      }
    }
    const etapaGanadora = etapas.find(
      (e) => Math.abs(e.intervalo_hr - prox.intervalo) <= 0.05,
    );
    return {
      ...prox,
      nombre: etapaGanadora?.nombre ?? null,
      etapas_incluidas: incluidos,
      tareas,
    };
  }

  /**
   * Tiempo TOTAL del planeador (célula): horas base capturadas + lo volado
   * desde que el tacómetro marcaba la referencia. Con base/ref en 0 equivale
   * al tacómetro (comportamiento histórico); el taco sigue siendo el eje
   * operativo — esto solo agrega la base real del avión (bitácoras previas).
   */
  tiempoTotalPlaneador(
    aeronave: Record<string, unknown>,
    hobbs: number,
  ): number {
    const base = Number(aeronave.planeador_horas_base ?? 0);
    const ref = Number(aeronave.planeador_taco_ref ?? 0);
    return Number((base + Math.max(0, hobbs - ref)).toFixed(1));
  }

  /**
   * Sincroniza las etapas del programa con la tabla y deriva
   * aeronave.servicio_intervalos (columna de lectura para app/alertas/panel).
   * Único camino de escritura del programa: etapas y arreglo jamás divergen.
   */
  private async syncServicioEtapas(
    aeronaveId: string,
    etapas: Array<{ intervalo_hr: number; nombre?: string; tareas?: string[] }>,
    userId: string,
  ): Promise<number[]> {
    // Dedupe por intervalo (el último gana) y orden ascendente.
    const porIntervalo = new Map<
      number,
      { intervalo_hr: number; nombre?: string; tareas?: string[] }
    >();
    for (const e of etapas) {
      const int = Number(Number(e.intervalo_hr).toFixed(2));
      if (Number.isFinite(int) && int > 0) porIntervalo.set(int, e);
    }
    const limpias = [...porIntervalo.values()].sort(
      (a, b) => Number(a.intervalo_hr) - Number(b.intervalo_hr),
    );
    const intervalos = limpias.map((e) => Number(e.intervalo_hr));

    // Borrar etapas que ya no están y upsert de las vigentes.
    const del = this.supabase.service
      .from('aeronave_servicio_etapa')
      .delete()
      .eq('aeronave_id', aeronaveId);
    const { error: delErr } = await (intervalos.length > 0
      ? del.not(
          'intervalo_hr',
          'in',
          `(${intervalos.map((i) => i.toString()).join(',')})`,
        )
      : del);
    if (delErr) throw new Error(delErr.message);

    if (limpias.length > 0) {
      const { error: upErr } = await this.supabase.service
        .from('aeronave_servicio_etapa')
        .upsert(
          limpias.map((e) => ({
            aeronave_id: aeronaveId,
            intervalo_hr: e.intervalo_hr,
            nombre: e.nombre?.trim() || null,
            tareas: (e.tareas ?? [])
              .map((t) => t.trim())
              .filter((t) => t.length > 0),
            updated_by: userId,
          })),
          { onConflict: 'aeronave_id,intervalo_hr' },
        );
      if (upErr) throw new Error(upErr.message);
    }
    return intervalos;
  }

  /**
   * Semáforo APTO/NO APTO en LOTE (para el listado, sin N+1). MISMOS
   * ingredientes que aircraftMetrics: documentos críticos vencidos
   * (aeronave + motores), servicio EN_TALLER, TBO agotado (motores Y
   * hélices) y squawks ALTA sin resolver; más la póliza de seguro vencida
   * (cuando el avión tiene pólizas registradas).
   */
  private async aptitudBulk(
    ids: string[],
    maxTaco: Map<string, number>,
  ): Promise<Map<string, { apto: boolean; razones: string[] }>> {
    const out = new Map<string, { apto: boolean; razones: string[] }>();
    for (const id of ids) out.set(id, { apto: true, razones: [] });
    if (ids.length === 0) return out;

    const hoy = this.hoyCancun();
    const [
      tallerRes,
      squawksRes,
      motoresRes,
      helicesRes,
      segurosRes,
      blocking,
    ] = await Promise.all([
      this.supabase.service
        .from('mantenimiento')
        .select('aeronave_id')
        .in('aeronave_id', ids)
        .eq('estado', 'EN_TALLER'),
      this.supabase.service
        .from('aeronave_discrepancia')
        .select('aeronave_id, descripcion')
        .in('aeronave_id', ids)
        .neq('estado', 'RESUELTA')
        .eq('severidad', 'ALTA'),
      this.supabase.service
        .from('motor')
        .select(
          'aeronave_id, posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .in('aeronave_id', ids),
      this.supabase.service
        .from('helice')
        .select(
          'aeronave_id, posicion, numero_serie, horas_totales, turm, tso_base, tbo_horas, aeronave_horas_ref',
        )
        .in('aeronave_id', ids),
      this.supabase.service
        .from('aeronave_seguro')
        .select('aeronave_id, vigente_hasta')
        .in('aeronave_id', ids),
      this.expirations.findBlockingExpirationsBulk(ids),
    ]);
    if (tallerRes.error) throw new Error(tallerRes.error.message);
    if (squawksRes.error) throw new Error(squawksRes.error.message);
    if (motoresRes.error) throw new Error(motoresRes.error.message);
    if (helicesRes.error) throw new Error(helicesRes.error.message);
    if (segurosRes.error) throw new Error(segurosRes.error.message);

    const marca = (id: string | null | undefined, razon: string) => {
      if (!id) return;
      const s = out.get(id);
      if (!s) return;
      s.apto = false;
      s.razones.push(razon);
    };

    for (const [avionId, docs] of blocking) {
      for (const d of docs)
        marca(avionId, `Documento vencido: ${d.tipo_nombre}`);
    }
    for (const t of tallerRes.data ?? []) {
      const s = out.get(t.aeronave_id as string);
      // Una sola razón de taller aunque haya varios servicios abiertos.
      if (s && !s.razones.includes('Servicio en taller')) {
        marca(t.aeronave_id as string, 'Servicio en taller');
      }
    }
    for (const comp of [
      ...(motoresRes.data ?? []).map((m) => ({ ...m, _tipo: 'Motor' })),
      ...(helicesRes.data ?? []).map((h) => ({ ...h, _tipo: 'Hélice' })),
    ]) {
      const avionId = comp.aeronave_id as string;
      const estado = this.componenteEstado(
        comp,
        maxTaco.get(avionId) ?? 0,
        true,
      );
      if ((estado.tbo_restante ?? 1) <= 0) {
        marca(
          avionId,
          `TBO agotado: ${comp._tipo} ${comp.posicion as string} (${comp.numero_serie as string})`,
        );
      }
    }
    for (const s of squawksRes.data ?? []) {
      marca(
        s.aeronave_id as string,
        `Discrepancia ALTA sin resolver: ${((s.descripcion as string | null) ?? '').slice(0, 60)}`,
      );
    }
    // Póliza de seguro: si el avión tiene pólizas y TODAS vencieron, no está
    // asegurado. (El documento crítico "Seguro" de vencimientos también lo
    // cubre cuando se captura ahí; ambas fuentes suman, no se pisan.)
    const vigencias = new Map<string, string>();
    for (const seg of segurosRes.data ?? []) {
      const avionId = seg.aeronave_id as string;
      const hasta = (seg.vigente_hasta as string | null) ?? '';
      if (hasta > (vigencias.get(avionId) ?? '')) vigencias.set(avionId, hasta);
    }
    for (const [avionId, hasta] of vigencias) {
      if (hasta && hasta < hoy) {
        marca(avionId, `Póliza de seguro vencida (${hasta})`);
      }
    }
    return out;
  }

  async list(filters: ListAeronavesQuery) {
    let query = this.supabase.service
      .from('aeronave')
      .select(AERONAVE_COLS, { count: 'exact' })
      .order('matricula', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.pais_registro)
      query = query.eq('pais_registro', filters.pais_registro);
    if (typeof filters.activa === 'boolean')
      query = query.eq('activa', filters.activa);
    if (filters.q) {
      const term = `%${filters.q}%`;
      query = query.or(`matricula.ilike.${term},modelo.ilike.${term}`);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(`list aeronaves failed: ${error.message}`);

    // Foto principal de cada avión (galería aeronave_imagen): el listado del
    // panel la muestra como avatar de la fila.
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const { data: imgs } = await this.supabase.service
        .from('aeronave_imagen')
        .select('aeronave_id, url')
        .in(
          'aeronave_id',
          rows.map((a) => a.id as string),
        )
        .eq('es_principal', true);
      const porAvion = new Map(
        (imgs ?? []).map((i) => [i.aeronave_id as string, i.url as string]),
      );
      for (const a of rows) {
        a.imagen_principal_url = porAvion.get(a.id as string) ?? null;
      }

      // Último tacómetro por avión (el horómetro solo sube: max de todas sus
      // lecturas), en UNA consulta para todo el listado. Regla de asignación
      // por tramo: la escala pertenece al avión de escala.aeronave_id, o al
      // del vuelo cuando no tiene asignación propia.
      const ids = new Set(rows.map((a) => a.id as string));
      // Paginado: sin .range() PostgREST trunca a 1000 filas y el max se
      // calcularía sobre un subconjunto arbitrario, en silencio.
      const tacos = await this.fetchTodas((from, to) =>
        this.supabase.service
          .from('escala')
          .select(
            'aeronave_id, taco_salida, taco_llegada, vuelo:vuelo_id(aeronave_id)',
          )
          .or('taco_salida.not.is.null,taco_llegada.not.is.null')
          .order('id', { ascending: true })
          .range(from, to),
      );
      const maxTaco = new Map<string, number>();
      for (const e of tacos) {
        const vuelo = e.vuelo as { aeronave_id?: string | null } | null;
        const dueno =
          (e.aeronave_id as string | null) ?? vuelo?.aeronave_id ?? null;
        if (!dueno || !ids.has(dueno)) continue;
        for (const v of [e.taco_salida, e.taco_llegada]) {
          const n = Number(v);
          if (Number.isFinite(n) && n > (maxTaco.get(dueno) ?? -Infinity)) {
            maxTaco.set(dueno, n);
          }
        }
      }
      // Semáforo APTO/NO APTO en lote (petición del cliente: verlo en la
      // lista, no solo en el detalle).
      const aptitud = await this.aptitudBulk([...ids], maxTaco);
      for (const a of rows) {
        a.ultimo_taco = maxTaco.get(a.id as string) ?? null;
        const apt = aptitud.get(a.id as string);
        a.apto = apt?.apto ?? true;
        a.no_apto_razones = apt?.razones ?? [];
      }
    }

    return {
      data: rows,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select(AERONAVE_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeronave ${id} not found`);
    return data;
  }

  async getSnapshot(id: string) {
    const aeronave = await this.findById(id);
    const [
      motorsRes,
      propellersRes,
      ownersRes,
      reservesRes,
      imagenesRes,
      segurosRes,
      discrepanciasRes,
    ] = await Promise.all([
      this.supabase.service
        .from('motor')
        .select(
          'id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tso_base, tbo_horas, tbo_fecha, aeronave_horas_ref, notas, created_at, updated_at, actualizado_por:updated_by(nombre)',
        )
        .eq('aeronave_id', id)
        .order('posicion'),
      this.supabase.service
        .from('helice')
        .select(
          'id, posicion, numero_serie, fabricante, modelo, horas_totales, turm, tso_base, tbo_horas, tbo_fecha, aeronave_horas_ref, notas, created_at, updated_at, actualizado_por:updated_by(nombre)',
        )
        .eq('aeronave_id', id)
        .order('posicion'),
      this.supabase.service
        .from('aeronave_socio')
        .select(
          'id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas, usuario:socio_id(nombre, es_empresa, rol)',
        )
        .eq('aeronave_id', id)
        // Vigencia REAL: sin fecha de fin O con fin en el futuro (día
        // Cancún). Filtrar solo IS NULL escondía socios con vigencia
        // programada a futuro que HOY siguen siendo dueños.
        .or(`vigente_hasta.is.null,vigente_hasta.gte.${this.hoyCancun()}`)
        .order('porcentaje', { ascending: false }),
      this.supabase.service
        .from('reserva_overhaul')
        .select('id, motor_id, monto_por_hora_usd, horas_acumuladas')
        .eq('aeronave_id', id),
      this.supabase.service
        .from('aeronave_imagen')
        .select(IMAGEN_COLS)
        .eq('aeronave_id', id)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: true }),
      this.supabase.service
        .from('aeronave_seguro')
        .select(SEGURO_COLS)
        .eq('aeronave_id', id)
        .order('vigente_hasta', { ascending: false }),
      this.supabase.service
        .from('aeronave_discrepancia')
        .select(DISCREPANCIA_COLS)
        .eq('aeronave_id', id)
        .order('fecha_reporte', { ascending: false }),
    ]);
    if (motorsRes.error) throw new Error(motorsRes.error.message);
    if (propellersRes.error) throw new Error(propellersRes.error.message);
    if (ownersRes.error) throw new Error(ownersRes.error.message);
    if (reservesRes.error) throw new Error(reservesRes.error.message);
    if (imagenesRes.error) throw new Error(imagenesRes.error.message);
    if (segurosRes.error) throw new Error(segurosRes.error.message);
    if (discrepanciasRes.error) throw new Error(discrepanciasRes.error.message);

    // Horas de vida vivas (acumulan con lo volado) + estatus de overhaul (TBO).
    const hobbs = await this.currentHobbs(id);
    const motors = (motorsRes.data ?? []).map((m) => ({
      ...m,
      ...this.componenteEstado(m, hobbs, true),
    }));
    // Las hélices también llevan TURM (taco en su último overhaul) desde
    // ago 2026: mismo cálculo de "desde overhaul" que los motores.
    const propellers = (propellersRes.data ?? []).map((p) => ({
      ...p,
      ...this.componenteEstado(p, hobbs, true),
    }));

    // Reserva de overhaul: horas mostradas = base manual + voladas DERIVADAS.
    const voladas = await this.horasVoladas(id);
    const overhaulReserves = (reservesRes.data ?? []).map((r) => ({
      ...r,
      horas_acumuladas: Number(
        (Number(r.horas_acumuladas ?? 0) + voladas).toFixed(2),
      ),
    }));

    // Semáforo APTO/NO APTO también en el snapshot: /metrics lleva gate de
    // roles financieros (ADMIN/ANALISTA/SOCIO) y el COORDINADOR — que asigna
    // vuelos y captura squawks — se quedaba sin ver el NO APTO en el detalle.
    const aptitud = (await this.aptitudBulk([id], new Map([[id, hobbs]]))).get(
      id,
    );

    return {
      ...aeronave,
      airworthiness: aptitud ?? { apto: true, razones: [] },
      motors,
      propellers,
      owners: ownersRes.data ?? [],
      overhaul_reserves: overhaulReserves,
      imagenes: imagenesRes.data ?? [],
      seguros: segurosRes.data ?? [],
      discrepancias: discrepanciasRes.data ?? [],
    };
  }

  /**
   * Tramos (escalas) que pertenecen a ESTE avión, con la regla de la
   * asignación por tramo: el tramo es del avión si `escala.aeronave_id` es el
   * avión, o si la escala no tiene avión propio y el vuelo (espejo) sí lo es.
   * Filtrar solo por `vuelo.aeronave_id` atribuía las horas/hobbs de un tramo
   * volado en OTRO avión (redondos con ida/regreso en aviones distintos).
   * Siempre excluye vuelos CANCELADOS. `select` permite pedir más columnas
   * (debe incluir el embed `vuelo:vuelo_id!inner(aeronave_id, estado)` para
   * que los filtros del join apliquen).
   */
  /**
   * Tira imprimible de bitácora de tacómetros (formato MONOMOTOR, réplica de
   * la hoja "Imprimir planeador" de la plantilla del equipo): una fila por
   * VUELO con fecha, tacómetro inicial, horas voladas, tacómetro final y la
   * ruta en minúsculas ("cun-pps-cun"). Se imprime, se recorta y se pega en
   * la bitácora física del avión. Sin rango = todo el histórico.
   */
  async bitacoraTacoPdf(
    id: string,
    desde?: string,
    hasta?: string,
    formato: 'PLANEADOR' | 'MOTOR_HELICE' = 'PLANEADOR',
    heliceBase?: number,
  ): Promise<{ buffer: Buffer; matricula: string }> {
    const aeronave = await this.findById(id);
    const rows = await this.escalasDelAvion(
      id,
      'orden, origen_iata, destino_iata, es_sobrevuelo, taco_salida, taco_llegada, vuelo:vuelo_id!inner(id, fecha_vuelo, estado, aeronave_id)',
    );

    const unwrapOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    // Corte del rango en hora Cancún (regla transversal de periodos).
    const desdeTs = desde
      ? new Date(`${desde}T00:00:00-05:00`).getTime()
      : null;
    const hastaTs = hasta
      ? new Date(`${hasta}T23:59:59-05:00`).getTime()
      : null;

    interface LegBitacora {
      orden: number;
      origen: string;
      destino: string;
      sobrevuelo: boolean;
      salida: number | null;
      llegada: number | null;
    }
    const porVuelo = new Map<string, { fecha: string; legs: LegBitacora[] }>();
    for (const r of rows) {
      const vuelo = unwrapOne(
        r.vuelo as { id?: string; fecha_vuelo?: string | null } | null,
      );
      const fecha = vuelo?.fecha_vuelo ?? null;
      if (!vuelo?.id || !fecha) continue; // sin fecha no hay renglón de bitácora
      const ts = new Date(fecha).getTime();
      if (desdeTs !== null && ts < desdeTs) continue;
      if (hastaTs !== null && ts > hastaTs) continue;
      const g =
        porVuelo.get(vuelo.id) ??
        porVuelo.set(vuelo.id, { fecha, legs: [] }).get(vuelo.id)!;
      g.legs.push({
        orden: Number(r.orden) || 0,
        origen: String(r.origen_iata ?? ''),
        destino: String(r.destino_iata ?? ''),
        sobrevuelo: r.es_sobrevuelo === true,
        salida: r.taco_salida == null ? null : Number(r.taco_salida),
        llegada: r.taco_llegada == null ? null : Number(r.taco_llegada),
      });
    }

    const filas: BitacoraTacoFilaPayload[] = [];
    for (const { fecha, legs } of porVuelo.values()) {
      legs.sort((a, b) => a.orden - b.orden);
      // Tacómetro inicial = salida del primer tramo con lectura; final =
      // llegada del último. Un vuelo aún sin llegadas no genera renglón
      // (igual que a mano: la fila se escribe con el vuelo cerrado).
      const inicial = legs.find((l) => l.salida != null)?.salida ?? null;
      const final =
        [...legs].reverse().find((l) => l.llegada != null)?.llegada ?? null;
      if (inicial == null || final == null) continue;
      const horas = legs.reduce(
        (sum, l) =>
          l.salida != null && l.llegada != null && l.llegada > l.salida
            ? sum + (l.llegada - l.salida)
            : sum,
        0,
      );
      // Cadena de la ruta: origen del primer tramo + destino de cada tramo;
      // un sobrevuelo (origen = destino) intercala "sobrevuelo" como en la
      // plantilla manual; un salto de base (reposicionado fuera del vuelo)
      // agrega el nuevo origen para no mentir la continuidad.
      const tokens: string[] = [];
      for (const l of legs) {
        if (tokens.length === 0 || tokens[tokens.length - 1] !== l.origen) {
          tokens.push(l.origen);
        }
        if (l.sobrevuelo) tokens.push('sobrevuelo');
        tokens.push(l.destino);
      }
      filas.push({
        fecha,
        taco_inicial: Number(inicial.toFixed(1)),
        horas: Number(horas.toFixed(1)),
        taco_final: Number(final.toFixed(1)),
        ruta: tokens.join('-').toLowerCase(),
      });
    }
    // Cronológico como el libro físico; empates del día por tacómetro.
    filas.sort(
      (a, b) =>
        new Date(a.fecha).getTime() - new Date(b.fecha).getTime() ||
        a.taco_inicial - b.taco_inicial,
    );

    // Formato bimotor (hoja "MOTOR - HÉLICE"): el tiempo de hélice corre
    // parejo con el tacómetro, así que basta el valor del PRIMER renglón
    // (lo aporta la oficina desde el libro, igual que en su plantilla) y el
    // resto se deriva con offset constante. El sistema aún no lleva horas
    // de vida de hélice (pendiente con el cliente) — no hay de dónde
    // autollenarlo. Sin helice_base, las columnas salen con "—".
    if (formato === 'MOTOR_HELICE' && heliceBase != null && filas.length > 0) {
      const offset = heliceBase - filas[0].taco_inicial;
      for (const f of filas) {
        f.helice_inicial = Number((f.taco_inicial + offset).toFixed(1));
        f.helice_final = Number((f.taco_final + offset).toFixed(1));
      }
    }

    const buffer = await this.pyservices.generateBitacoraTacoPdf({
      matricula: (aeronave.matricula as string) ?? '',
      modelo: (aeronave.modelo as string) ?? null,
      formato,
      desde: desde ?? null,
      hasta: hasta ?? null,
      generado: new Date().toISOString(),
      filas,
    });
    return { buffer, matricula: (aeronave.matricula as string) ?? 'avion' };
  }

  /**
   * Trae TODAS las filas de una consulta paginando en bloques de 1000:
   * PostgREST trunca a 1000 por default y el excedente se perdía EN SILENCIO
   * (último taco / horas calculados sobre un subconjunto arbitrario — hoy
   * van ~230 escalas, pero al ritmo actual el tope llegaba en meses).
   */
  private async fetchTodas(
    builder: (
      from: number,
      to: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
  ): Promise<Array<Record<string, unknown>>> {
    const PAGE = 1000;
    const out: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await builder(from, from + PAGE - 1);
      // Nunca degradar a [] en silencio: estas filas alimentan horas/hobbs.
      if (error) throw new Error(error.message);
      const chunk = (data ?? []) as Array<Record<string, unknown>>;
      out.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    return out;
  }

  private async escalasDelAvion(
    aeronaveId: string,
    select = 'taco_salida, taco_llegada, vuelo:vuelo_id!inner(aeronave_id, estado)',
  ): Promise<Array<Record<string, unknown>>> {
    const [propias, heredadas] = await Promise.all([
      // Tramos asignados explícitamente a este avión (escala.aeronave_id).
      // Tramos CANCELADOS fuera: no volaron (sus tacos ya vienen en null,
      // pero así tampoco aparecen en histórico/bitácora).
      this.fetchTodas((from, to) =>
        this.supabase.service
          .from('escala')
          .select(select)
          .eq('aeronave_id', aeronaveId)
          .is('cancelada_at', null)
          .neq('vuelo.estado', 'CANCELADO')
          .order('id', { ascending: true })
          .range(from, to),
      ),
      // Tramos sin avión propio: heredan el del vuelo.
      this.fetchTodas((from, to) =>
        this.supabase.service
          .from('escala')
          .select(select)
          .is('aeronave_id', null)
          .eq('vuelo.aeronave_id', aeronaveId)
          .is('cancelada_at', null)
          .neq('vuelo.estado', 'CANCELADO')
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);
    // El select dinámico deja al cliente sin tipo inferido: normalizamos a
    // Record<string, unknown> (los consumidores castean sus columnas).
    return [...propias, ...heredadas];
  }

  /**
   * Horas voladas reales del avión, DERIVADAS de las escalas (suma de
   * taco_llegada − taco_salida en vuelos no cancelados). Fuente única para la
   * reserva de overhaul mostrada: nunca se incrementa un contador aparte, así
   * un ajuste de tacómetro posterior se refleja solo y no hay doble conteo.
   */
  private async horasVoladas(aeronaveId: string): Promise<number> {
    const escalas = await this.escalasDelAvion(aeronaveId);
    let horas = 0;
    for (const e of escalas) {
      if (e.taco_salida == null || e.taco_llegada == null) continue;
      const h = Number(e.taco_llegada) - Number(e.taco_salida);
      if (Number.isFinite(h) && h > 0) horas += h;
    }
    return Number(horas.toFixed(2));
  }

  /** Día actual (yyyy-mm-dd) en hora Cancún — regla del repo para cortes. */
  private hoyCancun(): string {
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Cancun',
    });
  }

  /** Horas actuales (último Hobbs) de un avión = máximo tacómetro registrado. */
  // Público a propósito: engines/propellers usan ESTE eje de horas (no
  // duplicar la regla de asignación por tramo).
  async currentHobbs(aeronaveId: string): Promise<number> {
    const escalas = await this.escalasDelAvion(aeronaveId);
    let max = 0;
    for (const e of escalas) {
      for (const v of [e.taco_salida, e.taco_llegada]) {
        if (v != null) max = Math.max(max, Number(v));
      }
    }
    return Number(max.toFixed(1));
  }

  /**
   * Horas de vida vivas de un componente (motor/hélice) y horas restantes a su
   * overhaul (TBO). Si no hay referencia/TBO, devuelve los valores que se puedan.
   *
   * TURM = lectura del TACÓMETRO DEL AVIÓN en la última reparación mayor (así
   * lo captura el mecánico: N990GG turm=4290.5 con taco 5543.9 → 1253.4 hrs
   * desde overhaul). Restarlo de las horas de vida del motor —otra escala—
   * daba 0 o negativos en toda la flota. Sin TURM capturado, el respaldo son
   * las horas de vida (hélices, o motor recién anclado).
   *
   * Público a propósito: la alerta de TBO (alerts.service) usa ESTE cálculo —
   * no duplicar la aritmética.
   */
  componenteEstado(
    c: Record<string, unknown>,
    hobbs: number,
    conTurm: boolean,
  ): {
    horas_actuales: number;
    tbo_restante: number | null;
    horas_desde_overhaul: number;
    turm_componente: number | null;
    vida_usada_pct: number | null;
    hobbs_avion: number;
  } {
    const ht = Number(c.horas_totales ?? 0);
    const ref =
      c.aeronave_horas_ref != null ? Number(c.aeronave_horas_ref) : null;
    const delta = ref != null ? Math.max(0, hobbs - ref) : 0;
    const horasActuales = Number((ht + delta).toFixed(1));
    const tbo = Number(c.tbo_horas ?? 0);
    // TSO canónico: tso_base viaja CON el componente (marco del componente,
    // anclado en aeronave_horas_ref) y sobrevive traslados entre aviones.
    // Respaldo legado: turm en escala del taco del avión (TSO = hobbs − turm),
    // solo válido mientras el componente no se haya movido de avión.
    // Sin overhaul registrado: TSO = TSN (horas de vida).
    const tsoBase = c.tso_base != null ? Number(c.tso_base) : null;
    const turm = conTurm ? Number(c.turm ?? 0) : 0;
    const desdeOverhaul =
      tsoBase != null
        ? Math.max(0, tsoBase + delta)
        : turm > 0
          ? Math.max(0, hobbs - turm)
          : horasActuales;
    // TURM en marco del componente (como la bitácora física AFAC): horas de
    // vida del componente en su último overhaul. Null = sin overhaul.
    const tuvoOverhaul = tsoBase != null || turm > 0;
    const turmComponente = tuvoOverhaul
      ? Number(Math.max(0, horasActuales - desdeOverhaul).toFixed(1))
      : null;
    const tboRestante =
      tbo > 0 ? Number((tbo - desdeOverhaul).toFixed(1)) : null;
    // Porcentaje de vida consumida del ciclo TBO (para la barra del panel);
    // se calcula aquí para que el panel no invente su propia aritmética.
    const vidaUsadaPct =
      tbo > 0
        ? Number(
            (
              Math.min(100, Math.max(0, (desdeOverhaul / tbo) * 100)) || 0
            ).toFixed(1),
          )
        : null;
    return {
      horas_actuales: horasActuales,
      tbo_restante: tboRestante,
      horas_desde_overhaul: Number(desdeOverhaul.toFixed(1)),
      turm_componente: turmComponente,
      vida_usada_pct: vidaUsadaPct,
      hobbs_avion: hobbs,
    };
  }

  async create(dto: CreateAeronaveDto, createdBy: string) {
    const { servicio_etapas, ...rest } = dto;
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .insert({ ...rest, created_by: createdBy, updated_by: createdBy })
      .select(AERONAVE_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('matricula already exists');
      throw new Error(error.message);
    }
    if (servicio_etapas !== undefined) {
      return this.update(
        (data as { id: string }).id,
        { servicio_etapas },
        createdBy,
      );
    }
    return data!;
  }

  async update(id: string, dto: UpdateAeronaveDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { servicio_etapas, ...rest } = dto;
    const patch: Record<string, unknown> = { ...rest, updated_by: updatedBy };
    // Programa de servicio: las etapas (con tareas) son la fuente de verdad y
    // servicio_intervalos se deriva de ellas — un solo camino de escritura.
    if (servicio_etapas !== undefined) {
      patch.servicio_intervalos = await this.syncServicioEtapas(
        id,
        servicio_etapas,
        updatedBy,
      );
    } else if (rest.servicio_intervalos !== undefined) {
      // Camino legado (solo números): sincroniza etapas CONSERVANDO nombre y
      // tareas de los intervalos que se quedan.
      const actuales = await this.etapasDeServicio(id);
      const etapas = [
        ...new Set(
          (rest.servicio_intervalos ?? [])
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0),
        ),
      ].map((int) => {
        const previa = actuales.find(
          (e) => Math.abs(e.intervalo_hr - int) <= 0.05,
        );
        return {
          intervalo_hr: int,
          nombre: previa?.nombre ?? undefined,
          tareas: previa?.tareas ?? [],
        };
      });
      patch.servicio_intervalos = await this.syncServicioEtapas(
        id,
        etapas,
        updatedBy,
      );
    }
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .update(patch)
      .eq('id', id)
      .select(AERONAVE_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeronave ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }

  // ============ OWNERSHIP ============

  async listOwners(aeronaveId: string, includeHistory: boolean) {
    let q = this.supabase.service
      .from('aeronave_socio')
      .select(
        'id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas, created_at, updated_at, usuario:socio_id(nombre, email, rol, es_empresa)',
      )
      .eq('aeronave_id', aeronaveId)
      .order('vigente_desde', { ascending: false });
    // "Actuales" = vigencia real hoy (día Cancún): sin fin o fin a futuro,
    // mismo criterio que el snapshot del avión.
    if (!includeHistory)
      q = q.or(`vigente_hasta.is.null,vigente_hasta.gte.${this.hoyCancun()}`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createOwner(
    aeronaveId: string,
    dto: CreateAeronaveSocioDto,
    createdBy: string,
  ) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .insert({
        aeronave_id: aeronaveId,
        socio_id: dto.socio_id,
        porcentaje: dto.porcentaje,
        vigente_desde: dto.vigente_desde.toISOString().slice(0, 10),
        vigente_hasta: dto.vigente_hasta?.toISOString().slice(0, 10),
        notas: dto.notas,
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select('id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas')
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('socio_id does not exist');
      throw new Error(error.message);
    }
    return data!;
  }

  async updateOwner(
    ownerId: string,
    dto: UpdateAeronaveSocioDto,
    updatedBy: string,
  ) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty patch');
    }
    const patch: Record<string, unknown> = { updated_by: updatedBy };
    if (dto.porcentaje !== undefined) patch.porcentaje = dto.porcentaje;
    if (dto.vigente_hasta !== undefined)
      patch.vigente_hasta = dto.vigente_hasta.toISOString().slice(0, 10);
    if (dto.notas !== undefined) patch.notas = dto.notas;

    const { data, error } = await this.supabase.service
      .from('aeronave_socio')
      .update(patch)
      .eq('id', ownerId)
      .select(
        'id, aeronave_id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas',
      )
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`aeronave_socio ${ownerId} not found`);
    return data;
  }

  async closeOwner(ownerId: string, vigenteHasta: Date, updatedBy: string) {
    return this.updateOwner(
      ownerId,
      { vigente_hasta: vigenteHasta },
      updatedBy,
    );
  }

  // ============ Seguros ============

  async listSeguros(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_seguro')
      .select(SEGURO_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('vigente_hasta', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createSeguro(
    aeronaveId: string,
    dto: CreateAeronaveSeguroDto,
    userId: string,
  ) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_seguro')
      .insert({
        aeronave_id: aeronaveId,
        aseguradora: dto.aseguradora,
        num_poliza: dto.num_poliza,
        cobertura: dto.cobertura ?? null,
        suma_asegurada_usd: dto.suma_asegurada_usd ?? null,
        prima_usd: dto.prima_usd ?? null,
        vigente_desde: dto.vigente_desde.toISOString().slice(0, 10),
        vigente_hasta: dto.vigente_hasta.toISOString().slice(0, 10),
        archivo_url: dto.archivo_url ?? null,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(SEGURO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateSeguro(
    seguroId: string,
    dto: UpdateAeronaveSeguroDto,
    userId: string,
  ) {
    // Para limpiar el archivo anterior del bucket al reemplazar/quitar.
    const { data: previo, error: prevErr } = await this.supabase.service
      .from('aeronave_seguro')
      .select('archivo_url')
      .eq('id', seguroId)
      .maybeSingle();
    if (prevErr) throw new Error(prevErr.message);
    if (!previo) throw new NotFoundException(`Seguro ${seguroId} not found`);

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.aseguradora !== undefined) patch.aseguradora = dto.aseguradora;
    if (dto.num_poliza !== undefined) patch.num_poliza = dto.num_poliza;
    if (dto.cobertura !== undefined) patch.cobertura = dto.cobertura;
    if (dto.suma_asegurada_usd !== undefined)
      patch.suma_asegurada_usd = dto.suma_asegurada_usd;
    if (dto.prima_usd !== undefined) patch.prima_usd = dto.prima_usd;
    if (dto.vigente_desde !== undefined)
      patch.vigente_desde = dto.vigente_desde.toISOString().slice(0, 10);
    if (dto.vigente_hasta !== undefined)
      patch.vigente_hasta = dto.vigente_hasta.toISOString().slice(0, 10);
    if (dto.archivo_url !== undefined) patch.archivo_url = dto.archivo_url;
    if (dto.notas !== undefined) patch.notas = dto.notas;

    const { data, error } = await this.supabase.service
      .from('aeronave_seguro')
      .update(patch)
      .eq('id', seguroId)
      .select(SEGURO_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Seguro ${seguroId} not found`);
    // Reemplazo/retiro del adjunto: borrar el anterior del bucket
    // (best-effort, mismo patrón que expirations.update).
    const anterior = previo.archivo_url as string | null;
    if (
      dto.archivo_url !== undefined &&
      anterior &&
      anterior !== dto.archivo_url
    ) {
      const { error: stErr } = await this.supabase.service.storage
        .from('documentos-flota')
        .remove([anterior]);
      if (stErr) {
        this.logger.warn(
          `No se pudo borrar la póliza anterior del seguro ${seguroId}: ${stErr.message}`,
        );
      }
    }
    return data;
  }

  async deleteSeguro(seguroId: string) {
    const { data: previo } = await this.supabase.service
      .from('aeronave_seguro')
      .select('archivo_url')
      .eq('id', seguroId)
      .maybeSingle();
    const { error } = await this.supabase.service
      .from('aeronave_seguro')
      .delete()
      .eq('id', seguroId);
    if (error) throw new Error(error.message);
    const path = previo?.archivo_url as string | null | undefined;
    if (path) {
      const { error: stErr } = await this.supabase.service.storage
        .from('documentos-flota')
        .remove([path]);
      if (stErr) {
        this.logger.warn(
          `No se pudo borrar la póliza del seguro ${seguroId}: ${stErr.message}`,
        );
      }
    }
    return { ok: true };
  }

  /**
   * URL firmada (1 h) de la copia de la póliza. Mismo contrato que
   * expirations.archivoSignedUrl: el bucket es privado y el panel pide la
   * URL al momento de VER, nunca la persiste.
   */
  async seguroArchivoSignedUrl(seguroId: string): Promise<{ url: string }> {
    const { data, error } = await this.supabase.service
      .from('aeronave_seguro')
      .select('archivo_url')
      .eq('id', seguroId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Seguro ${seguroId} not found`);
    const path = data.archivo_url as string | null;
    if (!path) {
      throw new NotFoundException('Este seguro no tiene archivo adjunto');
    }
    const { data: signed, error: signErr } = await this.supabase.service.storage
      .from('documentos-flota')
      .createSignedUrl(path, 3600);
    if (signErr || !signed?.signedUrl) {
      throw new NotFoundException(
        `No se pudo firmar el archivo: ${signErr?.message ?? 'sin URL'}`,
      );
    }
    return { url: signed.signedUrl };
  }

  // ============ Discrepancias (squawks) ============

  async listDiscrepancias(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_discrepancia')
      .select(DISCREPANCIA_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('fecha_reporte', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createDiscrepancia(
    aeronaveId: string,
    dto: CreateDiscrepanciaDto,
    userId: string,
  ) {
    await this.findById(aeronaveId);
    const estado = dto.estado ?? 'ABIERTA';
    const { data, error } = await this.supabase.service
      .from('aeronave_discrepancia')
      .insert({
        aeronave_id: aeronaveId,
        vuelo_id: dto.vuelo_id ?? null,
        descripcion: dto.descripcion,
        severidad: dto.severidad ?? 'MEDIA',
        estado,
        reportado_por: userId,
        fecha_reporte: dto.fecha_reporte ?? null,
        resolucion: dto.resolucion ?? null,
        fecha_resolucion:
          estado === 'RESUELTA'
            ? (dto.fecha_resolucion ?? new Date().toISOString().slice(0, 10))
            : null,
        resuelto_por: estado === 'RESUELTA' ? userId : null,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(DISCREPANCIA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateDiscrepancia(
    id: string,
    dto: UpdateDiscrepanciaDto,
    userId: string,
  ) {
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.descripcion !== undefined) patch.descripcion = dto.descripcion;
    if (dto.severidad !== undefined) patch.severidad = dto.severidad;
    if (dto.vuelo_id !== undefined) patch.vuelo_id = dto.vuelo_id;
    if (dto.fecha_reporte !== undefined)
      patch.fecha_reporte = dto.fecha_reporte;
    if (dto.resolucion !== undefined) patch.resolucion = dto.resolucion;
    if (dto.notas !== undefined) patch.notas = dto.notas;
    if (dto.estado !== undefined) {
      patch.estado = dto.estado;
      // Al resolver, sella quién y cuándo (si no se especifica fecha).
      if (dto.estado === 'RESUELTA') {
        patch.resuelto_por = userId;
        patch.fecha_resolucion =
          dto.fecha_resolucion ?? new Date().toISOString().slice(0, 10);
      }
    }
    if (dto.fecha_resolucion !== undefined)
      patch.fecha_resolucion = dto.fecha_resolucion;

    const { data, error } = await this.supabase.service
      .from('aeronave_discrepancia')
      .update(patch)
      .eq('id', id)
      .select(DISCREPANCIA_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Discrepancia ${id} not found`);
    return data;
  }

  async deleteDiscrepancia(id: string) {
    const { error } = await this.supabase.service
      .from('aeronave_discrepancia')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  async listOverhaulReserves(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('reserva_overhaul')
      .select(
        'id, motor_id, monto_por_hora_usd, horas_acumuladas, notas, motor:motor_id(posicion, numero_serie)',
      )
      .eq('aeronave_id', aeronaveId);
    if (error) throw new Error(error.message);
    // Horas mostradas = base manual + voladas derivadas de escalas (ver horasVoladas).
    const voladas = await this.horasVoladas(aeronaveId);
    return (data ?? []).map((r) => ({
      ...r,
      horas_acumuladas: Number(
        (Number(r.horas_acumuladas ?? 0) + voladas).toFixed(2),
      ),
    }));
  }

  // ============ Imagenes ============

  async listImagenes(aeronaveId: string) {
    await this.findById(aeronaveId);
    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .select(IMAGEN_COLS)
      .eq('aeronave_id', aeronaveId)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createImagen(
    aeronaveId: string,
    dto: CreateAeronaveImagenDto,
    userId: string,
  ) {
    await this.findById(aeronaveId);

    // Si es_principal=true, desmarcamos cualquier otra previa (unique index lo
    // exige y damos UX consistente sin pedir al frontend hacer dos llamadas).
    if (dto.es_principal) {
      await this.unsetPrincipal(aeronaveId);
    }

    // Si no hay imagenes todavia, esta automaticamente es la principal.
    const existing = (await this.listImagenes(aeronaveId)) as {
      orden: number;
    }[];
    const esPrincipal = dto.es_principal ?? existing.length === 0;
    const nextOrden =
      existing.length > 0 ? Math.max(...existing.map((i) => i.orden)) + 1 : 0;

    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .insert({
        aeronave_id: aeronaveId,
        storage_path: dto.storage_path,
        url: dto.url,
        alt_text: dto.alt_text,
        es_principal: esPrincipal,
        orden: nextOrden,
        size_bytes: dto.size_bytes,
        content_type: dto.content_type,
        created_by: userId,
        updated_by: userId,
      })
      .select(IMAGEN_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  async updateImagen(
    imagenId: string,
    dto: UpdateAeronaveImagenDto,
    userId: string,
  ) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Empty patch');
    }

    // Cargamos primero para resolver aeronave_id antes de tocar principales.
    const { data: current, error: currentErr } = await this.supabase.service
      .from('aeronave_imagen')
      .select('id, aeronave_id, es_principal')
      .eq('id', imagenId)
      .maybeSingle();
    if (currentErr) throw new Error(currentErr.message);
    if (!current) throw new NotFoundException(`imagen ${imagenId} not found`);

    // Si vamos a marcar como principal, desmarcamos las otras.
    if (dto.es_principal === true && !current.es_principal) {
      await this.unsetPrincipal(current.aeronave_id as string);
    }
    // Etiqueta del PDF (EXTERIOR/INTERIOR): única por aeronave — se limpia
    // de la imagen que la tuviera antes (índice único parcial en BD).
    if (dto.etiqueta === 'EXTERIOR' || dto.etiqueta === 'INTERIOR') {
      await this.supabase.service
        .from('aeronave_imagen')
        .update({ etiqueta: null, updated_by: userId })
        .eq('aeronave_id', current.aeronave_id as string)
        .eq('etiqueta', dto.etiqueta);
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.alt_text !== undefined) patch.alt_text = dto.alt_text;
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.es_principal !== undefined) patch.es_principal = dto.es_principal;
    if (dto.etiqueta !== undefined) patch.etiqueta = dto.etiqueta;

    const { data, error } = await this.supabase.service
      .from('aeronave_imagen')
      .update(patch)
      .eq('id', imagenId)
      .select(IMAGEN_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`imagen ${imagenId} not found`);
    return data;
  }

  async deleteImagen(imagenId: string) {
    const { data: current, error: currentErr } = await this.supabase.service
      .from('aeronave_imagen')
      .select('id, aeronave_id, storage_path, es_principal')
      .eq('id', imagenId)
      .maybeSingle();
    if (currentErr) throw new Error(currentErr.message);
    if (!current) throw new NotFoundException(`imagen ${imagenId} not found`);

    // 1. Borramos el archivo del bucket (best-effort; si falla, no bloqueamos
    //    el delete de la fila para no dejar registros huerfanos).
    const { error: storageErr } = await this.supabase.service.storage
      .from(IMAGENES_BUCKET)
      .remove([current.storage_path as string]);
    if (storageErr) {
      console.warn(
        `Could not remove storage object ${current.storage_path}: ${storageErr.message}`,
      );
    }

    // 2. Borramos la fila.
    const { error } = await this.supabase.service
      .from('aeronave_imagen')
      .delete()
      .eq('id', imagenId);
    if (error) throw new Error(error.message);

    // 3. Si era la principal, promovemos a la siguiente (la de menor orden).
    if (current.es_principal) {
      const next = await this.listImagenes(current.aeronave_id as string);
      if (next.length > 0) {
        await this.supabase.service
          .from('aeronave_imagen')
          .update({ es_principal: true })
          .eq('id', next[0].id);
      }
    }

    return { ok: true };
  }

  private async unsetPrincipal(aeronaveId: string): Promise<void> {
    const { error } = await this.supabase.service
      .from('aeronave_imagen')
      .update({ es_principal: false })
      .eq('aeronave_id', aeronaveId)
      .eq('es_principal', true);
    if (error) throw new Error(error.message);
  }
}
