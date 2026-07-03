import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import type { EnvVars } from '../../config/env.schema';
import {
  ConciliacionParseDto,
  ImportarMovimientosDto,
  ListConciliacionQuery,
  TipoMovimientoBancario,
} from './dto/conciliacion.dto';

const MOV_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, conciliado, gasto_id, origen, notas, created_at';
const MATCH_DAYS = 3;

export interface ParsedStatement {
  movimientos: Array<{
    fecha: string | null;
    descripcion: string | null;
    monto: number;
    tipo: 'CARGO' | 'ABONO';
    referencia: string | null;
  }>;
  total: number;
  formato: string;
  notas: string;
  modelo: string | null;
}

export interface SugerenciaConciliacion {
  disponible: boolean;
  gasto_id_sugerido: string | null;
  confianza: number;
  razon: string;
  /** Gastos candidatos considerados (para que el front muestre opciones). */
  candidatos: Array<{
    id: string;
    fecha: string | null;
    monto: number;
    proveedor: string | null;
  }>;
}

/** Banda de tolerancia de monto (±5%) para juntar gastos candidatos. */
const MATCH_MONTO_PCT = 0.05;

@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
  ) {}

  /** Parsea el estado de cuenta en pyservices (sin persistir). */
  async parse(dto: ConciliacionParseDto): Promise<ParsedStatement> {
    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException('Conciliación no configurada (pyservices).');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify({ filename: dto.filename, file_base64: dto.file_base64 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al parsear: ${detail.slice(0, 200)}`,
        );
      }
      return (await res.json()) as ParsedStatement;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`parse estado de cuenta falló: ${msg}`);
      throw new ServiceUnavailableException(`No se pudo parsear el estado de cuenta: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persiste los movimientos y auto-concilia los CARGO con gastos del mismo monto/fecha. */
  async importar(dto: ImportarMovimientosDto, userId: string) {
    const rows = dto.movimientos
      .filter((m) => m.fecha)
      .map((m) => ({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        fecha: m.fecha,
        tipo: m.tipo,
        monto: m.monto,
        descripcion: m.descripcion ?? null,
        referencia: m.referencia ?? null,
        origen: 'IMPORTADO',
        created_by: userId,
        updated_by: userId,
      }));
    if (rows.length === 0) {
      throw new BadRequestException('No hay movimientos con fecha para importar.');
    }

    const { data: inserted, error } = await this.supabase.service
      .from('movimiento_bancario')
      .insert(rows)
      .select('id, fecha, monto, tipo');
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }

    let conciliadosAuto = 0;
    for (const mov of inserted ?? []) {
      const m = mov as { id: string; fecha: string; monto: number; tipo: string };
      if (m.tipo !== TipoMovimientoBancario.CARGO) continue;
      const matched = await this.autoMatch(m.id, m.monto, m.fecha, userId);
      if (matched) conciliadosAuto += 1;
    }

    return { importados: rows.length, conciliados_auto: conciliadosAuto };
  }

  /** Si hay exactamente un gasto candidato (mismo monto, fecha ±N días, sin conciliar), lo vincula. */
  private async autoMatch(
    movId: string,
    monto: number,
    fecha: string,
    userId: string,
  ): Promise<boolean> {
    const base = new Date(`${fecha}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - MATCH_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + MATCH_DAYS);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id')
      .eq('monto', monto)
      .eq('conciliado', false)
      // Los cargos automáticos de bodega (REFACCION medio BODEGA) no son
      // egresos bancarios: el dinero salió al comprar la pieza, no al usarla.
      .neq('medio_pago', 'BODEGA')
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .limit(2);
    if (error || !data || data.length !== 1) return false;

    const gastoId = (data[0] as { id: string }).id;
    await this.link(movId, gastoId, userId);
    return true;
  }

  async list(filters: ListConciliacionQuery) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        `${MOV_COLS}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto)`,
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.cuenta_bancaria_id) q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (typeof filters.conciliado === 'boolean') q = q.eq('conciliado', filters.conciliado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [], count: count ?? 0, limit: filters.limit, offset: filters.offset };
  }

  /** Vincula (o desvincula si gastoId es null) un movimiento con un gasto. */
  async link(movId: string, gastoId: string | null, userId: string) {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const prevGasto = (mov as { gasto_id: string | null }).gasto_id;
    if (prevGasto && prevGasto !== gastoId) {
      // Libera el gasto previamente vinculado.
      await this.supabase.service
        .from('gasto')
        .update({ conciliado: false, updated_by: userId })
        .eq('id', prevGasto);
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        gasto_id: gastoId,
        conciliado: gastoId !== null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23503') throw new BadRequestException('Gasto no encontrado.');
      throw new Error(error.message);
    }

    if (gastoId) {
      await this.supabase.service
        .from('gasto')
        .update({ conciliado: true, updated_by: userId })
        .eq('id', gastoId);
    }
    return data!;
  }

  /**
   * Sugiere (vía Claude en pyservices) el gasto más probable para un movimiento
   * bancario sin conciliar y ambiguo. Junta gastos candidatos cercanos (±3 días
   * y ±5% de monto, sin conciliar) y deja que la IA proponga el match con razón.
   * Best-effort: si pyservices no está configurado o falla, devuelve
   * disponible=false con los candidatos para que el operador elija a mano.
   */
  async sugerir(movId: string): Promise<SugerenciaConciliacion> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, fecha, monto, descripcion, conciliado')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const m = mov as {
      id: string;
      fecha: string;
      monto: number;
      descripcion: string | null;
      conciliado: boolean;
    };
    if (m.conciliado) {
      throw new BadRequestException('El movimiento ya está conciliado.');
    }

    const candidatos = await this.candidatosCercanos(m.monto, m.fecha);
    if (candidatos.length === 0) {
      return {
        disponible: true,
        gasto_id_sugerido: null,
        confianza: 0,
        razon: 'No hay gastos candidatos cercanos (±3 días y ±5% de monto) sin conciliar.',
        candidatos,
      };
    }

    const baseUrl = this.config.get('PYSERVICES_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      return {
        disponible: false,
        gasto_id_sugerido: null,
        confianza: 0,
        razon: 'Asistente de conciliación no configurado (pyservices).',
        candidatos,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/sugerir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify({
          movimiento: { fecha: m.fecha, monto: m.monto, descripcion: m.descripcion },
          candidatos,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`pyservices /conciliacion/sugerir respondió ${res.status}`);
        return {
          disponible: false,
          gasto_id_sugerido: null,
          confianza: 0,
          razon: `pyservices respondió ${res.status}.`,
          candidatos,
        };
      }
      const data = (await res.json()) as {
        gasto_id_sugerido: string | null;
        confianza: number;
        razon: string;
      };
      // Solo aceptamos un id que esté realmente entre los candidatos.
      const sugerido = candidatos.some((c) => c.id === data.gasto_id_sugerido)
        ? data.gasto_id_sugerido
        : null;
      return {
        disponible: true,
        gasto_id_sugerido: sugerido,
        confianza: sugerido ? data.confianza : 0,
        razon: data.razon ?? '',
        candidatos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sugerir conciliación falló: ${msg}`);
      return {
        disponible: false,
        gasto_id_sugerido: null,
        confianza: 0,
        razon: `No se pudo contactar al asistente de conciliación: ${msg}`,
        candidatos,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gastos sin conciliar dentro de ±MATCH_DAYS días y ±MATCH_MONTO_PCT de monto. */
  private async candidatosCercanos(
    monto: number,
    fecha: string,
  ): Promise<SugerenciaConciliacion['candidatos']> {
    const base = new Date(`${fecha}T00:00:00Z`);
    const lo = new Date(base);
    lo.setUTCDate(lo.getUTCDate() - MATCH_DAYS);
    const hi = new Date(base);
    hi.setUTCDate(hi.getUTCDate() + MATCH_DAYS);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const delta = Math.abs(monto) * MATCH_MONTO_PCT;
    const montoLo = monto - delta;
    const montoHi = monto + delta;

    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('id, fecha_gasto, monto, proveedor:proveedor!proveedor_id(nombre)')
      .eq('conciliado', false)
      // Ver nota en tryAutoMatch: los cargos de bodega no se cruzan con banco.
      .neq('medio_pago', 'BODEGA')
      .gte('fecha_gasto', iso(lo))
      .lte('fecha_gasto', iso(hi))
      .gte('monto', montoLo)
      .lte('monto', montoHi)
      .limit(15);
    if (error) throw new Error(error.message);

    return (data ?? []).map((g) => {
      const row = g as {
        id: string;
        fecha_gasto: string | null;
        monto: number;
        proveedor: { nombre: string } | { nombre: string }[] | null;
      };
      const prov = Array.isArray(row.proveedor) ? row.proveedor[0] : row.proveedor;
      return {
        id: row.id,
        fecha: row.fecha_gasto,
        monto: Number(row.monto),
        proveedor: prov?.nombre ?? null,
      };
    });
  }
}
