import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ExpirationsService } from '../expirations/expirations.service';
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
  'id, matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, permiso_afac_usd_hr, color_calendario, ubicacion_base, activa, notas, servicio_intervalos, servicio_horas_base, created_at, updated_at';

const SEGURO_COLS =
  'id, aeronave_id, aseguradora, num_poliza, cobertura, suma_asegurada_usd, prima_usd, vigente_desde, vigente_hasta, archivo_url, notas, created_at, updated_at';

const DISCREPANCIA_COLS =
  'id, aeronave_id, vuelo_id, descripcion, severidad, estado, reportado_por, fecha_reporte, resolucion, fecha_resolucion, resuelto_por, notas, created_at, updated_at';

const IMAGEN_COLS =
  'id, aeronave_id, storage_path, url, alt_text, orden, es_principal, size_bytes, content_type, created_at, updated_at';

const IMAGENES_BUCKET = 'aeronave-imagenes';

@Injectable()
export class AircraftService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly expirations: ExpirationsService,
  ) {}

  /**
   * Métricas operativas del avión para el expediente:
   *  - airworthiness ("apto para volar"): documentos críticos vencidos +
   *    servicio en taller + componentes con TBO agotado.
   *  - utilización: horas voladas y # de vuelos (mes / año / total).
   *  - finanzas: ingresos cobrados vs gastos por moneda.
   */
  async aircraftMetrics(id: string) {
    await this.findById(id);
    const now = new Date();
    const startMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const startYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();

    const [motorsRes, tallerRes, blocking, escalasRes, cobrosRes, gastosRes] =
      await Promise.all([
        this.supabase.service
          .from('motor')
          .select('posicion, numero_serie, horas_totales, turm, tbo_horas, aeronave_horas_ref')
          .eq('aeronave_id', id),
        this.supabase.service
          .from('mantenimiento')
          .select('id')
          .eq('aeronave_id', id)
          .eq('estado', 'EN_TALLER')
          .limit(1),
        this.expirations.findBlockingExpirations({ aeronaveId: id }),
        this.supabase.service
          .from('escala')
          .select(
            'taco_salida, taco_llegada, vuelo:vuelo_id!inner(id, aeronave_id, fecha_vuelo, estado)',
          )
          .eq('vuelo.aeronave_id', id)
          .neq('vuelo.estado', 'CANCELADO'),
        this.supabase.service
          .from('cobro_vuelo')
          .select('monto, moneda, vuelo:vuelo_id!inner(aeronave_id, estado)')
          .eq('vuelo.aeronave_id', id)
          .neq('vuelo.estado', 'CANCELADO'),
        this.supabase.service
          .from('gasto')
          .select('monto, moneda')
          .eq('aeronave_id', id),
      ]);
    if (motorsRes.error) throw new Error(motorsRes.error.message);
    if (tallerRes.error) throw new Error(tallerRes.error.message);
    if (escalasRes.error) throw new Error(escalasRes.error.message);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);

    const enTaller = (tallerRes.data ?? []).length > 0;

    // Utilización: suma de horas (taco_llegada - taco_salida) y # de vuelos.
    let horasTotal = 0;
    let horasMes = 0;
    let horasAnio = 0;
    let maxHobbs = 0; // último horómetro conocido (para horas de vida vivas)
    const vuelosTotal = new Set<string>();
    const vuelosMes = new Set<string>();
    const vuelosAnio = new Set<string>();
    for (const e of (escalasRes.data ?? []) as Array<Record<string, unknown>>) {
      if (e.taco_salida != null) maxHobbs = Math.max(maxHobbs, Number(e.taco_salida));
      if (e.taco_llegada != null) maxHobbs = Math.max(maxHobbs, Number(e.taco_llegada));
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
    const componentesVencidos = (motorsRes.data ?? [])
      .map((m: Record<string, unknown>) => ({
        posicion: m.posicion as string,
        numero_serie: m.numero_serie as string,
        restantes: this.componenteEstado(m, maxHobbs, true).tbo_restante ?? 1,
      }))
      .filter((m) => m.restantes <= 0);

    // Finanzas por moneda: ingresos cobrados vs gastos.
    const byMoneda = new Map<string, { ingresos: number; gastos: number }>();
    const bump = (moneda: string, key: 'ingresos' | 'gastos', monto: number) => {
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

    return {
      airworthiness: {
        apto:
          blocking.length === 0 && !enTaller && componentesVencidos.length === 0,
        documentos_vencidos: blocking,
        en_taller: enTaller,
        componentes_vencidos: componentesVencidos,
      },
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
    const { data, error } = await this.supabase.service
      .from('escala')
      .select(
        'id, origen_iata, destino_iata, taco_salida, taco_llegada, hora_salida, hora_llegada, foto_taco_salida_url, foto_taco_llegada_url, vuelo:vuelo_id!inner(id, folio, fecha_vuelo, aeronave_id, estado)',
      )
      .eq('vuelo.aeronave_id', id)
      .neq('vuelo.estado', 'CANCELADO')
      .not('taco_salida', 'is', null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

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
      if (e.foto_taco_salida_url) fotoPaths.push(e.foto_taco_salida_url as string);
      if (e.foto_taco_llegada_url) fotoPaths.push(e.foto_taco_llegada_url as string);
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
        const v = e.vuelo as { folio?: number; fecha_vuelo?: string | null };
        const s = e.taco_salida == null ? null : Number(e.taco_salida);
        const l = e.taco_llegada == null ? null : Number(e.taco_llegada);
        return {
          escala_id: e.id as string,
          folio: v.folio ?? null,
          fecha: (e.hora_salida as string | null) ?? v.fecha_vuelo ?? null,
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

    // Motores y hélices con horas de vida vivas + estatus de overhaul (TBO).
    const [motoresRes, helicesRes] = await Promise.all([
      this.supabase.service
        .from('motor')
        .select('id, posicion, numero_serie, horas_totales, turm, tbo_horas, aeronave_horas_ref')
        .eq('aeronave_id', id)
        .order('posicion'),
      this.supabase.service
        .from('helice')
        .select('id, posicion, numero_serie, horas_totales, tbo_horas, aeronave_horas_ref')
        .eq('aeronave_id', id)
        .order('posicion'),
    ]);
    const componentes = [
      ...(motoresRes.data ?? []).map((m) => ({
        tipo: 'MOTOR' as const,
        posicion: m.posicion as string,
        numero_serie: m.numero_serie as string,
        ...this.componenteEstado(m, horasActuales, true),
        tbo_horas: m.tbo_horas != null ? Number(m.tbo_horas) : null,
      })),
      ...(helicesRes.data ?? []).map((h) => ({
        tipo: 'HELICE' as const,
        posicion: h.posicion as string,
        numero_serie: h.numero_serie as string,
        ...this.componenteEstado(h, horasActuales, false),
        tbo_horas: h.tbo_horas != null ? Number(h.tbo_horas) : null,
      })),
    ];

    return {
      horas_actuales: Number(horasActuales.toFixed(1)),
      servicio_intervalos: intervalos,
      servicio_horas_base: base,
      proximo_servicio: this.proximoServicio(intervalos, base, horasActuales),
      componentes,
      historial: items,
    };
  }

  /**
   * Próximo umbral de servicio: recorre la secuencia de intervalos (cíclica)
   * desde `base` y devuelve el primer umbral por encima de `horas`. Null si no
   * hay programa configurado.
   */
  proximoServicio(intervalos: number[], base: number, horas: number) {
    const ints = intervalos.filter((n) => Number(n) > 0).map(Number);
    if (ints.length === 0) return null;
    let acc = base;
    for (let i = 0; i < 100000; i++) {
      acc += ints[i % ints.length];
      if (acc > horas) {
        return {
          a_las: Number(acc.toFixed(1)),
          intervalo: ints[i % ints.length],
          faltan: Number((acc - horas).toFixed(1)),
        };
      }
    }
    return null;
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
        .in('aeronave_id', rows.map((a) => a.id as string))
        .eq('es_principal', true);
      const porAvion = new Map(
        (imgs ?? []).map((i) => [i.aeronave_id as string, i.url as string]),
      );
      for (const a of rows) {
        a.imagen_principal_url = porAvion.get(a.id as string) ?? null;
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
            'id, posicion, numero_serie, tipo, horas_totales, turm, tbo_horas, aeronave_horas_ref',
          )
          .eq('aeronave_id', id)
          .order('posicion'),
        this.supabase.service
          .from('helice')
          .select('id, posicion, numero_serie, horas_totales, tbo_horas, aeronave_horas_ref')
          .eq('aeronave_id', id)
          .order('posicion'),
        this.supabase.service
          .from('aeronave_socio')
          .select(
            'id, socio_id, porcentaje, vigente_desde, vigente_hasta, notas, usuario:socio_id(nombre, es_empresa, rol)',
          )
          .eq('aeronave_id', id)
          .is('vigente_hasta', null)
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
    const propellers = (propellersRes.data ?? []).map((p) => ({
      ...p,
      ...this.componenteEstado(p, hobbs, false),
    }));

    // Reserva de overhaul: horas mostradas = base manual + voladas DERIVADAS.
    const voladas = await this.horasVoladas(id);
    const overhaulReserves = (reservesRes.data ?? []).map((r) => ({
      ...r,
      horas_acumuladas: Number(
        (Number(r.horas_acumuladas ?? 0) + voladas).toFixed(2),
      ),
    }));

    return {
      ...aeronave,
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
   * Siempre excluye vuelos CANCELADOS.
   */
  private async escalasDelAvion(
    aeronaveId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const [propias, heredadas] = await Promise.all([
      // Tramos asignados explícitamente a este avión (escala.aeronave_id).
      this.supabase.service
        .from('escala')
        .select('taco_salida, taco_llegada, vuelo:vuelo_id!inner(estado)')
        .eq('aeronave_id', aeronaveId)
        .neq('vuelo.estado', 'CANCELADO'),
      // Tramos sin avión propio: heredan el del vuelo.
      this.supabase.service
        .from('escala')
        .select(
          'taco_salida, taco_llegada, vuelo:vuelo_id!inner(aeronave_id, estado)',
        )
        .is('aeronave_id', null)
        .eq('vuelo.aeronave_id', aeronaveId)
        .neq('vuelo.estado', 'CANCELADO'),
    ]);
    // Nunca degradar a [] en silencio: estas escalas alimentan horas/hobbs.
    if (propias.error) throw new Error(propias.error.message);
    if (heredadas.error) throw new Error(heredadas.error.message);
    return [
      ...((propias.data ?? []) as Array<Record<string, unknown>>),
      ...((heredadas.data ?? []) as Array<Record<string, unknown>>),
    ];
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

  /** Horas actuales (último Hobbs) de un avión = máximo tacómetro registrado. */
  private async currentHobbs(aeronaveId: string): Promise<number> {
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
   * overhaul (TBO). El motor descuenta desde su último overhaul (turm); la
   * hélice desde 0. Si no hay referencia/TBO, devuelve los valores que se puedan.
   */
  private componenteEstado(
    c: Record<string, unknown>,
    hobbs: number,
    conTurm: boolean,
  ): { horas_actuales: number; tbo_restante: number | null } {
    const ht = Number(c.horas_totales ?? 0);
    const ref = c.aeronave_horas_ref != null ? Number(c.aeronave_horas_ref) : null;
    const horasActuales =
      ref != null ? Number((ht + Math.max(0, hobbs - ref)).toFixed(1)) : ht;
    const tbo = Number(c.tbo_horas ?? 0);
    const desdeOverhaul = conTurm ? horasActuales - Number(c.turm ?? 0) : horasActuales;
    const tboRestante = tbo > 0 ? Number((tbo - desdeOverhaul).toFixed(1)) : null;
    return { horas_actuales: horasActuales, tbo_restante: tboRestante };
  }

  async create(dto: CreateAeronaveDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(AERONAVE_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('matricula already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateAeronaveDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .update({ ...dto, updated_by: updatedBy })
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
    if (!includeHistory) q = q.is('vigente_hasta', null);
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

  async createSeguro(aeronaveId: string, dto: CreateAeronaveSeguroDto, userId: string) {
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

  async updateSeguro(seguroId: string, dto: UpdateAeronaveSeguroDto, userId: string) {
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.aseguradora !== undefined) patch.aseguradora = dto.aseguradora;
    if (dto.num_poliza !== undefined) patch.num_poliza = dto.num_poliza;
    if (dto.cobertura !== undefined) patch.cobertura = dto.cobertura;
    if (dto.suma_asegurada_usd !== undefined) patch.suma_asegurada_usd = dto.suma_asegurada_usd;
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
    return data;
  }

  async deleteSeguro(seguroId: string) {
    const { error } = await this.supabase.service
      .from('aeronave_seguro')
      .delete()
      .eq('id', seguroId);
    if (error) throw new Error(error.message);
    return { ok: true };
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

  async createDiscrepancia(aeronaveId: string, dto: CreateDiscrepanciaDto, userId: string) {
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
          estado === 'RESUELTA' ? (dto.fecha_resolucion ?? new Date().toISOString().slice(0, 10)) : null,
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

  async updateDiscrepancia(id: string, dto: UpdateDiscrepanciaDto, userId: string) {
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.descripcion !== undefined) patch.descripcion = dto.descripcion;
    if (dto.severidad !== undefined) patch.severidad = dto.severidad;
    if (dto.vuelo_id !== undefined) patch.vuelo_id = dto.vuelo_id;
    if (dto.fecha_reporte !== undefined) patch.fecha_reporte = dto.fecha_reporte;
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
    if (dto.fecha_resolucion !== undefined) patch.fecha_resolucion = dto.fecha_resolucion;

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

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.alt_text !== undefined) patch.alt_text = dto.alt_text;
    if (dto.orden !== undefined) patch.orden = dto.orden;
    if (dto.es_principal !== undefined) patch.es_principal = dto.es_principal;

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
