/**
 * CRUCE PURO Paywise ↔ sistema (9-sep-2026). Fuente única del cotejo entre
 * los ABONOS importados del estado de cuenta de la pasarela (cada uno con
 * neto depositado y, si el archivo lo trae, bruto y comisión) y los cobros
 * registrados con método PAYWISE (`cobro_vuelo` positivos que no son parte
 * de sobre + sobres `cobro_grupo`).
 *
 * La usan: el auto-cruce al importar (un movimiento contra sus candidatos),
 * la auditoría (`GET /conciliacion/paywise/auditoria`), la conciliación
 * automática (`POST …/conciliar`) y el reporte de 3 hojas. Sin I/O: el
 * service carga universos y aplica los resultados.
 *
 * Reglas (pedido del cliente: «comparar si todos los movimientos
 * coinciden»):
 * 1. Un movimiento YA ligado a un cobro del universo se reporta como
 *    YA_CONCILIADO (se coteja su comisión igual); ligado a algo fuera del
 *    universo se descarta del cruce (cuenta en `ya_conciliados_fuera`).
 * 2. Para cada movimiento libre (orden por fecha), candidatos = cobros
 *    libres de la MISMA moneda a ±`dias` de la fecha del abono. Criterios
 *    en orden: NETO exacto (abono == bruto − comisión del cobro; si el
 *    cobro no tiene comisión, abono == bruto) → BRUTO exacto (bruto del
 *    archivo == bruto del cobro; o abono == bruto del cobro cuando el cobro
 *    sí tiene comisión: se registró y la pasarela no retuvo) → REFERENCIA
 *    (misma referencia normalizada, montos distintos: se reporta, NO se
 *    liga solo). Dentro de un criterio gana el más cercano en fecha; empate
 *    exacto = AMBIGUO (no se cruza; se lista para que la oficina decida).
 * 3. Comisión: la del archivo (`comision_monto`, o `monto_bruto − monto`)
 *    contra `comision_banco_monto` del cobro. Difieren > 1 centavo →
 *    `comision_distinta` (la liga sigue valiendo; el service escribe la
 *    comisión REAL en el cobro de vuelo al ligar).
 */

export type CriterioCrucePaywise =
  | 'YA_CONCILIADO'
  | 'NETO'
  | 'BRUTO'
  | 'REFERENCIA';

export interface MovimientoPaywise {
  id: string;
  /** DATE YYYY-MM-DD (fecha del banco/pasarela). */
  fecha: string;
  /** NETO depositado (moneda de la cuenta). */
  monto: number;
  monto_bruto?: number | null;
  comision_monto?: number | null;
  referencia?: string | null;
  descripcion?: string | null;
  moneda?: string | null;
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
}

export interface CobroPaywise {
  tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO';
  /** cobro_vuelo.id o cobro_grupo.id. */
  id: string;
  /** ISO timestamptz (`fecha_cobro`). */
  fecha_cobro: string;
  /** BRUTO que pagó el cliente. */
  monto: number;
  moneda: string;
  metodo_cobro?: string | null;
  comision_banco_monto?: number | null;
  referencia?: string | null;
  vuelo_id?: string | null;
  folio?: number | null;
  grupo_id?: string | null;
  grupo_folio?: number | null;
  cliente?: string | null;
}

export interface CrucePaywise {
  movimiento: MovimientoPaywise;
  cobro: CobroPaywise;
  criterio: CriterioCrucePaywise;
  /** |días| entre el abono y el cobro. */
  dif_dias: number;
  /** Neto que el sistema esperaba (bruto − comisión del cobro). */
  neto_sistema: number;
  /** Comisión según el archivo de Paywise (null si el archivo no la trae). */
  comision_paywise: number | null;
  /** Comisión registrada en el cobro (0 si no tiene). */
  comision_sistema: number;
  /** comision_paywise − comision_sistema (null sin dato de Paywise). */
  dif_comision: number | null;
  comision_distinta: boolean;
  /** monto_bruto del archivo − bruto del cobro (null sin bruto en archivo). */
  dif_bruto: number | null;
  /** abono − neto_sistema (0 en NETO exacto). */
  dif_neto: number;
}

export interface AmbiguoPaywise {
  movimiento: MovimientoPaywise;
  criterio: Exclude<CriterioCrucePaywise, 'YA_CONCILIADO'>;
  candidatos: CobroPaywise[];
}

export interface ResultadoCrucePaywise {
  /** Cruces válidos (YA_CONCILIADO + NETO + BRUTO). */
  coinciden: CrucePaywise[];
  /** Subconjunto de `coinciden` con comisión (o bruto) distinta. */
  comision_distinta: CrucePaywise[];
  /** Misma referencia pero el dinero NO cuadra: se reporta, no se liga. */
  referencia_monto_distinto: CrucePaywise[];
  /** Abonos de Paywise sin cobro en el sistema. */
  solo_paywise: MovimientoPaywise[];
  /** Cobros PAYWISE del sistema sin abono en Paywise. */
  solo_sistema: CobroPaywise[];
  ambiguos: AmbiguoPaywise[];
  /** Movimientos ligados a cobros FUERA del universo (no se cruzan). */
  ya_conciliados_fuera: number;
}

export interface OpcionesCrucePaywise {
  /** Ventana ±días entre abono y cobro (default 5: liquidación diferida). */
  dias?: number;
  /** Tolerancia de igualdad de montos (default 0.01). */
  tolerancia?: number;
}

export const PAYWISE_VENTANA_DIAS = 5;
const TOL_DEFAULT = 0.01;
const MS_DIA = 86_400_000;

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pos(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Referencia normalizada para comparar (sin espacios/signos, minúsculas). */
export function normalizarReferencia(
  ref: string | null | undefined,
): string | null {
  if (typeof ref !== 'string') return null;
  const n = ref.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Referencias de 1-3 caracteres ("1", "ok") no identifican nada.
  return n.length >= 4 ? n : null;
}

/**
 * Día (ms UTC a medianoche) de un DATE `YYYY-MM-DD` (tal cual: la fecha del
 * banco ya es un día) o de un timestamp ISO (truncado a día CANCÚN, UTC−5:
 * un cobro capturado a las 22:00 Cancún del día 3 es del día 3, no del 4
 * UTC).
 */
function diaMs(fecha: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const ms = Date.parse(`${fecha}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  const ms = Date.parse(fecha);
  if (!Number.isFinite(ms)) return Number.NaN;
  const cancun = new Date(ms - 5 * 3_600_000);
  return Date.UTC(
    cancun.getUTCFullYear(),
    cancun.getUTCMonth(),
    cancun.getUTCDate(),
  );
}

export function difDias(fechaMov: string, fechaCobro: string): number {
  const a = diaMs(fechaMov);
  const b = diaMs(fechaCobro);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((a - b) / MS_DIA));
}

/** Neto que el sistema espera del cobro: bruto − comisión registrada. */
export function netoSistema(cobro: CobroPaywise): number {
  const comision = pos(cobro.comision_banco_monto) ?? 0;
  return r2(num(cobro.monto) - comision);
}

/** Comisión según el archivo (directa o por diferencia bruto − neto). */
export function comisionPaywise(mov: MovimientoPaywise): number | null {
  const directa = mov.comision_monto;
  if (directa != null && Number.isFinite(Number(directa)))
    return r2(Number(directa));
  const bruto = mov.monto_bruto;
  if (bruto != null && Number.isFinite(Number(bruto)))
    return r2(Number(bruto) - num(mov.monto));
  return null;
}

function armarCruce(
  mov: MovimientoPaywise,
  cobro: CobroPaywise,
  criterio: CriterioCrucePaywise,
  tol: number,
): CrucePaywise {
  const neto = netoSistema(cobro);
  const comSis = pos(cobro.comision_banco_monto) ?? 0;
  const comPw = comisionPaywise(mov);
  const difCom = comPw == null ? null : r2(comPw - comSis);
  const brutoArchivo = mov.monto_bruto;
  const difBruto =
    brutoArchivo != null && Number.isFinite(Number(brutoArchivo))
      ? r2(Number(brutoArchivo) - num(cobro.monto))
      : null;
  return {
    movimiento: mov,
    cobro,
    criterio,
    dif_dias: difDias(mov.fecha, cobro.fecha_cobro),
    neto_sistema: neto,
    comision_paywise: comPw,
    comision_sistema: r2(comSis),
    dif_comision: difCom,
    comision_distinta:
      (difCom != null && Math.abs(difCom) > tol) ||
      (difBruto != null && Math.abs(difBruto) > tol),
    dif_bruto: difBruto,
    dif_neto: r2(num(mov.monto) - neto),
  };
}

function igual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol + 1e-9;
}

/** Cobro cuadra por NETO: abono == bruto − comisión (o == bruto sin comisión). */
function cuadraNeto(
  mov: MovimientoPaywise,
  cobro: CobroPaywise,
  tol: number,
): boolean {
  return igual(num(mov.monto), netoSistema(cobro), tol);
}

/**
 * Cobro cuadra por BRUTO: el bruto del archivo == bruto del cobro, o (sin
 * bruto en el archivo) el abono == bruto de un cobro que SÍ tiene comisión
 * registrada (la pasarela no retuvo lo esperado).
 */
function cuadraBruto(
  mov: MovimientoPaywise,
  cobro: CobroPaywise,
  tol: number,
): boolean {
  const brutoArchivo = mov.monto_bruto;
  if (brutoArchivo != null && Number.isFinite(Number(brutoArchivo))) {
    return igual(Number(brutoArchivo), num(cobro.monto), tol);
  }
  const comision = pos(cobro.comision_banco_monto);
  return comision != null && igual(num(mov.monto), num(cobro.monto), tol);
}

function cuadraReferencia(mov: MovimientoPaywise, cobro: CobroPaywise) {
  const a = normalizarReferencia(mov.referencia);
  const b = normalizarReferencia(cobro.referencia);
  return a != null && b != null && a === b;
}

/**
 * Cruce completo. Determinista: movimientos por fecha (y id), cobros por
 * fecha (y id). Un cobro se liga a lo más con UN movimiento.
 */
export function cruzarPaywise(
  movimientos: ReadonlyArray<MovimientoPaywise>,
  cobros: ReadonlyArray<CobroPaywise>,
  opts: OpcionesCrucePaywise = {},
): ResultadoCrucePaywise {
  const dias = opts.dias ?? PAYWISE_VENTANA_DIAS;
  const tol = opts.tolerancia ?? TOL_DEFAULT;
  const porCobroId = new Map<string, CobroPaywise>();
  const porSobreId = new Map<string, CobroPaywise>();
  for (const c of cobros) {
    if (c.tipo === 'SOBRE_GRUPO') porSobreId.set(c.id, c);
    else porCobroId.set(c.id, c);
  }

  const coinciden: CrucePaywise[] = [];
  const referenciaMontoDistinto: CrucePaywise[] = [];
  const ambiguos: AmbiguoPaywise[] = [];
  const soloPaywise: MovimientoPaywise[] = [];
  const usados = new Set<string>(); // `${tipo}:${id}` de cobros ya cruzados
  let fuera = 0;

  const clave = (c: CobroPaywise) => `${c.tipo}:${c.id}`;
  const movsOrdenados = [...movimientos].sort(
    (a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id),
  );

  // 1) Ya ligados.
  const libres: MovimientoPaywise[] = [];
  for (const m of movsOrdenados) {
    const cobroId =
      typeof m.cobro_id === 'string' && m.cobro_id ? m.cobro_id : null;
    const sobreId =
      typeof m.cobro_grupo_id === 'string' && m.cobro_grupo_id
        ? m.cobro_grupo_id
        : null;
    if (!cobroId && !sobreId) {
      libres.push(m);
      continue;
    }
    const cobro = cobroId
      ? porCobroId.get(cobroId)
      : porSobreId.get(sobreId as string);
    if (!cobro) {
      fuera += 1;
      continue;
    }
    usados.add(clave(cobro));
    coinciden.push(armarCruce(m, cobro, 'YA_CONCILIADO', tol));
  }

  // 2) Cruce por criterios.
  const cobrosOrdenados = [...cobros].sort(
    (a, b) =>
      a.fecha_cobro.localeCompare(b.fecha_cobro) || a.id.localeCompare(b.id),
  );
  const elegir = (
    cands: CobroPaywise[],
    mov: MovimientoPaywise,
  ): { unico: CobroPaywise | null; empate: CobroPaywise[] } => {
    if (cands.length === 0) return { unico: null, empate: [] };
    if (cands.length === 1) return { unico: cands[0], empate: [] };
    const conDias = cands.map((c) => ({
      c,
      d: difDias(mov.fecha, c.fecha_cobro),
    }));
    const min = Math.min(...conDias.map((x) => x.d));
    const cercanos = conDias.filter((x) => x.d === min).map((x) => x.c);
    return cercanos.length === 1
      ? { unico: cercanos[0], empate: [] }
      : { unico: null, empate: cercanos };
  };

  for (const m of libres) {
    const moneda = m.moneda ?? null;
    const ventana = cobrosOrdenados.filter(
      (c) =>
        !usados.has(clave(c)) &&
        (moneda == null || c.moneda === moneda) &&
        difDias(m.fecha, c.fecha_cobro) <= dias,
    );
    let cruzado = false;
    const niveles: Array<{
      criterio: Exclude<CriterioCrucePaywise, 'YA_CONCILIADO'>;
      pasa: (c: CobroPaywise) => boolean;
    }> = [
      { criterio: 'NETO', pasa: (c) => cuadraNeto(m, c, tol) },
      { criterio: 'BRUTO', pasa: (c) => cuadraBruto(m, c, tol) },
      { criterio: 'REFERENCIA', pasa: (c) => cuadraReferencia(m, c) },
    ];
    for (const nivel of niveles) {
      const cands = ventana.filter(nivel.pasa);
      if (cands.length === 0) continue;
      const { unico, empate } = elegir(cands, m);
      if (!unico) {
        ambiguos.push({
          movimiento: m,
          criterio: nivel.criterio,
          candidatos: empate,
        });
        cruzado = true;
        break;
      }
      usados.add(clave(unico));
      const cruce = armarCruce(m, unico, nivel.criterio, tol);
      if (nivel.criterio === 'REFERENCIA') referenciaMontoDistinto.push(cruce);
      else coinciden.push(cruce);
      cruzado = true;
      break;
    }
    if (!cruzado) soloPaywise.push(m);
  }

  const soloSistema = cobrosOrdenados.filter((c) => !usados.has(clave(c)));
  return {
    coinciden,
    comision_distinta: coinciden.filter((c) => c.comision_distinta),
    referencia_monto_distinto: referenciaMontoDistinto,
    solo_paywise: soloPaywise,
    solo_sistema: soloSistema,
    ambiguos,
    ya_conciliados_fuera: fuera,
  };
}
