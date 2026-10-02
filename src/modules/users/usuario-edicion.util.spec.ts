import {
  CAMPOS_EDITABLES_COORDINADOR,
  CODIGO_SOLO_ADMIN_EDITA_USUARIOS,
  CODIGO_TARJETA_DE_OTRO_USUARIO,
  MENSAJE_SOLO_ADMIN_EDITA_USUARIOS,
  MENSAJE_USUARIO_DE_OFICINA,
  camposFueraDeAlcanceCoordinador,
  esDestinoEditablePorCoordinador,
  mensajeCamposSoloAdmin,
  mensajeTarjetaDeOtroUsuario,
  tarjetaEsDeOtro,
} from './usuario-edicion.util';

/**
 * Edición de datos del piloto por la coordinación (2-oct-2026): los textos y
 * la decisión del candado viven en el helper PURO; aquí se congelan.
 */
describe('usuario-edicion.util', () => {
  it('códigos y textos del contrato (es-MX)', () => {
    expect(CODIGO_SOLO_ADMIN_EDITA_USUARIOS).toBe('SOLO_ADMIN_EDITA_USUARIOS');
    expect(CODIGO_TARJETA_DE_OTRO_USUARIO).toBe('TARJETA_DE_OTRO_USUARIO');
    expect(MENSAJE_USUARIO_DE_OFICINA).toBe(
      'Ese usuario es de oficina: solo un ADMIN lo edita',
    );
    expect(MENSAJE_SOLO_ADMIN_EDITA_USUARIOS).toBe(
      'Solo un ADMIN edita usuarios.',
    );
    expect([...CAMPOS_EDITABLES_COORDINADOR]).toEqual([
      'nombre',
      'telefono',
      'apodo',
      'tarjeta_terminacion',
    ]);
  });

  describe('esDestinoEditablePorCoordinador', () => {
    it('piloto de base y piloto externo: sí', () => {
      expect(esDestinoEditablePorCoordinador({ rol: 'PILOTO' })).toBe(true);
      expect(
        esDestinoEditablePorCoordinador({
          rol: 'PILOTO',
          es_piloto_externo: true,
        }),
      ).toBe(true);
      // Externo con otro rol (dato raro, pero la bandera manda).
      expect(
        esDestinoEditablePorCoordinador({
          rol: 'MECANICO',
          es_piloto_externo: true,
        }),
      ).toBe(true);
    });

    it('oficina que también vuela (Pablo Canales: ADMIN + es_piloto): NO', () => {
      for (const rol of [
        'ADMIN',
        'COORDINADOR',
        'FACTURACION',
        'ANALISTA',
        'SOCIO',
      ]) {
        expect(
          esDestinoEditablePorCoordinador({
            rol,
            es_piloto_externo: false,
          }),
        ).toBe(false);
      }
      expect(esDestinoEditablePorCoordinador({ rol: null })).toBe(false);
    });
  });

  describe('camposFueraDeAlcanceCoordinador', () => {
    it('solo cuenta lo PRESENTE (undefined = ausente, como en el DTO ES2022)', () => {
      expect(
        camposFueraDeAlcanceCoordinador({
          nombre: 'Abraham Zamora',
          telefono: '+52 9981234567',
          apodo: null,
          tarjeta_terminacion: null,
          rol: undefined,
          estado: undefined,
          tiene_fondo_caja: undefined,
          es_piloto: undefined,
          es_piloto_externo: undefined,
          avatar_url: undefined,
        }),
      ).toEqual([]);
    });

    it('un campo de ADMIN presente (aunque sea false o null) sale', () => {
      expect(
        camposFueraDeAlcanceCoordinador({
          nombre: 'X',
          rol: 'ADMIN',
          tiene_fondo_caja: false,
          es_piloto: null,
        }),
      ).toEqual(['rol', 'tiene_fondo_caja', 'es_piloto']);
    });
  });

  describe('mensajeCamposSoloAdmin', () => {
    it('nombra lo prohibido y lo que sí se puede', () => {
      expect(mensajeCamposSoloAdmin(['rol'])).toBe(
        'Solo un ADMIN cambia rol. Desde Pilotos puedes editar nombre, teléfono, nombre corto y tarjeta corp.',
      );
      expect(mensajeCamposSoloAdmin(['estado', 'tiene_fondo_caja'])).toBe(
        'Solo un ADMIN cambia estado y fondo de caja chica. Desde Pilotos puedes editar nombre, teléfono, nombre corto y tarjeta corp.',
      );
      expect(
        mensajeCamposSoloAdmin(['es_piloto', 'es_piloto_externo', 'otro']),
      ).toBe(
        'Solo un ADMIN cambia «también es piloto», «piloto externo» y otro. Desde Pilotos puedes editar nombre, teléfono, nombre corto y tarjeta corp.',
      );
    });
  });

  describe('tarjeta', () => {
    it('mensaje con el dueño; sin nombre ⇒ «otro usuario»', () => {
      expect(mensajeTarjetaDeOtroUsuario('Luis Cáceres')).toBe(
        'Esa tarjeta es de Luis Cáceres: un ADMIN la reasigna desde Tarjetas corp.',
      );
      expect(mensajeTarjetaDeOtroUsuario('  ')).toBe(
        'Esa tarjeta es de otro usuario: un ADMIN la reasigna desde Tarjetas corp.',
      );
      expect(mensajeTarjetaDeOtroUsuario(null)).toContain('otro usuario');
    });

    it('libre o del destino ⇒ se puede; de otro ⇒ no', () => {
      expect(tarjetaEsDeOtro({ usuario_id: null }, 'p-1')).toBe(false);
      expect(tarjetaEsDeOtro({ usuario_id: 'p-1' }, 'p-1')).toBe(false);
      expect(tarjetaEsDeOtro(null, 'p-1')).toBe(false);
      expect(tarjetaEsDeOtro({ usuario_id: 'otro' }, 'p-1')).toBe(true);
    });
  });
});
