import type { MovCardex } from './inventario-cardex.util';

/**
 * CARDEX REAL DE PRODUCCIÓN (SELECT del 25-sep-2026, `bjesduasnzbzywofukbf`):
 * los 81 movimientos de `inventario_movimiento` (68 ENTRADA + 13 SALIDA, 66
 * productos), con las 10 salidas del 01-sep ya re-preciadas a costo + 25 %
 * (migración 20260925000002). Datos para los specs — el nombre `*-spec.ts`
 * lo deja FUERA del build (tsconfig.build excluye `**\/*spec.ts`) y fuera de
 * jest (no es `.spec.ts`).
 *
 * `cardexProd25sep({ tcOficial })`: sin T.C. (estado HOY, antes de la
 * migración 20260925000003) o con el T.C. oficial de su día que pone esa
 * migración (entradas del 29-ago a 17.0115; entradas y salidas del 01-sep a
 * 17.0077). Las 4 filas en PESOS (aceite 13-jul y sus 3 salidas) conservan
 * su 17.51 en los dos casos.
 */

type Tupla = [
  id: string,
  item: string,
  tipo: 'E' | 'S',
  cantidad: number,
  costoUsd: number,
  moneda: 'MXN' | 'USD',
  costoMxn: number | null,
  tc: number | null,
  venta: number | null,
  ventaMoneda: 'MXN' | 'USD' | null,
  fecha: string,
  creado: string,
  matricula: string | null,
];

// prettier-ignore
const FILAS: Tupla[] = [
  ['1acc986f-2873-4b50-8ca1-9becb7ac19a8','01146f1d','E',1,656.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['fd08305b-120e-499f-9d51-49d626687d3b','04b2c4e7','E',1,8902.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['00aaf998-242c-4bd8-a5a6-3ae5594790ad','0609ea06','E',2,197.19,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['d244a14d-0278-4429-8a0e-e78facd17250','08f6657e','E',3,18.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['432b15ef-61af-4c58-a143-11ca699fafa1','099e1746','E',2,868.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['871bc117-9a71-4553-8b1e-9404c4d53ff3','11419024','E',1,9875,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['66df5232-1657-4416-b9d7-769f93c0e48c','1454844b','E',1,144.81,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['24de2a04-6c4e-438a-b283-b4ef97cb02fd','234bdbad','E',1,287.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['ef31a3de-961f-4e9f-972c-7b1a2c94a7a0','2452803b','E',1,31.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['8f39ae95-8f12-4ccc-9c74-29a039c21e07','26134168','E',1,373.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['6679dadb-b87c-4594-9599-b03dcceac491','2b95f80f','E',4,69.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['27ea9605-0b5c-4f51-8253-120446c8930b','2b996511','E',1,30,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['8f88820b-6c30-41ca-8951-9d7e1ed88e73','2cc43fd7','E',1,515,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['0667f53b-93c3-4a68-bd8a-e32c5e3f83c9','2d4983fb','E',1,2093.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['575fce09-36ce-464f-8d2c-a5e477311734','32697ed1','E',1,350,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['94fe794a-b180-455a-aa42-f5444101e516','342c9a83','E',1,225,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['9103637c-f581-468b-b47e-b41c2c4c7cc9','34b1bf66','E',3,46.06,'USD',null,null,null,null,'09-01','09-21T14:19:20.890717',null],
  ['e8920cba-2c8d-427a-b36c-13683630d1f1','34b1bf66','S',2,46.06,'USD',null,null,57.575,'USD','09-01','09-22T14:18:11.479114','N4142R'],
  ['9ec8ccc2-7f3f-4585-868f-ae98e4ace08f','3d8927a7','E',2,405,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['35e9ae3c-456e-47bb-b16b-d515d83cdba2','416ddfba','E',2,249.69,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['68db3ae2-4252-4bf6-b3be-25a392816842','44b15206','E',2,21.88,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['55fc8864-83e9-4787-a83b-51750535a0c9','4a1dafaa','E',1,279.66,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['338573a6-9a2d-40f2-b9f2-ca84b63dd14b','4aba55d1','E',1,3107.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['dc1a7956-adf6-4a93-932b-90522c42cb25','4b6c4c34','E',1,875,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['a90b8f34-3781-4ee1-873b-7a23c03e8511','50079b53','E',1,50,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['142888c2-2ab4-441e-a8e9-649d9cc97410','50079b53','S',1,50,'USD',null,null,62.5,'USD','09-01','09-22T14:35:52.444391','N4142R'],
  ['590445ca-cedb-47d2-801d-1c7aa09555d2','53d05d76','E',9,21.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['3cf7e798-75f0-4308-8390-af2a04cae5b7','590914d4','E',1,1202.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['2abb3e9a-835d-4286-a8e9-0c8e84025133','5d442562','E',3,0.94,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['c885419c-c53f-4f24-9d6e-1251802c798f','5d6d9595','E',1,43.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['4f17f525-56ce-476c-8141-da5ba89d8a58','5f565c5f','E',7,104.69,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['242afa43-8f99-4ac7-ae4b-75ac4693c382','6189efa2','E',12,23.13,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['72b9b33f-facb-4cb7-8677-def258c921d1','6189efa2','S',4,23.13,'USD',null,null,28.9125,'USD','09-01','09-22T14:34:49.272946','XA-VGV'],
  ['0c313a22-3d91-4339-bb03-9c88e9c5743b','61b83a6f','E',1,312.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['bc17f68d-192c-48fb-bded-84fd206ff218','626a8ad1','E',2,373.75,'USD',null,null,null,null,'09-01','09-21T14:50:24.425815',null],
  ['2872370e-c9d1-4926-b0aa-69251621dc99','626a8ad1','S',1,373.75,'USD',null,null,467.1875,'USD','09-01','09-22T14:31:34.515404','XA-VGV'],
  ['e71c2c97-38e2-421e-af31-537ee8c97fe9','626a8ad1','S',1,373.75,'USD',null,null,467.1875,'USD','09-01','09-22T14:33:24.034366','N4142R'],
  ['8f74496a-1b96-4d14-9b09-3e098e950ecf','63685f3e','E',1,150,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['5cb9c61b-84e5-40e4-9272-782b62a437bd','64469d24','E',1,187.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['a8ec6e3e-df62-44d6-9b19-1bd44c901b21','69bbb336','E',1,400,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['f401beba-efb8-4019-9ad5-cc90299bc7c3','715b2f17','E',1,292.44,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['81f71d95-f583-45a0-a4ba-3a26489ebaf4','729c0e1e','E',1,400,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['806a846a-f5e6-44c7-b2ce-0832b8fb7b24','734f3a03','E',1,68.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['ed3979ac-a79c-43b3-b64e-ff9677e17499','7d891988','E',1,162.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['d7c6df6c-d6f6-41a7-8e78-71539fcd8f60','85291425','E',2,25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['65141017-4912-415d-9c4f-30febfd34ba7','8ebc459e','E',1,49.94,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['4e345092-b749-407b-8268-4f6f46f3687c','9770148d','E',1,1202.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['66892b07-6ec1-4b4d-8a4d-a721d3af8f5f','984ca21d','E',1,2503.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['16848dbd-5ed0-4367-8c1e-1705d87ad103','a6857bd8','E',2,9541.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['efda3e2d-89cb-403a-8d4b-662e2338bdb2','a6f38a8c','E',8,29.38,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['a1fdd813-e576-4494-b6ab-1e837ea09b33','a96a2949','E',2,68.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['3b067bad-c73f-4765-9b15-798f231b0a6f','b0483153','E',20,1.88,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['527aa19a-87b9-4fa7-8b53-765ed348833b','bbcb33c4','E',1,174.81,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['d7ae27ea-52b7-4558-b651-99d9b1cbecd7','c024f428','E',1,112.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['70f3e516-d80b-4684-8bde-fccf4e7cea03','c60f0ce4','E',1,116.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['5046a2e8-7762-427d-adc3-cd7ec31978a2','cb42d6ef','E',1,87.5,'USD',null,null,null,null,'08-29','08-29T17:36:43.664900',null],
  ['6151ccc6-ce34-418d-b198-bc500d725d12','cb677dbb','E',2,155.94,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['8452b4f4-e7fb-4632-972a-a3f7d2bb948c','cb677dbb','S',1,155.94,'USD',null,null,194.925,'USD','09-01','09-22T14:27:25.220106','N4142R'],
  ['93bef2f9-6cb2-4431-b8e2-72f774a03a6e','cdf50620','E',2,1781.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['c38dfdaa-fafe-4021-acc1-76ebf90d64d4','cea0ac2c','E',1,1731.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['8d366e4a-ce3c-45f6-aa2b-97e6b58e180f','cfc395c2','E',1,46.06,'USD',null,null,null,null,'09-01','09-21T14:23:04.509301',null],
  ['7e00d444-0e8a-4be0-999d-2c2755a858c3','cfc395c2','E',3,46.06,'USD',null,null,null,null,'09-01','09-21T14:24:03.774900',null],
  ['63c2a335-98e3-45f6-a665-6ba8b9d07807','cfc395c2','S',1,46.06,'USD',null,null,57.575,'USD','09-01','09-22T14:21:42.478630','XA-VGV'],
  ['40b788a9-5d9f-426d-baf8-3915789759fd','cfe18eef','E',2,46.06,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['7446034f-0ce1-4d91-ae6c-ba2952bc8278','d2f84c17','E',1,1625,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['e3f20592-3282-4506-b154-8590ea8eeb84','d99df930','E',30,94.71,'MXN',1658.33,17.51,null,null,'07-13','07-13T15:37:31.991531',null],
  ['d45dae06-7478-4f33-a412-00ae6a57e588','d99df930','S',4,94.71,'MXN',1658.33,17.51,null,null,'07-17','07-20T16:46:52.485836','N4142R'],
  ['a9378a18-54e1-4259-b65a-35de6dd533c0','d99df930','S',2,94.71,'MXN',1658.33,17.51,null,null,'07-20','07-20T16:48:21.530909','XB-PEV'],
  ['533fce35-6088-432b-b41f-a242aa471b42','d99df930','S',24,94.71,'MXN',1658.33,17.51,null,null,'08-06','08-07T20:07:07.655395','N990GG'],
  ['a614e7af-6b74-4f97-8a34-1277c97ffcf0','d99df930','E',120,21.25,'USD',null,null,null,null,'08-29','08-29T17:36:43.664900',null],
  ['40da8327-e60f-41aa-a061-8071ed1f9fc3','d99df930','S',12,21.25,'USD',null,null,26.5625,'USD','09-01','09-22T14:13:06.388548','XA-VGV'],
  ['19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7','d99df930','S',24,21.25,'USD',null,null,26.5625,'USD','09-01','09-22T14:14:18.318367','N4142R'],
  ['8d6030b0-e8dc-4e94-bf5f-1ee60efeb6a4','db12c501','E',1,141.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['9ed76af1-2544-4e4f-ab99-7978041d92a9','dff5f02b','E',2,1857.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['6b01b77e-aa01-4c99-900a-65e9a69db863','e1e6f7d3','E',1,192.19,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['276f0524-ad50-4194-9e00-ca8782026fcb','e1e6f7d3','S',1,192.19,'USD',null,null,240.2375,'USD','09-01','09-22T14:28:28.512121','XA-VGV'],
  ['6fd76eec-6e95-48aa-9a83-dd6113f1d52a','e4d595b8','E',2,172.44,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['10ce1905-a55a-417c-b345-34eaf897da89','e53043c7','E',2,868.75,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['13ff694a-cbc4-43ca-bb6d-e332257ff837','ed6d7e1b','E',1,2117.5,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['913c87c9-caff-45b8-81b4-4151192f2bff','f094cdd7','E',1,112.44,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
  ['ed956ec6-6b59-4444-b014-e8a422ff3ca5','f92479a3','E',1,1406.25,'USD',null,null,null,null,'08-29','08-29T17:36:21.895647',null],
];

/** Producto del aceite 15W-50 (el único con dos precios: 13-jul MXN y 29-ago USD). */
export const ITEM_ACEITE = 'd99df930';

/** T.C. oficial que pone la migración 20260925000003 a cada fecha. */
export const TC_MIGRACION: Record<string, number> = {
  '2026-08-29': 17.0115,
  '2026-09-01': 17.0077,
};

/** Cardex real por producto (clave = primeros 8 caracteres del item_id). */
export function cardexProd25sep(
  opts: { tcOficial?: boolean } = {},
): Map<string, MovCardex[]> {
  const out = new Map<string, MovCardex[]>();
  for (const f of FILAS) {
    const [
      id,
      item,
      tipo,
      cantidad,
      costoUsd,
      moneda,
      costoMxn,
      tc,
      venta,
      ventaMoneda,
      fecha,
      creado,
      matricula,
    ] = f;
    const fechaIso = `2026-${fecha}`;
    const tcFila =
      tc ??
      (opts.tcOficial && moneda === 'USD'
        ? (TC_MIGRACION[fechaIso] ?? null)
        : null);
    const mov: MovCardex = {
      id,
      item_id: item,
      tipo: tipo === 'E' ? 'ENTRADA' : 'SALIDA',
      cantidad,
      costo_unitario_usd: costoUsd,
      moneda,
      costo_unitario_mxn: costoMxn,
      tc_usd_mxn: tcFila,
      venta_unitaria: venta,
      venta_moneda: ventaMoneda,
      fecha_movimiento: fechaIso,
      created_at: `2026-${creado}+00:00`,
      para_flota: false,
      aeronave_id: matricula ? `avion-${matricula}` : null,
      aeronave: matricula ? { matricula } : null,
    };
    if (!out.has(item)) out.set(item, []);
    out.get(item)!.push(mov);
  }
  return out;
}

/** Los 81 movimientos en una lista. */
export function todosLosMovimientos(opts: { tcOficial?: boolean } = {}) {
  return [...cardexProd25sep(opts).values()].flat();
}
