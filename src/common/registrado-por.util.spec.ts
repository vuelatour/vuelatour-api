import {
  adjuntarNombreRegistrado,
  conNombreRegistrado,
  fetchNombresUsuarios,
  idsRegistradoPor,
  USUARIO_NOMBRE_COLS,
} from './registrado-por.util';

/**
 * Cliente Supabase de mentira: cuenta las consultas a `usuario` para poder
 * PROBAR que la resolución es en LOTE (una sola, jamás una por cobro).
 */
function sbFake(
  usuarios: Array<{ id: string; nombre: unknown }>,
  error?: { message: string },
) {
  const llamadas: Array<{ cols: string; ids: string[] }> = [];
  const sb = {
    from(tabla: string) {
      expect(tabla).toBe('usuario');
      return {
        select(cols: string) {
          return {
            in(col: string, ids: string[]) {
              expect(col).toBe('id');
              llamadas.push({ cols, ids });
              return Promise.resolve(
                error
                  ? { data: null, error }
                  : {
                      data: usuarios.filter((u) => ids.includes(u.id)),
                      error: null,
                    },
              );
            },
          };
        },
      };
    },
  };
  // El helper solo usa from/select/in: el cast es a propósito.
  return { sb: sb as never, llamadas };
}

const USUARIOS = [
  { id: 'u-itzi', nombre: 'Itzi' },
  { id: 'u-pablo', nombre: 'Pablo Canales' },
  { id: 'u-vacio', nombre: '   ' },
  { id: 'u-nulo', nombre: null },
];

describe('registrado-por.util (fuente única de registrado_por_nombre)', () => {
  it('idsRegistradoPor: distintos, sin nulls ni basura', () => {
    expect(
      idsRegistradoPor([
        { registrado_por: 'u-itzi' },
        { registrado_por: 'u-itzi' },
        { registrado_por: 'u-pablo' },
        { registrado_por: null },
        { registrado_por: undefined },
        { registrado_por: '' },
        { registrado_por: 42 },
        {},
      ]),
    ).toEqual(['u-itzi', 'u-pablo']);
  });

  it('fetchNombresUsuarios: UNA consulta por lote de ids distintos', async () => {
    const { sb, llamadas } = sbFake(USUARIOS);
    const mapa = await fetchNombresUsuarios(sb, [
      'u-itzi',
      'u-itzi',
      'u-pablo',
      null,
      undefined,
      '',
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].cols).toBe(USUARIO_NOMBRE_COLS);
    expect(llamadas[0].ids).toEqual(['u-itzi', 'u-pablo']);
    expect(mapa.get('u-itzi')).toBe('Itzi');
    expect(mapa.get('u-pablo')).toBe('Pablo Canales');
  });

  it('sin ids: ni una consulta', async () => {
    const { sb, llamadas } = sbFake(USUARIOS);
    expect((await fetchNombresUsuarios(sb, [])).size).toBe(0);
    expect((await fetchNombresUsuarios(sb, [null, ''])).size).toBe(0);
    expect(llamadas).toHaveLength(0);
  });

  it('nombre vacío o no-string NO entra al mapa (nunca un nombre inventado)', async () => {
    const { sb } = sbFake(USUARIOS);
    const mapa = await fetchNombresUsuarios(sb, ['u-vacio', 'u-nulo']);
    expect(mapa.size).toBe(0);
  });

  it('error al leer usuario: mapa vacío, jamás tumba la lista de cobros', async () => {
    const { sb } = sbFake(USUARIOS, { message: 'boom' });
    const mapa = await fetchNombresUsuarios(sb, ['u-itzi']);
    expect(mapa.size).toBe(0);
  });

  it('si la consulta RECHAZA (red caída), tampoco lanza', async () => {
    // `{ data, error }` cubre lo que contesta PostgREST; un rechazo del
    // cliente (DNS, socket) llega como excepción — y el nombre JAMÁS puede
    // tumbar el snapshot del vuelo: `adjuntarSobres` lo mete en Promise.all.
    const sb = {
      from: () => ({
        select: () => ({ in: () => Promise.reject(new Error('ECONNRESET')) }),
      }),
    } as never;
    await expect(fetchNombresUsuarios(sb, ['u-itzi'])).resolves.toEqual(
      new Map(),
    );
  });

  it('conNombreRegistrado: ADITIVO — el resto del objeto queda IDÉNTICO', () => {
    const cobro = {
      id: 'c1',
      vuelo_id: 'v1',
      monto: 600,
      moneda: 'USD',
      metodo_cobro: 'DOLARES',
      tc_usd_mxn: null,
      registrado_por: 'u-itzi',
      cobro_grupo: null,
      conciliado: false,
    };
    const [salida] = conNombreRegistrado(
      [cobro],
      new Map([['u-itzi', 'Itzi']]),
    );
    expect(salida.registrado_por_nombre).toBe('Itzi');
    // Campo por campo: solo se AÑADIÓ la llave nueva.
    const { registrado_por_nombre, ...resto } = salida;
    expect(registrado_por_nombre).toBe('Itzi');
    expect(resto).toEqual(cobro);
    expect(Object.keys(salida)).toEqual([
      ...Object.keys(cobro),
      'registrado_por_nombre',
    ]);
    // La fila sigue siendo un CobroLike utilizable por cobrosEnUsd.
    expect(salida.monto).toBe(600);
    expect(salida.moneda).toBe('USD');
  });

  it('id que no resuelve, usuario borrado o sin registrado_por ⇒ null', () => {
    const salida = conNombreRegistrado(
      [
        { id: 'c1', registrado_por: 'u-borrado' },
        { id: 'c2', registrado_por: null },
        { id: 'c3' },
      ],
      new Map([['u-itzi', 'Itzi']]),
    );
    expect(salida.map((c) => c.registrado_por_nombre)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('adjuntarNombreRegistrado: UNA consulta para toda la lista (cero N+1)', async () => {
    const { sb, llamadas } = sbFake(USUARIOS);
    const salida = await adjuntarNombreRegistrado(sb, [
      { id: 'c1', registrado_por: 'u-itzi' },
      { id: 'c2', registrado_por: 'u-pablo' },
      { id: 'c3', registrado_por: 'u-itzi' },
      { id: 'c4', registrado_por: 'u-borrado' },
      { id: 'c5', registrado_por: null },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].ids).toEqual(['u-itzi', 'u-pablo', 'u-borrado']);
    expect(salida.map((c) => c.registrado_por_nombre)).toEqual([
      'Itzi',
      'Pablo Canales',
      'Itzi',
      null,
      null,
    ]);
  });

  it('lista vacía: ni una consulta y sale vacía', async () => {
    const { sb, llamadas } = sbFake(USUARIOS);
    expect(await adjuntarNombreRegistrado(sb, [])).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it('el nombre se normaliza (espacios de más no viajan al panel)', async () => {
    const { sb } = sbFake([{ id: 'u-x', nombre: '  Ana   María  ' }]);
    const [salida] = await adjuntarNombreRegistrado(sb, [
      { id: 'c1', registrado_por: 'u-x' },
    ]);
    expect(salida.registrado_por_nombre).toBe('Ana María');
  });
});
