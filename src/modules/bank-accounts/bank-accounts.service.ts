import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateBankAccountDto,
  ListBankAccountsQuery,
  UpdateBankAccountDto,
} from './dto/bank-accounts.dto';

const COLS =
  'id, alias, banco, numero_cuenta, clabe, moneda, razon_social, tipo, notas, activa, created_at, updated_at';

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

  /**
   * Opciones del selector de cuenta del gasto (invariante 98): sin
   * `numero_cuenta` ni `clabe` (dato sensible), solo su terminación. Activas
   * por defecto, ordenadas por alias.
   */
  async opciones(incluirInactivas = false) {
    let q = this.supabase.service
      .from('cuenta_bancaria')
      .select(
        'id, alias, banco, moneda, tipo, razon_social, activa, numero_cuenta',
      )
      .order('alias', { ascending: true })
      .limit(500);
    if (!incluirInactivas) q = q.eq('activa', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      data: (data ?? []).map((c) =>
        opcionDeCuenta(c as Record<string, unknown>),
      ),
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
      if (error.code === '23505') {
        // Alias único (constraint `cuenta_bancaria_alias_key`): el panel
        // ofrece elegir la que ya existe.
        const existente = await this.supabase.service
          .from('cuenta_bancaria')
          .select('id, alias, activa')
          .eq('alias', dto.alias)
          .maybeSingle();
        const fila = existente.data as { id?: string; activa?: boolean } | null;
        throw new ConflictException({
          message:
            fila?.activa === false
              ? `Ya existe una cuenta «${dto.alias}», pero está dada de baja: pide a un administrador que la reactive o usa otro nombre.`
              : `Ya existe una cuenta con el nombre «${dto.alias}»: elígela de la lista.`,
          error: 'CUENTA_ALIAS_DUPLICADO',
          details: { id: fila?.id ?? null, activa: fila?.activa ?? null },
        });
      }
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

/** Opción del selector de cuenta: la terminación, nunca el número completo. */
export function opcionDeCuenta(c: Record<string, unknown>) {
  const numero = typeof c.numero_cuenta === 'string' ? c.numero_cuenta : '';
  const digitos = numero.replace(/\D/g, '');
  return {
    id: c.id as string,
    alias: (c.alias as string) ?? '',
    banco: (c.banco as string | null) ?? null,
    moneda: (c.moneda as string | null) ?? null,
    tipo: (c.tipo as string | null) ?? 'BANCO',
    razon_social: (c.razon_social as string | null) ?? null,
    activa: c.activa !== false,
    terminacion: digitos.length >= 4 ? digitos.slice(-4) : null,
  };
}
