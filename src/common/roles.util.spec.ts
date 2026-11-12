import { Rol } from './types/auth.types';
import {
  CATEGORIAS_CON_ACCESO_POR_PERSONA,
  CATEGORIAS_SOLO_DIRECCION,
  CATEGORIA_GASTOS_PERSONALES,
  CATEGORIA_NOMINA,
  CODIGO_CAJA_SOLO_DIRECCION,
  CODIGO_CATEGORIA_SOLO_DIRECCION,
  CODIGO_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES,
  CODIGO_SOLO_DIRECCION_ACCESO_NOMINA,
  CODIGO_SOLO_DIRECCION_USUARIOS,
  MENSAJE_CAJA_SOLO_DIRECCION,
  MENSAJE_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
  MENSAJE_NOMINA_SIN_ACCESO,
  MENSAJE_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES,
  MENSAJE_SOLO_DIRECCION_ACCESO_NOMINA,
  MENSAJE_SOLO_DIRECCION_ASIGNA,
  MENSAJE_SOLO_DIRECCION_EDITA,
  ROLES_GASTOS_PERSONALES_POR_ROL,
  ROLES_NOMINA_POR_ROL,
  actorPuedeAsignarRol,
  actorPuedeTocarUsuario,
  categoriaAdmiteAccesoPorPersona,
  categoriaSoloDireccion,
  categoriaVedadaAUsuario,
  entraAGastosPersonales,
  entraAModulo,
  entraANomina,
  esAdminODireccion,
  esAdministracion,
  esDireccion,
  finanzasParaRol,
  fondoEsDeDireccion,
  mensajeCategoriaVedada,
  rolAdmiteAccesoPorPersona,
  rolEntraAGastosPersonales,
  rolEntraAModulo,
  rolEntraANomina,
  rolVeFondo,
  rolVedaCategoria,
  rolesDestinatarios,
} from './roles.util';

/**
 * Dirección y Administración (6-nov-2026, invariante 122): la matriz de
 * quién ve qué vive en un solo lugar y aquí se congela.
 */
describe('roles.util — Dirección y Administración', () => {
  it('el enum trae DIRECCION y ADMIN sigue siendo el código de Administración', () => {
    expect(Rol.DIRECCION).toBe('DIRECCION');
    expect(Rol.ADMIN).toBe('ADMIN');
    expect(Object.values(Rol)).toContain('DIRECCION');
  });

  it('predicados básicos', () => {
    expect(esDireccion('DIRECCION')).toBe(true);
    expect(esDireccion('ADMIN')).toBe(false);
    expect(esAdministracion('ADMIN')).toBe(true);
    expect(esAdministracion('DIRECCION')).toBe(false);
    for (const r of ['ADMIN', 'DIRECCION']) {
      expect(esAdminODireccion(r)).toBe(true);
    }
    for (const r of [
      'COORDINADOR',
      'FACTURACION',
      'SOCIO',
      null,
      undefined,
      '',
    ]) {
      expect(esAdminODireccion(r)).toBe(false);
    }
  });

  it('un aviso a ADMIN llega también a DIRECCION; los demás roles, solo ellos', () => {
    expect(rolesDestinatarios(Rol.ADMIN)).toEqual([Rol.ADMIN, Rol.DIRECCION]);
    expect(rolesDestinatarios(Rol.COORDINADOR)).toEqual([Rol.COORDINADOR]);
    expect(rolesDestinatarios(Rol.DIRECCION)).toEqual([Rol.DIRECCION]);
  });

  describe('nómina y gastos personales', () => {
    it('solo esas dos categorías, y solo Administración las tiene vedadas', () => {
      expect([...CATEGORIAS_SOLO_DIRECCION]).toEqual([
        'NOMINA',
        'PERSONAL_DUENO',
      ]);
      expect(categoriaSoloDireccion('NOMINA')).toBe(true);
      expect(categoriaSoloDireccion('GAS')).toBe(false);
      expect(categoriaSoloDireccion(undefined)).toBe(false);
      expect(rolVedaCategoria('ADMIN', 'NOMINA')).toBe(true);
      expect(rolVedaCategoria('ADMIN', 'PERSONAL_DUENO')).toBe(true);
      expect(rolVedaCategoria('ADMIN', 'GAS')).toBe(false);
      expect(rolVedaCategoria('ADMIN', undefined)).toBe(false);
      for (const r of ['DIRECCION', 'COORDINADOR', 'FACTURACION', 'PILOTO']) {
        expect(rolVedaCategoria(r, 'NOMINA')).toBe(false);
      }
      expect(CODIGO_CATEGORIA_SOLO_DIRECCION).toBe('CATEGORIA_SOLO_DIRECCION');
      expect(MENSAJE_CATEGORIA_SOLO_DIRECCION).toBe(
        'La nómina y los gastos personales los lleva Dirección.',
      );
    });
  });

  describe('acceso por PERSONA a Nómina y a Gastos personales (12-nov-2026, invariantes 132 y 133)', () => {
    const TODOS = Object.values(Rol);
    const si = () => Promise.resolve(true);
    const no = () => Promise.resolve(false);
    /** Solo tiene el acceso de UNA categoría (las listas son independientes). */
    const solo = (cat: string) => (pedida: string) =>
      Promise.resolve(pedida === cat);

    it('las dos categorías solo de Dirección admiten acceso por persona, cada una con su lista', () => {
      expect(CATEGORIA_NOMINA).toBe('NOMINA');
      expect(CATEGORIA_GASTOS_PERSONALES).toBe('PERSONAL_DUENO');
      expect([...CATEGORIAS_CON_ACCESO_POR_PERSONA]).toEqual([
        'NOMINA',
        'PERSONAL_DUENO',
      ]);
      // Hoy toda categoría vedada a Administración tiene su acceso: si mañana
      // se veda otra, NO se abre con ninguno hasta que alguien lo decida.
      expect([...CATEGORIAS_CON_ACCESO_POR_PERSONA]).toEqual([
        ...CATEGORIAS_SOLO_DIRECCION,
      ]);
      expect(categoriaAdmiteAccesoPorPersona('NOMINA')).toBe(true);
      expect(categoriaAdmiteAccesoPorPersona('PERSONAL_DUENO')).toBe(true);
      for (const c of ['GAS', 'OTRO', '', null, undefined]) {
        expect(categoriaAdmiteAccesoPorPersona(c)).toBe(false);
      }
    });

    it('Nómina: por su rol entran Dirección, Coordinación y Facturación (los de siempre); Administración NO', () => {
      expect([...ROLES_NOMINA_POR_ROL]).toEqual([
        Rol.DIRECCION,
        Rol.COORDINADOR,
        Rol.FACTURACION,
      ]);
      expect(TODOS.filter((r) => rolEntraANomina(r))).toEqual([
        Rol.DIRECCION,
        Rol.COORDINADOR,
        Rol.FACTURACION,
      ]);
      for (const r of [null, undefined, '', 'OTRO']) {
        expect(rolEntraANomina(r)).toBe(false);
      }
    });

    it('Gastos personales: por su rol entran Dirección y Coordinación (Facturación nunca tuvo ese módulo); Administración NO', () => {
      expect([...ROLES_GASTOS_PERSONALES_POR_ROL]).toEqual([
        Rol.DIRECCION,
        Rol.COORDINADOR,
      ]);
      expect(TODOS.filter((r) => rolEntraAGastosPersonales(r))).toEqual([
        Rol.DIRECCION,
        Rol.COORDINADOR,
      ]);
      for (const r of [null, undefined, '', 'OTRO']) {
        expect(rolEntraAGastosPersonales(r)).toBe(false);
      }
      // La regla genérica y la de nombre dicen lo mismo.
      for (const r of TODOS) {
        expect(rolEntraAModulo('PERSONAL_DUENO', r)).toBe(
          rolEntraAGastosPersonales(r),
        );
        expect(rolEntraAModulo('NOMINA', r)).toBe(rolEntraANomina(r));
      }
    });

    it('un acceso por persona solo se le puede dar a Administración', () => {
      expect(TODOS.filter((r) => rolAdmiteAccesoPorPersona(r))).toEqual([
        Rol.ADMIN,
      ]);
    });

    it('entraANomina: por rol siempre; Administración solo si está en la lista; un id en la lista con otro rol NO entra', () => {
      for (const r of ROLES_NOMINA_POR_ROL) {
        expect(entraANomina(r, false)).toBe(true);
        expect(entraANomina(r, true)).toBe(true);
      }
      expect(entraANomina(Rol.ADMIN, true)).toBe(true);
      expect(entraANomina(Rol.ADMIN, false)).toBe(false);
      for (const r of [
        Rol.ANALISTA,
        Rol.PILOTO,
        Rol.SOCIO,
        Rol.MECANICO,
        Rol.VISITANTE,
        null,
        undefined,
      ]) {
        expect(entraANomina(r, true)).toBe(false);
      }
    });

    it('entraAGastosPersonales: por rol siempre; Administración solo si está en SU lista; Facturación y los demás roles NO entran ni estando en ella', () => {
      for (const r of ROLES_GASTOS_PERSONALES_POR_ROL) {
        expect(entraAGastosPersonales(r, false)).toBe(true);
        expect(entraAGastosPersonales(r, true)).toBe(true);
      }
      expect(entraAGastosPersonales(Rol.ADMIN, true)).toBe(true);
      expect(entraAGastosPersonales(Rol.ADMIN, false)).toBe(false);
      for (const r of [
        Rol.FACTURACION,
        Rol.ANALISTA,
        Rol.PILOTO,
        Rol.SOCIO,
        Rol.MECANICO,
        Rol.VISITANTE,
        null,
        undefined,
      ]) {
        expect(entraAGastosPersonales(r, true)).toBe(false);
      }
      expect(entraAModulo('PERSONAL_DUENO', Rol.ADMIN, true)).toBe(true);
      expect(entraAModulo('NOMINA', Rol.FACTURACION, false)).toBe(true);
    });

    it('cada categoría se le abre a Administración SOLO con el acceso de ESA categoría', async () => {
      for (const cat of ['NOMINA', 'PERSONAL_DUENO']) {
        expect(await categoriaVedadaAUsuario('ADMIN', cat, no)).toBe(true);
        expect(await categoriaVedadaAUsuario('ADMIN', cat, si)).toBe(false);
      }
      // Las listas son independientes: el acceso a Nómina NO abre los gastos
      // personales, y el de gastos personales NO abre la nómina.
      expect(
        await categoriaVedadaAUsuario('ADMIN', 'NOMINA', solo('NOMINA')),
      ).toBe(false);
      expect(
        await categoriaVedadaAUsuario(
          'ADMIN',
          'PERSONAL_DUENO',
          solo('NOMINA'),
        ),
      ).toBe(true);
      expect(
        await categoriaVedadaAUsuario(
          'ADMIN',
          'PERSONAL_DUENO',
          solo('PERSONAL_DUENO'),
        ),
      ).toBe(false);
      expect(
        await categoriaVedadaAUsuario(
          'ADMIN',
          'NOMINA',
          solo('PERSONAL_DUENO'),
        ),
      ).toBe(true);
    });

    it('la lista se consulta SOLO para Administración + una categoría con acceso, y se le pregunta por ESA categoría', async () => {
      const lista = jest.fn().mockResolvedValue(true);
      for (const cat of ['GAS', 'OTRO', null, undefined]) {
        expect(await categoriaVedadaAUsuario('ADMIN', cat, lista)).toBe(false);
      }
      for (const r of TODOS.filter((x) => x !== Rol.ADMIN)) {
        expect(await categoriaVedadaAUsuario(r, 'NOMINA', lista)).toBe(false);
        expect(await categoriaVedadaAUsuario(r, 'PERSONAL_DUENO', lista)).toBe(
          false,
        );
      }
      expect(lista).not.toHaveBeenCalled();
      await categoriaVedadaAUsuario('ADMIN', 'NOMINA', lista);
      expect(lista).toHaveBeenCalledTimes(1);
      expect(lista).toHaveBeenLastCalledWith('NOMINA');
      await categoriaVedadaAUsuario('ADMIN', 'PERSONAL_DUENO', lista);
      expect(lista).toHaveBeenCalledTimes(2);
      expect(lista).toHaveBeenLastCalledWith('PERSONAL_DUENO');
    });

    it('textos: a quien le falta el acceso se le dice a quién pedírselo y dónde; el código no cambia', () => {
      expect(mensajeCategoriaVedada('NOMINA')).toBe(MENSAJE_NOMINA_SIN_ACCESO);
      expect(MENSAJE_NOMINA_SIN_ACCESO).toBe(
        'La nómina la lleva Dirección. Si te toca llevarla, pídele a Dirección que te dé acceso en Configuración («Acceso a Nómina»).',
      );
      expect(mensajeCategoriaVedada('PERSONAL_DUENO')).toBe(
        MENSAJE_GASTOS_PERSONALES_SIN_ACCESO,
      );
      expect(MENSAJE_GASTOS_PERSONALES_SIN_ACCESO).toBe(
        'Los gastos personales los lleva Dirección. Si te toca llevarlos, pídele a Dirección que te dé acceso en Configuración («Acceso a Gastos personales»).',
      );
      // Sin categoría (o una que no tiene acceso por persona): el de siempre.
      expect(mensajeCategoriaVedada(undefined)).toBe(
        MENSAJE_CATEGORIA_SOLO_DIRECCION,
      );
      expect(mensajeCategoriaVedada('GAS')).toBe(
        MENSAJE_CATEGORIA_SOLO_DIRECCION,
      );
      expect(CODIGO_SOLO_DIRECCION_ACCESO_NOMINA).toBe(
        'SOLO_DIRECCION_ACCESO_NOMINA',
      );
      expect(MENSAJE_SOLO_DIRECCION_ACCESO_NOMINA).toBe(
        'Solo Dirección puede cambiar quién entra a Nómina.',
      );
      expect(CODIGO_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES).toBe(
        'SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES',
      );
      expect(MENSAJE_SOLO_DIRECCION_ACCESO_GASTOS_PERSONALES).toBe(
        'Solo Dirección puede cambiar quién entra a Gastos personales.',
      );
    });
  });

  describe('caja chica de Dirección', () => {
    const deAle = { usuario: { rol: 'DIRECCION' } };
    const deMary = { usuario: { rol: 'ADMIN' } };
    it('el fondo es de Dirección por el rol de su dueño', () => {
      expect(fondoEsDeDireccion(deAle)).toBe(true);
      expect(fondoEsDeDireccion(deMary)).toBe(false);
      expect(fondoEsDeDireccion({ usuario: null })).toBe(false);
      expect(fondoEsDeDireccion(null)).toBe(false);
    });
    it('Administración no lo ve; Dirección y los demás roles sí (sus @Roles mandan)', () => {
      expect(rolVeFondo('ADMIN', deAle)).toBe(false);
      expect(rolVeFondo('ADMIN', deMary)).toBe(true);
      expect(rolVeFondo('DIRECCION', deAle)).toBe(true);
      expect(rolVeFondo('FACTURACION', deAle)).toBe(true);
      expect(rolVeFondo(undefined, deAle)).toBe(true);
      expect(CODIGO_CAJA_SOLO_DIRECCION).toBe('CAJA_SOLO_DIRECCION');
      expect(MENSAJE_CAJA_SOLO_DIRECCION).toBe(
        'La caja chica de Dirección solo la ve Dirección.',
      );
    });
  });

  describe('usuarios', () => {
    it('solo Dirección da el rol de Dirección', () => {
      expect(actorPuedeAsignarRol('ADMIN', 'DIRECCION')).toBe(false);
      expect(actorPuedeAsignarRol('DIRECCION', 'DIRECCION')).toBe(true);
      expect(actorPuedeAsignarRol('ADMIN', 'ADMIN')).toBe(true);
      expect(actorPuedeAsignarRol('ADMIN', 'PILOTO')).toBe(true);
      expect(actorPuedeAsignarRol('ADMIN', undefined)).toBe(true);
    });
    it('solo Dirección toca a alguien de Dirección', () => {
      expect(actorPuedeTocarUsuario('ADMIN', { rol: 'DIRECCION' })).toBe(false);
      expect(actorPuedeTocarUsuario('DIRECCION', { rol: 'DIRECCION' })).toBe(
        true,
      );
      expect(actorPuedeTocarUsuario('ADMIN', { rol: 'ADMIN' })).toBe(true);
      expect(actorPuedeTocarUsuario('ADMIN', null)).toBe(true);
      expect(CODIGO_SOLO_DIRECCION_USUARIOS).toBe(
        'SOLO_DIRECCION_EDITA_DIRECCION',
      );
      expect(MENSAJE_SOLO_DIRECCION_ASIGNA).toBe(
        'Solo Dirección puede dar el rol de Dirección.',
      );
      expect(MENSAJE_SOLO_DIRECCION_EDITA).toBe(
        'Ese usuario es de Dirección: solo Dirección lo edita.',
      );
    });
  });

  describe('dinero del avión', () => {
    const finanzas = [
      {
        moneda: 'USD',
        ingresos: 24884.44,
        gastos: 1477.27,
        utilidad: 23407.17,
      },
      {
        moneda: 'MXN',
        ingresos: 922227.52,
        gastos: 422482.25,
        utilidad: 499745.27,
      },
    ];
    it('Administración: solo gastos (cobrado y utilidad en null, misma moneda y orden)', () => {
      expect(finanzasParaRol(finanzas, 'ADMIN')).toEqual([
        { moneda: 'USD', gastos: 1477.27, ingresos: null, utilidad: null },
        { moneda: 'MXN', gastos: 422482.25, ingresos: null, utilidad: null },
      ]);
    });
    it('Dirección, ANALISTA y SOCIO: todo (copia, no la misma referencia)', () => {
      for (const r of ['DIRECCION', 'ANALISTA', 'SOCIO', undefined]) {
        const salida = finanzasParaRol(finanzas, r);
        expect(salida).toEqual(finanzas);
        expect(salida[0]).not.toBe(finanzas[0]);
      }
    });
  });
});
