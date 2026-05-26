import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../realtime/notifications.service';
import { Rol } from '../../common/types/auth.types';
import type {
  CreateGastoDto,
  ListGastosQuery,
  UpdateGastoDto,
} from './dto/expenses.dto';

const COLS =
  'id, vuelo_id, aeronave_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, fecha_gasto, proveedor_id, medio_pago, tarjeta_terminacion, estatus_comprobante, foto_url, valor_ia_extraido, conciliado, duplicado_sospechado, notas, created_at, updated_at';

// Para el panel admin: nombres legibles de proveedor, avión y persona que capturó.
const LIST_COLS = `${COLS}, proveedor:proveedor!proveedor_id(nombre), aeronave:aeronave!aeronave_id(matricula), captura:usuario!usuario_captura_id(nombre)`;

/** Ventana en días para considerar dos gastos como posible duplicado. */
const DUP_DAYS = 3;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
  ) {}

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
   * Posible duplicado: mismo proveedor + mismo monto + misma moneda y fecha
   * dentro de ±DUP_DAYS días (regla del diseño funcional). Sin proveedor no se
   * intenta detectar para evitar falsos positivos.
   */
  private async looksLikeDuplicate(dto: CreateGastoDto): Promise<boolean> {
    if (!dto.proveedor_id) return false;
    const base = new Date(`${dto.fecha_gasto}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - DUP_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + DUP_DAYS);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id')
      .eq('proveedor_id', dto.proveedor_id)
      .eq('moneda', dto.moneda)
      .eq('monto', dto.monto)
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .limit(1);
    if (error) return false; // la detección no debe bloquear la captura
    return (data ?? []).length > 0;
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
