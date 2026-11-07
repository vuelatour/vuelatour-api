import { Rol } from './types/auth.types';
import {
  CATEGORIAS_SOLO_DIRECCION,
  CODIGO_CAJA_SOLO_DIRECCION,
  CODIGO_CATEGORIA_SOLO_DIRECCION,
  CODIGO_SOLO_DIRECCION_USUARIOS,
  MENSAJE_CAJA_SOLO_DIRECCION,
  MENSAJE_CATEGORIA_SOLO_DIRECCION,
  MENSAJE_SOLO_DIRECCION_ASIGNA,
  MENSAJE_SOLO_DIRECCION_EDITA,
  actorPuedeAsignarRol,
  actorPuedeTocarUsuario,
  categoriaSoloDireccion,
  esAdminODireccion,
  esAdministracion,
  esDireccion,
  finanzasParaRol,
  fondoEsDeDireccion,
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
