import { CategoriaGasto } from '../modules/expenses/dto/expenses.dto';
import {
  CATEGORIA_GASTO_DESTINO,
  CATEGORIA_GASTO_LABEL,
  CATEGORIAS_GASTO_EMPRESA,
  CATEGORIAS_GASTO_SIN_AVION,
  categoriaEsDeEmpresa,
  categoriaExigeVuelo,
  descripcionCategoriasGasto,
  destinoCategoriaGasto,
  etiquetaCategoriaGasto,
} from './categoria-gasto.util';

describe('categoria-gasto.util (etiquetas y destino por default, 2-sep-2026)', () => {
  const codigos = Object.values(CategoriaGasto);

  it('el enum tiene las 19 categorías conocidas', () => {
    expect(codigos).toHaveLength(19);
  });

  it('toda categoría del enum tiene etiqueta y destino no vacíos (y nada extra)', () => {
    for (const c of codigos) {
      expect(CATEGORIA_GASTO_LABEL[c]).toEqual(expect.any(String));
      expect(CATEGORIA_GASTO_LABEL[c].trim().length).toBeGreaterThan(0);
      expect(CATEGORIA_GASTO_DESTINO[c]).toEqual(expect.any(String));
      expect(CATEGORIA_GASTO_DESTINO[c].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(CATEGORIA_GASTO_LABEL).sort()).toEqual(
      [...codigos].sort(),
    );
    expect(Object.keys(CATEGORIA_GASTO_DESTINO).sort()).toEqual(
      [...codigos].sort(),
    );
  });

  it('tabla canónica: las dos categorías renombradas por el cliente', () => {
    expect(etiquetaCategoriaGasto('GAS')).toBe('Gasavión / Turbosina');
    expect(etiquetaCategoriaGasto('OTRO')).toBe('Otros gastos VuelaTour');
  });

  it('tabla canónica: el resto de las etiquetas (sentence case, homologadas)', () => {
    expect(etiquetaCategoriaGasto(CategoriaGasto.ATERRIZAJE)).toBe(
      'Aterrizaje',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.OPERACIONES)).toBe(
      'Operaciones',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.TUAS)).toBe('TUAS');
    expect(etiquetaCategoriaGasto(CategoriaGasto.FBO)).toBe('FBO');
    expect(etiquetaCategoriaGasto(CategoriaGasto.COMIDA)).toBe('Comida');
    expect(etiquetaCategoriaGasto(CategoriaGasto.HOTEL)).toBe('Hotel');
    expect(etiquetaCategoriaGasto(CategoriaGasto.TAXI)).toBe(
      'Taxi / estacionamiento',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.REFACCION)).toBe('Refacción');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PERMISO)).toBe('Permiso');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PILOTO_EXTERNO)).toBe(
      'Piloto externo (honorario)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.FIJO)).toBe('Gasto fijo');
    expect(etiquetaCategoriaGasto(CategoriaGasto.INDIRECTO)).toBe(
      'Gastos indirectos de avión',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.NOMINA)).toBe('Nómina');
    expect(etiquetaCategoriaGasto(CategoriaGasto.SERVICIOS)).toBe(
      'Servicios (avión)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.GASOLINA)).toBe(
      'Gasolina (vehículos)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.VISITA)).toBe('Visita');
    expect(etiquetaCategoriaGasto(CategoriaGasto.PERSONAL_DUENO)).toBe(
      'Gasto personal del dueño',
    );
  });

  it('tabla canónica: destino por default por familia', () => {
    const directos = [
      CategoriaGasto.OPERACIONES,
      CategoriaGasto.ATERRIZAJE,
      CategoriaGasto.TUAS,
      CategoriaGasto.FBO,
      CategoriaGasto.COMIDA,
      CategoriaGasto.HOTEL,
      CategoriaGasto.TAXI,
      CategoriaGasto.PILOTO_EXTERNO,
    ];
    for (const c of directos) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Gastos directos del vuelo (en el balance del avión)',
      );
    }
    expect(destinoCategoriaGasto(CategoriaGasto.GAS)).toBe(
      'Combustible (en el balance del avión)',
    );
    expect(destinoCategoriaGasto(CategoriaGasto.REFACCION)).toBe(
      'Inventario en el Balance general VuelaTour; al salir del inventario se vende al avión y cae en sus Gastos Indirectos',
    );
    expect(destinoCategoriaGasto(CategoriaGasto.PERMISO)).toBe(
      'Hoja de permisos (en el balance del avión)',
    );
    for (const c of [CategoriaGasto.INDIRECTO, CategoriaGasto.SERVICIOS]) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Gastos indirectos del avión (en el balance del avión)',
      );
    }
    for (const c of [
      CategoriaGasto.NOMINA,
      CategoriaGasto.GASOLINA,
      CategoriaGasto.OTRO,
      CategoriaGasto.FIJO,
      CategoriaGasto.VISITA,
    ]) {
      expect(destinoCategoriaGasto(c)).toBe(
        'Otros gastos (Balance general VuelaTour)',
      );
    }
    expect(destinoCategoriaGasto(CategoriaGasto.PERSONAL_DUENO)).toBe(
      'Gastos personales de los dueños (fuera de la empresa)',
    );
  });

  it('fallback: código desconocido → capitalizado; vacío/null → cadena vacía', () => {
    expect(etiquetaCategoriaGasto('FOO_BAR')).toBe('Foo bar');
    expect(etiquetaCategoriaGasto('reanalisis')).toBe('Reanalisis');
    expect(etiquetaCategoriaGasto('')).toBe('');
    expect(etiquetaCategoriaGasto(null)).toBe('');
    expect(etiquetaCategoriaGasto(undefined)).toBe('');
    expect(destinoCategoriaGasto('FOO_BAR')).toBeNull();
    expect(destinoCategoriaGasto(null)).toBeNull();
  });

  it('descripción Swagger: una línea código → etiqueta → destino por cada categoría', () => {
    const texto = descripcionCategoriasGasto();
    for (const c of codigos) {
      expect(texto).toContain(
        `${c} → ${CATEGORIA_GASTO_LABEL[c]} → ${CATEGORIA_GASTO_DESTINO[c]}`,
      );
    }
    expect(texto.split('\n')).toHaveLength(codigos.length + 1);
  });
});

/**
 * Gasto SIN vuelo (11-sep-2026): el piloto solo puede capturar sin vuelo las
 * categorías que NO son del vuelo. La regla se deriva del destino por
 * default + la lista corta (TUAS/PERMISO/PILOTO_EXTERNO).
 */
describe('categoriaExigeVuelo', () => {
  const DEL_VUELO: CategoriaGasto[] = [
    CategoriaGasto.ATERRIZAJE,
    CategoriaGasto.OPERACIONES,
    CategoriaGasto.TUAS,
    CategoriaGasto.FBO,
    CategoriaGasto.COMIDA,
    CategoriaGasto.HOTEL,
    CategoriaGasto.TAXI,
    CategoriaGasto.PERMISO,
    CategoriaGasto.PILOTO_EXTERNO,
  ];
  const SIN_VUELO: CategoriaGasto[] = [
    // GAS (11-sep-2026): el piloto también carga combustible EN BASE, sin
    // vuelo — la pantalla de combustible de la app ofrece "Sin vuelo".
    CategoriaGasto.GAS,
    CategoriaGasto.REFACCION,
    CategoriaGasto.FIJO,
    CategoriaGasto.INDIRECTO,
    CategoriaGasto.VISITA,
    CategoriaGasto.GASOLINA,
    CategoriaGasto.NOMINA,
    CategoriaGasto.SERVICIOS,
    CategoriaGasto.PERSONAL_DUENO,
    CategoriaGasto.OTRO,
  ];

  it('las categorías del VUELO lo exigen', () => {
    for (const c of DEL_VUELO) expect(categoriaExigeVuelo(c)).toBe(true);
  });

  it('las de empresa/indirectos/refacción/servicios NO lo exigen', () => {
    for (const c of SIN_VUELO) expect(categoriaExigeVuelo(c)).toBe(false);
  });

  it('la partición cubre TODO el enum (una categoría nueva no se queda sin decidir)', () => {
    expect([...DEL_VUELO, ...SIN_VUELO].sort()).toEqual(
      Object.values(CategoriaGasto).sort(),
    );
  });

  it('todas las que dicen «Gastos directos del vuelo» quedan dentro de la regla', () => {
    for (const c of Object.values(CategoriaGasto)) {
      if (CATEGORIA_GASTO_DESTINO[c].startsWith('Gastos directos del vuelo')) {
        expect(categoriaExigeVuelo(c)).toBe(true);
      }
    }
  });

  it('GAS NO exige vuelo (11-sep-2026): el piloto carga combustible en base', () => {
    // Cambio del cliente: el mecánico ya estaba fuera del candado por rol y
    // el piloto hacía lo mismo en tierra. El combustible sin vuelo no se
    // pierde (su hoja del balance se arma por AVIÓN y eje fecha_gasto).
    expect(categoriaExigeVuelo(CategoriaGasto.GAS)).toBe(false);
  });

  it('código desconocido / vacío ⇒ false (no se inventan candados)', () => {
    expect(categoriaExigeVuelo('FOO_BAR')).toBe(false);
    expect(categoriaExigeVuelo(null)).toBe(false);
    expect(categoriaExigeVuelo(undefined)).toBe(false);
    expect(categoriaExigeVuelo('')).toBe(false);
  });
});

/**
 * CATEGORÍAS DE EMPRESA («la categoría manda sobre el vuelo», 11-sep-2026):
 * su gasto sale del avión y vive en la hoja "otros gastos" del Balance
 * general. La membresía se DERIVA del destino, así que este spec la CONGELA:
 * mover un destino mueve dinero del cierre y debe fallar aquí primero.
 */
describe('categoriaEsDeEmpresa (11-sep-2026)', () => {
  it('la lista congelada es exactamente OTRO, NOMINA, GASOLINA, FIJO, VISITA', () => {
    expect([...CATEGORIAS_GASTO_EMPRESA].sort()).toEqual([
      'FIJO',
      'GASOLINA',
      'NOMINA',
      'OTRO',
      'VISITA',
    ]);
  });

  it('fuera a propósito: PERSONAL_DUENO, GAS y todo lo del avión', () => {
    for (const c of [
      'PERSONAL_DUENO',
      'GAS',
      'INDIRECTO',
      'SERVICIOS',
      'REFACCION',
      'PERMISO',
      'TUAS',
      'FBO',
      'OPERACIONES',
    ]) {
      expect(categoriaEsDeEmpresa(c)).toBe(false);
    }
  });

  it('coincide con el destino "Otros gastos (Balance general VuelaTour)"', () => {
    for (const c of Object.values(CategoriaGasto)) {
      expect(categoriaEsDeEmpresa(c)).toBe(
        CATEGORIA_GASTO_DESTINO[c] ===
          'Otros gastos (Balance general VuelaTour)',
      );
    }
  });

  it('código desconocido / vacío ⇒ false', () => {
    expect(categoriaEsDeEmpresa('FOO_BAR')).toBe(false);
    expect(categoriaEsDeEmpresa(null)).toBe(false);
    expect(categoriaEsDeEmpresa(undefined)).toBe(false);
    expect(categoriaEsDeEmpresa('')).toBe(false);
  });
});

/**
 * CATEGORÍAS QUE NUNCA PIDEN AVIÓN — fuente única de la bandeja de
 * pendientes, su sugerencia por IA, la alerta diaria `gastos_sin_avion` y el
 * pre-cierre del reparto. Antes cada lector escribía la lista a mano y todos
 * llevaban un `.or('categoria.neq.OTRO,vuelo_id.not.is.null')` que dejaba
 * DENTRO al «OTRO CON vuelo»: desde el 11-sep-2026 ese gasto ya no es de
 * ningún avión, así que pedirle aeronave es un pendiente eterno.
 */
describe('CATEGORIAS_GASTO_SIN_AVION (11-sep-2026)', () => {
  it('es exactamente las de EMPRESA + INDIRECTO + PERSONAL_DUENO', () => {
    expect([...CATEGORIAS_GASTO_SIN_AVION].sort()).toEqual([
      'FIJO',
      'GASOLINA',
      'INDIRECTO',
      'NOMINA',
      'OTRO',
      'PERSONAL_DUENO',
      'VISITA',
    ]);
  });

  it('un OTRO CON vuelo tampoco pide avión (la categoría manda)', () => {
    // El filtro de los cuatro lectores es exactamente esta pertenencia: no
    // mira `vuelo_id`, así que un OTRO ligado a un vuelo queda fuera de la
    // bandeja igual que uno suelto.
    expect(CATEGORIAS_GASTO_SIN_AVION).toContain('OTRO');
  });

  it('SERVICIOS, REFACCION y GAS SÍ son pendientes reales sin avión', () => {
    for (const c of ['SERVICIOS', 'REFACCION', 'GAS', 'OPERACIONES']) {
      expect(CATEGORIAS_GASTO_SIN_AVION).not.toContain(c);
    }
  });
});
