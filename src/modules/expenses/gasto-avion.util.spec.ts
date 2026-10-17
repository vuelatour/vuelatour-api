import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CATEGORIA_GASTO_LABEL,
  CATEGORIAS_GASTO_SIN_AVION,
} from '../../common/categoria-gasto.util';
import {
  expandirConReparto,
  type GastoRepartoFila,
} from '../../common/gasto-reparto.util';
import {
  AV,
  FILAS_REALES,
  matrizAvionGasto,
  parte,
  type FilaGasto,
} from './gasto-avion.fixture-spec';
import {
  ETIQUETA_AVION_PERSONAL,
  ETIQUETA_AVION_VUELATOUR,
  ETIQUETA_FALTA_AVION,
  ETIQUETA_REPARTIDO,
  MATRICULA_DESCONOCIDA,
  TEXTO_AVION_SIN_MATRICULA,
  celdaAvionGasto,
  estadoAvionGasto,
  textoAvionGasto,
  textoReferenciaAvion,
} from './gasto-avion.util';

/**
 * Columna «Avión» del Excel de gastos = la columna «Avión · vuelo» de la
 * tabla del panel (15-oct-2026, hallazgo #20 de la revisión del panel de
 * Gastos). La paridad que EJECUTA el helper del panel vive en
 * `gasto-avion.paridad.spec.ts`; aquí, los casos y las propiedades.
 */
const gasto = (extra: FilaGasto = {}): FilaGasto => ({
  categoria: 'COMIDA',
  monto: 1000,
  aeronave_id: null,
  aeronave: null,
  vuelo_id: null,
  repartos: [],
  ...extra,
});
const conAvion = (matricula = 'N4142R'): FilaGasto => ({
  aeronave_id: AV.N4142R,
  aeronave: { matricula },
});

const CATEGORIAS = Object.keys(CATEGORIA_GASTO_LABEL);
/** La expresión que vivía dentro de `listXlsx` hasta el 0.0.77. */
const celdaVieja = (x: FilaGasto): string => {
  const aeronave = x.aeronave as { matricula?: string } | null;
  return Array.isArray(x.repartos) && x.repartos.length > 0
    ? `Repartido (${x.repartos.length})`
    : (aeronave?.matricula ?? '(pendiente)');
};
const EMPRESA_Y_COMISION = [
  'OTRO',
  'NOMINA',
  'GASOLINA',
  'FIJO',
  'VISITA',
  'COMISION_VENDEDOR',
];
const REPARTO_STARLINK = [
  parte(AV.N4142R, 1577.92, 'N4142R'),
  parte(AV.N621TX, 1577.92, 'N621TX'),
  parte(AV.N990GG, 1577.92, 'N990GG'),
];

describe('columna «Avión» — gastos REALES de prod (15-oct-2026)', () => {
  it.each(FILAS_REALES.map((c) => [c.nombre, c] as const))(
    '%s',
    (_nombre, c) => {
      expect(celdaAvionGasto(c.fila)).toBe(c.celda);
    },
  );

  it('cubren las 4 ramas de la tabla; el «antes» es lo que escribía la expresión vieja', () => {
    const tipos = new Set(
      FILAS_REALES.map((c) => estadoAvionGasto(c.fila).tipo),
    );
    expect([...tipos].sort()).toEqual([
      'AVION',
      'FALTA',
      'FUERA_DEL_AVION',
      'REPARTIDO',
    ]);
    for (const c of FILAS_REALES) {
      expect([c.nombre, celdaVieja(c.fila)]).toEqual([c.nombre, c.antes]);
    }
  });

  it('lo que ya decía la matrícula de su avión sigue igual (848 de 1,144 en prod)', () => {
    let iguales = 0;
    for (const f of matrizAvionGasto()) {
      const e = estadoAvionGasto(f);
      if (e.tipo !== 'AVION' || e.matricula == null) continue;
      expect(celdaAvionGasto(f)).toBe(celdaVieja(f));
      iguales += 1;
    }
    expect(iguales).toBeGreaterThan(0);
  });
});

describe('sin avión ni reparto: las 22 categorías', () => {
  it('empresa, comisión (VuelaTour) e INDIRECTO ⇒ «VuelaTour»; PERSONAL_DUENO ⇒ «Personal»; las 14 restantes ⇒ «Falta avión»', () => {
    expect(CATEGORIAS).toHaveLength(22);
    const falta: string[] = [];
    for (const categoria of CATEGORIAS) {
      const celda = celdaAvionGasto(gasto({ categoria }));
      if ([...EMPRESA_Y_COMISION, 'INDIRECTO'].includes(categoria)) {
        expect([categoria, celda]).toEqual([categoria, 'VuelaTour']);
      } else if (categoria === 'PERSONAL_DUENO') {
        expect(celda).toBe('Personal');
      } else {
        expect([categoria, celda]).toEqual([categoria, 'Falta avión']);
        falta.push(categoria);
      }
    }
    expect(falta).toHaveLength(14);
    // A propósito, como la bandeja del API: la «(avión)», los servicios del
    // avión, la refacción y el comisariato sin avión SÍ son pendientes.
    for (const c of [
      'COMISION_VENDEDOR_AVION',
      'SERVICIOS',
      'REFACCION',
      'COMISARIATO',
    ]) {
      expect(falta).toContain(c);
    }
  });

  it('el vuelo NO cambia la celda (la tabla lo pinta en otra línea)', () => {
    for (const categoria of CATEGORIAS) {
      expect(
        celdaAvionGasto(
          gasto({ categoria, vuelo_id: 'v-437', vuelo: { folio: 437 } }),
        ),
      ).toBe(celdaAvionGasto(gasto({ categoria })));
    }
  });
});

describe('con avión sellado', () => {
  it('empresa y comisión (VuelaTour) ⇒ «VuelaTour (ref. N4142R)»: la categoría manda, el avión es solo referencia', () => {
    for (const categoria of EMPRESA_Y_COMISION) {
      for (const vuelo of [null, 'v-1']) {
        expect([
          categoria,
          vuelo,
          celdaAvionGasto(gasto({ categoria, vuelo_id: vuelo, ...conAvion() })),
        ]).toEqual([categoria, vuelo, 'VuelaTour (ref. N4142R)']);
      }
    }
  });

  it('PERSONAL_DUENO con avión ⇒ «Personal (ref. N4142R)» (la tabla también pinta la referencia)', () => {
    expect(
      celdaAvionGasto(gasto({ categoria: 'PERSONAL_DUENO', ...conAvion() })),
    ).toBe('Personal (ref. N4142R)');
  });

  it('INDIRECTO con UN avión dice la matrícula (resta en su balance), NO «VuelaTour (ref.)»', () => {
    expect(
      celdaAvionGasto(gasto({ categoria: 'INDIRECTO', ...conAvion('XB-PEV') })),
    ).toBe('XB-PEV');
    expect(
      estadoAvionGasto(gasto({ categoria: 'INDIRECTO', ...conAvion() })),
    ).toEqual({ tipo: 'AVION', matricula: 'N4142R' });
  });

  it('las demás (también la «Comisión del vendedor (avión)») ⇒ la matrícula', () => {
    const resto = CATEGORIAS.filter(
      (c) => !EMPRESA_Y_COMISION.includes(c) && c !== 'PERSONAL_DUENO',
    );
    expect(resto).toHaveLength(15);
    expect(resto).toContain('COMISION_VENDEDOR_AVION');
    for (const categoria of resto) {
      expect([
        categoria,
        celdaAvionGasto(gasto({ categoria, ...conAvion('XA-VGV') })),
      ]).toEqual([categoria, 'XA-VGV']);
    }
  });

  it('sin la matrícula del join: «Avión asignado» (la tabla pinta el enlace «Ver avión»); la referencia se omite', () => {
    const sinJoin = { aeronave_id: AV.XB_PEV, aeronave: null };
    expect(
      celdaAvionGasto(gasto({ categoria: 'OPERACIONES', ...sinJoin })),
    ).toBe('Avión asignado');
    expect(celdaAvionGasto(gasto({ categoria: 'OTRO', ...sinJoin }))).toBe(
      'VuelaTour',
    );
    expect(
      celdaAvionGasto(
        gasto({
          categoria: 'OPERACIONES',
          aeronave_id: AV.N621TX,
          aeronave: { matricula: null },
        }),
      ),
    ).toBe('Avión asignado');
  });

  it('manda `aeronave_id`: un embed sin id no es avión; un id vacío tampoco', () => {
    const embedSinId = { aeronave_id: null, aeronave: { matricula: 'XA-VGV' } };
    expect(
      celdaAvionGasto(gasto({ categoria: 'OPERACIONES', ...embedSinId })),
    ).toBe('Falta avión');
    expect(celdaAvionGasto(gasto({ categoria: 'OTRO', ...embedSinId }))).toBe(
      'VuelaTour',
    );
    expect(
      celdaAvionGasto(gasto({ categoria: 'OPERACIONES', aeronave_id: '' })),
    ).toBe('Falta avión');
  });
});

describe('reparto: gana a todo', () => {
  it('STARLINK repartido gana al avión sellado y a la categoría', () => {
    for (const categoria of [
      'INDIRECTO',
      'OTRO',
      'PERSONAL_DUENO',
      'OPERACIONES',
    ]) {
      expect(
        celdaAvionGasto(
          gasto({
            categoria,
            monto: 4733.76,
            repartos: REPARTO_STARLINK,
            ...conAvion('N990GG'),
          }),
        ),
      ).toBe('Repartido: N4142R, N621TX, N990GG');
    }
  });

  it('con remanente agrega «VuelaTour» al final; sin remanente, no', () => {
    const repartido = (monto: number | string, partes: FilaGasto[]) =>
      celdaAvionGasto(gasto({ categoria: 'OTRO', monto, repartos: partes }));
    expect(
      repartido('1000.00', [
        parte(AV.N4142R, '300.00', 'N4142R'),
        parte(AV.N621TX, 300, 'N621TX'),
      ]),
    ).toBe('Repartido: N4142R, N621TX, VuelaTour');
    // Un centavo EXACTO (3 × 33.33 de $100), partes sin matrícula ⇒ «¿?».
    expect(
      repartido('100.00', [
        parte(AV.N4142R, '33.33', null),
        parte(AV.N621TX, '33.33', null),
        { aeronave_id: AV.N990GG, monto: '33.33' },
      ]),
    ).toBe('Repartido: ¿?, ¿?, ¿?, VuelaTour');
    expect(repartido(100, [parte(AV.XB_PEV, 99.99, 'XB-PEV')])).toBe(
      'Repartido: XB-PEV, VuelaTour',
    );
    // Completo (número o texto, da igual) y de más (ticket + propina): sin
    // remanente.
    expect(repartido('4733.76', REPARTO_STARLINK)).toBe(
      'Repartido: N4142R, N621TX, N990GG',
    );
    expect(repartido(1000, [parte(AV.XA_VGV, '1050.00', 'XA-VGV')])).toBe(
      'Repartido: XA-VGV',
    );
  });

  it('respeta el orden del embed (no ordena las matrículas)', () => {
    expect(
      celdaAvionGasto(
        gasto({
          categoria: 'OTRO',
          repartos: [
            parte(AV.XB_PEV, 500, 'XB-PEV'),
            parte(AV.N4142R, 500, 'N4142R'),
          ],
        }),
      ),
    ).toBe('Repartido: XB-PEV, N4142R');
  });

  it('«VuelaTour» del reparto ⇔ los libros le cargan remanente a la empresa (`expandirConReparto`)', () => {
    let conReparto = 0;
    for (const f of matrizAvionGasto()) {
      if (!Array.isArray(f.repartos) || f.repartos.length === 0) continue;
      conReparto += 1;
      const filas: GastoRepartoFila[] = (f.repartos as FilaGasto[]).map(
        (p) => ({
          gasto_id: 'g',
          aeronave_id: String(p.aeronave_id),
          monto: Number(p.monto),
        }),
      );
      const empresa = expandirConReparto(
        [{ id: 'g', monto: f.monto }],
        new Map([['g', filas]]),
      ).empresa;
      expect(celdaAvionGasto(f).endsWith(', VuelaTour')).toBe(
        empresa.length > 0,
      );
    }
    expect(conReparto).toBe(28 * 6 * 2 * 7);
  });
});

describe('«Falta avión» = la bandeja de pendientes del API', () => {
  it('sin reparto: «Falta avión» ⇔ `aeronave_id` null y categoría fuera de CATEGORIAS_GASTO_SIN_AVION', () => {
    let revisadas = 0;
    for (const f of matrizAvionGasto()) {
      const categoria = f.categoria as string;
      // Filas posibles en la BD: categoría del enum (NOT NULL) y avión null o uuid.
      if (!CATEGORIAS.includes(categoria) || f.aeronave_id === '') continue;
      const reparto = Array.isArray(f.repartos) && f.repartos.length > 0;
      const enBandeja =
        f.aeronave_id == null &&
        !CATEGORIAS_GASTO_SIN_AVION.includes(categoria);
      const celda = celdaAvionGasto(f);
      if (reparto) {
        expect(celda).not.toBe('Falta avión');
      } else {
        expect([categoria, f.aeronave_id, celda === 'Falta avión']).toEqual([
          categoria,
          f.aeronave_id,
          enBandeja,
        ]);
      }
      revisadas += 1;
    }
    expect(revisadas).toBe(22 * 5 * 2 * 10);
  });
});

describe('textos', () => {
  it('constantes exactas (las de la tabla del panel)', () => {
    expect(ETIQUETA_FALTA_AVION).toBe('Falta avión');
    expect(ETIQUETA_AVION_VUELATOUR).toBe('VuelaTour');
    expect(ETIQUETA_AVION_PERSONAL).toBe('Personal');
    expect(ETIQUETA_REPARTIDO).toBe('Repartido:');
    expect(MATRICULA_DESCONOCIDA).toBe('¿?');
    expect(TEXTO_AVION_SIN_MATRICULA).toBe('Avión asignado');
    expect(textoReferenciaAvion('N4142R')).toBe('ref. N4142R');
  });

  it('textoAvionGasto de cada estado', () => {
    expect(
      textoAvionGasto({
        tipo: 'REPARTIDO',
        matriculas: ['N4142R', null],
        conRemanente: true,
      }),
    ).toBe('Repartido: N4142R, ¿?, VuelaTour');
    expect(
      textoAvionGasto({
        tipo: 'FUERA_DEL_AVION',
        etiqueta: 'VuelaTour',
        referencia: 'XB-PEV',
      }),
    ).toBe('VuelaTour (ref. XB-PEV)');
    expect(
      textoAvionGasto({
        tipo: 'FUERA_DEL_AVION',
        etiqueta: 'Personal',
        referencia: null,
      }),
    ).toBe('Personal');
    expect(textoAvionGasto({ tipo: 'AVION', matricula: 'N621TX' })).toBe(
      'N621TX',
    );
    expect(textoAvionGasto({ tipo: 'AVION', matricula: null })).toBe(
      'Avión asignado',
    );
    expect(textoAvionGasto({ tipo: 'FALTA' })).toBe('Falta avión');
  });

  it('ninguna celda vuelve a decir «(pendiente)» ni «Repartido (N)»', () => {
    const viejos = matrizAvionGasto()
      .map(celdaAvionGasto)
      .filter((t) => /\(pendiente\)|Repartido \(/.test(t));
    expect(viejos).toEqual([]);
  });
});

describe('cableado en el Excel de gastos', () => {
  const fuente = readFileSync(join(__dirname, 'expenses.service.ts'), 'utf8');
  const plano = fuente.replace(/\s+/g, '');

  it('la columna lee SOLO los embeds de siempre de `list()` (cero lecturas nuevas)', () => {
    expect(plano).toContain('aeronave:aeronave!aeronave_id(matricula)');
    expect(plano).toContain(
      'repartos:gasto_reparto(aeronave_id,monto,aeronave:aeronave_id(matricula))',
    );
  });

  it('`listXlsx` escribe `celdaAvionGasto(x)` justo después del «Concepto» y ya no la expresión vieja', () => {
    const ini = fuente.indexOf('async listXlsx(');
    const fin = fuente.indexOf('private async listParaXlsx(');
    expect(ini).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(ini);
    const cuerpo = fuente.slice(ini, fin).replace(/\s+/g, '');
    expect(cuerpo.split('celdaAvionGasto(x)')).toHaveLength(2);
    expect(cuerpo.indexOf('conceptoDeGasto(x),')).toBeGreaterThan(-1);
    expect(cuerpo.indexOf('conceptoDeGasto(x),')).toBeLessThan(
      cuerpo.indexOf('celdaAvionGasto(x),'),
    );
    expect(cuerpo).not.toContain("'(pendiente)'");
    expect(cuerpo).not.toContain('`Repartido(');
  });
});

describe('PAGO DE AFAC marcado (16-oct-2026, invariante 90)', () => {
  it('PERMISO marcado ⇒ «VuelaTour · pago de AFAC» (+ « (ref. N4142R)» con avión sellado): lo paga VuelaTour, no le resta al avión', () => {
    expect(
      celdaAvionGasto(
        gasto({ categoria: 'PERMISO', es_pago_afac: true, ...conAvion() }),
      ),
    ).toBe('VuelaTour · pago de AFAC (ref. N4142R)');
    expect(
      celdaAvionGasto(gasto({ categoria: 'PERMISO', es_pago_afac: true })),
    ).toBe('VuelaTour · pago de AFAC');
  });

  it('sin la marca (o sin la migración: la lista no trae la llave) ⇒ la regla de siempre', () => {
    expect(
      celdaAvionGasto(gasto({ categoria: 'PERMISO', ...conAvion() })),
    ).toBe('N4142R');
    expect(
      celdaAvionGasto(gasto({ categoria: 'PERMISO', es_pago_afac: false })),
    ).toBe('Falta avión');
    // La marca fuera de PERMISO no existe (trigger de la BD): defensa.
    expect(
      celdaAvionGasto(
        gasto({ categoria: 'SERVICIOS', es_pago_afac: true, ...conAvion() }),
      ),
    ).toBe('N4142R');
  });
});
