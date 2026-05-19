import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateAirportDto,
  ListAirportsQuery,
  UpdateAirportDto,
} from './dto/airports.dto';

const COLS =
  'id, iata, icao, nombre, ciudad, pais, tuas_default_usd_pax, tuas_aplica_xa, tuas_aplica_xb, tuas_aplica_n, tuas_pase_abordar_exenta, notas, activo, created_at, updated_at';

type AeronaveMatricula = 'XA' | 'XB' | 'N';

@Injectable()
export class AirportsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListAirportsQuery) {
    let q = this.supabase.service
      .from('aeropuerto')
      .select(COLS, { count: 'exact' })
      .order('iata', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.pais) q = q.eq('pais', filters.pais);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `iata.ilike.${term},icao.ilike.${term},nombre.ilike.${term},ciudad.ilike.${term}`,
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
      .from('aeropuerto')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeropuerto ${id} not found`);
    return data;
  }

  async findByIata(iata: string) {
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .select(COLS)
      .eq('iata', iata.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Aeropuerto ${iata} not found`);
    return data;
  }

  async create(dto: CreateAirportDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .insert({
        ...dto,
        iata: dto.iata.toUpperCase(),
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('iata already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateAirportDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.iata) patch.iata = dto.iata.toUpperCase();
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('iata already exists');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Aeropuerto ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }

  /**
   * Computes the TUAS amount per passenger at a given airport for a given matricula
   * prefix, considering "pase de abordar" exemption rules.
   */
  async computeTuasUsdPax(
    iata: string,
    matriculaPrefix: AeronaveMatricula,
    tienePaseAbordar: boolean,
  ): Promise<{ aplica: boolean; usd_pax: number; razon: string }> {
    const aeropuerto = await this.findByIata(iata);
    const aplicaPorMatricula = (
      matriculaPrefix === 'XA'
        ? aeropuerto.tuas_aplica_xa
        : matriculaPrefix === 'XB'
          ? aeropuerto.tuas_aplica_xb
          : aeropuerto.tuas_aplica_n
    ) as boolean;
    if (!aplicaPorMatricula) {
      return {
        aplica: false,
        usd_pax: 0,
        razon: `Matricula ${matriculaPrefix} exenta en ${iata}`,
      };
    }
    if (tienePaseAbordar && aeropuerto.tuas_pase_abordar_exenta) {
      return {
        aplica: false,
        usd_pax: 0,
        razon: `Pase de abordar exenta TUAS en ${iata}`,
      };
    }
    return {
      aplica: true,
      usd_pax: Number(aeropuerto.tuas_default_usd_pax),
      razon: `TUAS aplica: ${matriculaPrefix} en ${iata}${tienePaseAbordar ? ' con pase de abordar (no exenta aqui)' : ''}`,
    };
  }
}
