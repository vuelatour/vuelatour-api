/**
 * DECISIÓN ÚNICA de los ABONOS del banco (24-sep-2026, conciliación de
 * ingresos). PURO: sin BD, sin reloj, sin red — el servicio trae los datos y
 * aplica la decisión, y este archivo se prueba con descripciones REALES de
 * prod.
 *
 * Un abono (dinero que ENTRÓ) puede ser el cobro de un vuelo, el SOBRE de un
 * grupo o un INGRESO registrado (otro ingreso / anticipo). Antes el
 * auto-cruce solo miraba cobros y sobres y exigía candidato único; ahora los
 * tres universos compiten en UNA decisión y, si hay empate por monto, el
 * NOMBRE del ordenante que traen las transferencias SPEI («LETICIA LEON
 * ALVARADO : PAGO») puede desempatar — nunca liga «por parecerse»: exige
 * monto exacto y UN solo candidato cuyo nombre empate.
 *
 * Regla de MONTO = la de siempre (no se mueve ningún cruce existente): con
 * comisión > 0 se compara el NETO (bruto − comisión), sin comisión el
 * BRUTO, igualdad a centavos (r2). En una cuenta PASARELA, además, el bruto
 * del candidato contra el `monto_bruto` del abono.
 */
import { normalizarPlano, tokensTexto } from './auto-cruce.util';

export type TipoCandidatoAbono = 'COBRO_VUELO' | 'SOBRE_GRUPO' | 'INGRESO';

export interface CandidatoAbonoCruce {
  tipo: TipoCandidatoAbono;
  id: string;
  /** BRUTO (moneda nativa). */
  monto: number;
  comision: number | null;
  /** Día (YYYY-MM-DD) o instante ISO del cobro/ingreso. */
  fecha: string;
  /** Cliente del vuelo/grupo, o cliente/pagador del ingreso. */
  cliente: string | null;
  /** Solo INGRESO: la cuenta donde se registró (null en cobros/sobres). */
  cuenta_bancaria_id: string | null;
}

export interface AbonoCruce {
  /** Lo depositado (neto en pasarela). */
  monto: number;
  monto_bruto: number | null;
  descripcion: string | null;
  cuenta_bancaria_id: string;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * ¿El candidato cuadra con el abono? MISMA regla que el auto-cruce de
 * siempre (con comisión el NETO, sin comisión el BRUTO, igualdad r2) y, en
 * pasarela, también el bruto del candidato contra el `monto_bruto` del abono.
 */
export function cuadraMontoAbono(
  abono: AbonoCruce,
  c: CandidatoAbonoCruce,
  pasarela: boolean,
): boolean {
  const bruto = Number(c.monto) || 0;
  const comision = Number(c.comision) || 0;
  const monto = Number(abono.monto) || 0;
  const porNeto =
    comision > 0 ? r2(bruto - comision) === r2(monto) : r2(bruto) === r2(monto);
  if (porNeto) return true;
  if (pasarela && abono.monto_bruto != null) {
    return r2(bruto) === r2(Number(abono.monto_bruto) || 0);
  }
  return false;
}

/**
 * ¿El nombre (cliente/pagador) aparece en la descripción del banco? Las
 * transferencias SPEI traen el nombre del ordenante. Tokens con significado
 * (`tokensTexto`: ≥ 3 letras, sin acentos ni muletillas) del nombre: empata
 * si comparte ≥ min(2, n) tokens con la descripción; un nombre de UN solo
 * token solo empata si ese token tiene ≥ 5 letras (un «Luis» suelto no
 * identifica a nadie).
 */
export function empataNombre(
  descripcion: string | null | undefined,
  nombre: string | null | undefined,
): boolean {
  const deNombre = tokensTexto(nombre);
  if (deNombre.length === 0) return false;
  const deBanco = new Set(tokensTexto(descripcion));
  if (deBanco.size === 0) return false;
  const comunes = deNombre.filter((t) => deBanco.has(t));
  if (deNombre.length === 1) {
    return comunes.length === 1 && deNombre[0].length >= 5;
  }
  return comunes.length >= Math.min(2, deNombre.length);
}

export interface EleccionAbono {
  elegido: CandidatoAbonoCruce | null;
  criterio: 'MONTO_EXACTO' | 'DESCRIPCION' | null;
  motivo: 'SIN_CANDIDATOS' | 'AMBIGUO' | null;
  /** Candidatos que cuadran por monto (antes del desempate). */
  candidatos_n: number;
}

/**
 * LA decisión del auto-cruce de un abono (cobros, sobres e ingresos en UN
 * universo). Recibe candidatos LIBRES (no ligados a otro movimiento):
 *  1) filtra por monto (`cuadraMontoAbono`); un INGRESO además exige estar
 *     registrado en la MISMA cuenta del abono;
 *  2) 0 ⇒ SIN_CANDIDATOS; 1 ⇒ MONTO_EXACTO;
 *  3) ≥ 2 ⇒ los que empatan nombre con la descripción: exactamente 1 ⇒
 *     DESCRIPCION; si no, AMBIGUO (se queda pendiente, jamás a la brava).
 */
export function elegirCandidatoAbono(
  abono: AbonoCruce,
  candidatos: ReadonlyArray<CandidatoAbonoCruce>,
  pasarela: boolean,
): EleccionAbono {
  const cuadran = candidatos.filter(
    (c) =>
      cuadraMontoAbono(abono, c, pasarela) &&
      (c.tipo !== 'INGRESO' ||
        c.cuenta_bancaria_id === abono.cuenta_bancaria_id),
  );
  const n = cuadran.length;
  if (n === 0) {
    return {
      elegido: null,
      criterio: null,
      motivo: 'SIN_CANDIDATOS',
      candidatos_n: 0,
    };
  }
  if (n === 1) {
    return {
      elegido: cuadran[0],
      criterio: 'MONTO_EXACTO',
      motivo: null,
      candidatos_n: 1,
    };
  }
  const porNombre = cuadran.filter((c) =>
    empataNombre(abono.descripcion, c.cliente),
  );
  if (porNombre.length === 1) {
    return {
      elegido: porNombre[0],
      criterio: 'DESCRIPCION',
      motivo: null,
      candidatos_n: n,
    };
  }
  return { elegido: null, criterio: null, motivo: 'AMBIGUO', candidatos_n: n };
}

/** Clasificación canónica de los reversos (la siembra la migración). */
export const CLASIFICACION_REVERSO = 'Reverso de un cargo';

/**
 * ¿La descripción es un REVERSO (el banco devolvió un cargo)? No es ingreso:
 * se SUGIERE clasificar con «Reverso de un cargo» (la regla propone, no
 * clasifica sola). «REV ASUR MERIDA», «REV.ASUR MERIDA», «REV.DLO*DIDI
 * PAYIN», «REV ADO WEB», «Rev ASUR Cancun» ⇒ 'REV'; «REVOLVENTE…»,
 * «PREVIO» ⇒ null.
 */
export function patronReverso(
  descripcion: string | null | undefined,
): string | null {
  const t = normalizarPlano(descripcion);
  if (!t) return null;
  return /^REV(\s|$)/.test(t) ? 'REV' : null;
}

/**
 * Cliente sugerido para un abono: de los clientes ACTIVOS, el ÚNICO cuyo
 * nombre empata con la descripción del banco; 0 o ≥ 2 ⇒ null (nunca
 * adivina entre homónimos).
 */
export function clienteQueEmpata(
  descripcion: string | null | undefined,
  clientes: ReadonlyArray<{ id: string; nombre: string }>,
): { id: string; nombre: string } | null {
  const hits = clientes.filter((c) => empataNombre(descripcion, c.nombre));
  return hits.length === 1 ? { id: hits[0].id, nombre: hits[0].nombre } : null;
}

/**
 * Duplicado probable: OTRA línea del banco de la MISMA cuenta, tipo y fecha
 * con el MISMO monto (r2). Las referencias NO cuentan: los duplicados reales
 * de prod traen la referencia en otro formato («000125473315» vs
 * «00000000006247178602»). Devuelve la primera, prefiriendo la conciliada.
 */
export function posibleDuplicado<
  M extends {
    id: string;
    cuenta_bancaria_id: string;
    tipo: string;
    fecha: string;
    monto: number;
    conciliado: boolean;
  },
>(m: M, universo: ReadonlyArray<M>): M | null {
  const iguales = universo.filter(
    (o) =>
      o.id !== m.id &&
      o.cuenta_bancaria_id === m.cuenta_bancaria_id &&
      o.tipo === m.tipo &&
      o.fecha === m.fecha &&
      r2(Number(o.monto) || 0) === r2(Number(m.monto) || 0),
  );
  if (iguales.length === 0) return null;
  return iguales.find((o) => o.conciliado) ?? iguales[0];
}
