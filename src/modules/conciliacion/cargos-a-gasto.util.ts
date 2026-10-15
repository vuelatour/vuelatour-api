/**
 * «VARIOS CARGOS → UN GASTO» (14-oct-2026, API 0.0.77, invariante 76).
 * Pedido del usuario con la captura de /admin/conciliacion: «necesitamos
 * poder seleccionar varias filas de conciliaciones pendientes para todo eso
 * ponerlas a un solo gasto, si no existe el gasto que permita crearlo por la
 * cantidad de la suma».
 *
 * Fuente única PURA (con spec) de la regla y de los textos. El candado real
 * es la RPC atómica `conciliacion_ligar_cargos_a_gasto` (migración
 * 20261014000002: 2..50 cargos pendientes y libres bajo FOR UPDATE, una
 * moneda de cuenta = la del gasto, gasto bancario, Σ ligado + Σ nuevos ≤
 * monto + 1.00, cada cargo ENTERO, re-envío idéntico = idempotente). Aquí
 * viven su espejo (`validarCargosParaGasto`, para la prevalidación del alta
 * por la suma) y lo que el panel pinta en «Vincular a un gasto»
 * (`resultadoCargosSobreGasto`, `ordenarCandidatosPorSuma`). Jamás se
 * encadena la RPC G de un cargo para N cargos.
 */
import { etiquetaMedioPago } from '../../common/medio-pago.util';
import {
  mensajeGastoBodega,
  montoNota,
} from '../../common/vinculo-no-bancario.util';
import { TOLERANCIA_CONCILIACION } from './conciliacion-parcial.util';
import { MEDIO_BODEGA, MEDIOS_BANCARIOS } from './gastos-candidatos.util';
import {
  leerErrorRpc,
  type EstadoParaOmitir,
  type ErrorRpcLike,
} from './omision.util';

/** Tope de cargos por gasto (espejo de la RPC). Con UNO: «Vincular gasto». */
export const CARGOS_A_GASTO_MIN = 2;
export const CARGOS_A_GASTO_MAX = 50;

/** Centavos (enteros: nada de 0.30000000000000004). */
function cent(n: unknown): number {
  return Math.round((Number(n) || 0) * 100);
}

export type ResultadoSuma = 'CUBRE' | 'PARCIAL' | 'EXCEDE';

export interface ResultadoCargosSobreGasto {
  resultado: ResultadoSuma;
  /** Lo que le falta al gasto ANTES de estos cargos. */
  faltante: number;
  /** Lo que le faltaría DESPUÉS (0 si cubre). */
  faltante_tras: number;
  /** Lo que se pasarían (0 si no exceden). */
  excedente: number;
}

/**
 * Qué pasaría con el gasto si se le ligan estos cargos, en centavos y con
 * `TOLERANCIA_CONCILIACION` (1.00): faltante = max(0, monto − vinculado);
 * |Σ − faltante| ≤ 1.00 ⇒ CUBRE; Σ < faltante − 1.00 ⇒ PARCIAL; si no ⇒
 * EXCEDE (la RPC lo rechaza). Espejo del trigger A y de
 * `regla_gasto_cubierto`.
 */
export function resultadoCargosSobreGasto(args: {
  montoGasto: number;
  vinculado: number;
  sumaCargos: number;
}): ResultadoCargosSobreGasto {
  const monto = Math.abs(cent(args.montoGasto));
  const vinc = Math.max(0, cent(args.vinculado));
  const suma = Math.max(0, cent(args.sumaCargos));
  const tol = cent(TOLERANCIA_CONCILIACION);
  const faltante = Math.max(0, monto - vinc);
  if (Math.abs(suma - faltante) <= tol) {
    return {
      resultado: 'CUBRE',
      faltante: faltante / 100,
      faltante_tras: Math.max(0, faltante - suma) / 100,
      excedente: 0,
    };
  }
  if (suma < faltante - tol) {
    return {
      resultado: 'PARCIAL',
      faltante: faltante / 100,
      faltante_tras: (faltante - suma) / 100,
      excedente: 0,
    };
  }
  return {
    resultado: 'EXCEDE',
    faltante: faltante / 100,
    faltante_tras: 0,
    excedente: (suma - faltante) / 100,
  };
}

/** Lo mínimo que mira el orden de los candidatos por suma. */
export interface CandidatoPorSuma {
  id: string;
  monto: number;
  faltante?: number | null;
  fecha?: string | null;
  resultado: ResultadoSuma;
}

const RANGO_RESULTADO: Record<ResultadoSuma, number> = {
  CUBRE: 0,
  PARCIAL: 1,
  EXCEDE: 2,
};

/** Días entre dos fechas YYYY-MM-DD (mediodía UTC: sin corrimiento de zona). */
function diasEntre(a: string, b: string): number {
  const ta = Date.parse(`${a.slice(0, 10)}T12:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb))
    return Number.POSITIVE_INFINITY;
  return Math.round((tb - ta) / 86_400_000);
}

/** Distancia (días) de una fecha al rango [min, max] de los cargos. */
function distanciaAlRango(
  fecha: string | null | undefined,
  min: string,
  max: string,
): number {
  if (!fecha) return Number.POSITIVE_INFINITY;
  const f = fecha.slice(0, 10);
  if (f < min) return Math.abs(diasEntre(f, min));
  if (f > max) return Math.abs(diasEntre(max, f));
  return 0;
}

/**
 * Orden de los candidatos de «Vincular a un gasto»: CUBRE → PARCIAL →
 * EXCEDE; luego |faltante − Σ|; luego la distancia de la fecha al rango de
 * los cargos; luego fecha desc; empate por id. No muta la entrada.
 */
export function ordenarCandidatosPorSuma<T extends CandidatoPorSuma>(
  cands: readonly T[],
  ctx: { suma: number; fechaMin: string; fechaMax: string },
): T[] {
  const suma = cent(ctx.suma);
  return [...cands].sort((a, b) => {
    const r = RANGO_RESULTADO[a.resultado] - RANGO_RESULTADO[b.resultado];
    if (r !== 0) return r;
    const da = Math.abs(cent(a.faltante ?? a.monto) - suma);
    const db = Math.abs(cent(b.faltante ?? b.monto) - suma);
    if (da !== db) return da - db;
    const fa = distanciaAlRango(a.fecha, ctx.fechaMin, ctx.fechaMax);
    const fb = distanciaAlRango(b.fecha, ctx.fechaMin, ctx.fechaMax);
    if (fa !== fb) return fa - fb;
    const ea = a.fecha ?? '';
    const eb = b.fecha ?? '';
    if (ea !== eb) return ea < eb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** La misma terminación (no nula) en TODOS los cargos ⇒ esa; si no, null. */
export function terminacionComun(
  terminaciones: ReadonlyArray<string | null | undefined>,
): string | null {
  if (terminaciones.length === 0) return null;
  const primera = terminaciones[0];
  if (typeof primera !== 'string' || !primera) return null;
  return terminaciones.every((t) => t === primera) ? primera : null;
}

/** Cargo tal como lo valida el espejo de la RPC. */
export interface CargoParaGasto {
  id: string;
  tipo: string | null;
  monto: number;
  /** Moneda de la CUENTA del cargo (null = no se pudo leer). */
  moneda: string | null;
  estado: EstadoParaOmitir;
  fecha?: string | null;
  descripcion?: string | null;
}

/** Gasto contra el que se validan (el nuevo del alta por la suma o uno vivo). */
export interface GastoParaCargos {
  moneda: string | null;
  monto: number;
  medio_pago: string | null;
  /** Σ partes no cruzadas de OTROS cargos (0 para un gasto nuevo). */
  vinculado?: number;
  /** Partes cruzadas (1 ↔ 1 de otra moneda) que ya tiene. */
  cruzadas?: number;
  fecha_gasto?: string | null;
}

export type CodigoCargosGasto =
  | 'LOTE_INVALIDO'
  | 'SOLO_CARGOS'
  | 'MOVIMIENTO_NO_PENDIENTE'
  | 'CARGOS_MONEDA_DISTINTA'
  | 'LOTE_MONEDA_DISTINTA'
  | 'GASTO_BODEGA'
  | 'GASTO_NO_BANCARIO'
  | 'GASTO_YA_CUBIERTO'
  | 'CARGOS_EXCEDEN_GASTO';

export type ValidacionCargosGasto =
  | { ok: true; moneda: string; suma: number }
  | { ok: false; codigo: CodigoCargosGasto; details: Record<string, unknown> };

/**
 * Espejo PURO de la RPC para la prevalidación del alta por la suma: mismos
 * códigos y MISMO orden (lista → solo cargos → pendientes → una moneda →
 * moneda del gasto → medio bancario → cruzada previa → Σ ≤ monto + 1.00).
 * La cuenta sin moneda se resuelve ANTES (503 CUENTA_SIN_MONEDA del
 * llamador): aquí un null cuenta como moneda distinta.
 */
export function validarCargosParaGasto(
  cargos: readonly CargoParaGasto[],
  gasto: GastoParaCargos,
): ValidacionCargosGasto {
  const n = cargos.length;
  if (n < CARGOS_A_GASTO_MIN || n > CARGOS_A_GASTO_MAX) {
    return { ok: false, codigo: 'LOTE_INVALIDO', details: { n } };
  }
  if (new Set(cargos.map((c) => c.id)).size !== n) {
    return {
      ok: false,
      codigo: 'LOTE_INVALIDO',
      details: { n, repetidos: true },
    };
  }
  const abonos = cargos.filter((c) => c.tipo !== 'CARGO');
  if (abonos.length > 0) {
    return {
      ok: false,
      codigo: 'SOLO_CARGOS',
      details: {
        abonos: abonos.map((c) => ({
          id: c.id,
          fecha: c.fecha ?? null,
          monto: c.monto,
          descripcion: c.descripcion ?? null,
        })),
      },
    };
  }
  const ocupados = cargos.filter((c) => c.estado !== 'PENDIENTE');
  if (ocupados.length > 0) {
    return {
      ok: false,
      codigo: 'MOVIMIENTO_NO_PENDIENTE',
      details: {
        movimientos: ocupados.map((c) => ({
          id: c.id,
          fecha: c.fecha ?? null,
          tipo: c.tipo,
          monto: c.monto,
          moneda: c.moneda,
          descripcion: c.descripcion ?? null,
          estado: c.estado,
        })),
      },
    };
  }
  const monedas = [...new Set(cargos.map((c) => c.moneda ?? '?'))].sort();
  if (monedas.length !== 1 || monedas[0] === '?') {
    return {
      ok: false,
      codigo: 'CARGOS_MONEDA_DISTINTA',
      details: { monedas },
    };
  }
  const moneda = monedas[0];
  if (gasto.moneda !== moneda) {
    return {
      ok: false,
      codigo: 'LOTE_MONEDA_DISTINTA',
      details: { moneda_gasto: gasto.moneda, moneda_cuenta: moneda },
    };
  }
  const medio = gasto.medio_pago ?? '';
  if (medio === MEDIO_BODEGA) {
    return {
      ok: false,
      codigo: 'GASTO_BODEGA',
      details: { medio_pago: medio },
    };
  }
  if (!MEDIOS_BANCARIOS.includes(medio)) {
    return {
      ok: false,
      codigo: 'GASTO_NO_BANCARIO',
      details: { medio_pago: medio || null },
    };
  }
  if ((gasto.cruzadas ?? 0) > 0) {
    return {
      ok: false,
      codigo: 'GASTO_YA_CUBIERTO',
      details: { motivo: 'MONEDA_DISTINTA', moneda, monto_gasto: gasto.monto },
    };
  }
  const suma = cargos.reduce((a, c) => a + Math.abs(cent(c.monto)), 0);
  const vinculado = Math.max(0, cent(gasto.vinculado ?? 0));
  const montoGasto = Math.abs(cent(gasto.monto));
  if (vinculado + suma > montoGasto + cent(TOLERANCIA_CONCILIACION)) {
    return {
      ok: false,
      codigo: 'CARGOS_EXCEDEN_GASTO',
      details: {
        moneda,
        monto_gasto: montoGasto / 100,
        suma_ligada: vinculado / 100,
        faltante: Math.max(0, montoGasto - vinculado) / 100,
        suma_cargos: suma / 100,
        excedente: (vinculado + suma - montoGasto) / 100,
        tolerancia: TOLERANCIA_CONCILIACION,
      },
    };
  }
  return { ok: true, moneda, suma: suma / 100 };
}

// ============================ TEXTOS (es-MX) ============================

/** 400 LOTE_INVALIDO. */
export const MENSAJE_LOTE_CARGOS_INVALIDO =
  'Elige de 2 a 50 cargos sin repetir (con uno, usa «Vincular gasto» del menú ⋯).';

/** 400 SOLO_CARGOS. */
export function mensajeSoloCargos(n: number): string {
  return n === 1
    ? 'Solo los cargos pagan un gasto: quita el abono de la selección.'
    : `Solo los cargos pagan un gasto: quita los ${n} abonos de la selección.`;
}

/** 409 CARGOS_MONEDA_DISTINTA. */
export function mensajeCargosMonedaDistinta(
  monedas: ReadonlyArray<string | null | undefined>,
): string {
  const lista = [...new Set(monedas.map((m) => m || '?'))]
    .sort((a, b) => (a === 'MXN' ? -1 : b === 'MXN' ? 1 : a < b ? -1 : 1))
    .join(' y ');
  return `Los cargos son de cuentas en ${lista}: un gasto se paga en una sola moneda.`;
}

/** 409 LOTE_MONEDA_DISTINTA (el gasto en otra moneda que los cargos). */
export function mensajeLoteMonedaDistintaGasto(args: {
  monedaGasto: string | null | undefined;
  monedaCuenta: string | null | undefined;
}): string {
  const g = args.monedaGasto || '?';
  const c = args.monedaCuenta || '?';
  if (g === 'USD' && c === 'MXN') {
    return 'El gasto está en USD y los cargos en MXN: una compra en dólares pagada en pesos se vincula con UN solo cargo (menú ⋯ del cargo → Vincular gasto).';
  }
  return `El gasto está en ${g} y los cargos en ${c}: un gasto se vincula con cargos de su misma moneda.`;
}

/** 409 GASTO_NO_BANCARIO (efectivo, Personal Pablo/Ale…). */
export function mensajeGastoNoBancario(
  medio: string | null | undefined,
): string {
  const etiqueta = etiquetaMedioPago(medio) ?? 'un medio que no es del banco';
  return `El gasto se pagó con ${etiqueta}, que no pasa por el banco: se vincula cargo por cargo con su justificación (menú ⋯ → Vincular gasto → «Incluir gastos en efectivo y otros medios»).`;
}

/** 409 GASTO_BODEGA (salida de inventario): el texto de siempre. */
export function mensajeGastoBodegaCargos(
  fechaGasto: string | null | undefined,
): string {
  return mensajeGastoBodega([{ fecha_gasto: fechaGasto ?? null }]);
}

/** 409 GASTO_YA_CUBIERTO (1 ↔ 1 con un cargo de otra moneda). */
export const MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA =
  'Ese gasto ya está conciliado 1 a 1 con un cargo en otra moneda: no admite más cargos.';

/** 409 GASTO_YA_CUBIERTO por una carrera (otros cargos lo cubrieron mientras tanto). */
export const MENSAJE_GASTO_YA_CUBIERTO_CARRERA =
  'Ese gasto quedó cubierto por otros cargos mientras tanto: recarga la página y revisa la selección.';

/**
 * 409 CARGOS_EXCEDEN_GASTO: «Los 3 cargos suman $9,700.00 y al gasto le
 * faltan $9,591.49 (vale $9,591.49): se pasarían por $108.51 (tolerancia
 * $1.00). Revisa la selección o el monto del gasto.»; con pagos previos
 * «… le faltan $200.00 (ya tiene $100.00 de $300.00) …».
 */
export function mensajeCargosExcedenGasto(d: {
  n?: number | null;
  moneda?: string | null;
  monto_gasto: number;
  suma_ligada: number;
  suma_cargos: number;
  tolerancia?: number | null;
}): string {
  const moneda = d.moneda ?? null;
  const monto = cent(d.monto_gasto);
  const ligado = Math.max(0, cent(d.suma_ligada));
  const suma = cent(d.suma_cargos);
  const faltante = Math.max(0, monto - ligado);
  const exceso = Math.max(0, suma - faltante);
  const tol = d.tolerancia ?? TOLERANCIA_CONCILIACION;
  const n =
    d.n != null && d.n >= 2 ? `Los ${Math.trunc(d.n)} cargos` : 'Los cargos';
  const contexto =
    ligado > 0
      ? `ya tiene ${montoNota(ligado / 100, moneda)} de ${montoNota(monto / 100, moneda)}`
      : `vale ${montoNota(monto / 100, moneda)}`;
  return `${n} suman ${montoNota(suma / 100, moneda)} y al gasto le faltan ${montoNota(faltante / 100, moneda)} (${contexto}): se pasarían por ${montoNota(exceso / 100, moneda)} (tolerancia ${montoNota(tol, moneda)}). Revisa la selección o el monto del gasto.`;
}

/** 404 GASTO_NO_EXISTE. */
export const MENSAJE_GASTO_NO_EXISTE =
  'Ese gasto ya no existe: recarga la página.';

/** Prefijo de los 4xx del alta por la suma («No se registró el gasto: …»). */
export const PREFIJO_NO_SE_REGISTRO = 'No se registró el gasto: ';

/**
 * Antepone «No se registró el gasto: » y pasa la primera letra del mensaje
 * a minúscula (idempotente: un mensaje que ya trae el prefijo no se toca).
 */
export function conPrefijoNoSeRegistro(msg: string): string {
  const t = String(msg ?? '').trim();
  if (t.startsWith(PREFIJO_NO_SE_REGISTRO)) return t;
  if (!t) return PREFIJO_NO_SE_REGISTRO.trim();
  return `${PREFIJO_NO_SE_REGISTRO}${t.charAt(0).toLocaleLowerCase('es-MX')}${t.slice(1)}`;
}

/** 400 CLIENT_REQUEST_ID_REQUERIDO (alta por la suma sin llave). */
export const MENSAJE_CLIENT_REQUEST_ID_REQUERIDO =
  'Falta la llave de la captura: recarga la página y vuelve a intentarlo.';

/** 409 CLIENT_REQUEST_ID_EN_USO (la llave ya creó un gasto con otros datos). */
export const MENSAJE_CLIENT_REQUEST_ID_EN_USO =
  'Esa captura ya registró un gasto con otros datos: búscalo en Gastos antes de volver a intentarlo.';

/** 400 INVENTARIO_NO_DESDE_CARGOS. */
export const MENSAJE_INVENTARIO_NO_DESDE_CARGOS =
  'Una refacción que entra a Inventario/Tienda no se registra desde varios cargos: regístrala en Gastos y vincula los cargos después.';

/** 400 CONCILIAR_SOLO_AL_CREAR (PATCH con la llave). */
export const MENSAJE_CONCILIAR_SOLO_AL_CREAR =
  'Los cargos del banco se vinculan al crear el gasto; para un gasto que ya existe usa «Vincular a un gasto» en Conciliación.';

/** 403 CONCILIAR_SOLO_ADMIN_FACTURACION. */
export const MENSAJE_CONCILIAR_SOLO_ADMIN_FACTURACION =
  'Solo Administración y Facturación concilian con el banco.';

/**
 * 500 GASTO_NO_REGISTRADO: la liga falló con un error que no es de las
 * reglas (la base no respondió como se esperaba) y el gasto YA se retiró.
 */
export const MENSAJE_GASTO_NO_REGISTRADO =
  'No se registró el gasto: la liga con los cargos del banco falló y el gasto se retiró. Vuelve a intentarlo; si se repite, avisa a sistemas.';

/** 500 GASTO_SIN_VINCULAR (la RPC falló y el retiro también). */
export const MENSAJE_GASTO_SIN_VINCULAR =
  'El gasto se registró pero NO quedó vinculado a los cargos: vuelve a pulsar «Guardar» para reintentar la liga (no se duplica) o cancela y vincúlalo con «Vincular a un gasto».';

/** Códigos 23514 de la RPC (y de los triggers A/K que dispara). */
export const CODIGOS_ERROR_CARGOS_GASTO = [
  'LOTE_INVALIDO',
  'MOVIMIENTO_NO_EXISTE',
  'SOLO_CARGOS',
  'MOVIMIENTO_NO_PENDIENTE',
  'CARGOS_MONEDA_DISTINTA',
  'GASTO_NO_EXISTE',
  'LOTE_MONEDA_DISTINTA',
  'GASTO_NO_BANCARIO',
  'GASTO_YA_CUBIERTO',
  'CARGOS_EXCEDEN_GASTO',
  'CARGO_EXCEDIDO',
  'CARGO_NO_CUADRA',
  'PARTES_INCOHERENTES',
  'CARGO_LIGADO',
  'REVERSO_INVALIDO',
  'MOVIMIENTO_OMITIDO',
  'MOVIMIENTO_YA_LIGADO',
] as const;
export type CodigoErrorCargosGasto =
  (typeof CODIGOS_ERROR_CARGOS_GASTO)[number];

/** Error de la RPC `conciliacion_ligar_cargos_a_gasto`. */
export function leerErrorCargosGasto(err: ErrorRpcLike | null | undefined) {
  return leerErrorRpc(err, CODIGOS_ERROR_CARGOS_GASTO);
}
