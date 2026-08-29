import { normalizarCodigo, pareceCodigoBarras } from './inventario-codigo.util';
import {
  claveItem,
  normalizarClave,
  validarFilasInventario,
  type CatalogoImportInventario,
} from './inventario-masivo.util';

// Caso real del cliente (28-ago-2026): botella AeroShell W15W-50 1 qt
// (UPC 0 21400 06215 3) y su caja de 6 (ITF-14 0 00 21400 06216 0).
const AEROSHELL = {
  fila: 2,
  nombre: 'Aceite AeroShell W15W-50 1 qt',
  marca: 'AeroShell',
  categoria: 'aceites',
  numero_parte: '550050835',
  codigo: '0 21400 06215 3',
  unidad: 'botella',
  descripcion: 'Aceite multigrado 15W-50 para motores de pistón, 946 mL',
  ubicacion: null,
  stock_minimo: 12,
  existencia_inicial: 24,
  costo_unitario: 320.5,
  moneda: 'MXN',
  tipo_cambio: 18.2,
  empaque_nombre: 'Caja de 6',
  empaque_factor: 6,
  empaque_codigo: '0 00 21400 06216 0',
  notas: null,
};

const CATALOGO: CatalogoImportInventario = {
  categorias: ['Aceites', 'Filtros'],
  items: [
    {
      id: 'i1',
      nombre: 'Filtro de aceite CH48110',
      numero_parte: 'CH48110',
      codigo: '012345678905',
      activo: true,
    },
    {
      id: 'i2',
      nombre: 'Bujía REM38E',
      numero_parte: null,
      codigo: null,
      activo: false,
    },
  ],
  empaques: [
    { codigo: '10012345678902', item_nombre: 'Filtro de aceite CH48110' },
  ],
};

describe('normalizarCodigo', () => {
  it('quita espacios internos y externos (lo que imprime el UPC)', () => {
    expect(normalizarCodigo(' 0 21400 06215 3 ')).toBe('021400062153');
  });
  it('vacío o null → null', () => {
    expect(normalizarCodigo('')).toBeNull();
    expect(normalizarCodigo('   ')).toBeNull();
    expect(normalizarCodigo(null)).toBeNull();
    expect(normalizarCodigo(undefined)).toBeNull();
  });
  it('un número de Excel se vuelve texto entero sin notación científica', () => {
    expect(normalizarCodigo(21400062153)).toBe('21400062153');
    expect(normalizarCodigo('2.1400062153E10')).toBe('21400062153');
    expect(normalizarCodigo('2.14E+10')).toBe('21400000000');
    expect(normalizarCodigo('2.14e10')).toBe('21400000000');
    expect(normalizarCodigo('2E+10')).toBe('20000000000');
  });
  it('un SKU alfanumérico tipo "1E5" NO es notación científica', () => {
    expect(normalizarCodigo('1E5')).toBe('1E5');
    expect(normalizarCodigo('12e3')).toBe('12e3');
    expect(normalizarCodigo('CH48110')).toBe('CH48110');
  });
  it('EAN-13 con prefijo 0 se canoniza al UPC-A de 12 dígitos', () => {
    expect(normalizarCodigo('0021400062153')).toBe('021400062153');
    expect(normalizarCodigo('0 021400 062153')).toBe('021400062153');
    // Ya canónico (12 dígitos con 0 inicial): no se toca.
    expect(normalizarCodigo('021400062153')).toBe('021400062153');
    // EAN-13 real (no empieza con 0), ITF-14 y letras: intactos.
    expect(normalizarCodigo('7501234567890')).toBe('7501234567890');
    expect(normalizarCodigo('00021400062160')).toBe('00021400062160');
    expect(normalizarCodigo('0ABC123456789')).toBe('0ABC123456789');
  });
  it('objetos no son códigos', () => {
    expect(normalizarCodigo({})).toBeNull();
    expect(normalizarCodigo([])).toBeNull();
  });
  it('pareceCodigoBarras: solo dígitos, 8–14', () => {
    expect(pareceCodigoBarras('021400062153')).toBe(true);
    expect(pareceCodigoBarras('00021400062160')).toBe(true);
    expect(pareceCodigoBarras('1234567')).toBe(false);
    expect(pareceCodigoBarras('CH48110')).toBe(false);
  });
});

describe('normalizarClave / claveItem', () => {
  it('tolera acentos, mayúsculas y paréntesis de los encabezados', () => {
    expect(normalizarClave('Código de barras (unidad)')).toBe(
      'codigo_de_barras_unidad',
    );
    expect(normalizarClave('Número de parte')).toBe('numero_de_parte');
  });
  it('la llave nombre+parte ignora acentos y espacios', () => {
    expect(claveItem('  Bujía   REM38E ', null)).toBe(
      claveItem('bujia rem38e', ''),
    );
  });
});

describe('validarFilasInventario — fila completa', () => {
  const [r] = validarFilasInventario([AEROSHELL], CATALOGO);

  it('queda OK con ítem, empaque y entrada inicial', () => {
    expect(r.estado).toBe('OK');
    expect(r.crear.item.codigo).toBe('021400062153');
    expect(r.crear.item.marca).toBe('AeroShell');
    expect(r.crear.item.ubicacion).toBe('Bodega Cancún');
    expect(r.crear.item.stock_minimo).toBe(12);
    expect(r.crear.empaque).toEqual({
      nombre: 'Caja de 6',
      factor: 6,
      codigo: '00021400062160',
    });
    expect(r.crear.entrada_inicial).toEqual({
      cantidad: 24,
      moneda: 'MXN',
      costo_unitario_mxn: 320.5,
      tc_usd_mxn: 18.2,
    });
  });
  it('usa la capitalización de la categoría existente', () => {
    expect(r.crear.item.categoria).toBe('Aceites');
    expect(r.mensajes).toEqual([]);
  });
});

describe('validarFilasInventario — reglas por fila', () => {
  it('nombre y categoría son obligatorios', () => {
    const [r] = validarFilasInventario(
      [{ fila: 2, nombre: '', categoria: null }],
      CATALOGO,
    );
    expect(r.estado).toBe('ERROR');
    expect(r.mensajes.join(' ')).toMatch(/nombre/);
    expect(r.mensajes.join(' ')).toMatch(/categoría/);
  });

  it('existencia > 0 exige costo, y en MXN el tipo de cambio', () => {
    const [sinCosto, sinTc, usdOk] = validarFilasInventario(
      [
        { fila: 2, nombre: 'A', categoria: 'Aceites', existencia_inicial: 3 },
        {
          fila: 3,
          nombre: 'B',
          categoria: 'Aceites',
          existencia_inicial: 3,
          costo_unitario: 10,
        },
        {
          fila: 4,
          nombre: 'C',
          categoria: 'Aceites',
          existencia_inicial: 3,
          costo_unitario: 10,
          moneda: 'usd',
        },
      ],
      CATALOGO,
    );
    expect(sinCosto.estado).toBe('ERROR');
    expect(sinCosto.mensajes.join(' ')).toMatch(/costo unitario/);
    expect(sinTc.estado).toBe('ERROR');
    expect(sinTc.mensajes.join(' ')).toMatch(/tipo de cambio/);
    expect(usdOk.estado).toBe('OK');
    expect(usdOk.crear.entrada_inicial).toEqual({
      cantidad: 3,
      moneda: 'USD',
      costo_unitario_usd: 10,
    });
  });

  it('existencia en USD con tipo de cambio lo conserva en la entrada inicial', () => {
    const [r] = validarFilasInventario(
      [
        {
          fila: 2,
          nombre: 'Bujía USD',
          categoria: 'Bujías',
          existencia_inicial: 8,
          costo_unitario: 25,
          moneda: 'USD',
          tipo_cambio: 18.2,
        },
      ],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
    expect(r.crear.entrada_inicial).toEqual({
      cantidad: 8,
      moneda: 'USD',
      costo_unitario_usd: 25,
      tc_usd_mxn: 18.2,
    });
  });

  it('el mismo producto escaneado como EAN-13 (0 + UPC) choca con el código ya registrado', () => {
    const [r] = validarFilasInventario(
      [
        {
          fila: 2,
          nombre: 'Otro filtro',
          categoria: 'Filtros',
          codigo: '0012345678905',
        },
      ],
      CATALOGO,
    );
    expect(r.estado).toBe('DUPLICADO');
    expect(r.mensajes[0]).toMatch(/012345678905/);
  });

  it('sin existencia no hay entrada (y avisa si traía costo)', () => {
    const [r] = validarFilasInventario(
      [{ fila: 2, nombre: 'A', categoria: 'Aceites', costo_unitario: 10 }],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
    expect(r.crear.entrada_inicial).toBeUndefined();
    expect(r.mensajes.join(' ')).toMatch(/Sin existencia inicial/);
  });

  it('una unidad numérica se rechaza (la cantidad va en existencia)', () => {
    const [r] = validarFilasInventario(
      [{ fila: 2, nombre: 'A', categoria: 'Aceites', unidad: '1' }],
      CATALOGO,
    );
    expect(r.estado).toBe('ERROR');
    expect(r.mensajes.join(' ')).toMatch(/unidad/);
  });

  it('categoría nueva es OK con aviso', () => {
    const [r] = validarFilasInventario(
      [{ fila: 2, nombre: 'A', categoria: 'Llantas' }],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
    expect(r.crear.item.categoria).toBe('Llantas');
    expect(r.mensajes.join(' ')).toMatch(/Categoría nueva/);
  });

  it('empaque: exige unidades por empaque, nombre por default y código distinto al de la unidad', () => {
    const [sinFactor, sinNombre, mismoCodigo] = validarFilasInventario(
      [
        { fila: 2, nombre: 'A', categoria: 'Aceites', empaque_nombre: 'Caja' },
        { fila: 3, nombre: 'B', categoria: 'Aceites', empaque_factor: 12 },
        {
          fila: 4,
          nombre: 'C',
          categoria: 'Aceites',
          codigo: '021400062153',
          empaque_factor: 6,
          empaque_codigo: '0 21400 06215 3',
        },
      ],
      CATALOGO,
    );
    expect(sinFactor.estado).toBe('ERROR');
    expect(sinFactor.mensajes.join(' ')).toMatch(/unidades por empaque/);
    expect(sinNombre.estado).toBe('OK');
    expect(sinNombre.crear.empaque).toEqual({
      nombre: 'Caja de 12',
      factor: 12,
      codigo: null,
    });
    expect(mismoCodigo.estado).toBe('ERROR');
    expect(mismoCodigo.mensajes.join(' ')).toMatch(/mismo que el de la unidad/);
  });

  it('tolera los encabezados de la plantilla como claves', () => {
    const [r] = validarFilasInventario(
      [
        {
          fila: 2,
          'Nombre*': 'Aceite X',
          'Categoría*': 'Aceites',
          'Código de barras (unidad)': '0 21400 06215 3',
          'Unidades por empaque': '6',
          'Código de barras del empaque': '00021400062160',
        },
      ],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
    expect(r.crear.item.codigo).toBe('021400062153');
    expect(r.crear.empaque?.factor).toBe(6);
  });

  it('un código leído como número avisa del posible cero perdido', () => {
    const [r] = validarFilasInventario(
      [{ fila: 2, nombre: 'A', categoria: 'Aceites', codigo: 21400062153 }],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
    expect(r.crear.item.codigo).toBe('21400062153');
    expect(r.mensajes.join(' ')).toMatch(/formato TEXTO/);
  });
});

describe('validarFilasInventario — duplicados (idempotencia)', () => {
  it('código ya registrado en un ítem o en un empaque → DUPLICADO', () => {
    const [porItem, porEmpaque] = validarFilasInventario(
      [
        {
          fila: 2,
          nombre: 'Nuevo 1',
          categoria: 'Aceites',
          codigo: '012345678905',
        },
        {
          fila: 3,
          nombre: 'Nuevo 2',
          categoria: 'Aceites',
          codigo: '10012345678902',
        },
      ],
      CATALOGO,
    );
    expect(porItem.estado).toBe('DUPLICADO');
    expect(porItem.mensajes[0]).toMatch(/Filtro de aceite CH48110/);
    expect(porEmpaque.estado).toBe('DUPLICADO');
    expect(porEmpaque.mensajes[0]).toMatch(/empaque/);
  });

  it('nombre + número de parte ya existentes → DUPLICADO (aunque esté inactivo)', () => {
    const [a, b] = validarFilasInventario(
      [
        {
          fila: 2,
          nombre: 'filtro de aceite ch48110',
          categoria: 'Filtros',
          numero_parte: 'ch48110',
        },
        { fila: 3, nombre: 'Bujia REM38E', categoria: 'Bujías' },
      ],
      CATALOGO,
    );
    expect(a.estado).toBe('DUPLICADO');
    expect(b.estado).toBe('DUPLICADO');
    expect(b.mensajes[0]).toMatch(/inactivo/);
  });

  it('mismo nombre pero distinto número de parte NO es duplicado', () => {
    const [r] = validarFilasInventario(
      [
        {
          fila: 2,
          nombre: 'Filtro de aceite CH48110',
          categoria: 'Filtros',
          numero_parte: 'CH48110-1',
        },
      ],
      CATALOGO,
    );
    expect(r.estado).toBe('OK');
  });

  it('duplicados DENTRO del archivo apuntan a la primera fila', () => {
    const [ok, dupCodigo, dupEmpaque, dupNombre] = validarFilasInventario(
      [
        { ...AEROSHELL, fila: 2 },
        {
          fila: 3,
          nombre: 'Otro',
          categoria: 'Aceites',
          codigo: '021400062153',
        },
        {
          fila: 4,
          nombre: 'Otro más',
          categoria: 'Aceites',
          codigo: '00021400062160',
        },
        {
          fila: 5,
          nombre: AEROSHELL.nombre,
          categoria: 'Aceites',
          numero_parte: AEROSHELL.numero_parte,
        },
      ],
      CATALOGO,
    );
    expect(ok.estado).toBe('OK');
    expect(dupCodigo.estado).toBe('DUPLICADO');
    expect(dupCodigo.mensajes[0]).toMatch(/fila 2/);
    expect(dupEmpaque.estado).toBe('DUPLICADO');
    expect(dupEmpaque.mensajes[0]).toMatch(/fila 2/);
    expect(dupNombre.estado).toBe('DUPLICADO');
    expect(dupNombre.mensajes[0]).toMatch(/fila 2/);
  });
});
