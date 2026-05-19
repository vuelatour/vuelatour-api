import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { MedioPago } from './dto/expenses.dto';
import type {
  CreateGastoDto,
  ListGastosQuery,
  UpdateGastoDto,
} from './dto/expenses.dto';

const COLS =
  'id, vuelo_id, aeronave_id, usuario_captura_id, categoria, monto, moneda, tc_gasto, fecha_gasto, proveedor_id, medio_pago, tarjeta_terminacion, estatus_comprobante, foto_url, valor_ia_extraido, conciliado, duplicado_sospechado, notas, created_at, updated_at';

/** Ventana (dias) para considerar dos gastos como posible duplicado. */
const DUP_WINDOW_DAYS = 3;

@Injectable()
export class ExpensesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListGastosQuery) {
    let q = this.supabase.service
      .from('gasto')
      .select(COLS, { count: 'exact' })
      .order('fecha_gasto', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.aeronave_id) q = q.eq('aeronave_id', filters.aeronave_id);
    if (filters.vuelo_id) q = q.eq('vuelo_id', filters.vuelo_id);
    if (filters.proveedor_id) q = q.eq('proveedor_id', filters.proveedor_id);
    if (filters.categoria) q = q.eq('categoria', filters.categoria);
    if (filters.medio_pago) q = q.eq('medio_pago', filters.medio_pago);
    if (filters.estatus_comprobante)
      q = q.eq('estatus_comprobante', filters.estatus_comprobante);
    if (filters.sin_aeronave) q = q.is('aeronave_id', null);
    if (typeof filters.conciliado === 'boolean')
      q = q.eq('conciliado', filters.conciliado);
    if (filters.desde) q = q.gte('fecha_gasto', filters.desde);
    if (filters.hasta) q = q.lte('fecha_gasto', filters.hasta);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`notas.ilike.${term},tarjeta_terminacion.ilike.${term}`);
    }

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

  async create(dto: CreateGastoDto, userId: string) {
    this.assertTarjetaCoherente(dto.medio_pago, dto.tarjeta_terminacion);

    const duplicado = await this.detectDuplicate(
      dto.proveedor_id,
      dto.monto,
      dto.fecha_gasto,
    );

    const { data, error } = await this.supabase.service
      .from('gasto')
      .insert({
        vuelo_id: dto.vuelo_id ?? null,
        aeronave_id: dto.aeronave_id ?? null,
        usuario_captura_id: userId,
        categoria: dto.categoria,
        monto: dto.monto,
        moneda: dto.moneda,
        tc_gasto: dto.tc_gasto ?? null,
        fecha_gasto: dto.fecha_gasto,
        proveedor_id: dto.proveedor_id ?? null,
        medio_pago: dto.medio_pago,
        tarjeta_terminacion: dto.tarjeta_terminacion ?? null,
        estatus_comprobante: dto.estatus_comprobante ?? 'SIN_COMPROBANTE',
        foto_url: dto.foto_url ?? null,
        valor_ia_extraido: dto.valor_ia_extraido ?? null,
        duplicado_sospechado: duplicado,
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateGastoDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.findById(id);

    const medioPago = (dto.medio_pago ?? current.medio_pago) as MedioPago;
    const terminacion =
      dto.tarjeta_terminacion !== undefined
        ? dto.tarjeta_terminacion
        : (current.tarjeta_terminacion as string | null);
    this.assertTarjetaCoherente(medioPago, terminacion);

    const patch: Record<string, unknown> = { ...dto, updated_by: userId };
    if (
      dto.medio_pago === MedioPago.EFECTIVO ||
      dto.medio_pago === MedioPago.TRANSFERENCIA
    ) {
      // medio sin tarjeta: limpia la terminacion previa para no dejar datos huerfanos
      if (dto.tarjeta_terminacion === undefined)
        patch.tarjeta_terminacion = null;
    }

    const { data, error } = await this.supabase.service
      .from('gasto')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Gasto ${id} not found`);
    return data;
  }

  async remove(id: string) {
    await this.findById(id);
    const { error } = await this.supabase.service
      .from('gasto')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }

  private assertTarjetaCoherente(
    medioPago: MedioPago,
    terminacion: string | null | undefined,
  ): void {
    if (terminacion && medioPago !== MedioPago.TARJETA_CORP) {
      throw new BadRequestException(
        'tarjeta_terminacion solo aplica cuando medio_pago = TARJETA_CORP',
      );
    }
  }

  /** Marca duplicado si existe otro gasto con mismo proveedor + monto + fecha cercana. */
  private async detectDuplicate(
    proveedorId: string | undefined,
    monto: number,
    fechaGasto: string,
  ): Promise<boolean> {
    if (!proveedorId) return false;
    const fecha = new Date(`${fechaGasto}T00:00:00Z`);
    const desde = new Date(fecha);
    desde.setUTCDate(desde.getUTCDate() - DUP_WINDOW_DAYS);
    const hasta = new Date(fecha);
    hasta.setUTCDate(hasta.getUTCDate() + DUP_WINDOW_DAYS);

    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id')
      .eq('proveedor_id', proveedorId)
      .eq('monto', monto)
      .gte('fecha_gasto', desde.toISOString().slice(0, 10))
      .lte('fecha_gasto', hasta.toISOString().slice(0, 10))
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  }
}
