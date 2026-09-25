import {
  camposUbicacionDeItem,
  limpiarNombreUbicacion,
  normalizarNombreUbicacion,
  resolverUbicacionDeTexto,
  textoUbicacionExcel,
  ubicacionDuplicada,
  type UbicacionCatalogo,
} from './inventario-ubicacion.util';

/** El catálogo sembrado por la migración 20260925000001 (+ una inactiva). */
const CATALOGO: UbicacionCatalogo[] = [
  { id: 'u-vieja', nombre: 'Oficina vieja', activo: true },
  { id: 'u-nueva', nombre: 'Oficina nueva', activo: true },
  { id: 'u-locker', nombre: 'Locker del aeropuerto', activo: true },
  { id: 'u-mer', nombre: 'Bodega del taller de Mérida', activo: true },
  { id: 'u-czm', nombre: 'Bodega del taller de Cozumel', activo: true },
  { id: 'u-baja', nombre: 'Hangar 3', activo: false },
];

describe('normalizarNombreUbicacion / limpiarNombreUbicacion', () => {
  it('Mérida = Merida = MÉRIDA (sin acentos, minúsculas, espacios colapsados)', () => {
    const k = normalizarNombreUbicacion('Bodega del taller de Mérida');
    expect(normalizarNombreUbicacion('bodega del taller de merida')).toBe(k);
    expect(normalizarNombreUbicacion('  BODEGA  DEL TALLER DE MÉRIDA ')).toBe(
      k,
    );
    expect(k).toBe('bodega del taller de merida');
  });
  it('limpia para guardar: sin espacios de sobra, respeta acentos y mayúsculas', () => {
    expect(limpiarNombreUbicacion('  Locker   del  aeropuerto ')).toBe(
      'Locker del aeropuerto',
    );
    expect(limpiarNombreUbicacion('Mérida')).toBe('Mérida');
  });
});

describe('resolverUbicacionDeTexto — clientes viejos que mandan TEXTO', () => {
  it('coincide con una ACTIVA ⇒ su id y el nombre del catálogo', () => {
    expect(
      resolverUbicacionDeTexto('Bodega del taller de Merida', CATALOGO),
    ).toEqual({
      ubicacion_id: 'u-mer',
      ubicacion: 'Bodega del taller de Mérida',
    });
    expect(resolverUbicacionDeTexto(' oficina NUEVA ', CATALOGO)).toEqual({
      ubicacion_id: 'u-nueva',
      ubicacion: 'Oficina nueva',
    });
  });
  it('NO coincide ⇒ legado tal cual (jamás se adivina «Bodega Cancún» ⇒ catálogo)', () => {
    for (const legado of ['Bodega Cancún', 'Corner', 'Bodega Córner']) {
      expect(resolverUbicacionDeTexto(`  ${legado} `, CATALOGO)).toEqual({
        ubicacion_id: null,
        ubicacion: legado,
      });
    }
  });
  it('una INACTIVA solo se liga si es la que el ítem YA tiene', () => {
    expect(resolverUbicacionDeTexto('Hangar 3', CATALOGO)).toEqual({
      ubicacion_id: null,
      ubicacion: 'Hangar 3',
    });
    expect(resolverUbicacionDeTexto('hangar 3', CATALOGO, 'u-baja')).toEqual({
      ubicacion_id: 'u-baja',
      ubicacion: 'Hangar 3',
    });
  });
  it('texto vacío ⇒ sin id y texto vacío', () => {
    expect(resolverUbicacionDeTexto('   ', CATALOGO)).toEqual({
      ubicacion_id: null,
      ubicacion: '',
    });
  });
});

describe('ubicacionDuplicada', () => {
  it('encuentra el mismo nombre sin acentos ni mayúsculas, excluyendo la que se renombra', () => {
    expect(ubicacionDuplicada('OFICINA NUEVA', CATALOGO)?.id).toBe('u-nueva');
    expect(
      ubicacionDuplicada('bodega del taller de merida', CATALOGO)?.id,
    ).toBe('u-mer');
    expect(ubicacionDuplicada('Oficina nueva', CATALOGO, 'u-nueva')).toBeNull();
    expect(ubicacionDuplicada('Bodega Tulum', CATALOGO)).toBeNull();
  });
});

describe('camposUbicacionDeItem / textoUbicacionExcel', () => {
  it('catálogo: nombre; legado: texto de antes; vacía: todo null', () => {
    expect(
      camposUbicacionDeItem({
        ubicacion: 'Oficina nueva',
        ubicacion_id: 'u-nueva',
      }),
    ).toEqual({
      ubicacion: 'Oficina nueva',
      ubicacion_id: 'u-nueva',
      ubicacion_nombre: 'Oficina nueva',
      ubicacion_legado: null,
    });
    expect(
      camposUbicacionDeItem({ ubicacion: 'Bodega Cancún', ubicacion_id: null }),
    ).toEqual({
      ubicacion: 'Bodega Cancún',
      ubicacion_id: null,
      ubicacion_nombre: null,
      ubicacion_legado: 'Bodega Cancún',
    });
    expect(
      camposUbicacionDeItem({ ubicacion: null, ubicacion_id: null }),
    ).toEqual({
      ubicacion: null,
      ubicacion_id: null,
      ubicacion_nombre: null,
      ubicacion_legado: null,
    });
  });
  it('Excel: «(anterior)» solo al legado y solo con el catálogo', () => {
    expect(
      textoUbicacionExcel(
        { ubicacion: 'Bodega Cancún', ubicacion_id: null },
        true,
      ),
    ).toBe('Bodega Cancún (anterior)');
    expect(
      textoUbicacionExcel(
        { ubicacion: 'Oficina nueva', ubicacion_id: 'u' },
        true,
      ),
    ).toBe('Oficina nueva');
    expect(textoUbicacionExcel({ ubicacion: null }, true)).toBe('');
    expect(textoUbicacionExcel({ ubicacion: 'Bodega Cancún' }, false)).toBe(
      'Bodega Cancún',
    );
  });
});
