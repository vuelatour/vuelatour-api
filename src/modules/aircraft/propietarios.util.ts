/**
 * PROPIETARIOS DEL AVIÓN (`aeronave_socio`) — reglas PURAS (19-oct-2026,
 * API 0.0.97, invariante 95 del CLAUDE.md).
 *
 * Pedido del cliente (captura de «Propietarios actuales» de XA-VGV con dos
 * dueños al 100 %): «no me deja borrar al socio anterior y no es fácil editar
 * nombres y porcentajes de los socios». Aquí viven las fechas de pared, los
 * textos es-MX y los códigos; el servicio solo lee, valida y escribe.
 *
 * Fechas: `vigente_desde` / `vigente_hasta` son DÍAS de pared (`date`), los
 * dos INCLUSIVOS. Un régimen que «termina el 17/08» sigue contando ese día.
 */

/** Día de pared `AAAA-MM-DD`. */
export const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

export function esDia(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !RE_DIA.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

/** Suma `n` días a un día de pared (aritmética UTC: sin zona ni DST). */
export function diaMas(dia: string, n: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diaAnterior(dia: string): string {
  return diaMas(dia, -1);
}

/** Día de pared de un `Date` que class-transformer armó desde `AAAA-MM-DD`. */
export function diaDeDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** «17/08/2026» (el formato de los 400 de gastos). */
export function fmtDiaMx(dia: string): string {
  const [y, m, d] = dia.split('-');
  return `${d}/${m}/${y}`;
}

export const CODIGO_PROPIETARIO = {
  NO_EXISTE: 'PROPIETARIO_NO_EXISTE',
  FECHA_INVALIDA: 'PROPIETARIO_FECHA_INVALIDA',
  VIGENCIA_INVALIDA: 'PROPIETARIO_VIGENCIA_INVALIDA',
  SUSTITUYE_INVALIDO: 'PROPIETARIO_SUSTITUYE_INVALIDO',
  USUARIO_NO_EXISTE: 'PROPIETARIO_USUARIO_NO_EXISTE',
  /** Los vigentes de un mismo día pasarían del 100 % (pedido 19-oct-2026). */
  SUMA_EXCEDE: 'PROPIETARIO_SUMA_EXCEDE',
} as const;

/** Tolerancia de la suma (los porcentajes llevan 3 decimales). */
export const TOLERANCIA_SUMA_PCT = 0.0005;

export interface VigenciaPct {
  id: string;
  nombre: string;
  porcentaje: number | string;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export interface ExcesoPorcentaje {
  /** Primer día en que los vigentes pasan del 100 %. */
  dia: string;
  suma: number;
  propietarios: { id: string; nombre: string; porcentaje: number }[];
}

/** Suma a 3 decimales (sin errores binarios acumulados). */
function sumaPct(valores: number[]): number {
  return Math.round(valores.reduce((s, v) => s + v * 1000, 0)) / 1000;
}

/**
 * «Que no se pueda poner más del 100 % del avión» (19-oct-2026): los
 * propietarios vigentes en UN MISMO DÍA nunca suman más de 100. Barrido por
 * los días en que cambia el conjunto (cada primer día y el día siguiente a
 * cada último día): el máximo de la suma vive en uno de ellos. Devuelve el
 * primer día que se pasa (con quiénes) o null. Sumar MENOS de 100 se
 * permite (un socio que sale y nadie lo sustituye todavía).
 */
export function excesoPorcentaje(
  filas: readonly VigenciaPct[],
): ExcesoPorcentaje | null {
  const cortes = new Set<string>();
  for (const f of filas) {
    cortes.add(f.vigente_desde);
    if (f.vigente_hasta !== null) cortes.add(diaMas(f.vigente_hasta, 1));
  }
  for (const dia of [...cortes].sort()) {
    const activos = filas.filter(
      (f) =>
        f.vigente_desde <= dia &&
        (f.vigente_hasta === null || f.vigente_hasta >= dia),
    );
    const suma = sumaPct(activos.map((f) => Number(f.porcentaje)));
    if (suma > 100 + TOLERANCIA_SUMA_PCT) {
      return {
        dia,
        suma,
        propietarios: activos.map((f) => ({
          id: f.id,
          nombre: f.nombre,
          porcentaje: Number(f.porcentaje),
        })),
      };
    }
  }
  return null;
}

/** «70.5 %» / «100 %» sin ceros de cola. */
export function fmtPct(n: number): string {
  return `${Number(n.toFixed(3))} %`;
}

export function mensajeSumaExcede(e: ExcesoPorcentaje): string {
  const quienes = e.propietarios
    .map((p) => `${p.nombre} ${fmtPct(p.porcentaje)}`)
    .join(' + ');
  return `Los propietarios sumarían ${fmtPct(e.suma)} el ${fmtDiaMx(e.dia)} (${quienes}): no pueden pasar de 100 %. Pon el último día del que sale o baja los porcentajes.`;
}

export const MENSAJE_PROPIETARIO_NO_EXISTE =
  'Ese propietario ya no existe: recarga la página.';
export const MENSAJE_FECHA_INVALIDA =
  'La fecha debe ser un día válido con el formato AAAA-MM-DD.';
export const MENSAJE_USUARIO_NO_EXISTE =
  'Ese usuario ya no existe: elige otro socio.';
export const MENSAJE_SUSTITUYE_INVALIDO =
  'Solo se puede sustituir a propietarios de este mismo avión.';

/**
 * El último día no puede ser anterior al primero: dice quién, desde cuándo
 * y la salida («bórralo del historial» = `permanente=true`, para la fila
 * que se agregó por error).
 */
export function mensajeHastaAntesDelInicio(
  nombre: string,
  desde: string,
  hasta: string,
): string {
  return `${nombre} empezó el ${fmtDiaMx(desde)}: no puede terminar el ${fmtDiaMx(hasta)}. Si se agregó por error, bórralo del historial.`;
}

/**
 * Al agregar un propietario que SUSTITUYE a otro, el sustituido termina el
 * día anterior al inicio del nuevo; si empezó después de ese día no hay
 * régimen que cerrar.
 */
export function mensajeSustituyeAntesDelInicio(
  nombre: string,
  desdeSustituido: string,
  desdeNuevo: string,
): string {
  return `${nombre} empezó el ${fmtDiaMx(desdeSustituido)}: no puede terminar el ${fmtDiaMx(diaAnterior(desdeNuevo))} (el día anterior al nuevo régimen). Si se agregó por error, bórralo del historial; si no, pon una fecha de inicio posterior.`;
}

/**
 * Vigencia de UNA fila (`vigente_hasta` null = abierta). Devuelve el texto del
 * 400 o null si es válida. Espejo del CHECK `aeronave_socio_check`.
 */
export function errorVigencia(
  nombre: string,
  desde: string,
  hasta: string | null,
): string | null {
  if (hasta === null || hasta >= desde) return null;
  return mensajeHastaAntesDelInicio(nombre, desde, hasta);
}

export interface SustituidoLike {
  id: string;
  aeronave_id: string;
  vigente_desde: string;
  vigente_hasta: string | null;
  nombre: string;
}

export type PlanSustitucion =
  | { ok: true; cerrar: { id: string; hasta: string }[] }
  | { ok: false; code: string; message: string };

/**
 * Qué filas cierra `sustituye_a` al agregar un propietario que empieza
 * `desdeNuevo`: cada sustituido termina el día anterior. Se decide ANTES de
 * escribir nada: cualquier rechazo deja la base como estaba.
 *  - ids que no son del avión (o que no existen) ⇒ SUSTITUYE_INVALIDO;
 *  - un sustituido que empezó DESPUÉS de ese último día ⇒ VIGENCIA_INVALIDA
 *    (la salida es borrarlo si se agregó por error);
 *  - uno que YA termina ese día o antes no se toca (no se reabre ni se
 *    alarga).
 */
export function planSustitucion(
  aeronaveId: string,
  desdeNuevo: string,
  pedidos: string[],
  filas: SustituidoLike[],
): PlanSustitucion {
  const ids = [...new Set(pedidos)];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const ultimoDia = diaAnterior(desdeNuevo);
  const cerrar: { id: string; hasta: string }[] = [];
  for (const id of ids) {
    const f = porId.get(id);
    if (!f || f.aeronave_id !== aeronaveId) {
      return {
        ok: false,
        code: CODIGO_PROPIETARIO.SUSTITUYE_INVALIDO,
        message: MENSAJE_SUSTITUYE_INVALIDO,
      };
    }
    if (f.vigente_desde > ultimoDia) {
      return {
        ok: false,
        code: CODIGO_PROPIETARIO.VIGENCIA_INVALIDA,
        message: mensajeSustituyeAntesDelInicio(
          f.nombre,
          f.vigente_desde,
          desdeNuevo,
        ),
      };
    }
    if (f.vigente_hasta !== null && f.vigente_hasta <= ultimoDia) continue;
    cerrar.push({ id, hasta: ultimoDia });
  }
  return { ok: true, cerrar };
}
