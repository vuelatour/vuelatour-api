import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { UpdateConfiguracionDto } from './dto/configuracion.dto';

const COLS = 'clave, activa, valor_numerico, descripcion, updated_at';

/** Claves conocidas (no regar strings sueltos por el código). */
export const CONFIG_CAPTURA_TACO_FOTO_IA = 'captura_taco_foto_ia';
/**
 * Días de gracia de la SEMANA de gastos (regla 1-sep-2026, audio del equipo):
 * los roles de campo capturan/corrigen dentro del bloque lunes→domingo en
 * pared Cancún, y tras el domingo tienen estos días extra para lo de la
 * semana pasada (1 = hasta el lunes). Default 1 en los consumidores.
 */
export const CONFIG_DIAS_GRACIA_GASTOS_SEMANA = 'dias_gracia_gastos_semana';

/** Fila cacheada de una bandera: estado on/off + valor numérico opcional. */
type ConfigRow = { activa: boolean; valor_numerico: number | null };

/**
 * Banderas globales de comportamiento del sistema (tabla
 * `configuracion_sistema`). Lecturas con caché corto: /me las consulta en
 * cada arranque de la app y los gates de IA en cada captura — 60 s de
 * retraso máximo al propagar un toggle es aceptable y evita golpear la BD.
 */
@Injectable()
export class ConfiguracionService {
  private cache: { data: Map<string, ConfigRow>; at: number } | null = null;
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
   * Fila cacheada de una bandera. Best-effort: una consulta caída jamás tira
   * /me ni una captura — responde el último valor conocido (o nada, y el
   * llamador aplica su default).
   */
  private async cachedRow(clave: string): Promise<ConfigRow | undefined> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > ConfiguracionService.TTL_MS) {
      const { data, error } = await this.supabase.service
        .from('configuracion_sistema')
        .select('clave, activa, valor_numerico');
      if (error) return this.cache?.data.get(clave);
      this.cache = {
        data: new Map(
          (data ?? []).map((r) => [
            r.clave as string,
            {
              activa: r.activa as boolean,
              valor_numerico:
                r.valor_numerico == null ? null : Number(r.valor_numerico),
            },
          ]),
        ),
        at: now,
      };
    }
    return this.cache.data.get(clave);
  }

  /**
   * Valor de una bandera con default seguro si la fila no existe. Best-effort:
   * una consulta caída jamás tira /me ni una captura — responde el último
   * valor conocido o el default.
   */
  async isActiva(clave: string, porDefecto = true): Promise<boolean> {
    return (await this.cachedRow(clave))?.activa ?? porDefecto;
  }

  /**
   * Valor NUMÉRICO de una bandera (p.ej. días de la ventana de edición de
   * gastos). Mismo caché y mismo best-effort que `isActiva`; si la fila no
   * existe o su valor es null, responde el default.
   */
  async numero(clave: string, porDefecto: number): Promise<number> {
    return (await this.cachedRow(clave))?.valor_numerico ?? porDefecto;
  }

  async update(clave: string, dto: UpdateConfiguracionDto, userId: string) {
    const patch: Record<string, unknown> = {};
    if (dto.activa !== undefined) patch.activa = dto.activa;
    if (dto.valor_numerico !== undefined)
      patch.valor_numerico = dto.valor_numerico;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'Nada que actualizar: manda activa y/o valor_numerico.',
      );
    }
    const { data, error } = await this.supabase.service
      .from('configuracion_sistema')
      .update({
        ...patch,
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
