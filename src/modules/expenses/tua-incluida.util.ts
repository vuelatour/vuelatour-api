/**
 * «TUA incluida en este gasto» (13-oct-2026, TUA sistémica, invariante 66):
 * reglas PURAS del campo de OFICINA `gasto.tua_incluida` (alta y PATCH) y las
 * dos celdas del Excel de gastos. La PRIORIDAD de la TUA y su aritmética
 * viven en la fuente única `common/desglose-gasto.util.ts#partesDeGasto`:
 * aquí solo se decide si el valor se acepta, se limpia o se rechaza.
 *
 * - Solo en las facturas de aeropuerto (`CATEGORIAS_TUA_INCLUIDA`:
 *   Operaciones, Aterrizaje o FBO) y ≤ monto − propina (la base del
 *   desglose), validado sobre el estado FUSIONADO.
 * - null = volver a la lectura de la IA; 0 = «esta factura no cobra TUA»
 *   (nunca se rechaza ni se limpia solo).
 * - LIMPIEZA automática (PATCH sin la llave, con una TUA vigente > 0): la
 *   categoría efectiva ya no la admite, cambió la MONEDA del gasto (la cifra
 *   de la oficina estaba en la moneda vieja: USD y MXN nunca se mezclan) o un
 *   rol de campo bajó el monto por debajo de ella. La oficina que baja el
 *   monto sin tocarla recibe 400 (debe corregirla en el mismo guardado).
 */
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import {
  categoriaAdmiteTuaIncluida,
  trasladosEmbebidosDeGasto,
  tuaIncluidaDe,
  type GastoParaTuaEmbebido,
} from '../../common/desglose-gasto.util';
import { MIGRACION_TUA_INCLUIDA } from '../../common/tua-incluida-disponible.util';

/** Códigos estables de los rechazos (`error` del cuerpo). */
export const CODIGO_TUA_INCLUIDA = {
  MAYOR_QUE_TICKET: 'TUA_INCLUIDA_MAYOR_QUE_TICKET',
  NO_APLICA: 'TUA_INCLUIDA_NO_APLICA',
  NO_DISPONIBLE: 'TUA_INCLUIDA_NO_DISPONIBLE',
} as const;

/** 409 sin la migración (un NÚMERO; null sin la migración es un no-op). */
export const MENSAJE_TUA_INCLUIDA_NO_DISPONIBLE = `La TUA incluida todavía no se puede guardar: falta aplicar la migración ${MIGRACION_TUA_INCLUIDA}. Mientras tanto la TUA se separa solo con la lectura de la IA.`;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 400 MAYOR_QUE_TICKET (la oficina mandó una TUA mayor que el ticket). */
export function mensajeTuaMayorQueTicket(
  tua: number,
  base: number,
  moneda: string | null | undefined,
): string {
  return `La TUA incluida (${fmtDineroTexto(tua, moneda)}) no puede ser mayor que el monto del ticket (${fmtDineroTexto(base, moneda)}, sin propina).`;
}

/** 400 MAYOR_QUE_TICKET cuando la OFICINA baja el monto bajo la TUA vigente. */
export function mensajeTuaVigenteMayorQueTicket(
  vigente: number,
  base: number,
  moneda: string | null | undefined,
): string {
  return `Este gasto tiene una TUA incluida de ${fmtDineroTexto(vigente, moneda)} fijada por la oficina y el nuevo monto del ticket (${fmtDineroTexto(base, moneda)}, sin propina) es menor: corrige o vacía «TUA incluida en este gasto» en el mismo guardado.`;
}

/** 400 NO_APLICA (categoría fuera de las facturas de aeropuerto). */
export function mensajeTuaNoAplica(
  categoria: string | null | undefined,
): string {
  return `La categoría «${etiquetaCategoriaGasto(categoria)}» no lleva TUA incluida: solo las facturas de aeropuerto (Operaciones, Aterrizaje o FBO). Déjala vacía o cambia la categoría.`;
}

/** Cuerpo de los rechazos (`{ message, error, details }`, el filtro lo pasa). */
export type ErrorTuaIncluida = {
  message: string;
  error: string;
  details: Record<string, unknown>;
};

/**
 * Regla del ALTA (y de un PATCH que MANDA la llave), sobre el estado
 * fusionado: null / undefined / 0 ⇒ sin error; > 0 en una categoría que no
 * la admite ⇒ NO_APLICA (la categoría se revisa ANTES que el importe); > la
 * base (monto − propina, a centavos, +0.005) ⇒ MAYOR_QUE_TICKET.
 */
export function errorTuaIncluidaAlta(args: {
  tua: number | null | undefined;
  monto: number;
  propina: number;
  categoria: string | null | undefined;
  moneda: string | null | undefined;
}): ErrorTuaIncluida | null {
  const { tua } = args;
  if (tua === null || tua === undefined || !(Number(tua) > 0)) return null;
  if (!categoriaAdmiteTuaIncluida(args.categoria)) {
    return {
      message: mensajeTuaNoAplica(args.categoria),
      error: CODIGO_TUA_INCLUIDA.NO_APLICA,
      details: { categoria: args.categoria ?? null },
    };
  }
  const base = r2((Number(args.monto) || 0) - (Number(args.propina) || 0));
  if (Number(tua) > base + 0.005) {
    return {
      message: mensajeTuaMayorQueTicket(Number(tua), base, args.moneda),
      error: CODIGO_TUA_INCLUIDA.MAYOR_QUE_TICKET,
      details: {
        tua_incluida: Number(tua),
        base,
        moneda: args.moneda ?? null,
        vigente: false,
      },
    };
  }
  return null;
}

/** Qué hacer con `tua_incluida` en un PATCH (estado FUSIONADO). */
export type DecisionTuaIncluida =
  | { accion: 'NADA' }
  | { accion: 'LIMPIAR'; motivo: 'CATEGORIA' | 'MONEDA' | 'MONTO' }
  | { accion: 'ERROR'; error: ErrorTuaIncluida };

/**
 * Regla del PATCH. `enviado` = lo que trae el DTO (undefined = no se tocó);
 * `vigente` = `tuaIncluidaDe(actual)`; categoría/monto/propina/moneda = el
 * estado EFECTIVO tras el merge; `monedaCambio` = el PATCH cambia la moneda
 * del gasto; `esCampo` = PILOTO/MECANICO/VISITANTE.
 *  - Con la llave: las MISMAS reglas que el alta (null y 0 siempre NADA).
 *  - Sin la llave y con una TUA vigente > 0: categoría que ya no la admite ⇒
 *    LIMPIAR CATEGORIA; moneda nueva ⇒ LIMPIAR MONEDA (todos los roles); la
 *    base nueva quedó debajo ⇒ un rol de campo LIMPIA (MONTO), la oficina
 *    recibe 400 MAYOR_QUE_TICKET con `vigente: true`. Un 0 vigente nunca se
 *    limpia solo.
 */
export function decidirTuaIncluidaEnUpdate(args: {
  enviado: number | null | undefined;
  vigente: number | null;
  categoria: string | null | undefined;
  monto: number;
  propina: number;
  moneda: string | null | undefined;
  monedaCambio: boolean;
  esCampo: boolean;
}): DecisionTuaIncluida {
  if (args.enviado !== undefined) {
    const error = errorTuaIncluidaAlta({
      tua: args.enviado,
      monto: args.monto,
      propina: args.propina,
      categoria: args.categoria,
      moneda: args.moneda,
    });
    return error ? { accion: 'ERROR', error } : { accion: 'NADA' };
  }
  const vigente = args.vigente;
  if (vigente === null || !(vigente > 0)) return { accion: 'NADA' };
  if (!categoriaAdmiteTuaIncluida(args.categoria)) {
    return { accion: 'LIMPIAR', motivo: 'CATEGORIA' };
  }
  if (args.monedaCambio) return { accion: 'LIMPIAR', motivo: 'MONEDA' };
  const base = r2((Number(args.monto) || 0) - (Number(args.propina) || 0));
  if (vigente > base + 0.005) {
    if (args.esCampo) return { accion: 'LIMPIAR', motivo: 'MONTO' };
    return {
      accion: 'ERROR',
      error: {
        message: mensajeTuaVigenteMayorQueTicket(vigente, base, args.moneda),
        error: CODIGO_TUA_INCLUIDA.MAYOR_QUE_TICKET,
        details: {
          tua_incluida: vigente,
          base,
          moneda: args.moneda ?? null,
          vigente: true,
        },
      },
    };
  }
  return { accion: 'NADA' };
}

/**
 * Las DOS celdas del Excel de gastos, justo después de «Monto»: «TUA
 * incluida» = la TUA que SEPARAN los libros (`trasladosEmbebidosDeGasto`,
 * con la prioridad única y sus exclusiones; 0.00 si la oficina fijó «sin
 * TUA»; vacía si nada) y «Origen TUA» = «Oficina» (la fijó la oficina, 0
 * incluido) | «IA» (la leyó la IA) | vacío.
 */
export function celdasTuaExcel(
  g: GastoParaTuaEmbebido,
): [number | null, string] {
  const fija = tuaIncluidaDe(g);
  const tua = trasladosEmbebidosDeGasto(g).tua;
  const valor = tua > 0 ? r2(tua) : fija === 0 ? 0 : null;
  const origen =
    fija !== null ? 'Oficina' : valor !== null && valor > 0 ? 'IA' : '';
  return [valor, origen];
}
