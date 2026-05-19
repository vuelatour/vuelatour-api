import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateFundMovementDto,
  ListFundMovementsQuery,
  ResolveFundMovementDto,
} from './dto/fund-movements.dto';

const COLS =
  'id, fondo_id, tipo, monto, fecha, estado, solicitado_por, autorizado_por, autorizado_at, referencia, notas, created_at, updated_at';

@Injectable()
export class FundMovementsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListFundMovementsQuery) {
    let q = this.supabase.service
      .from('movimiento_fondo')
      .select(COLS, { count: 'exact' })
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (filters.fondo_id) q = q.eq('fondo_id', filters.fondo_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);
    if (filters.estado) q = q.eq('estado', filters.estado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async create(dto: CreateFundMovementDto, userId: string) {
    await this.requireActiveFondo(dto.fondo_id);

    const { data, error } = await this.supabase.service
      .from('movimiento_fondo')
      .insert({
        fondo_id: dto.fondo_id,
        tipo: dto.tipo,
        monto: dto.monto,
        fecha: dto.fecha ?? null,
        estado: 'SOLICITADO',
        solicitado_por: userId,
        referencia: dto.referencia ?? null,
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

  /** Autoriza o rechaza una solicitud. Solo aplica a movimientos SOLICITADO. */
  async resolve(id: string, dto: ResolveFundMovementDto, userId: string) {
    const { data: current, error: readErr } = await this.supabase.service
      .from('movimiento_fondo')
      .select('id, estado, notas')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new NotFoundException(`Movimiento ${id} not found`);
    const row = current;
    if (row.estado !== 'SOLICITADO') {
      throw new ConflictException(
        `El movimiento ya esta ${row.estado}; no se puede volver a resolver`,
      );
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_fondo')
      .update({
        estado: dto.estado,
        autorizado_por: userId,
        autorizado_at: new Date().toISOString(),
        notas: dto.notas ?? row.notas,
        updated_by: userId,
      })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Movimiento ${id} not found`);
    return data;
  }

  private async requireActiveFondo(fondoId: string): Promise<void> {
    const { data, error } = await this.supabase.service
      .from('fondo_caja')
      .select('id, activo')
      .eq('id', fondoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Fondo ${fondoId} not found`);
    if (!(data as { activo: boolean }).activo) {
      throw new BadRequestException('El fondo esta inactivo');
    }
  }
}
