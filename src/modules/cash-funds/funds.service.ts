import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TipoFondo } from './dto/funds.dto';
import type {
  CreateFundDto,
  ListFundsQuery,
  UpdateFundDto,
} from './dto/funds.dto';

const COLS =
  'id, usuario_id, tipo, medio_pago_asociado, monto_asignado, moneda, notas, activo, created_at, updated_at';

interface FondoRow {
  id: string;
  usuario_id: string;
  tipo: TipoFondo;
  medio_pago_asociado: string;
  monto_asignado: string;
  moneda: string;
  notas: string | null;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

interface SaldoFondo {
  total_gastado: number;
  total_repuesto: number;
  pendiente_autorizar: number;
  saldo: number;
}

@Injectable()
export class FundsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListFundsQuery) {
    let q = this.supabase.service
      .from('fondo_caja')
      .select(COLS)
      .order('tipo', { ascending: true })
      .order('created_at', { ascending: true });

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.usuario_id) q = q.eq('usuario_id', filters.usuario_id);
    if (filters.tipo) q = q.eq('tipo', filters.tipo);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as FondoRow[];
    const saldos = await this.computeSaldos(rows);
    const enriched = rows.map((r) => this.enrich(r, saldos));
    const paged = enriched.slice(
      filters.offset,
      filters.offset + filters.limit,
    );
    return {
      data: paged,
      count: enriched.length,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const row = await this.fetchRow(id);
    const saldos = await this.computeSaldos([row]);
    return this.enrich(row, saldos);
  }

  async create(dto: CreateFundDto, userId: string) {
    const { data, error } = await this.supabase.service
      .from('fondo_caja')
      .insert({
        usuario_id: dto.usuario_id,
        tipo: dto.tipo,
        medio_pago_asociado: dto.medio_pago_asociado,
        monto_asignado: dto.monto_asignado ?? 0,
        moneda: dto.moneda ?? 'MXN',
        notas: dto.notas ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException(
          'Ese usuario ya tiene un fondo de ese tipo',
        );
      if (error.code === '23503')
        throw new BadRequestException(
          `Referenced entity not found: ${error.message}`,
        );
      throw new Error(error.message);
    }
    return this.enrich(data as FondoRow, new Map());
  }

  async update(id: string, dto: UpdateFundDto, userId: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const { data, error } = await this.supabase.service
      .from('fondo_caja')
      .update({ ...dto, updated_by: userId })
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Conflicto: usuario + tipo ya existe');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Fondo ${id} not found`);
    const saldos = await this.computeSaldos([data]);
    return this.enrich(data, saldos);
  }

  async softDelete(id: string, userId: string) {
    return this.update(id, { activo: false }, userId);
  }

  private async fetchRow(id: string): Promise<FondoRow> {
    const { data, error } = await this.supabase.service
      .from('fondo_caja')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Fondo ${id} not found`);
    return data;
  }

  /** Calcula el saldo de cada fondo cruzando gastos y movimientos. */
  private async computeSaldos(
    fondos: FondoRow[],
  ): Promise<Map<string, SaldoFondo>> {
    const result = new Map<string, SaldoFondo>();
    if (fondos.length === 0) return result;

    const usuarioIds = [...new Set(fondos.map((f) => f.usuario_id))];
    const fondoIds = fondos.map((f) => f.id);

    // Gastos de caja chica de esos usuarios.
    const { data: gastos, error: gErr } = await this.supabase.service
      .from('gasto')
      .select('usuario_captura_id, medio_pago, monto, moneda')
      .in('usuario_captura_id', usuarioIds)
      .in('medio_pago', ['EFECTIVO', 'PERSONAL_PABLO', 'PERSONAL_ALE']);
    if (gErr) throw new Error(gErr.message);

    // gastoMap: clave usuario|medio_pago|moneda -> suma.
    const gastoMap = new Map<string, number>();
    for (const g of (gastos ?? []) as {
      usuario_captura_id: string;
      medio_pago: string;
      monto: string;
      moneda: string;
    }[]) {
      const key = `${g.usuario_captura_id}|${g.medio_pago}|${g.moneda}`;
      gastoMap.set(key, (gastoMap.get(key) ?? 0) + Number(g.monto));
    }

    // Movimientos de esos fondos.
    const { data: movs, error: mErr } = await this.supabase.service
      .from('movimiento_fondo')
      .select('fondo_id, monto, estado')
      .in('fondo_id', fondoIds);
    if (mErr) throw new Error(mErr.message);

    const autorizado = new Map<string, number>();
    const solicitado = new Map<string, number>();
    for (const m of (movs ?? []) as {
      fondo_id: string;
      monto: string;
      estado: string;
    }[]) {
      const monto = Number(m.monto);
      if (m.estado === 'AUTORIZADO') {
        autorizado.set(m.fondo_id, (autorizado.get(m.fondo_id) ?? 0) + monto);
      } else if (m.estado === 'SOLICITADO') {
        solicitado.set(m.fondo_id, (solicitado.get(m.fondo_id) ?? 0) + monto);
      }
    }

    for (const f of fondos) {
      const gastado =
        gastoMap.get(`${f.usuario_id}|${f.medio_pago_asociado}|${f.moneda}`) ??
        0;
      const repuesto = autorizado.get(f.id) ?? 0;
      const pendiente = solicitado.get(f.id) ?? 0;
      const saldo =
        f.tipo === TipoFondo.FIJO
          ? Number(f.monto_asignado) + repuesto - gastado
          : gastado - repuesto;
      result.set(f.id, {
        total_gastado: round2(gastado),
        total_repuesto: round2(repuesto),
        pendiente_autorizar: round2(pendiente),
        saldo: round2(saldo),
      });
    }
    return result;
  }

  private enrich(row: FondoRow, saldos: Map<string, SaldoFondo>) {
    const s =
      saldos.get(row.id) ??
      ({
        total_gastado: 0,
        total_repuesto: 0,
        pendiente_autorizar: 0,
        saldo: row.tipo === TipoFondo.FIJO ? Number(row.monto_asignado) : 0,
      } satisfies SaldoFondo);
    return { ...row, ...s };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
