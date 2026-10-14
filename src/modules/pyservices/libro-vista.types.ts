/**
 * Libro de Excel como JSON para la VISTA EN PANTALLA del panel
 * (12-oct-2026). Contrato 1:1 con `libro_json.py` de pyservices (versión 1)
 * y con `types/libro-excel.ts` del panel. El API solo lo TRANSPORTA: no lee
 * ni recalcula una celda (los números son los del propio libro, que ya
 * llegan del API a pyservices).
 */

/** Estilo de celda (una entrada por combinación distinta; las celdas citan el índice). */
export interface LibroVistaEstilo {
  /** Relleno sólido «RRGGBB». */
  bg?: string;
  /** Color de la letra «RRGGBB». */
  co?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** Tamaño de letra en puntos (solo si no es el default 11). */
  sz?: number;
  /** Alineación horizontal: left | center | right | … (ausente = general). */
  ha?: string;
  /** Alineación vertical: top | center | … (ausente = bottom). */
  va?: string;
  /** Ajustar texto. */
  wr?: boolean;
  /** Sangría. */
  ind?: number;
  /** Bordes con línea: letras de «lrtb». */
  bd?: string;
  /** Formato de número de Excel (p. ej. `#,##0.00`). */
  nf?: string;
}

/**
 * Vínculo celda → gasto (13-oct-2026, invariante 72): solo transporte (el
 * API no lee celdas). `rol`: 'fila' = la celda es el MONTO de la fila de ese
 * gasto; 'suma' = la celda lo suma junto con otros; 'nota' = solo va en la
 * nota (TUA o extensión de horario); 'sin_tc' = USD sin T.C. que aún no suma.
 */
export interface LibroVistaVinculo {
  tipo: 'gasto';
  id: string;
  rol: 'fila' | 'suma' | 'nota' | 'sin_tc';
  monto_mxn?: number | null;
  gasto_mxn?: number | null;
  parte?: 'reparto' | 'remanente';
  /** Clave del vuelo de la fila (hoja maestra). */
  fila?: string;
  /** Encabezado de la columna, sin salto de línea. */
  columna?: string;
}

export interface LibroVistaCelda {
  r: number;
  c: number;
  /** Valor crudo: número, texto, booleano, fecha ISO o null. */
  v: number | string | boolean | null;
  /** Texto tal como lo mostraría Excel con su formato de número. */
  t: string;
  /** Fórmula visible («=…»), solo en celdas con fórmula viva. */
  f?: string;
  /** Índice en `estilos`. */
  s?: number;
  /** Nota (comentario) de la celda. */
  n?: string;
  /** Fase 2 (edición): registro del API al que pertenece la celda. */
  vinculo?: Record<string, unknown>;
  /** Gastos que componen la celda (invariante 72; solo con `vinculos_gasto`). */
  vinculos?: LibroVistaVinculo[];
}

export interface LibroVistaHoja {
  nombre: string;
  /** Color de la pestaña «RRGGBB» o null. */
  pestana: string | null;
  /** Si Excel pintaría las líneas de la cuadrícula. */
  cuadricula: boolean;
  /** Paneles congelados: filas y columnas fijas (null = ninguno). */
  inmovilizar: { filas: number; columnas: number } | null;
  max_fila: number;
  max_col: number;
  /** Solo columnas con ancho propio u ocultas (ancho en caracteres de Excel). */
  columnas: { c: number; ancho?: number; oculta?: boolean }[];
  /** Solo filas con alto propio u ocultas (alto en puntos). */
  filas: { r: number; alto?: number; oculta?: boolean }[];
  combinadas: { r1: number; c1: number; r2: number; c2: number }[];
  celdas: LibroVistaCelda[];
}

export interface LibroVista {
  version: number;
  titulo: string;
  /** Nombre con el que se descargaría el .xlsx (null si no aplica). */
  archivo: string | null;
  generado: string | null;
  ancho_columna_default: number;
  alto_fila_default: number;
  estilos: LibroVistaEstilo[];
  hojas: LibroVistaHoja[];
  /** true = este libro marca las celdas de los gastos (invariante 72). */
  vinculos_gasto?: boolean;
}
