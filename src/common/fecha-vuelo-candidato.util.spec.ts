import { fechaVueloDe } from './fecha-vuelo-candidato.util';

describe('fechaVueloDe (invariante 54)', () => {
  it('conserva el ISO del vuelo y convierte lo demás en null', () => {
    expect(fechaVueloDe('2026-10-04T15:00:00+00:00')).toBe(
      '2026-10-04T15:00:00+00:00',
    );
    expect(fechaVueloDe('')).toBeNull();
    expect(fechaVueloDe('   ')).toBeNull();
    expect(fechaVueloDe(null)).toBeNull();
    expect(fechaVueloDe(undefined)).toBeNull();
    expect(fechaVueloDe(20261004)).toBeNull();
  });
});
