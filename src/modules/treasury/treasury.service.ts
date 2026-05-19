import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

interface CuentaRow {
  id: string;
  alias: string;
  banco: string;
  moneda: string;
}

interface MovRow {
  cuenta_bancaria_id: string;
  fecha: string;
  tipo: string;
  monto: string;
  saldo_posterior: string | null;
  conciliado: boolean;
  created_at: string;
}

@Injectable()
export class TreasuryService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Dashboard de tesoreria: saldos por cuenta + gastos por tarjeta del mes. */
  async dashboard() {
    const [cuentas, movimientos, tarjetas] = await Promise.all([
      this.fetchCuentas(),
      this.fetchMovimientos(),
      this.fetchTarjetas(),
    ]);

    const porCuenta = new Map<string, MovRow[]>();
    for (const m of movimientos) {
      const arr = porCuenta.get(m.cuenta_bancaria_id) ?? [];
      arr.push(m);
      porCuenta.set(m.cuenta_bancaria_id, arr);
    }

    const cuentasResumen = cuentas.map((c) => {
      const movs = porCuenta.get(c.id) ?? [];
      let abonos = 0;
      let cargos = 0;
      let pendientes = 0;
      for (const m of movs) {
        const monto = Number(m.monto);
        if (m.tipo === 'ABONO') abonos += monto;
        else cargos += monto;
        if (!m.conciliado) pendientes += 1;
      }
      // Saldo: el saldo_posterior mas reciente; si no hay, el flujo neto.
      const ordenados = [...movs].sort((a, b) =>
        a.fecha === b.fecha
          ? a.created_at.localeCompare(b.created_at)
          : a.fecha.localeCompare(b.fecha),
      );
      const ultimoConSaldo = [...ordenados]
        .reverse()
        .find((m) => m.saldo_posterior !== null);
      const saldo = ultimoConSaldo
        ? Number(ultimoConSaldo.saldo_posterior)
        : abonos - cargos;
      return {
        id: c.id,
        alias: c.alias,
        banco: c.banco,
        moneda: c.moneda,
        saldo: round2(saldo),
        saldo_es_estimado: !ultimoConSaldo,
        total_abonos: round2(abonos),
        total_cargos: round2(cargos),
        movimientos_count: movs.length,
        pendientes_conciliar: pendientes,
      };
    });

    const periodo = currentMonthRange();
    const gastosPorTarjeta = await this.gastosPorTarjeta(periodo, tarjetas);

    return {
      cuentas: cuentasResumen,
      gastos_por_tarjeta: gastosPorTarjeta,
      periodo_tarjetas: periodo,
    };
  }

  private async fetchCuentas(): Promise<CuentaRow[]> {
    const { data, error } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda')
      .eq('activa', true)
      .order('alias', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchMovimientos(): Promise<MovRow[]> {
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(
        'cuenta_bancaria_id, fecha, tipo, monto, saldo_posterior, conciliado, created_at',
      );
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  private async fetchTarjetas(): Promise<Map<string, string>> {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .select('terminacion, nombre_titular');
    if (error) throw new Error(error.message);
    return new Map(
      (data ?? []).map((t) => [
        t.terminacion as string,
        t.nombre_titular as string,
      ]),
    );
  }

  private async gastosPorTarjeta(
    periodo: { desde: string; hasta: string },
    titulares: Map<string, string>,
  ) {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select('tarjeta_terminacion, monto')
      .not('tarjeta_terminacion', 'is', null)
      .gte('fecha_gasto', periodo.desde)
      .lte('fecha_gasto', periodo.hasta);
    if (error) throw new Error(error.message);

    const agg = new Map<string, { total: number; count: number }>();
    for (const g of (data ?? []) as {
      tarjeta_terminacion: string;
      monto: string;
    }[]) {
      const prev = agg.get(g.tarjeta_terminacion) ?? { total: 0, count: 0 };
      prev.total += Number(g.monto);
      prev.count += 1;
      agg.set(g.tarjeta_terminacion, prev);
    }

    return [...agg.entries()]
      .map(([terminacion, v]) => ({
        terminacion,
        titular: titulares.get(terminacion) ?? null,
        total: round2(v.total),
        count: v.count,
      }))
      .sort((a, b) => b.total - a.total);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function currentMonthRange(): { desde: string; hasta: string } {
  const now = new Date();
  const desde = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    desde: desde.toISOString().slice(0, 10),
    hasta: now.toISOString().slice(0, 10),
  };
}
