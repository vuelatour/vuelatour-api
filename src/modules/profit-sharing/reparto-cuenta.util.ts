/**
 * CUENTA CORRIENTE DEL SOCIO (v2, 2-oct-2026, API 0.0.50, migración
 * `20261002000001`) — FUENTE ÚNICA PURA (con spec). Invariante 38.
 *
 * Aclaración del cliente (1-oct-2026, audio): «cuando el socio dice:
 * necesito que me adelanten 70,000 pesos de mis utilidades, necesitamos
 * poder grabarlo en algún lado y que se lleve el HISTÓRICO de cuánto se le
 * ha ido repartiendo a los socios, cuánto falta por repartir, cómo se le
 * repartió, la fecha de la entrega y algún comprobante escaneado».
 *
 * Reglas (todas aquí; los servicios solo hacen I/O):
 *  - SALDO (lo POR ENTREGAR) = saldo_inicial_mxn + Σ utilidades generadas −
 *    Σ entregas vivas. Las utilidades NO se guardan: salen de
 *    `ProfitSharingService.compute(primer día, último día)` de CADA mes
 *    calendario desde `cuenta_desde` hasta el mes EN CURSO inclusive (los %
 *    con vigencia cambian por mes: jamás un compute de todo el rango). Del
 *    reparto de cada avión se LEE `reparto[].monto_mxn` (residuo mayor); un
 *    socio con dos vigencias en el mes suma las dos (`partesDeSociosEnAvion`).
 *  - Un mes con PÉRDIDA (utilidad negativa del avión) RESTA en la cuenta:
 *    la cuenta suma lo que dice el reparto, tal cual (decisión v2, ver
 *    invariante 38; si el cliente decide que la empresa absorbe las
 *    pérdidas, el cambio es UNA línea en `movimientosDeCuenta`).
 *  - Entregas: TODAS las vivas (`deleted_at is null`), con o sin «corresponde
 *    a» (mes/avión), también las fechadas antes de `cuenta_desde` (avisa).
 *  - Estado: |saldo| ≤ $1.00 ⇒ AL_CORRIENTE; > $1.00 ⇒ POR_ENTREGAR;
 *    < −$1.00 ⇒ ADELANTADO. Aritmética en CENTAVOS.
 *  - Una entrega que rebasa lo por entregar de MESES CERRADOS (+ $1.00) es
 *    un ADELANTO: se confirma (409 `PAGO_EXCEDE_SALDO` ⇒ `aceptar_exceso`),
 *    no se prohíbe. El candado (alta, corrección, carrera de altas) y el
 *    aviso «adelantados» del pre-cierre miden lo MISMO:
 *    `por_entregar_cerrado_mxn` = lo por entregar SIN el mes en curso (su
 *    cifra todavía se mueve: a principios de mes suele ir negativa por los
 *    gastos ya capturados, y a medias positiva con utilidad no realizada).
 *    `por_entregar_mxn` (con el mes en curso) es lo que se MUESTRA.
 *  - Avisos de la cuenta (texto listo): entregas antes del arranque, aviones
 *    dados de baja y meses en que los % de los socios de un avión no suman
 *    100 (vigencias traslapadas o huecos: la cuenta suma lo que diga el
 *    reparto, tal cual).
 */
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { diaCortoCancun } from '../../common/mes-contable.util';
import { redondearA } from '../../common/redondeo.util';
import {
  ETIQUETAS_METODO_PAGO_SOCIO,
  MONTO_PAGO_MAX,
  compararCaptura,
  esMes,
  etiquetaMes,
  etiquetaMesCorta,
  rangoDeMes,
  type AeronaveCorta,
  type MetodoPagoSocio,
  type MonedaPagoSocio,
  type PagoSocio,
} from './reparto-pago.util';

// ===================================================================
// Constantes
// ===================================================================

/**
 * Migración que la cuenta corriente NECESITA hoy: la de PESOS (invariante
 * 99; `reparto_pago.monto_mxn` / `saldo_snapshot_mxn`,
 * `reparto_cuenta_socio.saldo_inicial_mxn`). La v2 (`20261002000001`) va
 * antes: sin ella la 000006 no aplica.
 */
export const MIGRACION_REPARTO_CUENTA = '20261020000006';

/** Tabla de la configuración de cada cuenta (opcional por socio). */
export const TABLA_REPARTO_CUENTA_SOCIO = 'reparto_cuenta_socio';

/** Columna SONDA: existe ⇔ la migración 20261020000006 (pesos) está aplicada. */
export const COLUMNA_SONDA_CUENTA_SOCIO = 'saldo_snapshot_mxn';

export const COLS_REPARTO_CUENTA =
  'socio_id, cuenta_desde, saldo_inicial_mxn, notas, created_by, created_at, updated_by, updated_at';

/**
 * Arranque por default de una cuenta SIN fila: septiembre 2026 (el mes que
 * «acaba de cerrar» cuando se pidió) con saldo 0 — `configurada:false`.
 */
export const CUENTA_DESDE_DEFAULT = '2026-09';

/** Tolerancia de redondeo, la MISMA de los cobros (`refreshCobradoFlag`). */
export const TOLERANCIA_CUENTA_MXN = 1;
const TOLERANCIA_CENTAVOS = TOLERANCIA_CUENTA_MXN * 100;

/** Una cuenta abarca como máximo 36 meses (cada mes es un `compute`). */
export const MESES_CUENTA_MAX = 36;
/** Rango máximo del estado de cuenta (meses de la tabla «por mes»). */
export const MESES_ESTADO_CUENTA_MAX = 120;

export const SALDO_INICIAL_MAX_MXN = MONTO_PAGO_MAX;
export const NOTAS_CUENTA_MAX = 500;

export const ESTADOS_CUENTA_SOCIO = [
  'AL_CORRIENTE',
  'POR_ENTREGAR',
  'ADELANTADO',
] as const;
export type EstadoCuentaSocio = (typeof ESTADOS_CUENTA_SOCIO)[number];

export const ETIQUETAS_ESTADO_CUENTA: Readonly<
  Record<EstadoCuentaSocio, string>
> = {
  AL_CORRIENTE: 'Al corriente',
  POR_ENTREGAR: 'Por entregar',
  ADELANTADO: 'Adelantado',
};

export const TIPOS_MOVIMIENTO_CUENTA = [
  'SALDO_INICIAL',
  'SALDO_ANTERIOR',
  'UTILIDAD',
  'ENTREGA',
] as const;
export type TipoMovimientoCuenta = (typeof TIPOS_MOVIMIENTO_CUENTA)[number];

/** Pre-cierre: claves, títulos y tope de la lista. */
export const CLAVE_PRECIERRE_SOCIOS_POR_ENTREGAR = 'socios_por_entregar';
export const TITULO_PRECIERRE_SOCIOS_POR_ENTREGAR =
  'Socios con utilidad por entregar';
export const CLAVE_PRECIERRE_SOCIOS_ADELANTADOS = 'socios_adelantados';
export const TITULO_PRECIERRE_SOCIOS_ADELANTADOS =
  'Socios con entregas adelantadas (más de lo generado)';
export const PRECIERRE_SOCIOS_MAX = 50;

// ===================================================================
// Textos (es-MX) — el panel copia los que pinta
// ===================================================================

export const MENSAJE_CUENTA_SOCIO_NO_DISPONIBLE =
  'Las cuentas de los socios todavía no están habilitadas en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.';

export const MENSAJE_SOCIO_NO_EXISTE =
  'Ese socio no existe o no es socio de ningún avión.';

export const MENSAJE_SOCIO_SOLO_SU_CUENTA =
  'Solo puedes consultar tu propia cuenta.';

export const MENSAJE_RANGO_MESES_INVALIDO = `El mes «desde» no puede ser posterior al mes «hasta» (y el rango es de máximo ${MESES_ESTADO_CUENTA_MAX} meses).`;

export const MENSAJE_RANGO_FECHAS_INVALIDO =
  'La fecha «desde» no puede ser posterior a la fecha «hasta».';

export const MENSAJE_CUENTA_DESDE_FUTURA =
  'La cuenta no puede arrancar en un mes futuro: elige el mes en curso o uno anterior.';

const MESES_LARGOS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * INICIO OFICIAL (invariante 86, auditoría 16-oct-2026, 0.0.85): «La cuenta
 * no puede arrancar antes de septiembre de 2026 (inicio oficial).»
 */
export function mensajeCuentaAntesDelInicio(inicio: string): string {
  const [y, m] = inicio.split('-');
  const mes = MESES_LARGOS[Number(m) - 1] ?? m;
  return `La cuenta no puede arrancar antes de ${mes} de ${y} (inicio oficial).`;
}

export const MENSAJE_CUENTA_DESDE_FUERA_DE_RANGO = `La cuenta puede arrancar como máximo ${MESES_CUENTA_MAX} meses atrás. Si hubo repartos antes, súmalos en el saldo inicial.`;

export const MENSAJE_SALDO_INICIAL_INVALIDO =
  'El saldo inicial debe ser un número en pesos (MXN) con máximo 2 decimales (positivo si se le debía al socio, negativo si ya se le había adelantado).';

/** Banner del panel cuando la cuenta no está configurada (copia literal). */
export const TEXTO_CUENTA_NO_CONFIGURADA =
  'La cuenta de este socio arranca en septiembre 2026 con saldo 0. Si hubo repartos anteriores, configura el mes de arranque y el saldo inicial.';

export const DETALLE_PRECIERRE_CUENTAS_NO_DISPONIBLE =
  'Las cuentas de los socios todavía no están habilitadas en la base de datos: lo por entregar no se puede revisar aquí.';
export const DETALLE_PRECIERRE_CUENTAS_LECTURA_FALLIDA =
  'No se pudieron leer las cuentas de los socios: revísalas en Tesorería → «Pagos a socios».';

const mxn = (n: number) => fmtDineroTexto(n, 'MXN');

/**
 * 409 `PAGO_EXCEDE_SALDO`: se confirma y se reintenta con `aceptar_exceso`
 * y la MISMA llave (texto que el panel copia literal). `por_entregar_mxn`
 * es lo por entregar de MESES CERRADOS; si el mes en curso ya lleva algo
 * (≠ $0), se dice cuánto y que no cuenta.
 */
export function mensajeExcedeSaldo(d: {
  monto_mxn: number;
  por_entregar_mxn: number;
  exceso_mxn: number;
  /** Utilidad del mes EN CURSO (todavía se mueve): no cuenta en el candado. */
  mes_en_curso_mxn?: number | null;
}): string {
  const curso =
    d.mes_en_curso_mxn != null && centavos(d.mes_en_curso_mxn) !== 0
      ? `, sin contar el mes en curso: ${mxn(d.mes_en_curso_mxn)}`
      : '';
  return `Esta entrega de ${mxn(d.monto_mxn)} supera lo que hay por entregar (${mxn(d.por_entregar_mxn)}${curso}). Se registrará como ADELANTO y el saldo quedará a favor de VuelaTour por ${mxn(d.exceso_mxn)}. ¿Registrar?`;
}

// ===================================================================
// Meses
// ===================================================================

function partesMes(mes: string): [number, number] {
  const [a, m] = mes.split('-').map(Number);
  return [a, m];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `2026-12` ⇒ `2027-01`. */
export function mesSiguiente(mes: string): string {
  const [a, m] = partesMes(mes);
  return m === 12 ? `${a + 1}-01` : `${a}-${pad2(m + 1)}`;
}

/** `2027-01` ⇒ `2026-12`. */
export function mesAnterior(mes: string): string {
  const [a, m] = partesMes(mes);
  return m === 1 ? `${a - 1}-12` : `${a}-${pad2(m - 1)}`;
}

/** Mes (`YYYY-MM`) de hoy en hora Cancún (invariante 4). */
export function mesActualCancun(d: Date = new Date()): string {
  return hoyCancun(d).slice(0, 7);
}

/**
 * Meses calendario de `desdeMes` a `hastaMes` INCLUSIVE (`[]` si alguno no
 * es `YYYY-MM` o si desde > hasta). Tope defensivo de 1,200 meses.
 */
export function mesesEntre(desdeMes: string, hastaMes: string): string[] {
  if (!esMes(desdeMes) || !esMes(hastaMes) || desdeMes > hastaMes) return [];
  const out: string[] = [];
  for (let m = desdeMes; m <= hastaMes && out.length < 1200; ) {
    out.push(m);
    m = mesSiguiente(m);
  }
  return out;
}

/** Último día del mes (`2026-09` ⇒ `2026-09-30`). */
export function ultimoDiaDeMes(mes: string): string {
  return rangoDeMes(mes).hasta;
}

// ===================================================================
// Dinero
// ===================================================================

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function centavos(n: unknown): number {
  return Math.round(redondearA(num(n), 2) * 100);
}

/** Estado de la cuenta por su saldo (lo por entregar), en centavos. */
export function estadoCuenta(saldoUsd: number): EstadoCuentaSocio {
  const c = centavos(saldoUsd);
  if (c > TOLERANCIA_CENTAVOS) return 'POR_ENTREGAR';
  if (c < -TOLERANCIA_CENTAVOS) return 'ADELANTADO';
  return 'AL_CORRIENTE';
}

/**
 * ¿Una entrega de `monto_mxn` rebasa lo por entregar (+ $1.00)? Si sí, es
 * un ADELANTO (se confirma). `exceso_mxn` = monto − por entregar =
 * cuánto quedaría a favor de VuelaTour (`saldo_despues_mxn` = −exceso).
 */
export function excedeSaldo(d: {
  por_entregar_mxn: number;
  monto_mxn: number;
}): {
  excede: boolean;
  exceso_mxn: number;
  saldo_despues_mxn: number;
} {
  const p = centavos(d.por_entregar_mxn);
  const m = centavos(d.monto_mxn);
  return {
    excede: m > p + TOLERANCIA_CENTAVOS,
    exceso_mxn: (m - p) / 100,
    saldo_despues_mxn: (p - m) / 100,
  };
}

/**
 * CARRERA DE ALTAS: dos entregas al mismo socio pueden pasar a la vez el
 * candado del saldo (leer y luego insertar). Ya insertada `nuevo`, ¿rebasa
 * lo por entregar contando SOLO las entregas vivas capturadas ANTES que
 * ella? `disponible_mxn` = saldo inicial + generado (todo menos entregas).
 * Las dos peticiones concluyen lo mismo (orden de captura determinista): la
 * capturada después es la que sobra.
 */
export function excedeSaldoEnOrdenDeCaptura(d: {
  disponible_mxn: number;
  vivos: ReadonlyArray<{
    id: string;
    created_at: string;
    monto_mxn: number | string;
  }>;
  nuevo: { id: string; created_at: string; monto_mxn: number | string };
}): { excede: boolean; por_entregar_antes_mxn: number; exceso_mxn: number } {
  const antesC = d.vivos
    .filter((p) => p.id !== d.nuevo.id && compararCaptura(p, d.nuevo) < 0)
    .reduce((acc, p) => acc + centavos(p.monto_mxn), 0);
  const porEntregarAntes = (centavos(d.disponible_mxn) - antesC) / 100;
  const ex = excedeSaldo({
    por_entregar_mxn: porEntregarAntes,
    monto_mxn: num(d.nuevo.monto_mxn),
  });
  return {
    excede: ex.excede,
    por_entregar_antes_mxn: porEntregarAntes,
    exceso_mxn: ex.exceso_mxn,
  };
}

/** Saldo inicial válido: finito, ≤ 2 decimales, |x| ≤ tope. */
export function saldoInicialValido(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (Math.abs(v) > SALDO_INICIAL_MAX_MXN) return false;
  return Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

/**
 * `cuenta_desde` válido: mes real, no futuro, ≤ 36 meses atrás y — con
 * inicio oficial (invariante 86, 0.0.85) — no anterior al mes del inicio
 * (`CUENTA_ANTES_DEL_INICIO`, `details.inicio`). `inicio` null ⇒ como hoy.
 */
export function validarCuentaDesde(
  mes: unknown,
  mesActual: string,
  inicio: string | null = null,
):
  | { ok: true; mes: string }
  | {
      ok: false;
      codigo:
        | 'MES_INVALIDO'
        | 'CUENTA_DESDE_FUTURA'
        | 'CUENTA_DESDE_FUERA_DE_RANGO'
        | 'CUENTA_ANTES_DEL_INICIO';
      mensaje: string;
      details?: { inicio: string };
    } {
  if (!esMes(mes)) {
    return {
      ok: false,
      codigo: 'MES_INVALIDO',
      mensaje: 'El mes de arranque debe tener el formato AAAA-MM.',
    };
  }
  if (mes > mesActual) {
    return {
      ok: false,
      codigo: 'CUENTA_DESDE_FUTURA',
      mensaje: MENSAJE_CUENTA_DESDE_FUTURA,
    };
  }
  if (inicio && mes < inicio.slice(0, 7)) {
    return {
      ok: false,
      codigo: 'CUENTA_ANTES_DEL_INICIO',
      mensaje: mensajeCuentaAntesDelInicio(inicio),
      details: { inicio },
    };
  }
  if (mesesEntre(mes, mesActual).length > MESES_CUENTA_MAX) {
    return {
      ok: false,
      codigo: 'CUENTA_DESDE_FUERA_DE_RANGO',
      mensaje: MENSAJE_CUENTA_DESDE_FUERA_DE_RANGO,
    };
  }
  return { ok: true, mes };
}

// ===================================================================
// Utilidades del reparto (lo que se LEE de compute)
// ===================================================================

export interface AeronaveRef {
  id: string;
  matricula: string;
  modelo: string;
}

/** Lo que se LEE de `compute()`: el avión y su reparto. */
export interface RepartoAvionInput {
  aeronave: AeronaveRef;
  /** Σ % de los socios del avión en el periodo (≠ 100 ⇒ vigencias mal). */
  reparto_porcentaje_total?: number | null;
  reparto: ReadonlyArray<{
    socio_id: string;
    socio_nombre: string;
    porcentaje: number;
    monto_mxn: number;
  }>;
}

/** Lo que el reparto del mes le toca a un socio en un avión. */
export interface PartesDeSocio {
  nombre: string;
  /** Σ % (3 decimales). */
  porcentaje: number;
  /** Σ `monto_mxn` en centavos ⇒ MXN. */
  utilidad_mxn: number;
}

/**
 * FUENTE ÚNICA de «utilidad y % de cada socio en un avión» en un mes. Un
 * socio con dos vigencias que tocan el mes aparece dos veces en el reparto:
 * se SUMA (el % total ≠ 100 ya lo delata el badge del reparto). Orden de
 * inserción = el del reparto.
 */
export function partesDeSociosEnAvion(
  avion: RepartoAvionInput,
): Map<string, PartesDeSocio> {
  const acc = new Map<string, { nombre: string; pct: number; c: number }>();
  for (const r of avion.reparto) {
    const s = acc.get(r.socio_id) ?? { nombre: r.socio_nombre, pct: 0, c: 0 };
    s.pct += num(r.porcentaje);
    s.c += Math.round(num(r.monto_mxn) * 100);
    acc.set(r.socio_id, s);
  }
  const out = new Map<string, PartesDeSocio>();
  for (const [id, s] of acc) {
    out.set(id, {
      nombre: s.nombre,
      porcentaje: redondearA(s.pct, 3),
      utilidad_mxn: s.c / 100,
    });
  }
  return out;
}

/** Utilidad de UN mes, ya por socio (lo que se memoiza: datos mínimos). */
export interface UtilidadMesSocios {
  mes: string;
  /** Mes en curso: la cifra todavía se mueve (no se memoiza). */
  en_curso: boolean;
  /**
   * CIERRE DE MES (16-oct-2026, API 0.0.88, invariante 89; ADITIVO, solo
   * con la migración): `SNAPSHOT_CIERRE` = utilidad CONGELADA al cerrar el
   * mes (`cierre_mes.socios_snapshot`); `EN_VIVO` = compute de hoy.
   * Ausente = API sin la migración (siempre en vivo, como 0.0.87).
   */
  origen?: 'SNAPSHOT_CIERRE' | 'EN_VIVO';
  /** Con `SNAPSHOT_CIERRE`: cuándo se cerró el mes (timestamptz). */
  cerrado_at?: string | null;
  aviones: Array<{
    aeronave: AeronaveCorta;
    /**
     * Σ % de los socios del avión en el mes, LEÍDO de compute (null si no
     * vino). ≠ 100 ⇒ vigencias traslapadas (dos filas del mismo socio que
     * tocan el mes suman su % completo cada una) o con hueco: aviso.
     */
    reparto_porcentaje_total: number | null;
    socios: Array<{ socio_id: string; porcentaje: number; monto_mxn: number }>;
    /**
     * CIERRE POR AVIÓN (23-oct-2026, invariante 105; ADITIVO): en un mes
     * PARCIAL cada avión dice su origen — `SNAPSHOT_CIERRE` (congelado al
     * cerrar ESE avión, con su `cerrado_at`) o `EN_VIVO`. Ausente = el del
     * mes (`UtilidadMesSocios.origen`).
     */
    origen?: 'SNAPSHOT_CIERRE' | 'EN_VIVO';
    cerrado_at?: string | null;
  }>;
}

/**
 * `compute(mes).aviones` ⇒ `UtilidadMesSocios` (aviones por matrícula,
 * socios con `partesDeSociosEnAvion`). No recalcula nada: solo lee.
 */
export function utilidadMesDesdeAviones(
  mes: string,
  aviones: ReadonlyArray<RepartoAvionInput>,
  enCurso: boolean,
): UtilidadMesSocios {
  return {
    mes,
    en_curso: enCurso,
    aviones: [...aviones]
      .sort(
        (a, b) =>
          a.aeronave.matricula.localeCompare(b.aeronave.matricula, 'es') ||
          a.aeronave.id.localeCompare(b.aeronave.id),
      )
      .map((a) => ({
        aeronave: { id: a.aeronave.id, matricula: a.aeronave.matricula },
        reparto_porcentaje_total:
          a.reparto_porcentaje_total == null ||
          !Number.isFinite(Number(a.reparto_porcentaje_total))
            ? null
            : redondearA(Number(a.reparto_porcentaje_total), 3),
        socios: [...partesDeSociosEnAvion(a)].map(([socio_id, s]) => ({
          socio_id,
          porcentaje: s.porcentaje,
          monto_mxn: s.utilidad_mxn,
        })),
      })),
  };
}

export interface UtilidadAvionSocio {
  aeronave: AeronaveCorta;
  porcentaje: number;
  monto_mxn: number;
  /** CIERRE POR AVIÓN (invariante 105; ADITIVO): origen de ESE avión en un mes PARCIAL. */
  origen?: 'SNAPSHOT_CIERRE' | 'EN_VIVO';
  cerrado_at?: string | null;
}

/** Lo que el socio generó en un mes, por avión (orden por matrícula). */
export function utilidadDeSocioEnMes(
  u: UtilidadMesSocios,
  socioId: string,
): UtilidadAvionSocio[] {
  const out: UtilidadAvionSocio[] = [];
  for (const a of u.aviones) {
    const s = a.socios.find((x) => x.socio_id === socioId);
    if (s) {
      out.push({
        aeronave: a.aeronave,
        porcentaje: s.porcentaje,
        monto_mxn: s.monto_mxn,
        ...(a.origen
          ? { origen: a.origen, cerrado_at: a.cerrado_at ?? null }
          : {}),
      });
    }
  }
  return out;
}

// ===================================================================
// Cuenta, socio y aviones
// ===================================================================

/** Fila cruda de `reparto_cuenta_socio`. */
export interface CuentaRow {
  socio_id: string;
  cuenta_desde: string;
  saldo_inicial_mxn: number | string;
  notas: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface CuentaSocio {
  /** Primer mes que suma utilidades (`YYYY-MM`). */
  cuenta_desde: string;
  /** Positivo = se le debía al arrancar; negativo = ya se le había adelantado. */
  saldo_inicial_mxn: number;
  notas: string | null;
  /** false = sin fila: default septiembre 2026 con saldo 0. */
  configurada: boolean;
  /** ADITIVO: última vez que se configuró (null sin fila). */
  updated_at: string | null;
}

/** Cuenta SIN fila: septiembre 2026, saldo 0, `configurada:false`. */
export function cuentaDefault(): CuentaSocio {
  return {
    cuenta_desde: CUENTA_DESDE_DEFAULT,
    saldo_inicial_mxn: 0,
    notas: null,
    configurada: false,
    updated_at: null,
  };
}

/** Fila ⇒ `CuentaSocio` (sin fila ⇒ el default). */
export function aCuentaSocio(row: CuentaRow | null | undefined): CuentaSocio {
  if (!row) return cuentaDefault();
  const mes = String(row.cuenta_desde).slice(0, 7);
  return {
    cuenta_desde: esMes(mes) ? mes : CUENTA_DESDE_DEFAULT,
    saldo_inicial_mxn: centavos(row.saldo_inicial_mxn) / 100,
    notas: row.notas ?? null,
    configurada: true,
    updated_at: row.updated_at ?? null,
  };
}

/** Fila de `aeronave_socio`. */
export interface AeronaveSocioRow {
  aeronave_id: string;
  socio_id: string;
  porcentaje: number | string;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export interface SocioInfo {
  id: string;
  nombre: string;
  rol: string | null;
  estado: string | null;
  /**
   * ADITIVO: la propia empresa (Aero Charter Cancún) registrada como socio
   * (`usuario.es_empresa`). Su «por entregar» es dinero que la empresa se
   * debe a sí misma: el panel la MARCA; qué hacer con ella (excluirla o
   * registrar el movimiento) lo decide la oficina.
   */
  es_empresa: boolean;
}

export interface AvionDeSocio {
  id: string;
  matricula: string;
  /** % vigente HOY (Σ si hay dos vigencias); sin vigente, el de la más reciente. */
  porcentaje: number;
  /** ¿Es socio de ese avión HOY (día Cancún)? */
  vigente: boolean;
  /** ADITIVO: el avión está activo en la flota (dado de baja ⇒ sin utilidad). */
  activa: boolean;
}

export interface UsuarioSocioRow {
  id: string;
  nombre: string | null;
  rol: string | null;
  estado: string | null;
  es_empresa?: boolean | null;
}

export interface AeronaveFlotaRow {
  id: string;
  matricula: string | null;
  activa: boolean | null;
}

/** El socio con su cuenta, sus aviones y sus entregas vivas (aún sin cifras). */
export interface SocioBase {
  socio: SocioInfo;
  cuenta: CuentaSocio;
  aviones: AvionDeSocio[];
  /** ¿Aparece en `aeronave_socio` (cualquier vigencia)? Requisito de escritura. */
  en_aeronave_socio: boolean;
}

const vigenteEn = (r: AeronaveSocioRow, dia: string) =>
  r.vigente_desde <= dia && (r.vigente_hasta == null || r.vigente_hasta >= dia);

/**
 * Universo de socios = todos los de `aeronave_socio` (cualquier vigencia) ∪
 * los que tengan cuenta configurada ∪ los que tengan entregas. Orden por
 * nombre. Nombre desconocido ⇒ 'Socio' (mismo respaldo que `compute`).
 */
export function armarSociosBase(e: {
  sociosAeronave: ReadonlyArray<AeronaveSocioRow>;
  cuentas: ReadonlyArray<CuentaRow>;
  /** socio_id de las entregas vivas. */
  sociosConEntregas: ReadonlyArray<string>;
  usuarios: ReadonlyMap<string, UsuarioSocioRow>;
  aeronaves: ReadonlyMap<string, AeronaveFlotaRow>;
  hoy: string;
}): SocioBase[] {
  const filasPorSocio = new Map<string, AeronaveSocioRow[]>();
  for (const r of e.sociosAeronave) {
    const l = filasPorSocio.get(r.socio_id) ?? [];
    l.push(r);
    filasPorSocio.set(r.socio_id, l);
  }
  const cuentas = new Map(e.cuentas.map((c) => [c.socio_id, c]));
  const ids = new Set<string>([
    ...filasPorSocio.keys(),
    ...cuentas.keys(),
    ...e.sociosConEntregas,
  ]);
  const out: SocioBase[] = [];
  for (const id of ids) {
    const u = e.usuarios.get(id);
    const filas = filasPorSocio.get(id) ?? [];
    const porAvion = new Map<string, AeronaveSocioRow[]>();
    for (const r of filas) {
      const l = porAvion.get(r.aeronave_id) ?? [];
      l.push(r);
      porAvion.set(r.aeronave_id, l);
    }
    const aviones: AvionDeSocio[] = [...porAvion].map(([avionId, rs]) => {
      const vigentes = rs.filter((r) => vigenteEn(r, e.hoy));
      const pct =
        vigentes.length > 0
          ? vigentes.reduce((acc, r) => acc + num(r.porcentaje), 0)
          : num(
              [...rs].sort((a, b) =>
                b.vigente_desde.localeCompare(a.vigente_desde),
              )[0].porcentaje,
            );
      const av = e.aeronaves.get(avionId);
      return {
        id: avionId,
        matricula: av?.matricula ?? '',
        porcentaje: redondearA(pct, 3),
        vigente: vigentes.length > 0,
        activa: av?.activa !== false,
      };
    });
    aviones.sort(
      (a, b) =>
        Number(b.vigente) - Number(a.vigente) ||
        a.matricula.localeCompare(b.matricula, 'es') ||
        a.id.localeCompare(b.id),
    );
    out.push({
      socio: {
        id,
        nombre: u?.nombre?.trim() || 'Socio',
        rol: u?.rol ?? null,
        estado: u?.estado ?? null,
        es_empresa: u?.es_empresa === true,
      },
      cuenta: aCuentaSocio(cuentas.get(id)),
      aviones,
      en_aeronave_socio: filas.length > 0,
    });
  }
  return out.sort(
    (a, b) =>
      a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
      a.socio.id.localeCompare(b.socio.id),
  );
}

/** Tolerancia del Σ % de los socios de un avión (los % llevan 3 decimales). */
const TOLERANCIA_PORCENTAJE_TOTAL = 0.005;

/**
 * Meses (desde el arranque de la cuenta) en que el reparto de un avión del
 * socio NO suma 100 % — p. ej. 69 % + 70 % = 139 % cuando se cerró una
 * vigencia y se abrió otra en el MISMO mes (compute da a cada una su %
 * completo) o un hueco entre vigencias. La cuenta suma lo que diga el
 * reparto: el aviso pide revisar la ficha del avión. Uno por avión-mes.
 */
export function avisosPorcentajesDeReparto(e: {
  socioId: string;
  cuenta: CuentaSocio;
  utilidades: ReadonlyArray<UtilidadMesSocios>;
}): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const u of e.utilidades) {
    if (!esMes(u.mes) || u.mes < e.cuenta.cuenta_desde) continue;
    for (const a of u.aviones) {
      const t = a.reparto_porcentaje_total;
      if (t == null || Math.abs(t - 100) < TOLERANCIA_PORCENTAJE_TOTAL) {
        continue;
      }
      if (!a.socios.some((s) => s.socio_id === e.socioId)) continue;
      const k = `${u.mes}|${a.aeronave.id}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(
        `En ${etiquetaMes(u.mes)}${u.en_curso ? ' (mes en curso)' : ''} los socios del ${a.aeronave.matricula || '(sin matrícula)'} suman ${fmtPorcentaje(t)}, no 100 %: la cuenta suma lo que dice el reparto. Revisa las vigencias y los porcentajes de los socios en la ficha del avión.`,
      );
    }
  }
  return out;
}

/**
 * Avisos de la cuenta (texto listo): entregas fechadas ANTES del arranque
 * (cuentan en el saldo: puede que el saldo inicial ya las incluya), aviones
 * dados de baja (el reparto ya no calcula su utilidad) y meses con los % de
 * un avión ≠ 100 (`avisosPorcentajesDeReparto`, si se pasan utilidades).
 */
export function avisosDeCuenta(e: {
  cuenta: CuentaSocio;
  pagos: ReadonlyArray<Pick<PagoSocio, 'fecha_pago'>>;
  aviones: ReadonlyArray<AvionDeSocio>;
  socioId?: string;
  utilidades?: ReadonlyArray<UtilidadMesSocios>;
}): string[] {
  const avisos: string[] = [];
  const arranque = `${e.cuenta.cuenta_desde}-01`;
  const previas = e.pagos.filter((p) => p.fecha_pago < arranque).length;
  if (previas > 0) {
    avisos.push(
      `Hay ${previas} entrega(s) con fecha anterior al arranque de la cuenta (${etiquetaMes(e.cuenta.cuenta_desde)}): sí descuentan del saldo. Revisa que el saldo inicial no las incluya ya.`,
    );
  }
  for (const a of e.aviones) {
    if (!a.activa) {
      avisos.push(
        `El avión ${a.matricula || '(sin matrícula)'} está dado de baja: el reparto ya no calcula su utilidad, así que no suma a esta cuenta.`,
      );
    }
  }
  if (e.socioId && e.utilidades) {
    avisos.push(
      ...avisosPorcentajesDeReparto({
        socioId: e.socioId,
        cuenta: e.cuenta,
        utilidades: e.utilidades,
      }),
    );
    // CIERRE DE MES (invariante 89): los meses CONGELADOS al cerrar.
    for (const u of e.utilidades) {
      if (u.mes < e.cuenta.cuenta_desde) continue;
      if (u.origen === 'SNAPSHOT_CIERRE') {
        avisos.push(
          `La utilidad de ${etiquetaMes(u.mes)} se congeló al cerrar el mes; si cambian porcentajes o cobros, reabre el mes y ciérralo de nuevo.`,
        );
        continue;
      }
      // CIERRE POR AVIÓN (invariante 105): mes PARCIAL — solo los aviones
      // cerrados están congelados.
      const congelados = u.aviones
        .filter((a) => a.origen === 'SNAPSHOT_CIERRE')
        .map((a) => a.aeronave.matricula || '(sin matrícula)');
      if (congelados.length > 0) {
        avisos.push(
          `La utilidad de ${etiquetaMes(u.mes)} de ${congelados.join(', ')} se congeló al cerrar ${congelados.length > 1 ? 'esos aviones' : 'ese avión'}; si cambian porcentajes o cobros, reábrelo y ciérralo de nuevo.`,
        );
      }
    }
  }
  return avisos;
}

// ===================================================================
// Movimientos (saldo corrido) — el CORAZÓN de la cuenta
// ===================================================================

export interface MovimientoCuenta {
  /** YYYY-MM-DD. UTILIDAD = último día de su mes; ENTREGA = fecha_pago. */
  fecha: string;
  tipo: TipoMovimientoCuenta;
  concepto: string;
  /** UTILIDAD: su mes · ENTREGA: «corresponde a» (null = a cuenta). */
  mes: string | null;
  aeronave: AeronaveCorta | null;
  /** % del socio en el avión (solo UTILIDAD). */
  porcentaje: number | null;
  /**
   * Lo que SUMA a lo por entregar: utilidad generada (NEGATIVA en un mes
   * con pérdida) o saldo inicial a favor del socio.
   */
  cargo_mxn: number;
  /** Lo que RESTA (siempre ≥ 0): entregas o saldo inicial ya adelantado. */
  abono_mxn: number;
  /** Lo por entregar DESPUÉS de este movimiento. */
  saldo_mxn: number;
  /** Utilidad del mes en curso (todavía se mueve). */
  en_curso: boolean;
  pago: PagoSocio | null;
}

/** «69 %» · «33.333 %» · «12.5 %». */
export function fmtPorcentaje(p: number): string {
  return `${String(redondearA(num(p), 3))} %`;
}

/**
 * « · cierre del 16-oct» cuando la utilidad del mes viene CONGELADA del
 * cierre (invariante 89); '' en vivo (concepto de siempre).
 */
export function sufijoCierre(
  u: Pick<UtilidadMesSocios, 'origen' | 'cerrado_at'>,
): string {
  if (u.origen !== 'SNAPSHOT_CIERRE') return '';
  const dia = diaCortoCancun(u.cerrado_at);
  return dia ? ` · cierre del ${dia}` : ' · cierre del mes';
}

export function conceptoUtilidad(
  mes: string,
  matricula: string,
  porcentaje: number,
): string {
  return `Utilidad ${etiquetaMesCorta(mes)} · ${matricula || '(sin matrícula)'} ${fmtPorcentaje(porcentaje)}`;
}

/**
 * «Entrega · Transferencia · ref SPEI 001 · corresponde a sep 2026 · N4142R»
 * o, sin mes, «Adelanto a cuenta · Efectivo · $70,000 MXN a T.C. 18.5».
 * Una entrega en DÓLARES dice sus pesos (la cuenta es en pesos, invariante
 * 99): «$1,000.00 USD = $18,500.00 MXN».
 */
export function conceptoEntrega(
  p: Pick<
    PagoSocio,
    | 'mes'
    | 'metodo'
    | 'moneda'
    | 'monto'
    | 'tc_usd_mxn'
    | 'referencia'
    | 'aeronave'
  > & { monto_mxn?: number | null },
): string {
  const partes = [
    p.mes ? 'Entrega' : 'Adelanto a cuenta',
    ETIQUETAS_METODO_PAGO_SOCIO[p.metodo] ?? 'Otro',
  ];
  if (p.moneda === 'MXN') {
    partes.push(
      `${fmtDineroTexto(num(p.monto), 'MXN')}${p.tc_usd_mxn != null ? ` a T.C. ${num(p.tc_usd_mxn)}` : ''}`,
    );
  } else if (p.monto_mxn != null) {
    partes.push(
      `${fmtDineroTexto(num(p.monto), 'USD')} = ${fmtDineroTexto(num(p.monto_mxn), 'MXN')}`,
    );
  }
  if (p.referencia) partes.push(`ref ${p.referencia}`);
  if (p.mes) partes.push(`corresponde a ${etiquetaMesCorta(p.mes)}`);
  if (p.aeronave?.matricula) partes.push(p.aeronave.matricula);
  return partes.join(' · ');
}

export function conceptoSaldoInicial(saldoUsd: number): string {
  const c = centavos(saldoUsd);
  if (c > 0) return 'Arranque de la cuenta · saldo inicial a favor del socio';
  if (c < 0) return 'Arranque de la cuenta · saldo inicial ya adelantado';
  return 'Arranque de la cuenta (saldo inicial $0)';
}

export function conceptoSaldoAnterior(mesAnteriorADesde: string): string {
  return `Saldo al cierre de ${etiquetaMesCorta(mesAnteriorADesde)}`;
}

const RANGO_TIPO: Readonly<Record<TipoMovimientoCuenta, number>> = {
  SALDO_ANTERIOR: 0,
  SALDO_INICIAL: 1,
  UTILIDAD: 2,
  ENTREGA: 3,
};

export interface EntradaCuenta {
  socioId: string;
  cuenta: CuentaSocio;
  /** Utilidades por mes (las de meses < `cuenta_desde` se ignoran). */
  utilidades: ReadonlyArray<UtilidadMesSocios>;
  /** Entregas (solo cuentan las VIVAS de este socio). */
  pagos: ReadonlyArray<PagoSocio>;
  /** Pre-cierre: solo utilidades de meses ≤ este (las entregas, todas). */
  utilidadesHasta?: string;
}

/**
 * TODOS los movimientos de la cuenta, en orden (fecha; el mismo día:
 * saldo inicial, utilidades por matrícula, entregas por captura) con el
 * saldo corrido en CENTAVOS. Una utilidad de $0 no genera renglón (el
 * desglose «por mes» sí la lista). Fuente ÚNICA del saldo: el resumen, el
 * estado de cuenta, el candado del exceso y el pre-cierre la leen.
 */
export function movimientosDeCuenta(e: EntradaCuenta): MovimientoCuenta[] {
  type Linea = {
    m: Omit<MovimientoCuenta, 'saldo_mxn'>;
    delta: number;
    sub: (o: Linea) => number;
  };
  const lineas: Linea[] = [];
  const ini = centavos(e.cuenta.saldo_inicial_mxn);
  lineas.push({
    m: {
      fecha: `${e.cuenta.cuenta_desde}-01`,
      tipo: 'SALDO_INICIAL',
      concepto: conceptoSaldoInicial(ini / 100),
      mes: e.cuenta.cuenta_desde,
      aeronave: null,
      porcentaje: null,
      cargo_mxn: ini > 0 ? ini / 100 : 0,
      abono_mxn: ini < 0 ? -ini / 100 : 0,
      en_curso: false,
      pago: null,
    },
    delta: ini,
    sub: () => 0,
  });
  const vistos = new Set<string>();
  for (const u of e.utilidades) {
    if (vistos.has(u.mes)) continue;
    vistos.add(u.mes);
    if (!esMes(u.mes) || u.mes < e.cuenta.cuenta_desde) continue;
    if (e.utilidadesHasta && u.mes > e.utilidadesHasta) continue;
    for (const a of utilidadDeSocioEnMes(u, e.socioId)) {
      const c = centavos(a.monto_mxn);
      if (c === 0) continue;
      const linea: Linea = {
        m: {
          fecha: ultimoDiaDeMes(u.mes),
          tipo: 'UTILIDAD',
          concepto:
            conceptoUtilidad(u.mes, a.aeronave.matricula, a.porcentaje) +
            // CIERRE POR AVIÓN (invariante 105): en un mes PARCIAL manda el
            // origen del AVIÓN; si no lo trae, el del mes.
            sufijoCierre(a.origen ? a : u),
          mes: u.mes,
          aeronave: a.aeronave,
          porcentaje: a.porcentaje,
          cargo_mxn: c / 100,
          abono_mxn: 0,
          en_curso: u.en_curso,
          pago: null,
        },
        delta: c,
        sub: (o) =>
          a.aeronave.matricula.localeCompare(
            o.m.aeronave?.matricula ?? '',
            'es',
          ) || a.aeronave.id.localeCompare(o.m.aeronave?.id ?? ''),
      };
      lineas.push(linea);
    }
  }
  for (const p of e.pagos) {
    if (p.socio_id !== e.socioId || p.deleted_at != null) continue;
    const c = centavos(p.monto_mxn);
    lineas.push({
      m: {
        fecha: p.fecha_pago,
        tipo: 'ENTREGA',
        concepto: conceptoEntrega(p),
        mes: p.mes,
        aeronave: p.aeronave,
        porcentaje: null,
        cargo_mxn: 0,
        abono_mxn: c / 100,
        en_curso: false,
        pago: p,
      },
      delta: -c,
      sub: (o) => (o.m.pago ? compararCaptura(p, o.m.pago) : 0),
    });
  }
  lineas.sort(
    (a, b) =>
      a.m.fecha.localeCompare(b.m.fecha) ||
      RANGO_TIPO[a.m.tipo] - RANGO_TIPO[b.m.tipo] ||
      a.sub(b),
  );
  let saldo = 0;
  return lineas.map((l) => {
    saldo += l.delta;
    return { ...l.m, saldo_mxn: saldo / 100 };
  });
}

export interface TotalesCuenta {
  /** Σ utilidades generadas desde el arranque (incluye el mes en curso). */
  generado_mxn: number;
  /** Parte de `generado_mxn` del mes EN CURSO (todavía se mueve). */
  mes_en_curso_mxn: number;
  /** Σ entregas vivas (todas). */
  entregado_mxn: number;
  /** saldo inicial + generado − entregado. */
  por_entregar_mxn: number;
  /**
   * ADITIVO: lo por entregar SIN el mes en curso (= por_entregar −
   * mes_en_curso). Contra ESTE número se decide un ADELANTO (409) y el
   * aviso «adelantados» del pre-cierre.
   */
  por_entregar_cerrado_mxn: number;
  estado: EstadoCuentaSocio;
}

/** Totales leídos de los movimientos (una sola suma de cada número). */
export function totalesDeMovimientos(
  movs: ReadonlyArray<MovimientoCuenta>,
): TotalesCuenta {
  let gen = 0;
  let curso = 0;
  let ent = 0;
  for (const m of movs) {
    if (m.tipo === 'UTILIDAD') {
      gen += centavos(m.cargo_mxn);
      if (m.en_curso) curso += centavos(m.cargo_mxn);
    } else if (m.tipo === 'ENTREGA') {
      ent += centavos(m.abono_mxn);
    }
  }
  const saldo = movs.length ? movs[movs.length - 1].saldo_mxn : 0;
  return {
    generado_mxn: gen / 100,
    mes_en_curso_mxn: curso / 100,
    entregado_mxn: ent / 100,
    por_entregar_mxn: saldo,
    por_entregar_cerrado_mxn: (centavos(saldo) - curso) / 100,
    estado: estadoCuenta(saldo),
  };
}

// ===================================================================
// Resumen (GET /socios)
// ===================================================================

export interface UltimoPago {
  id: string;
  fecha_pago: string;
  monto: number;
  moneda: MonedaPagoSocio;
  /** Lo que descontó EN PESOS (invariante 99). */
  monto_mxn: number;
  /** Dólares informativos. */
  monto_usd: number;
  metodo: MetodoPagoSocio;
}

export interface FilaCuentaSocio {
  socio: SocioInfo;
  cuenta: CuentaSocio;
  generado_mxn: number;
  mes_en_curso_mxn: number;
  entregado_mxn: number;
  por_entregar_mxn: number;
  /**
   * ADITIVO: lo por entregar SIN el mes en curso. Es contra lo que el API
   * decide un ADELANTO (409 `PAGO_EXCEDE_SALDO`): el diálogo «Registrar
   * entrega» debe mostrar ESTE número como tope sin confirmación.
   */
  por_entregar_cerrado_mxn: number;
  estado: EstadoCuentaSocio;
  ultimo_pago: UltimoPago | null;
  aviones: AvionDeSocio[];
  /** ADITIVO: avisos de la cuenta (texto listo). */
  avisos: string[];
}

/** La entrega más reciente (fecha y, el mismo día, la capturada al final). */
export function ultimaEntrega(
  pagos: ReadonlyArray<PagoSocio>,
): UltimoPago | null {
  let ult: PagoSocio | null = null;
  for (const p of pagos) {
    if (p.deleted_at != null) continue;
    if (
      !ult ||
      p.fecha_pago > ult.fecha_pago ||
      (p.fecha_pago === ult.fecha_pago && compararCaptura(p, ult) > 0)
    ) {
      ult = p;
    }
  }
  return ult
    ? {
        id: ult.id,
        fecha_pago: ult.fecha_pago,
        monto: ult.monto,
        moneda: ult.moneda,
        monto_mxn: ult.monto_mxn,
        monto_usd: ult.monto_usd,
        metodo: ult.metodo,
      }
    : null;
}

/** Renglón del resumen de un socio (lo devuelven también las escrituras). */
export function filaCuentaSocio(e: {
  base: SocioBase;
  utilidades: ReadonlyArray<UtilidadMesSocios>;
  pagos: ReadonlyArray<PagoSocio>;
}): FilaCuentaSocio {
  const pagos = e.pagos.filter(
    (p) => p.socio_id === e.base.socio.id && p.deleted_at == null,
  );
  const t = totalesDeMovimientos(
    movimientosDeCuenta({
      socioId: e.base.socio.id,
      cuenta: e.base.cuenta,
      utilidades: e.utilidades,
      pagos,
    }),
  );
  return {
    socio: e.base.socio,
    cuenta: e.base.cuenta,
    generado_mxn: t.generado_mxn,
    mes_en_curso_mxn: t.mes_en_curso_mxn,
    entregado_mxn: t.entregado_mxn,
    por_entregar_mxn: t.por_entregar_mxn,
    por_entregar_cerrado_mxn: t.por_entregar_cerrado_mxn,
    estado: t.estado,
    ultimo_pago: ultimaEntrega(pagos),
    aviones: e.base.aviones,
    avisos: avisosDeCuenta({
      cuenta: e.base.cuenta,
      pagos,
      aviones: e.base.aviones,
      socioId: e.base.socio.id,
      utilidades: e.utilidades,
    }),
  };
}

export interface TotalesCuentas {
  generado_mxn: number;
  entregado_mxn: number;
  /** Σ de lo por entregar POSITIVO (lo que VuelaTour debe a los socios). */
  por_entregar_mxn: number;
  /** ADITIVO: Σ de lo adelantado (saldos negativos, en positivo). */
  adelantado_mxn: number;
  socios_por_entregar: number;
  socios_adelantados: number;
}

/** Totales del resumen. Un adelanto NO compensa lo que se le debe a otro. */
export function totalesCuentas(
  filas: ReadonlyArray<FilaCuentaSocio>,
): TotalesCuentas {
  let gen = 0;
  let ent = 0;
  let pos = 0;
  let neg = 0;
  for (const f of filas) {
    gen += centavos(f.generado_mxn);
    ent += centavos(f.entregado_mxn);
    const s = centavos(f.por_entregar_mxn);
    if (s > 0) pos += s;
    else neg -= s;
  }
  return {
    generado_mxn: gen / 100,
    entregado_mxn: ent / 100,
    por_entregar_mxn: pos / 100,
    adelantado_mxn: neg / 100,
    socios_por_entregar: filas.filter((f) => f.estado === 'POR_ENTREGAR')
      .length,
    socios_adelantados: filas.filter((f) => f.estado === 'ADELANTADO').length,
  };
}

// ===================================================================
// Estado de cuenta (GET /socios/:id/estado-cuenta)
// ===================================================================

export interface PorMesCuenta {
  mes: string;
  /** Σ utilidad del socio en el mes (0 antes del arranque). */
  utilidad_mxn: number;
  en_curso: boolean;
  /** ADITIVO (invariante 89): `SNAPSHOT_CIERRE` | `EN_VIVO` (con la migración). */
  origen?: 'SNAPSHOT_CIERRE' | 'EN_VIVO';
  por_avion: UtilidadAvionSocio[];
  /** Σ entregas con `fecha_pago` en ese mes (flujo de dinero). */
  entregado_mxn: number;
}

export interface EstadoCuentaSocioDatos {
  socio: SocioInfo;
  cuenta: CuentaSocio;
  aviones: AvionDeSocio[];
  desde: string;
  hasta: string;
  /** Saldo al cierre del mes anterior a `desde` (incluye saldo inicial y entregas previas). */
  saldo_anterior_mxn: number;
  movimientos: MovimientoCuenta[];
  por_mes: PorMesCuenta[];
  /** De TODA la cuenta, hoy (mismas cifras que el resumen). */
  totales: TotalesCuenta;
  /** ADITIVO: solo lo que cae en [desde, hasta]. */
  rango: {
    generado_mxn: number;
    entregado_mxn: number;
    saldo_final_mxn: number;
  };
  avisos: string[];
}

/**
 * Estado de cuenta con filtro de meses: los movimientos ANTERIORES a
 * `desde` se colapsan en un renglón SALDO_ANTERIOR («Saldo al cierre de …»)
 * y los POSTERIORES a `hasta` no se listan (pero sí cuentan en `totales`,
 * que es la cuenta completa de hoy).
 */
export function armarEstadoCuenta(e: {
  base: SocioBase;
  utilidades: ReadonlyArray<UtilidadMesSocios>;
  pagos: ReadonlyArray<PagoSocio>;
  desde: string;
  hasta: string;
}): EstadoCuentaSocioDatos {
  const pagos = e.pagos.filter(
    (p) => p.socio_id === e.base.socio.id && p.deleted_at == null,
  );
  const todos = movimientosDeCuenta({
    socioId: e.base.socio.id,
    cuenta: e.base.cuenta,
    utilidades: e.utilidades,
    pagos,
  });
  const desdeDia = `${e.desde}-01`;
  const hastaDia = ultimoDiaDeMes(e.hasta);
  const antes = todos.filter((m) => m.fecha < desdeDia);
  const dentro = todos.filter(
    (m) => m.fecha >= desdeDia && m.fecha <= hastaDia,
  );
  const saldoAnterior = antes.length ? antes[antes.length - 1].saldo_mxn : 0;
  const movimientos: MovimientoCuenta[] = [];
  if (antes.length > 0) {
    movimientos.push({
      fecha: desdeDia,
      tipo: 'SALDO_ANTERIOR',
      concepto: conceptoSaldoAnterior(mesAnterior(e.desde)),
      mes: mesAnterior(e.desde),
      aeronave: null,
      porcentaje: null,
      cargo_mxn: 0,
      abono_mxn: 0,
      saldo_mxn: saldoAnterior,
      en_curso: false,
      pago: null,
    });
  }
  movimientos.push(...dentro);

  const utilPorMes = new Map(e.utilidades.map((u) => [u.mes, u]));
  const por_mes: PorMesCuenta[] = mesesEntre(e.desde, e.hasta).map((mes) => {
    const u = utilPorMes.get(mes);
    const cuenta = u && mes >= e.base.cuenta.cuenta_desde;
    const porAvion = cuenta ? utilidadDeSocioEnMes(u, e.base.socio.id) : [];
    return {
      mes,
      utilidad_mxn:
        porAvion.reduce((acc, a) => acc + centavos(a.monto_mxn), 0) / 100,
      en_curso: u?.en_curso ?? false,
      // ADITIVO (invariante 89): solo cuando la utilidad trae su origen.
      ...(u?.origen ? { origen: u.origen } : {}),
      por_avion: porAvion,
      entregado_mxn:
        pagos
          .filter((p) => p.fecha_pago.slice(0, 7) === mes)
          .reduce((acc, p) => acc + centavos(p.monto_mxn), 0) / 100,
    };
  });

  let genR = 0;
  let entR = 0;
  for (const m of dentro) {
    if (m.tipo === 'UTILIDAD') genR += centavos(m.cargo_mxn);
    if (m.tipo === 'ENTREGA') entR += centavos(m.abono_mxn);
  }
  return {
    socio: e.base.socio,
    cuenta: e.base.cuenta,
    aviones: e.base.aviones,
    desde: e.desde,
    hasta: e.hasta,
    saldo_anterior_mxn: saldoAnterior,
    movimientos,
    por_mes,
    totales: totalesDeMovimientos(todos),
    rango: {
      generado_mxn: genR / 100,
      entregado_mxn: entR / 100,
      saldo_final_mxn: movimientos.length
        ? movimientos[movimientos.length - 1].saldo_mxn
        : saldoAnterior,
    },
    avisos: avisosDeCuenta({
      cuenta: e.base.cuenta,
      pagos,
      aviones: e.base.aviones,
      socioId: e.base.socio.id,
      utilidades: e.utilidades,
    }),
  };
}

// ===================================================================
// Pre-cierre
// ===================================================================

export interface SocioPrecierre {
  /** `es_empresa` ADITIVO: la propia empresa como socio (el panel la marca). */
  socio: { id: string; nombre: string; es_empresa: boolean };
  /**
   * Por entregar: con las utilidades HASTA el mes del cierre. Adelantados:
   * el saldo con el que se decide un adelanto (ver `resumenPrecierreCuentas`).
   */
  por_entregar_mxn: number;
}

export interface SocioAdelantadoPrecierre extends SocioPrecierre {
  /** Lo adelantado (positivo), sin el mes en curso. */
  adelantado_mxn: number;
}

export interface ResumenPrecierreCuentas {
  por_entregar: {
    count: number;
    monto_mxn: number;
    socios: SocioPrecierre[];
    detalle: string;
  };
  adelantados: {
    count: number;
    monto_mxn: number;
    socios: SocioAdelantadoPrecierre[];
    detalle: string;
  };
}

/**
 * Mes HASTA el que suman utilidades en el aviso «adelantados» del
 * pre-cierre: el MISMO criterio del candado (meses cerrados, sin el mes en
 * curso) salvo que el cierre revisado SEA el mes en curso — entonces el
 * del «por entregar» (ese mes inclusive), para que un mismo socio no salga
 * a la vez «por entregar» y «adelantado» en el mismo pre-cierre.
 */
export function mesHastaAdelantosPrecierre(
  mesRevision: string,
  mesActual: string,
): string {
  return mesRevision >= mesActual ? mesActual : mesAnterior(mesActual);
}

/**
 * Pre-cierre de un MES calendario (NO bloqueante):
 *  - POR ENTREGAR = saldo con las utilidades HASTA ese mes (inclusive) y
 *    TODAS las entregas registradas hoy — así una entrega de octubre por la
 *    utilidad de septiembre sí limpia el cierre de septiembre. Solo socios
 *    cuya cuenta ya había arrancado en ese mes.
 *  - ADELANTADOS = saldo con las utilidades de los meses CERRADOS (sin el
 *    mes en curso: `mesHastaAdelantosPrecierre`) y todas las entregas <
 *    −$1.00 — el MISMO número contra el que el candado pide confirmar un
 *    adelanto. Así, entregar exactamente lo que este pre-cierre dice que se
 *    debe deja al socio al corriente, no «adelantado», aunque el mes en
 *    curso vaya en negativo.
 */
export function resumenPrecierreCuentas(e: {
  mes: string;
  /** Socios con la cuenta arrancada a ese mes. */
  filas: ReadonlyArray<{
    socio: { id: string; nombre: string; es_empresa?: boolean };
    por_entregar_hasta_mes_mxn: number;
    /** Saldo con las utilidades hasta `mesHastaAdelantosPrecierre`. */
    por_entregar_cerrado_mxn: number;
  }>;
  /** Socios cuya cuenta arranca DESPUÉS del mes (no se revisan). */
  sin_cuenta_en_mes: number;
}): ResumenPrecierreCuentas {
  const et = etiquetaMes(e.mes);
  const orden = (a: SocioPrecierre, b: SocioPrecierre) =>
    a.socio.nombre.localeCompare(b.socio.nombre, 'es') ||
    a.socio.id.localeCompare(b.socio.id);
  const pendientes: SocioPrecierre[] = e.filas
    .filter(
      (f) => estadoCuenta(f.por_entregar_hasta_mes_mxn) === 'POR_ENTREGAR',
    )
    .map((f) => ({
      socio: {
        id: f.socio.id,
        nombre: f.socio.nombre,
        es_empresa: f.socio.es_empresa === true,
      },
      por_entregar_mxn: f.por_entregar_hasta_mes_mxn,
    }))
    .sort((a, b) => b.por_entregar_mxn - a.por_entregar_mxn || orden(a, b));
  const adelantados: SocioAdelantadoPrecierre[] = e.filas
    .filter((f) => estadoCuenta(f.por_entregar_cerrado_mxn) === 'ADELANTADO')
    .map((f) => ({
      socio: {
        id: f.socio.id,
        nombre: f.socio.nombre,
        es_empresa: f.socio.es_empresa === true,
      },
      por_entregar_mxn: f.por_entregar_cerrado_mxn,
      adelantado_mxn: -f.por_entregar_cerrado_mxn,
    }))
    .sort((a, b) => b.adelantado_mxn - a.adelantado_mxn || orden(a, b));
  const totalPend =
    pendientes.reduce((acc, p) => acc + centavos(p.por_entregar_mxn), 0) / 100;
  const totalAdel =
    adelantados.reduce((acc, p) => acc + centavos(p.adelantado_mxn), 0) / 100;
  const lista = (
    xs: ReadonlyArray<{ socio: { nombre: string } }>,
    monto: (i: number) => number,
  ) => {
    const primeros = xs
      .slice(0, 5)
      .map((x, i) => `${x.socio.nombre} ${mxn(monto(i))}`)
      .join(', ');
    return `${primeros}${xs.length > 5 ? ` y ${xs.length - 5} más` : ''}`;
  };
  let detallePend: string;
  if (pendientes.length > 0) {
    detallePend = `${pendientes.length} socio(s) con utilidad por entregar hasta ${et} por ${mxn(totalPend)}: ${lista(pendientes, (i) => pendientes[i].por_entregar_mxn)}. Regístralo en Tesorería → «Pagos a socios».`;
  } else if (e.filas.length === 0 && e.sin_cuenta_en_mes > 0) {
    detallePend = `Las cuentas de los socios arrancan después de ${et}: no hay nada que revisar en este mes.`;
  } else {
    detallePend = `Todos los socios están al corriente con la utilidad generada hasta ${et}.`;
  }
  const detalleAdel =
    adelantados.length > 0
      ? `${adelantados.length} socio(s) recibieron más de lo generado en los meses ya cerrados (adelanto) por ${mxn(totalAdel)}: ${lista(adelantados, (i) => adelantados[i].adelantado_mxn)}. El saldo queda a favor de VuelaTour y se descuenta de las utilidades siguientes; revisa que sea correcto en Tesorería → «Pagos a socios».`
      : 'Ningún socio tiene entregas por encima de lo generado.';
  return {
    por_entregar: {
      count: pendientes.length,
      monto_mxn: totalPend,
      socios: pendientes.slice(0, PRECIERRE_SOCIOS_MAX),
      detalle: detallePend,
    },
    adelantados: {
      count: adelantados.length,
      monto_mxn: totalAdel,
      socios: adelantados.slice(0, PRECIERRE_SOCIOS_MAX),
      detalle: detalleAdel,
    },
  };
}
