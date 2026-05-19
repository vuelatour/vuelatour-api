import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateBankMovementDto,
  ListBankMovementsQuery,
  UpdateBankMovementDto,
} from './dto/bank-movements.dto';

const COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, saldo_posterior, conciliado, gasto_id, origen, notas, created_at, updated_at';

@Injectable()
export class BankMovementsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListBankMovementsQuery) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(COLS, { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (typeof filters.conciliado === 'boolean')
      q = q.eq('conciliado', filters.conciliado);
    if (filters.desde) q = q.gte('fecha', filters.desde);
    if (filters.hasta) q = q.lte('fecha', filters.hasta);

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
      .from('movimiento_bancario')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Movimiento bancario ${id} not found`);
    return data;
  }

  async create(dto: CreateBankMovementDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        fecha: dto.fecha,
        tipo: dto.tipo,
        monto: dto.monto,
        descripcion: dto.descripcion ?? null,
        referencia: dto.referencia ?? null,
        saldo_posterior: dto.saldo_posterior ?? null,
        origen: 'MANUAL',
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

  async update(id: string, dto: UpdateBankMovementDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Movimiento bancario ${id} not found`);
    return data;
  }

  async remove(id: string) {
    await this.findById(id);
    const { error } = await this.supabase.service
      .from('movimiento_bancario')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }

  /** Concilia el movimiento con un gasto: marca ambos como conciliados. */
  async reconcile(id: string, gastoId: string, userId: string) {
    const current = await this.findById(id);
    if ((current as { conciliado: boolean }).conciliado) {
      throw new ConflictException('El movimiento ya esta conciliado');
    }

    const { data: gasto, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('id')
      .eq('id', gastoId)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!gasto) throw new BadRequestException(`Gasto ${gastoId} not found`);

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({ gasto_id: gastoId, conciliado: true, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Reflejar la conciliacion en el gasto.
    await this.supabase.service
      .from('gasto')
      .update({ conciliado: true, updated_by: userId })
      .eq('id', gastoId);

    return data!;
  }

  /** Deshace la conciliacion del movimiento (no toca el gasto). */
  async unreconcile(id: string, userId: string) {
    await this.findById(id);
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({ gasto_id: null, conciliado: false, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }
}
