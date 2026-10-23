import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ToBooleanQuery } from '../../../common/decorators/to-boolean-query.decorator';
import { descripcionCategoriasGasto } from '../../../common/categoria-gasto.util';
import {
  REPARTO_IGUALES_MAX_AVIONES,
  REPARTO_IGUALES_MAX_GASTOS,
} from '../reparto-iguales.util';
import {
  CARGOS_A_GASTO_MAX,
  CARGOS_A_GASTO_MIN,
  MENSAJE_LOTE_CARGOS_INVALIDO,
} from '../../conciliacion/cargos-a-gasto.util';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export enum CategoriaGasto {
  GAS = 'GAS',
  ATERRIZAJE = 'ATERRIZAJE',
  OPERACIONES = 'OPERACIONES',
  TUAS = 'TUAS',
  FBO = 'FBO',
  COMIDA = 'COMIDA',
  /** «Comisariato» (13-oct-2026, pedido del cliente —Jimmy, 12-oct—:
   *  «agregar en la categoría de gastos: Comisariato; entraría en [la columna
   *  OTROS de costos directos] en el balance del avión»): snacks, bebidas y
   *  comisariato para los PASAJEROS. Invariante 63 del CLAUDE.md del API:
   *  - Gasto DIRECTO del vuelo (destino = el de COMIDA): columna OTROS de la
   *    fila del vuelo junto al FBO, grupo DIRECTO en el reparto a socios.
   *  - Exige vuelo SOLO al PILOTO (derivado del destino, como COMIDA); la
   *    oficina la captura suelta y la liga después.
   *  - Sin TUA embebido, no repartible, no ligable a compras; la IA de
   *    tickets SÍ la sugiere (pyservices). La comida de la TRIPULACIÓN
   *    sigue en COMIDA.
   *  - La migración 20261013000001 (valor del enum) va ANTES del API. */
  COMISARIATO = 'COMISARIATO',
  /** «Otros gastos directos del vuelo» (20-oct-2026, API 0.0.99, pedido del
   *  cliente: «agregar en las categorias del gasto la de "Otros gastos
   *  directos del vuelo" y que se vaya lo que se capture con esa categoria a
   *  la hoja de reportes de hora en el balance general y por avión en la
   *  columna de "Otros"»). Invariante 97 del CLAUDE.md del API: la MISMA
   *  regla que COMISARIATO (destino «Gastos directos del vuelo», columna
   *  OTROS, grupo DIRECTO del reparto, exige vuelo solo al PILOTO, sin TUA
   *  embebido, no repartible, no ligable a compras). La migración
   *  20261020000002 (valor del enum) va ANTES del API. */
  OTROS_DIRECTOS_VUELO = 'OTROS_DIRECTOS_VUELO',
  HOTEL = 'HOTEL',
  TAXI = 'TAXI',
  REFACCION = 'REFACCION',
  PERMISO = 'PERMISO',
  /** Honorario del piloto externo (freelance sin acceso; lo captura oficina). */
  PILOTO_EXTERNO = 'PILOTO_EXTERNO',
  /** «Comisión del vendedor (VuelaTour)»: pago al VENDEDOR de su comisión
   *  que paga VuelaTour (28-sep-2026, pedido del cliente: «¿cómo le pago la
   *  comisión a Saab sin que quede duplicada?»; etiqueta «(VuelaTour)» desde
   *  el 13-oct-2026). Invariantes 31 y 61 del CLAUDE.md del API:
   *  - Exige vuelo para TODOS los roles (400 `GASTO_REQUIERE_VUELO`; CHECK
   *    `gasto_comision_vendedor_exige_vuelo` de respaldo); el avión se hereda
   *    del vuelo solo como referencia.
   *  - SIEMPRE la paga VuelaTour en «otros movimientos» (Balance general) y
   *    en «Otros ingresos» (Libro Dinero), apareada con la comisión cobrada
   *    (sin pago capturado la fila no lleva egreso: invariantes 58 y 61). NO
   *    es costo del avión en ningún libro (tampoco dentro de
   *    `comisiones_al_avion_desde`) y NO va a «otros gastos». Si el pago le
   *    toca al avión, se usa `COMISION_VENDEDOR_AVION`.
   *  - Monto libre (parcial/exacto/mayor), varios por vuelo, proveedor
   *    opcional, cualquier moneda. No repartible. La IA de tickets no la
   *    sugiere. */
  COMISION_VENDEDOR = 'COMISION_VENDEDOR',
  /** «Comisión del vendedor (avión)»: pago al vendedor A CARGO DEL AVIÓN
   *  (13-oct-2026, pedido del cliente: «una opcion que sea Comision del
   *  vendedor pero que esa opcion si se cargue al balance del avión»;
   *  invariante 61 del CLAUDE.md del API):
   *  - Exige vuelo para TODOS los roles (400 `GASTO_REQUIERE_VUELO` y, de
   *    respaldo, el CHECK `gasto_comision_vendedor_avion_exige_vuelo`).
   *  - El avión del gasto es solo referencia. Lo carga el avión del vuelo
   *    SOLO por `comisionesDelVuelo`: vuelo COMPLETADO o CANCELADO con cobros
   *    retenidos, por participación (multi-avión), en el MES DEL VUELO, en
   *    su columna COMISIONES y en el reparto. Fuera de eso lo egresa
   *    VuelaTour en «otros movimientos», con aviso.
   *  - No es repartible, no lleva TUA embebido, no se liga a compras y la IA
   *    no la sugiere.
   *  - La migración 20261013000003 (valor del enum) va ANTES del API. */
  COMISION_VENDEDOR_AVION = 'COMISION_VENDEDOR_AVION',
  FIJO = 'FIJO',
  /** Gasto indirecto de la operación (SIN vuelo; avión opcional). Por ahora
   *  fuera del reparto y de la bandeja de pendientes — pendiente de decidir
   *  su tratamiento con el equipo (hoja "gastos indirectos" de su control). */
  INDIRECTO = 'INDIRECTO',
  /** Gastos de VISITA de trabajo (27-ago): los captura el rol VISITANTE
   *  (la app se la fija sola). Patrón GASOLINA: sin vuelo/avión/escala,
   *  visible en Otros gastos, repartible a mano, fuera de pendientes. */
  VISITA = 'VISITA',
  /** Gasolina de VEHÍCULOS de la empresa (27-ago): gasolinera Pemex/Gulf
   *  (Magna/Premium/Regular), NO combustible de aviación. Gasto de la
   *  EMPRESA: sin vuelo ni avión (candados create/update); visible en Otros
   *  gastos y repartible a mano. Nació porque los coches cargaban como GAS
   *  y contaminaban balances de aviones. */
  GASOLINA = 'GASOLINA',
  /** Nómina / sueldos del personal (29-ago-2026): se clasifica junto a los
   *  gastos INDIRECTOS (sin vuelo; avión opcional) y SÍ es repartible a mano
   *  entre aviones (`gasto_reparto`; el trigger de BD ya la acepta). */
  NOMINA = 'NOMINA',
  /** Servicios AL AVIÓN (29-ago-2026): mantenimientos/servicios contratados
   *  — gasto DIRECTO del avión SIN vuelo (avión permitido y esperado; como
   *  REFACCION queda pendiente hasta tener avión). NO es repartible. */
  SERVICIOS = 'SERVICIOS',
  /** Gasto PERSONAL del dueño (26-ago-2026): lo captura el personal de
   *  VuelaTour pero NO es de la empresa ni de los aviones — seguimiento en
   *  la pantalla "Gastos personales". SIEMPRE sin vuelo y sin avión (candado
   *  en create/update); fuera de balances, reparto, Libro Dinero, tablero de
   *  gastos y pre-cierre. Conciliación y caja chica SÍ lo ven (el dinero
   *  salió de verdad del banco/fondo). */
  PERSONAL_DUENO = 'PERSONAL_DUENO',
  OTRO = 'OTRO',
  /** «Paquetería» (20-oct-2026, API 0.0.99, pedido del cliente: «crear una
   *  nueva categoria que se llame "Paqueteria" y se vaya al balance general
   *  de Vuelatour»). Invariante 97: gasto de EMPRESA (destino «Otros gastos
   *  (Balance general VuelaTour)» ⇒ entra sola a CATEGORIAS_GASTO_EMPRESA y
   *  a «sin avión»). La migración 20261020000001 va ANTES del API: las
   *  listas de empresa viajan como literales a PostgREST (22P02 sin ella). */
  PAQUETERIA = 'PAQUETERIA',
  /** «Otros movimientos (VuelaTour)» (23-oct-2026, API 0.0.106, pedido del
   *  cliente con la captura del select de categorías: «Falta la opción de
   *  agregar un gasto a la hoja de "otros movimientos" en el balance
   *  general»). Invariante 107 del CLAUDE.md del API: EGRESO DE VUELATOUR.
   *  - Vuelo OPCIONAL y avión opcional (el avión del vuelo solo informa).
   *    Con vuelo: línea de egreso en el bloque del vuelo de la hoja «otros
   *    movimientos» del Balance general (y de «Otros ingresos» del Libro
   *    Dinero, como el TUA pagado); sin vuelo: fila suelta al final.
   *  - NUNCA es costo del avión: EXCLUIDO del reparto, fuera de la hoja
   *    maestra y de «otros gastos»; nunca «pendiente de avión».
   *  - Solo la OFICINA la captura (PILOTO/MECANICO/VISITANTE ⇒ 400
   *    `CATEGORIA_SOLO_OFICINA` en el alta); sin TUA embebido, no repartible,
   *    no ligable a compras; la IA de tickets no la sugiere.
   *  - La migración 20261023000002 (25.º valor del enum, AL FINAL) ya está
   *    aplicada en prod (23-oct-2026), ANTES del API. */
  OTROS_MOVIMIENTOS = 'OTROS_MOVIMIENTOS',
}

export enum Moneda {
  MXN = 'MXN',
  USD = 'USD',
}

export enum MedioPago {
  EFECTIVO = 'EFECTIVO',
  TARJETA_CORP = 'TARJETA_CORP',
  PERSONAL_PABLO = 'PERSONAL_PABLO',
  PERSONAL_ALE = 'PERSONAL_ALE',
  TRANSFERENCIA = 'TRANSFERENCIA',
  /** PayWise (2-sep-2026): medio BANCARIO — sus cargos aparecen en el estado
   *  de cuenta, así que entra a la conciliación automática, a "gastos sin
   *  banco" y al pre-cierre de bancarios sin conciliar, como TARJETA_CORP y
   *  TRANSFERENCIA. Caja chica NO lo cuenta (esa solo mira EFECTIVO). */
  PAYWISE = 'PAYWISE',
  /** «Pago domiciliado» (13-oct-2026, API 0.0.75, migración
   *  20261013000009, invariante 64): cargo AUTOMÁTICO a la cuenta
   *  (suscripciones, seguros, servicios). Medio BANCARIO: entra a
   *  MEDIOS_BANCARIOS (auto-cruce, candidatos sin justificación, gastos sin
   *  banco, pre-cierre, columna Banco) y se concilia como TRANSFERENCIA (1
   *  cargo ↔ 1 gasto; parciales como cualquier bancario). Sin tarjeta (CHECK
   *  `gasto_check`). Solo oficina: PILOTO/MECANICO/VISITANTE ⇒ 400
   *  `MEDIO_SOLO_OFICINA` en el alta. La IA de tickets no lo sugiere. */
  DOMICILIADO = 'DOMICILIADO',
  /** «Efectivo de la empresa (no de fondo)» (20-oct-2026, API 0.0.99,
   *  migración 20261020000003, invariante 97; caso del 19-oct: comisiones
   *  pagadas en efectivo por el dueño se capturaron como EFECTIVO y se
   *  restaron del fondo de quien las registró). Dinero en efectivo de la
   *  empresa que NO sale de ninguna caja chica: caja chica solo mira
   *  `medio_pago = 'EFECTIVO'` exacto, así que este medio no entra a ningún
   *  libro, reposición ni alerta. NO bancario (como EFECTIVO: se liga a un
   *  cargo solo con justificación, invariante 48). Solo oficina:
   *  PILOTO/MECANICO/VISITANTE ⇒ 400 `MEDIO_SOLO_OFICINA` en el alta. */
  EFECTIVO_EMPRESA = 'EFECTIVO_EMPRESA',
}

export enum TipoCombustible {
  TURBOSINA = 'TURBOSINA',
  AVGAS = 'AVGAS',
}

/**
 * Comprobante que entregó quien capturó — DOS opciones de cara al usuario
 * (pedido del cliente, 14-sep-2026), tres valores en BD para no migrar:
 *
 *  - `FACTURA`         = **con comprobante** (ticket, voucher o factura). Es
 *    el valor que GUARDAN el panel y la app cuando hay foto.
 *  - `VALE`            = con comprobante, valor **LEGADO** (cargas masivas
 *    con comprobante TICKET, capturas viejas). Se lee igual que FACTURA y
 *    NO se reescribe solo.
 *  - `SIN_COMPROBANTE` = sin comprobante (default de la columna).
 *
 * Regla de lectura única: `src/common/comprobante.util.ts`. Este campo NO
 * dice si ya se facturó — eso es `estatus_facturacion`.
 */
export enum EstatusComprobante {
  /** Con comprobante (ticket, voucher o factura) — valor que se guarda. */
  FACTURA = 'FACTURA',
  /** LEGADO: también significa "con comprobante"; no se escribe nuevo. */
  VALE = 'VALE',
  /** Sin comprobante. */
  SIN_COMPROBANTE = 'SIN_COMPROBANTE',
}

/**
 * Seguimiento de facturación de OFICINA — independiente del comprobante que
 * entregó el piloto (la app marca FACTURA con cualquier foto, aunque sea un
 * ticket, así que ese campo NO dice si ya se facturó).
 *
 * `NO_FACTURABLE` (14-sep-2026) = «No requiere factura»: ni facturado ni
 * por facturar. Necesita la migración `20260914000002` (CHECK de BD); sin
 * ella el API responde 400 explicándolo, nunca 500.
 */
export enum EstatusFacturacion {
  PENDIENTE = 'PENDIENTE',
  SOLICITADA = 'SOLICITADA',
  FACTURADA = 'FACTURADA',
  NO_FACTURABLE = 'NO_FACTURABLE',
}

/**
 * REFACCIÓN A INVENTARIO/TIENDA (12-oct-2026, invariante 57): con este
 * bloque, el gasto REFACCION se registra como COMPRA recibida (la pieza
 * entra al cardex con el monto del gasto como último precio de compra; el
 * artículo se crea si no existe), el precio de venta queda en la ficha del
 * artículo y, con `vender_al_avion`, sale de inmediato vendida al avión del
 * gasto (que recibe el cargo de bodega). El gasto de compra NO carga al
 * avión: el avión lo paga por su salida. Solo al crear.
 *
 * @deprecated Desde el 21-oct-2026 (invariante 101) el panel NO manda este
 * bloque: una refacción se da de alta como un gasto normal y la bodega se
 * alimenta desde Compras («Registrar gasto», «Vincular gasto ya registrado»,
 * «Entrada desde un gasto»). Se acepta por compatibilidad; la app móvil
 * nunca lo usó. No agregar funcionalidad aquí.
 */
export class RefaccionInventarioDto {
  @ApiPropertyOptional({
    description: 'Artículo existente de Inventario/Tienda',
  })
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Nombre del artículo NUEVO (sin item_id)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nombre?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero_parte?: string;

  @ApiPropertyOptional({
    maxLength: 50,
    description: "Categoría del artículo nuevo (default 'Refacción')",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoria?: string;

  @ApiProperty({ description: 'Unidades que entran a inventario (> 0)' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  @ApiProperty({
    description:
      'Precio de venta UNITARIO al avión (0 = a costo). OBLIGATORIO.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  precio_venta!: number;

  @ApiProperty({ enum: ['MXN', 'USD'] })
  @IsIn(['MXN', 'USD'])
  precio_venta_moneda!: 'MXN' | 'USD';

  @ApiPropertyOptional({
    description:
      'true = al guardar, SALIDA inmediata al avión del gasto (aeronave_id) al precio de venta.',
  })
  @IsOptional()
  @IsBoolean()
  vender_al_avion?: boolean;
}

export class CreateGastoDto {
  @ApiProperty({
    enum: CategoriaGasto,
    // Código → etiqueta (UI) → destino por default, derivado de la fuente
    // única src/common/categoria-gasto.util.ts (sin duplicar textos).
    description: descripcionCategoriasGasto(),
  })
  @IsEnum(CategoriaGasto)
  categoria!: CategoriaGasto;

  @ApiPropertyOptional({
    description:
      'Folio / número de remisión del ticket o factura (ej. remisión ASA). Con 4+ caracteres alfanuméricos es CANDADO anti-duplicados: otro gasto con el mismo folio se rechaza con 409.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio_ticket?: string;

  @ApiProperty({ description: 'Monto del gasto' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({
    description:
      'Propina incluida en monto (monto = ticket + propina; monto es lo que llega al banco).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  propina?: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'TUA (tarifa de uso de aeropuerto) incluida en el monto, CON IVA, en la moneda del gasto (13-oct-2026). Solo OFICINA (piloto/mecánico/visitante: se ignora) y solo en Operaciones, Aterrizaje o FBO. null = usar la lectura de la IA; 0 = esta factura no cobra TUA aunque la IA lea una; > 0 = esa TUA se separa del costo del avión (≤ monto − propina). 400 TUA_INCLUIDA_MAYOR_QUE_TICKET / TUA_INCLUIDA_NO_APLICA; 409 TUA_INCLUIDA_NO_DISPONIBLE sin la migración 20261013000008. En el PATCH: ausente = no tocar; null = volver a la lectura de la IA.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tua_incluida?: number | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Pago de AFAC que paga VuelaTour (16-oct-2026, invariante 90): solo categoría Permiso; no resta a ningún avión (es el comprobante de los costos reales AFAC capturados por vuelo en el Balance general). Solo OFICINA (ADMIN, FACTURACION, COORDINADOR): otro rol que lo cambie ⇒ 403 PAGO_AFAC_SOLO_OFICINA (un eco igual al vigente se ignora). true fuera de Permiso ⇒ 400 PAGO_AFAC_SOLO_PERMISO. Sin la migración 20261016000005: true ⇒ 503 AFAC_REAL_NO_DISPONIBLE; false se ignora. En el PATCH: ausente = no tocar; marcar/desmarcar en un mes cerrado ⇒ 409 MES_CERRADO.',
  })
  @IsOptional()
  @IsBoolean()
  es_pago_afac?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Gasto «por pagar» (19-oct-2026, invariante 93; migración 20261019000001). El servidor decide: una fecha_gasto después de hoy (Cancún) nace por pagar aunque no se mande. true con fecha ≤ hoy = «lo anoto hoy y lo pago al rato». En el PATCH, false sobre un gasto por pagar = «Marcar pagado» (fecha_gasto = la del pago, ≤ hoy; sin fecha: hoy, o la suya si ya venció). false con una fecha futura ⇒ 400 POR_PAGAR_FECHA_FUTURA. Sin la migración: true ⇒ 503 POR_PAGAR_NO_DISPONIBLE y false se ignora. Booleano ESTRICTO: el texto "false" ⇒ 400; null = ausente.',
  })
  @IsOptional()
  // Booleano ESTRICTO sobre el valor CRUDO del cuerpo (patrón de
  // `solo_enriquecer` / `simular`): con `enableImplicitConversion` el texto
  // «"false"» llegaría como Boolean('false') = true.
  @Transform(({ obj, key, value }): unknown => {
    const fuente = obj as Record<string, unknown> | null | undefined;
    return fuente && typeof fuente === 'object' && key in fuente
      ? fuente[key]
      : (value as unknown);
  })
  @IsBoolean({ message: 'por_pagar debe ser true o false' })
  por_pagar?: boolean | null;

  @ApiProperty({ enum: Moneda })
  @IsEnum(Moneda)
  moneda!: Moneda;

  @ApiPropertyOptional({
    description:
      'Tipo de cambio MXN/USD si el gasto es en moneda distinta a USD. Se ' +
      'guarda con 6 decimales (17-sep-2026): manda los que necesites, el API ' +
      'normaliza — no se rechazan decimales de más.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  tc_gasto?: number;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  fecha_gasto!: string;

  @ApiProperty({
    enum: MedioPago,
    description:
      'Obligatorio, sin valor por defecto (la app y el panel no preseleccionan).',
  })
  @IsEnum(MedioPago)
  medio_pago!: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tarjeta_terminacion?: string;

  @ApiPropertyOptional({
    description:
      'Cuenta de donde salió el pago (20-oct-2026, invariante 98). Solo se ' +
      'guarda con medio TRANSFERENCIA, DOMICILIADO o PAYWISE; con otro medio ' +
      'el API la deja en null. `null` en un PATCH la quita.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string | null;

  @ApiPropertyOptional({
    description:
      'Vuelo asociado (opcional). Desde el 11-sep-2026 el PILOTO puede ' +
      'capturar SIN vuelo, pero SOLO en categorías que no son del vuelo ' +
      '(empresa/indirectos/refacción/servicios y GAS): las «directas del ' +
      'vuelo» y TUAS/PERMISO/PILOTO_EXTERNO responden 400 con code ' +
      'GASTO_REQUIERE_VUELO (regla única: categoriaExigeVuelo, ' +
      'src/common/categoria-gasto.util.ts). GAS salió del candado el ' +
      '11-sep-2026 (el piloto carga combustible en base, como el mecánico), ' +
      'pero sigue exigiendo `aeronave_id` si no viene vuelo. Mandar ' +
      '`escala_id` cuenta como mandar el vuelo (el tramo lo resuelve).',
  })
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional({
    description:
      'Escala/aterrizaje asociado (gastos de pista: un gasto por aterrizaje)',
  })
  @IsOptional()
  @IsUUID()
  escala_id?: string;

  @ApiPropertyOptional({
    description: 'Aeronave (opcional). null = bandeja de pendientes',
  })
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional({
    enum: EstatusComprobante,
    description:
      'Comprobante entregado, DOS opciones de cara al usuario: FACTURA = con comprobante (ticket, voucher o factura; es el valor que se guarda) · VALE = con comprobante, LEGADO (se lee, no se escribe nuevo) · SIN_COMPROBANTE = sin comprobante. NO dice si ya se facturó: eso es estatus_facturacion.',
  })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({
    enum: EstatusFacturacion,
    description:
      'Semáforo de facturación de oficina: PENDIENTE · SOLICITADA · FACTURADA · NO_FACTURABLE (no requiere factura; necesita la migración 20260914000002).',
  })
  @IsOptional()
  @IsEnum(EstatusFacturacion)
  estatus_facturacion?: EstatusFacturacion;

  @ApiPropertyOptional({ description: 'URL/path en Supabase Storage' })
  @IsOptional()
  @IsString()
  foto_url?: string;

  @ApiPropertyOptional({ description: 'Litros cargados (solo combustible)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  litros?: number;

  @ApiPropertyOptional({ enum: TipoCombustible })
  @IsOptional()
  @IsEnum(TipoCombustible)
  tipo_combustible?: TipoCombustible;

  @ApiPropertyOptional({ description: 'Aeropuerto/FBO donde se hizo la carga' })
  @IsOptional()
  @IsString()
  lugar?: string;

  @ApiPropertyOptional({
    description: 'Momento preciso de la carga (ISO); permite sugerir el vuelo',
  })
  @IsOptional()
  @IsDateString()
  fecha_hora_carga?: string;

  @ApiPropertyOptional({
    description: 'Valores extraídos por IA antes de confirmación',
  })
  @IsOptional()
  @IsObject()
  valor_ia_extraido?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({
    type: RefaccionInventarioDto,
    deprecated: true,
    description:
      'DEPRECADO (21-oct-2026, invariante 101): el panel ya no lo manda; la bodega se alimenta desde Compras (registrar gasto / vincular gasto / entrada desde un gasto). Se acepta por compatibilidad. Solo categoría REFACCION y solo al CREAR (invariante 57): la pieza entra a Inventario/Tienda como compra recibida (ítem nuevo si no existe), con precio de venta obligatorio y salida inmediata al avión si se pide.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RefaccionInventarioDto)
  inventario?: RefaccionInventarioDto;

  @ApiPropertyOptional({
    description:
      'Captura offline con foto: al recibirla, el servidor lee el comprobante con IA y completa lo que falte (desglose, fecha del ticket, matrícula→avión) sin pisar lo capturado a mano.',
  })
  @IsOptional()
  @IsBoolean()
  leer_con_ia?: boolean;

  @ApiPropertyOptional({
    description:
      'Backfill de oficina: registra el gasto COMO SI lo hubiera subido el ' +
      'piloto del vuelo (usuario_captura + origen = PILOTO). Requiere ' +
      'vuelo_id y que el vuelo tenga piloto. La auditoría (created_by) ' +
      'conserva al usuario real que lo cargó. Solo ADMIN/COORDINADOR.',
  })
  @IsOptional()
  @IsBoolean()
  capturar_como_piloto?: boolean;

  @ApiPropertyOptional({
    description:
      'Capturado con prellenado de IA desde la app (flujo admin): queda pendiente del visto bueno de administración en el panel.',
  })
  @IsOptional()
  @IsBoolean()
  requiere_visto_bueno?: boolean;

  @ApiPropertyOptional({
    description:
      'true al guardar el diálogo Verificar del panel: sella verificado_por/' +
      'verificado_at con quien confirma. false = retirar la confirmación. ' +
      'Solo oficina (los roles de campo no pueden mandarlo).',
  })
  @IsOptional()
  @IsBoolean()
  verificado?: boolean;

  @ApiPropertyOptional({
    description:
      'Llave de IDEMPOTENCIA generada por el cliente (uuid v4, una por ' +
      'captura). Un reintento (timeout tras commit, doble flush del outbox, ' +
      'doble tap) con la misma llave devuelve el gasto YA creado en vez de ' +
      'duplicar dinero. Índice único uq_gasto_client_request.',
  })
  @IsOptional()
  @IsUUID()
  client_request_id?: string;

  /**
   * VARIOS CARGOS → UN GASTO, «Créalo por la suma» (14-oct-2026, API 0.0.77,
   * invariante 76): el gasto nace YA vinculado a estos cargos del banco (2..50)
   * o no se registra. Solo ADMIN y FACTURACION (403 a los demás); exige
   * `client_request_id`; solo al CREAR (un PATCH con la llave ⇒ 400).
   */
  @ApiPropertyOptional({
    type: [String],
    description: `Cargos del banco (${CARGOS_A_GASTO_MIN}..${CARGOS_A_GASTO_MAX}, uuid, sin repetir) que paga este gasto: el alta los vincula en la MISMA petición (todo o nada, sin auto-cruce). Exige client_request_id. Solo ADMIN/FACTURACION y solo al crear.`,
  })
  @IsOptional()
  @IsArray({ message: MENSAJE_LOTE_CARGOS_INVALIDO })
  @ArrayMinSize(CARGOS_A_GASTO_MIN, { message: MENSAJE_LOTE_CARGOS_INVALIDO })
  @ArrayMaxSize(CARGOS_A_GASTO_MAX, { message: MENSAJE_LOTE_CARGOS_INVALIDO })
  @ArrayUnique({ message: MENSAJE_LOTE_CARGOS_INVALIDO })
  @IsUUID(undefined, {
    each: true,
    message: 'Algún cargo de la selección no es válido: recarga la página.',
  })
  conciliar_con_movimientos?: string[];

  @ApiPropertyOptional({
    description:
      'Solo OFICINA: confirma a propósito una fecha_gasto de hace más de ' +
      '365 días (carga histórica real). Sin esta bandera, una fecha tan ' +
      'vieja se rechaza con 400 — casi siempre es el AÑO equivocado del ' +
      'ticket y el gasto quedaría fuera de todos los cortes.',
  })
  @IsOptional()
  @IsBoolean()
  permitir_fecha_antigua?: boolean;

  @ApiPropertyOptional({
    description:
      'Momento REAL de captura (7-sep-2026), ISO 8601 CON zona horaria ' +
      '(ej. 2026-09-05T14:32:00-05:00 o ...Z). La app lo manda al guardar ' +
      'aunque esté sin señal (el outbox lo sube después: created_at = ' +
      'llegada al servidor). Omitido = ahora (panel, cargas masivas). Se ' +
      'rechaza con 400 si viene sin zona, en el futuro (> 10 min) o antes ' +
      'de 2020. Solo auditoría: no toca dinero ni ventanas de edición. En ' +
      'PATCH la columna NO se reescribe (se fija una sola vez al crear): ahí ' +
      'el valor es el sello de la CORRECCIÓN (ver UpdateGastoDto).',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  capturado_en?: string;
}

/**
 * Edición de un gasto. Todo lo heredado es opcional. Dos campos cambian de
 * significado respecto al alta (10-sep-2026, app sin internet):
 *  - `capturado_en`: momento REAL en que el capturista hizo la CORRECCIÓN
 *    (el outbox la sube después). La ventana semanal se evalúa contra ese
 *    sello (si viene y es ≤ ahora), no contra la llegada al servidor, y la
 *    bitácora del gasto conserva «corrección capturada el … · recibida el …».
 *    La columna `capturado_en` del gasto NO se toca.
 *  - `client_request_id`: la llave de la captura ORIGINAL se conserva
 *    siempre (el PATCH ni la reescribe ni la borra); mandarla es inocuo.
 */
export class UpdateGastoDto extends PartialType(CreateGastoDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({
    description: 'Bandera de posible duplicado (la oficina la descarta).',
  })
  @IsOptional()
  @IsBoolean()
  duplicado_sospechado?: boolean;

  @ApiPropertyOptional({
    description:
      'Control de versión (doc 6.1, gana el servidor + aviso): `updated_at` ' +
      'del gasto tal como lo leyó el cliente (ISO). Si alguien lo modificó ' +
      'después, el PATCH no aplica y responde 409 CONFLICTO_VERSION con ' +
      '`details.actual` (la fila vigente), `updated_at_enviado` y ' +
      '`updated_at_actual`. Omitido = comportamiento de siempre (último gana).',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  if_updated_at?: string;
}

/** Query de DELETE /expenses/:id (10-sep-2026). */
export class DeleteGastoQuery {
  @ApiPropertyOptional({
    description:
      'Momento REAL en que el capturista pidió la baja (ISO con zona). Como ' +
      'en el PATCH: la ventana semanal se evalúa contra este sello si viene ' +
      'y es ≤ ahora; la bitácora conserva «baja capturada el … · recibida el …».',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  capturado_en?: string;
}

// ===== Gastos de pista (cuotas de aeródromo VIP SAESA) =====

export class PistasPendientesQuery {
  @ApiProperty({ description: 'fecha >= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  desde!: string;

  @ApiProperty({ description: 'fecha <= (YYYY-MM-DD, corte Cancún)' })
  @IsDateString()
  hasta!: string;
}

export class GenerarPistaItemDto {
  @ApiProperty({
    description: 'Escala (aterrizaje) a la que corresponde la cuota',
  })
  @IsUUID()
  escala_id!: string;

  @ApiProperty({ description: 'Monto de la cuota (editable; PCE es variable)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    enum: CategoriaGasto,
    default: CategoriaGasto.OPERACIONES,
  })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({ enum: MedioPago, default: MedioPago.TRANSFERENCIA })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proveedor_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class GenerarPistasDto {
  @ApiProperty({ type: [GenerarPistaItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerarPistaItemDto)
  items!: GenerarPistaItemDto[];
}

export class CreateTarifaAerodromoDto {
  @ApiPropertyOptional({
    description: 'IATA del aeródromo; vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  codigo_iata?: string;

  @ApiPropertyOptional({
    description:
      'Modelo de aeronave (Kodiak/Cessna/Seneca); vacío = cualquiera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelo?: string;

  @ApiProperty({ description: 'Cuota por aterrizaje' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monto!: number;

  @ApiPropertyOptional({ enum: Moneda, default: Moneda.MXN })
  @IsOptional()
  @IsEnum(Moneda)
  moneda?: Moneda;

  @ApiPropertyOptional({
    description: 'Tarifa variable (p.ej. PCE): el monto es estimado',
  })
  @IsOptional()
  @IsBoolean()
  variable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateTarifaAerodromoDto extends PartialType(
  CreateTarifaAerodromoDto,
) {}

export class PhotoUrlsDto {
  @ApiProperty({
    type: [String],
    description: 'Paths de fotos en gasto-fotos a firmar',
  })
  @IsString({ each: true })
  paths!: string[];
}

export class SugerirVueloQuery {
  @ApiProperty({ description: 'Aeronave de la carga' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Momento de la carga (ISO 8601)' })
  @IsDateString()
  fecha_hora!: string;
}

export class RepartoItemDto {
  @ApiProperty({ description: 'Aeronave que absorbe esta parte del gasto' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({ description: 'Monto en la MONEDA del gasto', example: 500 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monto!: number;
}

export class PutRepartoDto {
  @ApiProperty({
    description:
      'Reparto COMPLETO del gasto entre aviones (reemplaza el anterior; [] lo limpia). Σ montos <= gasto.monto; el remanente queda como gasto de la empresa VuelaTour.',
    type: [RepartoItemDto],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepartoItemDto)
  items!: RepartoItemDto[];
}

export class RepartoMasivoLineaDto {
  @ApiProperty({ description: 'Aeronave que absorbe este porcentaje' })
  @IsUUID()
  aeronave_id!: string;

  @ApiProperty({
    description:
      'Porcentaje del monto de CADA gasto (hasta 2 decimales, 0.01–100)',
    example: 25,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  porcentaje!: number;
}

export class RepartoMasivoDto {
  @ApiProperty({
    type: [String],
    description: 'Gastos generales a los que se aplica el reparto (1–200)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  gasto_ids!: string[];

  @ApiProperty({
    description:
      'Reparto porcentual entre aviones (Σ <= 100.00; lo no asignado queda como gasto de la empresa VuelaTour). Reemplaza el reparto vigente de cada gasto.',
    type: [RepartoMasivoLineaDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepartoMasivoLineaDto)
  items!: RepartoMasivoLineaDto[];
}

/**
 * NÓMINA: REPARTO EN PARTES IGUALES (16-oct-2026, API 0.0.90, invariante 91)
 * — `POST /v1/expenses/reparto-iguales`. Cada pago se reparte por separado
 * en partes iguales (centavos enteros, Σ == monto) entre los aviones
 * ACTIVOS elegidos; `aeronave_ids: []` QUITA el reparto. Con whitelist +
 * forbidNonWhitelisted (main.ts) cualquier otra llave ⇒ 400.
 */
export class RepartoIgualesDto {
  @ApiProperty({
    type: [String],
    description: 'Pagos (gastos) a repartir: 1–200 uuid sin repetir.',
  })
  @IsArray({ message: 'gasto_ids debe ser una lista de pagos' })
  @ArrayMinSize(1, { message: 'Elige al menos un pago.' })
  @ArrayMaxSize(REPARTO_IGUALES_MAX_GASTOS, {
    message: `Se reparten hasta ${REPARTO_IGUALES_MAX_GASTOS} pagos por vez.`,
  })
  @ArrayUnique({ message: 'Hay un pago repetido en la lista.' })
  @IsUUID(undefined, {
    each: true,
    message: 'Cada pago debe ser un id válido (uuid).',
  })
  gasto_ids!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Aviones ACTIVOS entre los que se reparte cada pago en partes iguales (0–20 uuid sin repetir). [] = QUITAR el reparto de esos pagos.',
  })
  @IsArray({ message: 'aeronave_ids debe ser una lista de aviones' })
  @ArrayMaxSize(REPARTO_IGUALES_MAX_AVIONES, {
    message: `Se reparte entre hasta ${REPARTO_IGUALES_MAX_AVIONES} aviones.`,
  })
  @ArrayUnique({ message: 'Hay un avión repetido en la lista.' })
  @IsUUID(undefined, {
    each: true,
    message: 'Cada avión debe ser un id válido (uuid).',
  })
  aeronave_ids!: string[];

  @ApiPropertyOptional({
    description:
      'true = NO escribe nada: solo calcula las partes y valida cada pago (vista previa).',
  })
  @IsOptional()
  // Booleano ESTRICTO sobre el valor CRUDO del cuerpo (patrón de
  // `solo_enriquecer` / `corregir_comision`): con `enableImplicitConversion`
  // (main.ts) el texto «"false"» llegaría como Boolean('false') = true; así
  // solo pasan `true` y `false` de verdad.
  @Transform(({ obj, key, value }): unknown => {
    const fuente = obj as Record<string, unknown> | null | undefined;
    return fuente && typeof fuente === 'object' && key in fuente
      ? fuente[key]
      : (value as unknown);
  })
  @IsBoolean({ message: 'simular debe ser true o false' })
  simular?: boolean;
}

export class ListOtrosGastosQuery {
  @ApiPropertyOptional({
    description: 'fecha_gasto >= (YYYY-MM-DD); default inicio del mes Cancún',
  })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({
    description: 'fecha_gasto <= (YYYY-MM-DD); default fin del mes Cancún',
  })
  @IsOptional()
  @IsDateString()
  hasta?: string;
}

export class ListGastosQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vuelo_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  aeronave_id?: string;

  @ApiPropertyOptional({
    description: 'Pagos de una compra de refacciones (gasto.compra_id).',
  })
  @IsOptional()
  @IsUUID()
  compra_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_captura_id?: string;

  @ApiPropertyOptional({ enum: CategoriaGasto })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  categoria?: CategoriaGasto;

  @ApiPropertyOptional({
    enum: CategoriaGasto,
    description:
      'Deja FUERA una categoría (16-oct-2026, invariante 91: el módulo Gastos manda NOMINA, que vive en su propio módulo). Aplica a la lista, su conteo, la bandeja, duplicados, orden=captura y el Excel. Con `categoria` igual ⇒ lista vacía.',
  })
  @IsOptional()
  @IsEnum(CategoriaGasto)
  excluir_categoria?: CategoriaGasto;

  @ApiPropertyOptional({ description: 'fecha_gasto >= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  desde?: string;

  @ApiPropertyOptional({ description: 'fecha_gasto <= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @ApiPropertyOptional({
    description:
      'Fecha de CAPTURA >= (YYYY-MM-DD, día Cancún): lo que se subió desde esa fecha aunque el ticket traiga otra.',
  })
  @IsOptional()
  // Solo día puro: el servicio concatena `T00:00:00-05:00` (corte Cancún);
  // un ISO con hora armaría un timestamp inválido y PostgREST respondería
  // con un error opaco en vez de un 400 legible.
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'capturado_desde debe ser un día YYYY-MM-DD',
  })
  capturado_desde?: string;

  @ApiPropertyOptional({
    description: 'Fecha de CAPTURA <= (YYYY-MM-DD, día Cancún)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'capturado_hasta debe ser un día YYYY-MM-DD',
  })
  capturado_hasta?: string;

  @ApiPropertyOptional({
    enum: ['fecha', 'captura'],
    default: 'fecha',
    description:
      'Orden del listado: fecha = fecha del consumo (fecha_gasto desc, luego llegada al servidor); captura = momento real de captura (capturado_en desc). El Excel respeta el mismo orden.',
  })
  @IsOptional()
  @IsIn(['fecha', 'captura'])
  orden?: 'fecha' | 'captura';

  @ApiPropertyOptional({
    description: 'Solo gastos sin avión asignado (bandeja de pendientes).',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  pendientes?: boolean;

  @ApiPropertyOptional({
    description: 'Solo gastos marcados como posible duplicado.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  duplicados?: boolean;

  @ApiPropertyOptional({
    description:
      'Solo gastos marcados «Pago de AFAC» (16-oct-2026, invariante 90). Sin la migración 20261016000005 se ignora.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  pago_afac?: boolean;

  @ApiPropertyOptional({
    description:
      'Conciliación con el banco (9-oct-2026): true = solo gastos CUBIERTOS por cargos del banco (gasto.conciliado); false = solo los que no (incluye los cubiertos a medias). Sin el parámetro, todos.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  conciliado?: boolean;

  @ApiPropertyOptional({
    description:
      'Gastos «por pagar» (19-oct-2026, invariante 93): true|1 = estado ≠ PAGADO (por_pagar y sin conciliar: por pagar y vencidos); false|0 = los demás. Sin la migración 20261019000001: true ⇒ lista vacía; false ⇒ todos.',
  })
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  por_pagar?: boolean;

  @ApiPropertyOptional({
    enum: EstatusComprobante,
    description:
      'FACTURA y VALE son ambos "con comprobante" (VALE = legado); SIN_COMPROBANTE = sin comprobante.',
  })
  @IsOptional()
  @IsEnum(EstatusComprobante)
  estatus_comprobante?: EstatusComprobante;

  @ApiPropertyOptional({
    description:
      'PENDIENTE | SOLICITADA | FACTURADA | NO_FACTURABLE (no requiere factura) | NO_FACTURADA (meta-valor = pendiente o solicitada; NO incluye NO_FACTURABLE)',
  })
  @IsOptional()
  @IsIn([...Object.values(EstatusFacturacion), 'NO_FACTURADA'])
  estatus_facturacion?: string;

  @ApiPropertyOptional({ enum: MedioPago })
  @IsOptional()
  @IsEnum(MedioPago)
  medio_pago?: MedioPago;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/**
 * FECHA DEL PAGO desde Conciliación (14-oct-2026, invariante 74):
 * `PATCH /v1/expenses/:id/fecha`. Solo la fecha; la regla vive en
 * `cambio-fecha-gasto.util.ts`. Con whitelist + forbidNonWhitelisted
 * (main.ts), cualquier otra llave (verificado, permitir_fecha_antigua,
 * if_updated_at…) responde 400. `@Matches` y no `@IsDateString`: este último
 * acepta timestamps, y uno en UTC podría correr el día.
 */
export class CambioFechaGastoDto {
  @ApiProperty({
    description:
      'Fecha del PAGO (YYYY-MM-DD, día Cancún): normalmente la del cargo del banco.',
    example: '2026-10-12',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'fecha_gasto debe ser AAAA-MM-DD',
  })
  fecha_gasto!: string;

  @ApiProperty({
    description:
      'La fecha que el operador VIO en pantalla (candado de campo: si el gasto ya tiene otra, 409 FECHA_GASTO_CAMBIO).',
    example: '2026-10-10',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'fecha_anterior debe ser AAAA-MM-DD',
  })
  fecha_anterior!: string;

  @ApiPropertyOptional({
    description:
      'true = el operador confirmó el texto del 409 FECHA_GASTO_CONFIRMAR.',
  })
  // Booleano ESTRICTO sobre el valor CRUDO del body (`obj[key]`): con
  // `enableImplicitConversion` (main.ts) el texto 'false' llegaría como
  // Boolean('false') = true y contaría como confirmado (patrón de
  // `flights/dto/seguimiento.dto` y `profit-sharing/dto/reparto-pago.dto`).
  @Transform(
    ({ obj, key }: { obj: unknown; key: string }) =>
      (obj as Record<string, unknown>)[key],
  )
  @IsOptional()
  @IsBoolean({ message: 'confirmar debe ser true o false' })
  confirmar?: boolean;
}
