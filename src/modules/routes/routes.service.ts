import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CreateRouteDto,
  ListRoutesQuery,
  RouteTramoInputDto,
  TipoRuta,
  UpdateRouteDto,
} from './dto/routes.dto';

const COLS =
  'id, tipo, origen_iata, destino_iata, millas_nauticas, es_redondo_auto, num_aterrizajes, fuente, notas, activa, created_at, updated_at';

const TRAMO_COLS =
  'id, ruta_id, orden, origen_iata, destino_iata, millas_nauticas, created_at, updated_at';

export interface RouteTramo {
  id: string;
  ruta_id: string;
  orden: number;
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: string;
  created_at: string;
  updated_at: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class RoutesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListRoutesQuery) {
    let q = this.supabase.service
      .from('ruta_predefinida')
      .select(COLS, { count: 'exact' })
      .order('origen_iata', { ascending: true })
      .order('destino_iata', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.origen) q = q.eq('origen_iata', filters.origen.toUpperCase());
    if (filters.destino)
      q = q.eq('destino_iata', filters.destino.toUpperCase());
    if (filters.q) {
      const term = `%${filters.q.toUpperCase()}%`;
      q = q.or(`origen_iata.ilike.${term},destino_iata.ilike.${term}`);
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const rutas = data ?? [];

    // Hidratar tramos para rutas multiescala. Lo hacemos en un solo query.
    const multiIds = rutas
      .filter((r) => r.tipo === TipoRuta.MULTIESCALA)
      .map((r) => r.id as string);
    const tramosByRuta =
      multiIds.length > 0 ? await this.findTramosByRutas(multiIds) : {};

    return {
      data: rutas.map((r) => ({
        ...r,
        tramos:
          r.tipo === TipoRuta.MULTIESCALA
            ? (tramosByRuta[r.id as string] ?? [])
            : [],
      })),
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Ruta ${id} not found`);
    const tramos =
      data.tipo === TipoRuta.MULTIESCALA ? await this.findTramos(id) : [];
    return { ...data, tramos };
  }

  async findByOriginDestination(origen: string, destino: string) {
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .select(COLS)
      .eq('origen_iata', origen.toUpperCase())
      .eq('destino_iata', destino.toUpperCase())
      .eq('tipo', TipoRuta.SIMPLE)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async create(dto: CreateRouteDto, createdBy: string) {
    const tipo = dto.tipo ?? TipoRuta.SIMPLE;

    if (tipo === TipoRuta.SIMPLE) {
      if (
        !dto.origen_iata ||
        !dto.destino_iata ||
        dto.millas_nauticas === undefined
      ) {
        throw new BadRequestException(
          'tipo=SIMPLE requiere origen_iata, destino_iata y millas_nauticas',
        );
      }
      if (dto.origen_iata.toUpperCase() === dto.destino_iata.toUpperCase()) {
        throw new BadRequestException(
          'origen_iata y destino_iata no pueden ser iguales',
        );
      }
      const { data, error } = await this.supabase.service
        .from('ruta_predefinida')
        .insert({
          tipo,
          origen_iata: dto.origen_iata.toUpperCase(),
          destino_iata: dto.destino_iata.toUpperCase(),
          millas_nauticas: dto.millas_nauticas,
          es_redondo_auto: dto.es_redondo_auto ?? true,
          num_aterrizajes: dto.num_aterrizajes ?? 2,
          fuente: dto.fuente,
          notas: dto.notas,
          created_by: createdBy,
          updated_by: createdBy,
        })
        .select(COLS)
        .maybeSingle();
      if (error) {
        if (error.code === '23505')
          throw new ConflictException(
            'Route already exists (origen+destino para tipo SIMPLE)',
          );
        throw new Error(error.message);
      }
      return { ...data!, tramos: [] as RouteTramo[] };
    }

    // MULTIESCALA
    const tramos = this.normalizeTramos(dto.tramos);
    const totalNm = tramos.reduce((acc, t) => acc + t.millas_nauticas, 0);

    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .insert({
        tipo,
        origen_iata: tramos[0].origen_iata,
        destino_iata: tramos[tramos.length - 1].destino_iata,
        millas_nauticas: round2(totalNm),
        es_redondo_auto: false,
        num_aterrizajes: tramos.length,
        fuente: dto.fuente,
        notas: dto.notas,
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    await this.replaceTramos(data!.id as string, tramos);
    const persisted = await this.findTramos(data!.id as string);
    return { ...data!, tramos: persisted };
  }

  async update(id: string, dto: UpdateRouteDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const current = await this.findById(id);
    const targetTipo = dto.tipo ?? (current.tipo as TipoRuta);

    const patch: Record<string, unknown> = {
      ...dto,
      tipo: targetTipo,
      updated_by: updatedBy,
    };
    // Las DTOs/tramos no van directo al UPDATE de la tabla padre.
    delete patch.tramos;

    if (targetTipo === TipoRuta.MULTIESCALA) {
      const tramosSource = dto.tramos ?? current.tramos;
      if (!tramosSource || tramosSource.length < 2) {
        throw new BadRequestException(
          'tipo=MULTIESCALA requiere tramos[] con al menos 2 tramos',
        );
      }
      const tramos = this.normalizeTramos(
        tramosSource.map((t) => ({
          origen_iata: t.origen_iata,
          destino_iata: t.destino_iata,
          millas_nauticas: Number(t.millas_nauticas),
        })),
      );
      patch.origen_iata = tramos[0].origen_iata;
      patch.destino_iata = tramos[tramos.length - 1].destino_iata;
      patch.millas_nauticas = round2(
        tramos.reduce((acc, t) => acc + t.millas_nauticas, 0),
      );
      patch.es_redondo_auto = false;
      patch.num_aterrizajes = tramos.length;

      const { data, error } = await this.supabase.service
        .from('ruta_predefinida')
        .update(patch)
        .eq('id', id)
        .select(COLS)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new NotFoundException(`Ruta ${id} not found`);

      // Replace tramos solo si vinieron en el DTO o si cambiamos de SIMPLE→MULTI.
      if (dto.tramos || current.tipo !== TipoRuta.MULTIESCALA) {
        await this.replaceTramos(id, tramos);
      }
      const persisted = await this.findTramos(id);
      return { ...data, tramos: persisted };
    }

    // SIMPLE
    if (dto.origen_iata) patch.origen_iata = dto.origen_iata.toUpperCase();
    if (dto.destino_iata) patch.destino_iata = dto.destino_iata.toUpperCase();
    if (current.tipo === TipoRuta.MULTIESCALA) {
      // Pasando de MULTIESCALA→SIMPLE: eliminar tramos.
      await this.deleteTramos(id);
    }
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          'Conflict: origen+destino combination already exists',
        );
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Ruta ${id} not found`);
    return { ...data, tramos: [] as RouteTramo[] };
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }

  // ============ Tramos helpers ============

  private async findTramos(rutaId: string): Promise<RouteTramo[]> {
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida_tramo')
      .select(TRAMO_COLS)
      .eq('ruta_id', rutaId)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async findTramosByRutas(
    rutaIds: string[],
  ): Promise<Record<string, RouteTramo[]>> {
    if (rutaIds.length === 0) return {};
    const { data, error } = await this.supabase.service
      .from('ruta_predefinida_tramo')
      .select(TRAMO_COLS)
      .in('ruta_id', rutaIds)
      .order('orden', { ascending: true });
    if (error) throw new Error(error.message);
    const grouped: Record<string, RouteTramo[]> = {};
    for (const t of (data ?? []) as RouteTramo[]) {
      (grouped[t.ruta_id] ||= []).push(t);
    }
    return grouped;
  }

  private normalizeTramos(
    tramos: RouteTramoInputDto[] | undefined,
  ): RouteTramoInputDto[] {
    if (!tramos || tramos.length < 2) {
      throw new BadRequestException('MULTIESCALA requiere al menos 2 tramos');
    }
    const norm = tramos.map((t) => ({
      origen_iata: t.origen_iata.toUpperCase(),
      destino_iata: t.destino_iata.toUpperCase(),
      millas_nauticas: Number(t.millas_nauticas),
    }));
    for (let i = 0; i < norm.length - 1; i++) {
      if (norm[i].destino_iata !== norm[i + 1].origen_iata) {
        throw new BadRequestException(
          `Tramo ${i + 2}: origen (${norm[i + 1].origen_iata}) debe coincidir con destino del tramo ${i + 1} (${norm[i].destino_iata}).`,
        );
      }
      if (norm[i].origen_iata === norm[i].destino_iata) {
        throw new BadRequestException(
          `Tramo ${i + 1}: origen y destino no pueden ser iguales.`,
        );
      }
    }
    if (
      norm[norm.length - 1].origen_iata === norm[norm.length - 1].destino_iata
    ) {
      throw new BadRequestException(
        `Tramo ${norm.length}: origen y destino no pueden ser iguales.`,
      );
    }
    return norm;
  }

  private async deleteTramos(rutaId: string): Promise<void> {
    const { error } = await this.supabase.service
      .from('ruta_predefinida_tramo')
      .delete()
      .eq('ruta_id', rutaId);
    if (error) throw new Error(`Failed to delete tramos: ${error.message}`);
  }

  private async replaceTramos(
    rutaId: string,
    tramos: RouteTramoInputDto[],
  ): Promise<void> {
    await this.deleteTramos(rutaId);
    const rows = tramos.map((t, idx) => ({
      ruta_id: rutaId,
      orden: idx + 1,
      origen_iata: t.origen_iata,
      destino_iata: t.destino_iata,
      millas_nauticas: t.millas_nauticas,
    }));
    const { error } = await this.supabase.service
      .from('ruta_predefinida_tramo')
      .insert(rows);
    if (error) throw new Error(`Failed to insert tramos: ${error.message}`);
  }
}
