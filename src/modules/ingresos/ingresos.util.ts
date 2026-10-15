/**
 * Helpers PUROS del módulo de INGRESOS (24-sep-2026, contrato §5.3). Sin BD,
 * sin reloj: el servicio trae los datos y decide con esto (specs con los
 * casos reales).
 *
 * Reglas de dinero (no negociables): los montos son NOMINALES por moneda
 * (jamás se convierten aquí), `monto` = BRUTO y neto = monto − comisión. El
 * dinero de un vuelo sigue saliendo SOLO de `cobro_vuelo` vía `cobrosEnUsd`.
 */
import {
  estadoBancoCobro,
  type CoberturaCobro,
} from '../../common/cobro-banco.util';
import type { ViaConciliacion } from '../../common/cobro-conciliado.util';
import { primeraLinea } from '../conciliacion/auto-cruce.util';
import type {
  EstadoConciliacionEntrada,
  EstadoConciliacionIngreso,
  ParcialEntrada,
} from './ingresos.types';

/** Tolerancia (moneda nativa) al cuadrar un abono con un ingreso. */
export const TOLERANCIA_INGRESO = 1.0;

export function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Neto del ingreso = bruto − comisión (r2). */
export function netoIngreso(monto: number, comision: number | null): number {
  const c = Number(comision) > 0 ? Number(comision) : 0;
  return r2((Number(monto) || 0) - c);
}

/** Saldo por aplicar de un anticipo: max(0, monto − aplicado) (r2). */
export function saldoAnticipo(monto: number, aplicado: number): number {
  return Math.max(0, r2((Number(monto) || 0) - (Number(aplicado) || 0)));
}

/**
 * Comisión que lleva el cobro de UNA aplicación del anticipo: PROPORCIONAL
 * al monto aplicado; la aplicación que AGOTA el saldo lleva el RESIDUO
 * exacto ⇒ Σ comisiones aplicadas == comisión del anticipo (al centavo).
 * Sin comisión en el anticipo ⇒ 0 EXPLÍCITO (sin él, un anticipo PAYWISE
 * provisionaría el 8.857 % que el banco jamás cobró).
 * Caso: 10,000.00 con 885.70 aplicado 3,333.33 + 3,333.33 + 3,333.34 ⇒
 * 295.23 + 295.23 + 295.24 = 885.70.
 */
export function comisionDeAplicacion(p: {
  comision_anticipo: number | null;
  monto_anticipo: number;
  aplicado_previo: number;
  comision_previa: number;
  monto: number;
}): number {
  const comision = Number(p.comision_anticipo) || 0;
  const total = Number(p.monto_anticipo) || 0;
  if (!(comision > 0) || !(total > 0)) return 0;
  const agota = (Number(p.aplicado_previo) || 0) + p.monto >= total - 0.005;
  if (agota) {
    return Math.max(0, r2(comision - (Number(p.comision_previa) || 0)));
  }
  return Math.max(0, r2((comision * p.monto) / total));
}

/**
 * ¿El abono cuadra con el ingreso? (regla 6.3, tolerancia 1.00): el NETO del
 * ingreso contra lo depositado, o el BRUTO contra el `monto_bruto` del abono
 * (pasarela) o contra lo depositado (el banco no descontó la comisión).
 * `diferencia` = la menor de las comparaciones (la del neto si ninguna
 * cuadra).
 */
export function montoCuadraIngreso(
  abono: { monto: number; monto_bruto: number | null },
  ingreso: { monto: number; comision_monto: number | null },
  tolerancia: number = TOLERANCIA_INGRESO,
): { cuadra: boolean; diferencia: number; por: 'NETO' | 'BRUTO' | null } {
  const neto = netoIngreso(ingreso.monto, ingreso.comision_monto);
  const bruto = r2(Number(ingreso.monto) || 0);
  const deposito = r2(Number(abono.monto) || 0);
  const difNeto = r2(Math.abs(neto - deposito));
  const refBruto =
    abono.monto_bruto != null ? r2(Number(abono.monto_bruto) || 0) : deposito;
  const difBruto = r2(Math.abs(bruto - refBruto));
  const tol = tolerancia + 1e-9;
  if (difNeto <= tol) return { cuadra: true, diferencia: difNeto, por: 'NETO' };
  if (difBruto <= tol) {
    return { cuadra: true, diferencia: difBruto, por: 'BRUTO' };
  }
  return { cuadra: false, diferencia: difNeto, por: null };
}

/**
 * «Concepto» de un COBRO de vuelo (regla ÚNICA, la de la lista de Ingresos y
 * la de la conciliación al revés, invariante 78): la referencia capturada
 * (recortada) o, si no hay, la PRIMERA línea de las notas; null si ninguna.
 * Las notas crudas nunca viajan.
 */
export function conceptoDeCobro(c: {
  referencia?: unknown;
  notas?: unknown;
}): string | null {
  const ref = typeof c.referencia === 'string' ? c.referencia.trim() : '';
  if (ref) return ref;
  return primeraLinea(typeof c.notas === 'string' ? c.notas : null) || null;
}

/** Estado de conciliación de un INGRESO (sin cuenta = no pasa por el banco). */
export function estadoConciliacionIngreso(
  i: { cuenta_bancaria_id: string | null },
  movimientoId: string | null,
): EstadoConciliacionIngreso {
  if (movimientoId) return 'CONCILIADO';
  return i.cuenta_bancaria_id ? 'SIN_CONCILIAR' : 'NO_BANCARIO';
}

/**
 * Estado de conciliación de un COBRO de vuelo — regla ÚNICA = la de «Cobros
 * sin banco» (y del aviso del pre-cierre), para que Ingresos y Conciliación
 * digan el MISMO número. Desde el 0.0.78 (invariante 77) es
 * `estadoBancoCobro` (common/cobro-banco.util) con los 4 valores de
 * siempre: un PARCIAL viaja como SIN_CONCILIAR (+ el aditivo
 * `conciliacion.parcial` de la fila):
 * - liga directa CUBIERTA o por sobre ⇒ CONCILIADO (`cubierto` ausente o
 *   null = como hoy: la liga basta);
 * - liga directa con `cubierto === false` (abonos que no completan el
 *   cobro) ⇒ SIN_CONCILIAR;
 * - cobro de un anticipo YA conciliado ⇒ VIA_ANTICIPO;
 * - positivo sin liga con método ∈ METODOS_COBRO_ABONO_AUTO (también el de
 *   un anticipo sin conciliar: su método ES el del anticipo y un método
 *   automático siempre trae cuenta) ⇒ SIN_CONCILIAR;
 * - el resto (efectivo, dólares directo, BillPocket, otro, reembolsos) ⇒
 *   NO_BANCARIO («no se concilia uno a uno»).
 */
export function estadoConciliacionCobro(p: {
  monto: number;
  metodo: string | null;
  via: ViaConciliacion | null;
  /** Cobertura del cobro con sus abonos directos (`coberturaCobro().cubierto`). */
  cubierto?: boolean | null;
}): EstadoConciliacionEntrada {
  const e = estadoBancoCobro({
    monto: p.monto,
    metodo: p.metodo,
    via: p.via,
    cobertura:
      typeof p.cubierto === 'boolean' ? { cubierto: p.cubierto } : null,
  });
  return e === 'PARCIAL' ? 'SIN_CONCILIAR' : e;
}

/**
 * El aditivo `conciliacion.parcial` de una fila de cobro (invariante 77):
 * solo si el cobro tiene abonos directos y NO está cubierto; los números
 * son los de `coberturaCobro` tal cual (jamás se recalculan aquí).
 */
export function parcialDeCobertura(
  cob: Pick<
    CoberturaCobro,
    'cubierto' | 'n_partes' | 'monto_vinculado' | 'faltante'
  > | null,
): ParcialEntrada | null {
  if (!cob || cob.cubierto || cob.n_partes <= 0) return null;
  return {
    monto_vinculado: cob.monto_vinculado,
    faltante: cob.faltante,
    abonos_n: cob.n_partes,
  };
}

/** Estados de un vuelo que todavía no vuela (su cobro es un DEPÓSITO). */
export const ESTADOS_POR_VOLAR: ReadonlySet<string> = new Set([
  'RESERVA',
  'SOLICITUD',
  'COTIZADO',
  'CONFIRMADO',
]);

/**
 * ¿El cobro es de un vuelo que aún no vuela? (RESERVA/SOLICITUD/COTIZADO/
 * CONFIRMADO con `fecha_vuelo` ≥ hoy Cancún, o sin fecha). `diaVuelo` y
 * `hoy` son días de pared YYYY-MM-DD.
 */
export function vueloPorVolar(
  estado: string | null | undefined,
  diaVuelo: string | null,
  hoy: string,
): boolean {
  if (!estado || !ESTADOS_POR_VOLAR.has(estado)) return false;
  return diaVuelo == null || diaVuelo >= hoy;
}

/** Nombre legible de cada campo de la bitácora (ficha del panel). */
export const CAMPOS_BITACORA_INGRESO: Record<string, string> = {
  categoria: 'Categoría',
  fecha: 'Fecha',
  descripcion: 'Concepto',
  monto: 'Monto',
  comision_monto: 'Comisión del banco',
  moneda: 'Moneda',
  tc_usd_mxn: 'Tipo de cambio',
  metodo: 'Método',
  cuenta_bancaria_id: 'Cuenta',
  referencia: 'Referencia del banco',
  pagador: 'Quién pagó',
  cliente_id: 'Cliente',
  vuelo_id: 'Vuelo',
  aeronave_id: 'Avión',
  gasto_id: 'Gasto relacionado',
  notas: 'Notas',
  archivo_path: 'Comprobante',
  deleted_at: 'Baja',
  motivo_baja: 'Motivo de baja',
};

/** 'monto' → 'Monto', 'cuenta_bancaria_id' → 'Cuenta'; desconocido ⇒ capitalizado. */
export function textoCampoBitacora(campo: string): string {
  const t = CAMPOS_BITACORA_INGRESO[campo];
  if (t) return t;
  const limpio = campo.replace(/_id$/, '').replace(/_/g, ' ').toLowerCase();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/** Texto plano sin acentos, minúsculas (búsqueda `q`). */
export function normalizarBusqueda(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿Algún texto contiene la búsqueda (normalizada)? */
export function coincideBusqueda(
  q: string,
  textos: ReadonlyArray<string | number | null | undefined>,
): boolean {
  const n = normalizarBusqueda(q);
  if (!n) return true;
  return textos.some(
    (t) => t != null && normalizarBusqueda(String(t)).includes(n),
  );
}

// ═══════ Ingreso asignado a un avión (13-oct-2026, API 0.0.75, invariante 67) ═══════
// Textos ÚNICOS del API (el panel no los copia: llegan como `message` del 400
// o en `avisos[]` de la respuesta). El spec congela los tres literales.

/** 400 `AVION_SOLO_EN_RESULTADO` (servicio y CHECK `ingreso_aeronave_chk`). */
export const MSG_AVION_SOLO_EN_RESULTADO =
  'Un anticipo o una aportación no se asigna a un avión: el avión solo aplica a ingresos que suman a resultados (otros ingresos, intereses, reembolsos y ventas).';

/** Aviso al dar de alta (o cambiar) un ingreso de resultado CON avión. */
export function avisoIngresoConAvion(matricula: string): string {
  return `Este ingreso cuenta para el avión ${matricula}: entra a la hoja «Otros ingresos» de su balance y a su reparto a socios; ya no cuenta como ingreso de VuelaTour.`;
}

/** Aviso al QUITAR el avión de un ingreso de resultado. */
export const AVISO_INGRESO_SIN_AVION =
  'Este ingreso ya no cuenta para ningún avión: vuelve a ser ingreso de VuelaTour (Balance general y Libro Dinero).';
