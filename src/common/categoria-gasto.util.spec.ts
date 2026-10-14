import { CategoriaGasto } from '../modules/expenses/dto/expenses.dto';
import {
  CATEGORIA_COMISARIATO,
  CATEGORIA_GASTO_DESTINO,
  CATEGORIA_GASTO_LABEL,
  CATEGORIA_PAGO_VENDEDOR,
  CATEGORIA_PAGO_VENDEDOR_AVION,
  CATEGORIAS_GASTO_EMPRESA,
  CATEGORIAS_GASTO_FUERA_DEL_AVION,
  CATEGORIAS_GASTO_PAGO_VENDEDOR,
  CATEGORIAS_GASTO_SIN_AVION,
  CATEGORIAS_GASTO_VUELO_OBLIGATORIO,
  MENSAJE_CATEGORIA_SIN_MIGRACION,
  MENSAJE_COMISARIATO_SIN_MIGRACION,
  MIGRACION_DE_CATEGORIA,
  categoriaDeCheckExigeVuelo,
  categoriaEsDeEmpresa,
  categoriaEsPagoVendedor,
  categoriaExigeVuelo,
  categoriaExigeVueloSiempre,
  categoriaFueraDelAvion,
  descripcionCategoriasGasto,
  destinoCategoriaGasto,
  etiquetaCategoriaGasto,
  ladoPagoVendedor,
  mensajeCategoriaSinMigracion,
} from './categoria-gasto.util';
import { CATEGORIAS_REPARTIBLES } from './gasto-reparto.util';
import { CATS_SIN_TUA_EMBEBIDO } from './desglose-gasto.util';

describe('categoria-gasto.util (etiquetas y destino por default, 2-sep-2026)', () => {
  const codigos = Object.values(CategoriaGasto);

  it('el enum tiene las 22 categorías conocidas (COMISION_VENDEDOR desde el 28-sep-2026; COMISION_VENDEDOR_AVION justo después y COMISARIATO justo después de COMIDA desde el 13-oct-2026)', () => {
    expect(codigos).toHaveLength(22);
    expect(codigos).toContain('COMISION_VENDEDOR');
    const i = codigos.indexOf(CategoriaGasto.COMISION_VENDEDOR);
    expect(codigos[i + 1]).toBe('COMISION_VENDEDOR_AVION');
    // Mismo orden que el selector del panel y los chips de la app.
    expect(codigos).toContain('COMISARIATO');
    const j = codigos.indexOf(CategoriaGasto.COMIDA);
    expect(codigos[j + 1]).toBe('COMISARIATO');
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
    expect(etiquetaCategoriaGasto(CategoriaGasto.COMISARIATO)).toBe(
      'Comisariato',
    );
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
    expect(etiquetaCategoriaGasto(CategoriaGasto.COMISION_VENDEDOR)).toBe(
      'Comisión del vendedor (VuelaTour)',
    );
    expect(etiquetaCategoriaGasto(CategoriaGasto.COMISION_VENDEDOR_AVION)).toBe(
      'Comisión del vendedor (avión)',
    );
  });

  it('tabla canónica: destino por default por familia', () => {
    const directos = [
      CategoriaGasto.OPERACIONES,
      CategoriaGasto.ATERRIZAJE,
      CategoriaGasto.TUAS,
      CategoriaGasto.FBO,
      CategoriaGasto.COMIDA,
      // 13-oct-2026: el MISMO destino que COMIDA (snacks de los pasajeros).
      CategoriaGasto.COMISARIATO,
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
    // 28-sep-2026 y 13-oct-2026 (tabla canónica IDÉNTICA en API, panel y
    // app; textos simétricos «no es / sí es costo del avión»).
    expect(destinoCategoriaGasto(CategoriaGasto.COMISION_VENDEDOR)).toBe(
      'Pago al vendedor (otros movimientos VuelaTour; no es costo del avión)',
    );
    expect(destinoCategoriaGasto(CategoriaGasto.COMISION_VENDEDOR_AVION)).toBe(
      'Pago al vendedor (columna COMISIONES del balance del avión; sí es costo del avión)',
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
    // 13-oct-2026: COMISARIATO entra por su destino (candado del PILOTO).
    CategoriaGasto.COMISARIATO,
    CategoriaGasto.HOTEL,
    CategoriaGasto.TAXI,
    CategoriaGasto.PERMISO,
    CategoriaGasto.PILOTO_EXTERNO,
    // 28-sep-2026 / 13-oct-2026: la comisión siempre es de un vuelo (y
    // para TODOS los roles: `categoriaExigeVueloSiempre`).
    CategoriaGasto.COMISION_VENDEDOR,
    CategoriaGasto.COMISION_VENDEDOR_AVION,
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
  it('es exactamente las de EMPRESA + INDIRECTO + PERSONAL_DUENO + COMISION_VENDEDOR', () => {
    expect([...CATEGORIAS_GASTO_SIN_AVION].sort()).toEqual([
      'COMISION_VENDEDOR',
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

  it('NO lleva COMISION_VENDEDOR_AVION (13-oct-2026): arma el `not.in` de PostgREST y un literal sin migración revienta la LECTURA', () => {
    // El filtro de la «(avión)» va en JS en cada lector que lo necesita; la
    // bandeja/alerta/pre-cierre la listan si su vuelo no tiene avión (a
    // propósito: la salida es reclasificarla a «(VuelaTour)»).
    expect(CATEGORIAS_GASTO_SIN_AVION).not.toContain('COMISION_VENDEDOR_AVION');
  });
});

/**
 * COMISIÓN DEL VENDEDOR como gasto (pedido del cliente, 28-sep-2026;
 * invariante 31): exige vuelo a TODOS los roles, NO es costo del avión, NO
 * va a «otros gastos» (la lista de EMPRESA no cambia) y se aparea con la
 * comisión cobrada en «otros movimientos».
 */
describe('COMISION_VENDEDOR (28-sep-2026)', () => {
  it('etiqueta y destino EXACTOS de las DOS (paridad manual panel/app)', () => {
    expect(CATEGORIA_PAGO_VENDEDOR).toBe('COMISION_VENDEDOR');
    expect(CATEGORIA_PAGO_VENDEDOR_AVION).toBe('COMISION_VENDEDOR_AVION');
    expect(CATEGORIA_GASTO_LABEL.COMISION_VENDEDOR).toBe(
      'Comisión del vendedor (VuelaTour)',
    );
    expect(CATEGORIA_GASTO_DESTINO.COMISION_VENDEDOR).toBe(
      'Pago al vendedor (otros movimientos VuelaTour; no es costo del avión)',
    );
    expect(CATEGORIA_GASTO_LABEL.COMISION_VENDEDOR_AVION).toBe(
      'Comisión del vendedor (avión)',
    );
    expect(CATEGORIA_GASTO_DESTINO.COMISION_VENDEDOR_AVION).toBe(
      'Pago al vendedor (columna COMISIONES del balance del avión; sí es costo del avión)',
    );
    const texto = descripcionCategoriasGasto();
    expect(texto).toContain(
      'COMISION_VENDEDOR → Comisión del vendedor (VuelaTour) → Pago al vendedor (otros movimientos VuelaTour; no es costo del avión)',
    );
    expect(texto).toContain(
      'COMISION_VENDEDOR_AVION → Comisión del vendedor (avión) → Pago al vendedor (columna COMISIONES del balance del avión; sí es costo del avión)',
    );
    // 22 categorías (COMISION_VENDEDOR_AVION y COMISARIATO entraron el
    // 13-oct-2026) + el título.
    expect(texto.split('\n')).toHaveLength(23);
  });

  it('exige vuelo (piloto) Y para TODOS los roles (solo las dos)', () => {
    expect(categoriaExigeVuelo('COMISION_VENDEDOR')).toBe(true);
    expect(categoriaExigeVuelo('COMISION_VENDEDOR_AVION')).toBe(true);
    expect([...CATEGORIAS_GASTO_VUELO_OBLIGATORIO].sort()).toEqual([
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]);
    for (const c of Object.values(CategoriaGasto)) {
      expect(categoriaExigeVueloSiempre(c)).toBe(
        c === CategoriaGasto.COMISION_VENDEDOR ||
          c === CategoriaGasto.COMISION_VENDEDOR_AVION,
      );
    }
    expect(categoriaExigeVueloSiempre(null)).toBe(false);
    expect(categoriaExigeVueloSiempre('')).toBe(false);
  });

  it('CATEGORIAS_GASTO_EMPRESA NO cambia: la comisión NO va a «otros gastos»', () => {
    expect([...CATEGORIAS_GASTO_EMPRESA].sort()).toEqual([
      'FIJO',
      'GASOLINA',
      'NOMINA',
      'OTRO',
      'VISITA',
    ]);
    expect(categoriaEsDeEmpresa('COMISION_VENDEDOR')).toBe(false);
    expect(categoriaEsDeEmpresa('COMISION_VENDEDOR_AVION')).toBe(false);
  });

  it('FUERA DEL AVIÓN (eje genérico) = empresa + las DOS del pago al vendedor', () => {
    expect([...CATEGORIAS_GASTO_FUERA_DEL_AVION].sort()).toEqual([
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
      'FIJO',
      'GASOLINA',
      'NOMINA',
      'OTRO',
      'VISITA',
    ]);
    expect(categoriaFueraDelAvion('COMISION_VENDEDOR')).toBe(true);
    expect(categoriaFueraDelAvion('COMISION_VENDEDOR_AVION')).toBe(true);
    expect(categoriaFueraDelAvion('OTRO')).toBe(true);
    for (const c of ['TUAS', 'OPERACIONES', 'GAS', 'PERSONAL_DUENO', null]) {
      expect(categoriaFueraDelAvion(c)).toBe(false);
    }
  });

  it('categoriaEsPagoVendedor = la UNIÓN, con los códigos EXACTOS', () => {
    expect([...CATEGORIAS_GASTO_PAGO_VENDEDOR].sort()).toEqual([
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]);
    expect(categoriaEsPagoVendedor('COMISION_VENDEDOR')).toBe(true);
    expect(categoriaEsPagoVendedor('COMISION_VENDEDOR_AVION')).toBe(true);
    for (const c of [
      'comision_vendedor',
      'comision_vendedor_avion',
      'COMISION_VENDEDOR_AVIONX',
      'COMISION_VENDEDOR_',
      'COMISION',
      'OTRO',
      '',
      null,
      undefined,
    ]) {
      expect(categoriaEsPagoVendedor(c)).toBe(false);
    }
  });

  it('ladoPagoVendedor: igualdad EXACTA (el código viejo es prefijo del nuevo)', () => {
    expect(ladoPagoVendedor('COMISION_VENDEDOR')).toBe('VUELATOUR');
    expect(ladoPagoVendedor('COMISION_VENDEDOR_AVION')).toBe('AVION');
    for (const c of [
      'COMISION_VENDEDOR_AVIONX',
      'COMISION_VENDEDOR_',
      'comision_vendedor',
      'comision_vendedor_avion',
      'COMISION',
      'OTRO',
      '',
      null,
      undefined,
    ]) {
      expect(ladoPagoVendedor(c)).toBeNull();
    }
  });

  it('GUARDIÁN: ninguna comparación por prefijo — el código viejo es prefijo del nuevo', () => {
    // Si alguien vuelve a comparar con startsWith/includes, este par lo
    // delata: con prefijo, la «(avión)» caería del lado de VuelaTour.
    expect('COMISION_VENDEDOR_AVION'.startsWith('COMISION_VENDEDOR')).toBe(
      true,
    );
    expect(ladoPagoVendedor('COMISION_VENDEDOR_AVION')).not.toBe('VUELATOUR');
    expect(categoriaEsDeEmpresa('COMISION_VENDEDOR_AVION')).toBe(false);
  });

  it('NO repartibles (lista y trigger de BD sin cambio) y SIN TUA embebido', () => {
    for (const c of ['COMISION_VENDEDOR', 'COMISION_VENDEDOR_AVION']) {
      expect(CATEGORIAS_REPARTIBLES.has(c)).toBe(false);
      expect(CATS_SIN_TUA_EMBEBIDO.has(c)).toBe(true);
    }
  });

  it('mensajeCategoriaSinMigracion: 22P02 del enum con COMISION_VENDEDOR ⇒ texto 400 con «(VuelaTour)»', () => {
    const err = {
      code: '22P02',
      message:
        'invalid input value for enum categoria_gasto: "COMISION_VENDEDOR"',
    };
    expect(mensajeCategoriaSinMigracion(err, 'COMISION_VENDEDOR')).toBe(
      MENSAJE_CATEGORIA_SIN_MIGRACION,
    );
    expect(MENSAJE_CATEGORIA_SIN_MIGRACION).toBe(
      '«Comisión del vendedor (VuelaTour)» necesita la migración 20260928000001 en la base de datos; avisa a sistemas (el gasto no se guardó).',
    );
    // Otro código, otro enum, otra categoría enviada ⇒ null.
    expect(
      mensajeCategoriaSinMigracion(
        { ...err, code: '23514' },
        'COMISION_VENDEDOR',
      ),
    ).toBeNull();
    expect(
      mensajeCategoriaSinMigracion(
        {
          code: '22P02',
          message: 'invalid input value for enum moneda: "COMISION_VENDEDOR"',
        },
        'COMISION_VENDEDOR',
      ),
    ).toBeNull();
    expect(mensajeCategoriaSinMigracion(err, 'OTRO')).toBeNull();
    expect(
      mensajeCategoriaSinMigracion(
        {
          code: '22P02',
          message: 'invalid input value for enum categoria_gasto: "FOO"',
        },
        'COMISION_VENDEDOR',
      ),
    ).toBeNull();
  });

  it('mensajeCategoriaSinMigracion: la nueva da 20261013000003 y NO se cruzan aunque una sea prefijo de la otra', () => {
    expect(MIGRACION_DE_CATEGORIA).toEqual({
      COMISION_VENDEDOR: '20260928000001',
      COMISION_VENDEDOR_AVION: '20261013000003',
      COMISARIATO: '20261013000001',
    });
    const errAvion = {
      code: '22P02',
      message:
        'invalid input value for enum categoria_gasto: "COMISION_VENDEDOR_AVION"',
    };
    expect(
      mensajeCategoriaSinMigracion(errAvion, 'COMISION_VENDEDOR_AVION'),
    ).toBe(
      '«Comisión del vendedor (avión)» necesita la migración 20261013000003 en la base de datos; avisa a sistemas (el gasto no se guardó).',
    );
    // El mensaje de la NUEVA contiene el código viejo como subcadena: con
    // las comillas dobles NO casa al enviar la vieja (y al revés tampoco).
    expect(
      mensajeCategoriaSinMigracion(errAvion, 'COMISION_VENDEDOR'),
    ).toBeNull();
    expect(
      mensajeCategoriaSinMigracion(
        {
          code: '22P02',
          message:
            'invalid input value for enum categoria_gasto: "COMISION_VENDEDOR"',
        },
        'COMISION_VENDEDOR_AVION',
      ),
    ).toBeNull();
    // Otro enum ⇒ null.
    expect(
      mensajeCategoriaSinMigracion(
        {
          code: '22P02',
          message:
            'invalid input value for enum moneda: "COMISION_VENDEDOR_AVION"',
        },
        'COMISION_VENDEDOR_AVION',
      ),
    ).toBeNull();
    expect(mensajeCategoriaSinMigracion(errAvion, null)).toBeNull();
  });

  it('categoriaDeCheckExigeVuelo: cada CHECK da SU categoría; otro 23514 ⇒ null', () => {
    expect(
      categoriaDeCheckExigeVuelo({
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_comision_vendedor_exige_vuelo"',
      }),
    ).toBe('COMISION_VENDEDOR');
    expect(
      categoriaDeCheckExigeVuelo({
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_comision_vendedor_avion_exige_vuelo"',
      }),
    ).toBe('COMISION_VENDEDOR_AVION');
    // El nombre viejo NO es subcadena del nuevo.
    expect(
      'gasto_comision_vendedor_avion_exige_vuelo'.includes(
        'gasto_comision_vendedor_exige_vuelo',
      ),
    ).toBe(false);
    expect(
      categoriaDeCheckExigeVuelo({
        code: '23514',
        message:
          'new row for relation "gasto" violates check constraint "gasto_medio_tarjeta_check"',
      }),
    ).toBeNull();
    expect(
      categoriaDeCheckExigeVuelo({
        code: '22P02',
        message: 'gasto_comision_vendedor_avion_exige_vuelo',
      }),
    ).toBeNull();
    expect(
      categoriaDeCheckExigeVuelo({ code: '23514', message: null }),
    ).toBeNull();
  });
});

/**
 * COMISARIATO (13-oct-2026, invariante 63; pedido del cliente: «agregar en
 * la categoría de gastos: Comisariato; entraría en [la columna OTROS de
 * costos directos] en el balance del avión»): snacks/bebidas de los
 * PASAJEROS. Entra SOLO por su destino (el de COMIDA): ninguna lista de
 * empresa / sin avión / fuera del avión / vuelo obligatorio cambia.
 */
describe('COMISARIATO (13-oct-2026)', () => {
  it('código, etiqueta y destino EXACTOS (paridad manual panel/app)', () => {
    expect(CATEGORIA_COMISARIATO).toBe('COMISARIATO');
    expect(CATEGORIA_GASTO_LABEL.COMISARIATO).toBe('Comisariato');
    expect(CATEGORIA_GASTO_DESTINO.COMISARIATO).toBe(
      'Gastos directos del vuelo (en el balance del avión)',
    );
    // El MISMO destino que COMIDA (la comida de la tripulación).
    expect(CATEGORIA_GASTO_DESTINO.COMISARIATO).toBe(
      CATEGORIA_GASTO_DESTINO.COMIDA,
    );
    expect(descripcionCategoriasGasto()).toContain(
      'COMISARIATO → Comisariato → Gastos directos del vuelo (en el balance del avión)',
    );
  });

  it('exige vuelo SOLO al PILOTO (derivado del destino), no a todos los roles', () => {
    expect(categoriaExigeVuelo('COMISARIATO')).toBe(true);
    expect(categoriaExigeVueloSiempre('COMISARIATO')).toBe(false);
    expect([...CATEGORIAS_GASTO_VUELO_OBLIGATORIO].sort()).toEqual([
      'COMISION_VENDEDOR',
      'COMISION_VENDEDOR_AVION',
    ]);
  });

  it('NO es de empresa, NO es «sin avión» (sin avión es pendiente real) y NO queda fuera del avión', () => {
    expect(categoriaEsDeEmpresa('COMISARIATO')).toBe(false);
    expect([...CATEGORIAS_GASTO_EMPRESA].sort()).toEqual([
      'FIJO',
      'GASOLINA',
      'NOMINA',
      'OTRO',
      'VISITA',
    ]);
    expect(CATEGORIAS_GASTO_SIN_AVION).not.toContain('COMISARIATO');
    expect(categoriaFueraDelAvion('COMISARIATO')).toBe(false);
    expect(categoriaEsPagoVendedor('COMISARIATO')).toBe(false);
    expect(ladoPagoVendedor('COMISARIATO')).toBeNull();
  });

  it('SIN TUA embebido (columna OTROS entera) y NO repartible', () => {
    expect(CATS_SIN_TUA_EMBEBIDO.has('COMISARIATO')).toBe(true);
    expect(CATEGORIAS_REPARTIBLES.has('COMISARIATO')).toBe(false);
  });

  it('22P02 del enum sin la migración 20261013000001 ⇒ texto 400 con «Comisariato»; la comisión sigue byte a byte', () => {
    const err = {
      code: '22P02',
      message: 'invalid input value for enum categoria_gasto: "COMISARIATO"',
    };
    expect(mensajeCategoriaSinMigracion(err, 'COMISARIATO')).toBe(
      MENSAJE_COMISARIATO_SIN_MIGRACION,
    );
    expect(MENSAJE_COMISARIATO_SIN_MIGRACION).toBe(
      '«Comisariato» necesita la migración 20261013000001 en la base de datos; avisa a sistemas (el gasto no se guardó).',
    );
    // Otro código, otro enum, otra categoría enviada ⇒ null.
    expect(
      mensajeCategoriaSinMigracion({ ...err, code: '23514' }, 'COMISARIATO'),
    ).toBeNull();
    expect(
      mensajeCategoriaSinMigracion(
        {
          code: '22P02',
          message: 'invalid input value for enum moneda: "COMISARIATO"',
        },
        'COMISARIATO',
      ),
    ).toBeNull();
    expect(mensajeCategoriaSinMigracion(err, 'COMIDA')).toBeNull();
    expect(mensajeCategoriaSinMigracion(err, 'COMISION_VENDEDOR')).toBeNull();
    // El texto de la comisión del 28-sep no se movió.
    expect(MENSAJE_CATEGORIA_SIN_MIGRACION).toBe(
      '«Comisión del vendedor (VuelaTour)» necesita la migración 20260928000001 en la base de datos; avisa a sistemas (el gasto no se guardó).',
    );
  });
});
