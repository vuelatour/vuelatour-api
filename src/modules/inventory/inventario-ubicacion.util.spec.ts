import {
  camposUbicacionDeItem,
  limpiarNombreUbicacion,
  mensajeNoEliminable,
  normalizarNombreUbicacion,
  planOrdenUbicaciones,
  resolverUbicacionDeTexto,
  textoCantidadProductos,
  textoUbicacionExcel,
  ubicacionDuplicada,
  type UbicacionCatalogo,
  type UbicacionOrdenable,
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

describe('mensajeNoEliminable — DELETE ubicaciones/:id (28-sep-2026)', () => {
  it('singular y plural de «producto»', () => {
    expect(textoCantidadProductos(1)).toBe('1 producto');
    expect(textoCantidadProductos(0)).toBe('0 productos');
    expect(textoCantidadProductos(12)).toBe('12 productos');
  });
  it('solo activos ⇒ «muévelos con «Mover a…» y vuelve a intentar»', () => {
    expect(mensajeNoEliminable('Oficina nueva', 1, 1)).toBe(
      '«Oficina nueva» tiene 1 producto: muévelo con «Mover a…» y vuelve a intentar.',
    );
    expect(mensajeNoEliminable('Oficina vieja', 3, 3)).toBe(
      '«Oficina vieja» tiene 3 productos: muévelos con «Mover a…» y vuelve a intentar.',
    );
  });
  it('solo dados de baja ⇒ no se mandan a mover (el panel no los mueve): desactívala', () => {
    expect(mensajeNoEliminable('Hangar 3', 2, 0)).toBe(
      '«Hangar 3» la usan 2 productos dados de baja (historial): no se puede eliminar; desactívala para que ya no se ofrezca.',
    );
    expect(mensajeNoEliminable('Hangar 3', 1, 0)).toContain(
      '1 producto dado de baja',
    );
  });
  it('mezcla ⇒ dice las dos cosas (moverlos no bastará)', () => {
    const m = mensajeNoEliminable('Locker del aeropuerto', 3, 2);
    expect(m).toContain('tiene 2 productos: muévelos con «Mover a…»');
    expect(m).toContain('1 producto dado de baja');
    expect(m).toContain('desactívala');
  });
});

describe('planOrdenUbicaciones — PUT ubicaciones/orden (28-sep-2026)', () => {
  const CAT: UbicacionOrdenable[] = [
    { id: 'u-vieja', orden: 1, activo: true },
    { id: 'u-nueva', orden: 2, activo: true },
    { id: 'u-locker', orden: 3, activo: true },
    { id: 'u-baja', orden: 4, activo: false },
    { id: 'u-mer', orden: 5, activo: true },
  ];

  it('activas en el orden pedido, la inactiva al final; SOLO se escriben las que cambian', () => {
    const r = planOrdenUbicaciones(CAT, [
      'u-nueva',
      'u-vieja',
      'u-locker',
      'u-mer',
    ]);
    expect(r).toEqual({
      ok: true,
      secuencia: ['u-nueva', 'u-vieja', 'u-locker', 'u-mer', 'u-baja'],
      cambios: [
        { id: 'u-nueva', orden: 1 },
        { id: 'u-vieja', orden: 2 },
        { id: 'u-mer', orden: 4 },
        { id: 'u-baja', orden: 5 },
      ],
    });
  });

  it('también acepta la lista COMPLETA con inactivas donde el panel las pinta', () => {
    const r = planOrdenUbicaciones(CAT, [
      'u-baja',
      'u-vieja',
      'u-nueva',
      'u-locker',
      'u-mer',
    ]);
    expect(r.ok && r.secuencia[0]).toBe('u-baja');
  });

  it('el mismo orden de hoy ⇒ cero escrituras', () => {
    const r = planOrdenUbicaciones(
      [
        { id: 'a', orden: 1, activo: true },
        { id: 'b', orden: 2, activo: true },
      ],
      ['a', 'b'],
    );
    expect(r).toEqual({ ok: true, secuencia: ['a', 'b'], cambios: [] });
  });

  it('órdenes repetidos o con huecos (datos viejos) se vuelven 1..n', () => {
    const r = planOrdenUbicaciones(
      [
        { id: 'a', orden: 0, activo: true },
        { id: 'b', orden: 0, activo: true },
        { id: 'c', orden: 9, activo: true },
      ],
      ['a', 'b', 'c'],
    );
    expect(r.ok && r.cambios).toEqual([
      { id: 'a', orden: 1 },
      { id: 'b', orden: 2 },
      { id: 'c', orden: 3 },
    ]);
  });

  it('lista VIEJA: falta una activa, sobra una borrada o hay repetidos ⇒ se rechaza entera', () => {
    expect(
      planOrdenUbicaciones(CAT, ['u-nueva', 'u-vieja', 'u-locker']),
    ).toEqual({
      ok: false,
      faltan: ['u-mer'],
      desconocidos: [],
      repetidos: [],
    });
    expect(
      planOrdenUbicaciones(CAT, [
        'u-vieja',
        'u-nueva',
        'u-locker',
        'u-mer',
        'u-borrada',
      ]),
    ).toEqual({
      ok: false,
      faltan: [],
      desconocidos: ['u-borrada'],
      repetidos: [],
    });
    expect(
      planOrdenUbicaciones(CAT, [
        'u-vieja',
        'u-nueva',
        'u-vieja',
        'u-locker',
        'u-mer',
      ]),
    ).toEqual({
      ok: false,
      faltan: [],
      desconocidos: [],
      repetidos: ['u-vieja'],
    });
  });
});
