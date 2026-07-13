import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateClienteDto,
  ListClientesQuery,
  SetTarifasClienteDto,
  UpdateClienteDto,
} from './dto/clients.dto';

const COLS =
  'id, nombre, telefono, email, razon_social_default, rfc, canal_origen, es_broker, notas, activo, created_at, updated_at';

@Injectable()
export class ClientsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListClientesQuery) {
    let q = this.supabase.service
      .from('cliente')
      .select(COLS, { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.canal_origen) q = q.eq('canal_origen', filters.canal_origen);
    if (typeof filters.es_broker === 'boolean')
      q = q.eq('es_broker', filters.es_broker);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `nombre.ilike.${term},email.ilike.${term},telefono.ilike.${term},rfc.ilike.${term}`,
      );
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
      .from('cliente')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return data;
  }

  async create(dto: CreateClienteDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('cliente')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflict — cliente already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateClienteDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('cliente')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }

  // ===== Tarifas preferenciales por aeronave =====
  // Si el cliente tiene tarifa pactada para un avión, el cotizador la usa en
  // lugar de la default (público/broker). Ver quotes.service.calculate().

  async listTarifas(clienteId: string) {
    await this.findById(clienteId);
    const { data, error } = await this.supabase.service
      .from('tarifa_cliente_aeronave')
      .select(
        'id, aeronave_id, tarifa_hora_usd, aeronave:aeronave!aeronave_id(matricula, modelo)',
      )
      .eq('cliente_id', clienteId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Reemplaza el set completo de tarifas preferenciales del cliente. */
  async setTarifas(
    clienteId: string,
    dto: SetTarifasClienteDto,
    userId: string,
  ) {
    await this.findById(clienteId);
    // Última tarifa gana si mandan la misma aeronave dos veces.
    const porAeronave = new Map<string, number>();
    for (const t of dto.tarifas)
      porAeronave.set(t.aeronave_id, t.tarifa_hora_usd);
    const keep = [...porAeronave.keys()];

    // Sin transacción (dos llamadas PostgREST): PRIMERO el upsert y después el
    // borrado — si algo falla a la mitad, a lo sumo sobran tarifas por quitar
    // (visibles y reintentables); nunca se pierden las pactadas.
    if (keep.length > 0) {
      const now = new Date().toISOString();
      const { error } = await this.supabase.service
        .from('tarifa_cliente_aeronave')
        .upsert(
          [...porAeronave].map(([aeronave_id, tarifa_hora_usd]) => ({
            cliente_id: clienteId,
            aeronave_id,
            tarifa_hora_usd,
            updated_at: now,
            updated_by: userId,
          })),
          { onConflict: 'cliente_id,aeronave_id' },
        );
      if (error) {
        if (error.code === '23503')
          throw new BadRequestException('Alguna aeronave no existe');
        throw new Error(error.message);
      }
    }

    // Las aeronaves que ya no vienen pierden su tarifa (vuelven a la default).
    let del = this.supabase.service
      .from('tarifa_cliente_aeronave')
      .delete()
      .eq('cliente_id', clienteId);
    if (keep.length > 0)
      del = del.not('aeronave_id', 'in', `(${keep.join(',')})`);
    const { error: delError } = await del;
    if (delError) throw new Error(delError.message);

    return this.listTarifas(clienteId);
  }
}
