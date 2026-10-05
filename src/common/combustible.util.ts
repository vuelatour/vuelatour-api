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

/**
 * Cómo lo llama el cliente (botón de la app, selector del panel, categoría
 * «Gasavión / Turbosina»). Solo TEXTO para humanos: lo que se guarda en
 * `gasto.tipo_combustible` / `aeronave.combustible` sigue siendo el código.
 */
const ETIQUETA: Record<CombustibleAeronave, string> = {
  AVGAS: 'Gasavión',
  TURBOSINA: 'Turbosina',
};

/**
 * 400 del DTO de aeronave cuando `combustible` no es del catálogo. Lleva la
 * ETIQUETA (cómo lo llama la oficina) Y el CÓDIGO (lo único que acepta la
 * API): quien integre directo y siga el mensaje manda el código, no
 * «Gasavión».
 */
export const MENSAJE_COMBUSTIBLE_INVALIDO = `El combustible del avión es ${ETIQUETA.AVGAS} (AVGAS, pistón) o ${ETIQUETA.TURBOSINA} (TURBOSINA, turbina).`;

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

/** Texto comparable: sin acentos, espacios ni guiones, en mayúsculas. */
function comparable(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

/**
 * Tipo de combustible ESCRITO POR UNA PERSONA (columna de la plantilla de la
 * carga masiva): acepta el código (`AVGAS`, `TURBOSINA`) o la ETIQUETA con
 * que la oficina lo llama («Gasavión», «gasavion», «Gas avión»,
 * «Turbosina»), sin distinguir mayúsculas, acentos, espacios ni guiones.
 * Devuelve el CÓDIGO (lo que se guarda) o `null`. Para valores de BD/DTO se
 * usa `normalizarCombustible` (solo códigos).
 */
export function combustibleDeTexto(v: unknown): CombustibleAeronave | null {
  if (typeof v !== 'string') return null;
  const s = comparable(v.trim());
  if (!s) return null;
  for (const c of COMBUSTIBLES) {
    if (s === c || s === comparable(ETIQUETA[c])) return c;
  }
  return null;
}

/**
 * Error de una fila de la carga masiva con un tipo que no es del catálogo:
 * etiqueta Y código, como el 400 del DTO de aeronave.
 */
export function mensajeTipoCombustibleFilaInvalido(valor: string): string {
  return `Tipo de combustible '${valor}' inválido: escribe ${ETIQUETA.AVGAS} (AVGAS) o ${ETIQUETA.TURBOSINA} (TURBOSINA).`;
}

/** «el XB-PEV» (o «el avión» sin matrícula): sujeto de todos los textos. */
function elAvion(matricula: string | null | undefined): string {
  const m = matricula?.trim();
  return m ? `el ${m}` : 'el avión';
}

/** «Gasavión» / «Turbosina»; «—» si no se sabe. */
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
 *  - distinto ⇒ el del avión + nota «⚠ … — revisar» (`corregido`), con
 *    ETIQUETAS: «⚠ se capturó Turbosina pero el XB-PEV carga Gasavión: se
 *    corrigió a Gasavión — revisar».
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
      ? `el gasto traía ${ETIQUETA[capturado]}`
      : `se capturó ${ETIQUETA[capturado]}`;
  const final = ETIQUETA[delAvion];
  return {
    ...base,
    tipo: delAvion,
    nota: `⚠ ${origen} pero ${avion} carga ${final}: se corrigió a ${final} — revisar`,
    corregido: true,
    rellenado: false,
  };
}

/**
 * Renglón «⚠ … — revisar» que deja `resolverTipoCombustible` (forma EXACTA:
 * es la clave para leerlo y retirarlo). Grupo 3 = lo que va tras «el »: la
 * matrícula o «avión» cuando no la había. Los combustibles (grupos 2, 4 y
 * 5) se validan con `combustibleDeNota`: la ETIQUETA vigente («Gasavión» /
 * «Turbosina») o, por tolerancia, el código crudo de la primera forma
 * («… carga AVGAS: se corrigió a AVGAS …»).
 */
const NOTA_COMBUSTIBLE_RE =
  /^⚠ (se capturó|el gasto traía) (\S+) pero el (.+?) carga (\S+): se corrigió a (\S+) — revisar$/;

/** Combustible escrito en una nota ⚠ (etiqueta o código exacto) o null. */
function combustibleDeNota(texto: string): CombustibleAeronave | null {
  for (const c of COMBUSTIBLES) {
    if (texto === c || texto === ETIQUETA[c]) return c;
  }
  return null;
}

/** Una nota de combustible leída de `gasto.notas`. */
export interface NotaCombustible {
  /** `captura` = «se capturó …»; `cambio_avion` = «el gasto traía …». */
  motivo: 'captura' | 'cambio_avion';
  /** Valor ANTES de la corrección (lo que se capturó / traía el gasto). */
  capturado: CombustibleAeronave;
  /** Matrícula del avión de la nota; null si decía «el avión». */
  matricula: string | null;
  /** Valor al que se corrigió (el combustible de ese avión). */
  corregidoA: CombustibleAeronave;
}

/** Lee UN renglón; null si no es una nota de combustible. */
export function leerNotaCombustible(
  linea: string | null | undefined,
): NotaCombustible | null {
  const m = NOTA_COMBUSTIBLE_RE.exec((linea ?? '').trim());
  if (!m) return null;
  const capturado = combustibleDeNota(m[2]);
  const delAvion = combustibleDeNota(m[4]);
  const corregidoA = combustibleDeNota(m[5]);
  if (!capturado || !delAvion || !corregidoA) return null;
  return {
    motivo: m[1] === 'se capturó' ? 'captura' : 'cambio_avion',
    capturado,
    matricula: m[3] === 'avión' ? null : m[3],
    corregidoA,
  };
}

/** Todas las notas de combustible de `notas`, en orden (la más vieja primero). */
export function notasCombustible(
  notas: string | null | undefined,
): NotaCombustible[] {
  if (!notas) return [];
  return notas
    .split('\n')
    .map((l) => leerNotaCombustible(l))
    .filter((n): n is NotaCombustible => n !== null);
}

/**
 * Notas sin ningún renglón de corrección de combustible (null si no queda
 * nada). Espejo de `quitarAvisoAvionTramo`: al mover la carga a OTRO avión la
 * nota vieja deja de ser cierta y se retira antes de re-evaluar.
 */
export function quitarNotaCombustible(
  notas: string | null | undefined,
): string | null {
  if (!notas) return null;
  const limpias = notas
    .split('\n')
    .filter((l) => leerNotaCombustible(l) === null)
    .join('\n')
    .replace(/\n+$/, '');
  return limpias.trim() ? limpias : null;
}

/** Matrícula comparable (sin guiones/espacios, mayúsculas). */
function matriculaComparable(m: string | null | undefined): string {
  return (m ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ¿Dos notas de combustible dicen lo mismo? (sin importar si una está en la
 * forma vieja con códigos y la otra con etiquetas).
 */
function mismaNotaCombustible(a: NotaCombustible, b: NotaCombustible) {
  return (
    a.motivo === b.motivo &&
    a.capturado === b.capturado &&
    a.corregidoA === b.corregidoA &&
    matriculaComparable(a.matricula) === matriculaComparable(b.matricula)
  );
}

/**
 * Agrega la nota ⚠ de combustible SIN duplicarla: ni como renglón idéntico
 * (`anexarLineaUnica`) ni como la MISMA nota escrita en la forma vieja con
 * códigos («… carga AVGAS: se corrigió a AVGAS …»).
 */
function anexarNotaCombustible(
  notas: string | null | undefined,
  nota: string,
): string {
  const nueva = leerNotaCombustible(nota);
  if (
    nueva &&
    notas &&
    notasCombustible(notas).some((n) => mismaNotaCombustible(n, nueva))
  ) {
    return notas;
  }
  return anexarLineaUnica(notas, nota);
}

/**
 * Renglón que arma la app al capturar una carga: «Combustible TURBOSINA · 74
 * L · …» (código crudo al INICIO del renglón). El balance Excel por avión
 * toma el detalle de la hoja «combustible» de `gasto.notas`, no de
 * `tipo_combustible`: si la regla corrige el tipo y el renglón no, el Excel
 * sigue diciendo «Combustible TURBOSINA» en el XB-PEV (síntoma del #280).
 */
const LINEA_COMBUSTIBLE_RE = /^Combustible (AVGAS|TURBOSINA)\b/;

/**
 * Reescribe el código del PRIMER renglón que empieza con «Combustible AVGAS»
 * o «Combustible TURBOSINA» con `codigoFinal` (el combustible que quedó en
 * el gasto). Una sola reescritura; no toca otros renglones ni un
 * «Combustible …» a media línea. Sin ese renglón, si ya coincide o si
 * `codigoFinal` no es del catálogo ⇒ `notas` intactas (misma referencia).
 */
export function reescribirLineaCombustible<T extends string | null | undefined>(
  notas: T,
  codigoFinal: unknown,
): T {
  const codigo = normalizarCombustible(codigoFinal);
  if (!notas || !codigo) return notas;
  const renglones = notas.split('\n');
  const i = renglones.findIndex((r) => LINEA_COMBUSTIBLE_RE.test(r));
  if (i < 0) return notas;
  const reescrito = renglones[i].replace(
    LINEA_COMBUSTIBLE_RE,
    `Combustible ${codigo}`,
  );
  if (reescrito === renglones[i]) return notas;
  renglones[i] = reescrito;
  return renglones.join('\n') as T;
}

export interface EntradaCombustiblePatch {
  /** Notas sobre las que se trabaja (las del PATCH o las vigentes). */
  notas: string | null | undefined;
  /** `gasto.tipo_combustible` GUARDADO antes del PATCH. */
  guardado: unknown;
  /** `tipo_combustible` del PATCH; `undefined` = el PATCH no lo trae. */
  enviado?: unknown;
  /** Combustible del avión VIGENTE tras el merge. */
  delAvion: unknown;
  /** Matrícula del avión vigente. */
  matricula: string | null | undefined;
}

export interface ResultadoCombustiblePatch {
  /** Valor que debe quedar en `gasto.tipo_combustible`. */
  tipo: CombustibleAeronave;
  /** Notas resultantes (null = vacías). Iguales a la entrada si no cambian. */
  notas: string | null;
  /** true = marcar `requiere_visto_bueno` (corrección NUEVA). */
  marcarVistoBueno: boolean;
  /** Resultado de la regla única (para quien lo necesite). */
  resultado: ResultadoTipoCombustible;
}

/**
 * Regla del PATCH de una carga GAS (invariante 43), PURA:
 *  - Reenviar el MISMO tipo que ya tenía el gasto no es «capturar» (el
 *    formulario completo del panel lo manda siempre): cuenta como lo que el
 *    gasto traía.
 *  - Si las notas traen una corrección de combustible de OTRO avión (la
 *    carga se movió de avión), esa nota ya no es cierta: se RETIRAN todas y
 *    se re-evalúa con el valor de ANTES de la primera corrección (lo que el
 *    piloto capturó). Caso #280 al revés: el piloto capturó bien TURBOSINA
 *    pero el gasto quedó en el XB-PEV (⇒ AVGAS + nota); la oficina lo mueve
 *    al N621TX ⇒ vuelve a TURBOSINA, sin nota y sin pedir otro visto bueno.
 *  - El visto bueno se marca solo si la corrección es NUEVA: cambia el valor
 *    guardado o el PATCH mandó otro tipo. Mover la carga entre dos aviones
 *    del mismo combustible solo reescribe la nota con el avión nuevo.
 *  - Cuando la regla corrige, cuando el tipo final es distinto al GUARDADO
 *    (relleno de un vacío o la oficina eligió a mano el del avión) o cuando
 *    se retiró la nota vieja por cambio de avión, el renglón «Combustible
 *    AVGAS|TURBOSINA …» de la app queda con el tipo FINAL
 *    (`reescribirLineaCombustible`) ANTES de anexar la nota ⚠. Si el tipo no
 *    cambia, el renglón no se toca.
 * Devuelve null si no hay contra qué comparar (avión sin dato).
 */
export function ajustarCombustiblePatch(
  entrada: EntradaCombustiblePatch,
): ResultadoCombustiblePatch | null {
  const delAvion = normalizarCombustible(entrada.delAvion);
  if (!delAvion) return null;
  const guardado = normalizarCombustible(entrada.guardado);
  const tocaTipo =
    entrada.enviado !== undefined &&
    normalizarCombustible(entrada.enviado) !== guardado;
  const notasBase = entrada.notas ?? null;
  const previas = notasCombustible(notasBase);
  const actual = matriculaComparable(entrada.matricula);
  const cambioDeAvion = previas.some(
    (n) => matriculaComparable(n.matricula) !== actual,
  );
  const base = cambioDeAvion ? quitarNotaCombustible(notasBase) : notasBase;
  let capturado: unknown = guardado;
  let motivo: 'captura' | 'cambio_avion' = 'cambio_avion';
  if (tocaTipo) {
    capturado = entrada.enviado;
    motivo = 'captura';
  } else if (cambioDeAvion) {
    capturado = previas[0].capturado;
    motivo = previas[0].motivo;
  }
  const resultado = resolverTipoCombustible({
    capturado,
    delAvion,
    matricula: entrada.matricula ?? null,
    motivo,
  });
  const tipo = resultado.tipo ?? delAvion;
  // El renglón de la app sigue al tipo FINAL siempre que ese tipo cambia
  // respecto al GUARDADO (la regla corrige, rellena un vacío o la oficina
  // eligió a mano el del avión) o se retiró la nota vieja por cambio de
  // avión. Sin `tipo !== guardado`, elegir «Gasavión» en el XB-PEV sobre una
  // carga guardada como TURBOSINA dejaba «Combustible TURBOSINA · 74 L …»
  // en un gasto AVGAS (el síntoma del #280). Si el tipo no cambia, el
  // renglón no se toca.
  const conLinea =
    resultado.corregido || cambioDeAvion || tipo !== guardado
      ? reescribirLineaCombustible(base, tipo)
      : base;
  const notas =
    resultado.corregido && resultado.nota
      ? anexarNotaCombustible(conLinea, resultado.nota)
      : conLinea;
  return {
    tipo,
    notas: notas ?? null,
    marcarVistoBueno: resultado.corregido && (tocaTipo || tipo !== guardado),
    resultado,
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
 * alta corrigió el combustible. El título ya dice «Carga de combustible
 * corregida»: el cuerpo NO lo repite (en la app y el panel se leía doble).
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
      `Se capturó ${etiquetaCombustible(resultado.capturado)} ` +
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
