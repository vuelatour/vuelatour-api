import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateBankAccountDto,
  ListBankAccountsQuery,
  UpdateBankAccountDto,
} from './dto/bank-accounts.dto';

const COLS =
  'id, alias, banco, numero_cuenta, clabe, moneda, razon_social, notas, activa, created_at, updated_at';

@Injectable()
export class BankAccountsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListBankAccountsQuery) {
    let q = this.supabase.service
      .from('cuenta_bancaria')
      .select(COLS, { count: 'exact' })
      .order('alias', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.moneda) q = q.eq('moneda', filters.moneda);
    if (filters.razon_social) q = q.eq('razon_social', filters.razon_social);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(`alias.ilike.${term},banco.ilike.${term}`);
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
      .from('cuenta_bancaria')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cuenta bancaria ${id} not found`);
    return data;
  }

  async create(dto: CreateBankAccountDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('cuenta_bancaria')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new BadRequestException('alias already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateBankAccountDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('cuenta_bancaria')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cuenta bancaria ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }
}
