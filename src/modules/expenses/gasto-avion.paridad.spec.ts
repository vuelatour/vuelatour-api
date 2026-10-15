import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runInThisContext } from 'vm';
import {
  CATEGORIA_PAGO_VENDEDOR,
  CATEGORIAS_GASTO_EMPRESA,
  CATEGORIAS_GASTO_SIN_AVION,
} from '../../common/categoria-gasto.util';
import { matrizAvionGasto, FILAS_REALES } from './gasto-avion.fixture-spec';
import {
  ETIQUETA_AVION_PERSONAL,
  ETIQUETA_AVION_VUELATOUR,
  ETIQUETA_FALTA_AVION,
  ETIQUETA_REPARTIDO,
  MATRICULA_DESCONOCIDA,
  TEXTO_AVION_SIN_MATRICULA,
  celdaAvionGasto,
  estadoAvionGasto,
  textoReferenciaAvion,
} from './gasto-avion.util';

/**
 * PARIDAD API ↔ PANEL de la columna «Avión» del Excel de gastos (15-oct-2026,
 * hallazgo #20 de la revisión del panel de Gastos): la celda del Excel dice
 * LO MISMO que la columna «Avión · vuelo» de la tabla.
 *
 * EJECUTA la fuente única del panel (`src/lib/admin/gasto-avion.ts#
 * estadoAvionGasto`, con sus `categorias-gasto.ts` y `format.ts`): la
 * transpila con el `typescript` de este repo y la corre sobre la MISMA
 * matriz que `gasto-avion.util.spec` (3,360 filas) y sobre las filas reales.
 * Además lee `expenses-table.tsx` como texto: cómo la tabla PINTA cada
 * estado es lo que aquí se aplana a una celda (`celdaDeLaTabla`).
 *
 * Busca el panel junto a este repo (`../vuelatour-next`, el workspace local)
 * o donde diga `VUELATOUR_NEXT_DIR` (un worktree fuera del workspace).
 * Sin repo hermano se SALTA (CI, Railway). Con el repo ahí (o la variable
 * puesta) es OBLIGATORIA: si el helper o la tabla se mudaron, o la ruta
 * está mal, truena en vez de saltarse.
 *
 * Si un lado cambia una regla o un texto sin el otro, esto truena en
 * pruebas y no en el Excel de la oficina. Revisión del 15-oct-2026: SOLO
 * por eso — renombrar una variable local de la tabla (las piezas son
 * patrones sin nombres de variables) o importar un paquete npm que la regla
 * no usa (se sustituye por un módulo que truena solo si se USA) ya no la
 * tumban. El acoplamiento lo documenta la invariante 71 del CLAUDE.md del
 * API (el AGENTS.md del panel debe citarlo en su lote).
 */
const DESDE_ENV = process.env.VUELATOUR_NEXT_DIR;
const RAIZ_PANEL = DESDE_ENV
  ? resolve(DESDE_ENV)
  : join(__dirname, '../../../../vuelatour-next');
const HELPER = join(RAIZ_PANEL, 'src/lib/admin/gasto-avion.ts');
const TABLA = join(
  RAIZ_PANEL,
  'src/components/admin/expenses/expenses-table.tsx',
);
const CORRER = !!DESDE_ENV || existsSync(join(RAIZ_PANEL, 'package.json'));

type Modulo = Record<string, unknown>;
type Requerir = (especificador: string) => Modulo;

/** Estado del panel (`EstadoAvionGasto` de `lib/admin/gasto-avion.ts`). */
type EstadoPanel =
  | {
      tipo: 'REPARTIDO';
      partes: Array<{ matricula: string | null }>;
      remanente: number;
    }
  | { tipo: 'FUERA_DEL_AVION'; etiqueta: string; referencia: string | null }
  | { tipo: 'AVION'; matricula: string | null }
  | { tipo: 'FALTA' };

interface HelperAvionPanel {
  estadoAvionGasto: (g: Modulo) => EstadoPanel;
  etiquetaAvionGasto: (e: EstadoPanel) => string;
  textoReferenciaAvion: (matricula: string) => string;
  ETIQUETA_FALTA_AVION: string;
  ETIQUETA_AVION_VUELATOUR: string;
  ETIQUETA_AVION_PERSONAL: string;
  ETIQUETA_REPARTIDO: string;
  MATRICULA_DESCONOCIDA: string;
}

interface CategoriasPanel {
  CATEGORIAS_EMPRESA: ReadonlySet<string>;
  CATEGORIAS_SIN_AVION: ReadonlySet<string>;
  CATEGORIA_PAGO_VENDEDOR: string;
}

/**
 * Un paquete npm que importa un módulo del panel (p. ej. `date-fns` en
 * `lib/format.ts`): la paridad NO lo carga (no corre código ajeno a las
 * reglas). En su lugar va un módulo que truena con su nombre SOLO cuando
 * algo lo USA: si una regla de la paridad empieza a necesitarlo, la prueba
 * truena y se decide aquí; un import que la regla no toca no la tumba.
 */
function paqueteNoCargado(archivo: string, esp: string): Modulo {
  const usar = (prop: string) => (): never => {
    throw new Error(
      `«${archivo}» usa «${esp}».${prop}: la paridad no carga paquetes npm; si la regla lo necesita, decídelo en gasto-avion.paridad.spec`,
    );
  };
  const destino: Modulo = {};
  return new Proxy(destino, {
    get(_destino, prop) {
      if (prop === '__esModule') return true;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return usar(prop);
    },
  });
}

/**
 * Carga un módulo TS del panel: lo transpila a CommonJS y lo corre con un
 * `require` que resuelve los módulos del panel (`@/…` y relativos); un
 * paquete npm se sustituye por `paqueteNoCargado` (truena solo al usarse).
 */
function cargadorPanel(raiz: string): (archivo: string) => Modulo {
  const ts = jest.requireActual<typeof import('typescript')>('typescript');
  const cache = new Map<string, { exports: Modulo }>();
  const resolverTs = (base: string): string => {
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(c)) return c;
    }
    throw new Error(`La paridad no encuentra «${base}» en el panel`);
  };
  const cargar = (archivo: string): Modulo => {
    const previo = cache.get(archivo);
    if (previo) return previo.exports;
    const { outputText } = ts.transpileModule(readFileSync(archivo, 'utf8'), {
      fileName: archivo,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const modulo = { exports: {} as Modulo };
    cache.set(archivo, modulo);
    const requerir: Requerir = (esp) => {
      if (esp.startsWith('@/')) {
        return cargar(resolverTs(join(raiz, 'src', esp.slice(2))));
      }
      if (esp.startsWith('.')) {
        return cargar(resolverTs(resolve(dirname(archivo), esp)));
      }
      return paqueteNoCargado(archivo, esp);
    };
    const envoltura = runInThisContext(
      `(function (require, module, exports) {${outputText}\n})`,
      { filename: archivo },
    ) as (r: Requerir, m: { exports: Modulo }, e: Modulo) => void;
    envoltura(requerir, modulo, modulo.exports);
    return modulo.exports;
  };
  return cargar;
}

/** Un identificador de JS (el nombre de una variable local de la tabla). */
const ID = '[A-Za-z_$][\\w$]*';

/**
 * Cómo PINTA la tabla cada estado (`expenses-table.tsx` sin espacios): la
 * regla (constantes, umbral 0.004, `??` y `&&`) y los textos, SIN los
 * nombres de las variables locales (revisión del 15-oct-2026: renombrar
 * `g` ⇒ `gasto` no cambia lo que se pinta).
 */
const PIEZAS_TABLA_AVION: ReadonlyArray<[string, RegExp]> = [
  ['estadoAvionGasto(…)', new RegExp(`estadoAvionGasto\\(${ID}\\)`)],
  ['{ETIQUETA_REPARTIDO}', /\{ETIQUETA_REPARTIDO\}/],
  [
    '{…matricula??MATRICULA_DESCONOCIDA}',
    new RegExp(`\\{${ID}\\.matricula\\?\\?MATRICULA_DESCONOCIDA\\}`),
  ],
  ['{…remanente>0.004&&(', new RegExp(`\\{${ID}\\.remanente>0\\.004&&\\(`)],
  ['{ETIQUETA_AVION_VUELATOUR}', /\{ETIQUETA_AVION_VUELATOUR\}/],
  ['{…etiqueta}', new RegExp(`\\{${ID}\\.etiqueta\\}`)],
  ['{…referencia&&(', new RegExp(`\\{${ID}\\.referencia&&\\(`)],
  [
    '{textoReferenciaAvion(…referencia)}',
    new RegExp(`\\{textoReferenciaAvion\\(${ID}\\.referencia\\)\\}`),
  ],
  [
    '{…matricula??TEXTO_VER_AVION}',
    new RegExp(`\\{${ID}\\.matricula\\?\\?TEXTO_VER_AVION\\}`),
  ],
  ['{ETIQUETA_FALTA_AVION}', /\{ETIQUETA_FALTA_AVION\}/],
];

/** Las piezas que NO están en el texto de la tabla (sin espacios). */
function piezasQueFaltan(tabla: string): string[] {
  const plano = tabla.replace(/\s+/g, '');
  return PIEZAS_TABLA_AVION.filter(([, re]) => !re.test(plano)).map(
    ([nombre]) => nombre,
  );
}

/**
 * La celda de la TABLA del panel aplanada a texto, rama por rama como la
 * pinta `expenses-table.tsx` (lo vigila el último caso de este archivo):
 * «Repartido:» + una insignia por parte («¿?» sin matrícula) + «VuelaTour»
 * si el remanente pasa de 0.004; la etiqueta con «ref. X» debajo; la
 * matrícula (en la tabla, el enlace «Ver avión» sin ella: en texto, la
 * etiqueta del panel `etiquetaAvionGasto`); «Falta avión».
 */
function celdaDeLaTabla(e: EstadoPanel, p: HelperAvionPanel): string {
  switch (e.tipo) {
    case 'REPARTIDO': {
      const fichas = e.partes.map(
        (x) => x.matricula ?? p.MATRICULA_DESCONOCIDA,
      );
      if (e.remanente > 0.004) fichas.push(p.ETIQUETA_AVION_VUELATOUR);
      return `${p.ETIQUETA_REPARTIDO} ${fichas.join(', ')}`;
    }
    case 'FUERA_DEL_AVION':
      return e.referencia
        ? `${e.etiqueta} (${p.textoReferenciaAvion(e.referencia)})`
        : e.etiqueta;
    case 'AVION':
      return p.etiquetaAvionGasto(e);
    case 'FALTA':
      return p.ETIQUETA_FALTA_AVION;
  }
}

(CORRER ? describe : describe.skip)(
  'PARIDAD con el panel: columna «Avión» del Excel = columna «Avión · vuelo» de la tabla',
  () => {
    let panel: HelperAvionPanel;
    let categorias: CategoriasPanel;

    beforeAll(() => {
      if (!existsSync(HELPER)) {
        throw new Error(
          `No está el helper del panel en «${HELPER}» (¿se mudó, o VUELATOUR_NEXT_DIR apunta mal?): ajusta esta paridad`,
        );
      }
      const cargar = cargadorPanel(RAIZ_PANEL);
      panel = cargar(HELPER) as unknown as HelperAvionPanel;
      categorias = cargar(
        join(RAIZ_PANEL, 'src/lib/admin/categorias-gasto.ts'),
      ) as unknown as CategoriasPanel;
    });

    it('el panel exporta lo que la paridad usa', () => {
      for (const fn of [
        'estadoAvionGasto',
        'etiquetaAvionGasto',
        'textoReferenciaAvion',
      ] as const) {
        expect([fn, typeof panel[fn]]).toEqual([fn, 'function']);
      }
      expect(categorias.CATEGORIAS_EMPRESA).toBeDefined();
      expect(categorias.CATEGORIAS_SIN_AVION).toBeDefined();
    });

    it('textos IDÉNTICOS', () => {
      expect(panel.ETIQUETA_FALTA_AVION).toBe(ETIQUETA_FALTA_AVION);
      expect(panel.ETIQUETA_AVION_VUELATOUR).toBe(ETIQUETA_AVION_VUELATOUR);
      expect(panel.ETIQUETA_AVION_PERSONAL).toBe(ETIQUETA_AVION_PERSONAL);
      expect(panel.ETIQUETA_REPARTIDO).toBe(ETIQUETA_REPARTIDO);
      expect(panel.MATRICULA_DESCONOCIDA).toBe(MATRICULA_DESCONOCIDA);
      expect(panel.textoReferenciaAvion('N4142R')).toBe(
        textoReferenciaAvion('N4142R'),
      );
      expect(panel.etiquetaAvionGasto({ tipo: 'AVION', matricula: null })).toBe(
        TEXTO_AVION_SIN_MATRICULA,
      );
    });

    it('mismas categorías de empresa, «sin avión» y pago al vendedor (VuelaTour)', () => {
      expect([...categorias.CATEGORIAS_EMPRESA].sort()).toEqual(
        [...CATEGORIAS_GASTO_EMPRESA].sort(),
      );
      expect([...categorias.CATEGORIAS_SIN_AVION].sort()).toEqual(
        [...CATEGORIAS_GASTO_SIN_AVION].sort(),
      );
      expect(categorias.CATEGORIA_PAGO_VENDEDOR).toBe(CATEGORIA_PAGO_VENDEDOR);
    });

    it('las filas REALES de prod dicen lo mismo en el Excel y en la tabla', () => {
      for (const c of FILAS_REALES) {
        const tabla = celdaDeLaTabla(panel.estadoAvionGasto(c.fila), panel);
        expect([c.nombre, tabla]).toEqual([c.nombre, c.celda]);
        expect([c.nombre, celdaAvionGasto(c.fila)]).toEqual([c.nombre, tabla]);
      }
    });

    it('la MISMA celda y la MISMA rama en las 3,360 filas de la matriz', () => {
      const filas = matrizAvionGasto();
      expect(filas).toHaveLength(3360);
      const distintas: string[] = [];
      for (const f of filas) {
        const e = panel.estadoAvionGasto(f);
        const api = estadoAvionGasto(f);
        const tabla = celdaDeLaTabla(e, panel);
        const excel = celdaAvionGasto(f);
        if (e.tipo !== api.tipo || tabla !== excel) {
          distintas.push(
            `${JSON.stringify(f)} ⇒ tabla ${e.tipo} «${tabla}» · Excel ${api.tipo} «${excel}»`,
          );
        }
      }
      expect(distintas.slice(0, 5)).toEqual([]);
    });

    it('la tabla PINTA cada estado como esta paridad lo aplana (`expenses-table.tsx`)', () => {
      if (!existsSync(TABLA)) {
        throw new Error(
          `La tabla de Gastos del panel ya no está en «${TABLA}»: revisa cómo pinta la columna «Avión · vuelo» y ajusta esta paridad`,
        );
      }
      expect(piezasQueFaltan(readFileSync(TABLA, 'utf8'))).toEqual([]);
    });
  },
);

describe('la paridad solo truena por reglas o textos (revisión del 15-oct-2026)', () => {
  // La celda «Avión · vuelo» como la escribe hoy la tabla y la MISMA con
  // otros nombres de variables (sin el panel: corre siempre).
  const HOY = `const e = estadoAvionGasto(g);
    {ETIQUETA_REPARTIDO} {e.partes.map((p) => <b>{p.matricula ?? MATRICULA_DESCONOCIDA}</b>)}
    {e.remanente > 0.004 && (<b>{ETIQUETA_AVION_VUELATOUR}</b>)}
    {e.etiqueta} {e.referencia && (<i>{textoReferenciaAvion(e.referencia)}</i>)}
    {e.matricula ?? TEXTO_VER_AVION} {ETIQUETA_FALTA_AVION}`;
  const RENOMBRADA = HOY.replace(/\bg\b/g, 'gasto')
    .replace(/\be\./g, 'estado.')
    .replace(/\(p\)/g, '(parte)')
    .replace(/\bp\./g, 'parte.');

  it('renombrar variables locales de la tabla NO la tumba', () => {
    expect(RENOMBRADA).toContain('estadoAvionGasto(gasto)');
    expect(piezasQueFaltan(HOY)).toEqual([]);
    expect(piezasQueFaltan(RENOMBRADA)).toEqual([]);
  });

  it('cambiar la REGLA o un texto sí: otro umbral, otro respaldo o un texto suelto', () => {
    expect(piezasQueFaltan(HOY.replace('0.004', '0.01'))).toEqual([
      '{…remanente>0.004&&(',
    ]);
    expect(
      piezasQueFaltan(HOY.replace('?? MATRICULA_DESCONOCIDA', '?? "—"')),
    ).toEqual(['{…matricula??MATRICULA_DESCONOCIDA}']);
    expect(
      piezasQueFaltan(HOY.replace('{ETIQUETA_FALTA_AVION}', 'Falta avión')),
    ).toEqual(['{ETIQUETA_FALTA_AVION}']);
  });

  it('un paquete npm que la regla no usa no tumba la carga; usarlo truena con su nombre', () => {
    const m = paqueteNoCargado('src/lib/format.ts', 'date-fns');
    expect(m.__esModule).toBe(true);
    const format = m.format as () => unknown;
    expect(typeof format).toBe('function');
    expect(() => format()).toThrow(
      '«src/lib/format.ts» usa «date-fns».format: la paridad no carga paquetes npm',
    );
  });
});
