import {
  horasVivasComponente,
  tiempoPlaneador,
  type AeronaveConBasePlaneador,
  type ComponenteConBase,
} from '../../common/horas-componente.util';
import type {
  BitacoraTiraFilaPayload,
  BitacoraTiraPayload,
  BitacoraTiraTipo,
} from '../pyservices/pyservices.service';

export type { BitacoraTiraTipo } from '../pyservices/pyservices.service';

/**
 * Construcción PURA de las tiras (páginas) del PDF de bitácoras de vuelo.
 *
 * Todas las tiras comparten las MISMAS filas (una por vuelo: fecha, taco
 * inicial/final, horas, ruta — las agrupa aircraft.service) y solo cambia el
 * tiempo acumulado del componente, derivado del tacómetro con la base
 * capturada: los tiempos de planeador, motor y hélice difieren porque cada
 * libro arrancó en otro momento. Sin la base no se inventa nada: el motor
 * imprime solo tacómetro (en el monomotor el taco ES el tiempo del motor) y
 * la hélice deja las columnas en "—" para llenarlas a mano, salvo que la
 * oficina teclee el tiempo del primer renglón (`heliceBase`, como en su
 * plantilla) y entonces se corre con offset constante.
 */

/** Orden canónico de las páginas del PDF; también dedupe de la query. */
export const BITACORA_TIRA_TIPOS: readonly BitacoraTiraTipo[] = [
  'PLANEADOR',
  'MOTOR',
  'HELICE',
];

/** Fila de bitácora ya agrupada por vuelo (sin tiempos de componente). */
export interface FilaBaseBitacora {
  fecha: string;
  taco_inicial: number;
  horas: number;
  taco_final: number;
  ruta: string;
}

/** Ficha mínima de motor/hélice (columnas de la tabla `motor` / `helice`). */
export interface ComponenteBitacora extends ComponenteConBase {
  posicion?: string | null;
  numero_serie?: string | null;
}

export interface ConstruirTirasInput {
  tiras: readonly string[];
  filasBase: FilaBaseBitacora[];
  aeronave: AeronaveConBasePlaneador;
  motores: ComponenteBitacora[];
  helices: ComponenteBitacora[];
  /** Tiempo de hélice del PRIMER renglón tecleado por oficina (opcional). */
  heliceBase?: number | null;
}

const r1 = (x: number): number => Number(x.toFixed(1));

/** "5226.1" ⇒ "5,226.1" (1 decimal, separador de miles; sin depender de ICU). */
export function formatearHoras(n: number): string {
  const [entero, decimal] = Math.abs(n).toFixed(1).split('.');
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${conMiles}.${decimal}`;
}

/**
 * Dedupe + orden canónico (PLANEADOR, MOTOR, HELICE) de lo que pida la
 * query; ignora espacios/minúsculas y valores desconocidos.
 */
export function normalizarTiras(
  tiras: readonly string[] | null | undefined,
): BitacoraTiraTipo[] {
  const pedidas = new Set(
    (tiras ?? []).map((t) => String(t).trim().toUpperCase()),
  );
  return BITACORA_TIRA_TIPOS.filter((t) => pedidas.has(t));
}

/**
 * Qué tiras imprimir según la query. `tiras` manda; sin ella, `formato`
 * (DEPRECADO) reproduce el PDF histórico: MOTOR_HELICE ⇒ motor + hélice,
 * PLANEADOR ⇒ la tira de tacómetro (hoy = MOTOR sin tiempo). Sin nada ⇒
 * las tres.
 */
export function resolverTirasSolicitadas(q: {
  tiras?: readonly string[] | null;
  formato?: 'PLANEADOR' | 'MOTOR_HELICE' | null;
}): BitacoraTiraTipo[] {
  const explicitas = normalizarTiras(q.tiras);
  if (explicitas.length > 0) return explicitas;
  if (q.formato === 'MOTOR_HELICE') return ['MOTOR', 'HELICE'];
  if (q.formato === 'PLANEADOR') return ['MOTOR'];
  return [...BITACORA_TIRA_TIPOS];
}

export function construirTiras(
  input: ConstruirTirasInput,
): BitacoraTiraPayload[] {
  const out: BitacoraTiraPayload[] = [];
  for (const tipo of normalizarTiras(input.tiras)) {
    if (tipo === 'PLANEADOR') {
      out.push(tiraPlaneador(input.filasBase, input.aeronave));
    } else if (tipo === 'MOTOR') {
      out.push(...tirasMotor(input.filasBase, input.motores));
    } else {
      out.push(
        ...tirasHelice(input.filasBase, input.helices, input.heliceBase),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Copia las filas base agregando el tiempo derivado (null ⇒ "—" en el PDF). */
function filasConTiempo(
  filasBase: FilaBaseBitacora[],
  tiempo: ((taco: number) => number) | null,
): BitacoraTiraFilaPayload[] {
  return filasBase.map((f) => ({
    fecha: f.fecha,
    taco_inicial: f.taco_inicial,
    horas: f.horas,
    taco_final: f.taco_final,
    tiempo_inicial: tiempo ? tiempo(f.taco_inicial) : null,
    tiempo_final: tiempo ? tiempo(f.taco_final) : null,
    ruta: f.ruta,
  }));
}

function tiraPlaneador(
  filasBase: FilaBaseBitacora[],
  aeronave: AeronaveConBasePlaneador,
): BitacoraTiraPayload {
  const base = Number(aeronave.planeador_horas_base ?? 0);
  const ref = Number(aeronave.planeador_taco_ref ?? 0);
  const sinBase = base === 0 && ref === 0;
  return {
    tipo: 'PLANEADOR',
    titulo: 'Bitácora de planeador',
    etiqueta: 'Tiempo planeador',
    nota: sinBase
      ? 'Sin base de planeador capturada en la ficha del avión: el tiempo iguala al tacómetro'
      : `Base del planeador: ${formatearHoras(base)} h cuando el tacómetro marcaba ${formatearHoras(ref)}`,
    con_tiempo: true,
    // Misma fórmula que tiempoTotalPlaneador pero SIN recorte: un renglón
    // anterior a la referencia debe salir con su tiempo real (5174.2 para
    // taco 100.0 con base 5226.1/ref 151.9).
    filas: filasConTiempo(filasBase, (taco) =>
      tiempoPlaneador(aeronave, taco, { recortar: false }),
    ),
  };
}

/** Ficha con base real: horas de vida > 0 ancladas a un tacómetro. */
function tieneBase(c: ComponenteBitacora): boolean {
  return Number(c.horas_totales ?? 0) > 0 && c.aeronave_horas_ref != null;
}

type LadoComponente = 'UNICO' | 'IZQ' | 'DER';

/**
 * Lado de un motor/hélice según la posición de su ficha. Enums reales de la
 * BD: posicion_motor = UNICO | IZQUIERDO | DERECHO y posicion_helice = UNICA
 * | IZQUIERDA | DERECHA; se toleran las abreviaturas IZQ/DER. null ⇒
 * posición desconocida (el título la imprime literal).
 */
function ladoDePosicion(
  posicion: string | null | undefined,
): LadoComponente | null {
  const p = String(posicion ?? '')
    .trim()
    .toUpperCase();
  if (!p || p === 'UNICO' || p === 'UNICA') return 'UNICO';
  if (p === 'IZQ' || p === 'IZQUIERDO' || p === 'IZQUIERDA') return 'IZQ';
  if (p === 'DER' || p === 'DERECHO' || p === 'DERECHA') return 'DER';
  return null;
}

const ORDEN_LADO: Record<LadoComponente, number> = { UNICO: 0, IZQ: 1, DER: 2 };

/** Único/izquierda antes que derecha; el resto por nombre (determinista). */
function ordenarComponentes<T extends ComponenteBitacora>(cs: T[]): T[] {
  const clave = (c: T): string =>
    String(c.posicion ?? '')
      .trim()
      .toUpperCase();
  const rango = (c: T): number => {
    const lado = ladoDePosicion(c.posicion);
    return lado ? ORDEN_LADO[lado] : 3;
  };
  return [...cs].sort(
    (a, b) => rango(a) - rango(b) || clave(a).localeCompare(clave(b)),
  );
}

function tituloPorPosicion(
  base: string,
  posicion: string | null | undefined,
  lados: { IZQ: string; DER: string },
): string {
  const lado = ladoDePosicion(posicion);
  if (lado === 'UNICO') return base;
  if (lado === 'IZQ') return `${base} ${lados.IZQ}`;
  if (lado === 'DER') return `${base} ${lados.DER}`;
  return `${base} ${String(posicion ?? '').trim()}`;
}

function notaComponente(nombre: string, c: ComponenteBitacora): string {
  const sn = String(c.numero_serie ?? '').trim() || '—';
  return `${nombre} S/N ${sn}: ${formatearHoras(Number(c.horas_totales ?? 0))} h cuando el tacómetro marcaba ${formatearHoras(Number(c.aeronave_horas_ref))}`;
}

/** Misma aritmética que componenteEstado (horas-componente.util), sin recorte. */
const tiempoComponente =
  (c: ComponenteBitacora) =>
  (taco: number): number =>
    horasVivasComponente(c, taco, { recortar: false }).horas;

function tirasMotor(
  filasBase: FilaBaseBitacora[],
  motores: ComponenteBitacora[],
): BitacoraTiraPayload[] {
  const conBase = ordenarComponentes(motores.filter(tieneBase));
  if (conBase.length === 0) {
    // Sin ficha con horas: solo columnas de tacómetro (en el monomotor el
    // tacómetro ES el tiempo del motor; la hoja histórica del equipo).
    return [
      {
        tipo: 'MOTOR',
        titulo: 'Bitácora de motor',
        etiqueta: 'Tiempo motor',
        nota: 'Tiempo del motor = lectura del tacómetro (sin horas del motor capturadas en su ficha)',
        con_tiempo: false,
        filas: filasConTiempo(filasBase, null),
      },
    ];
  }
  return conBase.map((m) => ({
    tipo: 'MOTOR',
    titulo: tituloPorPosicion('Bitácora de motor', m.posicion, {
      IZQ: 'izquierdo',
      DER: 'derecho',
    }),
    etiqueta: 'Tiempo motor',
    nota: notaComponente('Motor', m),
    con_tiempo: true,
    filas: filasConTiempo(filasBase, tiempoComponente(m)),
  }));
}

function tirasHelice(
  filasBase: FilaBaseBitacora[],
  helices: ComponenteBitacora[],
  heliceBase: number | null | undefined,
): BitacoraTiraPayload[] {
  // (a) Valor tecleado por oficina: offset constante desde el PRIMER renglón
  // (la hélice corre pareja con el tacómetro). Gana sobre la ficha.
  if (heliceBase != null) {
    const offset =
      filasBase.length > 0 ? heliceBase - filasBase[0].taco_inicial : 0;
    return [
      {
        tipo: 'HELICE',
        titulo: 'Bitácora de hélice',
        etiqueta: 'Tiempo hélice',
        nota: `Tiempo de hélice del primer renglón capturado a mano: ${formatearHoras(heliceBase)}`,
        con_tiempo: true,
        filas: filasConTiempo(filasBase, (taco) => r1(taco + offset)),
      },
    ];
  }
  // (b) Ficha de hélice con horas: misma derivación que el motor.
  const conBase = ordenarComponentes(helices.filter(tieneBase));
  if (conBase.length > 0) {
    return conBase.map((h) => ({
      tipo: 'HELICE',
      titulo: tituloPorPosicion('Bitácora de hélice', h.posicion, {
        IZQ: 'izquierda',
        DER: 'derecha',
      }),
      etiqueta: 'Tiempo hélice',
      nota: notaComponente('Hélice', h),
      con_tiempo: true,
      filas: filasConTiempo(filasBase, tiempoComponente(h)),
    }));
  }
  // (c) Nada capturado: columnas de tiempo en "—" para llenarlas a mano.
  return [
    {
      tipo: 'HELICE',
      titulo: 'Bitácora de hélice',
      etiqueta: 'Tiempo hélice',
      nota: 'Sin horas de hélice capturadas: llena las columnas a mano (o captúralas en Componentes → hélice)',
      con_tiempo: true,
      filas: filasConTiempo(filasBase, null),
    },
  ];
}
