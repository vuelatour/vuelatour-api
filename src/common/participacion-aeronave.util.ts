/**
 * Participación por AERONAVE en un vuelo multi-avión — FUENTE ÚNICA.
 *
 * Regla del cliente (28-ago-2026): cuando los tramos de un vuelo los vuelan
 * aviones distintos (ida en N990GG, regreso en N4142R), la VENTA DEL AVIÓN
 * (tiempo de vuelo + ajuste + su IVA, ver `particionIngresoVuelo`) y lo que
 * de ella deriva — cobros, por cobrar, horas cobradas — se REPARTE entre los
 * aviones por tramo ("mitad y mitad" en ida/regreso; con más tramos, tantas
 * partes como tramos vendidos voló cada avión). Los GASTOS no se reparten:
 * van al avión del tramo al que están enlazados (`avionDelGasto`). El
 * ingreso de VuelaTour (TUAS/extras/pernocta/comisión del vendedor) no es de
 * ningún avión y no se reparte.
 *
 * Peso = PARTES IGUALES POR TRAMO VENDIDO (regla literal del cliente:
 * "ida/regreso = mitad y mitad; con más tramos, repartirlo correctamente").
 * NO se usan horas, ni reales ni cotizadas, a propósito: el #105 real tiene
 * 0.9/1.3 h de tacos y 1.2033/1.1967 h cotizadas (saldría 41/59 o
 * 50.14/49.86 y el cliente pidió mitad y mitad), y el itinerario operativo
 * no siempre coincide tramo a tramo con la ruta cotizada (ferries
 * intercalados, órdenes distintos), así que emparejar por `orden` con el
 * snapshot es frágil. Los tacos siguen mandando en las HORAS VOLADAS de cada
 * avión (se calculan aparte, por escala).
 * Tramos OPERATIVOS (`solo_operativa` / `es_ferry`: posicionamiento, ferry,
 * parada técnica, orden ≥ 100) NO se vendieron y no reparten la venta; si el
 * vuelo solo tiene tramos operativos (#138, servicio $0) se usan todos.
 * Tramos cancelados (`cancelada_at`) no participan. El avión de un tramo se
 * resuelve CON HERENCIA: `escala.aeronave_id ?? vuelo.aeronave_id` (regla
 * de todo el sistema — comparar el id crudo apaga el reparto en silencio).
 * (`fuente` 'cotizacion'/'tacos' quedan reservados en el tipo; no se emiten.)
 *
 * Los factores se redondean a 4 decimales y el residuo va al avión
 * PRINCIPAL (`vuelo.aeronave_id`): Σ factores == 1 exacto. Para repartir
 * dinero usar `repartirUsd` (centavos por residuo mayor: Σ partes == monto
 * exacto; nunca prorratear a mano y redondear cada parte por separado).
 *
 * Lectores: balance por avión, reparto de dueños, Libro Dinero, reporte por
 * vuelo, detalle de vuelo/cotización (panel). Cualquier lector nuevo de
 * "venta del avión" en vuelos multi-avión usa ESTA función. Si el cliente
 * decide algún día repartir por horas, cambiar SOLO `pesosTramo` aquí.
 */

import type { ParticionIngreso } from './ingreso-vuelo.util';

export interface EscalaParticipacionInput {
  id?: string | null;
  orden?: number | string | null;
  aeronave_id?: string | null;
  cancelada_at?: string | null;
  taco_salida?: number | string | null;
  taco_llegada?: number | string | null;
  /** Tramo operativo (ferry / posicionamiento / parada técnica): no vende. */
  solo_operativa?: boolean | null;
  es_ferry?: boolean | null;
}

export interface VueloParticipacionInput {
  aeronave_id?: string | null;
  calculo_snapshot?: unknown;
}

export type FuenteParticipacion = 'unico' | 'tacos' | 'cotizacion' | 'tramos';

export interface ParticipacionAeronave {
  /** aeronave_id → fracción (0, 1]; Σ == 1 exacto (4 decimales, residuo al principal). */
  factores: Map<string, number>;
  /** Peso crudo por avión (nº de tramos vendidos). */
  pesos: Map<string, number>;
  /** Tramos VENDIDOS activos que voló cada avión (etiquetas "1 de 2 tramos"). */
  tramos_por_avion: Map<string, number>;
  tramos_activos: number;
  fuente: FuenteParticipacion;
  /** true cuando participa más de un avión. */
  multi_avion: boolean;
  /** Avión principal del vuelo (`vuelo.aeronave_id`), si lo hay. */
  principal: string | null;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function unico(principal: string | null): ParticipacionAeronave {
  const factores = new Map<string, number>();
  const pesos = new Map<string, number>();
  const tramos = new Map<string, number>();
  if (principal) {
    factores.set(principal, 1);
    pesos.set(principal, 1);
  }
  return {
    factores,
    pesos,
    tramos_por_avion: tramos,
    tramos_activos: 0,
    fuente: 'unico',
    multi_avion: false,
    principal,
  };
}

export function participacionPorAeronave(
  v: VueloParticipacionInput,
  escalas: EscalaParticipacionInput[] | null | undefined,
): ParticipacionAeronave {
  const principal = v.aeronave_id ?? null;
  const activas = (escalas ?? []).filter((e) => e.cancelada_at == null);
  // Tramos OPERATIVOS (ferry / posicionamiento / parada técnica) no se
  // vendieron: no reparten la venta (sí cuentan en las horas reales de cada
  // avión, que se calculan aparte). Si el vuelo solo tiene operativos
  // (#138, servicio $0) se usan todos: nada que repartir, pero cada libro
  // sabe que su avión participó.
  const comerciales = activas.filter(
    (e) => e.solo_operativa !== true && e.es_ferry !== true,
  );
  const base = comerciales.length > 0 ? comerciales : activas;
  // Avión de cada tramo con herencia; los tramos sin avión resoluble no
  // participan (vuelo externo sin avión de referencia).
  const conAvion = base
    .map((e) => ({ e, avion: e.aeronave_id ?? principal }))
    .filter((x): x is { e: EscalaParticipacionInput; avion: string } =>
      Boolean(x.avion),
    );
  if (conAvion.length === 0) return unico(principal);

  const tramosPorAvion = new Map<string, number>();
  for (const { avion } of conAvion) {
    tramosPorAvion.set(avion, (tramosPorAvion.get(avion) ?? 0) + 1);
  }
  if (tramosPorAvion.size === 1) {
    const soloUno = unico([...tramosPorAvion.keys()][0]);
    soloUno.tramos_por_avion = tramosPorAvion;
    soloUno.tramos_activos = conAvion.length;
    return soloUno;
  }

  // Partes iguales por tramo vendido (ver cabecera).
  const fuente: FuenteParticipacion = 'tramos';
  const pesosTramo = conAvion.map(() => 1);

  const pesos = new Map<string, number>();
  conAvion.forEach(({ avion }, i) => {
    pesos.set(avion, (pesos.get(avion) ?? 0) + pesosTramo[i]);
  });
  const total = [...pesos.values()].reduce((a, b) => a + b, 0);

  // Factores a 4 decimales; el residuo cierra en el principal (o, si el
  // principal no voló ningún tramo vendido, en el avión de mayor peso).
  const factores = new Map<string, number>();
  let suma = 0;
  for (const [avion, peso] of pesos) {
    const f = round4(peso / total);
    factores.set(avion, f);
    suma += f;
  }
  const residuo = round4(1 - suma);
  if (Math.abs(residuo) >= 0.00005) {
    const receptor =
      principal && factores.has(principal)
        ? principal
        : [...pesos.entries()].sort((a, b) => b[1] - a[1])[0][0];
    factores.set(receptor, round4((factores.get(receptor) ?? 0) + residuo));
  }

  return {
    factores,
    pesos,
    tramos_por_avion: tramosPorAvion,
    tramos_activos: conAvion.length,
    fuente,
    multi_avion: true,
    principal,
  };
}

/** Fracción del avión en el vuelo (0 si no participa). */
export function factorDe(
  p: ParticipacionAeronave,
  aeronaveId: string | null | undefined,
): number {
  if (!aeronaveId) return 0;
  return p.factores.get(aeronaveId) ?? 0;
}

/**
 * Avión que REPORTA la parte de VuelaTour (TUAS/extras/pernocta/comisión) y
 * los avisos de cotización/cobranza del vuelo — UNA sola vez por vuelo: el
 * principal si participa; si no (su único tramo se canceló y el regreso lo
 * voló otro avión), el primer avión participante. Misma regla en balance,
 * reparto y Libro Dinero: con factor 0 en el principal, la parte de
 * VuelaTour no puede desaparecer de todos los libros.
 */
export function avionQueReporta(p: ParticipacionAeronave): string | null {
  if (p.principal && (p.factores.get(p.principal) ?? 0) > 0) {
    return p.principal;
  }
  const primero = [...p.factores.entries()].find(([, f]) => f > 0);
  return primero ? primero[0] : (p.principal ?? null);
}

/**
 * Reparte un monto (USD o MXN) entre los aviones según `factores`, en
 * centavos por residuo mayor: Σ partes == round2(monto) EXACTO. Empates de
 * residuo: primero el principal, luego orden de inserción. Montos negativos
 * se reparten con el mismo criterio sobre el valor absoluto.
 */
export function repartirUsd(
  monto: number,
  p: ParticipacionAeronave,
): Map<string, number> {
  const out = new Map<string, number>();
  const aviones = [...p.factores.keys()];
  if (aviones.length === 0) return out;
  const signo = monto < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(monto) * 100);
  const partes = aviones.map((avion, idx) => {
    const exacto = cents * (p.factores.get(avion) ?? 0);
    const base = Math.floor(exacto + 1e-9);
    return { avion, idx, cents: base, resto: exacto - base };
  });
  let faltan = cents - partes.reduce((acc, x) => acc + x.cents, 0);
  const orden = [...partes].sort((a, b) => {
    if (Math.abs(b.resto - a.resto) > 1e-9) return b.resto - a.resto;
    if (a.avion === p.principal) return -1;
    if (b.avion === p.principal) return 1;
    return a.idx - b.idx;
  });
  for (const x of orden) {
    if (faltan <= 0) break;
    x.cents += 1;
    faltan -= 1;
  }
  for (const x of partes) out.set(x.avion, (signo * x.cents) / 100);
  return out;
}

/**
 * Parte de ESTA FILA (un avión) de un monto COBRADO del vuelo — FUENTE ÚNICA
 * del balance por avión y del Libro Dinero (verificación 28-ago-2026).
 *
 * En un vuelo multi-avión con parte de VuelaTour (TUAS/extras/pernocta/
 * comisión) la fila que REPORTA lleva como total su parte de la venta del
 * avión + TODA la parte de VuelaTour; si sus cobros se repartieran por el
 * factor del avión (depósito entero × factor) la fila no cuadraría consigo
 * misma (total ≠ Σ cobros) ni con el Libro Dinero. Regla:
 *   parteAvionVuelo = montoVuelo × factor_avion de la partición (solo con
 *                     precio y NO cancelado; si no, el monto entero es del
 *                     avión — en un cancelado lo retenido es 100 % del avión)
 *   parte de la fila = repartirUsd(parteAvionVuelo)[avión]
 *                      + (reporta ? montoVuelo − parteAvionVuelo : 0)
 * Σ filas de los libros == montoVuelo al centavo. Con un solo avión (o sin
 * participación multi-avión) devuelve `montoVuelo` tal cual — cero cambio
 * numérico respecto al libro de siempre; un avión que no participa recibe 0.
 * Sirve igual para MXN, USD y comisiones bancarias del cobro.
 */
export function parteFilaDeCobro(
  montoVuelo: number,
  p: Pick<ParticionIngreso, 'total_usd' | 'factor_avion'> | null | undefined,
  part: ParticipacionAeronave | null | undefined,
  aeronaveId: string | null | undefined,
  reporta: boolean,
  cancelado: boolean,
): number {
  if (!part || !part.multi_avion) {
    if (part && aeronaveId && part.factores.size > 0) {
      return part.factores.has(aeronaveId) ? montoVuelo : 0;
    }
    return montoVuelo;
  }
  const parteAvionVuelo =
    p && !cancelado && p.total_usd > 0
      ? round2(montoVuelo * p.factor_avion)
      : montoVuelo;
  const parteAvion = aeronaveId
    ? (repartirUsd(parteAvionVuelo, part).get(aeronaveId) ?? 0)
    : 0;
  return round2(
    parteAvion + (reporta ? round2(montoVuelo - parteAvionVuelo) : 0),
  );
}

/**
 * Avión al que pertenece un GASTO de un vuelo (regla del cliente 28-ago:
 * "los gastos van al avión que realizó el tramo y que tenga enlazado").
 * Prioridad: avión de la ESCALA del gasto (con herencia) → avión sellado en
 * el gasto → avión principal del vuelo. Misma resolución en balance por
 * avión, reparto y Libro Dinero. El mapa de escalas debe incluir TAMBIÉN
 * las canceladas (un gasto ligado a un tramo cancelado sigue siendo de ese
 * avión).
 */
export function avionDelGasto(
  g: { escala_id?: string | null; aeronave_id?: string | null },
  escalaPorId: Map<string, { aeronave_id?: string | null }>,
  vueloAeronaveId: string | null | undefined,
): string | null {
  const esc = g.escala_id ? escalaPorId.get(g.escala_id) : undefined;
  return (
    (esc ? (esc.aeronave_id ?? vueloAeronaveId ?? null) : null) ??
    g.aeronave_id ??
    vueloAeronaveId ??
    null
  );
}

/**
 * Elemento de `participacion_aviones[]` (detalle de cotización —
 * quotes.findById — y snapshot del vuelo — flights.snapshot; campo ADITIVO,
 * regla B 28-ago). `factor` ∈ (0, 1], Σ == 1 (partes iguales por tramo
 * vendido); `venta_avion_usd` = parte de la VENTA DEL AVIÓN
 * (`particionIngresoVuelo(v).avion_usd` repartido con `repartirUsd`: Σ ==
 * avion_usd al centavo; null sin precio). `horas` se conserva por contrato
 * del panel/app (siempre null: el peso ya no es por horas).
 */
export interface ParticipacionAvionItem {
  aeronave_id: string;
  matricula: string | null;
  factor: number;
  tramos: number;
  horas: number | null;
  venta_avion_usd: number | null;
}

/**
 * Mapper ÚNICO de `participacion_aviones[]`: principal primero, el resto en
 * el orden de sus tramos. `avionUsd` = venta del avión del vuelo (null sin
 * precio → `venta_avion_usd` null en cada elemento). Los lectores solo
 * aportan las matrículas (una consulta).
 */
export function participacionAvionesItems(
  p: ParticipacionAeronave,
  avionUsd: number | null,
  matriculaPorId: Map<string, string>,
): ParticipacionAvionItem[] {
  const ventaPorAvion = avionUsd != null ? repartirUsd(avionUsd, p) : null;
  const ids = [...p.factores.keys()];
  ids.sort((a, b) => (a === p.principal ? -1 : b === p.principal ? 1 : 0));
  return ids.map((id) => ({
    aeronave_id: id,
    matricula: matriculaPorId.get(id) ?? null,
    factor: p.factores.get(id) ?? 0,
    tramos: p.tramos_por_avion.get(id) ?? 0,
    horas: null,
    venta_avion_usd: ventaPorAvion ? (ventaPorAvion.get(id) ?? 0) : null,
  }));
}
