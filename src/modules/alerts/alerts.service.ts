import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { AircraftService } from '../aircraft/aircraft.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService, type NotificationInput } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';

export interface AlertConfig {
  clave: string;
  descripcion: string;
  activa: boolean;
  canal: 'socket' | 'email' | 'ambos';
  roles: string[];
  dias_anticipacion: number[];
  horas_anticipacion: number | null;
}

function unwrap<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly aircraft: AircraftService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  // ===== Cron =====

  @Cron(CronExpression.EVERY_HOUR)
  async runHourly(): Promise<void> {
    await this.safe('permiso_pista', (c) => this.checkPermisoPista(c));
  }

  /**
   * Recordatorio al piloto de capturar el tacómetro de SALIDA antes del vuelo.
   * Corre cada minuto y avisa a 15, 10 y 5 min de la salida si aún no se ha
   * capturado. Cada umbral se envía una sola vez (dedupe vía notificacion).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async runTacoReminders(): Promise<void> {
    try {
      await this.checkTacoReminders();
    } catch (err) {
      this.logger.warn(
        `runTacoReminders falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private static readonly TACO_UMBRALES = [15, 10, 5] as const;

  private async checkTacoReminders(): Promise<void> {
    const now = Date.now();
    const desde = new Date(now).toISOString();
    const hasta = new Date(now + 16 * 60_000).toISOString();

    // Vuelos propios, operables, con piloto y salida en los próximos ~16 min.
    const { data: vuelos, error } = await this.supabase.service
      .from('vuelo')
      .select('id, folio, piloto_id, origen_iata, destino_iata, fecha_vuelo, estado')
      .eq('es_externo', false)
      .not('piloto_id', 'is', null)
      .not('fecha_vuelo', 'is', null)
      .in('estado', ['RESERVA', 'SOLICITUD', 'COTIZADO', 'CONFIRMADO', 'EN_VUELO'])
      .gte('fecha_vuelo', desde)
      .lte('fecha_vuelo', hasta);
    if (error) throw new Error(error.message);
    if (!vuelos || vuelos.length === 0) return;

    for (const v of vuelos) {
      const salida = new Date(v.fecha_vuelo as string).getTime();
      const minutos = (salida - now) / 60_000;

      // El umbral que cae en esta ventana de 1 min (con tolerancia a desfase).
      const umbral = AlertsService.TACO_UMBRALES.find(
        (t) => minutos <= t && minutos > t - 1.5,
      );
      if (!umbral) continue;

      // ¿Ya se capturó el tacómetro de salida (tramo orden=1)?
      const { data: primerTramo } = await this.supabase.service
        .from('escala')
        .select('taco_salida')
        .eq('vuelo_id', v.id as string)
        .eq('orden', 1)
        .maybeSingle();
      if (primerTramo && primerTramo.taco_salida !== null) continue;

      // Dedupe: ¿ya se envió este umbral para este vuelo?
      const { count } = await this.supabase.service
        .from('notificacion')
        .select('id', { count: 'exact', head: true })
        .eq('tipo', 'recordatorio_taco')
        .eq('data->>vuelo_id', v.id as string)
        .eq('data->>umbral', String(umbral));
      if ((count ?? 0) > 0) continue;

      await this.notifications.notifyUser(v.piloto_id as string, {
        tipo: 'recordatorio_taco',
        titulo: `Captura el tacómetro · faltan ${umbral} min`,
        cuerpo: `Vuelo ${v.origen_iata as string} → ${v.destino_iata as string} (#${v.folio as number}). Sube la lectura de salida antes de despegar.`,
        data: { vuelo_id: v.id, folio: v.folio, umbral },
        link: `/flights/${v.id as string}`,
      });
      this.logger.log(
        `Recordatorio taco #${v.folio as number} · ${umbral} min → piloto ${v.piloto_id as string}`,
      );
    }
  }

  @Cron('0 8 * * *', { timeZone: 'America/Cancun' })
  async runDaily(): Promise<void> {
    await this.safe('vencimiento', (c) => this.checkVencimientos(c));
    await this.safe('cobro_pendiente', (c) => this.checkCobrosPendientes(c));
    await this.safe('inventario_bajo', (c) => this.checkInventarioBajo(c));
    await this.safe('mantenimiento_programado', (c) => this.checkMantenimientos(c));
    await this.safe('servicio_horas', (c) => this.checkServicioPorHoras(c));
    await this.safe('caja_negativa', (c) => this.checkCajaNegativa(c));
    await this.safe('gastos_sin_avion', (c) => this.checkGastosSinAvion(c));
    await this.safe('vuelo_estancado', (c) => this.checkVuelosEstancados(c));
  }

  /** Dispara todas las reglas activas de inmediato (para pruebas / botón admin). */
  async runAll(): Promise<{ ejecutadas: string[] }> {
    const ejecutadas: string[] = [];
    for (const [clave, fn] of [
      ['permiso_pista', (c: AlertConfig) => this.checkPermisoPista(c)],
      ['vencimiento', (c: AlertConfig) => this.checkVencimientos(c)],
      ['cobro_pendiente', (c: AlertConfig) => this.checkCobrosPendientes(c)],
      ['inventario_bajo', (c: AlertConfig) => this.checkInventarioBajo(c)],
      ['mantenimiento_programado', (c: AlertConfig) => this.checkMantenimientos(c)],
      ['servicio_horas', (c: AlertConfig) => this.checkServicioPorHoras(c)],
      ['caja_negativa', (c: AlertConfig) => this.checkCajaNegativa(c)],
      ['gastos_sin_avion', (c: AlertConfig) => this.checkGastosSinAvion(c)],
      ['vuelo_estancado', (c: AlertConfig) => this.checkVuelosEstancados(c)],
    ] as const) {
      const ran = await this.safe(clave, fn);
      if (ran) ejecutadas.push(clave);
    }
    return { ejecutadas };
  }

  private async safe(
    clave: string,
    fn: (c: AlertConfig) => Promise<void>,
  ): Promise<boolean> {
    try {
      const config = await this.getConfig(clave);
      if (!config || !config.activa) return false;
      await fn(config);
      return true;
    } catch (err) {
      this.logger.error(
        `Alerta ${clave} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ===== Reglas =====

  /** Permiso de pista pendiente para un vuelo dentro de la ventana de anticipación. */
  private async checkPermisoPista(config: AlertConfig): Promise<void> {
    const horas = config.horas_anticipacion ?? 48;
    const limite = new Date(Date.now() + horas * 3600 * 1000);
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, folio, origen_iata, destino_iata, fecha_vuelo')
      .eq('estado_permiso', 'pendiente')
      .in('estado', ['CONFIRMADO', 'COTIZADO'])
      .not('fecha_vuelo', 'is', null)
      .gte('fecha_vuelo', new Date().toISOString())
      .lte('fecha_vuelo', limite.toISOString());
    if (error) throw new Error(error.message);

    for (const v of data ?? []) {
      const fecha = v.fecha_vuelo
        ? new Date(v.fecha_vuelo).toLocaleString('es-MX', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: 'America/Cancun',
          })
        : 'por confirmar';
      await this.dispatch(config, `permiso_pista:${v.id}`, {
        tipo: 'permiso_pista',
        titulo: 'Permiso de pista por vencer',
        cuerpo: `${v.origen_iata} → ${v.destino_iata} · folio #${v.folio} · vuela ${fecha} y el permiso sigue pendiente`,
        data: { vuelo_id: v.id, folio: v.folio },
        link: `/admin/flights/${v.id}`,
      });
    }
  }

  /** Documentos/licencias/permisos próximos a vencer, por cada umbral configurado. */
  private async checkVencimientos(config: AlertConfig): Promise<void> {
    const umbrales = config.dias_anticipacion.length > 0 ? config.dias_anticipacion : [30, 15, 7];
    for (const d of umbrales) {
      const target = dateOnly(new Date(Date.now() + d * 86400 * 1000));
      const { data, error } = await this.supabase.service
        .from('vencimiento')
        .select(
          'id, fecha_vencimiento, referencia, tipo_documento(nombre), aeronave(matricula), piloto:usuario!piloto_id(nombre)',
        )
        .eq('fecha_vencimiento', target);
      if (error) throw new Error(error.message);

      for (const row of data ?? []) {
        const tipo =
          unwrap(row.tipo_documento as unknown as { nombre: string } | { nombre: string }[] | null)
            ?.nombre ?? 'Documento';
        const aeronave = unwrap(
          row.aeronave as unknown as { matricula: string } | { matricula: string }[] | null,
        )?.matricula;
        const piloto = unwrap(
          row.piloto as unknown as { nombre: string } | { nombre: string }[] | null,
        )?.nombre;
        const entidad = aeronave ?? piloto ?? row.referencia ?? '';
        await this.dispatch(config, `venc:${row.id}:${d}`, {
          tipo: 'vencimiento',
          titulo: `Vence en ${d} días: ${tipo}`,
          cuerpo: `${tipo}${entidad ? ` de ${entidad}` : ''} vence el ${row.fecha_vencimiento}`,
          data: { vencimiento_id: row.id, dias: d },
        });
      }
    }
  }

  /** Mantenimientos programados próximos (por cada umbral configurado). */
  private async checkMantenimientos(config: AlertConfig): Promise<void> {
    const umbrales = config.dias_anticipacion.length > 0 ? config.dias_anticipacion : [15, 7, 1];
    for (const d of umbrales) {
      const target = dateOnly(new Date(Date.now() + d * 86400 * 1000));
      const { data, error } = await this.supabase.service
        .from('mantenimiento')
        .select('id, descripcion, fecha_programada, aeronave_id, aeronave(matricula)')
        .eq('tipo', 'PROGRAMADO')
        .is('fecha_realizada', null)
        .eq('fecha_programada', target);
      if (error) throw new Error(error.message);

      for (const m of data ?? []) {
        const matricula =
          unwrap(m.aeronave as unknown as { matricula: string } | { matricula: string }[] | null)
            ?.matricula ?? 'aeronave';
        await this.dispatch(config, `mant:${m.id}:${d}`, {
          tipo: 'mantenimiento_programado',
          titulo: `Mantenimiento en ${d} día(s): ${matricula}`,
          cuerpo: `${m.descripcion} (programado ${m.fecha_programada})`,
          data: { mantenimiento_id: m.id, aeronave_id: m.aeronave_id, dias: d },
          link: `/admin/aircraft/${m.aeronave_id}`,
        });
      }
    }
  }

  /** Vuelos completados sin cobrar tras X días. */
  private async checkCobrosPendientes(config: AlertConfig): Promise<void> {
    const umbrales = config.dias_anticipacion.length > 0 ? config.dias_anticipacion : [3];
    for (const d of umbrales) {
      const corte = new Date(Date.now() - d * 86400 * 1000).toISOString();
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select('id, folio, origen_iata, destino_iata, monto_total_usd, updated_at')
        .eq('estado', 'COMPLETADO')
        .eq('cobrado', false)
        .lte('updated_at', corte);
      if (error) throw new Error(error.message);

      for (const v of data ?? []) {
        await this.dispatch(config, `cobro:${v.id}:${d}`, {
          tipo: 'cobro_pendiente',
          titulo: 'Cobro pendiente',
          cuerpo: `Vuelo #${v.folio} (${v.origen_iata} → ${v.destino_iata}) completado sin cobrar · $${Number(v.monto_total_usd).toLocaleString('en-US')} USD`,
          data: { vuelo_id: v.id, folio: v.folio },
          link: `/admin/flights/${v.id}`,
        });
      }
    }
  }

  /** Ítems de inventario por debajo del stock mínimo (stock calculado del cardex). */
  private async checkInventarioBajo(config: AlertConfig): Promise<void> {
    const { data: items, error: itemsErr } = await this.supabase.service
      .from('inventario_item')
      .select('id, nombre, stock_minimo')
      .eq('activo', true);
    if (itemsErr) throw new Error(itemsErr.message);
    if (!items || items.length === 0) return;

    const { data: movs, error: movsErr } = await this.supabase.service
      .from('inventario_movimiento')
      .select('item_id, tipo, cantidad');
    if (movsErr) throw new Error(movsErr.message);

    const stock = new Map<string, number>();
    for (const m of movs ?? []) {
      const cant = Number(m.cantidad);
      const signo = m.tipo === 'SALIDA' ? -cant : m.tipo === 'AJUSTE' ? cant : cant; // ENTRADA/DEVOLUCION/AJUSTE suman; SALIDA resta
      stock.set(m.item_id as string, (stock.get(m.item_id as string) ?? 0) + signo);
    }

    const mes = dateOnly(new Date()).slice(0, 7); // YYYY-MM: re-alerta a lo sumo 1 vez al mes por ítem
    for (const it of items) {
      const actual = stock.get(it.id as string) ?? 0;
      const minimo = Number(it.stock_minimo);
      if (minimo > 0 && actual < minimo) {
        await this.dispatch(config, `inv:${it.id}:${mes}`, {
          tipo: 'inventario_bajo',
          titulo: 'Inventario bajo',
          cuerpo: `${it.nombre}: ${actual} en stock (mínimo ${minimo})`,
          data: { item_id: it.id, stock: actual, minimo },
        });
      }
    }
  }

  /**
   * Servicio POR HORAS y TBO de componentes: nadie debería tener que abrir el
   * expediente del avión para enterarse. Avisa cuando faltan pocas horas para
   * el próximo servicio del programa cíclico o para agotar el TBO de un
   * motor/hélice (re-alerta a lo sumo una vez al mes por objetivo).
   */
  private async checkServicioPorHoras(config: AlertConfig): Promise<void> {
    const umbralHoras = config.horas_anticipacion ?? 10;
    const mes = dateOnly(new Date()).slice(0, 7);

    const { data: aviones, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula, servicio_intervalos, servicio_horas_base')
      .eq('activa', true);
    if (error) throw new Error(error.message);

    // Hobbs por avión (máximo tacómetro de vuelos no cancelados) en una consulta.
    const { data: escalas } = await this.supabase.service
      .from('escala')
      .select('aeronave_id, taco_salida, taco_llegada, vuelo:vuelo_id!inner(estado)')
      .neq('vuelo.estado', 'CANCELADO');
    const hobbsPorAvion = new Map<string, number>();
    for (const e of (escalas ?? []) as Array<Record<string, unknown>>) {
      const id = e.aeronave_id as string | null;
      if (!id) continue;
      for (const v of [e.taco_salida, e.taco_llegada]) {
        if (v == null) continue;
        const num = Number(v);
        if (Number.isFinite(num))
          hobbsPorAvion.set(id, Math.max(hobbsPorAvion.get(id) ?? 0, num));
      }
    }

    for (const a of aviones ?? []) {
      const hobbs = hobbsPorAvion.get(a.id as string) ?? 0;
      if (hobbs <= 0) continue;
      const prox = this.aircraft.proximoServicio(
        (a.servicio_intervalos as number[] | null) ?? [],
        Number(a.servicio_horas_base ?? 0),
        hobbs,
      );
      if (prox && prox.faltan <= umbralHoras) {
        await this.dispatch(config, `servicio:${a.id as string}:${prox.a_las}:${mes}`, {
          tipo: 'mantenimiento_programado',
          titulo: `Servicio por horas cerca: ${a.matricula as string}`,
          cuerpo: `Faltan ${prox.faltan} hrs para el servicio de ${prox.intervalo} hrs (a las ${prox.a_las}). Tacómetro actual: ${hobbs}.`,
          data: { aeronave_id: a.id, a_las: prox.a_las },
          link: `/admin/aircraft/${a.id as string}`,
        });
      }
    }

    // TBO de motores y hélices (horas vivas = horas_totales + hobbs − ref).
    for (const tabla of ['motor', 'helice'] as const) {
      const { data: comps } = await this.supabase.service
        .from(tabla)
        .select(
          'id, aeronave_id, numero_serie, posicion, horas_totales, turm, tbo_horas, aeronave_horas_ref, aeronave:aeronave_id(matricula)',
        )
        .not('aeronave_id', 'is', null);
      for (const c of (comps ?? []) as Array<Record<string, unknown>>) {
        const tbo = Number(c.tbo_horas ?? 0);
        if (tbo <= 0) continue;
        const hobbs = hobbsPorAvion.get(c.aeronave_id as string) ?? 0;
        const ref = c.aeronave_horas_ref != null ? Number(c.aeronave_horas_ref) : null;
        const vivas =
          ref != null
            ? Number(c.horas_totales ?? 0) + Math.max(0, hobbs - ref)
            : Number(c.horas_totales ?? 0);
        const desdeOH = tabla === 'motor' ? vivas - Number(c.turm ?? 0) : vivas;
        const restantes = Number((tbo - desdeOH).toFixed(1));
        const umbralTbo = Math.max(umbralHoras, 25);
        if (restantes <= umbralTbo) {
          const matricula =
            unwrap(c.aeronave as { matricula: string } | { matricula: string }[] | null)
              ?.matricula ?? '';
          await this.dispatch(config, `tbo:${tabla}:${c.id as string}:${mes}`, {
            tipo: 'vencimiento',
            titulo:
              restantes <= 0
                ? `TBO AGOTADO: ${tabla} de ${matricula}`
                : `TBO cerca (${restantes} hrs): ${tabla} de ${matricula}`,
            cuerpo: `${tabla === 'motor' ? 'Motor' : 'Hélice'} ${c.numero_serie as string} (${c.posicion as string}) · ${restantes <= 0 ? 'overhaul vencido' : `quedan ${restantes} hrs de TBO`}.`,
            data: { aeronave_id: c.aeronave_id, componente: tabla, id: c.id },
            link: `/admin/aircraft/${c.aeronave_id as string}`,
          });
        }
      }
    }
  }

  /** Fondos de caja chica en saldo negativo (sobregiro invisible). */
  private async checkCajaNegativa(config: AlertConfig): Promise<void> {
    const hoy = dateOnly(new Date());
    const { data: fondos, error } = await this.supabase.service
      .from('caja_chica_fondo')
      .select('id, usuario_id, moneda, activo, usuario:usuario_id(nombre)')
      .eq('activo', true);
    if (error) throw new Error(error.message);
    if (!fondos || fondos.length === 0) return;

    const usuarioIds = fondos.map((f) => f.usuario_id as string);
    // OJO: caja_chica_movimiento no tiene columna `estado`; el saldo suma
    // TODOS los movimientos, igual que caja-chica.service.saldoFromParts.
    const [movsRes, gastosRes] = await Promise.all([
      this.supabase.service
        .from('caja_chica_movimiento')
        .select('fondo_id, tipo, monto'),
      this.supabase.service
        .from('gasto')
        .select('usuario_captura_id, monto, moneda')
        .eq('medio_pago', 'EFECTIVO')
        .in('usuario_captura_id', usuarioIds),
    ]);
    // Un fallo parcial calcularía el saldo con la mitad de los datos y
    // dispararía alertas falsas de fondo negativo: mejor lanzar.
    if (movsRes.error) throw new Error(movsRes.error.message);
    if (gastosRes.error) throw new Error(gastosRes.error.message);
    const movs = movsRes.data;
    const gastos = gastosRes.data;

    for (const f of fondos) {
      let saldo = 0;
      for (const m of (movs ?? []) as Array<Record<string, unknown>>) {
        if (m.fondo_id !== f.id) continue;
        const monto = Number(m.monto);
        saldo += m.tipo === 'REINTEGRO' ? -monto : monto;
      }
      for (const g of (gastos ?? []) as Array<Record<string, unknown>>) {
        if (g.usuario_captura_id !== f.usuario_id || g.moneda !== f.moneda) continue;
        saldo -= Number(g.monto);
      }
      if (saldo < 0) {
        const nombre =
          unwrap(f.usuario as { nombre: string } | { nombre: string }[] | null)?.nombre ??
          'usuario';
        await this.dispatch(config, `caja:${f.id as string}:${hoy}`, {
          tipo: 'alerta_sistema',
          titulo: `Caja chica en NEGATIVO: ${nombre}`,
          cuerpo: `Saldo ${saldo.toFixed(2)} ${f.moneda as string}. Registra la reposición o revisa los gastos en efectivo.`,
          data: { fondo_id: f.id, saldo },
          link: `/admin/caja-chica`,
        });
      }
    }
  }

  /** Bandeja de gastos sin avión: la meta del diseño es que SIEMPRE esté vacía. */
  private async checkGastosSinAvion(config: AlertConfig): Promise<void> {
    const hoy = dateOnly(new Date());
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id, monto, moneda')
      .is('aeronave_id', null)
      // FIJO e INDIRECTO no llevan avión por diseño: mismo criterio que la
      // bandeja de pendientes de expenses.service, o el conteo no cuadra.
      .not('categoria', 'in', '(FIJO,INDIRECTO)');
    if (error) throw new Error(error.message);
    const pendientes = data ?? [];
    if (pendientes.length === 0) return;

    await this.dispatch(config, `gastos_sin_avion:${hoy}`, {
      tipo: 'alerta_sistema',
      titulo: `${pendientes.length} gasto(s) sin avión asignado`,
      cuerpo:
        'Estos gastos no se restan a ningún avión en el cierre. Asígnalos desde Gastos (bandeja de pendientes).',
      data: { count: pendientes.length },
      link: '/admin/expenses?pendientes=1',
    });
  }

  /**
   * Vuelos "estancados": programados cuya fecha ya pasó y siguen sin iniciar,
   * o EN_VUELO de días anteriores con lecturas incompletas (el autocierre
   * nocturno no pudo completarlos). Sin esto, sus horas e ingresos desaparecen
   * del cierre sin que nadie lo note.
   */
  private async checkVuelosEstancados(config: AlertConfig): Promise<void> {
    const hoyCancun = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Cancun',
    });
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select('id, folio, estado, origen_iata, destino_iata, fecha_vuelo')
      .in('estado', ['COTIZADO', 'RESERVA', 'CONFIRMADO', 'EN_VUELO'])
      .eq('es_externo', false)
      .not('fecha_vuelo', 'is', null)
      .lt('fecha_vuelo', `${hoyCancun}T00:00:00-05:00`);
    if (error) throw new Error(error.message);

    const semana = this.isoWeek(new Date());
    for (const v of data ?? []) {
      const esEnVuelo = v.estado === 'EN_VUELO';
      await this.dispatch(config, `zombi:${v.id as string}:${semana}`, {
        tipo: 'alerta_sistema',
        titulo: esEnVuelo
          ? `Vuelo #${v.folio as number} sigue EN VUELO (fecha pasada)`
          : `Vuelo #${v.folio as number} quedó ${v.estado as string} y su fecha ya pasó`,
        cuerpo: esEnVuelo
          ? `${v.origen_iata as string} → ${v.destino_iata as string}: faltan lecturas de llegada; complétalo o ajusta en Tacómetros en vivo. Sus horas no entran al cierre hasta completarse.`
          : `${v.origen_iata as string} → ${v.destino_iata as string}: complétalo si voló, reagéndalo o cancélalo. Si queda así, no cuenta en el cierre.`,
        data: { vuelo_id: v.id, folio: v.folio, estado: v.estado },
        link: `/admin/flights/${v.id as string}`,
      });
    }
  }

  /** Semana ISO (YYYY-Www) para deduplicar alertas que re-avisan semanalmente. */
  private isoWeek(d: Date): string {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  // ===== Despacho + dedupe =====

  /**
   * Persiste + emite por socket (siempre, para el centro de notificaciones) y
   * envía email si el canal lo incluye. Deduplica por dedupeKey para no repetir.
   */
  private async dispatch(
    config: AlertConfig,
    dedupeKey: string,
    notif: NotificationInput,
  ): Promise<void> {
    const isNew = await this.markIfNew(dedupeKey, config.clave);
    if (!isNew) return;

    const roles = config.roles.length > 0 ? config.roles : ['ADMIN'];
    for (const rol of roles) {
      await this.notifications.notifyRole(rol as Rol, notif);
    }

    if (config.canal === 'email' || config.canal === 'ambos') {
      await this.emailToRoles(roles, notif);
    }
  }

  private async emailToRoles(roles: string[], notif: NotificationInput): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('email')
      .in('rol', roles)
      .eq('estado', 'ACTIVO')
      // Externos sin acceso (doc 3.7): fuera de correos por rol, igual que
      // notifyRole los excluye del socket/push.
      .eq('es_piloto_externo', false);
    if (error) throw new Error(error.message);
    const emails = [...new Set((data ?? []).map((u) => (u as { email: string }).email).filter(Boolean))];
    const subject = `VuelaTour · ${notif.titulo}`;
    for (const to of emails) {
      await this.email.sendAlert(to, subject, notif.titulo, notif.cuerpo ?? '');
    }
  }

  /** Inserta la dedupeKey; devuelve true solo si es nueva (no emitida antes). */
  private async markIfNew(dedupeKey: string, clave: string): Promise<boolean> {
    const { error } = await this.supabase.service
      .from('alerta_emitida')
      .insert({ dedupe_key: dedupeKey, clave });
    if (error) {
      if (error.code === '23505') return false; // ya emitida
      throw new Error(error.message);
    }
    return true;
  }

  // ===== Config =====

  async getConfig(clave: string): Promise<AlertConfig | null> {
    const { data, error } = await this.supabase.service
      .from('alerta_config')
      .select('clave, descripcion, activa, canal, roles, dias_anticipacion, horas_anticipacion')
      .eq('clave', clave)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as AlertConfig | null) ?? null;
  }

  async listConfig(): Promise<AlertConfig[]> {
    const { data, error } = await this.supabase.service
      .from('alerta_config')
      .select('clave, descripcion, activa, canal, roles, dias_anticipacion, horas_anticipacion')
      .order('clave');
    if (error) throw new Error(error.message);
    return (data as AlertConfig[]) ?? [];
  }

  async updateConfig(
    clave: string,
    patch: Record<string, unknown>,
    userId: string,
  ): Promise<AlertConfig> {
    const { data, error } = await this.supabase.service
      .from('alerta_config')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('clave', clave)
      .select('clave, descripcion, activa, canal, roles, dias_anticipacion, horas_anticipacion')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Alerta ${clave} no encontrada`);
    return data as AlertConfig;
  }
}
