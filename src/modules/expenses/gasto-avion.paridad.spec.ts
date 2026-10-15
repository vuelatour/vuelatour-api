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
 * pruebas y no en el Excel de la oficina.
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
 * Carga un módulo TS del panel: lo transpila a CommonJS y lo corre con un
 * `require` que solo resuelve módulos del panel (`@/…` y relativos). Un
 * import de paquete truena con su nombre: si el helper empieza a necesitar
 * uno, se decide aquí, no se carga a ciegas.
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
      throw new Error(
        `«${archivo}» importa «${esp}»: la paridad solo carga módulos del panel`,
      );
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
      const plano = readFileSync(TABLA, 'utf8').replace(/\s+/g, '');
      const faltan = [
        'estadoAvionGasto(g)',
        '{ETIQUETA_REPARTIDO}',
        '{p.matricula??MATRICULA_DESCONOCIDA}',
        '{e.remanente>0.004&&(',
        '{ETIQUETA_AVION_VUELATOUR}',
        '{e.etiqueta}',
        '{e.referencia&&(',
        '{textoReferenciaAvion(e.referencia)}',
        '{e.matricula??TEXTO_VER_AVION}',
        '{ETIQUETA_FALTA_AVION}',
      ].filter((pieza) => !plano.includes(pieza));
      expect(faltan).toEqual([]);
    });
  },
);
