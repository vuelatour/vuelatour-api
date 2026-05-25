import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
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
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  // ===== Cron =====

  @Cron(CronExpression.EVERY_HOUR)
  async runHourly(): Promise<void> {
    await this.safe('permiso_pista', (c) => this.checkPermisoPista(c));
  }

  @Cron('0 8 * * *', { timeZone: 'America/Cancun' })
  async runDaily(): Promise<void> {
    await this.safe('vencimiento', (c) => this.checkVencimientos(c));
    await this.safe('cobro_pendiente', (c) => this.checkCobrosPendientes(c));
    await this.safe('inventario_bajo', (c) => this.checkInventarioBajo(c));
    await this.safe('mantenimiento_programado', (c) => this.checkMantenimientos(c));
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
      .eq('estado', 'ACTIVO');
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
