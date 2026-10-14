// El servicio real arrastra pyservices/IA: se stubbea (solo se lee la
// metadata del controller).
jest.mock('./conciliacion.service', () => ({ ConciliacionService: class {} }));

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { ROLES_POR_BUCKET } from '../storage/storage-firma.util';
import { ConciliacionController } from './conciliacion.controller';
import { puedeVerDetalleBanco, ROLES_CONCILIACION } from './roles-conciliacion';

/**
 * QUIÉN VE EL BANCO (13-oct-2026, invariante 71): `ROLES_CONCILIACION` es la
 * fuente única y tiene que coincidir con la metadata de la clase de
 * Conciliación y con el bucket `estados-cuenta` (invariante 37). Si alguien
 * abre uno sin el otro, este spec falla.
 */
describe('ROLES_CONCILIACION — paridad', () => {
  it('es la metadata de la clase ConciliacionController (ADMIN, FACTURACION)', () => {
    const meta: unknown = Reflect.getMetadata(
      ROLES_KEY,
      ConciliacionController,
    );
    expect(meta).toEqual([...ROLES_CONCILIACION]);
    expect(meta).toEqual([Rol.ADMIN, Rol.FACTURACION]);
  });

  it('es la fila «estados-cuenta» de ROLES_POR_BUCKET', () => {
    expect([...ROLES_POR_BUCKET['estados-cuenta']].sort()).toEqual(
      [...ROLES_CONCILIACION].sort(),
    );
  });
});

describe('puedeVerDetalleBanco', () => {
  it('solo ADMIN y FACTURACION', () => {
    expect(puedeVerDetalleBanco(Rol.ADMIN)).toBe(true);
    expect(puedeVerDetalleBanco(Rol.FACTURACION)).toBe(true);
    for (const r of [
      Rol.COORDINADOR,
      Rol.ANALISTA,
      Rol.SOCIO,
      Rol.PILOTO,
      Rol.MECANICO,
      Rol.VISITANTE,
      '',
      null,
      undefined,
    ]) {
      expect(puedeVerDetalleBanco(r)).toBe(false);
    }
  });
});
