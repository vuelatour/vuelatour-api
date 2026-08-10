import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const COLS = 'clave, activa, descripcion, updated_at';

/** Claves conocidas (no regar strings sueltos por el código). */
export const CONFIG_CAPTURA_TACO_FOTO_IA = 'captura_taco_foto_ia';

/**
 * Banderas globales de comportamiento del sistema (tabla
 * `configuracion_sistema`). Lecturas con caché corto: /me las consulta en
 * cada arranque de la app y los gates de IA en cada captura — 60 s de
 * retraso máximo al propagar un toggle es aceptable y evita golpear la BD.
 */
@Injectable()
export class ConfiguracionService {
  private cache: { data: Map<string, boolean>; at: number } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .select(COLS)
      .order('clave');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Valor de una bandera con default seguro si la fila no existe. Best-effort:
   * una consulta caída jamás tira /me ni una captura — responde el último
   * valor conocido o el default.
   */
  async isActiva(clave: string, porDefecto = true): Promise<boolean> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > ConfiguracionService.TTL_MS) {
      const { data, error } = await this.supabase.service
        .from('configuracion_sistema')
        .select('clave, activa');
      if (error) return this.cache?.data.get(clave) ?? porDefecto;
      this.cache = {
        data: new Map(
          (data ?? []).map((r) => [r.clave as string, r.activa as boolean]),
        ),
        at: now,
      };
    }
    return this.cache.data.get(clave) ?? porDefecto;
  }

  async update(clave: string, activa: boolean, userId: string) {
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .update({
        activa,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('clave', clave)
      .select(COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Configuración ${clave} not found`);
    // El toggle se refleja de inmediato en este proceso (la caché se rearma
    // en la siguiente lectura).
    this.cache = null;
    return data;
  }
}
