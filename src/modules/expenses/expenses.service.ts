import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  PyservicesService,
  type TablaColumnaPayload,
} from '../pyservices/pyservices.service';
import { Rol } from '../../common/types/auth.types';
import type {
  CreateGastoDto,
  ListGastosQuery,
  UpdateGastoDto,
} from './dto/expenses.dto';

const COLS =
  'id, vuelo_id, aeronave_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, fecha_gasto, proveedor_id, medio_pago, tarjeta_terminacion, litros, tipo_combustible, lugar, fecha_hora_carga, estatus_comprobante, foto_url, valor_ia_extraido, conciliado, duplicado_sospechado, notas, created_at, updated_at';

// Para el panel admin: nombres legibles de proveedor, avión y persona que capturó.
const LIST_COLS = `${COLS}, proveedor:proveedor!proveedor_id(nombre), aeronave:aeronave!aeronave_id(matricula), captura:usuario!usuario_captura_id(nombre)`;

/** Ventana en días para considerar dos gastos como posible duplicado. */
const DUP_DAYS = 3;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly pyservices: PyservicesService,
  ) {}

  /** Gastos por avión/categoría en Excel (respeta los filtros del listado). */
  async listXlsx(filters: ListGastosQuery): Promise<Buffer> {
    const { data } = await this.list({ ...filters, limit: 5000, offset: 0 });
    const columnas: TablaColumnaPayload[] = [
      { label: 'Fecha' },
      { label: 'Categoría' },
      { label: 'Avión' },
      { label: 'Proveedor' },
      { label: 'Medio pago' },
      { label: 'Comprobante' },
      { label: 'Moneda' },
      { label: 'Monto', tipo: 'money' },
    ];
    const filas = data.map((g) => {
      const x = g as Record<string, unknown>;
      const aeronave = x.aeronave as { matricula?: string } | null;
      const proveedor = x.proveedor as { nombre?: string } | null;
      return [
        (x.fecha_gasto as string) ?? '',
        (x.categoria as string) ?? '',
        aeronave?.matricula ?? '(pendiente)',
        proveedor?.nombre ?? '',
        (x.medio_pago as string) ?? '',
        (x.estatus_comprobante as string) ?? '',
        (x.moneda as string) ?? '',
        Number(x.monto),
      ];
    });
    return this.pyservices.generateTablaXlsx({
      titulo: 'Gastos por avión / categoría',
      subtitulo: `Generado ${new Date().toISOString().slice(0, 10)}`,
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
    if (filters.usuario_captura_id) q = q.eq('usuario_captura_id', filters.usuario_captura_id);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.estatus_comprobante) q = q.eq('estatus_comprobante', filters.estatus_comprobante);
    if (filters.medio_pago) q = q.eq('medio_pago', filters.medio_pago);
    if (filters.desde) q = q.gte('fecha_gasto', filters.desde);
    if (filters.hasta) q = q.lte('fecha_gasto', filters.hasta);
    // Pendiente = sin avión asignado (la bandeja debe quedar siempre vacía).
    if (filters.pendientes === true) q = q.is('aeronave_id', null);
    if (filters.duplicados === true) q = q.eq('duplicado_sospechado', true);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
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
   * pertenece? Candidatos DETERMINISTAS = vuelos donde el capturista voló
   * (piloto/copiloto/por tramo) con fecha a ±3 días del gasto. Si hay
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
      return sinMatch('El gasto no tiene fecha o capturista para buscar vuelos.');
    }

    // Vuelos propios no cancelados en ±3 días de la fecha del gasto.
    const base = new Date(`${fecha}T12:00:00-05:00`);
    const lo = new Date(base.getTime() - 3 * 86400_000).toISOString();
    const hi = new Date(base.getTime() + 3 * 86400_000).toISOString();
    const { data: vuelos, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, fecha_vuelo, piloto_id, copiloto_id, estado, aeronave_id, aeronave:aeronave_id(matricula), escalas:escala(orden, origen_iata, destino_iata, piloto_id)',
      )
      .neq('estado', 'CANCELADO')
      .eq('es_externo', false)
      .gte('fecha_vuelo', lo)
      .lte('fecha_vuelo', hi);
    if (error) throw new Error(error.message);

    const participo = (v: Record<string, unknown>): boolean => {
      if (v.piloto_id === capturo || v.copiloto_id === capturo) return true;
      const escalas = (v.escalas as Array<Record<string, unknown>> | null) ?? [];
      return escalas.some((e) => e.piloto_id === capturo);
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
      const a = v.aeronave as { matricula?: string } | { matricula?: string }[] | null;
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
      }));

    if (candidatos.length === 0) {
      return sinMatch(
        'El piloto no tiene vuelos en ±3 días de la fecha del gasto: asignar a mano.',
      );
    }

    // Regla fuerte: exactamente UN vuelo del capturista el MISMO día (Cancún).
    const diaCancun = (iso: string | null) =>
      iso
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
            new Date(iso),
          )
        : null;
    const mismoDia = candidatos.filter((c) => diaCancun(c.fecha_vuelo) === fecha);
    if (mismoDia.length === 1) {
      return {
        sugerido: mismoDia[0],
        confianza: 0.95,
        razon: 'Único vuelo del piloto ese día.',
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
      })),
    });
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
    const pick = candidatos.find((c) => c.vuelo_id === ia.vuelo_id_sugerido) ?? null;
    return {
      sugerido: pick,
      confianza: pick ? ia.confianza : 0,
      razon: ia.razon || (pick ? 'Match propuesto por IA.' : 'Sin coincidencias claras.'),
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
      .neq('categoria', 'FIJO')
      .order('fecha_gasto', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    const pendientes = (data ?? []) as Array<Record<string, unknown>>;

    const resumen = (g: Record<string, unknown>) => {
      const cap = g.captura as { nombre?: string } | { nombre?: string }[] | null;
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

  async create(dto: CreateGastoDto, userId: string, rol?: Rol) {
    // El mecánico solo puede cargar combustible (GAS).
    if (rol === Rol.MECANICO && dto.categoria !== 'GAS') {
      throw new BadRequestException('El mecánico solo puede cargar combustible (GAS).');
    }
    const payload: Record<string, unknown> = {
      usuario_captura_id: userId,
      categoria: dto.categoria,
      monto: dto.monto,
      moneda: dto.moneda,
      tc_gasto: dto.tc_gasto,
      fecha_gasto: dto.fecha_gasto,
      medio_pago: dto.medio_pago,
      tarjeta_terminacion: dto.tarjeta_terminacion,
      vuelo_id: dto.vuelo_id,
      aeronave_id: dto.aeronave_id,
      proveedor_id: dto.proveedor_id,
      litros: dto.litros,
      tipo_combustible: dto.tipo_combustible,
      lugar: dto.lugar,
      fecha_hora_carga: dto.fecha_hora_carga,
      estatus_comprobante: dto.estatus_comprobante ?? 'SIN_COMPROBANTE',
      foto_url: dto.foto_url,
      valor_ia_extraido: dto.valor_ia_extraido,
      duplicado_sospechado: await this.looksLikeDuplicate(dto),
      notas: dto.notas,
      created_by: userId,
      updated_by: userId,
    };

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert(payload)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }

    // Aviso a admin: el piloto subió un gasto desde campo.
    void this.notifications.notifyRole(
      Rol.ADMIN,
      {
        tipo: 'gasto_registrado',
        titulo: 'Gasto registrado',
        cuerpo: `${dto.categoria} · ${dto.moneda} ${Number(dto.monto).toLocaleString('en-US')}`,
        data: { gasto_id: (data as { id: string }).id, vuelo_id: dto.vuelo_id ?? null },
        link: dto.vuelo_id ? `/admin/flights/${dto.vuelo_id}` : '/admin/expenses',
      },
      userId,
    );

    return data!;
  }

  /**
   * Posible duplicado (doble captura). Dos reglas, deterministas — más fiable
   * que IA para esto:
   * - CON proveedor: mismo proveedor + monto + moneda, fecha ±DUP_DAYS
   *   (regla del diseño funcional).
   * - SIN proveedor (capturas del piloto/mecánico desde la app): misma
   *   categoría + monto + moneda, fecha ±1 día — ventana corta para no marcar
   *   falsos positivos (dos taxis iguales en días distintos).
   * El flag NUNCA bloquea: la app avisa al capturista y el admin lo lista.
   */
  private async looksLikeDuplicate(dto: CreateGastoDto): Promise<boolean> {
    const base = new Date(`${dto.fecha_gasto}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) return false;
    const dias = dto.proveedor_id ? DUP_DAYS : 1;
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

    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, origen_iata, destino_iata, estado, fecha_vuelo, fecha_traslado_final, aeronave_id, escalas:escala(aeronave_id, fecha_salida_plan, hora_salida, hora_llegada)',
      )
      .neq('estado', 'CANCELADO')
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
    const enRuta = deAvion.find(
      (c) =>
        (t >= c.inicio - VENTANA_ANTES_MS && t <= c.fin + VENTANA_DESPUES_MS) ||
        (c.v.estado === 'EN_VUELO' && t >= c.inicio - VENTANA_ANTES_MS),
    );
    // 2) Previno: la siguiente salida de la aeronave después de la carga.
    const siguiente = deAvion
      .filter((c) => c.inicio >= t)
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
   * Regla del doc 5.2/5.3: el CAPTURISTA (piloto/mecánico) corrige o borra su
   * gasto SOLO el mismo día de la captura (hora Cancún) y solo si aún no está
   * conciliado. Después, únicamente oficina. Lanza si no cumple.
   */
  async assertOwnSameDay(id: string, userId: string): Promise<void> {
    const gasto = await this.findById(id);
    if (gasto.usuario_captura_id !== userId) {
      throw new ForbiddenException('Solo puedes corregir gastos capturados por ti.');
    }
    if (gasto.conciliado === true) {
      throw new ConflictException(
        'Este gasto ya está conciliado con el banco; pide el ajuste a oficina.',
      );
    }
    const dia = (iso: string | Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Cancun' }).format(
        typeof iso === 'string' ? new Date(iso) : iso,
      );
    if (dia(gasto.created_at as string) !== dia(new Date())) {
      throw new ForbiddenException(
        'Los gastos solo se corrigen el mismo día. Pide el ajuste a oficina.',
      );
    }
  }

  async update(id: string, dto: UpdateGastoDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('gasto')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(`Referenced entity not found: ${error.message}`);
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.service.from('gasto').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }
}
