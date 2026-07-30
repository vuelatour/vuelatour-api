import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateAirportDto,
  ListAirportsQuery,
  UpdateAirportDto,
} from './dto/airports.dto';

const COLS =
  'id, iata, icao, nombre, ciudad, pais, latitud, longitud, tuas_default_usd_pax, tuas_aplica_xa, tuas_aplica_xb, tuas_aplica_n, tuas_pase_abordar_exenta, requiere_permiso, notas, activo, created_at, updated_at';

const NM_PER_KM = 0.539957;
const EARTH_RADIUS_KM = 6371;

/** Distancia great-circle (Haversine) en millas náuticas entre dos coords. */
export function haversineNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = EARTH_RADIUS_KM * c;
  return Math.round(km * NM_PER_KM * 100) / 100;
}

type AeronaveMatricula = 'XA' | 'XB' | 'N';

@Injectable()
export class AirportsService {
  private readonly logger = new Logger(AirportsService.name);

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
   * Millas náuticas great-circle entre dos aeropuertos (por IATA). Devuelve
   * null si a alguno le faltan coordenadas (el cotizador cae a input manual).
   */
  // ============ Catálogo de distancias por aerovía ============

  async listDistancias() {
    const { data, error } = await this.supabase.service
      .from('distancia_tramo')
      .select(
        'id, origen_iata, destino_iata, millas_nauticas, fuente, notas, updated_at',
      )
      .order('origen_iata', { ascending: true })
      .order('destino_iata', { ascending: true })
      .limit(2000);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Upsert por par origen+destino (el par es único; editar = recargar). */
  async upsertDistancia(dto: {
    origen_iata: string;
    destino_iata: string;
    millas_nauticas: number;
    fuente?: string;
    notas?: string;
  }) {
    const { data, error } = await this.supabase.service
      .from('distancia_tramo')
      .upsert(
        {
          origen_iata: dto.origen_iata.toUpperCase(),
          destino_iata: dto.destino_iata.toUpperCase(),
          millas_nauticas: dto.millas_nauticas,
          fuente: dto.fuente ?? 'AEROVIA',
          notas: dto.notas ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'origen_iata,destino_iata' },
      )
      .select('id, origen_iata, destino_iata, millas_nauticas, fuente, notas')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  /** Carga masiva (archivo de distancias por aerovía de Alejandro). */
  async importDistancias(
    tramos: Array<{
      origen_iata: string;
      destino_iata: string;
      millas_nauticas: number;
      fuente?: string;
      notas?: string;
    }>,
  ) {
    const rows = tramos.map((t) => ({
      origen_iata: t.origen_iata.toUpperCase(),
      destino_iata: t.destino_iata.toUpperCase(),
      millas_nauticas: t.millas_nauticas,
      fuente: t.fuente ?? 'AEROVIA',
      notas: t.notas ?? null,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await this.supabase.service
      .from('distancia_tramo')
      .upsert(rows, { onConflict: 'origen_iata,destino_iata' });
    if (error) throw new Error(error.message);
    return { imported: rows.length };
  }

  async deleteDistancia(id: string) {
    const { error } = await this.supabase.service
      .from('distancia_tramo')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true, id };
  }

  async distanceNm(
    origenIata: string,
    destinoIata: string,
  ): Promise<{
    millas_nauticas: number | null;
    origen: string;
    destino: string;
    falta_coords: boolean;
  }> {
    const codes = [origenIata.toUpperCase(), destinoIata.toUpperCase()];
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .select('iata, latitud, longitud')
      .in('iata', codes);
    if (error) throw new Error(error.message);

    const byIata = new Map(
      (data ?? []).map((a) => [
        a.iata as string,
        a as { latitud: number | null; longitud: number | null },
      ]),
    );
    const o = byIata.get(codes[0]);
    const d = byIata.get(codes[1]);

    if (
      !o ||
      !d ||
      o.latitud == null ||
      o.longitud == null ||
      d.latitud == null ||
      d.longitud == null
    ) {
      return {
        millas_nauticas: null,
        origen: codes[0],
        destino: codes[1],
        falta_coords: true,
      };
    }
    const nm = haversineNm(
      Number(o.latitud),
      Number(o.longitud),
      Number(d.latitud),
      Number(d.longitud),
    );
    return {
      millas_nauticas: nm,
      origen: codes[0],
      destino: codes[1],
      falta_coords: false,
    };
  }

  /**
   * True si alguno de los IATA dados corresponde a una pista que requiere
   * permiso. Usado al crear vuelos para fijar estado_permiso.
   */
  async anyRequiresPermit(iatas: string[]): Promise<boolean> {
    const codes = iatas.filter(Boolean).map((s) => s.toUpperCase());
    if (codes.length === 0) return false;
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .select('iata')
      .in('iata', codes)
      .eq('requiere_permiso', true)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  /** Subconjunto de IATAs que requieren permiso (una sola consulta). */
  async permitRequiringSet(iatas: string[]): Promise<Set<string>> {
    const codes = [
      ...new Set(iatas.filter(Boolean).map((s) => s.toUpperCase())),
    ];
    if (codes.length === 0) return new Set();
    const { data, error } = await this.supabase.service
      .from('aeropuerto')
      .select('iata')
      .in('iata', codes)
      .eq('requiere_permiso', true);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((a) => (a.iata as string).toUpperCase()));
  }

  /**
   * Recalcula el permiso de pista de un vuelo y de CADA uno de sus tramos a
   * partir de `aeropuerto.requiere_permiso`.
   *
   * FUENTE ÚNICA: la llaman todos los caminos que crean o cambian una ruta
   * (cotizar, revisar, reserva, agregar/editar tramo). Antes solo se derivaba
   * al CREAR una cotización, así que los vuelos dados de alta como reserva —el
   * flujo nuevo— nunca avisaban del permiso (jul 2026: 9 vuelos a HOL/PTU sin
   * marcar, reportado por Itzel).
   *
   * Reglas:
   * - Un permiso ya EMITIDO no se degrada a pendiente (el trámite ya se hizo).
   * - Si la ruta deja de tocar pistas con permiso, vuelve a `no_aplica`.
   * - Los tramos CANCELADOS no cuentan (no se van a volar).
   * - Best-effort: si algo falla, se registra y NO se rompe la operación —
   *   el aviso es importante, pero no puede impedir guardar un vuelo.
   */
  async refreshPermisosDeVuelo(vueloId: string): Promise<void> {
    try {
      const [vueloRes, escalasRes] = await Promise.all([
        this.supabase.service
          .from('vuelo')
          .select('id, origen_iata, destino_iata, estado_permiso')
          .eq('id', vueloId)
          .maybeSingle(),
        this.supabase.service
          .from('escala')
          .select('id, origen_iata, destino_iata, estado_permiso, cancelada_at')
          .eq('vuelo_id', vueloId),
      ]);
      const vuelo = vueloRes.data as {
        origen_iata: string | null;
        destino_iata: string | null;
        estado_permiso: string | null;
      } | null;
      if (!vuelo) return;
      const escalas = (escalasRes.data ?? []) as Array<{
        id: string;
        origen_iata: string;
        destino_iata: string;
        estado_permiso: string | null;
        cancelada_at: string | null;
      }>;
      const vivas = escalas.filter((e) => !e.cancelada_at);

      const conPermiso = await this.permitRequiringSet([
        vuelo.origen_iata ?? '',
        vuelo.destino_iata ?? '',
        ...vivas.flatMap((e) => [e.origen_iata, e.destino_iata]),
      ]);

      const nuevoEstado = (
        iatas: string[],
        actual: string | null,
      ): 'no_aplica' | 'pendiente' | 'emitido' => {
        const toca = iatas.some((i) => conPermiso.has((i ?? '').toUpperCase()));
        if (!toca) return 'no_aplica';
        return actual === 'emitido' ? 'emitido' : 'pendiente';
      };

      // 1) Cada tramo, según SUS aeropuertos.
      const estadosTramos: string[] = [];
      for (const e of vivas) {
        const nuevo = nuevoEstado(
          [e.origen_iata, e.destino_iata],
          e.estado_permiso,
        );
        estadosTramos.push(nuevo);
        if (nuevo !== (e.estado_permiso ?? 'no_aplica')) {
          await this.supabase.service
            .from('escala')
            .update({ estado_permiso: nuevo })
            .eq('id', e.id);
        }
      }

      // 2) El vuelo: pendiente si CUALQUIER tramo lo está. Sin tramos, se
      //    evalúa con el origen/destino del propio vuelo.
      const vueloNuevo = vivas.length
        ? estadosTramos.includes('pendiente')
          ? 'pendiente'
          : estadosTramos.includes('emitido')
            ? 'emitido'
            : 'no_aplica'
        : nuevoEstado(
            [vuelo.origen_iata ?? '', vuelo.destino_iata ?? ''],
            vuelo.estado_permiso,
          );
      if (vueloNuevo !== (vuelo.estado_permiso ?? 'no_aplica')) {
        await this.supabase.service
          .from('vuelo')
          .update({ estado_permiso: vueloNuevo })
          .eq('id', vueloId);
      }
    } catch (err) {
      this.logger.warn(
        `refreshPermisosDeVuelo(${vueloId}) falló: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
