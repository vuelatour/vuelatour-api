/**
 * Vigencia de las URLs FIRMADAS de Storage (1-oct-2026, API 0.0.48).
 *
 * Reporte de la oficina: «las fotos de las facturas no están cargando» — la
 * miniatura de la columna «Comp.» de Gastos salía como una rayita blanca y el
 * visor como una franja delgada. Los archivos del bucket privado estaban
 * sanos; la causa era la VIGENCIA: el panel firma las URLs en el servidor al
 * renderizar la página (`POST /v1/expenses/photo-urls`, 1 h) y la oficina
 * deja la pestaña abierta toda la mañana. Al vencer, Supabase responde
 * HTTP 400 JSON `InvalidJWT · "exp" claim timestamp check failed` y el
 * navegador pinta la imagen rota.
 *
 * Dos vigencias, a propósito:
 *  - `SEGUNDOS_URL_MINIATURA` (8 h, una jornada): las que alimentan
 *    MINIATURAS y visores que se quedan en pantalla — fotos de gastos
 *    (Gastos, gastos personales, combustibles, detalle de vuelo, caja chica,
 *    compras de inventario), fotos de tacómetro (vuelo, taco-live, histórico
 *    del avión), vouchers de cobro y el plan de vuelo (el detalle del vuelo
 *    lo firma al renderizar y lo deja como href). Regla: toda URL que el
 *    panel firma al RENDERIZAR y el operador usa DESPUÉS va aquí. El panel
 *    además REFRESCA la URL al fallar o al abrir el visor con una URL vieja
 *    (`POST /v1/storage/firmar`), pero la vigencia larga evita el parpadeo
 *    en el caso normal.
 *  - `SEGUNDOS_URL_PUNTUAL` (1 h): las que se usan en el ACTO — descargas
 *    que se piden al clic (pólizas, estados de cuenta) y las URLs que
 *    el API le pasa a la IA para leer un comprobante: no hay razón para que
 *    una URL entregada a un tercero viva una jornada.
 *
 * Las firmas de 10 min (`SEGUNDOS_URL_FIRMADA` de facturas, ingresos y la
 * respuesta de subir un comprobante de cobro) NO cambian: son de un clic.
 */

/** 8 h: miniaturas y visores que el panel deja abiertos toda la jornada. */
export const SEGUNDOS_URL_MINIATURA = 8 * 60 * 60;

/** 1 h: descargas puntuales y URLs que se entregan a la IA. */
export const SEGUNDOS_URL_PUNTUAL = 60 * 60;
