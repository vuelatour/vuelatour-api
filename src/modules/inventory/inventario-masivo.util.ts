import type { FilaInventarioCruda } from '../pyservices/pyservices.service';
import { normalizarCodigo } from './inventario-codigo.util';

/**
 * Alta masiva de inventario: validación de negocio PURA (sin BD) de las filas
 * crudas que pyservices lee del Excel. Recibe los catálogos ya cargados y
 * devuelve, fila por fila, el estado + mensajes en español + lo que se
 * crearía (ítem, empaque, ENTRADA inicial). Funciones puras = testeables.
 */

export const UNIDADES_SUGERIDAS = [
  'pieza',
  'botella',
  'cuarto',
  'litro',
  'galón',
  'caja',
  'juego',
  'kit',
  'bote',
  'bolsa',
  'lata',
  'metro',
];
export const MONEDAS_INVENTARIO = ['MXN', 'USD'] as const;
export const UBICACION_DEFAULT = 'Bodega Cancún';

export interface ItemExistenteRef {
  id: string;
  nombre: string;
  numero_parte: string | null;
  codigo: string | null;
  activo: boolean;
}
export interface EmpaqueExistenteRef {
  codigo: string;
  item_nombre: string;
}
export interface CatalogoImportInventario {
  /** Categorías ya usadas en bodega (con su capitalización real). */
  categorias: string[];
  items: ItemExistenteRef[];
  /** Empaques con código de barras (para no chocar códigos). */
  empaques: EmpaqueExistenteRef[];
}

export type EstadoFilaImport = 'OK' | 'ERROR' | 'DUPLICADO';

export interface ItemACrear {
  nombre: string;
  marca?: string;
  numero_parte?: string;
  codigo?: string;
  categoria: string;
  unidad?: string;
  descripcion?: string;
  ubicacion: string;
  stock_minimo?: number;
  notas?: string;
}
export interface EmpaqueACrear {
  nombre: string;
  factor: number;
  codigo: string | null;
}
export interface EntradaInicialACrear {
  cantidad: number;
  moneda: 'MXN' | 'USD';
  costo_unitario_mxn?: number;
  costo_unitario_usd?: number;
  tc_usd_mxn?: number;
}

export interface FilaImportInventario {
  fila: number;
  estado: EstadoFilaImport;
  nombre: string;
  codigo: string | null;
  mensajes: string[];
  crear: {
    item: ItemACrear;
    empaque?: EmpaqueACrear;
    entrada_inicial?: EntradaInicialACrear;
  };
  /** id del ítem creado (solo tras confirmar). */
  item_id?: string;
}

type CampoFila =
  | 'nombre'
  | 'marca'
  | 'categoria'
  | 'numero_parte'
  | 'codigo'
  | 'unidad'
  | 'descripcion'
  | 'ubicacion'
  | 'stock_minimo'
  | 'existencia_inicial'
  | 'costo_unitario'
  | 'moneda'
  | 'tipo_cambio'
  | 'empaque_nombre'
  | 'empaque_factor'
  | 'empaque_codigo'
  | 'notas';

/**
 * Alias tolerados por columna (clave normalizada: minúsculas, sin acentos,
 * no-alfanumérico → "_"). El primero es el nombre canónico que manda
 * pyservices; el resto cubre encabezados de la plantilla tal cual y
 * variantes razonables si alguien arma el archivo a mano.
 */
const ALIAS: Record<CampoFila, string[]> = {
  nombre: ['nombre', 'producto', 'item', 'articulo'],
  marca: ['marca', 'fabricante'],
  categoria: ['categoria'],
  numero_parte: [
    'numero_parte',
    'numero_de_parte',
    'no_parte',
    'no_de_parte',
    'part_number',
    'pn',
  ],
  codigo: [
    'codigo',
    'codigo_barras',
    'codigo_de_barras',
    'codigo_de_barras_unidad',
    'codigo_barras_unidad',
    'sku',
    'upc',
    'ean',
  ],
  unidad: ['unidad', 'unidad_medida', 'unidad_de_medida'],
  descripcion: ['descripcion'],
  ubicacion: ['ubicacion', 'bodega'],
  stock_minimo: ['stock_minimo', 'minimo', 'stock_min'],
  existencia_inicial: [
    'existencia_inicial',
    'existencia',
    'stock_inicial',
    'cantidad',
    'stock',
  ],
  costo_unitario: ['costo_unitario', 'costo', 'precio_unitario', 'costo_unit'],
  moneda: ['moneda'],
  tipo_cambio: ['tipo_cambio', 'tipo_de_cambio', 'tc', 'tc_usd_mxn'],
  empaque_nombre: [
    'empaque_nombre',
    'empaque',
    'nombre_empaque',
    'empaque_nombre_',
  ],
  empaque_factor: [
    'empaque_factor',
    'unidades_por_empaque',
    'factor',
    'factor_empaque',
    'piezas_por_empaque',
  ],
  empaque_codigo: [
    'empaque_codigo',
    'codigo_empaque',
    'codigo_barras_empaque',
    'codigo_de_barras_del_empaque',
    'codigo_del_empaque',
  ],
  notas: ['notas', 'nota', 'observaciones', 'comentarios'],
};

/** Clave de columna normalizada: "Código de barras (unidad)" → "codigo_de_barras_unidad". */
export function normalizarClave(k: string): string {
  return sinAcentos(k)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Texto comparable: sin acentos, minúsculas, espacios colapsados. */
export function normTexto(s: string | null | undefined): string {
  return sinAcentos(String(s ?? ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

type ValorCrudo = FilaInventarioCruda[string];

function leerCampos(raw: FilaInventarioCruda): Map<string, ValorCrudo> {
  const m = new Map<string, ValorCrudo>();
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'fila') continue;
    const nk = normalizarClave(k);
    if (!m.has(nk)) m.set(nk, v);
  }
  return m;
}

function campo(m: Map<string, ValorCrudo>, nombre: CampoFila): ValorCrudo {
  for (const alias of ALIAS[nombre]) {
    const v = m.get(alias);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function texto(v: ValorCrudo): string | null {
  if (v == null || typeof v === 'boolean') return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** null = vacío; NaN = no se pudo leer como número. */
function numero(v: ValorCrudo): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return NaN;
  const s = String(v).trim().replace(/[$\s]/g, '').replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Llave de idempotencia sin código: nombre + número de parte (normalizados). */
export function claveItem(
  nombre: string | null | undefined,
  numeroParte: string | null | undefined,
): string {
  return `${normTexto(nombre)}|${normTexto(numeroParte)}`;
}

const RE_UNIDAD_NUMERICA = /^\s*[\d.,]+\s*$/;

/**
 * Valida TODAS las filas (en orden: los duplicados dentro del archivo se
 * reportan contra la primera fila que trajo el código/nombre).
 */
export function validarFilasInventario(
  crudas: FilaInventarioCruda[],
  catalogo: CatalogoImportInventario,
): FilaImportInventario[] {
  // Códigos ya ocupados en bodega → dueño legible.
  const codigosDb = new Map<string, string>();
  for (const it of catalogo.items) {
    const c = normalizarCodigo(it.codigo);
    if (c && !codigosDb.has(c)) {
      codigosDb.set(
        c,
        `el producto "${it.nombre}"${it.activo ? '' : ' (inactivo)'}`,
      );
    }
  }
  for (const e of catalogo.empaques) {
    const c = normalizarCodigo(e.codigo);
    if (c && !codigosDb.has(c))
      codigosDb.set(c, `un empaque de "${e.item_nombre}"`);
  }
  const clavesDb = new Map<string, ItemExistenteRef>();
  for (const it of catalogo.items) {
    const k = claveItem(it.nombre, it.numero_parte);
    if (!clavesDb.has(k)) clavesDb.set(k, it);
  }
  const categoriasIdx = new Map<string, string>();
  for (const c of catalogo.categorias) {
    const k = normTexto(c);
    if (k && !categoriasIdx.has(k)) categoriasIdx.set(k, c.trim());
  }

  const codigosArchivo = new Map<string, number>();
  const clavesArchivo = new Map<string, number>();

  return crudas.map((raw) => {
    const r = validarFila(raw, {
      codigosDb,
      clavesDb,
      categoriasIdx,
      codigosArchivo,
      clavesArchivo,
    });
    if (r.estado === 'OK') {
      if (r.crear.item.codigo) codigosArchivo.set(r.crear.item.codigo, r.fila);
      if (r.crear.empaque?.codigo)
        codigosArchivo.set(r.crear.empaque.codigo, r.fila);
      clavesArchivo.set(
        claveItem(r.crear.item.nombre, r.crear.item.numero_parte),
        r.fila,
      );
    }
    return r;
  });
}

interface CtxValidacion {
  codigosDb: Map<string, string>;
  clavesDb: Map<string, ItemExistenteRef>;
  categoriasIdx: Map<string, string>;
  codigosArchivo: Map<string, number>;
  clavesArchivo: Map<string, number>;
}

function validarFila(
  raw: FilaInventarioCruda,
  ctx: CtxValidacion,
): FilaImportInventario {
  const m = leerCampos(raw);
  const errores: string[] = [];
  const duplicados: string[] = [];
  const avisos: string[] = [];
  const fila = Number(raw.fila) || 0;

  // --- Ítem ---
  const nombre = texto(campo(m, 'nombre')) ?? '';
  if (!nombre) errores.push('Falta el nombre del producto.');
  else if (nombre.length > 200)
    errores.push('El nombre excede 200 caracteres.');

  const categoriaCruda = texto(campo(m, 'categoria'));
  let categoria = '';
  if (!categoriaCruda) {
    errores.push('Falta la categoría (aceites, filtros, llantas…).');
  } else if (categoriaCruda.length > 50) {
    errores.push('La categoría excede 50 caracteres.');
  } else {
    const existente = ctx.categoriasIdx.get(normTexto(categoriaCruda));
    categoria = existente ?? categoriaCruda;
    if (!existente)
      avisos.push(`Categoría nueva "${categoria}": se creará con este ítem.`);
  }

  const marca = texto(campo(m, 'marca')) ?? undefined;
  if (marca && marca.length > 80)
    errores.push('La marca excede 80 caracteres.');

  const numeroParte = texto(campo(m, 'numero_parte')) ?? undefined;
  if (numeroParte && numeroParte.length > 50)
    errores.push('El número de parte excede 50 caracteres.');

  const codigoCrudo = campo(m, 'codigo');
  const codigo = normalizarCodigo(codigoCrudo) ?? undefined;
  if (codigo && codigo.length > 60)
    errores.push('El código de barras excede 60 caracteres.');
  if (typeof codigoCrudo === 'number' && codigo) {
    avisos.push(
      `El código de barras se leyó como número (${codigo}): si empieza con cero, pon la celda en formato TEXTO o corrígelo al terminar.`,
    );
  }

  const unidad = texto(campo(m, 'unidad')) ?? undefined;
  if (unidad) {
    if (RE_UNIDAD_NUMERICA.test(unidad)) {
      errores.push(
        `La unidad "${unidad}" no puede ser un número: describe cómo se cuenta (pieza, botella, litro). La cantidad va en "Existencia inicial".`,
      );
    } else if (unidad.length > 30)
      errores.push('La unidad excede 30 caracteres.');
  }

  const descripcion = texto(campo(m, 'descripcion')) ?? undefined;
  const ubicacionCruda = texto(campo(m, 'ubicacion'));
  const ubicacion = ubicacionCruda ?? UBICACION_DEFAULT;
  if (ubicacion.length > 50) errores.push('La ubicación excede 50 caracteres.');
  const notas = texto(campo(m, 'notas')) ?? undefined;

  let stockMinimo: number | undefined;
  const stockMinCrudo = numero(campo(m, 'stock_minimo'));
  if (stockMinCrudo != null) {
    if (Number.isNaN(stockMinCrudo) || stockMinCrudo < 0)
      errores.push('El stock mínimo debe ser un número mayor o igual a 0.');
    else stockMinimo = round(stockMinCrudo, 2);
  }

  // --- Existencia inicial (ENTRADA) ---
  let entrada: EntradaInicialACrear | undefined;
  const existencia = numero(campo(m, 'existencia_inicial'));
  const costo = numero(campo(m, 'costo_unitario'));
  const monedaCruda = texto(campo(m, 'moneda'));
  const tc = numero(campo(m, 'tipo_cambio'));
  if (existencia != null && (Number.isNaN(existencia) || existencia < 0)) {
    errores.push('La existencia inicial debe ser un número mayor o igual a 0.');
  } else if (existencia != null && existencia > 0) {
    let moneda: 'MXN' | 'USD' = 'MXN';
    if (monedaCruda) {
      const mon = monedaCruda.toUpperCase();
      if (mon === 'MXN' || mon === 'USD') moneda = mon;
      else errores.push(`Moneda "${monedaCruda}" inválida (MXN o USD).`);
    }
    if (costo == null || Number.isNaN(costo) || costo < 0) {
      errores.push(
        'La existencia inicial necesita su costo unitario (en la moneda indicada) para valorizar la ENTRADA.',
      );
    } else {
      if (costo === 0)
        avisos.push(
          'Costo unitario 0: las salidas de este ítem no generarán gasto de bodega.',
        );
      if (moneda === 'MXN') {
        if (tc == null || Number.isNaN(tc) || tc <= 0) {
          errores.push(
            'Existencia en MXN: falta el tipo de cambio (pesos por dólar) de la compra, igual que en una ENTRADA manual.',
          );
        } else {
          entrada = {
            cantidad: round(existencia, 2),
            moneda,
            costo_unitario_mxn: round(costo, 4),
            tc_usd_mxn: round(tc, 4),
          };
        }
      } else {
        if (tc != null && (Number.isNaN(tc) || tc <= 0))
          errores.push('El tipo de cambio debe ser mayor a 0.');
        entrada = {
          cantidad: round(existencia, 2),
          moneda,
          costo_unitario_usd: round(costo, 4),
          ...(tc != null && !Number.isNaN(tc) && tc > 0
            ? { tc_usd_mxn: round(tc, 4) }
            : {}),
        };
      }
    }
  } else if (costo != null && !Number.isNaN(costo) && costo > 0) {
    avisos.push(
      'Sin existencia inicial: el costo unitario se ignora (el stock sale del cardex; captura una ENTRADA después).',
    );
  }

  // --- Empaque (caja) ---
  let empaque: EmpaqueACrear | undefined;
  const empNombreCrudo = texto(campo(m, 'empaque_nombre'));
  const empFactor = numero(campo(m, 'empaque_factor'));
  const empCodigoCrudo = campo(m, 'empaque_codigo');
  const empCodigo = normalizarCodigo(empCodigoCrudo);
  if (empNombreCrudo || empFactor != null || empCodigo) {
    if (empFactor == null || Number.isNaN(empFactor) || empFactor <= 0) {
      errores.push(
        `Empaque${empNombreCrudo ? ` "${empNombreCrudo}"` : ''}: faltan las unidades por empaque (número mayor a 0, ej. 6 para una caja de 6).`,
      );
    } else {
      const factor = round(empFactor, 4);
      const empNombre = empNombreCrudo ?? `Caja de ${factor}`;
      if (empNombre.length > 60)
        errores.push('El nombre del empaque excede 60 caracteres.');
      if (empCodigo && empCodigo.length > 60)
        errores.push('El código del empaque excede 60 caracteres.');
      if (empCodigo && codigo && empCodigo === codigo) {
        errores.push(
          `El código del empaque (${empCodigo}) es el mismo que el de la unidad: la caja debe tener su propio código de barras.`,
        );
      }
      if (typeof empCodigoCrudo === 'number' && empCodigo) {
        avisos.push(
          `El código del empaque se leyó como número (${empCodigo}): si empieza con cero, pon la celda en formato TEXTO.`,
        );
      }
      empaque = { nombre: empNombre, factor, codigo: empCodigo };
    }
  }

  // --- Duplicados (idempotencia): código o nombre+parte ya existentes ---
  if (codigo) {
    const dueno = ctx.codigosDb.get(codigo);
    const filaPrev = ctx.codigosArchivo.get(codigo);
    if (dueno)
      duplicados.push(`El código ${codigo} ya está registrado en ${dueno}.`);
    else if (filaPrev != null)
      duplicados.push(`El código ${codigo} ya viene en la fila ${filaPrev}.`);
  }
  if (empaque?.codigo) {
    const dueno = ctx.codigosDb.get(empaque.codigo);
    const filaPrev = ctx.codigosArchivo.get(empaque.codigo);
    if (dueno)
      duplicados.push(
        `El código del empaque ${empaque.codigo} ya está registrado en ${dueno}.`,
      );
    else if (filaPrev != null)
      duplicados.push(
        `El código del empaque ${empaque.codigo} ya viene en la fila ${filaPrev}.`,
      );
  }
  if (nombre) {
    const k = claveItem(nombre, numeroParte);
    const ex = ctx.clavesDb.get(k);
    const filaPrev = ctx.clavesArchivo.get(k);
    if (ex) {
      duplicados.push(
        `Ya existe el producto "${ex.nombre}"${ex.numero_parte ? ` (No. parte ${ex.numero_parte})` : ''}${ex.activo ? '' : ' — está inactivo'}.`,
      );
    } else if (filaPrev != null) {
      duplicados.push(
        `Mismo nombre y número de parte que la fila ${filaPrev}.`,
      );
    }
  }

  const estado: EstadoFilaImport =
    duplicados.length > 0 ? 'DUPLICADO' : errores.length > 0 ? 'ERROR' : 'OK';

  const item: ItemACrear = {
    nombre,
    categoria,
    ubicacion,
    ...(marca ? { marca } : {}),
    ...(numeroParte ? { numero_parte: numeroParte } : {}),
    ...(codigo ? { codigo } : {}),
    ...(unidad ? { unidad } : {}),
    ...(descripcion ? { descripcion } : {}),
    ...(stockMinimo != null ? { stock_minimo: stockMinimo } : {}),
    ...(notas ? { notas } : {}),
  };

  return {
    fila,
    estado,
    nombre,
    codigo: codigo ?? null,
    mensajes: [...duplicados, ...errores, ...avisos],
    crear: {
      item,
      ...(empaque ? { empaque } : {}),
      ...(entrada ? { entrada_inicial: entrada } : {}),
    },
  };
}
