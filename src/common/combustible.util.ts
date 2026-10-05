/**
 * COMBUSTIBLE POR AERONAVE — fuente única (5-oct-2026, API 0.0.56,
 * migración `20261005000001_aeronave_combustible.sql`).
 *
 * Caso real: Luis capturó desde la app una carga de 74 L para el XB-PEV
 * (vuelo #280, Chetumal) y eligió «Turbosina»; el PEV (Cessna 205, pistón)
 * solo carga AVGAS y el balance Excel del avión mostró «Combustible
 * TURBOSINA». Pedido del cliente: dejar registrado en cada avión qué
 * combustible usa (`aeronave.combustible`) y que toda carga GAS se AJUSTE a
 * ese valor al capturarla, marcándola para revisión si se eligió otro.
 *
 * PURO: sin BD ni Nest. Los textos que un humano lee (nota del gasto, aviso
 * a oficina, avisos de la carga masiva) salen de aquí y tienen spec.
 *
 * `gasto.tipo_combustible` es TEXT ('AVGAS' | 'TURBOSINA', sin enum) y
 * `aeronave.combustible` lleva CHECK con los mismos dos valores.
 */
import { fmtDineroTexto } from './dinero-texto.util';

/** Combustibles que carga la flota (mismo orden que el selector del panel). */
export const COMBUSTIBLES = ['AVGAS', 'TURBOSINA'] as const;

export type CombustibleAeronave = (typeof COMBUSTIBLES)[number];

/** Default de la columna (pistón): el de la mayoría de la flota. */
export const COMBUSTIBLE_DEFAULT: CombustibleAeronave = 'AVGAS';

/** 400 del DTO de aeronave cuando `combustible` no es del catálogo. */
export const MENSAJE_COMBUSTIBLE_INVALIDO =
  'El combustible del avión es AVGAS (pistón) o TURBOSINA (turbina).';

const ETIQUETA: Record<CombustibleAeronave, string> = {
  AVGAS: 'Avgas',
  TURBOSINA: 'Turbosina',
};

/**
 * Valor de BD/DTO a `CombustibleAeronave` (sin espacios, mayúsculas) o
 * `null` si viene vacío o no es uno de los dos.
 */
export function normalizarCombustible(v: unknown): CombustibleAeronave | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return (COMBUSTIBLES as readonly string[]).includes(s)
    ? (s as CombustibleAeronave)
    : null;
}

/** «el XB-PEV» (o «el avión» sin matrícula): sujeto de todos los textos. */
function elAvion(matricula: string | null | undefined): string {
  const m = matricula?.trim();
  return m ? `el ${m}` : 'el avión';
}

/** «Avgas» / «Turbosina»; «—» si no se sabe. */
export function etiquetaCombustible(v: unknown): string {
  const c = normalizarCombustible(v);
  return c ? ETIQUETA[c] : '—';
}

export interface EntradaTipoCombustible {
  /** Lo que mandó quien capturó (o lo que ya tenía el gasto en un PATCH). */
  capturado: unknown;
  /** `aeronave.combustible` del avión del gasto; vacío ⇒ no se corrige. */
  delAvion: unknown;
  /** Matrícula del avión, para el texto («XB-PEV»). */
  matricula?: string | null;
  /**
   * `captura` (default): el valor vino del formulario. `cambio_avion`: el
   * PATCH solo movió el gasto de avión/vuelo/tramo y el valor es el que el
   * gasto YA traía (el texto no dice «se capturó»).
   */
  motivo?: 'captura' | 'cambio_avion';
}

export interface ResultadoTipoCombustible {
  /** Valor que se guarda en `gasto.tipo_combustible` (null = sin dato). */
  tipo: CombustibleAeronave | null;
  /** Línea «⚠ … — revisar» para `gasto.notas` cuando se corrigió. */
  nota: string | null;
  /** true = se cambió un valor distinto al del avión (visto bueno + aviso). */
  corregido: boolean;
  /** true = venía vacío y se rellenó con el del avión (sin nota). */
  rellenado: boolean;
  /** Valor capturado normalizado (para textos y reportes). */
  capturado: CombustibleAeronave | null;
  /** Combustible del avión normalizado (null = no se sabe). */
  delAvion: CombustibleAeronave | null;
}

/**
 * REGLA ÚNICA: la carga GAS lleva el combustible DEL AVIÓN.
 *  - sin `delAvion` (avión sin dato o migración sin aplicar) ⇒ tal cual;
 *  - `capturado` vacío ⇒ se rellena con el del avión, sin nota;
 *  - igual ⇒ nada;
 *  - distinto ⇒ el del avión + nota «⚠ … — revisar» (`corregido`).
 */
export function resolverTipoCombustible(
  entrada: EntradaTipoCombustible,
): ResultadoTipoCombustible {
  const capturado = normalizarCombustible(entrada.capturado);
  const delAvion = normalizarCombustible(entrada.delAvion);
  const base = { capturado, delAvion };
  if (!delAvion) {
    return {
      ...base,
      tipo: capturado,
      nota: null,
      corregido: false,
      rellenado: false,
    };
  }
  if (!capturado) {
    return {
      ...base,
      tipo: delAvion,
      nota: null,
      corregido: false,
      rellenado: true,
    };
  }
  if (capturado === delAvion) {
    return {
      ...base,
      tipo: delAvion,
      nota: null,
      corregido: false,
      rellenado: false,
    };
  }
  const avion = elAvion(entrada.matricula);
  const origen =
    entrada.motivo === 'cambio_avion'
      ? `el gasto traía ${capturado}`
      : `se capturó ${capturado}`;
  return {
    ...base,
    tipo: delAvion,
    nota: `⚠ ${origen} pero ${avion} carga ${delAvion}: se corrigió a ${delAvion} — revisar`,
    corregido: true,
    rellenado: false,
  };
}

/**
 * Agrega `linea` al final de `notas` SOLO si no está ya como renglón
 * completo (repetir el PATCH no apila la misma nota).
 */
export function anexarLineaUnica(
  notas: string | null | undefined,
  linea: string,
): string {
  const base = notas ?? '';
  if (!base.trim()) return linea;
  const renglones = base.split('\n').map((r) => r.trim());
  if (renglones.includes(linea.trim())) return base;
  return `${base}\n${linea}`;
}

/**
 * Aviso a oficina (mismo canal que la discrepancia de matrícula) cuando el
 * alta corrigió el combustible.
 */
export function avisoCombustibleCorregido(args: {
  resultado: ResultadoTipoCombustible;
  matricula?: string | null;
  litros?: number | null;
  monto: number;
  moneda?: string | null;
}): { titulo: string; cuerpo: string } {
  const { resultado } = args;
  const avion = elAvion(args.matricula);
  const litros =
    args.litros != null && Number.isFinite(Number(args.litros))
      ? `${Number(args.litros).toLocaleString('en-US', { maximumFractionDigits: 2 })} L · `
      : '';
  return {
    titulo: 'Carga de combustible corregida',
    cuerpo:
      `Carga de combustible corregida: se capturó ${etiquetaCombustible(resultado.capturado)} ` +
      `pero ${avion} carga ${etiquetaCombustible(resultado.delAvion)} ` +
      `(${litros}${fmtDineroTexto(Number(args.monto), args.moneda)}). ` +
      `Se guardó como ${etiquetaCombustible(resultado.tipo)} y quedó para revisión.`,
  };
}

/**
 * Texto de la carga masiva para una fila cuyo tipo no es el del avión.
 * `preview`: lo que VA a pasar; `guardada`: lo que pasó. null si la fila
 * no se corrige.
 */
export function avisoFilaCombustible(
  resultado: ResultadoTipoCombustible,
  matricula: string | null | undefined,
  momento: 'preview' | 'guardada',
): string | null {
  if (!resultado.corregido) return null;
  const avion = elAvion(matricula);
  const capturado = etiquetaCombustible(resultado.capturado);
  const delAvion = etiquetaCombustible(resultado.delAvion);
  return momento === 'preview'
    ? `La fila dice ${capturado} pero ${avion} carga ${delAvion}: se guardará como ${delAvion} y quedará marcada para revisión.`
    : `La fila decía ${capturado} pero ${avion} carga ${delAvion}: se guardó como ${delAvion} y quedó marcada para revisión.`;
}
